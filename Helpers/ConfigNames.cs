using System;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.ArtworkPlus.Configuration;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Audit S1-07 (Session 138): the admin's base / type / folder names go into
/// <c>Path.Combine</c> at ~35 read sites. A value with a directory part
/// (<c>..\..\x</c>, <c>sub/name</c>) would escape the item folder - and the
/// LogoArt creator would even write there. Instead of touching every read
/// site the names are reduced to a single path segment when the configuration
/// is saved (admin page and API both go through <see cref="Plugin.UpdateConfiguration"/>).
/// </summary>
public static class ConfigNames
{
    private static readonly string[] Suffixes = { "FolderName", "BaseName", "TypeName" };

    /// <summary>A single file-name segment: directory parts, "." and ".." are dropped, whitespace trimmed.</summary>
    public static string Clean(string? value)
    {
        var v = (value ?? string.Empty).Trim().Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
        var name = Path.GetFileName(v).Trim();
        if (name == "." || name == "..") { return string.Empty; }
        return name;
    }

    /// <summary>Cleans every string property whose name ends with FolderName / BaseName / TypeName; returns how many changed.</summary>
    public static int Sanitize(PluginConfiguration config)
    {
        var changed = 0;
        foreach (var p in typeof(PluginConfiguration).GetProperties().Where(p => p.PropertyType == typeof(string) && p.CanWrite && Suffixes.Any(s => p.Name.EndsWith(s, StringComparison.Ordinal))))
        {
            var before = (string?)p.GetValue(config);
            var after = Clean(before);
            if (!string.Equals(before, after, StringComparison.Ordinal))
            {
                p.SetValue(config, after);
                changed++;
            }
        }

        return changed;
    }
}
