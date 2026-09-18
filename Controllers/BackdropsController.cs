using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Result DTO for Backdrops settings. Unlike the other five controllers,
/// NO file list here - Backdrops works with images Jellyfin itself already
/// knows about, our plugin only returns the timing/behavior settings
/// (curriculum section G).
/// </summary>
public class BackdropsSettingsResult
{
    public bool Enabled { get; set; }

    public int CycleTimeMs { get; set; } = 24000;

    public string OrderMode { get; set; } = "Sequential";

    public bool KenBurnsEnabled { get; set; }

    public int KenBurnsZoomMs { get; set; } = 10000;

    public int KenBurnsPanMs { get; set; } = 5000;
}

/// <summary>
/// One pool entry - deliberately NOT a pre-built URL. Matches Detail
/// View Backdrops' own client-side pattern exactly: the client builds
/// the actual image URL itself via window.ApiClient.getScaledImageUrl(
/// sourceId, { type: 'Backdrop', tag, maxWidth, index }) - the server's
/// job is only to say WHICH item/index/tag, never to assemble the URL.
/// </summary>
public class GenrePoolImageEntry
{
    public Guid SourceId { get; set; }

    public string Tag { get; set; } = string.Empty;

    public int Index { get; set; }
}

/// <summary>
/// Result DTO for Genre Backdrops' own pool endpoint. Unlike
/// BackdropsSettingsResult, this DOES carry a file list (Images) -
/// unlike Detail View Backdrops (one item, images already known
/// client-side), Genre Backdrops spans multiple items the client has no
/// other way to enumerate, so the server must return the resolved list
/// directly.
/// </summary>
public class GenrePoolResult
{
    public bool Enabled { get; set; }

    public string SortMode { get; set; } = "Shuffle";

    public bool MainOnly { get; set; } = true;

    public int CycleTimeMs { get; set; } = 24000;

    public bool KenBurnsEnabled { get; set; }

    public int KenBurnsZoomMs { get; set; } = 10000;

    public int KenBurnsPanMs { get; set; } = 5000;

    public List<GenrePoolImageEntry> Images { get; set; } = new();
}

/// <summary>
/// Result DTO for Studio Backdrops - single image, no rotation, so no
/// SortMode/MainOnly/CycleTimeMs exist here (see
/// BackdropsStudioKenBurnsEnabled's own doc comment in
/// PluginConfiguration.cs). HasImage lets the client know whether to
/// even attempt loading the image endpoint - a studio with no
/// landscape.jpg on disk is a normal, expected case, not an error.
/// </summary>
public class StudioSettingsResult
{
    public bool Enabled { get; set; }

    public bool HasImage { get; set; }

    /// <summary>Session 116: "Appearances" or "StudioImage" - tells the client which branch to run.</summary>
    public string SourceMode { get; set; } = "StudioImage";

    public bool KenBurnsEnabled { get; set; }

    public int KenBurnsZoomMs { get; set; } = 10000;

    public int KenBurnsPanMs { get; set; } = 5000;
}

/// <summary>
/// Result DTO for Favorites People - two mutually exclusive shapes
/// depending on SourceMode (see
/// PluginConfiguration.BackdropsFavoritesPeopleSourceMode's own doc
/// comment): WallpapersCom populates WallpaperUrls (raw hotlinked
/// URLs, reusing People Backdrops' own cache files directly - no
/// SourceId/Tag/Index concept applies to an external URL). Appearances
/// populates Images (Jellyfin's own item images, same shape as
/// GenrePoolImageEntry, since it is really just a Genre-pool-style
/// query scoped by PersonIds instead of GenreIds).
/// </summary>
public class FavoritesPeoplePoolResult
{
    public bool Enabled { get; set; }

    public string SourceMode { get; set; } = "WallpapersCom";

    /// <summary>Session 116: the Order of the active source (Appearances sort field, Folder/Wallpapers Sequential/Shuffle/Random) - the client had been reading a field that did not exist.</summary>
    public string SortMode { get; set; } = "Shuffle";

    public bool MainOnly { get; set; }

    public int CycleTimeMs { get; set; } = 24000;

    public bool KenBurnsEnabled { get; set; }

    public int KenBurnsZoomMs { get; set; } = 10000;

    public int KenBurnsPanMs { get; set; } = 5000;

    public List<string> WallpaperUrls { get; set; } = new();

    public List<GenrePoolImageEntry> Images { get; set; } = new();
}
/// different nature than the other five: no file SEARCHING, just a
/// single settings endpoint plus (CHANGED, real gap fixed per explicit
/// user correction - "sollte aber schon tied zu den sub below sein") one
/// filtering endpoint (GetAllowedIndices below). The actual override
/// happens entirely in backdrops.js (Firefox detection, the
/// enableBackdrops check, its own rotation) - this controller only
/// returns HOW the override is configured (GetSettings) and WHICH of the
/// item's own already-known backdrops are allowed to be shown
/// (GetAllowedIndices, a display gate on Jellyfin's own already-resolved
/// images, not a search of its own) - not WHETHER the override is
/// allowed to run at all (backdrops.js decides that itself, client-side,
/// see curriculum G: "two separate checks").
/// </summary>
[ApiController]
[Route("Backdrops")]
// Session 116: no class-level [AllowAnonymous] any more - it would
// override the [Authorize] the two Favorites endpoints need (a class-
// level [AllowAnonymous] wins over every method-level [Authorize], see
// PeopleBackdropsController's own comment). Every other endpoint keeps
// [AllowAnonymous] individually, exactly as before.
public class BackdropsController : ControllerBase
{
    private readonly ILogger<BackdropsController> _logger;
    private readonly ILibraryManager _libraryManager;
    private readonly IImageProcessor _imageProcessor;
    private readonly IServerApplicationPaths _appPaths;
    private readonly PeopleBackdropsController _peopleBackdropsController;
    private readonly IUserManager _userManager;

    public BackdropsController(ILogger<BackdropsController> logger, ILibraryManager libraryManager, IImageProcessor imageProcessor, IServerApplicationPaths appPaths, PeopleBackdropsController peopleBackdropsController, IUserManager userManager)
    {
        _userManager = userManager;
        _logger = logger;
        _libraryManager = libraryManager;
        _imageProcessor = imageProcessor;
        _appPaths = appPaths;
        _peopleBackdropsController = peopleBackdropsController;
    }

    /// <summary>
    /// GET /Backdrops/settings - returns the current Backdrops settings.
    /// CHANGED: now accepts an optional itemId - real gap found and
    /// fixed per explicit user request ("das wir es ja einzeln
    /// schaltbar machen wollten, movies tvshows seasons episodes
    /// videos"). Without an itemId (kept for backward compatibility - a
    /// stale/older client, or a request made before the current item is
    /// known), no per-type filtering happens, matching this endpoint's
    /// own previous, uniform-for-everyone behavior exactly.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("settings")]
    public ActionResult<BackdropsSettingsResult> GetSettings([FromQuery] Guid? itemId)
    {
        var config = Plugin.Instance!.Configuration;
        // Both the tab-level master switch AND BackdropsPlus's own,
        // independent sub-feature switch must be on - see
        // BackdropsTabEnabled's own doc comment in PluginConfiguration.cs.
        var effectivelyEnabled = config.BackdropsTabEnabled && config.BackdropsEnabled;

        var typeAllowed = true;
        var resolvedType = "unknown (no itemId)";
        if (effectivelyEnabled && itemId.HasValue)
        {
            var item = _libraryManager.GetItemById(itemId.Value);
            // Movie and Episode BOTH derive from the generic Video base
            // class in Jellyfin's own data model - checked BEFORE the
            // generic Video fallback below, or they'd incorrectly match
            // that branch instead of their own, more specific one.
            if (item is Movie)
            {
                typeAllowed = config.BackdropsShowOnMovies;
                resolvedType = "Movie";
            }
            else if (item is BoxSet)
            {
                // Real gap fixed here (explicit user report): BoxSet used
                // to have no explicit branch at all, so it fell all the
                // way through to the generic "no opinion, don't block"
                // else below - silently always on regardless of this
                // settings page, since no checkbox existed to control it.
                typeAllowed = config.BackdropsShowOnSets;
                resolvedType = "BoxSet";
            }
            else if (item is Episode)
            {
                typeAllowed = config.BackdropsShowOnEpisodes;
                resolvedType = "Episode";
            }
            else if (item is Series)
            {
                typeAllowed = config.BackdropsShowOnTvShows;
                resolvedType = "Series";
            }
            else if (item is Season)
            {
                typeAllowed = config.BackdropsShowOnSeasons;
                resolvedType = "Season";
            }
            else if (item is Video)
            {
                // Generic fallback - standalone Videos (home videos,
                // music videos, etc.) that are none of the more specific
                // types above.
                typeAllowed = config.BackdropsShowOnVideos;
                resolvedType = "Video (generic)";
            }
            else
            {
                // An item type this feature has no opinion on (e.g. a
                // Person page, which never had backdrops to begin with -
                // see this project's own curriculum on that) - don't
                // block, matches this endpoint's own previous behavior
                // of never filtering by type at all.
                resolvedType = item?.GetType().Name ?? "null (not found)";
            }
        }

        var finalEnabled = effectivelyEnabled && typeAllowed;
        _logger.LogInformation(
            "Backdrops: GetSettings - ItemId={ItemId}, ResolvedType={ResolvedType}, TabEnabled={TabEnabled}, ModEnabled={ModEnabled}, TypeAllowed={TypeAllowed}, FinalEnabled={Final}, Cycle={Cycle}, Order={Order}, KenBurns={KenBurns}",
            itemId, resolvedType, config.BackdropsTabEnabled, config.BackdropsEnabled, typeAllowed, finalEnabled, config.BackdropsCycleTimeMs, config.BackdropsOrderMode, config.BackdropsKenBurnsEnabled);

        return Ok(new BackdropsSettingsResult
        {
            Enabled = finalEnabled,
            CycleTimeMs = config.BackdropsCycleTimeMs,
            OrderMode = config.BackdropsOrderMode,
            KenBurnsEnabled = config.BackdropsKenBurnsEnabled,
            KenBurnsZoomMs = config.BackdropsKenBurnsZoomMs,
            KenBurnsPanMs = config.BackdropsKenBurnsPanMs
        });
    }

    /// <summary>
    /// GET /Backdrops/allowed-indices?sourceId=X - a real gap fix per
    /// explicit user correction: BackdropsAllowedFormats is NOT a file
    /// search (BackdropsPlus never searches for files - it reuses
    /// whichever backdrop images Jellyfin itself already resolved for
    /// the item, see this file's own class doc comment) - it's a DISPLAY
    /// gate on top of those already-known images. Given the sourceId the
    /// client already computes (the item that actually owns the
    /// backdrops - itself, or its parent when the current item has none
    /// of its own and inherits them), resolves each backdrop's own,
    /// actual on-disk file extension via Jellyfin's own ItemImageInfo.Path
    /// and returns only the INDICES (matching BackdropImageTags' own
    /// index-for-index order, which the client already relies on to
    /// build its own image URLs) whose extension is in
    /// BackdropsAllowedFormats. Deliberately does not apply to People
    /// Backdrops - those come from a Wallpapers.com URL, not a local
    /// file with a checkable extension, so there is nothing here for
    /// that feature to filter by.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("allowed-indices")]
    public ActionResult<int[]> GetAllowedIndices([FromQuery] Guid sourceId)
    {
        var config = Plugin.Instance!.Configuration;
        var extensions = (config.BackdropsAllowedFormats ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();

        var item = _libraryManager.GetItemById(sourceId);
        if (item is null)
        {
            _logger.LogInformation("Backdrops: GetAllowedIndices - sourceId {SourceId} not found", sourceId);
            return Ok(Array.Empty<int>());
        }

        var backdrops = item.GetImages(ImageType.Backdrop).ToList();
        var allowed = new System.Collections.Generic.List<int>();
        for (var i = 0; i < backdrops.Count; i++)
        {
            var ext = Path.GetExtension(backdrops[i].Path);
            var isAllowed = extensions.Length == 0 || extensions.Contains(ext, StringComparer.OrdinalIgnoreCase);
            if (isAllowed) { allowed.Add(i); }
        }

        _logger.LogInformation(
            "Backdrops: GetAllowedIndices - sourceId={SourceId}, totalBackdrops={Total}, allowedFormats=[{Formats}], allowedIndices=[{Allowed}]",
            sourceId, backdrops.Count, string.Join(", ", extensions), string.Join(", ", allowed));

        return Ok(allowed.ToArray());
    }

    /// <summary>
    /// GET /Backdrops/genre-pool?genreId=X&amp;parentId=Y (parentId
    /// optional) - the pool of image URLs for Genre Backdrops' own
    /// rotation, one image per matching item. Mirrors list.js's own
    /// resolution exactly (checked in jellyfin-web's own source, not
    /// assumed): parentId absent means the Global genre list (no
    /// library scope, IncludeItemTypes Movie+Series); parentId present
    /// means a library-scoped genre list, and that library's own
    /// CollectionType (movies/tvshows) decides which of the two
    /// remaining subs applies and which single item type is included -
    /// confirmed against moviegenres.js/tvgenres.js, both of which pass
    /// their own library's id as parentId together with a single fixed
    /// IncludeItemTypes. Any other CollectionType (Music, etc.) falls
    /// back to the Movies sub, since only Movies/TV libraries can
    /// realistically reach a Genre Backdrops-relevant page at all.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("genre-pool")]
    public ActionResult<GenrePoolResult> GetGenrePool([FromQuery] Guid genreId, [FromQuery] Guid? parentId)
    {
        var config = Plugin.Instance!.Configuration;
        var tabAndRootEnabled = config.BackdropsTabEnabled && config.BackdropsGenreEnabled;

        string subName;
        bool subEnabled;
        BaseItemKind[] includeTypes;

        if (parentId.HasValue)
        {
            var parentItem = _libraryManager.GetItemById(parentId.Value);
            if (parentItem is CollectionFolder folder && folder.CollectionType == CollectionType.tvshows)
            {
                subName = "TvShows";
                subEnabled = config.BackdropsGenreTvShowsEnabled;
                includeTypes = new[] { BaseItemKind.Series };
            }
            else
            {
                subName = "Movies";
                subEnabled = config.BackdropsGenreMoviesEnabled;
                includeTypes = new[] { BaseItemKind.Movie };
            }
        }
        else
        {
            subName = "Global";
            subEnabled = config.BackdropsGenreGlobalEnabled;
            includeTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series };
        }

        // Phase A (Session 97): Sort/Traversal are no longer read per-sub -
        // consolidated into ONE shared pair for all three subs (Global/
        // Movies/TvShows), matching the sandbox design from Session 77.
        var sortMode = config.BackdropsGenreSortMode;
        var traversalMode = config.BackdropsGenreTraversalMode;

        var finalEnabled = tabAndRootEnabled && subEnabled;
        var result = new GenrePoolResult
        {
            Enabled = finalEnabled,
            SortMode = sortMode,
            MainOnly = config.BackdropsGenreMainOnly == "Main",
            CycleTimeMs = config.BackdropsGenreCycleTimeMs,
            KenBurnsEnabled = config.BackdropsGenreKenBurnsEnabled,
            KenBurnsZoomMs = config.BackdropsGenreKenBurnsZoomMs,
            KenBurnsPanMs = config.BackdropsGenreKenBurnsPanMs
        };

        if (!finalEnabled)
        {
            _logger.LogInformation(
                "Backdrops: GetGenrePool - genreId={GenreId}, sub={Sub}, not enabled (tabAndRoot={TabAndRoot}, subEnabled={SubEnabled})",
                genreId, subName, tabAndRootEnabled, subEnabled);
            return Ok(result);
        }

        var query = new InternalItemsQuery(GetRequestUser())
        {
            GenreIds = new[] { genreId },
            IncludeItemTypes = includeTypes,
            Recursive = true
        };
        if (parentId.HasValue)
        {
            query.ParentId = parentId.Value;
        }

        var (resolvedOrderBy, resolvedOrder, resolvedStartIndex, resolvedLimit) = ResolveRotationQuery(sortMode, traversalMode, query);
        query.OrderBy = new[] { (resolvedOrderBy, resolvedOrder) };
        query.Limit = resolvedLimit;
        if (resolvedStartIndex.HasValue)
        {
            query.StartIndex = resolvedStartIndex.Value;
        }

        var extensions = (config.BackdropsAllowedFormats ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();

        var items = _libraryManager.GetItemList(query);
        var random = new Random();
        var images = new List<GenrePoolImageEntry>();
        foreach (var item in items)
        {
            // Indices must stay the ORIGINAL, unfiltered ones -
            // GetImageCacheTag below looks up by that original index,
            // not by position within the filtered subset. Bug caught
            // before shipping: an earlier version filtered first and
            // then used the filtered list's own 0-based position,
            // which silently pointed at the wrong (sometimes disallowed)
            // image whenever an earlier index was filtered out.
            var allBackdrops = item.GetImages(ImageType.Backdrop).ToList();
            var allowedIndices = new List<int>();
            for (var i = 0; i < allBackdrops.Count; i++)
            {
                if (extensions.Length == 0 || extensions.Contains(Path.GetExtension(allBackdrops[i].Path), StringComparer.OrdinalIgnoreCase))
                {
                    allowedIndices.Add(i);
                }
            }
            if (allowedIndices.Count == 0) { continue; }

            // Main = the file without a number, confirmed always added
            // FIRST by Jellyfin's own LocalImageProvider.PopulateBackdrops
            // - lands reliably at original index 0. allowedIndices[0] is
            // only equal to 0 if index 0 itself passed the format
            // filter - if it didn't, there is no allowed "Main" for this
            // item, so it correctly falls through to Random-among-
            // allowed instead of ever returning a disallowed format.
            var chosenIndex = config.BackdropsGenreMainOnly == "Main" && allowedIndices.Contains(0)
                ? 0
                : allowedIndices[random.Next(allowedIndices.Count)];
            var tag = _imageProcessor.GetImageCacheTag(item, ImageType.Backdrop, chosenIndex);
            if (tag is null) { continue; }

            images.Add(new GenrePoolImageEntry
            {
                SourceId = item.Id,
                Tag = tag,
                Index = chosenIndex
            });
        }

        result.Images = images;

        _logger.LogInformation(
            "Backdrops: GetGenrePool - genreId={GenreId}, sub={Sub}, sortMode={SortMode}, itemsFound={ItemCount}, imagesReturned={ImageCount}",
            genreId, subName, sortMode, items.Count, images.Count);

        return Ok(result);
    }

    /// <summary>
    /// GET /Backdrops/studio-pool?studioId=X[&amp;parentId=Y] - the pool
    /// for Studio Backdrops with Source=Appearances (Session 116): the
    /// backdrops of the titles the studio appears in, exactly like
    /// GetGenrePool with a StudioIds filter. Studio has only the
    /// Global/TvShows subs (see BackdropsStudioTvShowsEnabled).
    /// </summary>
    [AllowAnonymous]
    [HttpGet("studio-pool")]
    public ActionResult<GenrePoolResult> GetStudioPool([FromQuery] Guid studioId, [FromQuery] Guid? parentId)
    {
        var config = Plugin.Instance!.Configuration;
        var tabAndRootEnabled = config.BackdropsTabEnabled && config.BackdropsStudioEnabled;

        string subName;
        bool subEnabled;
        BaseItemKind[] includeTypes;
        if (parentId.HasValue && _libraryManager.GetItemById(parentId.Value) is CollectionFolder folder && folder.CollectionType == CollectionType.tvshows)
        {
            subName = "TvShows";
            subEnabled = config.BackdropsStudioTvShowsEnabled;
            includeTypes = new[] { BaseItemKind.Series };
        }
        else
        {
            subName = "Global";
            subEnabled = config.BackdropsStudioGlobalEnabled;
            includeTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series };
        }

        var sortMode = config.BackdropsStudioSortMode;
        var traversalMode = config.BackdropsStudioTraversalMode;
        var finalEnabled = tabAndRootEnabled && subEnabled && config.BackdropsStudioSourceMode == "Appearances";
        var result = new GenrePoolResult
        {
            Enabled = finalEnabled,
            SortMode = sortMode,
            MainOnly = config.BackdropsStudioMainOnly == "Main",
            CycleTimeMs = config.BackdropsStudioCycleTimeMs,
            KenBurnsEnabled = config.BackdropsStudioKenBurnsEnabled,
            KenBurnsZoomMs = config.BackdropsStudioKenBurnsZoomMs,
            KenBurnsPanMs = config.BackdropsStudioKenBurnsPanMs
        };

        if (!finalEnabled)
        {
            _logger.LogInformation(
                "Backdrops: GetStudioPool - studioId={StudioId}, sub={Sub}, not enabled (tabAndRoot={TabAndRoot}, subEnabled={SubEnabled}, source={Source})",
                studioId, subName, tabAndRootEnabled, subEnabled, config.BackdropsStudioSourceMode);
            return Ok(result);
        }

        var query = new InternalItemsQuery(GetRequestUser())
        {
            StudioIds = new[] { studioId },
            IncludeItemTypes = includeTypes,
            Recursive = true
        };
        if (parentId.HasValue)
        {
            query.ParentId = parentId.Value;
        }

        var (resolvedOrderBy, resolvedOrder, resolvedStartIndex, resolvedLimit) = ResolveRotationQuery(sortMode, traversalMode, query);
        query.OrderBy = new[] { (resolvedOrderBy, resolvedOrder) };
        query.Limit = resolvedLimit;
        if (resolvedStartIndex.HasValue)
        {
            query.StartIndex = resolvedStartIndex.Value;
        }

        var items = _libraryManager.GetItemList(query);
        result.Images = CollectPoolImages(items, config.BackdropsStudioMainOnly == "Main", config.BackdropsAllowedFormats);

        _logger.LogInformation(
            "Backdrops: GetStudioPool - studioId={StudioId}, sub={Sub}, sortMode={SortMode}, itemsFound={ItemCount}, imagesReturned={ImageCount}",
            studioId, subName, sortMode, items.Count, result.Images.Count);

        return Ok(result);
    }

    /// <summary>
    /// GET /Backdrops/tag-pool?tag=X - the pool for Tag Backdrops. Only
    /// one variant exists (see BackdropsTagMainOnly's own doc comment in
    /// PluginConfiguration.cs) - no parentId/CollectionType resolution
    /// needed like Genre, since tags are global by design and this
    /// feature deliberately never restricts item type. tag is the raw
    /// tag NAME (a string), not a Guid - confirmed against list.js's
    /// own resolution (Tags: params.tag, no separate lookup item at
    /// all), unlike Genre/Studio which resolve an actual item first.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("tag-pool")]
    public ActionResult<GenrePoolResult> GetTagPool([FromQuery] string tag)
    {
        var config = Plugin.Instance!.Configuration;
        var finalEnabled = config.BackdropsTabEnabled && config.BackdropsTagEnabled;

        var result = new GenrePoolResult
        {
            Enabled = finalEnabled,
            SortMode = config.BackdropsTagSortMode,
            MainOnly = config.BackdropsTagMainOnly == "Main",
            CycleTimeMs = config.BackdropsTagCycleTimeMs,
            KenBurnsEnabled = config.BackdropsTagKenBurnsEnabled,
            KenBurnsZoomMs = config.BackdropsTagKenBurnsZoomMs,
            KenBurnsPanMs = config.BackdropsTagKenBurnsPanMs
        };

        if (!finalEnabled || string.IsNullOrEmpty(tag))
        {
            _logger.LogInformation("Backdrops: GetTagPool - tag={Tag}, not enabled or empty tag", tag);
            return Ok(result);
        }

        var sortMode = config.BackdropsTagSortMode;
        var traversalMode = config.BackdropsTagTraversalMode;

        // Deliberately NO IncludeItemTypes restriction - "tags nimmt
        // alles was im tag ist", explicit user decision, mixing
        // movies/series/etc. by design (see this field's own doc
        // comment in PluginConfiguration.cs).
        var query = new InternalItemsQuery(GetRequestUser())
        {
            Tags = new[] { tag },
            Recursive = true
        };
        var (resolvedOrderBy, resolvedOrder, resolvedStartIndex, resolvedLimit) = ResolveRotationQuery(sortMode, traversalMode, query);
        query.OrderBy = new[] { (resolvedOrderBy, resolvedOrder) };
        query.Limit = resolvedLimit;
        if (resolvedStartIndex.HasValue)
        {
            query.StartIndex = resolvedStartIndex.Value;
        }

        var extensions = (config.BackdropsAllowedFormats ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();

        var items = _libraryManager.GetItemList(query);
        var random = new Random();
        var images = new List<GenrePoolImageEntry>();
        foreach (var item in items)
        {
            var allBackdrops = item.GetImages(ImageType.Backdrop).ToList();
            var allowedIndices = new List<int>();
            for (var i = 0; i < allBackdrops.Count; i++)
            {
                if (extensions.Length == 0 || extensions.Contains(Path.GetExtension(allBackdrops[i].Path), StringComparer.OrdinalIgnoreCase))
                {
                    allowedIndices.Add(i);
                }
            }
            if (allowedIndices.Count == 0) { continue; }

            var chosenIndex = config.BackdropsTagMainOnly == "Main" && allowedIndices.Contains(0)
                ? 0
                : allowedIndices[random.Next(allowedIndices.Count)];
            var tagValue = _imageProcessor.GetImageCacheTag(item, ImageType.Backdrop, chosenIndex);
            if (tagValue is null) { continue; }

            images.Add(new GenrePoolImageEntry { SourceId = item.Id, Tag = tagValue, Index = chosenIndex });
        }

        result.Images = images;
        _logger.LogInformation(
            "Backdrops: GetTagPool - tag={Tag}, sortMode={SortMode}, itemsFound={ItemCount}, imagesReturned={ImageCount}",
            tag, sortMode, items.Count, images.Count);

        return Ok(result);
    }


    /// <summary>
    /// Session 116: the user behind the request, from Jellyfin's own
    /// auth claim ("Jellyfin-UserId", InternalClaimTypes.UserId in
    /// Jellyfin.Api). IsFavorite is per-user data: Jellyfin only joins
    /// UserDatas when InternalItemsQuery.User is set
    /// (SqliteItemRepository.EnableJoinUserData), otherwise the
    /// IsFavorite filter is a bare "no such column" SQLite error -
    /// exactly what the Favorites endpoints threw before this fix
    /// (log: SQLite Error 1: 'no such column: IsFavorite').
    /// </summary>
    private Jellyfin.Data.Entities.User? GetRequestUser()
    {
        var claim = User?.FindFirst("Jellyfin-UserId")?.Value;
        if (string.IsNullOrEmpty(claim) || !Guid.TryParse(claim, out var userId))
        {
            return null;
        }
        return _userManager.GetUserById(userId);
    }

    /// <summary>
    /// GET /Backdrops/favorites-pool?type=X - the pool for one of the
    /// ten generic Favorites sections (everything except People, which
    /// has its own dedicated endpoint - see
    /// BackdropsFavoritesPeopleSourceMode's own doc comment). type is
    /// the raw BaseItemKind name (Movie/Series/Episode/Video/BoxSet/
    /// Playlist/MusicArtist/MusicAlbum/Audio/Book) - confirmed against
    /// list.js's own query construction (IncludeItemTypes: params.type,
    /// IsFavorite: params.IsFavorite === 'true'). MainOnly/CycleTimeMs/
    /// KenBurns are shared across all ten (and People) - only Enable
    /// and SortMode differ per section.
    /// </summary>
    [Authorize]
    [HttpGet("favorites-pool")]
    public ActionResult<GenrePoolResult> GetFavoritesPool([FromQuery] string type)
    {
        var config = Plugin.Instance!.Configuration;
        var tabAndRootEnabled = config.BackdropsTabEnabled && config.BackdropsFavoritesEnabled;

        bool subEnabled;
        string perTypeSortMode;
        string perTypeTraversalMode;
        BaseItemKind includeType;
        switch (type)
        {
            case "Movie": subEnabled = config.BackdropsFavoritesMoviesEnabled; perTypeSortMode = config.BackdropsFavoritesMoviesSortMode; perTypeTraversalMode = config.BackdropsFavoritesMoviesTraversalMode; includeType = BaseItemKind.Movie; break;
            case "Series": subEnabled = config.BackdropsFavoritesShowsEnabled; perTypeSortMode = config.BackdropsFavoritesShowsSortMode; perTypeTraversalMode = config.BackdropsFavoritesShowsTraversalMode; includeType = BaseItemKind.Series; break;
            case "Episode": subEnabled = config.BackdropsFavoritesEpisodesEnabled; perTypeSortMode = config.BackdropsFavoritesEpisodesSortMode; perTypeTraversalMode = config.BackdropsFavoritesEpisodesTraversalMode; includeType = BaseItemKind.Episode; break;
            case "Video": subEnabled = config.BackdropsFavoritesVideosEnabled; perTypeSortMode = config.BackdropsFavoritesVideosSortMode; perTypeTraversalMode = config.BackdropsFavoritesVideosTraversalMode; includeType = BaseItemKind.Video; break;
            case "BoxSet": subEnabled = config.BackdropsFavoritesCollectionsEnabled; perTypeSortMode = config.BackdropsFavoritesCollectionsSortMode; perTypeTraversalMode = config.BackdropsFavoritesCollectionsTraversalMode; includeType = BaseItemKind.BoxSet; break;
            case "Playlist": subEnabled = config.BackdropsFavoritesPlaylistsEnabled; perTypeSortMode = config.BackdropsFavoritesPlaylistsSortMode; perTypeTraversalMode = config.BackdropsFavoritesPlaylistsTraversalMode; includeType = BaseItemKind.Playlist; break;
            case "MusicArtist": subEnabled = config.BackdropsFavoritesArtistsEnabled; perTypeSortMode = config.BackdropsFavoritesArtistsSortMode; perTypeTraversalMode = config.BackdropsFavoritesArtistsTraversalMode; includeType = BaseItemKind.MusicArtist; break;
            case "MusicAlbum": subEnabled = config.BackdropsFavoritesAlbumsEnabled; perTypeSortMode = config.BackdropsFavoritesAlbumsSortMode; perTypeTraversalMode = config.BackdropsFavoritesAlbumsTraversalMode; includeType = BaseItemKind.MusicAlbum; break;
            case "Audio": subEnabled = config.BackdropsFavoritesSongsEnabled; perTypeSortMode = config.BackdropsFavoritesSongsSortMode; perTypeTraversalMode = config.BackdropsFavoritesSongsTraversalMode; includeType = BaseItemKind.Audio; break;
            case "Book": subEnabled = config.BackdropsFavoritesBooksEnabled; perTypeSortMode = config.BackdropsFavoritesBooksSortMode; perTypeTraversalMode = config.BackdropsFavoritesBooksTraversalMode; includeType = BaseItemKind.Book; break;
            default:
                _logger.LogInformation("Backdrops: GetFavoritesPool - unrecognized type {Type}", type);
                return Ok(new GenrePoolResult { Enabled = false });
        }

        // Phase C (Session 99): "General" uses ONE shared Order/Traversal
        // for every type instead of each sub's own - see
        // BackdropsFavoritesManageMode's own doc comment.
        var isGeneral = config.BackdropsFavoritesManageMode == "General";
        var sortMode = isGeneral ? config.BackdropsFavoritesGeneralSortMode : perTypeSortMode;
        var traversalMode = isGeneral ? config.BackdropsFavoritesGeneralTraversalMode : perTypeTraversalMode;

        var requestUser = GetRequestUser();
        var finalEnabled = tabAndRootEnabled && subEnabled && requestUser is not null;
        var result = new GenrePoolResult
        {
            Enabled = finalEnabled,
            SortMode = sortMode,
            MainOnly = config.BackdropsFavoritesMainOnly == "Main",
            CycleTimeMs = config.BackdropsFavoritesCycleTimeMs,
            KenBurnsEnabled = config.BackdropsFavoritesKenBurnsEnabled,
            KenBurnsZoomMs = config.BackdropsFavoritesKenBurnsZoomMs,
            KenBurnsPanMs = config.BackdropsFavoritesKenBurnsPanMs
        };

        if (!finalEnabled)
        {
            _logger.LogInformation("Backdrops: GetFavoritesPool - type={Type}, not enabled", type);
            return Ok(result);
        }

        var query = new InternalItemsQuery(requestUser)
        {
            IsFavorite = true,
            IncludeItemTypes = new[] { includeType },
            Recursive = true
        };
        var (resolvedOrderBy, resolvedOrder, resolvedStartIndex, resolvedLimit) = ResolveRotationQuery(sortMode, traversalMode, query);
        query.OrderBy = new[] { (resolvedOrderBy, resolvedOrder) };
        query.Limit = resolvedLimit;
        if (resolvedStartIndex.HasValue)
        {
            query.StartIndex = resolvedStartIndex.Value;
        }

        var extensions = (config.BackdropsAllowedFormats ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();

        var items = _libraryManager.GetItemList(query);
        var random = new Random();
        var images = new List<GenrePoolImageEntry>();
        foreach (var item in items)
        {
            var allBackdrops = item.GetImages(ImageType.Backdrop).ToList();
            var allowedIndices = new List<int>();
            for (var i = 0; i < allBackdrops.Count; i++)
            {
                if (extensions.Length == 0 || extensions.Contains(Path.GetExtension(allBackdrops[i].Path), StringComparer.OrdinalIgnoreCase))
                {
                    allowedIndices.Add(i);
                }
            }
            if (allowedIndices.Count == 0) { continue; }

            var chosenIndex = config.BackdropsFavoritesMainOnly == "Main" && allowedIndices.Contains(0)
                ? 0
                : allowedIndices[random.Next(allowedIndices.Count)];
            var tagValue = _imageProcessor.GetImageCacheTag(item, ImageType.Backdrop, chosenIndex);
            if (tagValue is null) { continue; }

            images.Add(new GenrePoolImageEntry { SourceId = item.Id, Tag = tagValue, Index = chosenIndex });
        }

        result.Images = images;
        _logger.LogInformation(
            "Backdrops: GetFavoritesPool - type={Type}, sortMode={SortMode}, itemsFound={ItemCount}, imagesReturned={ImageCount}",
            type, sortMode, items.Count, images.Count);

        return Ok(result);
    }

    /// <summary>
    /// GET /Backdrops/favorites-people-pool - the pool for the Favorites
    /// People section, the one exception among the eleven sections (see
    /// FavoritesPeoplePoolResult's own doc comment for the two mutually
    /// exclusive source shapes).
    /// </summary>
    [Authorize]
    [HttpGet("favorites-people-pool")]
    public async Task<ActionResult<FavoritesPeoplePoolResult>> GetFavoritesPeoplePool()
    {
        var config = Plugin.Instance!.Configuration;
        var requestUser = GetRequestUser();
        var finalEnabled = config.BackdropsTabEnabled && config.BackdropsFavoritesEnabled && config.BackdropsFavoritesPeopleEnabled && requestUser is not null;
        var sourceMode = config.BackdropsFavoritesPeopleSourceMode;

        var result = new FavoritesPeoplePoolResult
        {
            Enabled = finalEnabled,
            SourceMode = sourceMode,
            SortMode = sourceMode == "Appearances" ? config.BackdropsFavoritesPeopleAppearancesSortMode
                     : sourceMode == "Folder" ? config.BackdropsFavoritesPeopleFolderOrderMode
                     : config.PeopleBackdropsOrderMode,
            MainOnly = config.BackdropsFavoritesPeopleAppearancesMainOnly == "Main",
            CycleTimeMs = config.BackdropsFavoritesCycleTimeMs,
            KenBurnsEnabled = config.BackdropsFavoritesKenBurnsEnabled,
            KenBurnsZoomMs = config.BackdropsFavoritesKenBurnsZoomMs,
            KenBurnsPanMs = config.BackdropsFavoritesKenBurnsPanMs
        };

        if (!finalEnabled)
        {
            return Ok(result);
        }

        // Session 116: favourite persons are NOT reachable through an
        // items query (Person items hang under no library, Recursive=true
        // finds none - verified live: 0 results while /Persons?IsFavorite
        // returned 5). Jellyfin's own PersonsController resolves them via
        // GetPeopleItems(InternalPeopleQuery { User, IsFavorite }) - the
        // People table joined with UserData - so do we.
        var favoritePeople = _libraryManager.GetPeopleItems(new InternalPeopleQuery
        {
            User = requestUser,
            IsFavorite = true
        }).Where(person => person is not null).ToList();

        if (favoritePeople.Count == 0)
        {
            _logger.LogInformation("Backdrops: GetFavoritesPeoplePool - no favorited people");
            return Ok(result);
        }

        if (sourceMode == "Appearances")
        {
            var personIds = favoritePeople.Select(p => p.Id).ToArray();
            var extensions = (config.BackdropsAllowedFormats ?? string.Empty)
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(f => "." + f.ToLowerInvariant())
                .Distinct()
                .ToArray();

            // Phase F (Session 103): same filter concept as
            // PeopleBackdropsAppearancesFilter (standalone People
            // Backdrops) - restricts the appearances query to movies-
            // only/shows-only/both, ported here so Favorites' People
            // sub has the same choice.
            var includeTypes = config.BackdropsFavoritesPeopleAppearancesFilter switch
            {
                "Movies" => new[] { BaseItemKind.Movie },
                "Series" => new[] { BaseItemKind.Series },
                _ => new[] { BaseItemKind.Movie, BaseItemKind.Series }
            };

            // Session 116: own Order/Traversal (mirrors the standalone People
            // Appearances block), the request user on the query, pool cap.
            var appearancesQuery = new InternalItemsQuery(requestUser)
            {
                PersonIds = personIds,
                IncludeItemTypes = includeTypes,
                Recursive = true
            };
            var (apOrderBy, apOrder, apStart, apLimit) = ResolveRotationQuery(config.BackdropsFavoritesPeopleAppearancesSortMode, config.BackdropsFavoritesPeopleAppearancesTraversalMode, appearancesQuery);
            appearancesQuery.OrderBy = new[] { (apOrderBy, apOrder) };
            appearancesQuery.Limit = apLimit;
            if (apStart.HasValue) { appearancesQuery.StartIndex = apStart.Value; }
            var items = _libraryManager.GetItemList(appearancesQuery);

            var random = new Random();
            var images = new List<GenrePoolImageEntry>();
            foreach (var item in items)
            {
                var allBackdrops = item.GetImages(ImageType.Backdrop).ToList();
                var allowedIndices = new List<int>();
                for (var i = 0; i < allBackdrops.Count; i++)
                {
                    if (extensions.Length == 0 || extensions.Contains(Path.GetExtension(allBackdrops[i].Path), StringComparer.OrdinalIgnoreCase))
                    {
                        allowedIndices.Add(i);
                    }
                }
                if (allowedIndices.Count == 0) { continue; }

                var chosenIndex = config.BackdropsFavoritesPeopleAppearancesMainOnly == "Main" && allowedIndices.Contains(0)
                    ? 0
                    : allowedIndices[random.Next(allowedIndices.Count)];
                var tagValue = _imageProcessor.GetImageCacheTag(item, ImageType.Backdrop, chosenIndex);
                if (tagValue is null) { continue; }

                images.Add(new GenrePoolImageEntry { SourceId = item.Id, Tag = tagValue, Index = chosenIndex });
            }

            result.Images = images;
            _logger.LogInformation(
                "Backdrops: GetFavoritesPeoplePool - Appearances, favoritePeople={PeopleCount}, itemsFound={ItemCount}, imagesReturned={ImageCount}",
                favoritePeople.Count, items.Count, images.Count);
            return Ok(result);
        }

        // WallpapersCom - reuses People Backdrops' own cache files
        // directly (ReadOrPopulateCacheFileAsync/GetCacheFilePath,
        // widened to internal specifically for this reuse - see their
        // own remarks in PeopleBackdropsController.cs). Two buckets,
        // both randomly sampled (explicit user decision - "damit es
        // heterogen bleibt... reines Zufallsziehen bei beiden Stufen
        // reicht"): already-cached people are read straight off disk
        // (cheap, no request), NOT-yet-cached people are hard-capped so
        // even libraries with hundreds of favorited people never risk
        // the shared Wallpapers.com rate limit (documented on
        // PeopleBackdropsApiKey's own field: ~30/min without a key,
        // ~60/min with a free one).
        if (sourceMode == "Folder")
        {
            // Session 116: Folder source for the favourite-people pool -
            // every favourite person's own backdrop.ext / backdropN.ext
            // (same resolver and image endpoint as the standalone People
            // Folder source; the endpoint gets our own Single/Multiple
            // mode so the indices match). Order: Sequential keeps person
            // order with each person's files in native order, Shuffle/
            // Random are applied by the client's engine over all files.
            var folderMode = config.BackdropsFavoritesPeopleFolderBackdropFiles;
            var folderUrls = new List<string>();
            foreach (var person in favoritePeople)
            {
                var personFolder = PeopleBackdropsController.GetPersonFolder(person);
                var paths = PeopleBackdropsController.ResolveFolderBackdropPaths(personFolder, folderMode, config.BackdropsAllowedFormats);
                for (var i = 0; i < paths.Count; i++)
                {
                    folderUrls.Add("/PeopleBackdrops/" + person.Id + "/folder-image?index=" + i + "&mode=" + folderMode);
                }
            }
            result.WallpaperUrls = folderUrls;
            _logger.LogInformation(
                "Backdrops: GetFavoritesPeoplePool - Folder, favoritePeople={PeopleCount}, mode={Mode}, imagesReturned={ImageCount}",
                favoritePeople.Count, folderMode, folderUrls.Count);
            return Ok(result);
        }

        const int MaxCachedSample = 25;
        const int MaxNewFetchesPerVisit = 5;

        var shuffledPeople = favoritePeople.OrderBy(_ => Guid.NewGuid()).ToList();
        var cachedUrls = new List<string>();
        var uncachedPeople = new List<Person>();
        foreach (var person in shuffledPeople)
        {
            var jsonPath = PeopleBackdropsController.GetCacheFilePath(person);
            if (System.IO.File.Exists(jsonPath))
            {
                try
                {
                    var parsed = JsonSerializer.Deserialize<PeopleBackdropsCacheFile>(System.IO.File.ReadAllText(jsonPath));
                    if (parsed?.Images?.Count > 0)
                    {
                        cachedUrls.AddRange(parsed.Images.Select(i => i.Url));
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Backdrops: GetFavoritesPeoplePool - failed to read cache for {PersonName}", person.Name);
                }
            }
            else
            {
                uncachedPeople.Add(person);
            }

            if (cachedUrls.Count >= MaxCachedSample && uncachedPeople.Count >= MaxNewFetchesPerVisit) { break; }
        }

        var newlyFetchedUrls = new List<string>();
        foreach (var person in uncachedPeople.Take(MaxNewFetchesPerVisit))
        {
            try
            {
                var (file, _) = await _peopleBackdropsController.ReadOrPopulateCacheFileAsync(person, config, _ => Task.CompletedTask);
                if (file?.Images?.Count > 0)
                {
                    newlyFetchedUrls.AddRange(file.Images.Select(i => i.Url));
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Backdrops: GetFavoritesPeoplePool - failed to populate cache for {PersonName}", person.Name);
            }
        }

        var allUrls = cachedUrls.Concat(newlyFetchedUrls).OrderBy(_ => Guid.NewGuid()).ToList();
        result.WallpaperUrls = allUrls;

        _logger.LogInformation(
            "Backdrops: GetFavoritesPeoplePool - WallpapersCom, favoritePeople={PeopleCount}, cachedSampled={CachedSampled}, newlyFetched={NewCount}, totalUrls={UrlCount}",
            favoritePeople.Count, cachedUrls.Count, uncachedPeople.Take(MaxNewFetchesPerVisit).Count(), allUrls.Count);

        return Ok(result);
    }

    /// <summary>
    /// GET /Backdrops/studio-settings?studioId=X&amp;parentId=Y
    /// (parentId optional) - settings only, no file list (unlike
    /// GetGenrePool) since there is at most one image per studio. Same
    /// parentId/CollectionType resolution as GetGenrePool, but only two
    /// outcomes exist for Studio (Global/TvShows - no Movies sub, see
    /// BackdropsStudioTvShowsEnabled's own doc comment for why).
    /// </summary>
    [AllowAnonymous]
    [HttpGet("studio-settings")]
    public ActionResult<StudioSettingsResult> GetStudioSettings([FromQuery] Guid studioId, [FromQuery] Guid? parentId)
    {
        var config = Plugin.Instance!.Configuration;
        var tabAndRootEnabled = config.BackdropsTabEnabled && config.BackdropsStudioEnabled;

        bool subEnabled;
        if (parentId.HasValue)
        {
            var parentItem = _libraryManager.GetItemById(parentId.Value);
            subEnabled = parentItem is CollectionFolder folder && folder.CollectionType == CollectionType.tvshows
                ? config.BackdropsStudioTvShowsEnabled
                : config.BackdropsStudioGlobalEnabled;
        }
        else
        {
            subEnabled = config.BackdropsStudioGlobalEnabled;
        }

        var finalEnabled = tabAndRootEnabled && subEnabled;
        var studioItem = _libraryManager.GetItemById(studioId);
        var hasImage = finalEnabled && config.BackdropsStudioSourceMode != "Appearances"
            && studioItem is not null && ResolveStudioImagePath(studioItem.Name) is not null;

        _logger.LogInformation(
            "Backdrops: GetStudioSettings - studioId={StudioId}, enabled={Enabled}, hasImage={HasImage}",
            studioId, finalEnabled, hasImage);

        return Ok(new StudioSettingsResult
        {
            Enabled = finalEnabled,
            HasImage = hasImage,
            SourceMode = config.BackdropsStudioSourceMode == "Appearances" ? "Appearances" : "StudioImage",
            KenBurnsEnabled = config.BackdropsStudioKenBurnsEnabled,
            KenBurnsZoomMs = config.BackdropsStudioKenBurnsZoomMs,
            KenBurnsPanMs = config.BackdropsStudioKenBurnsPanMs
        });
    }

    /// <summary>
    /// Resolves metadata\Studio\&lt;exact studio name&gt;\landscape.jpg
    /// (or .png) - path structure and file name confirmed directly
    /// against a real library's own Studio folder (424 folders
    /// checked), not assumed. IServerApplicationPaths.StudioPath is
    /// Jellyfin's own already-correct path
    /// (ServerApplicationPaths.cs: Path.Combine(InternalMetadataPath,
    /// "Studio")) - reused rather than reconstructed by hand.
    /// </summary>
    /// <summary>
    /// Session 116: the per-item backdrop pick shared by every pool
    /// endpoint (Genre/Tag/Favorites/Studio). Indices stay the ORIGINAL,
    /// unfiltered ones - GetImageCacheTag looks up by that index (bug
    /// caught before shipping in Session 63). Main = original index 0,
    /// only if it passed the format filter; otherwise random among the
    /// allowed indices.
    /// </summary>
    private List<GenrePoolImageEntry> CollectPoolImages(IReadOnlyList<BaseItem> items, bool mainOnly, string? allowedFormatsCsv)
    {
        var extensions = (allowedFormatsCsv ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();
        var random = new Random();
        var images = new List<GenrePoolImageEntry>();
        foreach (var item in items)
        {
            var allBackdrops = item.GetImages(ImageType.Backdrop).ToList();
            var allowedIndices = new List<int>();
            for (var i = 0; i < allBackdrops.Count; i++)
            {
                if (extensions.Length == 0 || extensions.Contains(Path.GetExtension(allBackdrops[i].Path), StringComparer.OrdinalIgnoreCase))
                {
                    allowedIndices.Add(i);
                }
            }
            if (allowedIndices.Count == 0) { continue; }

            var chosenIndex = mainOnly && allowedIndices.Contains(0)
                ? 0
                : allowedIndices[random.Next(allowedIndices.Count)];
            var tag = _imageProcessor.GetImageCacheTag(item, ImageType.Backdrop, chosenIndex);
            if (tag is null) { continue; }

            images.Add(new GenrePoolImageEntry { SourceId = item.Id, Tag = tag, Index = chosenIndex });
        }
        return images;
    }

    /// <summary>
    /// Shared by GetGenrePool/GetTagPool/GetFavoritesPool - resolves
    /// SortMode+TraversalMode into the actual OrderBy/Order/StartIndex/
    /// Limit to apply. Follow-up to F-2024-01 (explicit user decision):
    /// real sort fields previously had no Limit at all, unlike Shuffle/
    /// Random - now every mode is capped at the same 100-item pool (see
    /// GetGenrePool's own earlier doc comment for the N=100 derivation),
    /// just reached differently:
    /// - Shuffle/Random: ORDER BY RANDOM() LIMIT 100, no StartIndex.
    /// - BeginAscending/BeginDescending: real field, StartIndex 0,
    ///   Limit 100 - same items every visit (the field's own natural
    ///   "first/last 100"), just no longer unbounded.
    /// - RandomStartAscending/RandomStartDescending: real field, but a
    ///   fresh random StartIndex each visit so the whole category
    ///   becomes reachable over many visits, not just the same 100 at
    ///   the start/end. Needs the total count first - baseQuery must
    ///   carry only the filter fields (GenreIds/Tags/IsFavorite/
    ///   IncludeItemTypes/ParentId), no OrderBy/Limit/StartIndex yet -
    ///   GetCount ignores those anyway, but keeping baseQuery clean
    ///   avoids relying on that.
    /// </summary>
    private static readonly HashSet<ItemSortBy> UserDataSorts = new()
    {
        ItemSortBy.PlayCount, ItemSortBy.DatePlayed, ItemSortBy.SeriesDatePlayed,
        ItemSortBy.IsPlayed, ItemSortBy.IsUnplayed, ItemSortBy.IsFavoriteOrLiked
    };

    private (ItemSortBy OrderBy, SortOrder Order, int? StartIndex, int Limit) ResolveRotationQuery(string sortMode, string traversalMode, InternalItemsQuery baseQuery)
    {
        const int PoolLimit = 100;

        if (sortMode == "Shuffle" || sortMode == "Random")
        {
            return (ItemSortBy.Random, SortOrder.Ascending, null, PoolLimit);
        }

        var orderBy = ItemSortBy.SortName;
        if (Enum.TryParse<ItemSortBy>(sortMode, out var parsedSort))
        {
            orderBy = parsedSort;
        }
        // Session 116: PlayCount/DatePlayed/IsPlayed/IsUnplayed/
        // IsFavoriteOrLiked sort on UserDatas columns, which Jellyfin
        // only joins when the query carries a user
        // (SqliteItemRepository.EnableJoinUserData). Without one the
        // query dies with "no such column" - fall back to SortName
        // instead of failing the whole pool.
        if (baseQuery.User is null && UserDataSorts.Contains(orderBy))
        {
            _logger.LogInformation("Backdrops: sort {Sort} needs a user, request is anonymous - using SortName", sortMode);
            orderBy = ItemSortBy.SortName;
        }

        var order = (traversalMode == "BeginDescending" || traversalMode == "RandomStartDescending")
            ? SortOrder.Descending
            : SortOrder.Ascending;

        int? startIndex = null;
        if (traversalMode == "RandomStartAscending" || traversalMode == "RandomStartDescending")
        {
            var total = _libraryManager.GetCount(baseQuery);
            var maxStart = Math.Max(0, total - PoolLimit);
            startIndex = maxStart > 0 ? new Random().Next(0, maxStart + 1) : 0;
        }

        return (orderBy, order, startIndex, PoolLimit);
    }

    private string? ResolveStudioImagePath(string studioName)
    {
        foreach (var ext in new[] { ".jpg", ".png" })
        {
            var candidate = Path.Combine(_appPaths.StudioPath, studioName, "landscape" + ext);
            if (System.IO.File.Exists(candidate)) { return candidate; }
        }
        return null;
    }

    /// <summary>
    /// GET /Backdrops/studio-image?studioId=X - serves the resolved
    /// landscape.jpg/png directly, same ETag/CacheControl pattern as
    /// CustomPosterController's own GetPosterImage (local file serving
    /// convention, replicated rather than reinvented).
    /// </summary>
    [AllowAnonymous]
    [HttpGet("studio-image")]
    public ActionResult GetStudioImage([FromQuery] Guid studioId)
    {
        var studioItem = _libraryManager.GetItemById(studioId);
        if (studioItem is null)
        {
            return NotFound();
        }

        var fullPath = ResolveStudioImagePath(studioItem.Name);
        if (fullPath is null)
        {
            return NotFound();
        }

        var contentType = Path.GetExtension(fullPath).Equals(".png", StringComparison.OrdinalIgnoreCase) ? "image/png" : "image/jpeg";
        var fileInfo = new FileInfo(fullPath);
        var imageEtag = "\"" + fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";
        Response.Headers.ETag = imageEtag;
        Response.Headers.CacheControl = "public, max-age=86400";
        var ifNoneMatch = Request.Headers.IfNoneMatch.ToString();
        if (!string.IsNullOrEmpty(ifNoneMatch) && ifNoneMatch == imageEtag)
        {
            return StatusCode(StatusCodes.Status304NotModified);
        }

        var stream = System.IO.File.OpenRead(fullPath);
        return File(stream, contentType);
    }

    /// <summary>
    /// GET /Backdrops/script.js - serves backdrops.js, analogous to the
    /// other controllers.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("script.js")]
    public ActionResult GetScript()
    {
        try
        {
            var scriptPath = Path.Combine(Plugin.Instance!.DataFolderPath, "Jellyfin-ArtworkPlus-Backdrops-v1.js");
            if (!System.IO.File.Exists(scriptPath))
            {
                _logger.LogWarning("Backdrops: GetScript 404 - backdrops.js not found at \"{Path}\"", scriptPath);
                return NotFound();
            }

            var stream = System.IO.File.OpenRead(scriptPath);
            return File(stream, "application/javascript");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Backdrops: Unexpected error in GetScript");
            return NotFound();
        }
    }
}
