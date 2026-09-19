using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// A single characterart candidate paired with its own version
/// fingerprint - see ExtraposterController.PosterEntry for the full
/// reasoning (identical structure/purpose, kept as a separate type here
/// rather than sharing across controllers, matching this project's
/// existing per-controller-DTO convention).
/// </summary>
public class ImageEntry
{
    public string FileName { get; set; } = string.Empty;

    public string Version { get; set; } = string.Empty;
}

/// <summary>
/// Result DTO for Characterart. Unlike Extraposter/Poster, the existence
/// field here isn't called "IsMovie" (Characterart applies to
/// series/seasons/episodes too) - "IsApplicable" fits better. Even with
/// just a single static image (MultiImage=false), a list with exactly one
/// entry is still returned, so the frontend doesn't have to distinguish
/// between two response shapes.
/// </summary>
public class CharacterartResult
{
    public bool IsApplicable { get; set; }

    public IReadOnlyList<ImageEntry> Images { get; set; } = Array.Empty<ImageEntry>();

    public bool MultiImage { get; set; }

    public string Position { get; set; } = "BottomLeft";

    public string ScaleMode { get; set; } = "Height";

    public double HeightVh { get; set; } = 15;

    public double MaxWidthVw { get; set; }

    public double WidthVw { get; set; } = 11.5;

    public double MaxHeightVh { get; set; }

    public string HorizontalAlign { get; set; } = "Center";

    public double HorizontalOffsetVw { get; set; }

    // Same per-position/per-media-type granularity as HorizontalOffsetVw
    // above (originally a single global value, split per-position after
    // the user found windowed and fullscreen need visibly different
    // corrections at different positions). Added to HorizontalOffsetVw
    // ONLY while document.fullscreenElement is truthy (characterart.js)
    // - a pragmatic, manually-tunable compensation after extensive
    // investigation (frozen-gap-width-fraction proportional scaling
    // fix, native .detailLogo's own display:none breakpoint at 1100px)
    // still left a small residual drift the user wanted a direct way to
    // correct for themselves.
    public double FullscreenHorizontalOffsetVw { get; set; }

    public int CycleTimeMs { get; set; } = 5000;

    public int FadeTimeMs { get; set; } = 500;

    public bool DelayEnabled { get; set; }

    public int DelayMs { get; set; }

    public bool SinglePass { get; set; }

    public bool StaySingleImageStatic { get; set; }

    /// <summary>See PluginConfiguration.CharacterartMoviesOrderMode - purely
    /// informational for the frontend (the actual ordering already
    /// happened server-side by the time Images is populated), matching
    /// ExtraposterController's identical OrderMode field.</summary>
    public string OrderMode { get; set; } = "Sequential";
}

/// <summary>
/// The second, fully independent feature block (curriculum section E) -
/// deliberately its own controller with its own route, not an extension of
/// ExtraposterController, to keep the two feature blocks as cleanly
/// separated in the code as they are in the config page/curriculum.
/// Logging philosophy identical to ExtraposterController (curriculum D0b) -
/// all lines prefixed with "Characterart:".
/// </summary>
[ApiController]
[Route("Characterart")]
[AllowAnonymous]
public class CharacterartController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<CharacterartController> _logger;
    private readonly IMemoryCache _cache;

    private const int MaxNumberedImages = 50;
    private static readonly TimeSpan CacheSlidingExpiration = TimeSpan.FromHours(6);

    public CharacterartController(ILibraryManager libraryManager, ILogger<CharacterartController> logger, IMemoryCache cache)
    {
        _libraryManager = libraryManager;
        _logger = logger;
        _cache = cache;
    }

    /// <summary>
    /// GET /Characterart/{itemId} - returns the image list (in
    /// single-image mode: a list with exactly one entry) plus the
    /// position/timing settings for this item. Works the same for Movie,
    /// Series, Season, and Episode.
    /// </summary>
    [HttpGet("{itemId}")]
    public ActionResult<CharacterartResult> GetCharacterart([FromRoute] Guid itemId)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;

            if (!config.CharacterartEnabled)
            {
                _logger.LogInformation("Characterart: GetCharacterart - CharacterartEnabled is off (General tab), {ItemId}", itemId);
                return Ok(new CharacterartResult { IsApplicable = false });
            }

            var resolved = ResolveItem(itemId, config);
            if (resolved is null)
            {
                return Ok(new CharacterartResult { IsApplicable = false });
            }

            var (folderPath, namingMode, typeName, folderName, multiImage, allowedFormatsCsv,
                cycleMs, fadeMs, delayEnabled, delayMs, singlePass, staySingleImageStatic, orderMode, isMovie, randomStart) = resolved.Value;

            var position = isMovie ? config.CharacterartMoviesPosition : config.CharacterartTvShowsPosition;
            var lastWriteUtc = SafeGetLastWriteTimeUtc(folderPath);
            var sizing = ResolvePositionSizing(config, isMovie, position);
            var etag = ComputeETag(
                itemId, lastWriteUtc.Ticks, namingMode, typeName, folderName, multiImage,
                allowedFormatsCsv, position, sizing.ScaleMode, sizing.HeightVh, sizing.MaxWidthVw,
                sizing.WidthVw, sizing.MaxHeightVh, sizing.HorizontalAlign,
                sizing.OffsetVw, cycleMs, fadeMs, delayEnabled, delayMs, singlePass, staySingleImageStatic, orderMode);

            if (IsETagStillValid(etag))
            {
                _logger.LogInformation("Characterart: GetCharacterart - ETag unchanged, 304 for {ItemId}", itemId);
                return StatusCode(StatusCodes.Status304NotModified);
            }

            var images = ResolveCandidates(folderPath, namingMode, typeName, folderName, multiImage, orderMode, allowedFormatsCsv);
            // Session 127: Random start position - Sequential + Loop only (the page greys the box otherwise).
            if (randomStart && orderMode == "Sequential" && !singlePass && multiImage) { images = Helpers.RandomStart.Rotate(images); }

            var effectiveFadeMs = Math.Min(fadeMs, cycleMs);

            // If MultiImage is configured on but only one (or zero) image
            // actually exists for this specific item, report it as
            // effectively single-image for THIS response - found via user
            // feedback: without this, the client-side "images.length > 1"
            // check already correctly prevented a pointless self-fade
            // loop, but the response itself still claimed MultiImage=true,
            // which was misleading in the log/API contract even though
            // the visible behavior happened to be correct either way.
            // Doesn't touch the underlying config value - only what THIS
            // one item's response reports, exactly matching what actually
            // exists for it.
            var effectiveMultiImage = multiImage && images.Count > 1;

            _logger.LogInformation(
                "Characterart: GetCharacterart END for {ItemId} -> {Count} image(s) found (effective MultiImage={EffectiveMultiImage}): [{Files}]",
                itemId, images.Count, effectiveMultiImage, string.Join(", ", images));

            return Ok(new CharacterartResult
            {
                IsApplicable = images.Count > 0,
                Images = BuildImageEntries(folderPath, images),
                MultiImage = effectiveMultiImage,
                Position = position,
                ScaleMode = sizing.ScaleMode,
                HeightVh = sizing.HeightVh,
                MaxWidthVw = sizing.MaxWidthVw,
                WidthVw = sizing.WidthVw,
                MaxHeightVh = sizing.MaxHeightVh,
                HorizontalAlign = sizing.HorizontalAlign,
                HorizontalOffsetVw = sizing.OffsetVw,
                FullscreenHorizontalOffsetVw = sizing.FullscreenOffsetVw,
                CycleTimeMs = cycleMs,
                FadeTimeMs = effectiveFadeMs,
                DelayEnabled = delayEnabled,
                DelayMs = delayMs,
                SinglePass = singlePass,
                StaySingleImageStatic = staySingleImageStatic,
                OrderMode = orderMode
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Characterart: Unexpected error in GetCharacterart for {ItemId}", itemId);
            return Ok(new CharacterartResult { IsApplicable = false });
        }
    }

    /// <summary>
    /// GET /Characterart/{itemId}/image/{fileName} - serves a single image
    /// file, following the same path-traversal-safe pattern as
    /// ExtraposterController.GetPosterImage (freshly resolve the candidate
    /// list, check fileName against it instead of trusting it blindly).
    /// </summary>
    [HttpGet("{itemId}/image/{fileName}")]
    public ActionResult GetCharacterartImage([FromRoute] Guid itemId, [FromRoute] string fileName)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            if (!config.CharacterartEnabled)
            {
                return NotFound();
            }

            var resolved = ResolveItem(itemId, config);
            if (resolved is null)
            {
                _logger.LogWarning("Characterart: GetCharacterartImage 404 - item {ItemId} couldn't be resolved/isn't enabled for this type", itemId);
                return NotFound();
            }

            var (folderPath, namingMode, typeName, folderName, multiImage, allowedFormatsCsv, _, _, _, _, _, _, orderMode, _, _) = resolved.Value;
            var images = ResolveCandidates(folderPath, namingMode, typeName, folderName, multiImage, orderMode, allowedFormatsCsv);

            if (!images.Contains(fileName, StringComparer.Ordinal))
            {
                _logger.LogWarning(
                    "Characterart: GetCharacterartImage 404 - \"{FileName}\" not in the candidate list for {ItemId}. List: [{Images}]",
                    fileName, itemId, string.Join(", ", images));
                return NotFound();
            }

            var fullPath = Path.Combine(folderPath, fileName);
            if (!System.IO.File.Exists(fullPath))
            {
                _logger.LogWarning("Characterart: GetCharacterartImage 404 - file no longer exists: \"{Path}\"", fullPath);
                return NotFound();
            }

            var contentType = GetContentType(fullPath);
            var fileInfo = new FileInfo(fullPath);

            // Image bytes caching - see ExtraposterController.GetPosterImage's
            // comment for the full reasoning (found missing here too in the
            // same review round).
            var imageEtag = "\"" + fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";
            Response.Headers.ETag = imageEtag;
            Response.Headers.CacheControl = "public, max-age=86400";
            var ifNoneMatchImage = Request.Headers.IfNoneMatch.ToString();
            if (!string.IsNullOrEmpty(ifNoneMatchImage) && ifNoneMatchImage == imageEtag)
            {
                _logger.LogInformation("Characterart: GetCharacterartImage - ETag unchanged, 304 for \"{Path}\"", fullPath);
                return StatusCode(StatusCodes.Status304NotModified);
            }

            var stream = System.IO.File.OpenRead(fullPath);
            _logger.LogInformation("Characterart: GetCharacterartImage 200 - serving \"{Path}\", Content-Type={ContentType}", fullPath, contentType);
            return File(stream, contentType);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Characterart: Unexpected error in GetCharacterartImage for {ItemId}/{FileName}", itemId, fileName);
            return NotFound();
        }
    }

    // NOTE: this controller used to have its own GET /Characterart/script.js
    // endpoint here, serving Jellyfin-ArtworkPlus-CharacterArt-v1.js from
    // disk. That file no longer exists on its own - explicit user
    // decision to merge CharacterArt and RedCarpet's own, previously
    // separate client scripts into one file, Jellyfin-ArtworkPlus-
    // RenderArt-v1.js (file-level merge only - neither feature's own
    // behavior, admin-UI section, or settings changed; the two keep
    // running as two entirely independent, non-interacting sections
    // within that one file). The client script is now served by
    // RenderArtController's own GetScript() endpoint instead
    // (GET /RenderArt/script.js). This controller's OWN data endpoints
    // below (character-art resolution, image serving) are unchanged and
    // still exactly what RenderArt-v1.js's own CharacterArt section calls.

    /// <summary>
    /// Resolves an itemId and, if applicable, returns all the values
    /// needed for further processing: the folder path AND the matching
    /// Movies or TvShows settings, depending on the actual type. Returns
    /// null if the type isn't supported, the corresponding "where to show"
    /// checkbox is off, or the folder can't be resolved.
    ///
    /// TV resolution (Episode/Season/Series) always navigates to the
    /// series' main folder (curriculum E, verified: Series inherits from
    /// Folder, so, like a movie, it has its own exclusive folder) -
    /// regardless of which of the three levels you start from.
    /// </summary>
    private (string FolderPath, string NamingMode, string TypeName, string FolderName, bool MultiImage,
        string AllowedFormatsCsv, int CycleMs, int FadeMs, bool DelayEnabled, int DelayMs, bool SinglePass, bool StaySingleImageStatic, string OrderMode, bool IsMovie, bool RandomStart)?
        ResolveItem(Guid itemId, PluginConfiguration config)
    {
        var item = _libraryManager.GetItemById(itemId);
        _logger.LogInformation(
            "Characterart: ResolveItem - {ItemId} resolved as type \"{Type}\"",
            itemId, item?.GetType().FullName ?? "null (not found)");

        string? folderPath = null;

        if (item is Movie movie)
        {
            if (!config.CharacterartShowOnMovies)
            {
                _logger.LogInformation("Characterart: ResolveItem - {ItemId} is a Movie, but CharacterartShowOnMovies is off", itemId);
                return null;
            }

            folderPath = movie.ContainingFolderPath;
            if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath))
            {
                _logger.LogWarning("Characterart: ResolveItem - movie folder not found for {ItemId}: \"{Path}\"", itemId, folderPath ?? "(empty)");
                return null;
            }

            return (folderPath, config.CharacterartMoviesNamingMode, config.CharacterartMoviesTypeName,
                config.CharacterartMoviesFolderName, config.CharacterartMoviesMultiImage, config.CharacterartAllowedFormats,
                config.CharacterartMoviesCycleTimeMs, config.CharacterartMoviesFadeTimeMs,
                config.CharacterartMoviesDelayEnabled, config.CharacterartMoviesDelayMs, config.CharacterartMoviesSinglePass,
                config.CharacterartMoviesStaySingleImageStatic, config.CharacterartMoviesOrderMode, true, config.CharacterartMoviesRandomStart);
        }

        if (item is BoxSet boxSet)
        {
            if (!config.CharacterartShowOnSets)
            {
                _logger.LogInformation("Characterart: ResolveItem - {ItemId} is a BoxSet, but CharacterartShowOnSets is off", itemId);
                return null;
            }

            folderPath = boxSet.ContainingFolderPath;
            if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath))
            {
                _logger.LogWarning("Characterart: ResolveItem - set folder not found for {ItemId}: \"{Path}\"", itemId, folderPath ?? "(empty)");
                return null;
            }

            // Shares every other Movies setting (see this method's own
            // BoxSet branch reasoning, and CharacterartShowOnSets' own
            // doc comment in PluginConfiguration.cs) - NamingMode is the
            // one deliberate exception, hardcoded to "Standalone" rather
            // than reading config.CharacterartMoviesNamingMode: a
            // "Prefixed" filename needs one specific movie's own name to
            // prefix with, which a Set inherently doesn't have.
            return (folderPath, "Standalone", config.CharacterartMoviesTypeName,
                config.CharacterartMoviesFolderName, config.CharacterartMoviesMultiImage, config.CharacterartAllowedFormats,
                config.CharacterartMoviesCycleTimeMs, config.CharacterartMoviesFadeTimeMs,
                config.CharacterartMoviesDelayEnabled, config.CharacterartMoviesDelayMs, config.CharacterartMoviesSinglePass,
                config.CharacterartMoviesStaySingleImageStatic, config.CharacterartMoviesOrderMode, true, config.CharacterartMoviesRandomStart);
        }

        if (item is Series series)
        {
            if (!config.CharacterartShowOnTvShows)
            {
                _logger.LogInformation("Characterart: ResolveItem - {ItemId} is a Series, but CharacterartShowOnTvShows is off", itemId);
                return null;
            }

            folderPath = series.ContainingFolderPath;
        }
        else if (item is Season season)
        {
            if (!config.CharacterartShowOnSeasons)
            {
                _logger.LogInformation("Characterart: ResolveItem - {ItemId} is a Season, but CharacterartShowOnSeasons is off", itemId);
                return null;
            }

            folderPath = season.Series?.ContainingFolderPath;
            _logger.LogInformation("Characterart: ResolveItem - Season {ItemId} -> navigated to the series' main folder via Season.Series", itemId);
        }
        else if (item is Episode episode)
        {
            if (!config.CharacterartShowOnEpisodes)
            {
                _logger.LogInformation("Characterart: ResolveItem - {ItemId} is an Episode, but CharacterartShowOnEpisodes is off", itemId);
                return null;
            }

            folderPath = episode.Series?.ContainingFolderPath;
            _logger.LogInformation("Characterart: ResolveItem - Episode {ItemId} -> navigated to the series' main folder via Episode.Series", itemId);
        }
        else
        {
            _logger.LogInformation("Characterart: ResolveItem - {ItemId} is none of the supported types (Movie/Series/Season/Episode)", itemId);
            return null;
        }

        if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath))
        {
            _logger.LogWarning("Characterart: ResolveItem - the TV series' main folder wasn't found for {ItemId}: \"{Path}\"", itemId, folderPath ?? "(empty)");
            return null;
        }

        return (folderPath, config.CharacterartTvShowsNamingMode, config.CharacterartTvShowsTypeName,
            config.CharacterartTvShowsFolderName, config.CharacterartTvShowsMultiImage, config.CharacterartAllowedFormats,
            config.CharacterartTvShowsCycleTimeMs, config.CharacterartTvShowsFadeTimeMs,
            config.CharacterartTvShowsDelayEnabled, config.CharacterartTvShowsDelayMs, config.CharacterartTvShowsSinglePass,
            config.CharacterartTvShowsStaySingleImageStatic, config.CharacterartTvShowsOrderMode, false, config.CharacterartTvShowsRandomStart);
    }

    /// <summary>
    /// Sizing is configured separately per position AND per content type
    /// (Movies vs. TV shows) - each of the four spots on the page is
    /// different enough that reusing one shared value never made sense
    /// once you actually compare them side by side, and a movie's detail
    /// page and a show's detail page could reasonably want the artwork
    /// positioned differently too. Picks out the one set matching
    /// whichever position is currently selected for the given content
    /// type - the other sets stay stored in the config, just unused
    /// until the admin switches to them.
    /// </summary>
    private static (string ScaleMode, double HeightVh, double MaxWidthVw, double WidthVw, double MaxHeightVh, string HorizontalAlign, double OffsetVw, double FullscreenOffsetVw)
        ResolvePositionSizing(PluginConfiguration config, bool isMovie, string position)
    {
        if (isMovie)
        {
            return position switch
            {
                "TopLeft" => (config.CharacterartMoviesTopLeftScaleMode, config.CharacterartMoviesTopLeftHeightVh, config.CharacterartMoviesTopLeftMaxWidthVw, config.CharacterartMoviesTopLeftWidthVw, config.CharacterartMoviesTopLeftMaxHeightVh, config.CharacterartMoviesTopLeftHorizontalAlign, config.CharacterartMoviesTopLeftOffsetVw, config.CharacterartMoviesTopLeftFullscreenOffsetVw),
                "TopRight" => (config.CharacterartMoviesTopRightScaleMode, config.CharacterartMoviesTopRightHeightVh, config.CharacterartMoviesTopRightMaxWidthVw, config.CharacterartMoviesTopRightWidthVw, config.CharacterartMoviesTopRightMaxHeightVh, config.CharacterartMoviesTopRightHorizontalAlign, config.CharacterartMoviesTopRightOffsetVw, config.CharacterartMoviesTopRightFullscreenOffsetVw),
                "BottomRight" => (config.CharacterartMoviesBottomRightScaleMode, config.CharacterartMoviesBottomRightHeightVh, config.CharacterartMoviesBottomRightMaxWidthVw, config.CharacterartMoviesBottomRightWidthVw, config.CharacterartMoviesBottomRightMaxHeightVh, config.CharacterartMoviesBottomRightHorizontalAlign, config.CharacterartMoviesBottomRightOffsetVw, config.CharacterartMoviesBottomRightFullscreenOffsetVw),
                _ => (config.CharacterartMoviesBottomLeftScaleMode, config.CharacterartMoviesBottomLeftHeightVh, config.CharacterartMoviesBottomLeftMaxWidthVw, config.CharacterartMoviesBottomLeftWidthVw, config.CharacterartMoviesBottomLeftMaxHeightVh, config.CharacterartMoviesBottomLeftHorizontalAlign, config.CharacterartMoviesBottomLeftOffsetVw, config.CharacterartMoviesBottomLeftFullscreenOffsetVw)
            };
        }

        return position switch
        {
            "TopLeft" => (config.CharacterartTvShowsTopLeftScaleMode, config.CharacterartTvShowsTopLeftHeightVh, config.CharacterartTvShowsTopLeftMaxWidthVw, config.CharacterartTvShowsTopLeftWidthVw, config.CharacterartTvShowsTopLeftMaxHeightVh, config.CharacterartTvShowsTopLeftHorizontalAlign, config.CharacterartTvShowsTopLeftOffsetVw, config.CharacterartTvShowsTopLeftFullscreenOffsetVw),
            "TopRight" => (config.CharacterartTvShowsTopRightScaleMode, config.CharacterartTvShowsTopRightHeightVh, config.CharacterartTvShowsTopRightMaxWidthVw, config.CharacterartTvShowsTopRightWidthVw, config.CharacterartTvShowsTopRightMaxHeightVh, config.CharacterartTvShowsTopRightHorizontalAlign, config.CharacterartTvShowsTopRightOffsetVw, config.CharacterartTvShowsTopRightFullscreenOffsetVw),
            "BottomRight" => (config.CharacterartTvShowsBottomRightScaleMode, config.CharacterartTvShowsBottomRightHeightVh, config.CharacterartTvShowsBottomRightMaxWidthVw, config.CharacterartTvShowsBottomRightWidthVw, config.CharacterartTvShowsBottomRightMaxHeightVh, config.CharacterartTvShowsBottomRightHorizontalAlign, config.CharacterartTvShowsBottomRightOffsetVw, config.CharacterartTvShowsBottomRightFullscreenOffsetVw),
            _ => (config.CharacterartTvShowsBottomLeftScaleMode, config.CharacterartTvShowsBottomLeftHeightVh, config.CharacterartTvShowsBottomLeftMaxWidthVw, config.CharacterartTvShowsBottomLeftWidthVw, config.CharacterartTvShowsBottomLeftMaxHeightVh, config.CharacterartTvShowsBottomLeftHorizontalAlign, config.CharacterartTvShowsBottomLeftOffsetVw, config.CharacterartTvShowsBottomLeftFullscreenOffsetVw)
        };
    }

    private string[] GetAllowedExtensions(string? allowedFormatsCsv)
    {
        var extensions = (allowedFormatsCsv ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .ToArray();

        return extensions.Length == 0 ? new[] { ".png" } : extensions;
    }

    /// <summary>
    /// Finds the Characterart candidates - with a server cache in front of
    /// it, exactly the same principle as
    /// ExtraposterController.ResolveCandidates (a composite key from the
    /// folder's change date + all relevant settings).
    /// </summary>
    /// <summary>
    /// Pairs each candidate file name with its own version fingerprint -
    /// see ExtraposterController.BuildPosterEntries for the full
    /// reasoning (identical logic, kept separate per this project's
    /// existing per-controller convention).
    /// </summary>
    private static List<ImageEntry> BuildImageEntries(string folderPath, List<string> fileNames)
    {
        return fileNames.Select(fileName =>
        {
            string version;
            try
            {
                var fullPath = Path.Combine(folderPath, fileName);
                var fileInfo = new FileInfo(fullPath);
                version = fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                version = string.Empty;
            }

            return new ImageEntry { FileName = fileName, Version = version };
        }).ToList();
    }

    private List<string> ResolveCandidates(string folderPath, string namingMode, string typeName, string folderName, bool multiImage, string orderMode, string? allowedFormatsCsv)
    {
        var lastWriteUtc = SafeGetLastWriteTimeUtc(folderPath);
        // orderMode deliberately left OUT of the cache key now - see
        // below for why: the cached list is always the raw, naturally-
        // sorted discovery result, identical regardless of orderMode, so
        // keying on it would just create redundant, wasteful cache
        // entries for the same underlying files.
        var cacheKey = string.Join(
            '|',
            "Characterart:Candidates",
            folderPath,
            lastWriteUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture),
            namingMode,
            typeName,
            folderName,
            multiImage,
            allowedFormatsCsv ?? string.Empty);

        List<string> naturallyOrdered;
        if (_cache.TryGetValue(cacheKey, out List<string>? cached) && cached is not null)
        {
            _logger.LogInformation("Characterart: ResolveCandidates - cache hit for \"{Key}\"", cacheKey);
            naturallyOrdered = cached;
        }
        else
        {
            // Real, user-identified bug fixed here: this used to cache
            // the ALREADY-SHUFFLED Random result directly, meaning the
            // one-time shuffle outcome itself sat behind the 6-hour
            // sliding cache - the same order kept reappearing for as
            // long as the title kept being accessed (resetting the
            // slide), which is NOT what "Random" was supposed to mean.
            // Always resolving in natural order here now (regardless of
            // the caller's actual orderMode) means only the genuinely
            // expensive part - the filesystem discovery itself - is what
            // ends up cached.
            naturallyOrdered = ResolveCandidatesUncached(folderPath, namingMode, typeName, folderName, multiImage, "Sequential", allowedFormatsCsv);
            _cache.Set(cacheKey, naturallyOrdered, new MemoryCacheEntryOptions().SetSlidingExpiration(CacheSlidingExpiration));
        }

        // Applied fresh on every single call when Random is selected -
        // cheap (a plain in-memory shuffle of an already-known list, no
        // filesystem access at all), so there's no real cost to doing
        // this every time rather than caching the shuffled outcome.
        // ApplyOrder() returns a new list, never mutating the cached one.
        return orderMode == "Sequential" ? naturallyOrdered : ApplyOrder(naturallyOrdered, orderMode);
    }

    /// <summary>
    /// Uncached candidate resolution. Four combinations are possible:
    /// Standalone+single image ("typeName.ext"), Standalone+multi-image
    /// ("typeName1.ext", "typeName2.ext", ...), Prefixed+single image
    /// ("MovieFolderName-typeName.ext", only available for Movies),
    /// Prefixed+multi-image, plus Folder (always everything in the
    /// subfolder, for single image only the first match in natural sort
    /// order is returned - curriculum E: "a valid, intended combination").
    /// </summary>
    private List<string> ResolveCandidatesUncached(string folderPath, string namingMode, string typeName, string folderName, bool multiImage, string orderMode, string? allowedFormatsCsv)
    {
        var allowedExtensions = GetAllowedExtensions(allowedFormatsCsv);
        List<string> fileNames;

        if (namingMode == "Folder")
        {
            var subFolder = Path.Combine(folderPath, folderName);
            if (!Directory.Exists(subFolder))
            {
                _logger.LogInformation("Characterart: ResolveCandidatesUncached - Folder mode, subfolder not found: \"{SubFolder}\"", subFolder);
                return new List<string>();
            }

            var filesInSubFolder = Directory.EnumerateFiles(subFolder).Select(Path.GetFileName).ToList();
            fileNames = filesInSubFolder
                .Where(f => f is not null && allowedExtensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase))
                .Select(f => Path.Combine(folderName, f!))
                .ToList();
            fileNames = ApplyOrder(fileNames, orderMode);

            if (!multiImage && fileNames.Count > 1)
            {
                _logger.LogInformation(
                    "Characterart: ResolveCandidatesUncached - Folder mode + single image: {Count} files found, only the first is used: \"{First}\"",
                    fileNames.Count, fileNames[0]);
                fileNames = new List<string> { fileNames[0] };
            }

            return fileNames;
        }

        var prefix = namingMode == "Prefixed"
            ? Path.GetFileName(folderPath) + "-" + typeName
            : typeName;

        fileNames = new List<string>();

        if (!multiImage)
        {
            // Single image: exactly "<prefix>.ext", no digit at all.
            foreach (var ext in allowedExtensions)
            {
                var candidate = prefix + ext;
                if (System.IO.File.Exists(Path.Combine(folderPath, candidate)))
                {
                    fileNames.Add(candidate);
                    break;
                }
            }

            _logger.LogInformation(
                "Characterart: ResolveCandidatesUncached - single-image mode, searched pattern=\"{Prefix}.<ext>\", match: [{Files}]",
                prefix, string.Join(", ", fileNames));
            return fileNames;
        }

        // Multi-image (found via user feedback): the FIRST image is the
        // unnumbered one, matching Single mode's own naming exactly - only
        // the SECOND image onward gets a number, starting at 1 again -
        // "prefix1.ext" is the second image, not the first. This is the
        // opposite convention from Extraposter/Poster, where the
        // unnumbered file is Jellyfin's own NATIVE main poster and never
        // part of the candidate list itself - Characterart has no native
        // image field to fall back on, so the unnumbered file has to be a
        // genuine, first-class member of ITS OWN candidate list, standing
        // in for a "main image" the same way Poster's native image does.
        var unnumberedFound = false;
        foreach (var ext in allowedExtensions)
        {
            var candidate = prefix + ext;
            if (System.IO.File.Exists(Path.Combine(folderPath, candidate)))
            {
                fileNames.Add(candidate);
                unnumberedFound = true;
                break;
            }
        }

        var numberedFilesFound = 0;
        for (var i = 1; i <= MaxNumberedImages; i++)
        {
            var found = false;
            foreach (var ext in allowedExtensions)
            {
                var candidate = prefix + i.ToString(System.Globalization.CultureInfo.InvariantCulture) + ext;
                if (System.IO.File.Exists(Path.Combine(folderPath, candidate)))
                {
                    fileNames.Add(candidate);
                    found = true;
                    numberedFilesFound++;
                    break;
                }
            }

            // Early-abort gap tolerance, counted independently of whether
            // the unnumbered file was found - otherwise "only the
            // unnumbered file exists, no numbered ones at all" would
            // needlessly probe all the way up to MaxNumberedImages before
            // giving up (correct result either way, just wasteful).
            if (!found && i >= 3 && numberedFilesFound == 0)
            {
                break;
            }
        }

        _logger.LogInformation(
            "Characterart: ResolveCandidatesUncached - multi-image mode, searched prefix=\"{Prefix}\", unnumbered found={UnnumberedFound}, {NumberedCount} numbered match(es), {TotalCount} total: [{Files}]",
            prefix, unnumberedFound, numberedFilesFound, fileNames.Count, string.Join(", ", fileNames));

        // Deliberately NOT using the shared ApplyOrder/NaturalSort helper
        // here (unlike the Folder-mode branch above, which still does) -
        // NaturalSort sorts unnumbered files AFTER numbered ones
        // (Number.HasValue ? 0 : 1), which is exactly backwards for what
        // we want here: the unnumbered file must come first. "Shuffle"
        // and "Random" both still shuffle everything together, unnumbered
        // file included - "random is random" (explicit user decision, no
        // special casing for the unnumbered file there). "Sequential"
        // needs no sorting at all - fileNames is already in the exact
        // right order, since it was BUILT that way above (unnumbered
        // first, then 1, 2, 3... in the order they were searched for).
        if (orderMode == "Shuffle")
        {
            return fileNames.OrderBy(_ => Guid.NewGuid()).ToList();
        }

        if (orderMode == "Random")
        {
            var rnd = new Random();
            var result = new List<string>(fileNames.Count);
            for (var i = 0; i < fileNames.Count; i++)
            {
                result.Add(fileNames[rnd.Next(fileNames.Count)]);
            }

            return result;
        }

        return fileNames;
    }

    /// <summary>
    /// Applies the admin-configured order (found missing entirely until a
    /// user report - Extraposter/AnimatedPoster already had this, but
    /// Characterart's rotation never did): "Random" shuffles once per
    /// resolve (same principle as ExtraposterController's identical
    /// Random handling - re-shuffled again whenever the underlying
    /// candidate-list cache entry is recomputed, not on every single
    /// request), anything else (including the default "Sequential")
    /// keeps the natural numeric order. A no-op for the single-image
    /// return paths above (0 or 1 entries - no visible difference either
    /// way), kept consistent there anyway rather than special-cased, so
    /// this function is the one single place order handling lives.
    /// </summary>
    private static List<string> ApplyOrder(List<string> fileNames, string orderMode)
    {
        if (orderMode == "Shuffle")
        {
            // A full permutation of the whole list, freshly re-rolled on
            // every call by this method's own caller (see
            // ResolveCandidates - the caching layer above deliberately
            // caches only the raw discovery result, never this shuffled
            // outcome) - guarantees every image appears exactly once
            // before any repeat, since the entire returned sequence for
            // one request/round is a genuine permutation, not an
            // independent draw per position.
            return fileNames.OrderBy(_ => Guid.NewGuid()).ToList();
        }

        if (orderMode == "Random")
        {
            // Deliberately the simplest possible random pick, distinct
            // from "Shuffle" above: independently draws (WITH
            // replacement) for every position in a list of the same
            // length as the candidate pool - the same file can appear
            // more than once, or not at all, in a given result. Explicit
            // user request: "ein einfacher zufallsgenerator (es könnten
            // auch immer dieselben kommen)".
            var rnd = new Random();
            var result = new List<string>(fileNames.Count);
            for (var i = 0; i < fileNames.Count; i++)
            {
                result.Add(fileNames[rnd.Next(fileNames.Count)]);
            }

            return result;
        }

        return NaturalSort(fileNames);
    }

    /// <summary>
    /// Genuine alphanumeric "natural sort" - see the identical, more
    /// fully-commented implementation in ExtraposterController.NaturalSort
    /// for the complete reasoning. Kept as a separate copy here per this
    /// project's existing per-controller-code convention (same as
    /// PosterEntry/ImageEntry, ComputeETag, etc. elsewhere). Also used
    /// directly by the Folder-mode branch above (arbitrary file names,
    /// where the "banana before banana1" behavior actually matters) - the
    /// Standalone/Prefixed multi-image branch further above does NOT call
    /// this (it builds its own already-correctly-ordered list directly,
    /// bypassing this for reasons specific to that branch - see its own
    /// comment).
    /// </summary>
    private static List<string> NaturalSort(List<string> fileNames)
    {
        var result = new List<string>(fileNames);
        result.Sort(NaturalFileNameComparer.Instance);
        return result;
    }

    private sealed class NaturalFileNameComparer : IComparer<string>
    {
        public static readonly NaturalFileNameComparer Instance = new();

        private static readonly Regex ChunkPattern = new(@"\d+|\D+", RegexOptions.Compiled);

        public int Compare(string? a, string? b)
        {
            if (a is null || b is null)
            {
                return string.CompareOrdinal(a, b);
            }

            var stemA = Path.GetFileNameWithoutExtension(a);
            var stemB = Path.GetFileNameWithoutExtension(b);

            var chunksA = ChunkPattern.Matches(stemA);
            var chunksB = ChunkPattern.Matches(stemB);
            var count = Math.Min(chunksA.Count, chunksB.Count);

            for (var i = 0; i < count; i++)
            {
                var chunkA = chunksA[i].Value;
                var chunkB = chunksB[i].Value;
                var isDigitA = char.IsDigit(chunkA[0]);
                var isDigitB = char.IsDigit(chunkB[0]);

                var cmp = isDigitA && isDigitB
                    ? CompareNumericChunks(chunkA, chunkB)
                    : string.Compare(chunkA, chunkB, StringComparison.OrdinalIgnoreCase);

                if (cmp != 0)
                {
                    return cmp;
                }
            }

            if (chunksA.Count != chunksB.Count)
            {
                return chunksA.Count - chunksB.Count;
            }

            return string.Compare(a, b, StringComparison.OrdinalIgnoreCase);
        }

        private static int CompareNumericChunks(string a, string b)
        {
            var trimmedA = a.TrimStart('0');
            var trimmedB = b.TrimStart('0');
            if (trimmedA.Length == 0)
            {
                trimmedA = "0";
            }

            if (trimmedB.Length == 0)
            {
                trimmedB = "0";
            }

            return trimmedA.Length != trimmedB.Length
                ? trimmedA.Length - trimmedB.Length
                : string.CompareOrdinal(trimmedA, trimmedB);
        }
    }

    private static string GetContentType(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            ".svg" => "image/svg+xml",
            _ => "image/jpeg"
        };
    }

    private static string ComputeETag(params object?[] parts)
    {
        var raw = string.Join('|', parts.Select(p => p?.ToString() ?? string.Empty));
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw));
        return "\"" + Convert.ToHexString(hash)[..16] + "\"";
    }

    private bool IsETagStillValid(string etag)
    {
        Response.Headers.ETag = etag;
        Response.Headers.CacheControl = "no-cache";
        var ifNoneMatch = Request.Headers.IfNoneMatch.ToString();
        return !string.IsNullOrEmpty(ifNoneMatch) && ifNoneMatch == etag;
    }

    private DateTime SafeGetLastWriteTimeUtc(string folderPath)
    {
        try
        {
            return Directory.GetLastWriteTimeUtc(folderPath);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Characterart: SafeGetLastWriteTimeUtc failed for \"{Folder}\"", folderPath);
            return DateTime.MinValue;
        }
    }
}
