using System;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Result DTO for Red Carpet. The leanest of all five controllers - no
/// naming pattern, no timing, always exactly 1 static image per person
/// (curriculum section H).
/// </summary>
public class RedCarpetResult
{
    public bool IsApplicable { get; set; }

    public string Position { get; set; } = "BottomLeft";

    public string ScaleMode { get; set; } = "Height";

    public double HeightVh { get; set; } = 15;

    public double MaxWidthVw { get; set; }

    public double WidthVw { get; set; } = 10.5;

    public double MaxHeightVh { get; set; }

    public string HorizontalAlign { get; set; } = "Center";

    public double HorizontalOffsetVw { get; set; }

    // Per-position extra horizontal offset (vw), added to
    // HorizontalOffsetVw ONLY while the tab is in fullscreen - see
    // PluginConfiguration.CharacterartMoviesTopRightFullscreenOffsetVw's
    // own doc comment for the full reasoning; same idea, applied here
    // for RedCarpet's own two positions.
    public double FullscreenHorizontalOffsetVw { get; set; }

    /// <summary>
    /// Version fingerprint (LastWriteTimeUtc.Ticks-Length) of the
    /// resolved image file - see ExtraposterController.PosterEntry for
    /// the full reasoning. Empty when not applicable/no file found.
    /// </summary>
    public string Version { get; set; } = string.Empty;
}

/// <summary>
/// The fifth, fully independent feature block (curriculum section H). A
/// fundamentally different storage structure than all the others: ONE
/// global, shared folder (IServerApplicationPaths.InternalMetadataPath +
/// "Red Carpet") instead of a per-item folder - an actor appears in many
/// movies, duplicating per item wouldn't make sense. Name matching is
/// exactly via Person.Name (TheMovieDB convention, 1:1 like Jellyfin
/// itself), no free-text field/naming pattern needed. Logging philosophy
/// identical to the other controllers (curriculum D0b).
/// </summary>
[ApiController]
[Route("RedCarpet")]
[AllowAnonymous]
public class RedCarpetController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<RedCarpetController> _logger;
    private readonly IMemoryCache _cache;
    private readonly IServerApplicationPaths _applicationPaths;

    private static readonly TimeSpan CacheSlidingExpiration = TimeSpan.FromHours(6);

    public RedCarpetController(
        ILibraryManager libraryManager,
        ILogger<RedCarpetController> logger,
        IMemoryCache cache,
        IServerApplicationPaths applicationPaths)
    {
        _libraryManager = libraryManager;
        _logger = logger;
        _cache = cache;
        _applicationPaths = applicationPaths;
    }

    /// <summary>
    /// GET /RedCarpet/{personId}?scope=info|movie|series|episode - "scope"
    /// chooses which of the four independent "where to show" fields is
    /// checked (curriculum H). If the parameter is missing, "info" is
    /// assumed. The server checks for itself whether the itemId even
    /// belongs to a person - the frontend doesn't have to detect the page
    /// type itself, it just always asks and trusts the result (see
    /// animatedposter.js/script.js: the same "the plugin stays dumb"
    /// principle).
    /// </summary>
    [HttpGet("{personId}")]
    public ActionResult<RedCarpetResult> GetRedCarpet([FromRoute] Guid personId, [FromQuery] string? scope)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            if (!config.RedCarpetEnabled)
            {
                return Ok(new RedCarpetResult { IsApplicable = false });
            }

            var fileName = IsScopeEnabled(scope, config) ? FindImageFileName(personId, config) : null;
            var applicable = fileName is not null;

            var sizing = ResolvePositionSizing(config);
            var etag = ComputeETag(personId, scope ?? "info", applicable, config.RedCarpetPosition,
                sizing.ScaleMode, sizing.HeightVh, sizing.MaxWidthVw, sizing.WidthVw, sizing.MaxHeightVh,
                sizing.HorizontalAlign, sizing.OffsetVw);
            if (IsETagStillValid(etag))
            {
                return StatusCode(StatusCodes.Status304NotModified);
            }

            var version = string.Empty;
            if (fileName is not null)
            {
                try
                {
                    var fileInfo = new FileInfo(Path.Combine(GetRedCarpetFolder(config), fileName));
                    version = fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)
                        + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture);
                }
                catch (Exception)
                {
                    version = string.Empty;
                }
            }

            return Ok(new RedCarpetResult
            {
                IsApplicable = applicable,
                Position = config.RedCarpetPosition,
                ScaleMode = sizing.ScaleMode,
                HeightVh = sizing.HeightVh,
                MaxWidthVw = sizing.MaxWidthVw,
                WidthVw = sizing.WidthVw,
                MaxHeightVh = sizing.MaxHeightVh,
                HorizontalAlign = sizing.HorizontalAlign,
                HorizontalOffsetVw = sizing.OffsetVw,
                FullscreenHorizontalOffsetVw = sizing.FullscreenOffsetVw,
                Version = version
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "RedCarpet: Unexpected error in GetRedCarpet for {PersonId}", personId);
            return Ok(new RedCarpetResult { IsApplicable = false });
        }
    }

    /// <summary>
    /// GET /RedCarpet/{personId}/image - serves the PNG file. No fileName
    /// needed in the path (always exactly "&lt;Person.Name&gt;.png").
    /// </summary>
    [HttpGet("{personId}/image")]
    public ActionResult GetRedCarpetImage([FromRoute] Guid personId)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            if (!config.RedCarpetEnabled)
            {
                return NotFound();
            }

            var fileName = FindImageFileName(personId, config);
            if (fileName is null)
            {
                return NotFound();
            }

            var fullPath = Path.Combine(GetRedCarpetFolder(config), fileName);
            if (!System.IO.File.Exists(fullPath))
            {
                _logger.LogWarning("RedCarpet: GetRedCarpetImage 404 - file no longer exists: \"{Path}\"", fullPath);
                return NotFound();
            }

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
                _logger.LogDebug("RedCarpet: GetRedCarpetImage - ETag unchanged, 304 for \"{Path}\"", fullPath);
                return StatusCode(StatusCodes.Status304NotModified);
            }

            var stream = System.IO.File.OpenRead(fullPath);
            _logger.LogDebug("RedCarpet: GetRedCarpetImage 200 - serving \"{Path}\"", fullPath);
            return File(stream, "image/png");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "RedCarpet: Unexpected error in GetRedCarpetImage for {PersonId}", personId);
            return NotFound();
        }
    }

    // NOTE: this controller used to have its own GET /RedCarpet/script.js
    // endpoint here, serving Jellyfin-ArtworkPlus-RedCarpet-v1.js from
    // disk. That file no longer exists on its own - explicit user
    // decision to merge RedCarpet and CharacterArt's own, previously
    // separate client scripts into one file, Jellyfin-ArtworkPlus-
    // RenderArt-v1.js (file-level merge only - neither feature's own
    // behavior, admin-UI section, or settings changed; the two keep
    // running as two entirely independent, non-interacting sections
    // within that one file). The client script is now served by
    // RenderArtController's own GetScript() endpoint instead
    // (GET /RenderArt/script.js). This controller's OWN data endpoints
    // below (red-carpet resolution, image serving) are unchanged and
    // still exactly what RenderArt-v1.js's own RedCarpet section calls.

    /// <summary>
    /// Sizing is configured separately per position (curriculum H, same
    /// redesigned system as Characterart's own - see its detailed
    /// comment) - picks the set matching whichever of the two positions
    /// is currently selected.
    /// </summary>
    private static (string ScaleMode, double HeightVh, double MaxWidthVw, double WidthVw, double MaxHeightVh, string HorizontalAlign, double OffsetVw, double FullscreenOffsetVw)
        ResolvePositionSizing(PluginConfiguration config)
    {
        return config.RedCarpetPosition == "BottomRight"
            ? (config.RedCarpetBottomRightScaleMode, config.RedCarpetBottomRightHeightVh, config.RedCarpetBottomRightMaxWidthVw, config.RedCarpetBottomRightWidthVw, config.RedCarpetBottomRightMaxHeightVh, config.RedCarpetBottomRightHorizontalAlign, config.RedCarpetBottomRightOffsetVw, config.RedCarpetBottomRightFullscreenOffsetVw)
            : (config.RedCarpetBottomLeftScaleMode, config.RedCarpetBottomLeftHeightVh, config.RedCarpetBottomLeftMaxWidthVw, config.RedCarpetBottomLeftWidthVw, config.RedCarpetBottomLeftMaxHeightVh, config.RedCarpetBottomLeftHorizontalAlign, config.RedCarpetBottomLeftOffsetVw, config.RedCarpetBottomLeftFullscreenOffsetVw);
    }

    private static bool IsScopeEnabled(string? scope, PluginConfiguration config)
    {
        return scope switch
        {
            "movie" => config.RedCarpetShowOnMovies,
            "series" => config.RedCarpetShowOnTvShows,
            "episode" => config.RedCarpetShowOnEpisodes,
            _ => config.RedCarpetShowOnInfoPage // "info" or no parameter
        };
    }

    /// <summary>
    /// Computes the global, shared Red Carpet folder at runtime -
    /// InternalMetadataPath automatically accounts for a metadata path the
    /// admin has reconfigured themselves, which also makes this work
    /// cross-platform without a hardcoded Windows path (curriculum H).
    /// </summary>
    private string GetRedCarpetFolder(PluginConfiguration config)
    {
        return Path.Combine(_applicationPaths.InternalMetadataPath, config.RedCarpetFolderName);
    }

    /// <summary>
    /// Resolves a personId and looks for the matching file - with a
    /// server cache in front of it, the same principle as in the other
    /// controllers. Checks for itself whether the itemId is even a person
    /// (no trust in the frontend).
    /// </summary>
    private string? FindImageFileName(Guid personId, PluginConfiguration config)
    {
        var item = _libraryManager.GetItemById(personId);
        if (item is not Person person)
        {
            _logger.LogInformation("RedCarpet: FindImageFileName - {PersonId} isn't a Person, skipping", personId);
            return null;
        }

        var folder = GetRedCarpetFolder(config);
        if (!Directory.Exists(folder))
        {
            _logger.LogWarning("RedCarpet: FindImageFileName - the Red Carpet folder wasn't found: \"{Folder}\"", folder);
            return null;
        }

        var lastWriteUtc = SafeGetLastWriteTimeUtc(folder);
        var cacheKey = string.Join('|', "RedCarpet:File", folder, lastWriteUtc.Ticks, person.Name, config.RedCarpetAllowedFormats);

        if (_cache.TryGetValue(cacheKey, out string? cached))
        {
            return cached;
        }

        // CHANGED: used to be hardcoded to ".png" only - real gap found
        // and fixed per explicit user request, now reads
        // RedCarpetAllowedFormats same as every other feature's own
        // allowed-formats field. Still an exact 1:1 name match per
        // extension, no naming-pattern logic needed (curriculum H: names
        // in the resource pack follow the exact same TheMovieDB
        // convention Jellyfin itself uses for Person.Name) - just tried
        // across every configured extension now instead of only .png.
        var extensions = (config.RedCarpetAllowedFormats ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();
        if (extensions.Length == 0)
        {
            extensions = new[] { ".png" };
        }

        string? found = null;
        foreach (var ext in extensions)
        {
            var candidate = person.Name + ext;
            if (System.IO.File.Exists(Path.Combine(folder, candidate)))
            {
                found = candidate;
                break;
            }
        }

        _logger.LogInformation(
            "RedCarpet: FindImageFileName - searched: \"{Name}\" with extensions [{Ext}] in \"{Folder}\" -> {Result}",
            person.Name, string.Join(", ", extensions), folder, found ?? "no match");

        _cache.Set(cacheKey, found, new MemoryCacheEntryOptions().SetSlidingExpiration(CacheSlidingExpiration));
        return found;
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
            _logger.LogWarning(ex, "RedCarpet: SafeGetLastWriteTimeUtc failed for \"{Folder}\"", folderPath);
            return DateTime.MinValue;
        }
    }
}
