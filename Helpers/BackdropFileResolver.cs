using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Session 118: file-system backdrop resolution that mirrors Jellyfin's own
/// <c>LocalImageProvider.PopulateBackdrops</c> (10.10.7) 1:1 - the only
/// difference is that the base name of the last stage ("backdrop") is
/// configurable ("Listener: Custom", base name e.g. "fanart"). Jellyfin's
/// side patterns (fanart-N, background-N, art-N, extrafanart\) are kept as
/// they are in Jellyfin, so with base name "backdrop" the result is
/// identical to what Jellyfin stores in its database.
///
/// Also hosts the two smaller resolvers that are deliberately NOT Jellyfin
/// behaviour: per-episode files with the episode file-name prefix
/// (Jellyfin knows no episode backdrops beyond "episodefile-fanart") and
/// the People folder files (backdrop.ext / backdropN.ext in a person's
/// metadata folder). Both share the Single/Multiple rule: Multiple = the
/// plain "name.ext" as index 0 PLUS name1..name20, Single = the plain
/// file only.
///
/// Pure static code over the file system - unit-tested against a temporary
/// folder tree in tests/test_backdrop_resolver.py (through a tiny console
/// harness), with base name "backdrop" checked to equal Jellyfin's order.
/// A per-folder cache (path + last write time) keeps the 100-item pools
/// cheap; the cache is process-wide and evicts itself on folder changes.
/// </summary>
public static class BackdropFileResolver
{
    /// <summary>Jellyfin's own extension order (BaseItem.SupportedImageExtensions) - the order decides which file wins when a name exists in several formats.</summary>
    public static readonly string[] JellyfinExtensionOrder = { ".png", ".jpg", ".jpeg", ".webp", ".tbn", ".gif", ".svg" };

    private const int MaxNumbered = 20;
    private const int MaxConsecutiveMisses = 3;

    private static readonly ConcurrentDictionary<string, (DateTime Stamp, List<FileEntry> Files)> FolderCache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>One image file in a folder, pre-split for Jellyfin's length/prefix/suffix matching.</summary>
    public sealed record FileEntry(string FullPath, string NameWithoutExtension, string Extension, long Length);

    /// <summary>
    /// The full Jellyfin sequence with a custom last-stage name. Returns the
    /// files in Jellyfin's order (index 0 = first found), each file at most
    /// once, filtered to <paramref name="allowedExtensions"/> (null/empty =
    /// every Jellyfin-supported extension).
    /// </summary>
    public static List<string> ResolveLikeJellyfin(string folder, string? fileNameWithoutExtension, bool isInMixedFolder, string baseName, IReadOnlyCollection<string>? allowedExtensions)
    {
        var files = ListImageFiles(folder);
        var images = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var imagePrefix = string.IsNullOrEmpty(fileNameWithoutExtension) ? null : fileNameWithoutExtension + "-";

        void Add(string? path)
        {
            if (path is not null && seen.Add(path)) { images.Add(path); }
        }

        // Stage 1: "<file>-fanart" (with the prefix, and without it when not in a mixed folder)
        if (!string.IsNullOrEmpty(fileNameWithoutExtension))
        {
            Add(GetImage(files, fileNameWithoutExtension + "-fanart", imagePrefix));
            if (!isInMixedFolder) { Add(GetImage(files, fileNameWithoutExtension + "-fanart", null)); }
        }

        // Stages 2-4: Jellyfin's fixed side names
        PopulateNumbered(files, imagePrefix, "fanart", "fanart-", isInMixedFolder, Add);
        PopulateNumbered(files, imagePrefix, "background", "background-", isInMixedFolder, Add);
        PopulateNumbered(files, imagePrefix, "art", "art-", isInMixedFolder, Add);

        // Stage 5: everything inside "extrafanart\"
        var extra = Path.Combine(folder, "extrafanart");
        if (Directory.Exists(extra))
        {
            foreach (var f in ListImageFiles(extra))
            {
                Add(f.FullPath);
            }
        }

        // Stage 6: the base name - "backdrop" in Jellyfin, the user's word here (backdrop, backdrop1..20, no dash)
        PopulateNumbered(files, imagePrefix, baseName, baseName, isInMixedFolder, Add);

        return FilterExtensions(images, allowedExtensions);
    }

    /// <summary>
    /// Per-episode files: "<episodefile>-<name>.ext" (Single) or that plus
    /// "<episodefile>-<name>1..20.ext" (Multiple). Prefix is mandatory -
    /// episodes always share their folder.
    /// </summary>
    public static List<string> ResolvePrefixed(string folder, string fileNameWithoutExtension, string baseName, bool multiple, IReadOnlyCollection<string>? allowedExtensions)
    {
        var files = ListImageFiles(folder);
        var prefix = fileNameWithoutExtension + "-";
        var images = new List<string>();
        var first = GetImage(files, baseName, prefix);
        if (first is not null) { images.Add(first); }
        if (multiple)
        {
            AddNumbered(files, prefix, baseName, images);
        }

        return FilterExtensions(images, allowedExtensions);
    }

    /// <summary>
    /// Plain files in a folder without any prefix (People folder):
    /// "<name>.ext" (Single) or that plus "<name>1..20.ext" (Multiple).
    /// </summary>
    public static List<string> ResolvePlain(string folder, string baseName, bool multiple, IReadOnlyCollection<string>? allowedExtensions)
    {
        var files = ListImageFiles(folder);
        var images = new List<string>();
        var first = GetImage(files, baseName, null);
        if (first is not null) { images.Add(first); }
        if (multiple)
        {
            AddNumbered(files, null, baseName, images);
        }

        return FilterExtensions(images, allowedExtensions);
    }

    /// <summary>Parses the plugin's "jpg,png" list into ".jpg" style extensions; empty = null (no filter).</summary>
    public static IReadOnlyCollection<string>? ParseAllowedFormats(string? csv)
    {
        var list = (csv ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();
        return list.Length == 0 ? null : list;
    }

    /// <summary>Drops the cache entry of one folder (tests, or after a known write).</summary>
    public static void Invalidate(string folder) => FolderCache.TryRemove(folder, out _);

    // ------------------------------------------------------------------

    private static void PopulateNumbered(List<FileEntry> files, string? imagePrefix, string firstFileName, string subsequentPrefix, bool isInMixedFolder, Action<string?> add)
    {
        // With the item's own prefix ("<file>-")
        if (imagePrefix is not null)
        {
            add(GetImage(files, imagePrefix + firstFileName, null));
            var unfound = 0;
            for (var i = 1; i <= MaxNumbered; i++)
            {
                var found = GetImage(files, imagePrefix + subsequentPrefix + i, null);
                add(found);
                if (found is null && ++unfound >= MaxConsecutiveMisses) { break; }
                if (found is not null) { unfound = 0; }
            }
        }

        // Without the prefix - only when the item has its own folder
        if (!isInMixedFolder)
        {
            add(GetImage(files, firstFileName, null));
            var unfound = 0;
            for (var i = 1; i <= MaxNumbered; i++)
            {
                var found = GetImage(files, subsequentPrefix + i, null);
                add(found);
                if (found is null && ++unfound >= MaxConsecutiveMisses) { break; }
                if (found is not null) { unfound = 0; }
            }
        }
    }

    private static void AddNumbered(List<FileEntry> files, string? prefix, string baseName, List<string> images)
    {
        var unfound = 0;
        for (var i = 1; i <= MaxNumbered; i++)
        {
            var found = GetImage(files, baseName + i, prefix);
            if (found is not null) { images.Add(found); unfound = 0; }
            else if (++unfound >= MaxConsecutiveMisses) { break; }
        }
    }

    /// <summary>Jellyfin's GetImage: exact length, prefix and suffix match, case-insensitive; files are in extension order so the first hit is the preferred format.</summary>
    private static string? GetImage(List<FileEntry> files, string name, string? prefix)
    {
        var wanted = (prefix ?? string.Empty).Length + name.Length;
        foreach (var f in files)
        {
            if (f.NameWithoutExtension.Length != wanted) { continue; }
            if (prefix is not null && !f.NameWithoutExtension.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { continue; }
            if (!f.NameWithoutExtension.EndsWith(name, StringComparison.OrdinalIgnoreCase)) { continue; }
            return f.FullPath;
        }

        return null;
    }

    private static List<string> FilterExtensions(List<string> paths, IReadOnlyCollection<string>? allowed)
    {
        if (allowed is null || allowed.Count == 0) { return paths; }
        return paths.Where(p => allowed.Contains(Path.GetExtension(p), StringComparer.OrdinalIgnoreCase)).ToList();
    }

    private static List<FileEntry> ListImageFiles(string folder)
    {
        if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) { return new List<FileEntry>(); }
        var stamp = Directory.GetLastWriteTimeUtc(folder);
        if (FolderCache.TryGetValue(folder, out var cached) && cached.Stamp == stamp) { return cached.Files; }

        var entries = new List<FileEntry>();
        foreach (var path in Directory.EnumerateFiles(folder))
        {
            var ext = Path.GetExtension(path);
            if (Array.FindIndex(JellyfinExtensionOrder, e => e.Equals(ext, StringComparison.OrdinalIgnoreCase)) < 0) { continue; }
            long length;
            try { length = new FileInfo(path).Length; } catch (IOException) { continue; }
            if (length <= 0) { continue; }
            entries.Add(new FileEntry(path, Path.GetFileNameWithoutExtension(path), ext, length));
        }

        // Jellyfin orders the directory listing by its extension list, so "name.png" beats "name.jpg"
        entries = entries.OrderBy(e => Array.FindIndex(JellyfinExtensionOrder, x => x.Equals(e.Extension, StringComparison.OrdinalIgnoreCase))).ToList();
        FolderCache[folder] = (stamp, entries);
        return entries;
    }
}
