using System;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using MediaBrowser.Controller.Entities.Movies;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Finds a movie's Postercase / Keyart file by the Custom Poster tab's own
/// naming rules (Naming mode, Type name, Formats) - the same
/// logic as CustomPosterController.FindCustomPosterFile, used by
/// Extraposter to show a Set's movies with their custom posters.
/// Deliberately independent of the Custom Poster feature's
/// Enable/Show-on switches: only the file counts.
/// </summary>
public static class CustomPosterFileResolver
{
    /// <summary>Full path of the movie's Postercase ("postercase") or Keyart ("keyart") file, or null.</summary>
    public static string? Resolve(PluginConfiguration config, Movie movie, string posterType)
    {
        var folderPath = movie.ContainingFolderPath;
        if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath)) { return null; }
        var isPostercase = posterType == "postercase";
        // Prefixed or Standalone only (single-image types have no Folder mode).
        var namingMode = (isPostercase ? config.PostercaseMoviesNamingMode : config.KeyartMoviesNamingMode) == "Prefixed" ? "Prefixed" : "Standalone";
        var typeName = isPostercase ? config.PostercaseMoviesTypeName : config.KeyartMoviesTypeName;
        var extensions = (config.CustomPosterAllowedFormats ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();
        if (extensions.Length == 0) { extensions = new[] { ".jpg" }; }

        var prefix = namingMode == "Prefixed" ? Path.GetFileName(folderPath) + "-" + typeName : typeName;
        foreach (var ext in extensions)
        {
            var candidate = Path.Combine(folderPath, prefix + ext);
            if (File.Exists(candidate)) { return candidate; }
        }
        return null;
    }

    public static string ContentType(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".webp" => "image/webp",
            ".png" => "image/png",
            _ => "image/jpeg"
        };
    }
}
