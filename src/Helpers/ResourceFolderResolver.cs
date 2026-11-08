using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// The "Resource folder" source of
/// Genre / Studio / Tag / Favorites Backdrops - Kodi resource add-on style, a
/// folder of ready-made images per name:
/// <c>&lt;metadata&gt;\&lt;folder&gt;\[&lt;subfolder&gt;\]&lt;label&gt;\&lt;any image&gt;</c>.
///
/// Label -> folder name: ": " becomes " - ", then every
/// character of Jellyfin's FIXED invalid set (ManagedFileSystem
/// _invalidPathCharacters, 10.10.7 lines 20-27 - not the platform's
/// Path.GetInvalidFileNameChars(), which on Linux is only '/' and '\0') becomes
/// a space, then leading/trailing spaces and trailing dots go.
///
/// Matching: both sides Unicode-normalised (NFC - folders
/// copied from a Mac / some NAS arrive as NFD), case-insensitive (Linux file
/// systems are not), the exact name first, then accent-insensitive (diacritics
/// stripped; ß/ss are NOT equated). Every path is checked to stay inside the
/// metadata folder (a Tag label comes straight from the URL).
///
/// Pure static code over the file system, so it can be unit-tested on its own.
/// </summary>
public static class ResourceFolderResolver
{
    /// <summary>At most this many images per page visit - drawn at random.</summary>
    public const int MaxImages = 100;

    /// <summary>Jellyfin's fixed invalid path characters (ManagedFileSystem, 10.10.7).</summary>
    private static readonly char[] InvalidCharacters = BuildInvalidCharacters();

    /// <summary>
    /// The Favorites sections by their BaseItemKind name -> the English
    /// section name (favorites.js section names, the names the admin tab uses).
    /// People is not here: it keeps its own three sources.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> FavoritesSectionNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["Movie"] = "Movies",
        ["Series"] = "Shows",
        ["Episode"] = "Episodes",
        ["Video"] = "Videos",
        ["BoxSet"] = "Collections",
        ["Playlist"] = "Playlists",
        ["MusicArtist"] = "Artists",
        ["MusicAlbum"] = "Albums",
        ["Audio"] = "Songs",
        ["Book"] = "Books"
    };

    /// <summary>A genre / studio / tag / section name as a folder name (": " becomes " - ", then Jellyfin's invalid set).</summary>
    public static string LabelToFolderName(string? label)
    {
        var s = (label ?? string.Empty).Replace(": ", " - ", StringComparison.Ordinal);
        var chars = s.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
        {
            if (Array.IndexOf(InvalidCharacters, chars[i]) >= 0) { chars[i] = ' '; }
        }

        return new string(chars).Trim().TrimEnd('.').Trim();
    }

    /// <summary>
    /// The resource root: &lt;metadata&gt;\&lt;folder&gt;[\&lt;subfolder&gt;]. Null when a
    /// name is empty after cleaning or the result would leave the metadata
    /// folder. The names are expected to be cleaned already (ConfigNames on
    /// save); this is the second safeguard.
    /// </summary>
    public static string? ResourceRoot(string metadataPath, string? folderName, string? subFolderName)
    {
        var folder = CleanSegment(folderName);
        if (string.IsNullOrEmpty(folder)) { return null; }
        var root = ChildDirectory(metadataPath, folder);
        if (subFolderName is not null)
        {
            var sub = CleanSegment(subFolderName);
            if (string.IsNullOrEmpty(sub)) { return null; }
            root = ChildDirectory(root, sub);
        }

        return IsInside(metadataPath, root) ? root : null;
    }

    /// <summary>
    /// parent\name - the existing directory whose name matches
    /// case-insensitively when the exact spelling does not exist (Linux file
    /// systems are case-sensitive, the admin's field may differ in case).
    /// </summary>
    private static string ChildDirectory(string parent, string name)
    {
        var exact = Path.Combine(parent, name);
        if (Directory.Exists(exact) || !Directory.Exists(parent)) { return exact; }
        try
        {
            var wanted = name.Normalize(NormalizationForm.FormC);
            foreach (var dir in Directory.GetDirectories(parent).OrderBy(d => d, StringComparer.Ordinal))
            {
                if (string.Equals(Path.GetFileName(dir).Normalize(NormalizationForm.FormC), wanted, StringComparison.OrdinalIgnoreCase)) { return dir; }
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }

        return exact;
    }

    /// <summary>
    /// The label folder inside <paramref name="root"/>: the exact (normalised,
    /// case-insensitive) name first, then the accent-insensitive one. Null when
    /// there is none or it would leave <paramref name="root"/>.
    /// </summary>
    public static string? FindLabelFolder(string? root, string? label)
    {
        if (string.IsNullOrEmpty(root) || !Directory.Exists(root)) { return null; }
        var wanted = LabelToFolderName(label);
        if (string.IsNullOrEmpty(wanted)) { return null; }
        var wantedNfc = wanted.Normalize(NormalizationForm.FormC);
        var wantedBare = StripDiacritics(wantedNfc);

        string[] dirs;
        try { dirs = Directory.GetDirectories(root); }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }

        string? accentMatch = null;
        foreach (var dir in dirs.OrderBy(d => d, StringComparer.Ordinal))
        {
            var name = Path.GetFileName(dir).Normalize(NormalizationForm.FormC);
            if (string.Equals(name, wantedNfc, StringComparison.OrdinalIgnoreCase))
            {
                return IsInside(root, dir) ? dir : null;
            }

            if (accentMatch is null && string.Equals(StripDiacritics(name), wantedBare, StringComparison.OrdinalIgnoreCase))
            {
                accentMatch = dir;
            }
        }

        return accentMatch is not null && IsInside(root, accentMatch) ? accentMatch : null;
    }

    /// <summary>
    /// Every image in <paramref name="folder"/> (not recursive), any file name,
    /// a Jellyfin image extension that is also in <paramref name="allowedExtensions"/>
    /// (null = every one), zero-byte files ignored, sorted by name.
    /// </summary>
    public static List<string> ListImages(string? folder, IReadOnlyCollection<string>? allowedExtensions)
    {
        var result = new List<string>();
        if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) { return result; }
        IEnumerable<string> files;
        try { files = Directory.EnumerateFiles(folder).ToList(); }
        catch (IOException) { return result; }
        catch (UnauthorizedAccessException) { return result; }

        foreach (var path in files)
        {
            var ext = Path.GetExtension(path);
            if (!BackdropFileResolver.JellyfinExtensionOrder.Contains(ext, StringComparer.OrdinalIgnoreCase)) { continue; }
            if (allowedExtensions is not null && allowedExtensions.Count > 0 && !allowedExtensions.Contains(ext, StringComparer.OrdinalIgnoreCase)) { continue; }
            long length;
            try { length = new FileInfo(path).Length; }
            catch (IOException) { continue; }
            if (length <= 0) { continue; }
            result.Add(path);
        }

        return result.OrderBy(p => Path.GetFileName(p), StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>Root + label + images in one call; empty when anything is missing.</summary>
    public static List<string> Resolve(string metadataPath, string? folderName, string? subFolderName, string? label, IReadOnlyCollection<string>? allowedExtensions)
    {
        var labelFolder = FindLabelFolder(ResourceRoot(metadataPath, folderName, subFolderName), label);
        return ListImages(labelFolder, allowedExtensions);
    }

    /// <summary>More than <see cref="MaxImages"/> -> that many drawn at random (fresh each visit), kept in name order.</summary>
    public static List<T> Cap<T>(List<T> images, Random? random = null)
    {
        if (images.Count <= MaxImages) { return images; }
        var rnd = random ?? new Random();
        var picked = new HashSet<int>();
        while (picked.Count < MaxImages) { picked.Add(rnd.Next(images.Count)); }
        return picked.OrderBy(i => i).Select(i => images[i]).ToList();
    }

    /// <summary>true when <paramref name="candidate"/> lies inside <paramref name="root"/> (full paths compared).</summary>
    public static bool IsInside(string root, string candidate)
    {
        try
        {
            var r = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var c = Path.GetFullPath(candidate);
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            return c.StartsWith(r, comparison);
        }
        catch (ArgumentException) { return false; }
        catch (NotSupportedException) { return false; }
        catch (PathTooLongException) { return false; }
    }

    /// <summary>
    /// The same one-segment rule as <c>ConfigNames.Clean</c> (directory parts,
    /// "." and ".." dropped) - repeated here so this helper stays free of the
    /// configuration class and the test harness can compile it on its own.
    /// </summary>
    private static string CleanSegment(string? value)
    {
        var v = (value ?? string.Empty).Trim().Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
        var name = Path.GetFileName(v).Trim();
        return name == "." || name == ".." ? string.Empty : name;
    }

    private static string StripDiacritics(string s)
    {
        var d = s.Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(d.Length);
        foreach (var ch in d)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) != UnicodeCategory.NonSpacingMark) { sb.Append(ch); }
        }

        return sb.ToString().Normalize(NormalizationForm.FormC);
    }

    private static char[] BuildInvalidCharacters()
    {
        var list = new List<char> { '"', '<', '>', '|', '\0', ':', '*', '?', '\\', '/' };
        for (var i = 1; i <= 31; i++) { list.Add((char)i); }
        return list.ToArray();
    }
}
