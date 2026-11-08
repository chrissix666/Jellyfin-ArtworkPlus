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
/// Result DTO for Custom Poster: single image only, no order or timing
/// fields (like AnimatedPosterResult).
/// </summary>
public class CustomPosterResult
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
    /// "postercase" or "keyart" - set only when the request's "type" was
    /// "auto". The client uses it to build the explicit-type image URL and
    /// to decide whether the logo overlay applies (Postercase never has one).
    /// Empty for an explicit type or when IsApplicable is false.
    /// </summary>
    public string ResolvedType { get; set; } = string.Empty;

    /// <summary>
    /// Set only when ResolvedType is "keyart" AND the view's Keyart logo is
    /// on; the client has no other way to know the server's config.
    /// Postercase never sets this.
    /// </summary>
    public bool LogoEnabled { get; set; }

    public int LogoVerticalPositionPercent { get; set; }

    public int LogoSizePercent { get; set; }

    /// <summary>The item has a Jellyfin Logo image (library tiles draw the logo without an extra item request).</summary>
    public bool HasLogo { get; set; }
}

/// <summary>
/// Result DTO of the batch endpoint, analogous to
/// AnimatedPosterBatchResult/BatchPosterListResult.
/// </summary>
public class CustomPosterBatchResult
{
    public Dictionary<string, CustomPosterResult> Items { get; set; } = new();
}

/// <summary>
/// Custom Poster: Postercase (a retouched poster without lettering) and Keyart,
/// resolved through one route and told apart by the "type" parameter.
/// Replaces the main poster entirely instead of overlaying it (priority 1 in
/// the poster model of Posters-v1.js). The controller only reports WHETHER and
/// WHICH file exists; the client's CustomModule changes the DOM.
/// </summary>
[ApiController]
[Route("CustomPoster")]
[AllowAnonymous]
public class CustomPosterController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<CustomPosterController> _logger;
    private readonly IMemoryCache _cache;

    private static readonly TimeSpan CacheSlidingExpiration = TimeSpan.FromHours(6);

    public CustomPosterController(ILibraryManager libraryManager, ILogger<CustomPosterController> logger, IMemoryCache cache)
    {
        _libraryManager = libraryManager;
        _logger = logger;
        _cache = cache;
    }

    /// <summary>
    /// GET /CustomPoster/{itemId}?type=auto|postercase|keyart&amp;scope=detail|library -
    /// "type": "auto" (the default, used by the client's first request)
    /// picks Postercase or Keyart by CustomPosterPriority (see
    /// ResolveItemResult); "postercase"/"keyart" resolve exactly that type,
    /// used for the image URL once the winner is known. "scope" selects the
    /// detail or library enable field, as in
    /// AnimatedPosterController.GetAnimatedPoster.
    /// </summary>
    [HttpGet("{itemId}")]
    public ActionResult<CustomPosterResult> GetCustomPoster([FromRoute] Guid itemId, [FromQuery] string? type, [FromQuery] string? scope, [FromQuery] bool? webgl)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            var posterType = NormalizeType(type);

            if (!IsTypeEnabled(config, posterType))
            {
                return Ok(new CustomPosterResult { IsApplicable = false });
            }

            var isLibraryScope = string.Equals(scope, "library", StringComparison.OrdinalIgnoreCase);
            // The Case mix's poster chain: on a detail page whose draw has
            // this slot unticked, the slot does not deliver and the page's
            // chain falls through to the next one. Library scope never asks;
            // the mix is for detail pages only.
            if (!isLibraryScope && config.CaseModMixEnabled
                && !CaseMix.SlotAllowed(CaseMixConfig.DrawFor(config, _libraryManager.GetItemById(itemId), webgl ?? true), "customposter", CaseMixConfig.From(config)))
            {
                return Ok(new CustomPosterResult { IsApplicable = false });
            }

            var result = ResolveItemResult(itemId, config, posterType, isLibraryScope);

            ApplyKeyartLogo(result, config, isLibraryScope, itemId);

            var etag = ComputeETag(itemId, posterType, isLibraryScope, result?.FileName ?? "none");
            if (IsETagStillValid(etag))
            {
                return StatusCode(StatusCodes.Status304NotModified);
            }

            return Ok(result ?? new CustomPosterResult { IsApplicable = false });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CustomPoster: Unexpected error in GetCustomPoster for {ItemId}", itemId);
            return Ok(new CustomPosterResult { IsApplicable = false });
        }
    }

    /// <summary>
    /// GET /CustomPoster/batch?ids=guid1,guid2&amp;type=postercase&amp;scope=library -
    /// for the library view, the same principle as
    /// AnimatedPosterController.GetAnimatedPosterBatch.
    /// </summary>
    private const int MaxBatchIds = 200;

    [HttpGet("batch")]
    public ActionResult<CustomPosterBatchResult> GetCustomPosterBatch([FromQuery] string? ids, [FromQuery] string? type, [FromQuery] string? scope, [FromQuery] string? page)
    {
        var config = Plugin.Instance!.Configuration;
        var posterType = NormalizeType(type);
        var result = new CustomPosterBatchResult();
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

        _logger.LogInformation("CustomPoster: GetCustomPosterBatch - {Count} itemIds requested (type={Type})", itemIds.Count, posterType);

        foreach (var itemId in itemIds)
        {
            // "N" (no dashes): the client looks the answer up by the tile's
            // data-id, which Jellyfin serialises via JsonGuidConverter as the
            // 32-hex form. Dictionary keys are strings and bypass that
            // converter, so Guid.ToString() (dashed) would never match.
            var itemResult = ResolveItemResult(itemId, config, posterType, isLibraryScope, isLibraryScope ? pageClass : null) ?? new CustomPosterResult { IsApplicable = false };
            ApplyKeyartLogo(itemResult, config, isLibraryScope, itemId);
            result.Items[itemId.ToString("N")] = itemResult;
        }

        return Ok(result);
    }

    /// <summary>
    /// Keyart's logo overlay values for the requested view (detail pages and
    /// library views have their own set). Postercase never gets a logo.
    /// </summary>
    private void ApplyKeyartLogo(CustomPosterResult? result, PluginConfiguration config, bool isLibraryScope, Guid itemId)
    {
        if (result is null || !result.IsApplicable || result.ResolvedType != "keyart") { return; }
        var enabled = isLibraryScope ? config.KeyartLibraryLogoEnabled : config.KeyartDetailLogoEnabled;
        if (!enabled) { return; }
        result.LogoEnabled = true;
        result.LogoVerticalPositionPercent = isLibraryScope ? config.KeyartLibraryLogoVerticalPositionPercent : config.KeyartDetailLogoVerticalPositionPercent;
        result.LogoSizePercent = isLibraryScope ? config.KeyartLibraryLogoSizePercent : config.KeyartDetailLogoSizePercent;
        result.HasLogo = _libraryManager.GetItemById(itemId)?.HasImage(MediaBrowser.Model.Entities.ImageType.Logo, 0) ?? false;
    }

    /// <summary>
    /// GET /CustomPoster/{itemId}/image - serves the resolved file itself.
    /// No file name in the path: resolution happens entirely on the server,
    /// as in AnimatedPosterController.GetAnimatedPosterImage.
    /// </summary>
    [HttpGet("{itemId}/image")]
    public ActionResult GetCustomPosterImage([FromRoute] Guid itemId, [FromQuery] string? type, [FromQuery] string? scope)
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
                _logger.LogWarning("CustomPoster: GetCustomPosterImage 404 - file no longer exists: \"{Path}\"", fullPath);
                return NotFound();
            }

            var contentType = GetContentType(fullPath);
            var fileInfo = new FileInfo(fullPath);

            // Image bytes caching; see ExtraposterController.GetPosterImage.
            var imageEtag = "\"" + fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";
            Response.Headers.ETag = imageEtag;
            Response.Headers.CacheControl = "public, max-age=86400";
            var ifNoneMatchImage = Request.Headers.IfNoneMatch.ToString();
            if (!string.IsNullOrEmpty(ifNoneMatchImage) && ifNoneMatchImage == imageEtag)
            {
                return StatusCode(StatusCodes.Status304NotModified);
            }

            var stream = System.IO.File.OpenRead(fullPath);
            return File(stream, contentType);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CustomPoster: Unexpected error in GetCustomPosterImage for {ItemId}", itemId);
            return NotFound();
        }
    }

    // The client script is served by PostersPlusController (GET /PostersPlus/script.js).

    /// <summary>
    /// "auto" (priority resolution between Postercase and Keyart, see
    /// ResolveItemResult) is the default when "type" is missing or empty;
    /// the client's first request sends no type. "postercase"/"keyart" are
    /// explicit values, used by the client's image-URL requests.
    /// </summary>
    private static string NormalizeType(string? type)
    {
        if (string.Equals(type, "postercase", StringComparison.OrdinalIgnoreCase)) { return "postercase"; }
        if (string.Equals(type, "keyart", StringComparison.OrdinalIgnoreCase)) { return "keyart"; }
        return "auto";
    }

    /// <summary>
    /// Master (Enabled) switch per type. The tab-level CustomPosterEnabled is
    /// checked first as a server-side kill switch, as in ExtraposterController.
    /// "auto" counts as enabled while the tab is on; the per-type check
    /// happens in the priority loop of ResolveItemResult, which skips a
    /// disabled type.
    /// </summary>
    private static bool IsTypeEnabled(PluginConfiguration config, string posterType)
    {
        if (!config.CustomPosterEnabled)
        {
            return false;
        }

        if (posterType == "postercase") { return config.PostercaseEnabled; }
        if (posterType == "keyart") { return config.KeyartEnabled; }
        return true; // auto - per-type gating happens inside ResolveItemResult's own priority loop
    }

    /// <summary>
    /// "auto" resolves Postercase vs Keyart by CustomPosterPriority: the
    /// preferred type first, then the other, and IsApplicable=false only if
    /// neither has a file. An explicit type skips the priority logic and
    /// resolves exactly that type.
    /// </summary>
    private CustomPosterResult? ResolveItemResult(Guid itemId, PluginConfiguration config, string posterType, bool isLibraryScope, string? page = null)
    {
        if (posterType != "auto")
        {
            return ResolveSingleType(itemId, config, posterType, isLibraryScope, page);
        }

        var order = string.Equals(config.CustomPosterPriority, "Keyart", StringComparison.OrdinalIgnoreCase)
            ? new[] { "keyart", "postercase" }
            : new[] { "postercase", "keyart" };

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

        return new CustomPosterResult { IsApplicable = false };
    }

    /// <summary>
    /// Fully resolves an itemId for ONE known type (never "auto"; the caller
    /// handles that). Mirrors AnimatedPosterController: Movie, BoxSet and
    /// Series only, no Season/Episode, because Custom Poster replaces the main
    /// poster and Season/Episode have their own image concepts in Jellyfin.
    /// posterType selects the Postercase* or Keyart* settings.
    /// </summary>
    private CustomPosterResult? ResolveSingleType(Guid itemId, PluginConfiguration config, string posterType, bool isLibraryScope, string? page = null)
    {
        var item = _libraryManager.GetItemById(itemId);

        string? folderPath;
        string namingMode;
        string typeName;
        string allowedFormatsCsv;

        if (item is Movie movie)
        {
            var showOnMovies = posterType == "postercase" ? config.PostercaseShowOnMovies : config.KeyartShowOnMovies;
            var detailOrLibraryEnabled = posterType == "postercase"
                ? (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "Postercase", "Movie") : config.PostercaseMoviesDetailEnabled)
                : (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "Keyart", "Movie") : config.KeyartMoviesDetailEnabled);
            if (!showOnMovies || !detailOrLibraryEnabled) { return null; }

            folderPath = movie.ContainingFolderPath;
            // Single-image types know Prefixed and Standalone only; any other
            // value is read as Standalone.
            var moviesMode = posterType == "postercase" ? config.PostercaseMoviesNamingMode : config.KeyartMoviesNamingMode;
            namingMode = moviesMode == "Prefixed" ? "Prefixed" : "Standalone";
            typeName = posterType == "postercase" ? config.PostercaseMoviesTypeName : config.KeyartMoviesTypeName;
            // One format setting shared by Postercase and Keyart.
            allowedFormatsCsv = config.CustomPosterAllowedFormats;
        }
        else if (item is BoxSet boxSet)
        {
            // Sets have no fields of their own: they reuse the Movies
            // settings, and naming is always Standalone (a set has one
            // exclusive main folder).
            var showOnSets = posterType == "postercase" ? config.PostercaseShowOnSets : config.KeyartShowOnSets;
            var detailOrLibraryEnabled = posterType == "postercase"
                ? (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "Postercase", "BoxSet") : config.PostercaseMoviesDetailEnabled)
                : (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "Keyart", "BoxSet") : config.KeyartMoviesDetailEnabled);
            if (!showOnSets || !detailOrLibraryEnabled) { return null; }

            folderPath = boxSet.ContainingFolderPath;
            namingMode = "Standalone";
            typeName = posterType == "postercase" ? config.PostercaseMoviesTypeName : config.KeyartMoviesTypeName;
            allowedFormatsCsv = config.CustomPosterAllowedFormats;
        }
        else if (item is Series series)
        {
            var showOnTvShows = posterType == "postercase" ? config.PostercaseShowOnTvShows : config.KeyartShowOnTvShows;
            var detailOrLibraryEnabled = posterType == "postercase"
                ? (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "Postercase", "Series") : config.PostercaseTvShowsDetailEnabled)
                : (isLibraryScope ? Helpers.AlsoOn.Allowed(config, page, "Keyart", "Series") : config.KeyartTvShowsDetailEnabled);
            if (!showOnTvShows || !detailOrLibraryEnabled) { return null; }

            folderPath = series.ContainingFolderPath;
            // TV shows are always Standalone for the single-image types, like
            // Animated Poster / Animated Keyart: a show folder is exclusive.
            namingMode = "Standalone";
            typeName = posterType == "postercase" ? config.PostercaseTvShowsTypeName : config.KeyartTvShowsTypeName;
            // One format setting shared by Postercase and Keyart.
            allowedFormatsCsv = config.CustomPosterAllowedFormats;
        }
        else
        {
            return null;
        }

        if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath))
        {
            return null;
        }

        var fileName = FindCustomPosterFile(folderPath, namingMode, typeName, allowedFormatsCsv, posterType);
        if (fileName is null)
        {
            return new CustomPosterResult { IsApplicable = false };
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

        return new CustomPosterResult { IsApplicable = true, FileName = fileName, Version = version, ResolvedType = posterType };
    }

    /// <summary>
    /// Only for GetCustomPosterImage: resolves the folder path again without
    /// the full ResolveItemResult logic (the enable check has already
    /// happened). Same as AnimatedPosterController.ResolveFolderPathOnly.
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
    /// Finds the one possible file for the given type (Postercase or
    /// Keyart), with a server cache in front of it, as in
    /// AnimatedPosterController.FindAnimatedFile. No numbering (always one
    /// file per type). posterType is part of the cache key so the two
    /// types' results for the same folder never collide.
    /// </summary>
    private string? FindCustomPosterFile(string folderPath, string namingMode, string typeName, string? allowedFormatsCsv, string posterType)
    {
        var lastWriteUtc = SafeGetLastWriteTimeUtc(folderPath);
        var cacheKey = string.Join('|', "CustomPoster:File", posterType, folderPath, lastWriteUtc.Ticks, namingMode, typeName, allowedFormatsCsv ?? string.Empty);

        if (_cache.TryGetValue(cacheKey, out string? cached))
        {
            return cached;
        }

        var extensions = (allowedFormatsCsv ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();
        if (extensions.Length == 0)
        {
            extensions = new[] { ".jpg" };
        }

        // Prefixed or Standalone only; single-image types have no Folder mode.
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
            "CustomPoster: FindCustomPosterFile({Type}) - searched pattern=\"{Prefix}.<ext>\" (allowed: [{Ext}]) in \"{Folder}\" -> {Result}",
            posterType, prefix, string.Join(", ", extensions), folderPath, found ?? "no match");

        _cache.Set(cacheKey, found, new MemoryCacheEntryOptions().SetSlidingExpiration(CacheSlidingExpiration));
        return found;
    }

    private static string GetContentType(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".webp" => "image/webp",
            ".png" => "image/png",
            ".jpeg" => "image/jpeg",
            _ => "image/jpeg"
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
            _logger.LogWarning(ex, "CustomPoster: SafeGetLastWriteTimeUtc failed for \"{Folder}\"", folderPath);
            return DateTime.MinValue;
        }
    }
}
