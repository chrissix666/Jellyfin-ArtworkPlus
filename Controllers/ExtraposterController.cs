using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
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
/// Result DTO for the poster list. No longer contains just the file names +
/// order, but also all the timing/behavior values the frontend needs for
/// playback (cycle/fade/delay/single-pass) - so these can be configured
/// centrally in the admin config page, instead of living as fixed values in
/// the script (curriculum, feature list A.5-A.8). PascalCase is
/// deliberately kept for all properties (no [JsonPropertyName]) - Jellyfin's
/// global JSON configuration is PascalCaseOptions, see the curriculum
/// "The biggest bug".
/// </summary>
/// <summary>
/// A single poster candidate, paired with its own version fingerprint -
/// the file's own LastWriteTimeUtc (not the containing folder's, since
/// overwriting an EXISTING file's content in place, same name, does not
/// necessarily update the parent folder's own mtime on most filesystems -
/// only the file's own does). Used to build a per-file, self-versioning
/// image URL (?v=...), the same principle native Jellyfin uses for its
/// own image tags: when the file changes, the URL changes automatically,
/// so a browser can safely cache the OLD url forever (it will simply
/// never be requested again) while the NEW url is fetched fresh - no
/// blind blanket cache-expiry window needed, and no risk of a replaced
/// file staying invisible until some fixed cache duration runs out.
/// </summary>
public class PosterEntry
{
    public string FileName { get; set; } = string.Empty;

    public string Version { get; set; } = string.Empty;
}

/// <summary>
/// DTO for GET /Extraposter/{itemId}/quickcheck - the poster-arbiter's
/// lightweight applicability probe. See GetQuickCheck's own doc comment
/// for why this is deliberately much smaller than PosterListResult (no
/// per-poster entries, no OrderMode/CycleTimeMs/FadeTimeMs/SinglePass -
/// none of that is needed just to decide "will something replace Main,
/// and after how long").
/// </summary>
public class QuickCheckResult
{
    public bool IsApplicable { get; set; }

    public bool DelayEnabled { get; set; }

    public int DelayMs { get; set; }

    /// <summary>
    /// "extraposter" or "extrakeyart" - only meaningful when the
    /// request's own "type" was "auto" (priority resolution between the
    /// two, see ResolvePosterType's own doc comment). The client uses
    /// this to build the correct explicit-type follow-up requests
    /// (GetPosterList, image URLs) without guessing.
    /// </summary>
    public string ResolvedType { get; set; } = string.Empty;
}

public class PosterListResult
{
    public bool IsMovie { get; set; }

    public string OrderMode { get; set; } = "Sequential";

    public IReadOnlyList<PosterEntry> Posters { get; set; } = Array.Empty<PosterEntry>();

    public int CycleTimeMs { get; set; } = 5000;

    public int FadeTimeMs { get; set; } = 500;

    public bool DelayEnabled { get; set; }

    public int DelayMs { get; set; }

    public bool SinglePass { get; set; }

    public string ResolvedType { get; set; } = string.Empty;

    /// <summary>
    /// 1:1 replica of CustomPosterResult's own identical three fields
    /// (explicit user request - see PluginConfiguration.cs's own
    /// ExtrakeyartLogoEnabled doc comment for the full reasoning). Set
    /// only when ResolvedType is "extrakeyart" AND ExtrakeyartLogoEnabled
    /// is true - the client has no other way to know the server's own
    /// config. Extraposter never sets this (matches Postercase's own
    /// identical "no logo overlay concept at all" exclusion).
    /// </summary>
    public bool LogoEnabled { get; set; }

    public int LogoVerticalPositionPercent { get; set; }

    public int LogoSizePercent { get; set; }
}

/// <summary>
/// Result DTO of the batch endpoint for the library view (curriculum
/// section C). One entry per requested itemId, key = itemId as a string
/// (a raw Guid would be unusual/unclean as a dictionary key in JSON). Every
/// entry still uses PosterListResult - populated with the appropriate
/// Library-Movies or Library-TvShows settings, depending on whether the
/// itemId was a Movie or a Series. Deliberately NO shared timing for the
/// whole response - Movies and TV shows can have different cycle/fade/delay
/// values (curriculum C), the JS groups client-side by type and runs two
/// independent, each internally synchronized clocks (see the curriculum:
/// page-wide synchronized clock - "synchronized" refers to tiles of the
/// SAME type, there's no requirement to synchronize Movie and Series tiles
/// with each other).
/// </summary>
public class BatchPosterListResult
{
    public Dictionary<string, PosterListResult> Items { get; set; } = new();
}

/// <summary>
/// Serves character posters directly from the movie folder - entirely
/// outside Jellyfin's ImageType system (see the curriculum: "no abusing the
/// backdrop slot"). AllowAnonymous is a deliberate choice, see the chat
/// answer about the auth chicken-and-egg problem with static
/// File-Transformation injection.
///
/// LOGGING PHILOSOPHY of this file (deliberately verbose, see curriculum
/// D0b - now applies to ALL six feature blocks, not just this one): every
/// decision that could lead to "no poster found" is logged - not just the
/// final outcome. Goal: for every future debugging case, a look at the
/// server log is enough, with no need to add new log lines and redeploy
/// first. All lines start with "Extraposter:", easy to filter for via log
/// search. Levels: LogInformation for the normal flow (always visible, even
/// without the Debug log level), LogWarning for genuinely
/// suspicious/erroneous states, LogError for unexpected exceptions.
/// </summary>
[ApiController]
[Route("Extraposter")]
[AllowAnonymous]
public class ExtraposterController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<ExtraposterController> _logger;
    private readonly IMemoryCache _cache;

    // Upper limit for the numbered variants (Standalone/Prefixed), analogous
    // to Jellyfin's own PopulateBackdrops behavior (there: up to 20, a
    // tolerance of 3 gaps). Deliberately simpler for us: we just list
    // everything up to this limit, with no gap-based early stop - the
    // Folder variant doesn't need this anyway (takes everything in the
    // folder).
    private const int MaxNumberedPosters = 50;

    // A safety net against unbounded cache growth (see the curriculum,
    // audit/counter-audit round on the caching strategy). Entries are NOT
    // invalidated based on time (the composite cache key itself handles
    // that, see ResolveCandidates), but if an entry isn't requested at all
    // for a longer time (e.g. because the folder timestamp or settings have
    // since changed, leaving the old key "orphaned"), it automatically gets
    // evicted after this time instead of staying in memory forever.
    private static readonly TimeSpan CacheSlidingExpiration = TimeSpan.FromHours(6);

    public ExtraposterController(ILibraryManager libraryManager, ILogger<ExtraposterController> logger, IMemoryCache cache)
    {
        _libraryManager = libraryManager;
        _logger = logger;
        _cache = cache;
    }

    /// <summary>
    /// GET /Extraposter/{itemId} - returns the list of found poster file
    /// names (not the images themselves) plus all currently configured
    /// timing/behavior settings.
    /// </summary>
    /// <summary>
    /// Extracted from GetPosterList's own first half (the movie/series
    /// resolution + per-type enabled-checks) so the new lightweight
    /// GetQuickCheck endpoint below can reuse the exact same "is this
    /// applicable at all" logic without duplicating it - added as part of
    /// the poster-arbiter feature (curriculum: "3-body problem" between
    /// Main/AnimatedPoster/ExtraPoster). Returns folderPath=null when not
    /// applicable for any reason (disabled, wrong type, etc.) - the
    /// specific reason is still logged by the caller via the ItemId/isMovie
    /// combination, exactly as GetPosterList's own inline version did.
    /// </summary>
    /// <summary>
    /// Extracted from GetPosterList's own first half (the movie/series
    /// resolution + per-type enabled-checks) so the new lightweight
    /// GetQuickCheck endpoint below can reuse the exact same "is this
    /// applicable at all" logic without duplicating it - added as part of
    /// the poster-arbiter feature (curriculum: "3-body problem" between
    /// Main/AnimatedPoster/ExtraPoster). Returns folderPath=null when not
    /// applicable for any reason (disabled, wrong type, etc.) - the
    /// specific reason is still logged by the caller via the ItemId/isMovie
    /// combination, exactly as GetPosterList's own inline version did.
    ///
    /// posterType parameter added for Extrakeyart: "extraposter" (default)
    /// reads the original Extraposter* fields, "extrakeyart" reads the
    /// sibling Extrakeyart* field set - same "one function, several
    /// naming-pattern types" precedent as CharacterartController's own
    /// ResolveCandidatesUncached and CustomPosterController's own
    /// ResolveSingleType.
    /// </summary>
    private (bool applicable, string? folderPath, string namingMode, string folderName) ResolveApplicability(Guid itemId, PluginConfiguration config, string posterType = "extraposter", bool isLibraryScope = false)
    {
        // Tab-level master switch (concept-session decision, mirrors
        // CustomPosterController's own IsTypeEnabled pattern) - checked
        // FIRST, applies to BOTH extraposter and extrakeyart equally,
        // since both live under the same Extraposter tab. Independent of
        // each type's own specific switch below.
        if (!config.ExtraposterTabEnabled)
        {
            return (false, null, string.Empty, string.Empty);
        }

        var isExtrakeyart = posterType == "extrakeyart";
        var typeEnabled = isExtrakeyart ? config.ExtrakeyartEnabled : config.ExtraposterEnabled;
        if (!typeEnabled)
        {
            return (false, null, string.Empty, string.Empty);
        }

        var (isMovie, movieFolderPath) = ResolveMovieFolder(itemId);
        if (isMovie && movieFolderPath is not null)
        {
            var showOnMovies = isExtrakeyart ? config.ExtrakeyartShowOnMovies : config.ExtraposterShowOnMovies;
            var moviesDetailOrLibraryEnabled = isExtrakeyart
                ? (isLibraryScope ? config.ExtrakeyartMoviesLibraryEnabled : config.ExtrakeyartMoviesDetailEnabled)
                : (isLibraryScope ? config.ExtraposterMoviesLibraryEnabled : config.ExtraposterMoviesDetailEnabled);
            if (!showOnMovies || !moviesDetailOrLibraryEnabled)
            {
                return (false, null, string.Empty, string.Empty);
            }

            var moviesNamingMode = isExtrakeyart ? config.ExtrakeyartMoviesNamingMode : config.ExtraposterMoviesNamingMode;
            var moviesFolderName = isExtrakeyart ? config.ExtrakeyartMoviesFolderName : config.ExtraposterMoviesFolderName;
            return (true, movieFolderPath, moviesNamingMode, moviesFolderName);
        }

        // Session 87 (Sets-Erweiterung, explicit user request): Sets has
        // NO own Naming-mode/Folder-name fields - reuses Movies' own,
        // but naming is ALWAYS forced to "Standalone" here regardless of
        // what Movies' own NamingMode is configured to (a Set has one
        // exclusive main folder, "Standalone" is always correct, same
        // reasoning as AnimatedPosterController's own identical BoxSet
        // branch). Positioned right after Movie, same convention.
        var (isSet, setFolderPath) = ResolveSetFolder(itemId);
        if (isSet && setFolderPath is not null)
        {
            var showOnSets = isExtrakeyart ? config.ExtrakeyartShowOnSets : config.ExtraposterShowOnSets;
            var setsDetailOrLibraryEnabled = isExtrakeyart
                ? (isLibraryScope ? config.ExtrakeyartMoviesLibraryEnabled : config.ExtrakeyartMoviesDetailEnabled)
                : (isLibraryScope ? config.ExtraposterMoviesLibraryEnabled : config.ExtraposterMoviesDetailEnabled);
            if (!showOnSets || !setsDetailOrLibraryEnabled)
            {
                return (false, null, string.Empty, string.Empty);
            }

            return (true, setFolderPath, "Standalone", string.Empty);
        }

        var (isSeries, seriesFolderPath) = ResolveSeriesFolder(itemId);
        if (!isSeries || seriesFolderPath is null)
        {
            return (false, null, string.Empty, string.Empty);
        }

        var showOnTvShows = isExtrakeyart ? config.ExtrakeyartShowOnTvShows : config.ExtraposterShowOnTvShows;
        var tvShowsDetailOrLibraryEnabled = isExtrakeyart
            ? (isLibraryScope ? config.ExtrakeyartTvShowsLibraryEnabled : config.ExtrakeyartTvShowsDetailEnabled)
            : (isLibraryScope ? config.ExtraposterTvShowsLibraryEnabled : config.ExtraposterTvShowsDetailEnabled);
        if (!showOnTvShows || !tvShowsDetailOrLibraryEnabled)
        {
            return (false, null, string.Empty, string.Empty);
        }

        var tvShowsNamingMode = isExtrakeyart ? config.ExtrakeyartTvShowsNamingMode : config.ExtraposterTvShowsNamingMode;
        var tvShowsFolderName = isExtrakeyart ? config.ExtrakeyartTvShowsFolderName : config.ExtraposterTvShowsFolderName;
        return (true, seriesFolderPath, tvShowsNamingMode, tvShowsFolderName);
    }

    /// <summary>
    /// "extraposter" and "extrakeyart" are valid explicit values; anything
    /// else (including missing/empty) becomes "auto" - same convention as
    /// CustomPosterController's own NormalizeType.
    /// </summary>
    private static string NormalizeType(string? type)
    {
        if (string.Equals(type, "extraposter", StringComparison.OrdinalIgnoreCase)) { return "extraposter"; }
        if (string.Equals(type, "extrakeyart", StringComparison.OrdinalIgnoreCase)) { return "extrakeyart"; }
        return "auto";
    }

    /// <summary>
    /// "auto" resolves Extraposter vs Extrakeyart by the configured
    /// ExtraposterPriority: tries the preferred type first, checks it
    /// actually HAS at least one candidate (not just that it's enabled/
    /// applicable per config - an enabled type with an empty folder
    /// should still fall through to the other type), falls back to the
    /// other type if not, returns null only if NEITHER has anything.
    /// Explicit "extraposter"/"extrakeyart" skip this entirely and are
    /// returned as-is - used by the client's own follow-up requests
    /// (GetPosterList, image URLs), which already know the winner from
    /// GetQuickCheck's own initial "auto" call.
    /// </summary>
    private string? ResolvePosterType(Guid itemId, PluginConfiguration config, string requestedType, bool isLibraryScope = false)
    {
        // Real bug found via explicit user report ("Extraposter
        // ausschalten, aber Extrakeyart einschalten, wird Extraposter
        // noch immer angezeigt"): an explicitly-requested type (not
        // "auto") used to be returned immediately here, WITHOUT ever
        // calling ResolveApplicability - meaning a stale/explicit type
        // parameter from the client could bypass the Enable/Show-on/
        // Detail-Library checks entirely. Now always validates via
        // ResolveApplicability first, for both the "auto" and the
        // explicit-type case - an explicit type is only honored if it's
        // actually still applicable.
        if (requestedType != "auto")
        {
            var (explicitApplicable, explicitFolderPath, explicitNamingMode, explicitFolderName) = ResolveApplicability(itemId, config, requestedType, isLibraryScope);
            if (!explicitApplicable || explicitFolderPath is null) { return null; }

            var explicitAllowedFormats = config.AllowedFormats;
            var explicitOrderMode = requestedType == "extrakeyart" ? config.ExtrakeyartOrderMode : config.OrderMode;
            var explicitCandidates = ResolveCandidates(explicitFolderPath, explicitNamingMode, explicitFolderName, explicitOrderMode, explicitAllowedFormats, requestedType, config.ExtrakeyartUnnumberedMode);
            return explicitCandidates.Count > 0 ? requestedType : null;
        }

        var order = string.Equals(config.ExtraposterPriority, "Extrakeyart", StringComparison.OrdinalIgnoreCase)
            ? new[] { "extrakeyart", "extraposter" }
            : new[] { "extraposter", "extrakeyart" };

        foreach (var candidateType in order)
        {
            var (applicable, folderPath, namingMode, folderName) = ResolveApplicability(itemId, config, candidateType, isLibraryScope);
            if (!applicable || folderPath is null) { continue; }

            var allowedFormats = config.AllowedFormats; // CHANGED: shared, tab-level now (explicit user request), no longer per-sub
            var orderMode = candidateType == "extrakeyart" ? config.ExtrakeyartOrderMode : config.OrderMode;
            var candidates = ResolveCandidates(folderPath, namingMode, folderName, orderMode, allowedFormats, candidateType, config.ExtrakeyartUnnumberedMode);
            if (candidates.Count > 0) { return candidateType; }
        }

        return null;
    }

    /// <summary>
    /// GET /Extraposter/{itemId}/quickcheck - lightweight applicability
    /// check for the poster-arbiter (Core.js) mechanism: "will ExtraPoster
    /// show something for this item, and if so, is there a configured
    /// delay?" - deliberately does NOT call BuildPosterEntries (which does
    /// a real FileInfo stat call per candidate to compute each poster's own
    /// cache-busting version fingerprint) since none of that is needed
    /// just to answer "at least one exists" - only ResolveCandidates
    /// (already itself cached, see its own doc comment) is called, and
    /// only its Count is inspected. One poster is enough - per explicit
    /// user decision, a single ExtraPoster is expected to normally mean
    /// more exist too, and even if not, one static poster still
    /// legitimately replaces Main (matches the corresponding `< 1` check
    /// in GetPosterList/GetPosterListBatch/Posters-v1.js's own
    /// ExtraModule, changed
    /// together with this endpoint from the previous `< 2` threshold).
    ///
    /// "type" query param added for Extrakeyart: "auto" (default, used by
    /// the client's own initial request) resolves Extraposter vs
    /// Extrakeyart by ExtraposterPriority - see ResolvePosterType's own
    /// doc comment.
    /// </summary>
    [HttpGet("{itemId}/quickcheck")]
    public ActionResult<QuickCheckResult> GetQuickCheck([FromRoute] Guid itemId, [FromQuery] string? type)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            var requestedType = NormalizeType(type);
            var resolvedType = ResolvePosterType(itemId, config, requestedType);
            if (resolvedType is null)
            {
                _logger.LogInformation("Extraposter: GetQuickCheck for {ItemId} -> not applicable (type={Type})", itemId, requestedType);
                return Ok(new QuickCheckResult { IsApplicable = false });
            }

            var (applicable, folderPath, namingMode, folderName) = ResolveApplicability(itemId, config, resolvedType);
            if (!applicable || folderPath is null)
            {
                _logger.LogInformation("Extraposter: GetQuickCheck for {ItemId} -> not applicable", itemId);
                return Ok(new QuickCheckResult { IsApplicable = false });
            }

            var isExtrakeyart = resolvedType == "extrakeyart";
            var orderMode = isExtrakeyart ? config.ExtrakeyartOrderMode : config.OrderMode;
            var allowedFormats = config.AllowedFormats; // CHANGED: shared, tab-level now (explicit user request), no longer per-sub
            var delayEnabled = isExtrakeyart ? config.ExtrakeyartDelayEnabled : config.DelayEnabled;
            var delayMs = isExtrakeyart ? config.ExtrakeyartDelayMs : config.DelayMs;

            var candidates = ResolveCandidates(folderPath, namingMode, folderName, orderMode, allowedFormats, resolvedType, config.ExtrakeyartUnnumberedMode);
            var hasAny = candidates.Count > 0;
            _logger.LogInformation(
                "Extraposter: GetQuickCheck for {ItemId} -> IsApplicable={HasAny} ({Count} candidate(s), ResolvedType={ResolvedType}, DelayEnabled={DelayEnabled}, Delay={Delay})",
                itemId, hasAny, candidates.Count, resolvedType, delayEnabled, delayMs);

            return Ok(new QuickCheckResult
            {
                IsApplicable = hasAny,
                DelayEnabled = delayEnabled,
                DelayMs = delayMs,
                ResolvedType = resolvedType
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Extraposter: Unexpected error in GetQuickCheck for {ItemId}", itemId);
            return Ok(new QuickCheckResult { IsApplicable = false });
        }
    }

    /// <summary>
    /// "type" query param added for Extrakeyart, same convention as
    /// GetQuickCheck: "auto" (default) resolves via ExtraposterPriority,
    /// explicit "extraposter"/"extrakeyart" skip straight to that type -
    /// used by the client once GetQuickCheck's own "auto" call already
    /// told it the winner. Rewritten to use ResolveApplicability/
    /// ResolvePosterType instead of the previous inline-duplicated
    /// Movie/Series resolution (which never actually reused
    /// ResolveApplicability despite that function's own doc comment
    /// promising it would) - net effect: less duplication, not just
    /// Extrakeyart support.
    /// </summary>
    [HttpGet("{itemId}")]
    public ActionResult<PosterListResult> GetPosterList([FromRoute] Guid itemId, [FromQuery] string? type)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            var requestedType = NormalizeType(type);
            _logger.LogInformation(
                "Extraposter: === GetPosterList START for {ItemId} | RequestedType={RequestedType}, Priority={Priority}",
                itemId, requestedType, config.ExtraposterPriority);

            var resolvedType = ResolvePosterType(itemId, config, requestedType);
            if (resolvedType is null)
            {
                _logger.LogInformation("Extraposter: === GetPosterList END for {ItemId} -> IsMovie=false (nothing applicable)", itemId);
                return Ok(new PosterListResult { IsMovie = false });
            }

            var (applicable, folderPath, namingMode, folderName) = ResolveApplicability(itemId, config, resolvedType);
            if (!applicable || folderPath is null)
            {
                _logger.LogInformation("Extraposter: === GetPosterList END for {ItemId} -> IsMovie=false", itemId);
                return Ok(new PosterListResult { IsMovie = false });
            }

            var isExtrakeyart = resolvedType == "extrakeyart";
            var orderMode = isExtrakeyart ? config.ExtrakeyartOrderMode : config.OrderMode;
            var allowedFormats = config.AllowedFormats; // CHANGED: shared, tab-level now (explicit user request), no longer per-sub
            var cycleTimeMs = isExtrakeyart ? config.ExtrakeyartCycleTimeMs : config.CycleTimeMs;
            var fadeTimeMs = isExtrakeyart ? config.ExtrakeyartFadeTimeMs : config.FadeTimeMs;
            var delayEnabled = isExtrakeyart ? config.ExtrakeyartDelayEnabled : config.DelayEnabled;
            var delayMs = isExtrakeyart ? config.ExtrakeyartDelayMs : config.DelayMs;
            var singlePass = isExtrakeyart ? config.ExtrakeyartSinglePass : config.SinglePass;

            // ETag-based browser caching (curriculum section B) - same
            // reasoning as before, fingerprint now also includes
            // resolvedType (an "auto" request could resolve to a
            // different type after a priority/config change, which must
            // invalidate the browser's cached copy).
            var folderLastWriteUtc = SafeGetLastWriteTimeUtc(folderPath);
            var etag = ComputeETag(
                itemId, resolvedType, folderLastWriteUtc.Ticks,
                namingMode, folderName, orderMode, allowedFormats,
                cycleTimeMs, fadeTimeMs, delayEnabled, delayMs, singlePass);

            if (IsETagStillValid(etag))
            {
                _logger.LogInformation(
                    "Extraposter: GetPosterList - ETag unchanged, returning 304 Not Modified for {ItemId} instead of the full JSON",
                    itemId);
                return StatusCode(StatusCodes.Status304NotModified);
            }

            var candidates = ResolveCandidates(folderPath, namingMode, folderName, orderMode, allowedFormats, resolvedType, config.ExtrakeyartUnnumberedMode);

            // A defensive safeguard, in addition to the live clamping in
            // the config page itself (curriculum A.6) - in case, e.g., an
            // invalid state was imported via the backup/restore code.
            var effectiveFadeMs = Math.Min(fadeTimeMs, cycleTimeMs);
            if (effectiveFadeMs != fadeTimeMs)
            {
                _logger.LogWarning(
                    "Extraposter: FadeTimeMs ({Fade}) was larger than CycleTimeMs ({Cycle}) for {ResolvedType} - clamped server-side to {Effective}",
                    fadeTimeMs, cycleTimeMs, resolvedType, effectiveFadeMs);
            }

            _logger.LogInformation(
                "Extraposter: === GetPosterList END for {ItemId} -> IsMovie=true, ResolvedType={ResolvedType}, {Count} posters found: [{Files}]",
                itemId,
                resolvedType,
                candidates.Count,
                string.Join(", ", candidates));

            // 1:1 replica of CustomPosterController's own identical logo
            // overlay logic (explicit user request) - deliberately its
            // own, entirely independent config (ExtrakeyartLogoEnabled,
            // not KeyartLogoEnabled), so the two overlays never affect
            // each other.
            var logoEnabled = isExtrakeyart && config.ExtrakeyartLogoEnabled;

            return Ok(new PosterListResult
            {
                IsMovie = true,
                OrderMode = orderMode,
                Posters = BuildPosterEntries(folderPath, candidates),
                CycleTimeMs = cycleTimeMs,
                FadeTimeMs = effectiveFadeMs,
                DelayEnabled = delayEnabled,
                DelayMs = delayMs,
                SinglePass = singlePass,
                ResolvedType = resolvedType,
                LogoEnabled = logoEnabled,
                LogoVerticalPositionPercent = logoEnabled ? config.ExtrakeyartLogoVerticalPositionPercent : 0,
                LogoSizePercent = logoEnabled ? config.ExtrakeyartLogoSizePercent : 0
            });
        }
        catch (Exception ex)
        {
            // Catches anything that could unexpectedly go wrong in the
            // steps above (e.g. a permission error while accessing the
            // directory) - ASP.NET's ExceptionMiddleware would catch this
            // anyway (no server crash), but with this Extraposter prefix
            // it's immediately clear which component it belongs to when
            // searching the log.
            _logger.LogError(ex, "Extraposter: Unexpected error in GetPosterList for {ItemId}", itemId);
            return Ok(new PosterListResult { IsMovie = false });
        }
    }

    /// <summary>
    /// GET /Extraposter/batch?ids=guid1,guid2,guid3 - batch endpoint for the
    /// library view (curriculum section C). Comma-separated itemIds as a
    /// query parameter, exactly mirroring Jellyfin's own native convention
    /// (ItemsController.cs:227 uses the same `ids` query-parameter name and
    /// the same comma-separated format). NOTE: Jellyfin's own
    /// CommaDelimitedArrayModelBinder lives in the Jellyfin.Api project,
    /// which plugins can't reference - so here we use a simple, custom
    /// comma-split instead of reusing that internal binder, but the result
    /// for the caller is the same URL format.
    ///
    /// Answers each itemId individually with either the Movies OR the
    /// TvShows library settings, depending on which type it actually is -
    /// invalid/not-found/disabled types simply return IsMovie=false for
    /// that one entry, the rest of the batch response is unaffected.
    /// </summary>
    // A defensive upper bound on the batch endpoint - it's [AllowAnonymous]
    // and reachable via any manually crafted URL, not just through the
    // plugin's own client-side code (which naturally stays well under
    // this via viewport-based IntersectionObserver + debounce). Found in
    // a formal audit pass: no functional harm from a huge ids list (each
    // GetItemById lookup is fast, in-memory), but an unbounded list is
    // still needless exposure for a request that doesn't need auth - a
    // cheap, minimal safeguard.
    private const int MaxBatchIds = 200;

    [HttpGet("batch")]
    public ActionResult<BatchPosterListResult> GetPosterListBatch([FromQuery] string? ids)
    {
        var result = new BatchPosterListResult();
        var config = Plugin.Instance!.Configuration;

        var allParsedIds = (ids ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => Guid.TryParse(s, out var g) ? g : (Guid?)null)
            .Where(g => g.HasValue)
            .Select(g => g!.Value)
            .Distinct()
            .ToList();
        var itemIds = allParsedIds.Take(MaxBatchIds).ToList();
        if (allParsedIds.Count > MaxBatchIds)
        {
            _logger.LogWarning(
                "Extraposter: GetPosterListBatch - {Requested} unique itemIds requested, truncated to the {Max} limit",
                allParsedIds.Count, MaxBatchIds);
        }

        _logger.LogInformation(
            "Extraposter: === GetPosterListBatch START, {Count} unique itemIds requested: [{Ids}]",
            itemIds.Count, string.Join(", ", itemIds));

        foreach (var itemId in itemIds)
        {
            // "N" (no dashes): the client looks the answer up by the tile's
            // data-id, which Jellyfin serialises via JsonGuidConverter as the
            // 32-hex form. Dictionary keys are strings and bypass that
            // converter - Guid.ToString() (dashed) never matched (Session 122).
            result.Items[itemId.ToString("N")] = ResolveLibraryItemResult(itemId, config);
        }

        _logger.LogInformation(
            "Extraposter: === GetPosterListBatch END, {Count} entries answered, {WithPosters} of them with IsMovie=true",
            result.Items.Count, result.Items.Values.Count(r => r.IsMovie));

        return Ok(result);
    }

    /// <summary>
    /// Resolves a single itemId for the batch endpoint - checks whether
    /// it's a Movie or a Series, and applies the correspondingly matching
    /// library settings (curriculum C: Movies and TV shows fully
    /// separately configurable). Everything else (Episode, Season, Person,
    /// any other type, not found) returns IsMovie=false.
    /// </summary>
    private PosterListResult ResolveLibraryItemResult(Guid itemId, PluginConfiguration config)
    {
        var item = _libraryManager.GetItemById(itemId);
        _logger.LogInformation(
            "Extraposter: ResolveLibraryItemResult - {ItemId} resolved as type \"{Type}\"",
            itemId, item?.GetType().FullName ?? "null (not found)");

        // Real bug found via explicit user report ("Extraposter
        // ausschalten, aber Extrakeyart einschalten, wird Extraposter
        // noch immer angezeigt... Habe leider auch noch kein Extrakeyart
        // gesehen"): this function used to be entirely separate,
        // hand-rolled logic that predates Extrakeyart's own introduction -
        // it never checked ExtraposterTabEnabled/ExtraposterEnabled/
        // ExtrakeyartEnabled at all (only Show-on + LibraryEnabled), and
        // had no Extrakeyart branch whatsoever, so the library view could
        // never show Extrakeyart and could never actually respect
        // Extraposter being turned off. Rewritten to reuse
        // ResolvePosterType/ResolveApplicability (isLibraryScope: true) -
        // the same, already-fixed logic the single-item detail endpoint
        // uses - instead of its own separate, silently-stale copy.
        // Session 122: BoxSet admitted - ResolveApplicability/ResolveSetFolder
        // below have handled Sets since Session 88, but this early gate
        // still turned every Set tile away, so the library view could
        // never show a Set's Extraposter.
        if (item is not Movie && item is not Series && item is not BoxSet)
        {
            _logger.LogInformation("Extraposter: ResolveLibraryItemResult - {ItemId} is neither a Movie, a Series nor a BoxSet, skipping", itemId);
            return new PosterListResult { IsMovie = false };
        }

        var resolvedType = ResolvePosterType(itemId, config, "auto", isLibraryScope: true);
        if (resolvedType is null)
        {
            _logger.LogInformation("Extraposter: ResolveLibraryItemResult - {ItemId} not applicable (Enable/Show-on/LibraryEnabled off, or no matching file)", itemId);
            return new PosterListResult { IsMovie = false };
        }

        var (applicable, folderPath, namingMode, folderName) = ResolveApplicability(itemId, config, resolvedType, isLibraryScope: true);
        if (!applicable || folderPath is null)
        {
            return new PosterListResult { IsMovie = false };
        }

        var isExtrakeyart = resolvedType == "extrakeyart";
        var allowedFormats = config.AllowedFormats;
        var orderMode = isExtrakeyart ? config.ExtrakeyartOrderMode : config.OrderMode;
        var candidates = ResolveCandidates(folderPath, namingMode, folderName, orderMode, allowedFormats, resolvedType, config.ExtrakeyartUnnumberedMode);
        var effectiveFade = Math.Min(config.FadeTimeMs, config.CycleTimeMs);

        return new PosterListResult
        {
            IsMovie = true, // the field name is historically "IsMovie", here it means "is a valid, enabled item"
            OrderMode = orderMode,
            Posters = BuildPosterEntries(folderPath, candidates),
            CycleTimeMs = config.CycleTimeMs,
            FadeTimeMs = effectiveFade,
            DelayEnabled = isExtrakeyart ? config.ExtrakeyartDelayEnabled : config.DelayEnabled,
            DelayMs = isExtrakeyart ? config.ExtrakeyartDelayMs : config.DelayMs,
            SinglePass = config.SinglePass,
            ResolvedType = resolvedType
        };
    }

    /// <summary>
    /// GET /Extraposter/{itemId}/image/{fileName} - serves a single image
    /// file. The file name is NOT joined directly with the folder path,
    /// but checked against the freshly, server-side resolved candidate
    /// list - this rules out path traversal, without us having to keep
    /// additional state/session between the two endpoints (see the
    /// curriculum: "the plugin stays dumb/stateless").
    ///
    /// Type-aware since the library extension (curriculum C): first tries
    /// Movie (detail-page settings), then Series (Library-TvShows
    /// settings) - an itemId is of course never both at once, the order is
    /// just the check order.
    /// </summary>
    [HttpGet("{itemId}/image/{fileName}")]
    public ActionResult GetPosterImage([FromRoute] Guid itemId, [FromRoute] string fileName, [FromQuery] string? type)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            var resolvedType = NormalizeType(type);
            if (resolvedType == "auto")
            {
                // Should not normally happen - the client always knows
                // the resolved type by the time it requests an image
                // (from GetPosterList's/GetQuickCheck's own ResolvedType),
                // but defaults to "extraposter" rather than failing
                // outright, matching NormalizeType's own general
                // philosophy of never silently picking the wrong thing
                // through an unreachable branch.
                resolvedType = "extraposter";
            }

            _logger.LogInformation(
                "Extraposter: GetPosterImage START for {ItemId}, type={Type}, requested file=\"{FileName}\"",
                itemId, resolvedType, fileName);

            // Deliberately NOT using ResolveApplicability here - that
            // function only checks *DetailEnabled (right, since it also
            // gates the detail-page endpoints), but this image endpoint
            // is shared by BOTH the detail page AND the library view
            // (no "scope" parameter to tell them apart), so it needs the
            // original "Detail OR Library" check - using
            // ResolveApplicability as-is would have been a real
            // regression: a user with only the library view enabled
            // (DetailEnabled=false, LibraryEnabled=true) would silently
            // lose all images. Inline, type-parameterized version of
            // that same "Detail OR Library" logic instead.
            string? folderPath = null;
            string namingMode = string.Empty;
            string folderName = string.Empty;
            var isExtrakeyart = resolvedType == "extrakeyart";

            var typeEnabled = config.ExtraposterTabEnabled
                && (isExtrakeyart ? config.ExtrakeyartEnabled : config.ExtraposterEnabled);
            if (typeEnabled)
            {
                var (isMovie, movieFolderPath) = ResolveMovieFolder(itemId);
                var showOnMovies = isExtrakeyart ? config.ExtrakeyartShowOnMovies : config.ExtraposterShowOnMovies;
                var moviesDetailEnabled = isExtrakeyart ? config.ExtrakeyartMoviesDetailEnabled : config.ExtraposterMoviesDetailEnabled;
                var moviesLibraryEnabled = isExtrakeyart ? config.ExtrakeyartMoviesLibraryEnabled : config.ExtraposterMoviesLibraryEnabled;
                if (isMovie && movieFolderPath is not null && showOnMovies && (moviesDetailEnabled || moviesLibraryEnabled))
                {
                    folderPath = movieFolderPath;
                    namingMode = isExtrakeyart ? config.ExtrakeyartMoviesNamingMode : config.ExtraposterMoviesNamingMode;
                    folderName = isExtrakeyart ? config.ExtrakeyartMoviesFolderName : config.ExtraposterMoviesFolderName;
                }
                else
                {
                    // Session 87 (Sets-Erweiterung): Sets reuses Movies'
                    // own Detail/Library flags and TypeName - see this
                    // function's own first ResolveMovieFolder/ResolveSet-
                    // Folder pairing above for the full reasoning. Naming
                    // is always forced "Standalone", never Movies'
                    // configured NamingMode.
                    var (isSet, setFolderPath) = ResolveSetFolder(itemId);
                    var showOnSets = isExtrakeyart ? config.ExtrakeyartShowOnSets : config.ExtraposterShowOnSets;
                    if (isSet && setFolderPath is not null && showOnSets && (moviesDetailEnabled || moviesLibraryEnabled))
                    {
                        folderPath = setFolderPath;
                        namingMode = "Standalone";
                        folderName = string.Empty;
                    }
                    else
                    {
                        var (isSeries, seriesFolderPath) = ResolveSeriesFolder(itemId);
                        var showOnTvShows = isExtrakeyart ? config.ExtrakeyartShowOnTvShows : config.ExtraposterShowOnTvShows;
                        var tvShowsDetailEnabled = isExtrakeyart ? config.ExtrakeyartTvShowsDetailEnabled : config.ExtraposterTvShowsDetailEnabled;
                        var tvShowsLibraryEnabled = isExtrakeyart ? config.ExtrakeyartTvShowsLibraryEnabled : config.ExtraposterTvShowsLibraryEnabled;
                        if (isSeries && seriesFolderPath is not null && showOnTvShows && (tvShowsDetailEnabled || tvShowsLibraryEnabled))
                        {
                            folderPath = seriesFolderPath;
                            namingMode = isExtrakeyart ? config.ExtrakeyartTvShowsNamingMode : config.ExtraposterTvShowsNamingMode;
                            folderName = isExtrakeyart ? config.ExtrakeyartTvShowsFolderName : config.ExtraposterTvShowsFolderName;
                        }
                    }
                }
            }

            List<string>? candidates = null;
            if (folderPath is not null)
            {
                var orderMode = isExtrakeyart ? config.ExtrakeyartOrderMode : config.OrderMode;
                var allowedFormats = config.AllowedFormats; // CHANGED: shared, tab-level now (explicit user request), no longer per-sub
                candidates = ResolveCandidates(folderPath, namingMode, folderName, orderMode, allowedFormats, resolvedType, config.ExtrakeyartUnnumberedMode);
            }

            if (folderPath is null || candidates is null)
            {
                _logger.LogWarning(
                    "Extraposter: GetPosterImage 404 - item {ItemId} couldn't be resolved as either an enabled Movie or an enabled Series (type={Type})",
                    itemId, resolvedType);
                return NotFound();
            }

            // Only serve what our own scan just found itself - fileName
            // comes from the client, but isn't blindly trusted here.
            if (!candidates.Contains(fileName, StringComparer.Ordinal))
            {
                _logger.LogWarning(
                    "Extraposter: GetPosterImage 404 - \"{FileName}\" not in the resolved candidate list for {ItemId}. Current candidate list: [{Candidates}]",
                    fileName, itemId, string.Join(", ", candidates));
                return NotFound();
            }

            var fullPath = Path.Combine(folderPath, fileName);
            var exists = System.IO.File.Exists(fullPath);
            _logger.LogInformation(
                "Extraposter: GetPosterImage - full path=\"{FullPath}\", File.Exists={Exists}",
                fullPath, exists);

            if (!exists)
            {
                // Should practically never happen (the candidate just came
                // from the very same File.Exists() check), but theoretically
                // possible with a race condition (the file gets
                // deleted/renamed between the two requests) - hence its
                // own log case.
                _logger.LogWarning(
                    "Extraposter: GetPosterImage 404 - the file was in the candidate list, but no longer exists: \"{FullPath}\"",
                    fullPath);
                return NotFound();
            }

            var contentType = GetContentType(fullPath);
            var fileInfo = new FileInfo(fullPath);

            // Image bytes caching (found missing in a later review round -
            // all the earlier ETag work only ever covered the LIST/JSON
            // endpoints, never the actual image-serving ones). Native
            // Jellyfin sets long-lived caching on its own served images
            // specifically so the disk doesn't have to be touched again
            // for unchanged content - this endpoint had none at all,
            // meaning every single poster switch during a rotation (same
            // handful of images, shown repeatedly) potentially re-hit the
            // disk. Fingerprint is the file's own LastWriteTimeUtc + size
            // (cheap - no need to read/hash the actual file content, and
            // still changes correctly if the file is ever replaced with
            // different content under the same name). "public" (not
            // "no-cache" like the LIST endpoint's ETag helper below) since
            // this is genuinely static content for the length of the
            // max-age window - browsers can serve it from cache without
            // even asking the server first, not just revalidate every time.
            var imageEtag = "\"" + fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";
            Response.Headers.ETag = imageEtag;
            Response.Headers.CacheControl = "public, max-age=86400";
            var ifNoneMatchImage = Request.Headers.IfNoneMatch.ToString();
            if (!string.IsNullOrEmpty(ifNoneMatchImage) && ifNoneMatchImage == imageEtag)
            {
                _logger.LogInformation("Extraposter: GetPosterImage - ETag unchanged, 304 for \"{FullPath}\"", fullPath);
                return StatusCode(StatusCodes.Status304NotModified);
            }

            _logger.LogInformation(
                "Extraposter: GetPosterImage 200 - serving \"{FullPath}\", {Size} bytes, Content-Type={ContentType}",
                fullPath, fileInfo.Length, contentType);

            var stream = System.IO.File.OpenRead(fullPath);
            return File(stream, contentType);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Extraposter: Unexpected error in GetPosterImage for {ItemId}/{FileName}", itemId, fileName);
            return NotFound();
        }
    }

    // NOTE: this controller used to have its own GET /Extraposter/script.js
    // endpoint here, serving Jellyfin-ArtworkPlus-ExtraPoster-v1.js from
    // disk (a merge of what used to be two separate files/endpoints -
    // detail-page script.js and library-view library.js - itself merged
    // earlier during the ArtworkPlus rename). That file no longer exists
    // (a second, later architecture consolidation: CustomPoster/
    // AnimatedPoster/ExtraPoster's previously separate visual render
    // paths were merged into one shared state machine - see
    // Jellyfin-ArtworkPlus-Posters-v1.js's own header comment for the
    // full reasoning) - the client script (detail-page AND library-view
    // logic alike, still two independently-scoped IIFEs internally) is
    // now served by PostersPlusController's own GetScript() endpoint
    // instead (GET /PostersPlus/script.js). This controller's OWN data
    // endpoints below (quickcheck, poster list, image serving, batch) are
    // unchanged and still exactly what Posters-v1.js's own
    // ExtraModule calls.

    /// <summary>
    /// Computes a short, stable ETag fingerprint from any number of values
    /// - all parts are joined with "|" and hashed. SHA256 here is pure
    /// convenience (collision-resistant enough for this purpose), not a
    /// security requirement. Returned in quotes, as the HTTP ETag header
    /// standard requires.
    /// </summary>
    private static string ComputeETag(params object?[] parts)
    {
        var raw = string.Join('|', parts.Select(p => p?.ToString() ?? string.Empty));
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw));
        return "\"" + Convert.ToHexString(hash)[..16] + "\"";
    }

    /// <summary>
    /// Sets the ETag and Cache-Control headers on the current response and
    /// checks whether the `If-None-Match` header sent by the browser
    /// already matches the current ETag - if so, the caller can respond
    /// with 304 Not Modified instead of building and transmitting the full
    /// JSON response. `no-cache` (NOT `no-store`!) lets the browser keep
    /// its previous response, but always requires this slim validation
    /// request first (curriculum section B).
    /// </summary>
    private bool IsETagStillValid(string etag)
    {
        Response.Headers.ETag = etag;
        Response.Headers.CacheControl = "no-cache";
        var ifNoneMatch = Request.Headers.IfNoneMatch.ToString();
        return !string.IsNullOrEmpty(ifNoneMatch) && ifNoneMatch == etag;
    }

    /// <summary>
    /// Like <see cref="Directory.GetLastWriteTimeUtc"/>, but catches
    /// permission errors etc. - a failed timestamp lookup shouldn't crash
    /// the whole request, but simply return a placeholder timestamp
    /// (guaranteed to never match anything afterward).
    /// </summary>
    private DateTime SafeGetLastWriteTimeUtc(string folderPath)
    {
        try
        {
            return Directory.GetLastWriteTimeUtc(folderPath);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Extraposter: SafeGetLastWriteTimeUtc failed for \"{Folder}\"", folderPath);
            return DateTime.MinValue;
        }
    }

    private (bool IsMovie, string? FolderPath) ResolveMovieFolder(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);

        _logger.LogInformation(
            "Extraposter: ResolveMovieFolder - item {ItemId} resolved as type \"{Type}\"",
            itemId,
            item?.GetType().FullName ?? "null (not found)");

        if (item is not Movie movie)
        {
            _logger.LogInformation(
                "Extraposter: ResolveMovieFolder - not a Movie, aborting for {ItemId}",
                itemId);
            return (false, null);
        }

        var folderPath = movie.ContainingFolderPath;
        var exists = !string.IsNullOrEmpty(folderPath) && Directory.Exists(folderPath);

        _logger.LogInformation(
            "Extraposter: ResolveMovieFolder - ContainingFolderPath=\"{Path}\", Directory.Exists={Exists}",
            folderPath, exists);

        if (!exists)
        {
            _logger.LogWarning(
                "Extraposter: ResolveMovieFolder - folder not found from the server's point of view for {ItemId}: \"{Path}\" (possible causes: network drive not visible to the service context, path was moved, permission problem)",
                itemId, folderPath ?? "(empty)");
            return (true, null);
        }

        return (true, folderPath);
    }

    /// <summary>
    /// Analogous to <see cref="ResolveMovieFolder"/>, but for Series (the
    /// TV-show main level, curriculum section C/E). Series inherits from
    /// Jellyfin's Folder base class - so, like a movie, it has its own,
    /// exclusive main folder. Called directly with the Series' own itemId
    /// (not navigated via Episode/Season) - for the library view, a tile's
    /// itemId is always already the series itself.
    /// </summary>
    private (bool IsSeries, string? FolderPath) ResolveSeriesFolder(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);

        _logger.LogInformation(
            "Extraposter: ResolveSeriesFolder - item {ItemId} resolved as type \"{Type}\"",
            itemId,
            item?.GetType().FullName ?? "null (not found)");

        if (item is not Series series)
        {
            _logger.LogInformation(
                "Extraposter: ResolveSeriesFolder - not a Series, aborting for {ItemId}",
                itemId);
            return (false, null);
        }

        var folderPath = series.ContainingFolderPath;
        var exists = !string.IsNullOrEmpty(folderPath) && Directory.Exists(folderPath);

        _logger.LogInformation(
            "Extraposter: ResolveSeriesFolder - ContainingFolderPath=\"{Path}\", Directory.Exists={Exists}",
            folderPath, exists);

        if (!exists)
        {
            _logger.LogWarning(
                "Extraposter: ResolveSeriesFolder - folder not found from the server's point of view for {ItemId}: \"{Path}\"",
                itemId, folderPath ?? "(empty)");
            return (true, null);
        }

        return (true, folderPath);
    }

    /// <summary>
    /// Session 87 (Sets-Erweiterung, explicit user request): analogous
    /// to <see cref="ResolveMovieFolder"/>/<see cref="ResolveSeriesFolder"/>
    /// above, but for BoxSet (a "Set"/Collection). Like Movie/Series, a
    /// BoxSet has its own, exclusive main folder (inherits from
    /// Jellyfin's Folder base class) - ContainingFolderPath works the
    /// same way, already confirmed working for this exact type in
    /// AnimatedPosterController's own identical BoxSet branch.
    /// </summary>
    private (bool IsSet, string? FolderPath) ResolveSetFolder(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);

        _logger.LogInformation(
            "Extraposter: ResolveSetFolder - item {ItemId} resolved as type \"{Type}\"",
            itemId,
            item?.GetType().FullName ?? "null (not found)");

        if (item is not BoxSet boxSet)
        {
            _logger.LogInformation(
                "Extraposter: ResolveSetFolder - not a BoxSet, aborting for {ItemId}",
                itemId);
            return (false, null);
        }

        var folderPath = boxSet.ContainingFolderPath;
        var exists = !string.IsNullOrEmpty(folderPath) && Directory.Exists(folderPath);

        _logger.LogInformation(
            "Extraposter: ResolveSetFolder - ContainingFolderPath=\"{Path}\", Directory.Exists={Exists}",
            folderPath, exists);

        if (!exists)
        {
            _logger.LogWarning(
                "Extraposter: ResolveSetFolder - folder not found from the server's point of view for {ItemId}: \"{Path}\"",
                itemId, folderPath ?? "(empty)");
            return (true, null);
        }

        return (true, folderPath);
    }

    /// <summary>
    /// Turns a comma-separated format list ("jpg,png,webp") into real file
    /// extensions with a dot (".jpg",".png",".webp"). Falls back to ".jpg"
    /// if the configuration is empty/invalid (e.g. a freshly installed
    /// plugin before the config page has been saved for the first time) -
    /// never returns an empty list, otherwise ResolveCandidates would
    /// always return 0 matches for no reason. Deliberately takes a plain
    /// string instead of the whole PluginConfiguration - reused for both
    /// the Movies and the TvShows format list (curriculum C: fully
    /// separate settings per type).
    /// </summary>
    private string[] GetAllowedExtensions(string? allowedFormatsCsv)
    {
        var extensions = (allowedFormatsCsv ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .ToArray();

        if (extensions.Length == 0)
        {
            _logger.LogWarning(
                "Extraposter: GetAllowedExtensions - the format list was empty/invalid (\"{Raw}\"), falling back to \".jpg\"",
                allowedFormatsCsv);
            return new[] { ".jpg" };
        }

        return extensions;
    }

    /// <summary>
    /// Finds the poster candidates in a folder - with a server cache in
    /// front of it (curriculum section B). The cache key is deliberately
    /// built from ALL the values that affect the result: the folder's
    /// change date (`LastWriteTimeUtc`, catches new/changed files) AND the
    /// naming pattern/folder/order/formats (catches admin settings
    /// changes). If any of these changes, a new key is created
    /// automatically - no explicit "clear the cache" needed, the old entry
    /// simply isn't requested anymore and disappears on its own after
    /// <see cref="CacheSlidingExpiration"/>. Deliberately `LastWriteTimeUtc`
    /// instead of `FileSystemWatcher` - Microsoft's own docs confirm the
    /// watcher is unreliable on network drives (curriculum: caching
    /// best-practice research).
    /// </summary>
    /// <summary>
    /// Pairs each candidate file name with its own version fingerprint
    /// (LastWriteTimeUtc.Ticks-Length, the same formula the image
    /// endpoint's own ETag already uses) - the direct mechanism that
    /// carries per-file version data from the list endpoint to the
    /// client, so the client can build a self-versioning image URL
    /// (?v=...) per poster. A file that can no longer be stat'd (deleted
    /// between the folder scan and this call - a narrow but real race,
    /// same one already noted elsewhere in this file) gets an empty
    /// version rather than aborting the whole list - the image endpoint
    /// itself still correctly 404s for it regardless of what any stale
    /// "v" value would have been.
    /// </summary>
    private static List<PosterEntry> BuildPosterEntries(string folderPath, List<string> fileNames)
    {
        return fileNames.Select(fileName =>
        {
            string version;
            try
            {
                var fullPath = Path.Combine(folderPath, fileName);
                var fileInfo = new FileInfo(fullPath);
                version = fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                version = string.Empty;
            }

            return new PosterEntry { FileName = fileName, Version = version };
        }).ToList();
    }

    private List<string> ResolveCandidates(string folderPath, string namingMode, string folderName, string orderMode, string? allowedFormatsCsv, string posterType = "extraposter", string unnumberedMode = "Ignored")
    {
        DateTime lastWriteUtc;
        try
        {
            lastWriteUtc = Directory.GetLastWriteTimeUtc(folderPath);
        }
        catch (Exception ex)
        {
            // Can happen, e.g., with permission problems - better to run
            // uncached in that case (always scan fresh) than to keep using
            // the same (possibly empty) cache entry forever with a
            // wrong/never-changing timestamp.
            _logger.LogWarning(ex, "Extraposter: ResolveCandidates - GetLastWriteTimeUtc failed for \"{Folder}\", skipping the cache for this request", folderPath);
            var uncachedResult = ResolveCandidatesUncached(folderPath, namingMode, folderName, "Sequential", allowedFormatsCsv, unnumberedMode, posterType);
            return orderMode == "Sequential" ? uncachedResult : ApplyOrder(uncachedResult, orderMode);
        }

        // orderMode deliberately left OUT of the cache key now - see
        // below for why: the cached list is always the raw, naturally-
        // sorted discovery result, identical regardless of orderMode, so
        // keying on it would just create redundant, wasteful cache
        // entries for the same underlying files. posterType IS part of
        // the key (Extrakeyart addition) - a user could theoretically
        // give both a matching folder name, and without this the two
        // types' own caches would collide and return each other's files.
        var cacheKey = string.Join(
            '|',
            "Extraposter:Candidates",
            posterType,
            folderPath,
            lastWriteUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture),
            namingMode,
            folderName,
            allowedFormatsCsv ?? string.Empty,
            unnumberedMode);

        List<string> naturallyOrdered;
        if (_cache.TryGetValue(cacheKey, out List<string>? cached) && cached is not null)
        {
            _logger.LogInformation(
                "Extraposter: ResolveCandidates - cache hit, no disk access needed. Key: \"{Key}\"",
                cacheKey);
            naturallyOrdered = cached;
        }
        else
        {
            _logger.LogInformation(
                "Extraposter: ResolveCandidates - cache miss, scanning the disk. Key: \"{Key}\"",
                cacheKey);

            // Real, user-identified bug fixed here: this used to cache
            // the ALREADY-SHUFFLED Random result directly, meaning the
            // one-time shuffle outcome itself sat behind the 6-hour
            // sliding cache - the same order kept reappearing for as
            // long as the title kept being accessed (resetting the
            // slide), which is NOT what "Random" was supposed to mean.
            // Always resolving in natural order here now (regardless of
            // the caller's actual orderMode) means only the genuinely
            // expensive part - the filesystem discovery itself - is what
            // ends up cached.
            naturallyOrdered = ResolveCandidatesUncached(folderPath, namingMode, folderName, "Sequential", allowedFormatsCsv, unnumberedMode, posterType);
            _cache.Set(cacheKey, naturallyOrdered, new MemoryCacheEntryOptions().SetSlidingExpiration(CacheSlidingExpiration));
        }

        // Applied fresh on every single call when Random is selected -
        // cheap (a plain in-memory shuffle of an already-known list, no
        // filesystem access at all), so there's no real cost to doing
        // this every time rather than caching the shuffled outcome.
        // Never mutates naturallyOrdered itself (OrderBy returns a new list).
        return orderMode == "Sequential" ? naturallyOrdered : ApplyOrder(naturallyOrdered, orderMode);
    }

    /// <summary>
    /// "Shuffle": a full permutation of the whole list - guarantees every
    /// image appears exactly once before any repeat, since the entire
    /// returned sequence for one request/round is a genuine permutation,
    /// not an independent draw per position.
    /// "Random": deliberately the simplest possible random pick, distinct
    /// from "Shuffle" - independently draws (WITH replacement) for every
    /// position in a list of the same length as the input - the same
    /// file can appear more than once, or not at all. Explicit user
    /// request: "ein einfacher zufallsgenerator (es könnten auch immer
    /// dieselben kommen)".
    /// Never called for "Sequential" - callers check that case themselves
    /// to avoid the allocation/shuffle work entirely when not needed.
    /// </summary>
    private static List<string> ApplyOrder(List<string> fileNames, string orderMode)
    {
        if (orderMode == "Shuffle")
        {
            return fileNames.OrderBy(_ => Guid.NewGuid()).ToList();
        }

        var rnd = new Random();
        var result = new List<string>(fileNames.Count);
        for (var i = 0; i < fileNames.Count; i++)
        {
            result.Add(fileNames[rnd.Next(fileNames.Count)]);
        }

        return result;
    }

    /// <summary>
    /// The actual, uncached scan logic - unchanged from the original
    /// version, just renamed and now hidden behind the cache wrapper above.
    /// </summary>
    private List<string> ResolveCandidatesUncached(string folderPath, string namingMode, string folderName, string orderMode, string? allowedFormatsCsv, string unnumberedMode = "Ignored", string posterType = "extraposter")
    {
        var allowedExtensions = GetAllowedExtensions(allowedFormatsCsv);
        List<string> fileNames;

        // Always log what's actually in the relevant folder first,
        // regardless of the naming pattern. That's the fastest way to spot
        // a typo/differing character in the expected vs. actual file
        // name: simply compare the two lists side by side, without having
        // to guess.
        try
        {
            var allFilesInFolder = Directory.EnumerateFiles(folderPath)
                .Select(Path.GetFileName)
                .ToList();
            _logger.LogInformation(
                "Extraposter: ResolveCandidates - actual contents of \"{Folder}\" ({Count} files): [{Files}], allowed extensions: [{Allowed}]",
                folderPath, allFilesInFolder.Count, string.Join(", ", allFilesInFolder), string.Join(", ", allowedExtensions));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Extraposter: ResolveCandidates - couldn't list the folder contents: \"{Folder}\"", folderPath);
        }

        if (namingMode == "Folder")
        {
            var subFolder = Path.Combine(folderPath, folderName);
            var subFolderExists = Directory.Exists(subFolder);
            _logger.LogInformation(
                "Extraposter: ResolveCandidates - Folder mode, expected subfolder=\"{SubFolder}\", Directory.Exists={Exists}",
                subFolder, subFolderExists);

            if (!subFolderExists)
            {
                return new List<string>();
            }

            var filesInSubFolder = Directory.EnumerateFiles(subFolder).Select(Path.GetFileName).ToList();
            _logger.LogInformation(
                "Extraposter: ResolveCandidates - contents of \"{SubFolder}\" ({Count} files): [{Files}]",
                subFolder, filesInSubFolder.Count, string.Join(", ", filesInSubFolder));

            // The Folder variant: everything in it counts, no naming
            // convention needed - return paths relative to the actual
            // movie folder, so GetPosterImage() can use the same
            // Path.Combine(folderPath, fileName) logic uniformly for all
            // three variants.
            fileNames = filesInSubFolder
                .Where(f => f is not null && allowedExtensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase))
                .Select(f => Path.Combine(folderName, f!))
                .ToList();

            var skipped = filesInSubFolder.Count - fileNames.Count;
            if (skipped > 0)
            {
                _logger.LogInformation(
                    "Extraposter: ResolveCandidates - {Skipped} file(s) in the subfolder skipped due to an unsupported extension (allowed: {Allowed})",
                    skipped, string.Join(", ", allowedExtensions));
            }
        }
        else
        {
            // Real bug found via user report ("Extraposter deaktiviert,
            // Extrakeyart aktiviert - Extraposter erscheint trotzdem"):
            // this used to hardcode the literal word "poster" for BOTH
            // types - correct and unchanged for Extraposter itself (its
            // own UI text has always promised exactly "poster", matching
            // this literal word since before Extrakeyart existed -
            // existing installations' own files are named accordingly,
            // so this word is intentionally NOT touched here), but wrong
            // for Extrakeyart, which silently searched for the exact same
            // "poster" pattern despite its own UI text promising
            // "keyart" (folderName's own default) - meaning a leftover
            // file created for Extraposter kept getting found and shown
            // by Extrakeyart too, even with Extraposter disabled. Only
            // Extrakeyart's own branch changed, to the word it already
            // owns (`folderName`) - matches CustomPosterController's own
            // identical pattern for its OWN two types (Postercase/
            // Keyart), each with its own distinct word.
            var isExtrakeyartType = posterType == "extrakeyart";
            var prefixWord = isExtrakeyartType ? folderName : "poster";
            var prefix = namingMode == "Prefixed"
                ? Path.GetFileName(folderPath) + "-" + prefixWord
                : prefixWord;

            // For a direct character-by-character comparison: the first
            // complete example path we actually check - helps spot subtle
            // deviations (a different type of hyphen, a missing space,
            // etc.) at a glance.
            var exampleCandidate = Path.Combine(folderPath, prefix + "1" + allowedExtensions[0]);
            _logger.LogInformation(
                "Extraposter: ResolveCandidates - NamingMode={NamingMode}, searched prefix=\"{Prefix}\", example full path #1=\"{Example}\"",
                namingMode, prefix, exampleCandidate);

            fileNames = new List<string>();

            // Extrakeyart-only feature (explicit user request): an
            // unnumbered file (e.g. "keyart.jpg", no "1"/"2"/...
            // suffix) can optionally be picked up as the very first image
            // in the rotation, ahead of the explicitly numbered ones -
            // "Counts as #1" adds it first if found; "Ignored" (the
            // default, matching this search's own pre-existing behavior
            // exactly) skips this check entirely, same as before this
            // field existed.
            // Real bug found via the same consistency pass as the prefix
            // word fix above: this check used to run for BOTH types
            // whenever `unnumberedMode` happened to be "Counts" -
            // Extraposter has no UI of its own for this setting (only
            // Extrakeyart's own "Unnumbered file" dropdown exists), but
            // since `config.ExtrakeyartUnnumberedMode` is passed to EVERY
            // ResolveCandidates() call unconditionally (including ones
            // resolving plain Extraposter), setting Extrakeyart's own
            // dropdown to "Counts" would have silently made Extraposter
            // ALSO start picking up an unnumbered "poster.ext" file as
            // its own first image - despite this being explicitly
            // documented as an "Extrakeyart-only feature" below. Gated on
            // `isExtrakeyartType` to actually match that intent.
            if (unnumberedMode == "Counts" && isExtrakeyartType)
            {
                foreach (var ext in allowedExtensions)
                {
                    var unnumberedCandidate = prefix + ext;
                    if (System.IO.File.Exists(Path.Combine(folderPath, unnumberedCandidate)))
                    {
                        fileNames.Add(unnumberedCandidate);
                        _logger.LogInformation(
                            "Extraposter: ResolveCandidates - unnumbered file found and counted as #1: \"{Candidate}\"",
                            unnumberedCandidate);
                        break; // one match is enough, same "first extension wins" principle as the numbered loop below
                    }
                }
            }

            var lastCheckedNumber = 0;
            for (var i = 1; i <= MaxNumberedPosters; i++)
            {
                lastCheckedNumber = i;
                var found = false;
                foreach (var ext in allowedExtensions)
                {
                    var candidate = prefix + i.ToString(System.Globalization.CultureInfo.InvariantCulture) + ext;
                    if (System.IO.File.Exists(Path.Combine(folderPath, candidate)))
                    {
                        fileNames.Add(candidate);
                        found = true;
                        break; // one match per number is enough, not all extensions at once
                    }
                }

                // As soon as the first 3 numbers found nothing, break
                // early instead of stubbornly counting up to
                // MaxNumberedPosters - saves unnecessary File.Exists()
                // calls for empty sets.
                if (!found && i >= 3 && fileNames.Count == 0)
                {
                    _logger.LogInformation(
                        "Extraposter: ResolveCandidates - the first 3 numbers (1-3) had no match, aborting the search early instead of continuing to {Max}",
                        MaxNumberedPosters);
                    break;
                }
            }

            _logger.LogInformation(
                "Extraposter: ResolveCandidates - search performed up to number {Last}, {Count} matches: [{Files}]",
                lastCheckedNumber, fileNames.Count, string.Join(", ", fileNames));
        }

        List<string> result;
        if (orderMode == "Shuffle")
        {
            // A full permutation of the whole list - guarantees every
            // image appears exactly once before any repeat, since the
            // entire returned sequence for one request/round is a
            // genuine permutation, not an independent draw per position.
            result = fileNames.OrderBy(_ => Guid.NewGuid()).ToList();
        }
        else if (orderMode == "Random")
        {
            // Deliberately the simplest possible random pick, distinct
            // from "Shuffle" above: independently draws (WITH
            // replacement) for every position in a list of the same
            // length as the candidate pool - the same file can appear
            // more than once, or not at all, in a given result. Explicit
            // user request: "ein einfacher zufallsgenerator (es könnten
            // auch immer dieselben kommen)".
            var rnd = new Random();
            result = new List<string>(fileNames.Count);
            for (var i = 0; i < fileNames.Count; i++)
            {
                result.Add(fileNames[rnd.Next(fileNames.Count)]);
            }
        }
        else
        {
            result = NaturalSort(fileNames);
        }

        _logger.LogInformation(
            "Extraposter: ResolveCandidates - final order ({OrderMode}): [{Files}]",
            orderMode, string.Join(", ", result));

        return result;
    }

    /// <summary>
    /// Sorts by the numeric suffix in the file name, not as a string -
    /// otherwise "poster11" would come before "poster2" (see the
    /// curriculum: explicitly required). Files with no recognizable number
    /// (e.g. the Folder variant with arbitrary names) fall back to normal
    /// alphabetical sorting, stably placed at the end. Still internally
    /// called "NaturalSort" (the method's name) even though the config-page
    /// setting is now called "Sequential" (originally "Natural", then
    /// "Numeric", per user feedback across two rounds) - purely a renaming
    /// of the display/config value, the sorting logic itself is unchanged
    /// throughout (the comparison only ever checks for "Random", never for
    /// the specific non-random value's name, so renaming it is safe).
    ///
    /// REWORKED per direct user feedback: the doc comment above describing
    /// "numbered ones first, then the rest" was the OLD behavior and is now
    /// stale in spirit (kept the historical context above rather than
    /// rewriting it, since it still correctly explains WHY numeric
    /// comparison matters). The actual comparer is now a genuine
    /// alphanumeric "natural sort": the whole stem (filename without
    /// extension - Folder mode allows ANY name, so the extension itself
    /// shouldn't factor into ordering) is split into alternating
    /// text/digit chunks and compared chunk by chunk, text chunks as
    /// case-insensitive strings, digit chunks numerically (comparing
    /// digit-string length first, then lexicographically - avoids ever
    /// parsing into a bounded integer type at all, so the camera-timestamp
    /// overflow concern from the old implementation's comment doesn't even
    /// apply here anymore, for numbers of ANY length). A name that's an
    /// exact prefix of another (out of chunks first) sorts before it - so
    /// "banana" sorts before "banana1" (matches plain alphabetical
    /// intuition - a shorter string sorts before the same string with more
    /// appended), while "banana1"/"banana2"/"banana11" sort in genuine
    /// ascending numeric order among themselves, not first-as-a-block.
    /// </summary>
    private static List<string> NaturalSort(List<string> fileNames)
    {
        var result = new List<string>(fileNames);
        result.Sort(NaturalFileNameComparer.Instance);
        return result;
    }

    /// <summary>
    /// See NaturalSort's own doc comment above for the full reasoning.
    /// A dedicated IComparer (rather than a LINQ OrderBy key selector)
    /// because comparing two filenames here genuinely needs a real
    /// chunk-by-chunk walk, not a single sortable key value per file.
    /// </summary>
    private sealed class NaturalFileNameComparer : IComparer<string>
    {
        public static readonly NaturalFileNameComparer Instance = new();

        private static readonly Regex ChunkPattern = new(@"\d+|\D+", RegexOptions.Compiled);

        public int Compare(string? a, string? b)
        {
            if (a is null || b is null)
            {
                return string.CompareOrdinal(a, b);
            }

            var stemA = Path.GetFileNameWithoutExtension(a);
            var stemB = Path.GetFileNameWithoutExtension(b);

            var chunksA = ChunkPattern.Matches(stemA);
            var chunksB = ChunkPattern.Matches(stemB);
            var count = Math.Min(chunksA.Count, chunksB.Count);

            for (var i = 0; i < count; i++)
            {
                var chunkA = chunksA[i].Value;
                var chunkB = chunksB[i].Value;
                var isDigitA = char.IsDigit(chunkA[0]);
                var isDigitB = char.IsDigit(chunkB[0]);

                var cmp = isDigitA && isDigitB
                    ? CompareNumericChunks(chunkA, chunkB)
                    : string.Compare(chunkA, chunkB, StringComparison.OrdinalIgnoreCase);

                if (cmp != 0)
                {
                    return cmp;
                }
            }

            // All shared chunks are equal - the one that ran out of
            // chunks first (fewer segments overall) sorts first, e.g.
            // "banana" (1 chunk) before "banana1" (2 chunks).
            if (chunksA.Count != chunksB.Count)
            {
                return chunksA.Count - chunksB.Count;
            }

            // Fully identical stems (e.g. differing only by extension or
            // case) - full-filename comparison as a deterministic
            // final tie-breaker.
            return string.Compare(a, b, StringComparison.OrdinalIgnoreCase);
        }

        private static int CompareNumericChunks(string a, string b)
        {
            var trimmedA = a.TrimStart('0');
            var trimmedB = b.TrimStart('0');
            if (trimmedA.Length == 0)
            {
                trimmedA = "0";
            }

            if (trimmedB.Length == 0)
            {
                trimmedB = "0";
            }

            return trimmedA.Length != trimmedB.Length
                ? trimmedA.Length - trimmedB.Length
                : string.CompareOrdinal(trimmedA, trimmedB);
        }
    }

    private static string GetContentType(string path)
    {
        // .tbn isn't its own image type, but a Kodi convention for JPEG
        // data under a .tbn extension (curriculum, central data-model
        // finding).
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            ".svg" => "image/svg+xml",
            _ => "image/jpeg" // .jpg, .jpeg, .tbn
        };
    }
}
