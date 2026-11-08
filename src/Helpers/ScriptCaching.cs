using System;
using System.Globalization;
using System.IO;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Cache headers for the four script endpoints. Without them browsers cache
/// heuristically and an open tab can run a new feature script against an old
/// Core (or the reverse) for hours after an update. Every script answer carries
/// <c>Cache-Control: no-cache</c> (revalidate on every load) and an ETag; an
/// unchanged script is a 304.
/// </summary>
public static class ScriptCaching
{
    /// <summary>ETag of a file script: last write ticks + size, the convention of every image endpoint.</summary>
    public static string FileTag(string path)
    {
        var info = new FileInfo(path);
        return "\"" + info.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture) + "-" + info.Length.ToString(CultureInfo.InvariantCulture) + "\"";
    }

    /// <summary>ETag of the embedded Core: the assembly's module version id changes with every build.</summary>
    public static string AssemblyTag(System.Reflection.Assembly assembly) => "\"" + assembly.ManifestModule.ModuleVersionId.ToString("N") + "\"";

    /// <summary>Sets the headers; true when the client already has this version (answer 304).</summary>
    public static bool NotModified(HttpRequest request, HttpResponse response, string etag)
    {
        response.Headers.ETag = etag;
        response.Headers.CacheControl = "no-cache";
        var ifNoneMatch = request.Headers.IfNoneMatch.ToString();
        return !string.IsNullOrEmpty(ifNoneMatch) && ifNoneMatch == etag;
    }
}
