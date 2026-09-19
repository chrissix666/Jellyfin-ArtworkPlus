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
/// Result DTO for Animated Poster/Animated Keyart. Noticeably leaner than
/// PosterListResult/CharacterartResult - no multi-image concept, so neither
/// an order nor timing fields are needed (curriculum section F).
/// </summary>
public class AnimatedPosterResult
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
    /// "animatedposter" or "animatedkeyart" - only meaningful when the
    /// request's own "type" was "auto" (priority resolution, see
    /// ResolveItemResult's own doc comment). Mirrors
    /// CustomPosterResult.ResolvedType exactly (same reasoning: the
    /// client needs to know which type won to build the correct
    /// explicit-type image URL). Empty when the request already
    /// specified an explicit type itself, or when IsApplicable is false.
    /// </summary>
    public string ResolvedType { get; set; } = string.Empty;

    /// <summary>Session 126: Animated Keyart's logo overlay for the requested view (like Custom Keyart). Only set for ResolvedType "animatedkeyart".</summary>
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
/// The third, fully independent feature block (curriculum section F).
/// Replaces the main poster entirely instead of overlaying it - which is
/// why it's important that it does NOT set anything in the DOM itself
/// (animatedposter.js does that), it only returns WHETHER and WHICH file
/// exists. Logging philosophy identical to the other controllers
/// (curriculum D0b).
///
/// Phase 2 (Session 91): "Animated Keyart" was added as a second,
/// structurally identical sibling feature - handled through this SAME
/// controller/route rather than a new one, exactly mirroring how
/// CustomPosterController already resolves Postercase vs. Keyart through
/// one shared "type" parameter (see that class's own doc comment for the
/// precedent this follows). Adding Animated Keyart meant adding a second
/// branch inside ResolveSingleType plus the same NormalizeType/
/// IsTypeEnabled/priority-resolution trio CustomPosterController already
/// has - not a new controller.
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
    /// "type" chooses which sub-feature: "auto" (the default, used by the
    /// client's own initial request) resolves Animated Poster vs. Animated
    /// Keyart by AnimatedPosterPriority, see ResolveItemResult's own doc
    /// comment; "animatedposter"/"animatedkeyart" resolve exactly that one
    /// type, used by the client's own subsequent image-URL request once it
    /// already knows which type won. "scope" chooses which of the two
    /// independent enable fields is checked (Movies/TvShows x Detail/
    /// Library are all four independently switchable, curriculum F).
    /// </summary>
    [HttpGet("{itemId}")]
    public ActionResult<AnimatedPosterResult> GetAnimatedPoster([FromRoute] Guid itemId, [FromQuery] string? type, [FromQuery] string? scope)
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
    /// ExtraposterController.GetPosterListBatch. "scope" here is almost
    /// always "library" (the detail page only ever needs a single item),
    /// the parameter still exists for consistency/completeness.
    /// </summary>
    // Same defensive upper bound as ExtraposterController.MaxBatchIds -
    // see that constant's comment for the full reasoning.
    private const int MaxBatchIds = 200;

    [HttpGet("batch")]
    public ActionResult<AnimatedPosterBatchResult> GetAnimatedPosterBatch([FromQuery] string? ids, [FromQuery] string? type, [FromQuery] string? scope)
    {
        var config = Plugin.Instance!.Configuration;
        var posterType = NormalizeType(type);
        var result = new AnimatedPosterBatchResult();

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
            // converter - Guid.ToString() (dashed) never matched (Session 122).
            var itemResult = ResolveItemResult(itemId, config, posterType, isLibraryScope) ?? new AnimatedPosterResult { IsApplicable = false };
            ApplyKeyartLogo(itemResult, config, isLibraryScope, itemId);
            result.Items[itemId.ToString("N")] = itemResult;
        }

        return Ok(result);
    }

    /// <summary>
    /// Animated Keyart's logo overlay values for the requested view (Session
    /// 126) - the same concept as Custom Keyart's. Animated Poster never gets
    /// a logo (a poster carries its title itself).
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
    /// itself. No "fileName" in the path like the other controllers (there
    /// is, after all, only ever exactly one possible file per item per
    /// type here) - the resolution happens entirely server-side, the
    /// frontend doesn't know the file name in advance at all.
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

            // Image bytes caching - see ExtraposterController.GetPosterImage's
            // comment for the full reasoning (found missing here too in the
            // same review round). Especially relevant here: the format is
            // typically animated (GIF/APNG/WEBP) and already loops on its
            // own once loaded - there's no reason to ever re-fetch it
            // within the cache window at all.
            var imageEtag = "\"" + fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";
            Response.Headers.ETag = imageEtag;
            Response.Headers.CacheControl = "public, max-age=86400";
            var ifNoneMatchImage = Request.Headers.IfNoneMatch.ToString();
            if (!string.IsNullOrEmpty(ifNoneMatchImage) && ifNoneMatchImage == imageEtag)
            {
                _logger.LogInformation("AnimatedPoster: GetAnimatedPosterImage - ETag unchanged, 304 for \"{Path}\"", fullPath);
                return StatusCode(StatusCodes.Status304NotModified);
            }

            var stream = System.IO.File.OpenRead(fullPath);
            _logger.LogInformation("AnimatedPoster: GetAnimatedPosterImage 200 - serving \"{Path}\", Content-Type={ContentType}", fullPath, contentType);
            return File(stream, contentType);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "AnimatedPoster: Unexpected error in GetAnimatedPosterImage for {ItemId}", itemId);
            return NotFound();
        }
    }

    // NOTE: this controller used to have its own GET /AnimatedPoster/script.js
    // endpoint here, serving Jellyfin-ArtworkPlus-AnimatedPoster-v1.js from
    // disk. That file no longer exists (architecture consolidation - see
    // Jellyfin-ArtworkPlus-Posters-v1.js's own header comment) - the
    // client script is now served by PostersPlusController's own
    // GetScript() endpoint instead (GET /PostersPlus/script.js). This
    // controller's OWN data endpoints below are unchanged and still
    // exactly what Posters-v1.js's own AnimatedModule calls.

    /// <summary>
    /// "auto" (priority resolution between Animated Poster/Animated
    /// Keyart) is the real default when "type" is missing/empty - same
    /// convention as CustomPosterController.NormalizeType.
    /// "animatedposter"/"animatedkeyart" remain valid explicit values,
    /// used by the client's own image-URL requests (which already know
    /// the resolved type by then) and available for direct testing/
    /// debugging.
    /// </summary>
    private static string NormalizeType(string? type)
    {
        if (string.Equals(type, "animatedposter", StringComparison.OrdinalIgnoreCase)) { return "animatedposter"; }
        if (string.Equals(type, "animatedkeyart", StringComparison.OrdinalIgnoreCase)) { return "animatedkeyart"; }
        return "auto";
    }

    /// <summary>
    /// Master (Enabled) switch per type. Checks the tab-level
    /// AnimatedPosterTabEnabled FIRST (mirrors CustomPosterController's
    /// own "server-side kill switch, applies BEFORE any further check"
    /// pattern - Phase 2, Session 90: this field used to be named
    /// AnimatedPosterEnabled and doubled as BOTH the tab-level AND the
    /// only feature's own switch; now split, same as
    /// ExtraposterTabEnabled/ExtraposterEnabled). "auto" is considered
    /// enabled as long as the TAB itself is on - the per-type check
    /// happens later, inside the priority resolution loop in
    /// ResolveItemResult, which simply skips whichever type turns out
    /// disabled.
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
    /// "auto" resolves Animated Poster vs. Animated Keyart by the
    /// configured AnimatedPosterPriority: tries the preferred type first,
    /// falls back to the other if the preferred one has no file, and
    /// returns IsApplicable=false only if NEITHER does. Explicit
    /// "animatedposter"/"animatedkeyart" skip the priority logic entirely
    /// and resolve exactly that one type - used by the client's own
    /// image-URL requests, which already know which type won from the
    /// initial "auto" call's own ResolvedType. Exact mirror of
    /// CustomPosterController.ResolveItemResult.
    /// </summary>
    private AnimatedPosterResult? ResolveItemResult(Guid itemId, PluginConfiguration config, string posterType, bool isLibraryScope)
    {
        if (posterType != "auto")
        {
            return ResolveSingleType(itemId, config, posterType, isLibraryScope);
        }

        var order = string.Equals(config.AnimatedPosterPriority, "AnimatedKeyart", StringComparison.OrdinalIgnoreCase)
            ? new[] { "animatedkeyart", "animatedposter" }
            : new[] { "animatedposter", "animatedkeyart" };

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

        return new AnimatedPosterResult { IsApplicable = false };
    }

    /// <summary>
    /// Resolves exactly one explicit type (never "auto" - the caller
    /// already handled that). Checks the type, checks the right enable
    /// field (depending on Movies/TvShows AND the detail/library scope),
    /// finds the folder, looks for the file.
    ///
    /// Phase 2 (Session 90/91): Sets has NO own Naming-mode/Type-name/
    /// Detail/Library fields for either type any more - reuses Movies'
    /// own (same simplification already applied to Extraposter/
    /// Extrakeyart/Postercase/Keyart in Phase 1, Session 87/88). Naming
    /// is always forced "Standalone" for Sets, same as it already was
    /// before this simplification - only the CONFIG FIELDS changed, not
    /// the behavior itself.
    /// </summary>
    private AnimatedPosterResult? ResolveSingleType(Guid itemId, PluginConfiguration config, string posterType, bool isLibraryScope)
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
                ? (isLibraryScope ? config.AnimatedKeyartMoviesLibraryEnabled : config.AnimatedKeyartMoviesDetailEnabled)
                : (isLibraryScope ? config.AnimatedPosterMoviesLibraryEnabled : config.AnimatedPosterMoviesDetailEnabled);
            if (!showOnMovies || !detailOrLibraryEnabled) { return null; }

            folderPath = movie.ContainingFolderPath;
            namingMode = isKeyart ? config.AnimatedKeyartMoviesNamingMode : config.AnimatedPosterMoviesNamingMode;
            typeName = isKeyart ? config.AnimatedKeyartMoviesTypeName : config.AnimatedPosterMoviesTypeName;
        }
        else if (item is BoxSet boxSet)
        {
            // CHANGED (Session 90): used to read AnimatedPosterSets*
            // (no Keyart equivalent existed yet) - now reuses Movies'
            // own Detail/Library/TypeName, same as every other set
            // simplification in this project. Positioned right after
            // Movie, unchanged from before.
            var showOnSets = isKeyart ? config.AnimatedKeyartShowOnSets : config.AnimatedPosterShowOnSets;
            var detailOrLibraryEnabled = isKeyart
                ? (isLibraryScope ? config.AnimatedKeyartMoviesLibraryEnabled : config.AnimatedKeyartMoviesDetailEnabled)
                : (isLibraryScope ? config.AnimatedPosterMoviesLibraryEnabled : config.AnimatedPosterMoviesDetailEnabled);
            if (!showOnSets || !detailOrLibraryEnabled) { return null; }

            folderPath = boxSet.ContainingFolderPath;
            namingMode = "Standalone";
            typeName = isKeyart ? config.AnimatedKeyartMoviesTypeName : config.AnimatedPosterMoviesTypeName;
        }
        else if (item is Series series)
        {
            var showOnTvShows = isKeyart ? config.AnimatedKeyartShowOnTvShows : config.AnimatedPosterShowOnTvShows;
            var detailOrLibraryEnabled = isKeyart
                ? (isLibraryScope ? config.AnimatedKeyartTvShowsLibraryEnabled : config.AnimatedKeyartTvShowsDetailEnabled)
                : (isLibraryScope ? config.AnimatedPosterTvShowsLibraryEnabled : config.AnimatedPosterTvShowsDetailEnabled);
            if (!showOnTvShows || !detailOrLibraryEnabled) { return null; }

            folderPath = series.ContainingFolderPath;
            namingMode = "Standalone"; // TV only ever has this one sensible variant, no config field needed
            typeName = isKeyart ? config.AnimatedKeyartTvShowsTypeName : config.AnimatedPosterTvShowsTypeName;
        }
        else
        {
            // Deliberately NO Season/Episode support for Animated
            // Poster/Animated Keyart - unlike Characterart, where that
            // was explicitly required. Both replace the main poster/
            // keyart, and Season/Episode have their own, different
            // image concepts in Jellyfin.
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
    /// Only for GetAnimatedPosterImage - resolves the folder path again,
    /// without repeating the full ResolveSingleType logic (the enable
    /// check has already happened at this point). Deliberately kept
    /// simple, since only Movie/BoxSet/Series are relevant here (no
    /// Season/Episode) - identical for both types, so no posterType
    /// parameter needed here at all.
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
    /// Finds the one possible animated file - with a server cache in front
    /// of it, the same principle as in the other controllers. No
    /// numbering needed (always exactly one file), so noticeably simpler
    /// than Extraposter's/Characterart's candidate resolution. Shared
    /// verbatim between Animated Poster and Animated Keyart - the caller
    /// already picked the right namingMode/typeName/format list, this
    /// function itself has no notion of "which type" at all.
    /// </summary>
    private string? FindAnimatedFile(string folderPath, string namingMode, string typeName, string? allowedFormatsCsv)
    {
        var lastWriteUtc = SafeGetLastWriteTimeUtc(folderPath);
        var cacheKey = string.Join('|', "AnimatedPoster:File", folderPath, lastWriteUtc.Ticks, namingMode, typeName, allowedFormatsCsv ?? string.Empty);

        if (_cache.TryGetValue(cacheKey, out string? cached))
        {
            return cached;
        }

        // In practice, APNG files very often carry the ".png" extension
        // (not ".apng") - browsers detect APNG by the file content, not
        // the extension (curriculum F: "APNG (.png/.apng)"). So if "apng"
        // is selected, we search for BOTH extensions, not just the rarer
        // ".apng".
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

        _logger.LogInformation(
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
