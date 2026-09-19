using System;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using MediaBrowser.Controller.Entities.Movies;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Finds a movie's Postercase / Keyart file by the Custom Poster tab's own
/// naming rules (Naming mode, Type name, Folder name, Formats) - the same
/// logic as CustomPosterController.FindCustomPosterFile, extracted in
/// Session 125 so Extraposter can show a Set's movies with their custom
/// posters. Deliberately independent of the Custom Poster feature's
/// Enable/Show-on switches: only the file counts (user decision).
/// </summary>
public static class CustomPosterFileResolver
{
    /// <summary>Full path of the movie's Postercase ("postercase") or Keyart ("keyart") file, or null.</summary>
    public static string? Resolve(PluginConfiguration config, Movie movie, string posterType)
    {
        var folderPath = movie.ContainingFolderPath;
        if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath)) { return null; }
        var isPostercase = posterType == "postercase";
        var namingMode = isPostercase ? config.PostercaseMoviesNamingMode : config.KeyartMoviesNamingMode;
        var typeName = isPostercase ? config.PostercaseMoviesTypeName : config.KeyartMoviesTypeName;
        var folderName = isPostercase ? config.PostercaseMoviesFolderName : config.KeyartMoviesFolderName;
        var extensions = (config.CustomPosterAllowedFormats ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();
        if (extensions.Length == 0) { extensions = new[] { ".jpg" }; }

        if (namingMode == "Folder")
        {
            var subFolder = Path.Combine(folderPath, folderName);
            if (!Directory.Exists(subFolder)) { return null; }
            var first = Directory.EnumerateFiles(subFolder)
                .Where(f => extensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase))
                .OrderBy(f => Path.GetFileName(f), StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
            return first;
        }

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
