using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using Jellyfin.Plugin.ArtworkPlus.Helpers;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Result DTO for Animated Poster/Animated Keyart. There is only ever one file,
/// so there are no order or timing fields.
/// </summary>
public class AnimatedPosterResult
{
    public bool IsApplicable { get; set; }

    public string? FileName { get; set; }

    /// <summary>
    /// Version fingerprint (LastWriteTimeUtc.Ticks-Length) of the
    /// resolved file; see ExtraposterController.PosterEntry. Empty when
    /// not applicable or no file was resolved.
    /// </summary>
    public string Version { get; set; } = string.Empty;

    /// <summary>
    /// "animatedposter" or "animatedkeyart" - set only when the request's
    /// "type" was "auto" (see ResolveItemResult), so the client can build the
    /// explicit-type image URL; mirrors CustomPosterResult.ResolvedType. Empty
    /// for an explicit type or when IsApplicable is false.
    /// </summary>
    public string ResolvedType { get; set; } = string.Empty;

    /// <summary>Animated Keyart's logo overlay for the requested view (like Custom Keyart). Only set for ResolvedType "animatedkeyart".</summary>
    public bool LogoEnabled { get; set; }

    public int LogoVerticalPositionPercent { get; set; }

    public int LogoSizePercent { get; set; }

    /// <summary>The item has a Jellyfin Logo image (tiles need no extra request).</summary>
    public bool HasLogo { get; set; }
}

/// <summary>
/// Result DTO of the batch endpoint, analogous to BatchPosterListResult in
/// ExtraposterController.
/// </summary>
public class AnimatedPosterBatchResult
{
    public Dictionary<string, AnimatedPosterResult> Items { get; set; } = new();
}

/// <summary>
/// Animated Poster and Animated Keyart: replace the main poster (or keyart)
/// with an animated file. The controller only reports WHETHER and WHICH file
/// exists; the client script changes the DOM. Both types share this route and
/// are told apart by a "type" parameter, the same way CustomPosterController
/// handles Postercase and Keyart.
/// </summary>
[ApiController]
[Route("AnimatedPoster")]
[AllowAnonymous]
public class AnimatedPosterController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<AnimatedPosterController> _logger;
    private readonly IMemoryCache _cache;

    private static readonly TimeSpan CacheSlidingExpiration = TimeSpan.FromHours(6);

    public AnimatedPosterController(ILibraryManager libraryManager, ILogger<AnimatedPosterController> logger, IMemoryCache cache)
    {
        _libraryManager = libraryManager;
        _logger = logger;
        _cache = cache;
    }

    /// <summary>
    /// GET /AnimatedPoster/{itemId}?type=auto|animatedposter|animatedkeyart&amp;scope=detail|library -
    /// "type": "auto" (the default, used by the client's first request)
    /// picks Animated Poster or Animated Keyart by AnimatedPosterPriority (see
    /// ResolveItemResult); "animatedposter"/"animatedkeyart" resolve exactly
    /// that type, used for the image URL once the winner is known. "scope"
    /// selects the detail or library enable field (Movies/TV Shows x Detail/
    /// Library are four independent switches).
    /// </summary>
    [HttpGet("{itemId}")]
    public ActionResult<AnimatedPosterResult> GetAnimatedPoster([FromRoute] Guid itemId, [FromQuery] string? type, [FromQuery] string? scope, [FromQuery] bool? webgl)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            var posterType = NormalizeType(type);

            if (!IsTypeEnabled(config, posterType))
            {
                return Ok(new AnimatedPosterResult { IsApplicable = false });
            }

            var isLibraryScope = string.Equals(scope, "library", StringComparison.OrdinalIgnoreCase);
            // The Case mix's poster chain: on a detail page whose draw has
            // this slot unticked, the slot does not deliver and the page's
            // chain falls through to the next one. Library scope never asks;
            // the mix is for detail pages only.
            if (!isLibraryScope && config.CaseModMixEnabled
                && !CaseMix.SlotAllowed(CaseMixConfig.DrawFor(config, _libraryManager.GetItemById(itemId), webgl ?? true), "animatedposter", CaseMixConfig.From(config)))
            {
                return Ok(new AnimatedPosterResult { IsApplicable = false });
            }

            var result = ResolveItemResult(itemId, config, posterType, isLibraryScope);
            ApplyKeyartLogo(result, config, isLibraryScope, itemId);

            var etag = ComputeETag(itemId, posterType, isLibraryScope, result?.FileName ?? "none", result?.LogoEnabled ?? false);
            if (IsETagStillValid(etag))
            {
                return StatusCode(StatusCodes.Status304NotModified);
            }

            return Ok(result ?? new AnimatedPosterResult { IsApplicable = false });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "AnimatedPoster: Unexpected error in GetAnimatedPoster for {ItemId}", itemId);
            return Ok(new AnimatedPosterResult { IsApplicable = false });
        }
    }

    /// <summary>
    /// GET /AnimatedPoster/batch?ids=guid1,guid2&amp;type=animatedposter&amp;scope=library -
    /// for the library view, the same principle as
    /// ExtraposterController.GetPosterListBatch. "scope" is almost always
    /// "library" (a detail page needs a single item).
    /// </summary>
    // Same upper bound as ExtraposterController.MaxBatchIds.
    private const int MaxBatchIds = 200;

    [HttpGet("batch")]
    public ActionResult<AnimatedPosterBatchResult> GetAnimatedPosterBatch([FromQuery] string? ids, [FromQuery] string? type, [FromQuery] string? scope, [FromQuery] string? page)
    {
        var config = Plugin.Instance!.Configuration;
        var posterType = NormalizeType(type);
        var result = new AnimatedPosterBatchResult();
        // The page class of this batch (Helpers/AlsoOn), the library grid when absent; the resolver reads the grid switch or the "show also on" box of the item kind.
        var pageClass = string.IsNullOrEmpty(page) ? "library" : page;

        if (!IsTypeEnabled(config, posterType))
        {
            return Ok(result);
        }

        var isLibraryScope = !string.Equals(scope, "detail", StringComparison.OrdinalIgnoreCase);

        var itemIds = (ids ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => Guid.TryParse(s, out var g) ? g : (Guid?)null)
            .Where(g => g.HasValue)
            .Select(g => g!.Value)
            .Distinct()
            .Take(MaxBatchIds)
            .ToList();

        _logger.LogInformation("AnimatedPoster: GetAnimatedPosterBatch - {Count} itemIds requested (type={Type})", itemIds.Count, posterType);

        foreach (var itemId in itemIds)
        {
            // "N" (no dashes): the client looks the answer up by the tile's
            // data-id, which Jellyfin serialises via JsonGuidConverter as the
            // 32-hex form. Dictionary keys are strings and bypass that
            // converter, so Guid.ToString() (dashed) would never match.
            var itemResult = ResolveItemResult(itemId, config, posterType, isLibraryScope, isLibraryScope ? pageClass : null) ?? new AnimatedPosterResult { IsApplicable = false };
            ApplyKeyartLogo(itemResult, config, isLibraryScope, itemId);
            result.Items[itemId.ToString("N")] = itemResult;
        }

        return Ok(result);
    }

    /// <summary>
    /// Animated Keyart's logo overlay values for the requested view, the same
    /// concept as Custom Keyart's. Animated Poster never gets a logo (a poster
    /// carries its title itself).
    /// </summary>
    private void ApplyKeyartLogo(AnimatedPosterResult? result, PluginConfiguration config, bool isLibraryScope, Guid itemId)
    {
        if (result is null || !result.IsApplicable || result.ResolvedType != "animatedkeyart") { return; }
        var enabled = isLibraryScope ? config.AnimatedKeyartLibraryLogoEnabled : config.AnimatedKeyartDetailLogoEnabled;
        if (!enabled) { return; }
        result.LogoEnabled = true;
        result.LogoVerticalPositionPercent = isLibraryScope ? config.AnimatedKeyartLibraryLogoVerticalPositionPercent : config.AnimatedKeyartDetailLogoVerticalPositionPercent;
        result.LogoSizePercent = isLibraryScope ? config.AnimatedKeyartLibraryLogoSizePercent : config.AnimatedKeyartDetailLogoSizePercent;
        result.HasLogo = _libraryManager.GetItemById(itemId)?.HasImage(MediaBrowser.Model.Entities.ImageType.Logo, 0) ?? false;
    }

    /// <summary>
    /// GET /AnimatedPoster/{itemId}/image - serves the animated file
    /// itself. No file name in the path: there is only one possible file per
    /// item and type, and it is resolved entirely on the server.
    /// </summary>
    [HttpGet("{itemId}/image")]
    public ActionResult GetAnimatedPosterImage([FromRoute] Guid itemId, [FromQuery] string? type, [FromQuery] string? scope)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            var posterType = NormalizeType(type);
            if (!IsTypeEnabled(config, posterType))
            {
                return NotFound();
            }

            var isLibraryScope = string.Equals(scope, "library", StringComparison.OrdinalIgnoreCase);
            var result = ResolveItemResult(itemId, config, posterType, isLibraryScope);
            if (result is null || !result.IsApplicable || result.FileName is null)
            {
                return NotFound();
            }

            var folderPath = ResolveFolderPathOnly(itemId);
            if (folderPath is null)
            {
                return NotFound();
            }

            var fullPath = Path.Combine(folderPath, result.FileName);
            if (!System.IO.File.Exists(fullPath))
            {
                _logger.LogWarning("AnimatedPoster: GetAnimatedPosterImage 404 - file no longer exists: \"{Path}\"", fullPath);
                return NotFound();
            }

            var contentType = GetContentType(fullPath);
            var fileInfo = new FileInfo(fullPath);

            // Image bytes caching; see ExtraposterController.GetPosterImage.
            // The file is typically animated (GIF/APNG/WebP) and loops on its
            // own, so there is no reason to re-fetch it within the cache window.
            var imageEtag = "\"" + fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";
            Response.Headers.ETag = imageEtag;
            Response.Headers.CacheControl = "public, max-age=86400";
            var ifNoneMatchImage = Request.Headers.IfNoneMatch.ToString();
            if (!string.IsNullOrEmpty(ifNoneMatchImage) && ifNoneMatchImage == imageEtag)
            {
                _logger.LogDebug("AnimatedPoster: GetAnimatedPosterImage - ETag unchanged, 304 for \"{Path}\"", fullPath);
                return StatusCode(StatusCodes.Status304NotModified);
            }

            var stream = System.IO.File.OpenRead(fullPath);
            _logger.LogDebug("AnimatedPoster: GetAnimatedPosterImage 200 - serving \"{Path}\", Content-Type={ContentType}", fullPath, contentType);
            return File(stream, contentType);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "AnimatedPoster: Unexpected error in GetAnimatedPosterImage for {ItemId}", itemId);
            return NotFound();
        }
    }

    // The client script is served by PostersPlusController (GET /PostersPlus/script.js).

    /// <summary>
    /// "auto" (priority resolution between Animated Poster and Animated
    /// Keyart) is the default when "type" is missing or empty, as in
    /// CustomPosterController.NormalizeType. "animatedposter"/"animatedkeyart"
    /// are explicit values, used by the client's image-URL requests.
    /// </summary>
    private static string NormalizeType(string? type)
    {
        if (string.Equals(type, "animatedposter", StringComparison.OrdinalIgnoreCase)) { return "animatedposter"; }
        if (string.Equals(type, "animatedkeyart", StringComparison.OrdinalIgnoreCase)) { return "animatedkeyart"; }
        return "auto";
    }

    /// <summary>
    /// Master (Enabled) switch per type. AnimatedPosterTabEnabled is checked
    /// first as a server-side kill switch, as in CustomPosterController.
    /// "auto" counts as enabled while the tab is on; the per-type check
    /// happens in the priority loop of ResolveItemResult, which skips a
    /// disabled type.
    /// </summary>
    private static bool IsTypeEnabled(PluginConfiguration config, string posterType)
    {
        if (!config.AnimatedPosterTabEnabled)
        {
            return false;
        }

        if (posterType == "animatedposter") { return config.AnimatedPosterEnabled; }
        if (posterType == "animatedkeyart") { return config.AnimatedKeyartEnabled; }
        return true; // auto - per-type gating happens inside ResolveItemResult's own priority loop
    }

    /// <summary>
    /// "auto" resolves Animated Poster vs. Animated Keyart by
    /// AnimatedPosterPriority: the preferred type first, then the other, and
    /// IsApplicable=false only if neither has a file. An explicit type skips
    /// the priority logic and resolves exactly that type. Mirrors
    /// CustomPosterController.ResolveItemResult.
    /// </summary>
    private AnimatedPosterResult? ResolveItemResult(Guid itemId, PluginConfiguration config, string posterType, bool isLibraryScope, string? page = null)
    {
        if (posterType != "auto")
        {
            return ResolveSingleType(itemId, config, posterType, isLibraryScope, page);
        }

        var order = string.Equals(config.AnimatedPosterPriority, "AnimatedKeyart", StringComparison.OrdinalIgnoreCase)
            ? new[] { "animatedkeyart", "animatedposter" }
            : new[] { "animatedposter", "animatedkeyart" };

        foreach (var candidateType in order)
        {
            if (!IsTypeEnabled(config, candidateType)) { continue; }

            var candidateResult = ResolveSingleType(itemId, config, candidateType, isLibraryScope, page);
            if (candidateResult is not null && candidateResult.IsApplicable)
            {
                candidateResult.ResolvedType = candidateType;
                return candidateResult;
            }
        }

        return new AnimatedPosterResult { IsApplicable = false };
    }

    /// <summary>
    /// Resolves exactly one explicit type (never "auto"; the caller handles
    /// that). Checks the type, the enable field for Movies/TV Shows and the
    /// detail/library scope, finds the folder and looks for the file.
    /// Sets have no fields of their own: they reuse the Movies settings, and
    /// naming is always "Standalone".
    /// </summary>
    private AnimatedPosterResult? ResolveSingleType(Guid itemId, PluginConfiguration config, string posterType, bool isLibraryScope, string? page = null)
    {
        var item = _libraryManager.GetItemById(itemId);
        var isKeyart = posterType == "animatedkeyart";

        string? folderPath;
        string namingMode;
        string typeName;

        if (item is Movie movie)
        {
            var showOnMovies = isKeyart ? config.AnimatedKeyartShowOnMovies : config.AnimatedPosterShowOnMovies;
            var detailOrLibraryEnabled = isKeyart
                ? (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "AnimatedKeyart", "Movie") : config.AnimatedKeyartMoviesDetailEnabled)
                : (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "AnimatedPoster", "Movie") : config.AnimatedPosterMoviesDetailEnabled);
            if (!showOnMovies || !detailOrLibraryEnabled) { return null; }

            folderPath = movie.ContainingFolderPath;
            namingMode = isKeyart ? config.AnimatedKeyartMoviesNamingMode : config.AnimatedPosterMoviesNamingMode;
            typeName = isKeyart ? config.AnimatedKeyartMoviesTypeName : config.AnimatedPosterMoviesTypeName;
        }
        else if (item is BoxSet boxSet)
        {
            // Sets reuse the Movies Detail/Library/TypeName settings.
            var showOnSets = isKeyart ? config.AnimatedKeyartShowOnSets : config.AnimatedPosterShowOnSets;
            var detailOrLibraryEnabled = isKeyart
                ? (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "AnimatedKeyart", "BoxSet") : config.AnimatedKeyartMoviesDetailEnabled)
                : (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "AnimatedPoster", "BoxSet") : config.AnimatedPosterMoviesDetailEnabled);
            if (!showOnSets || !detailOrLibraryEnabled) { return null; }

            folderPath = boxSet.ContainingFolderPath;
            namingMode = "Standalone";
            typeName = isKeyart ? config.AnimatedKeyartMoviesTypeName : config.AnimatedPosterMoviesTypeName;
        }
        else if (item is Series series)
        {
            var showOnTvShows = isKeyart ? config.AnimatedKeyartShowOnTvShows : config.AnimatedPosterShowOnTvShows;
            var detailOrLibraryEnabled = isKeyart
                ? (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "AnimatedKeyart", "Series") : config.AnimatedKeyartTvShowsDetailEnabled)
                : (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "AnimatedPoster", "Series") : config.AnimatedPosterTvShowsDetailEnabled);
            if (!showOnTvShows || !detailOrLibraryEnabled) { return null; }

            folderPath = series.ContainingFolderPath;
            namingMode = "Standalone"; // TV only ever has this one sensible variant, no config field needed
            typeName = isKeyart ? config.AnimatedKeyartTvShowsTypeName : config.AnimatedPosterTvShowsTypeName;
        }
        else
        {
            // No Season/Episode support: both types replace the main poster
            // or keyart, and Season/Episode have their own image concepts
            // in Jellyfin.
            return null;
        }

        if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath))
        {
            return null;
        }

        var fileName = FindAnimatedFile(folderPath, namingMode, typeName, config.AnimatedPosterAllowedFormats);
        if (fileName is null)
        {
            return new AnimatedPosterResult { IsApplicable = false };
        }

        string version;
        try
        {
            var fileInfo = new FileInfo(Path.Combine(folderPath, fileName));
            version = fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (Exception)
        {
            version = string.Empty;
        }

        return new AnimatedPosterResult { IsApplicable = true, FileName = fileName, Version = version };
    }

    /// <summary>
    /// Only for GetAnimatedPosterImage: resolves the folder path again
    /// without the full ResolveSingleType logic (the enable check has already
    /// happened). Only Movie/BoxSet/Series are relevant, identical for both
    /// types.
    /// </summary>
    private string? ResolveFolderPathOnly(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);
        if (item is Movie movie) { return movie.ContainingFolderPath; }
        if (item is BoxSet boxSet) { return boxSet.ContainingFolderPath; }
        if (item is Series series) { return series.ContainingFolderPath; }
        return null;
    }

    /// <summary>
    /// Finds the one possible animated file, with a server cache in front of
    /// it. No numbering (always exactly one file). Shared by Animated Poster
    /// and Animated Keyart: the caller picks the namingMode, typeName and
    /// format list.
    /// </summary>
    private string? FindAnimatedFile(string folderPath, string namingMode, string typeName, string? allowedFormatsCsv)
    {
        var lastWriteUtc = SafeGetLastWriteTimeUtc(folderPath);
        var cacheKey = string.Join('|', "AnimatedPoster:File", folderPath, lastWriteUtc.Ticks, namingMode, typeName, allowedFormatsCsv ?? string.Empty);

        if (_cache.TryGetValue(cacheKey, out string? cached))
        {
            return cached;
        }

        // APNG files very often carry the ".png" extension: browsers detect
        // APNG by content, not by extension. So "apng" searches both
        // ".apng" and ".png".
        var extensions = (allowedFormatsCsv ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .SelectMany(f => string.Equals(f, "apng", StringComparison.OrdinalIgnoreCase)
                ? new[] { ".png", ".apng" }
                : new[] { "." + f.ToLowerInvariant() })
            .Distinct()
            .ToArray();
        if (extensions.Length == 0)
        {
            extensions = new[] { ".gif" };
        }

        var prefix = namingMode == "Prefixed"
            ? Path.GetFileName(folderPath) + "-" + typeName
            : typeName;

        string? found = null;
        foreach (var ext in extensions)
        {
            var candidate = prefix + ext;
            if (System.IO.File.Exists(Path.Combine(folderPath, candidate)))
            {
                found = candidate;
                break;
            }
        }

        _logger.LogDebug(
            "AnimatedPoster: FindAnimatedFile - searched pattern=\"{Prefix}.<ext>\" (allowed: [{Ext}]) in \"{Folder}\" -> {Result}",
            prefix, string.Join(", ", extensions), folderPath, found ?? "no match");

        _cache.Set(cacheKey, found, new MemoryCacheEntryOptions().SetSlidingExpiration(CacheSlidingExpiration));
        return found;
    }

    private static string GetContentType(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".webp" => "image/webp",
            ".apng" => "image/apng",
            ".png" => "image/png", // also covers .png-named APNGs, see FindAnimatedFile
            _ => "image/gif"
        };
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
            _logger.LogWarning(ex, "AnimatedPoster: SafeGetLastWriteTimeUtc failed for \"{Folder}\"", folderPath);
            return DateTime.MinValue;
        }
    }
}
