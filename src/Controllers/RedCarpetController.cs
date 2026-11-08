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
/// Result DTO for Red Carpet: no naming pattern, no timing, always exactly one
/// static image per person.
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

    // Extra horizontal offset (vw) for the selected position, added to
    // HorizontalOffsetVw only while the tab is in fullscreen; see
    // PluginConfiguration.CharacterartMoviesTopRightFullscreenOffsetVw.
    public double FullscreenHorizontalOffsetVw { get; set; }

    /// <summary>
    /// Version fingerprint (LastWriteTimeUtc.Ticks-Length) of the
    /// resolved image file; see ExtraposterController.PosterEntry. Empty when
    /// not applicable or no file was found.
    /// </summary>
    public string Version { get; set; } = string.Empty;
}

/// <summary>
/// Red Carpet: a full-body image per person. Unlike the other features it uses
/// ONE shared folder (InternalMetadataPath + "Red Carpet") instead of a per-item
/// folder, because an actor appears in many items. Files are matched exactly by
/// Person.Name (the TheMovieDB naming Jellyfin uses), so no naming pattern is needed.
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
    /// chooses which of the four "where to show" settings is checked; missing
    /// means "info". The server checks whether the id belongs to a person, so
    /// the client never has to detect the page type: it always asks and trusts
    /// the result.
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
    /// GET /RedCarpet/{personId}/image - serves the image file. No file name is
    /// needed in the path: it is always "&lt;Person.Name&gt;.&lt;ext&gt;".
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

            // Image bytes caching; see ExtraposterController.GetPosterImage.
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

    // The client script is served by RenderArtController (GET /RenderArt/script.js).

    /// <summary>
    /// Sizing is configured separately per position (same system as
    /// CharacterArt); picks the set for the currently selected position.
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
    /// admin has reconfigured, and keeps this cross-platform without a
    /// hardcoded path.
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

        // Exact name match on Person.Name, tried for every extension in
        // RedCarpetAllowedFormats in order; .png when the list is empty.
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
