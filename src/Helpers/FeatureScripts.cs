using System.IO;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Where a feature script is read from. The release ZIP ships the client
/// scripts next to the DLL; a copy in the plugin's data folder can override
/// them so scripts can be updated without a restart. The NEWER of the two
/// wins (file time), so a catalog update is not shadowed by a stale
/// data-folder copy: a catalog install extracts the ZIP entries with their
/// build time, equal times keep the data-folder copy.
/// </summary>
public static class FeatureScripts
{
    /// <summary>The newer of the data-folder copy and the copy shipped next to the DLL, else whichever exists, else null.</summary>
    public static string? Resolve(string fileName)
    {
        var plugin = Plugin.Instance!;
        var data = Path.Combine(plugin.DataFolderPath, fileName);
        string? shipped = null;
        var dir = Path.GetDirectoryName(plugin.AssemblyFilePath);
        if (!string.IsNullOrEmpty(dir))
        {
            var candidate = Path.Combine(dir, fileName);
            if (File.Exists(candidate))
            {
                shipped = candidate;
            }
        }

        if (File.Exists(data))
        {
            return shipped is null || File.GetLastWriteTimeUtc(data) >= File.GetLastWriteTimeUtc(shipped) ? data : shipped;
        }

        return shipped;
    }
}
