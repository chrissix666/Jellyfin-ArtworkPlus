using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
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
/// Result DTO for Custom Poster. Deliberately as lean as
/// AnimatedPosterResult (see that class's own doc comment for the
/// reasoning) - single-image only, no order/timing concept.
/// </summary>
public class CustomPosterResult
{
    public bool IsApplicable { get; set; }

    public string? FileName { get; set; }

    /// <summary>
    /// Version fingerprint (LastWriteTimeUtc.Ticks-Length) of the
    /// resolved file - see ExtraposterController.PosterEntry for the
    /// full reasoning. Empty when not applicable/no file resolved.
    /// </summary>
    public string Version { get; set; } = string.Empty;

    /// <summary>
    /// "postercase" or "keyart" - only meaningful when the request's own
    /// "type" was "auto" (priority resolution, see
    /// CustomPosterController's own doc comment). The client uses this
    /// to build the correct explicit-type image URL and to decide
    /// whether the optional logo overlay applies (Postercase never has
    /// one). Empty when the request already specified an explicit type
    /// itself, or when IsApplicable is false.
    /// </summary>
    public string ResolvedType { get; set; } = string.Empty;

    /// <summary>
    /// Set only when ResolvedType is "keyart" AND KeyartLogoEnabled is
    /// true - the client has no other way to know the server's own
    /// config. Postercase never sets this (Postercase has no logo
    /// overlay concept at all).
    /// </summary>
    public bool LogoEnabled { get; set; }

    public int LogoVerticalPositionPercent { get; set; }

    public int LogoSizePercent { get; set; }
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
/// Custom Poster - currently only Postercase (a retouched poster with no
/// lettering). Named "CustomPoster" rather than "Postercase" from the
/// start because Keyart is a planned, near-term sibling that will share
/// this exact controller/route (own concept-session decision, verified
/// precedent: CharacterartController.cs already resolves several distinct
/// naming-pattern "types" through one shared function - see
/// ResolveCandidatesUncached's own doc comment there). The "type" query
/// parameter below exists for that reason from day one, even though only
/// "postercase" is a real, implemented value right now - adding "keyart"
/// later means adding a second branch inside ResolveItemResult, not a new
/// controller or route.
///
/// Replaces the main poster entirely instead of overlaying it (priority 1
/// in the shared poster controller - see Posters-v1.js's own
/// "Priority model" doc comment, renumbered specifically to make room for
/// this) - which is why it does NOT set anything in the DOM itself
/// (Posters-v1.js's own CustomModule does that), it only returns
/// WHETHER and WHICH file exists, mirroring AnimatedPosterController's
/// own division of responsibility.
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
    /// "type" chooses which sub-feature: "auto" (the default, used by the
    /// client's own initial request) resolves Postercase vs Keyart by
    /// CustomPosterPriority, see ResolveItemResult's own doc comment;
    /// "postercase"/"keyart" resolve exactly that one type, used by the
    /// client's own subsequent image-URL request once it already knows
    /// which type won. "scope" chooses which of the two independent
    /// enable fields is checked (Movies/TvShows detail-vs-library), same
    /// pattern as AnimatedPosterController.GetAnimatedPoster.
    /// </summary>
    [HttpGet("{itemId}")]
    public ActionResult<CustomPosterResult> GetCustomPoster([FromRoute] Guid itemId, [FromQuery] string? type, [FromQuery] string? scope)
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
            var result = ResolveItemResult(itemId, config, posterType, isLibraryScope);

            if (result is not null && result.IsApplicable && result.ResolvedType == "keyart" && config.KeyartLogoEnabled)
            {
                result.LogoEnabled = true;
                result.LogoVerticalPositionPercent = config.KeyartLogoVerticalPositionPercent;
                result.LogoSizePercent = config.KeyartLogoSizePercent;
            }

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
    public ActionResult<CustomPosterBatchResult> GetCustomPosterBatch([FromQuery] string? ids, [FromQuery] string? type, [FromQuery] string? scope)
    {
        var config = Plugin.Instance!.Configuration;
        var posterType = NormalizeType(type);
        var result = new CustomPosterBatchResult();

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
            result.Items[itemId.ToString()] = ResolveItemResult(itemId, config, posterType, isLibraryScope) ?? new CustomPosterResult { IsApplicable = false };
        }

        return Ok(result);
    }

    /// <summary>
    /// GET /CustomPoster/{itemId}/image - serves the resolved file itself,
    /// same division of responsibility as
    /// AnimatedPosterController.GetAnimatedPosterImage (no fileName in the
    /// path - resolution happens entirely server-side).
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

            // Image bytes caching - see AnimatedPosterController's own
            // identical comment for the full reasoning.
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

    // NOTE: this controller used to have its own GET /CustomPoster/script.js
    // endpoint here, serving Jellyfin-ArtworkPlus-CustomPoster-v1.js from
    // disk. That file no longer exists (architecture consolidation:
    // CustomPoster/AnimatedPoster/ExtraPoster's previously separate visual
    // render paths were merged into one shared state machine - see
    // Jellyfin-ArtworkPlus-Posters-v1.js's own header comment for the
    // full reasoning) - the client script is now served by
    // PostersPlusController's own GetScript() endpoint instead
    // (GET /PostersPlus/script.js). This controller's OWN data endpoints
    // below (poster resolution, image serving) are unchanged and still
    // exactly what Posters-v1.js's own CustomModule calls.

    /// <summary>
    /// "auto" (priority resolution between Postercase/Keyart, see
    /// ResolveItemResult's own doc comment) is now the real default when
    /// "type" is missing/empty - matches the client's own behavior
    /// (Posters-v1.js's own CustomModule.check() no longer sends an
    /// explicit
    /// type on its initial request). "postercase"/"keyart" remain valid
    /// explicit values, used by the client's own image-URL requests
    /// (which already know the resolved type by then) and available for
    /// direct testing/debugging.
    /// </summary>
    private static string NormalizeType(string? type)
    {
        if (string.Equals(type, "postercase", StringComparison.OrdinalIgnoreCase)) { return "postercase"; }
        if (string.Equals(type, "keyart", StringComparison.OrdinalIgnoreCase)) { return "keyart"; }
        return "auto";
    }

    /// <summary>
    /// Master (Enabled) switch per type. Checks the tab-level
    /// CustomPosterEnabled FIRST (mirrors ExtraposterController's own
    /// "server-side kill switch, applies BEFORE any further check"
    /// pattern). "auto" is considered enabled as long as the TAB itself
    /// is on - the per-type check happens later, inside the priority
    /// resolution loop in ResolveItemResult, which simply skips whichever
    /// type turns out disabled.
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
    /// "auto" resolves Postercase vs Keyart by the configured
    /// CustomPosterPriority: tries the preferred type first, falls back
    /// to the other if the preferred one has no file, and returns
    /// IsApplicable=false only if NEITHER does. Explicit "postercase"/
    /// "keyart" skip the priority logic entirely and resolve exactly
    /// that one type - used by the client's own image-URL requests,
    /// which already know which type won from the initial "auto" call's
    /// own ResolvedType.
    /// </summary>
    private CustomPosterResult? ResolveItemResult(Guid itemId, PluginConfiguration config, string posterType, bool isLibraryScope)
    {
        if (posterType != "auto")
        {
            return ResolveSingleType(itemId, config, posterType, isLibraryScope);
        }

        var order = string.Equals(config.CustomPosterPriority, "Keyart", StringComparison.OrdinalIgnoreCase)
            ? new[] { "keyart", "postercase" }
            : new[] { "postercase", "keyart" };

        foreach (var candidateType in order)
        {
            if (!IsTypeEnabled(config, candidateType)) { continue; }

            var candidateResult = ResolveSingleType(itemId, config, candidateType, isLibraryScope);
            if (candidateResult is not null && candidateResult.IsApplicable)
            {
                candidateResult.ResolvedType = candidateType;
                return candidateResult;
            }
        }

        return new CustomPosterResult { IsApplicable = false };
    }

    /// <summary>
    /// Fully resolves an itemId for ONE specific, already-known type
    /// (never "auto" - the caller, ResolveItemResult, already handled
    /// that). Structure mirrors AnimatedPosterController.ResolveItemResult
    /// exactly - same Movie/Series-only scope (deliberately no Season/
    /// Episode, concept-session decision, same reasoning as AnimatedPoster's
    /// own: Custom Poster replaces the main poster, and Season/Episode
    /// have their own, different image concepts in Jellyfin). Reads the
    /// right config field set (Postercase* vs Keyart*) based on
    /// posterType - same "one function, several naming-pattern types"
    /// precedent as CharacterartController's own ResolveCandidatesUncached.
    /// </summary>
    private CustomPosterResult? ResolveSingleType(Guid itemId, PluginConfiguration config, string posterType, bool isLibraryScope)
    {
        var item = _libraryManager.GetItemById(itemId);

        string? folderPath;
        string namingMode;
        string typeName;
        string folderName;
        string allowedFormatsCsv;

        if (item is Movie movie)
        {
            var showOnMovies = posterType == "postercase" ? config.PostercaseShowOnMovies : config.KeyartShowOnMovies;
            var detailOrLibraryEnabled = posterType == "postercase"
                ? (isLibraryScope ? config.PostercaseMoviesLibraryEnabled : config.PostercaseMoviesDetailEnabled)
                : (isLibraryScope ? config.KeyartMoviesLibraryEnabled : config.KeyartMoviesDetailEnabled);
            if (!showOnMovies || !detailOrLibraryEnabled) { return null; }

            folderPath = movie.ContainingFolderPath;
            namingMode = posterType == "postercase" ? config.PostercaseMoviesNamingMode : config.KeyartMoviesNamingMode;
            typeName = posterType == "postercase" ? config.PostercaseMoviesTypeName : config.KeyartMoviesTypeName;
            folderName = posterType == "postercase" ? config.PostercaseMoviesFolderName : config.KeyartMoviesFolderName;
            // CHANGED: no longer per-sub - explicit user request to detach the
            // format setting from both Postercase and Keyart, one shared,
            // tab-level setting for both now.
            allowedFormatsCsv = config.CustomPosterAllowedFormats;
        }
        else if (item is BoxSet boxSet)
        {
            // Session 87 (Sets-Erweiterung, explicit user request): Sets
            // has NO own Naming-mode/Type-name/Detail/Library fields -
            // reuses Movies' own (see this project's own admin-menu
            // description text: "Sets always use Movies' own settings,
            // but Standalone naming"). Positioned right after Movie,
            // same convention as AnimatedPosterController's own
            // identical BoxSet branch (that one's own comment: "a Set
            // has one exclusive main folder, so Standalone is always
            // correct here too, no config field needed for it").
            var showOnSets = posterType == "postercase" ? config.PostercaseShowOnSets : config.KeyartShowOnSets;
            var detailOrLibraryEnabled = posterType == "postercase"
                ? (isLibraryScope ? config.PostercaseMoviesLibraryEnabled : config.PostercaseMoviesDetailEnabled)
                : (isLibraryScope ? config.KeyartMoviesLibraryEnabled : config.KeyartMoviesDetailEnabled);
            if (!showOnSets || !detailOrLibraryEnabled) { return null; }

            folderPath = boxSet.ContainingFolderPath;
            namingMode = "Standalone";
            typeName = posterType == "postercase" ? config.PostercaseMoviesTypeName : config.KeyartMoviesTypeName;
            folderName = string.Empty; // never read - namingMode is never "Folder" here
            allowedFormatsCsv = config.CustomPosterAllowedFormats;
        }
        else if (item is Series series)
        {
            var showOnTvShows = posterType == "postercase" ? config.PostercaseShowOnTvShows : config.KeyartShowOnTvShows;
            var detailOrLibraryEnabled = posterType == "postercase"
                ? (isLibraryScope ? config.PostercaseTvShowsLibraryEnabled : config.PostercaseTvShowsDetailEnabled)
                : (isLibraryScope ? config.KeyartTvShowsLibraryEnabled : config.KeyartTvShowsDetailEnabled);
            if (!showOnTvShows || !detailOrLibraryEnabled) { return null; }

            folderPath = series.ContainingFolderPath;
            // CHANGED: used to be hardcoded to "Standalone" - real gap
            // found and fixed per explicit user request, TV now reads
            // its own genuine NamingMode field, same as Movies (minus
            // "Prefixed", which TvShowsNamingMode's own field never
            // offers as an option in the first place).
            namingMode = posterType == "postercase" ? config.PostercaseTvShowsNamingMode : config.KeyartTvShowsNamingMode;
            typeName = posterType == "postercase" ? config.PostercaseTvShowsTypeName : config.KeyartTvShowsTypeName;
            folderName = posterType == "postercase" ? config.PostercaseTvShowsFolderName : config.KeyartTvShowsFolderName;
            // CHANGED: no longer per-sub - explicit user request to detach the
            // format setting from both Postercase and Keyart, one shared,
            // tab-level setting for both now.
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

        var fileName = FindCustomPosterFile(folderPath, namingMode, typeName, folderName, allowedFormatsCsv, posterType);
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
    /// Only for GetCustomPosterImage - resolves the folder path again,
    /// without repeating the full ResolveItemResult logic (the enable
    /// check has already happened at this point). Same simplification as
    /// AnimatedPosterController.ResolveFolderPathOnly (only Movie OR
    /// Series, no Season/Episode).
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
    /// Keyart) - with a server cache in front of it, same principle as
    /// AnimatedPosterController.FindAnimatedFile. No numbering needed
    /// (always exactly one file per type). posterType is part of the
    /// cache key so Postercase's and Keyart's own results for the same
    /// folder never collide.
    /// </summary>
    private string? FindCustomPosterFile(string folderPath, string namingMode, string typeName, string folderName, string? allowedFormatsCsv, string posterType)
    {
        var lastWriteUtc = SafeGetLastWriteTimeUtc(folderPath);
        var cacheKey = string.Join('|', "CustomPoster:File", posterType, folderPath, lastWriteUtc.Ticks, namingMode, typeName, folderName, allowedFormatsCsv ?? string.Empty);

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

        string? found;

        if (namingMode == "Folder")
        {
            // Single-image Folder mode (added per explicit user request -
            // "die folder variante vergessen") - same reasoning as
            // CharacterartController's own ResolveCandidatesUncached:
            // whole subfolder counts, no naming convention needed, but
            // since Postercase/Keyart are single-image, only the first
            // match in natural (alphabetical) sort order is actually
            // used - everything else in the subfolder is silently
            // ignored, exactly like Characterart's own single-image
            // Folder behavior.
            var subFolder = Path.Combine(folderPath, folderName);
            if (!Directory.Exists(subFolder))
            {
                _logger.LogInformation(
                    "CustomPoster: FindCustomPosterFile({Type}) - Folder mode, subfolder not found: \"{SubFolder}\"",
                    posterType, subFolder);
                found = null;
            }
            else
            {
                var firstMatch = Directory.EnumerateFiles(subFolder)
                    .Select(Path.GetFileName)
                    .Where(f => f is not null && extensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase))
                    .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();
                found = firstMatch is null ? null : Path.Combine(folderName, firstMatch);
                _logger.LogInformation(
                    "CustomPoster: FindCustomPosterFile({Type}) - Folder mode, subfolder=\"{SubFolder}\" (allowed: [{Ext}]) -> {Result}",
                    posterType, subFolder, string.Join(", ", extensions), found ?? "no match");
            }
        }
        else
        {
            var prefix = namingMode == "Prefixed"
                ? Path.GetFileName(folderPath) + "-" + typeName
                : typeName;

            found = null;
            foreach (var ext in extensions)
            {
                var candidate = prefix + ext;
                if (System.IO.File.Exists(Path.Combine(folderPath, candidate)))
                {
                    found = candidate;
                    break;
                }
            }

            _logger.LogInformation(
                "CustomPoster: FindCustomPosterFile({Type}) - searched pattern=\"{Prefix}.<ext>\" (allowed: [{Ext}]) in \"{Folder}\" -> {Result}",
                posterType, prefix, string.Join(", ", extensions), folderPath, found ?? "no match");
        }

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
