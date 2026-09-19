using System;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using MediaBrowser.Controller.Entities.Movies;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Finds a movie's Animated Poster / Animated Keyart file by the Animated
/// Poster tab's own naming rules (Naming mode, Type name, Formats - "apng"
/// covers .png and .apng, as in AnimatedPosterController.FindAnimatedFile).
/// Extracted in Session 125 so Extraposter can show a Set's movies with
/// their animated files; independent of that feature's own switches (only
/// the file counts, user decision).
/// </summary>
public static class AnimatedPosterFileResolver
{
    /// <summary>Full path of the movie's animated file for "animatedposter" or "animatedkeyart", or null.</summary>
    public static string? Resolve(PluginConfiguration config, Movie movie, string posterType)
    {
        var folderPath = movie.ContainingFolderPath;
        if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath)) { return null; }
        var isKeyart = posterType == "animatedkeyart";
        var namingMode = isKeyart ? config.AnimatedKeyartMoviesNamingMode : config.AnimatedPosterMoviesNamingMode;
        var typeName = isKeyart ? config.AnimatedKeyartMoviesTypeName : config.AnimatedPosterMoviesTypeName;
        var extensions = (config.AnimatedPosterAllowedFormats ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .SelectMany(f => string.Equals(f, "apng", StringComparison.OrdinalIgnoreCase) ? new[] { ".png", ".apng" } : new[] { "." + f.ToLowerInvariant() })
            .Distinct()
            .ToArray();
        if (extensions.Length == 0) { extensions = new[] { ".gif" }; }
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
            ".apng" => "image/apng",
            ".png" => "image/png",
            _ => "image/gif"
        };
    }
}
