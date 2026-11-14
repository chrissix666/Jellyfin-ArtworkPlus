using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Metadata.Profiles.Exif;
using SixLabors.ImageSharp.Processing;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Upright copies of game case pictures whose EXIF orientation is not "normal". Only JPEG is turned: Playnite Bridge
/// reads the orientation from JPEG only when it measures a spine, so both sides mean the same picture (a PNG or WebP
/// is served as stored, and the Bridge measures it as stored).
/// </summary>
public static class GameCasePictures
{
    /// <summary>The folder under Jellyfin's cache path that holds the upright copies.</summary>
    public const string CacheFolderName = "artworkplus-gamecase";

    /// <summary>
    /// The fanart booklet's picture: the game's first backdrop with a tag from Playnite Bridge's list (a game has no
    /// library item; the Bridge's filter serves its backdrops at Jellyfin's image URL by that tag, as in Backdrops'
    /// ResolveGameImages). Null without one.
    /// </summary>
    public static string? FanartUrl(Guid id, IReadOnlyList<(string Path, string Tag)> backdrops)
    {
        for (var i = 0; i < backdrops.Count; i++)
        {
            if (!string.IsNullOrEmpty(backdrops[i].Tag))
            {
                return "/Items/" + id.ToString("N") + "/Images/Backdrop/" + i + "?tag=" + Uri.EscapeDataString(backdrops[i].Tag)
                       + "&maxWidth=1280&quality=90";
            }
        }

        return null;
    }

    /// <summary>
    /// The upright, scaled copy of a JPEG with an EXIF orientation of 2-8, kept in <paramref name="cacheDir"/> under a
    /// name from the file, its tag and the rendition; null for every other picture (Jellyfin's processor serves it).
    /// Two first requests at the same moment both get the copy; no temporary file is left behind.
    /// </summary>
    public static async Task<(string Path, string Mime)?> UprightCopy(
        string path, string tag, string version, bool transparent, int maxHeight, int quality, string cacheDir)
    {
        ushort orientation = 1;
        try
        {
            var info = Image.Identify(SafeImages.WithMetadata, path);
            if (info.Metadata.DecodedImageFormat is not JpegFormat)
            {
                return null;
            }

            if (info.Metadata.ExifProfile is { } exif && exif.TryGetValue(ExifTag.Orientation, out var value) && value is not null)
            {
                orientation = value.Value;
            }
        }
        catch (Exception)
        {
            return null;   // not readable here: Jellyfin's processor decides
        }

        if (orientation <= 1)
        {
            return null;
        }

        Directory.CreateDirectory(cacheDir);
        var key = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(path + "|" + tag + "|" + version)), 0, 12).ToLowerInvariant();
        var file = Path.Combine(cacheDir, key + (transparent ? ".png" : ".jpg"));
        if (File.Exists(file))
        {
            return (file, transparent ? "image/png" : "image/jpeg");
        }

        var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var picture = await Image.LoadAsync(SafeImages.WithMetadata, path).ConfigureAwait(false))
            {
                picture.Mutate(x => x.AutoOrient());
                if (picture.Height > maxHeight)
                {
                    picture.Mutate(x => x.Resize(0, maxHeight));   // width 0 = keeps the aspect
                }

                if (transparent)
                {
                    await picture.SaveAsync(temporary, new PngEncoder()).ConfigureAwait(false);
                }
                else
                {
                    await picture.SaveAsync(temporary, new JpegEncoder { Quality = quality }).ConfigureAwait(false);
                }
            }

            Publish(temporary, file);
        }
        finally
        {
            try
            {
                File.Delete(temporary);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        return (file, transparent ? "image/png" : "image/jpeg");
    }

    /// <summary>
    /// Puts a finished copy in its place. Never over a copy that already stands: another request may be streaming it,
    /// and Windows refuses to replace an open file - the first copy stands, this one is dropped.
    /// </summary>
    public static void Publish(string temporary, string file)
    {
        try
        {
            File.Move(temporary, file, false);
        }
        catch (IOException) when (File.Exists(file))
        {
            // the first copy stands; the caller's finally deletes this one
        }
    }
}
