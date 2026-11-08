using System;
using System.Collections.Generic;
using Microsoft.Extensions.Logging;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Text-PRESENCE detection only (not OCR - it never reads the text) for
/// People Backdrops' text filter. A coarse, dependency-free classical
/// heuristic: good at catching clearly organised lines of text, not a
/// precise scene-text detector. A neural detector (ONNX Runtime) is avoided
/// on purpose: Jellyfin's PluginManager tries to load every ".dll" in a
/// plugin folder as a managed assembly, the native runtime fails that and
/// marks the whole plugin "Malfunctioned", and it adds ~100 MB.
///
/// Known limitations: thin cursive watermarks fragment into clusters below
/// MinComponentArea at the 500 px downscale and are missed; bold text over
/// dense texture (hair in particular) is found as a group, but the
/// unrelated texture candidates push the grouped ratio below the threshold.
/// Lowering MinComponentArea, an absolute group-size threshold and a
/// pre-threshold blur were all tested against text-free crops and did not
/// separate the two cleanly.
///
/// ALGORITHM:
///
/// 1. Otsu's method picks a single global brightness threshold that
///    best separates an image into two classes - it works reasonably
///    even on backdrop photos with varied content, despite being
///    simpler than a local/adaptive threshold.
/// 2. Binarize in BOTH polarities (pixels lighter than the threshold,
///    and pixels darker than the threshold) and analyze both, since
///    text can be either lighter or darker than its background and
///    there is no way to know which in advance.
/// 3. Connected-component labeling (flood fill, 8-connectivity) groups
///    each binary image into individual blobs.
/// 4. Geometric filters keep only blobs whose SIZE and ASPECT RATIO are
///    plausible for a single letter - rejects both tiny noise specks
///    and large flat background regions.
/// 5. THE KEY STEP: raw component/pixel COUNTS are not a reliable signal -
///    photo texture produces MORE surviving candidate blobs than real text,
///    not fewer. What distinguishes real text is that its letter-candidates
///    GROUP TOGETHER - similar height, aligned along the same horizontal
///    band - while texture candidates are scattered. The decisive score is
///    the RATIO of "candidates in the single largest such group" over
///    "total surviving candidates". On test images real text scored
///    0.68-1.00 and photo texture 0.06-0.09, a wide margin for the fixed
///    threshold used below.
/// </summary>
public static class PeopleBackdropsTextDetector
{
    // Images are downscaled to this before analysis - keeps the O(n)
    // thresholding/component-labeling work fast and bounds worst-case
    // memory. A title readable at normal viewing size is still clearly
    // present after this downscale.
    private const int MaxSide = 500;

    // A connected component smaller than this many pixels (in the
    // downscaled image) is treated as noise speckle, not a letter -
    // real letters at any normal title/subtitle size comfortably clear
    // this bar after the MaxSide downscale above.
    private const int MinComponentArea = 6;

    // A component larger than this fraction of the total image area is
    // almost certainly a large background/foreground region (sky, a
    // face, a wall), not a single letter - real letters are always a
    // small fraction of a whole backdrop image.
    private const double MaxComponentAreaFraction = 0.03;

    // Real letterforms are neither extremely flat/wide nor extremely
    // tall/thin - this range is deliberately generous (covers "I" and
    // "M" and everything between) rather than tuned tightly.
    private const double MinAspectRatio = 0.15;
    private const double MaxAspectRatio = 7.0;

    // Two candidates are considered part of the same letter-line group
    // if their own heights don't differ by more than this ratio -
    // generous enough to tolerate normal letter-height variation
    // (ascenders/descenders, punctuation) within one real line of text.
    private const double MaxGroupHeightRatio = 1.6;

    // Two candidates are considered part of the same group only if
    // their vertical centers are within this fraction of the (shorter)
    // candidate's own height - keeps the grouping restricted to
    // roughly the same horizontal band, matching how a real line of
    // text is laid out.
    private const double MaxGroupVerticalGapFraction = 0.6;

    // A real title/subtitle is virtually always at least this many
    // letters - fewer surviving candidates than this are not treated
    // as an organized line at all (avoids a meaningless "100% of my
    // only 1-2 candidates form a group" false-positive on an image
    // with barely any candidates in the first place).
    private const int MinCandidatesForGrouping = 3;

    // THE decision threshold - see the class doc comment for the
    // measured margin (real text: 0.68-1.00; photo texture: 0.06-0.09).
    // Deliberately set well inside that margin, not at its edge.
    private const double GroupedRatioThreshold = 0.35;

    // Safety cap against a pathological image producing an enormous
    // number of tiny candidates (very fine-grained texture): the grouping
    // step below is O(n^2) in the number of candidates. Past this cap the
    // image is treated as texture/noise without grouping - very high
    // candidate counts are themselves a texture signal, not a text signal.
    private const int MaxCandidatesBeforeGroupingSkipped = 400;

    /// <summary>
    /// Returns true if the image likely contains a visible, organized
    /// line of text (titles, watermarks, subtitles) - a coarse "shield",
    /// not a precise scene-text detector. Both false positives and false
    /// negatives are expected to happen sometimes.
    /// </summary>
    public static bool ContainsText(byte[] imageBytes, ILogger logger)
    {
        try
        {
            using var image = Image.Load<L8>(imageBytes);

            var longerSide = Math.Max(image.Width, image.Height);
            if (longerSide > MaxSide)
            {
                var scale = (double)MaxSide / longerSide;
                var targetWidth = Math.Max(1, (int)Math.Round(image.Width * scale));
                var targetHeight = Math.Max(1, (int)Math.Round(image.Height * scale));
                image.Mutate(x => x.Resize(targetWidth, targetHeight));
            }

            var width = image.Width;
            var height = image.Height;
            var gray = new byte[height, width];
            image.ProcessPixelRows(accessor =>
            {
                for (var y = 0; y < accessor.Height; y++)
                {
                    var row = accessor.GetRowSpan(y);
                    for (var x = 0; x < row.Length; x++)
                    {
                        gray[y, x] = row[x].PackedValue;
                    }
                }
            });

            var threshold = ComputeOtsuThreshold(gray, width, height);

            var lighterMask = BuildMask(gray, width, height, (value, t) => value > t, threshold);
            var darkerMask = BuildMask(gray, width, height, (value, t) => value < t, threshold);

            var candidates = new List<(int Y, int Height)>();
            CollectCandidates(lighterMask, width, height, candidates);
            CollectCandidates(darkerMask, width, height, candidates);

            if (candidates.Count < MinCandidatesForGrouping)
            {
                logger.LogDebug("PeopleBackdropsTextDetector: ContainsText - only {Count} letter-shaped candidate(s) found (need at least {Min}), treating as no organized text", candidates.Count, MinCandidatesForGrouping);
                return false;
            }

            if (candidates.Count > MaxCandidatesBeforeGroupingSkipped)
            {
                // An extremely high candidate count points to fine-grained
                // texture/noise - real titles produce tens of candidates,
                // not hundreds.
                logger.LogDebug("PeopleBackdropsTextDetector: ContainsText - {Count} candidates exceeds the safety cap of {Cap}, treating as texture/noise without running the full grouping step", candidates.Count, MaxCandidatesBeforeGroupingSkipped);
                return false;
            }

            var largestGroup = FindLargestGroupSize(candidates);
            var ratio = (double)largestGroup / candidates.Count;

            var containsText = ratio >= GroupedRatioThreshold;
            logger.LogDebug("PeopleBackdropsTextDetector: ContainsText - {Candidates} candidate(s), largest aligned group = {Group}, ratio = {Ratio:F2} (threshold {Threshold:F2}) -> {Result}", candidates.Count, largestGroup, ratio, GroupedRatioThreshold, containsText ? "text detected" : "no text detected");
            return containsText;
        }
        catch (Exception ex)
        {
            // A failed detection (corrupt/unsupported image data, unexpected
            // error) deliberately does NOT reject the candidate: it is logged
            // and treated as "no text detected", so a good image is not lost
            // to an unrelated technical failure.
            logger.LogWarning(ex, "PeopleBackdropsTextDetector: ContainsText - text detection failed for a candidate image (image size {Bytes} bytes), treating as no-text-found so this candidate isn't lost to an unrelated technical failure", imageBytes.Length);
            return false;
        }
    }

    /// <summary>
    /// Otsu's method: picks the brightness threshold that maximizes the
    /// between-class variance of the resulting two pixel groups.
    /// </summary>
    private static int ComputeOtsuThreshold(byte[,] gray, int width, int height)
    {
        Span<int> histogram = stackalloc int[256];
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                histogram[gray[y, x]]++;
            }
        }

        var total = width * height;
        double sumAll = 0;
        for (var i = 0; i < 256; i++)
        {
            sumAll += i * (long)histogram[i];
        }

        double sumBackground = 0;
        var weightBackground = 0L;
        var maxVariance = 0.0;
        var threshold = 0;

        for (var t = 0; t < 256; t++)
        {
            weightBackground += histogram[t];
            if (weightBackground == 0)
            {
                continue;
            }

            var weightForeground = total - weightBackground;
            if (weightForeground == 0)
            {
                break;
            }

            sumBackground += t * (long)histogram[t];
            var meanBackground = sumBackground / weightBackground;
            var meanForeground = (sumAll - sumBackground) / weightForeground;
            var varianceBetween = (double)weightBackground * weightForeground * Math.Pow(meanBackground - meanForeground, 2);

            if (varianceBetween > maxVariance)
            {
                maxVariance = varianceBetween;
                threshold = t;
            }
        }

        return threshold;
    }

    private static bool[,] BuildMask(byte[,] gray, int width, int height, Func<byte, int, bool> predicate, int threshold)
    {
        var mask = new bool[height, width];
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                mask[y, x] = predicate(gray[y, x], threshold);
            }
        }

        return mask;
    }

    /// <summary>
    /// Flood-fill (BFS, 8-connectivity) connected-component labeling,
    /// followed immediately by the geometric filters - one method, since
    /// only the numbers of a kept component (y-position, height) are needed
    /// for the later grouping step.
    /// </summary>
    private static void CollectCandidates(bool[,] mask, int width, int height, List<(int Y, int Height)> candidates)
    {
        var visited = new bool[height, width];
        var maxArea = (int)(width * (double)height * MaxComponentAreaFraction);
        var queue = new Queue<(int Y, int X)>();

        for (var startY = 0; startY < height; startY++)
        {
            for (var startX = 0; startX < width; startX++)
            {
                if (!mask[startY, startX] || visited[startY, startX])
                {
                    continue;
                }

                var minY = startY;
                var maxY = startY;
                var minX = startX;
                var maxX = startX;
                var area = 0;

                queue.Clear();
                queue.Enqueue((startY, startX));
                visited[startY, startX] = true;

                while (queue.Count > 0)
                {
                    var (y, x) = queue.Dequeue();
                    area++;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;

                    for (var dy = -1; dy <= 1; dy++)
                    {
                        for (var dx = -1; dx <= 1; dx++)
                        {
                            if (dy == 0 && dx == 0)
                            {
                                continue;
                            }

                            var ny = y + dy;
                            var nx = x + dx;
                            if (ny < 0 || ny >= height || nx < 0 || nx >= width)
                            {
                                continue;
                            }

                            if (mask[ny, nx] && !visited[ny, nx])
                            {
                                visited[ny, nx] = true;
                                queue.Enqueue((ny, nx));
                            }
                        }
                    }
                }

                if (area < MinComponentArea || area > maxArea)
                {
                    continue;
                }

                var componentHeight = maxY - minY + 1;
                var componentWidth = maxX - minX + 1;
                var aspect = (double)componentWidth / componentHeight;

                if (aspect >= MinAspectRatio && aspect <= MaxAspectRatio)
                {
                    candidates.Add((minY, componentHeight));
                }
            }
        }
    }

    /// <summary>
    /// Finds the size of the largest group of candidates that share a
    /// similar height and lie along roughly the same horizontal band -
    /// see the class doc comment for why this grouping, not raw candidate
    /// counts, separates real text from photo texture. O(n^2) in candidate
    /// count, bounded by MaxCandidatesBeforeGroupingSkipped above.
    /// </summary>
    private static int FindLargestGroupSize(List<(int Y, int Height)> candidates)
    {
        var largest = 0;
        for (var i = 0; i < candidates.Count; i++)
        {
            var (yA, heightA) = candidates[i];
            var groupSize = 1;
            var centerA = yA + heightA / 2.0;

            for (var j = 0; j < candidates.Count; j++)
            {
                if (i == j)
                {
                    continue;
                }

                var (yB, heightB) = candidates[j];
                var heightRatio = Math.Max(heightA, heightB) / (double)Math.Max(1, Math.Min(heightA, heightB));
                var centerB = yB + heightB / 2.0;
                var verticalGap = Math.Abs(centerA - centerB);

                if (heightRatio < MaxGroupHeightRatio && verticalGap < heightA * MaxGroupVerticalGapFraction)
                {
                    groupSize++;
                }
            }

            if (groupSize > largest)
            {
                largest = groupSize;
            }
        }

        return largest;
    }
}
