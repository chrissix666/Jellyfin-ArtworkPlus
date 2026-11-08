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
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Result DTO for the Backdrops settings. Backdrops works with images Jellyfin already knows, so the server returns
/// the settings and the resolved image list, not a file search of its own.
/// </summary>
public class BackdropsSettingsResult
{
    public bool Enabled { get; set; }

    public int CycleTimeMs { get; set; } = 24000;

    public string OrderMode { get; set; } = "Sequential";

    public bool KenBurnsEnabled { get; set; }

    public int KenBurnsZoomMs { get; set; } = 10000;

    public int KenBurnsPanMs { get; set; } = 5000;

    /// <summary>
    /// The ready-made image URLs for this item, resolved on the server: own episode files first (if enabled), then
    /// the item's backdrops, then the first ancestor with backdrops (season, show), each from the configured
    /// Listener (Native = Jellyfin's database, Custom = the plugin's own file resolution). Empty = nothing to show,
    /// the native display stays untouched.
    /// </summary>
    public List<string> Images { get; set; } = new();

    /// <summary>"Episode" (own episode files, EpisodeOrderMode applies), "Item", "Parent" or "" - for the log and the client's order choice.</summary>
    public string ImageSource { get; set; } = string.Empty;

    /// <summary>Order for the episode file list (Sequential/Shuffle/Random); the normal OrderMode applies to everything else.</summary>
    public string EpisodeOrderMode { get; set; } = "Shuffle";

    /// <summary>True for Set override lists: the client preloads only the next image (a set list can hold up to 100).</summary>
    public bool PreloadNextOnly { get; set; }
}

/// <summary>
/// One pool entry, deliberately not a built URL: like Detail View Backdrops, the client builds the image URL itself
/// via ApiClient.getScaledImageUrl(sourceId, { type: 'Backdrop', tag, maxWidth, index }); the server only says
/// which item, index and tag.
/// </summary>
public class GenrePoolImageEntry
{
    public Guid SourceId { get; set; }

    public string Tag { get; set; } = string.Empty;

    public int Index { get; set; }

    /// <summary>Set for Listener=Custom: a ready-made /Backdrops/custom-image URL the client uses instead of building an /Items image URL from SourceId/Tag/Index.</summary>
    public string? Url { get; set; }
}

/// <summary>
/// Result DTO for the Genre Backdrops pool endpoint. It carries the image list itself: the pool spans many items
/// the client has no other way to enumerate.
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

    /// <summary>
    /// Favorites with Resource folder and Section names "As shown": the client asks again with the page title it
    /// read. Only then does the client wait for the title, so every other setup gets its first image without delay.
    /// </summary>
    public bool NeedsTitle { get; set; }
}

/// <summary>
/// Result DTO for Studio Backdrops: a single image, no rotation, so there is no SortMode/MainOnly/CycleTimeMs.
/// HasImage tells the client whether to load the image endpoint at all; a studio without landscape.jpg is a normal
/// case, not an error.
/// </summary>
public class StudioSettingsResult
{
    public bool Enabled { get; set; }

    public bool HasImage { get; set; }

    /// <summary>"Appearances" or "StudioImage": tells the client which branch to run.</summary>
    public string SourceMode { get; set; } = "StudioImage";

    public bool KenBurnsEnabled { get; set; }

    public int KenBurnsZoomMs { get; set; } = 10000;

    public int KenBurnsPanMs { get; set; } = 5000;
}

/// <summary>
/// Result DTO for Favorites People, two exclusive shapes by SourceMode: WallpapersCom fills WallpaperUrls (external
/// URLs from People Backdrops' cache files, no SourceId/Tag/Index), Appearances fills Images (Jellyfin's item
/// images, a Genre-pool-style query scoped by PersonIds instead of GenreIds).
/// </summary>
public class FavoritesPeoplePoolResult
{
    public bool Enabled { get; set; }

    public string SourceMode { get; set; } = "WallpapersCom";

    /// <summary>The Order of the active source (Appearances sort field, Folder/Wallpapers Sequential/Shuffle/Random).</summary>
    public string SortMode { get; set; } = "Shuffle";

    public bool MainOnly { get; set; }

    public int CycleTimeMs { get; set; } = 24000;

    public bool KenBurnsEnabled { get; set; }

    public int KenBurnsZoomMs { get; set; } = 10000;

    public int KenBurnsPanMs { get; set; } = 5000;

    public List<string> WallpaperUrls { get; set; } = new();

    public List<GenrePoolImageEntry> Images { get; set; } = new();
}

/// <summary>
/// Backdrops: no file search, but settings endpoints and pool endpoints for the categories. The override itself
/// runs in Backdrops-v1.js (page detection, claim on the transition bus, its own rotation). GetSettings says how it
/// is configured and returns the resolved images; GetAllowedIndices is a display gate on Jellyfin's own resolved
/// backdrops. Whether the override runs on a page at all is decided by the client.
/// </summary>
[ApiController]
[Route("Backdrops")]
// No class-level [AllowAnonymous]: it would override the [Authorize] the Favorites endpoints need (a class-level
// [AllowAnonymous] wins over every method-level [Authorize]). Every other endpoint carries [AllowAnonymous] itself.
public class BackdropsController : ControllerBase
{
    private readonly ILogger<BackdropsController> _logger;
    private readonly ILibraryManager _libraryManager;
    private readonly IImageProcessor _imageProcessor;
    private readonly IServerApplicationPaths _appPaths;
    private readonly PeopleBackdropsController _peopleBackdropsController;
    private readonly IUserManager _userManager;
    private readonly ILocalizationManager _localization;
    private readonly IMemoryCache _cache;

    /// <summary>
    /// A list-page pool (Genre/Tag/Favorites: ORDER BY RANDOM over the whole category + 100 candidates with image
    /// cache tags) costs about a second of server time per visit. The finished list is kept for this window per
    /// category key + user + config identity (Jellyfin replaces the config object on every save, so a saved change
    /// is seen at once). Within the window a return to the same page gets the same 100 images (the client still
    /// shuffles their order).
    /// </summary>
    private static readonly TimeSpan PoolCacheWindow = TimeSpan.FromSeconds(30);

    public BackdropsController(ILogger<BackdropsController> logger, ILibraryManager libraryManager, IImageProcessor imageProcessor, IServerApplicationPaths appPaths, PeopleBackdropsController peopleBackdropsController, IUserManager userManager, ILocalizationManager localization, IMemoryCache cache)
    {
        _userManager = userManager;
        _localization = localization;
        _cache = cache;
        _logger = logger;
        _libraryManager = libraryManager;
        _imageProcessor = imageProcessor;
        _appPaths = appPaths;
        _peopleBackdropsController = peopleBackdropsController;
    }

    /// <summary>
    /// GET /Backdrops/settings: the current Backdrops settings for an item. Without an itemId (a request made
    /// before the current item is known) no per-type filtering happens.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("settings")]
    public ActionResult<BackdropsSettingsResult> GetSettings([FromQuery] Guid? itemId, [FromQuery] Guid? first)
    {
        var config = Plugin.Instance!.Configuration;
        // Both the tab-level master switch and the feature's own switch must be on.
        var effectivelyEnabled = config.BackdropsTabEnabled && config.BackdropsEnabled;

        var typeAllowed = true;
        var resolvedType = "unknown (no itemId)";
        if (effectivelyEnabled && itemId.HasValue)
        {
            var item = _libraryManager.GetItemById(itemId.Value);
            // A Playnite Bridge game has no database entry (item null): its own type, checked first; every other
            // null stays the "not found, don't block" case below.
            if (item is null && Helpers.PlayniteBridgeLink.IsGame(itemId.Value))
            {
                typeAllowed = config.BackdropsShowOnGames && Helpers.PlayniteBridgeLink.DrawsGames;
                resolvedType = "Game";
            }
            // Game collections: a virtual folder of Playnite Bridge, under the same Settings From rule as its games.
            else if (item is null && Helpers.PlayniteBridgeLink.IsCollection(itemId.Value))
            {
                typeAllowed = config.BackdropsShowOnGameCollections && Helpers.PlayniteBridgeLink.DrawsGames;
                resolvedType = "GameCollection";
            }
            // Movie and Episode both derive from Video, so they are checked before the generic Video branch below.
            else if (item is Movie)
            {
                typeAllowed = config.BackdropsShowOnMovies;
                resolvedType = "Movie";
            }
            else if (item is BoxSet)
            {
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
                // Generic fallback: standalone videos (home videos, music videos, ...) of none of the types above.
                typeAllowed = config.BackdropsShowOnVideos;
                resolvedType = "Video (generic)";
            }
            else
            {
                // A type this feature has no opinion on (e.g. a Person page, which has no backdrops): don't block.
                resolvedType = item?.GetType().Name ?? "null (not found)";
            }
        }

        var finalEnabled = effectivelyEnabled && typeAllowed;

        // The settings that apply to this item's type: Manage General -> the shared rows; Individual -> the
        // type's Settings (General / Own / TvShows chain). The client gets finished values.
        var effective = EffectiveDetailSettings(config, DetailSubOf(resolvedType));

        // The image list is resolved here (episode files, then item, then ancestors, per Listener): the item DTO's
        // BackdropImageTags/ParentBackdropImageTags know neither episode files nor the Custom listener.
        var images = new List<string>();
        var imageSource = string.Empty;
        var orderMode = effective.OrderMode;
        var preloadNextOnly = false;
        if (finalEnabled && itemId.HasValue)
        {
            var item = _libraryManager.GetItemById(itemId.Value);
            if (item is BoxSet boxSet && config.BackdropsSetOverrideEnabled)
            {
                // Set backdrops override: the server builds the finished order once per visit; Mixed is one flat
                // list the client shuffles. The set's members are filtered by the requesting user (parental
                // control); without a user only the set's own images are used.
                images = BuildSetOverrideImages(boxSet, config, GetRequestUser());
                imageSource = "Set";
                orderMode = config.BackdropsSetSourceMode == "Mixed" ? "Shuffle" : "Sequential";
                preloadNextOnly = true;
            }
            else if (item is null && resolvedType == "GameCollection")
            {
                images = BuildGameCollectionImages(itemId.Value, config, GetRequestUser());
                imageSource = "GameCollection";
                orderMode = config.BackdropsGameCollectionSource == "Mixed" ? "Shuffle" : "Sequential";
                preloadNextOnly = true;
            }
            else if (item is null && resolvedType == "Game")
            {
                // Version change: the version whose backdrops are shown, null = none.
                var sourceId = Helpers.PlayniteBridgeLink.VersionImageId(itemId.Value, first, "Backdrop");
                (images, imageSource) = sourceId is null ? (new List<string>(), string.Empty) : ResolveGameImages(sourceId.Value, config);
                if (effective.OrderMode == "Sequential" && effective.RandomStart) { images = Helpers.RandomStart.Rotate(images); }
            }
            else if (item is not null)
            {
                (images, imageSource) = ResolveDetailViewImages(item, config);
                // Random start position: Sequential only; episode files have their own Order + box.
                var detailRandomStart = imageSource == "Episode"
                    ? config.BackdropsEpisodeOrderMode == "Sequential" && config.BackdropsEpisodeRandomStart
                    : effective.OrderMode == "Sequential" && effective.RandomStart;
                if (detailRandomStart) { images = Helpers.RandomStart.Rotate(images); }
            }
        }

        _logger.LogInformation(
            "Backdrops: GetSettings - ItemId={ItemId}, ResolvedType={ResolvedType}, TabEnabled={TabEnabled}, ModEnabled={ModEnabled}, TypeAllowed={TypeAllowed}, FinalEnabled={Final}, Listener={Listener}, Source={Source}, Images={Images}, Cycle={Cycle}, Order={Order}, KenBurns={KenBurns}, Manage={Manage}",
            itemId, resolvedType, config.BackdropsTabEnabled, config.BackdropsEnabled, typeAllowed, finalEnabled, config.BackdropsListener, imageSource, images.Count, effective.CycleTimeMs, orderMode, effective.KenBurnsEnabled, config.BackdropsManageMode);

        return Ok(new BackdropsSettingsResult
        {
            Enabled = finalEnabled,
            CycleTimeMs = effective.CycleTimeMs,
            OrderMode = orderMode,
            KenBurnsEnabled = effective.KenBurnsEnabled,
            KenBurnsZoomMs = effective.KenBurnsZoomMs,
            KenBurnsPanMs = effective.KenBurnsPanMs,
            Images = images,
            ImageSource = imageSource,
            EpisodeOrderMode = config.BackdropsEpisodeOrderMode,
            PreloadNextOnly = preloadNextOnly
        });
    }

    /// <summary>The effective Detail View settings of one type.</summary>
    internal sealed record DetailSettings(int CycleTimeMs, string OrderMode, bool RandomStart, bool KenBurnsEnabled, int KenBurnsZoomMs, int KenBurnsPanMs);

    /// <summary>The Detail View sub-section of a resolved type ("Movie" -> "Movies" ...); null = no sub (the shared rows apply).</summary>
    internal static string? DetailSubOf(string resolvedType) => resolvedType switch
    {
        "Movie" => "Movies",
        "BoxSet" => "Sets",
        "Series" => "TvShows",
        "Season" => "Seasons",
        "Episode" => "Episodes",
        "Video (generic)" => "Videos",
        "Game" => "Games",
        "GameCollection" => "GameCollections",
        _ => null
    };

    /// <summary>
    /// Manage General -> the shared rows. Individual -> the type's Settings: "Own" = its own six rows; "TvShows"
    /// (Seasons, Episodes) = the TV shows type's effective settings, General when TV shows is not Own or when Show on
    /// TV shows is off (series pages are vanilla then, nothing to follow); anything else = the shared rows.
    /// </summary>
    internal static DetailSettings EffectiveDetailSettings(PluginConfiguration c, string? sub)
    {
        var general = new DetailSettings(c.BackdropsCycleTimeMs, c.BackdropsOrderMode, c.BackdropsRandomStart, c.BackdropsKenBurnsEnabled, c.BackdropsKenBurnsZoomMs, c.BackdropsKenBurnsPanMs);
        if (c.BackdropsManageMode != "Individual" || sub is null) { return general; }
        var (settings, own) = DetailSub(c, sub);
        if (settings == "Own") { return own; }
        if (settings == "TvShows" && (sub == "Seasons" || sub == "Episodes") && c.BackdropsShowOnTvShows)
        {
            var (tvSettings, tvOwn) = DetailSub(c, "TvShows");
            return tvSettings == "Own" ? tvOwn : general;
        }

        return general;
    }

    private static (string Settings, DetailSettings Own) DetailSub(PluginConfiguration c, string sub) => sub switch
    {
        "Movies" => (c.BackdropsDetailMoviesSettings, new DetailSettings(c.BackdropsDetailMoviesCycleTimeMs, c.BackdropsDetailMoviesOrderMode, c.BackdropsDetailMoviesRandomStart, c.BackdropsDetailMoviesKenBurnsEnabled, c.BackdropsDetailMoviesKenBurnsZoomMs, c.BackdropsDetailMoviesKenBurnsPanMs)),
        "Sets" => (c.BackdropsDetailSetsSettings, new DetailSettings(c.BackdropsDetailSetsCycleTimeMs, c.BackdropsDetailSetsOrderMode, c.BackdropsDetailSetsRandomStart, c.BackdropsDetailSetsKenBurnsEnabled, c.BackdropsDetailSetsKenBurnsZoomMs, c.BackdropsDetailSetsKenBurnsPanMs)),
        "TvShows" => (c.BackdropsDetailTvShowsSettings, new DetailSettings(c.BackdropsDetailTvShowsCycleTimeMs, c.BackdropsDetailTvShowsOrderMode, c.BackdropsDetailTvShowsRandomStart, c.BackdropsDetailTvShowsKenBurnsEnabled, c.BackdropsDetailTvShowsKenBurnsZoomMs, c.BackdropsDetailTvShowsKenBurnsPanMs)),
        "Seasons" => (c.BackdropsDetailSeasonsSettings, new DetailSettings(c.BackdropsDetailSeasonsCycleTimeMs, c.BackdropsDetailSeasonsOrderMode, c.BackdropsDetailSeasonsRandomStart, c.BackdropsDetailSeasonsKenBurnsEnabled, c.BackdropsDetailSeasonsKenBurnsZoomMs, c.BackdropsDetailSeasonsKenBurnsPanMs)),
        "Games" => (c.BackdropsDetailGamesSettings, new DetailSettings(c.BackdropsDetailGamesCycleTimeMs, c.BackdropsDetailGamesOrderMode, c.BackdropsDetailGamesRandomStart, c.BackdropsDetailGamesKenBurnsEnabled, c.BackdropsDetailGamesKenBurnsZoomMs, c.BackdropsDetailGamesKenBurnsPanMs)),
        // No Order rows: the server builds the finished list of a collection (BuildGameCollectionImages).
        "GameCollections" => (c.BackdropsDetailGameCollectionsSettings, new DetailSettings(c.BackdropsDetailGameCollectionsCycleTimeMs, "Sequential", false, c.BackdropsDetailGameCollectionsKenBurnsEnabled, c.BackdropsDetailGameCollectionsKenBurnsZoomMs, c.BackdropsDetailGameCollectionsKenBurnsPanMs)),
        "Episodes" => (c.BackdropsDetailEpisodesSettings, new DetailSettings(c.BackdropsDetailEpisodesCycleTimeMs, c.BackdropsDetailEpisodesOrderMode, c.BackdropsDetailEpisodesRandomStart, c.BackdropsDetailEpisodesKenBurnsEnabled, c.BackdropsDetailEpisodesKenBurnsZoomMs, c.BackdropsDetailEpisodesKenBurnsPanMs)),
        _ => (c.BackdropsDetailVideosSettings, new DetailSettings(c.BackdropsDetailVideosCycleTimeMs, c.BackdropsDetailVideosOrderMode, c.BackdropsDetailVideosRandomStart, c.BackdropsDetailVideosKenBurnsEnabled, c.BackdropsDetailVideosKenBurnsZoomMs, c.BackdropsDetailVideosKenBurnsPanMs))
    };

    /// <summary>
    /// The finished Set override list. Set block: the set's own backdrops (Single = main, or a random allowed one
    /// when the main's format is not allowed, the pools' Main rule; Multiple = all in Set image order). Movie
    /// blocks: one per member title with a backdrop (the user's members only, parental control; no user = no
    /// members), each Single or Multiple in Movie image order, the titles in Movie order (release date per
    /// Jellyfin's rule, Shuffle, or Random = drawn with repeats, each drawn title as one block); Random start
    /// rotates the titles of a sorted order. Mixed = everything flat, the client shuffles. At most 100 URLs, cut
    /// after ordering.
    /// </summary>
    private List<string> BuildSetOverrideImages(BoxSet set, PluginConfiguration c, JfUser? user)
    {
        var random = new Random();
        var source = c.BackdropsSetSourceMode;
        var mixed = source == "Mixed";

        List<string> Block(BaseItem item, string imagesMode, string orderMode)
        {
            var candidates = GetBackdropCandidates(item, c);
            if (candidates.Count == 0) { return new List<string>(); }
            if (imagesMode != "Multiple")
            {
                var main = candidates.FirstOrDefault(e => e.Index == 0) ?? candidates[random.Next(candidates.Count)];
                return new List<string> { EntryUrl(main) };
            }

            var urls = candidates.Select(EntryUrl).ToList();
            return mixed ? urls : OrderList(urls, orderMode, random);
        }

        var result = new List<string>();
        if (source != "Movies")
        {
            result.AddRange(Block(set, c.BackdropsSetImages, c.BackdropsSetImageOrderMode));
        }

        if (source != "Set" && user is not null)
        {
            // Library access and parental rating / blocked tags, the two steps of vanilla's Folder.AddChildren.
            var members = set.GetLinkedChildren(user).Where(m => m.IsVisible(user)).ToList();
            var ordered = c.BackdropsSetMovieOrder == "Descending"
                ? members.OrderByDescending(PremiereSortDate).ToList()
                : members.OrderBy(PremiereSortDate).ToList();
            var blocks = ordered.Select(m => Block(m, c.BackdropsSetMovieImages, c.BackdropsSetMovieImageOrderMode)).Where(b => b.Count > 0).ToList();
            if (!mixed)
            {
                blocks = c.BackdropsSetMovieOrder switch
                {
                    "Shuffle" => blocks.OrderBy(_ => random.Next()).ToList(),
                    "Random" => Enumerable.Range(0, blocks.Count).Select(_ => blocks[random.Next(blocks.Count)]).ToList(),
                    _ => c.BackdropsSetMovieRandomStart ? Helpers.RandomStart.Rotate(blocks) : blocks
                };
            }

            foreach (var b in blocks) { result.AddRange(b); }
        }

        result = CapImages(result, mixed, random);
        _logger.LogInformation("Backdrops: Set override {SetId} - source {Source}, user {User}, images {Count}", set.Id, source, user?.Id.ToString("N") ?? "none", result.Count);
        return result;
    }

    /// <summary>
    /// The finished list of a Playnite Bridge game collection, built like the Set override with its own pictures
    /// and games: own block (Single = the first allowed picture, Multiple = all in Own image order), then one block
    /// per game the user may see, in Game order; Random start rotates the games of a sorted order. Mixed =
    /// everything flat, the client shuffles every round. No user = no games. At most 100 URLs, cut after ordering.
    /// </summary>
    private List<string> BuildGameCollectionImages(Guid id, PluginConfiguration c, JfUser? user)
    {
        var random = new Random();
        var source = c.BackdropsGameCollectionSource;
        var mixed = source == "Mixed";

        List<string> Block(List<string> urls, string imagesMode, string orderMode)
        {
            if (urls.Count == 0) { return urls; }
            if (imagesMode != "Multiple") { return urls.Take(1).ToList(); }
            return mixed ? urls : OrderList(urls, orderMode, random);
        }

        var result = new List<string>();
        if (source != "Games")
        {
            var allowed = Helpers.BackdropFileResolver.ParseAllowedFormats(c.BackdropsAllowedFormats);
            var own = new List<string>();
            var pictures = Helpers.PlayniteBridgeLink.CollectionBackdrops(id);
            for (var i = 0; i < pictures.Count; i++)
            {
                var (path, tag) = pictures[i];
                if (string.IsNullOrEmpty(tag) || (allowed is not null && !allowed.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase))) { continue; }
                own.Add("/Items/" + id.ToString("N") + "/Images/Backdrop/" + i + "?tag=" + Uri.EscapeDataString(tag));
            }

            result.AddRange(Block(own, c.BackdropsGameCollectionOwnImages, c.BackdropsGameCollectionOwnImageOrder));
        }

        if (source != "Own" && user is not null)
        {
            // Playnite Bridge's rule: games without a release date last, a tie by sort name.
            var games = Helpers.PlayniteBridgeLink.CollectionMembers(id, user.Id).OrderBy(g => g.Released is null);
            var ordered = (c.BackdropsGameCollectionGameOrder == "ReleaseDescending" ? games.ThenByDescending(g => g.Released) : games.ThenBy(g => g.Released))
                .ThenBy(g => g.SortName, StringComparer.OrdinalIgnoreCase).ToList();
            var blocks = ordered.Select(g => Block(ResolveGameImages(g.Id, c).Images, c.BackdropsGameCollectionGameImages, c.BackdropsGameCollectionGameImageOrder)).Where(b => b.Count > 0).ToList();
            if (!mixed)
            {
                blocks = c.BackdropsGameCollectionGameOrder switch
                {
                    "Shuffle" => blocks.OrderBy(_ => random.Next()).ToList(),
                    "Random" => Enumerable.Range(0, blocks.Count).Select(_ => blocks[random.Next(blocks.Count)]).ToList(),
                    _ => c.BackdropsGameCollectionRandomStart ? Helpers.RandomStart.Rotate(blocks) : blocks
                };
            }

            foreach (var b in blocks) { result.AddRange(b); }
        }

        result = CapImages(result, mixed, random);
        _logger.LogInformation("Backdrops: Game collection {CollectionId} - source {Source}, user {User}, images {Count}", id, source, user?.Id.ToString("N") ?? "none", result.Count);
        return result;
    }

    /// <summary>At most MaxImages URLs. Mixed is drawn at random first: its list stands in member order, so a plain cut would hide the last members on every visit.</summary>
    private static List<string> CapImages(List<string> urls, bool mixed, Random random)
    {
        if (urls.Count <= Helpers.ResourceFolderResolver.MaxImages) { return urls; }
        var pool = mixed ? urls.OrderBy(_ => random.Next()) : urls.AsEnumerable();
        return pool.Take(Helpers.ResourceFolderResolver.MaxImages).ToList();
    }

    /// <summary>Sequential keeps the list, Shuffle permutes it, Random draws as many entries with repeats.</summary>
    private static List<string> OrderList(List<string> urls, string orderMode, Random random) => orderMode switch
    {
        "Shuffle" => urls.OrderBy(_ => random.Next()).ToList(),
        "Random" => Enumerable.Range(0, urls.Count).Select(_ => urls[random.Next(urls.Count)]).ToList(),
        _ => urls
    };

    /// <summary>Jellyfin's release-date rule for set members (as Extraposter's Set order): the premiere date, else 1 January of the production year, else first.</summary>
    private static DateTime PremiereSortDate(BaseItem x)
    {
        if (x.PremiereDate.HasValue) { return x.PremiereDate.Value; }
        if (x.ProductionYear.HasValue)
        {
            try { return new DateTime(x.ProductionYear.Value, 1, 1, 0, 0, 0, DateTimeKind.Utc); }
            catch (ArgumentOutOfRangeException) { /* bad year - sorts first, like Jellyfin */ }
        }

        return DateTime.MinValue;
    }

    /// <summary>A pool entry as an image URL: the ready Url (Custom listener) or Jellyfin's own backdrop URL.</summary>
    private static string EntryUrl(GenrePoolImageEntry e) => e.Url ?? ("/Items/" + e.SourceId.ToString("N") + "/Images/Backdrop/" + e.Index + "?tag=" + Uri.EscapeDataString(e.Tag));

    /// <summary>
    /// The detail-view chain. 1) Episode with "Episode backdrops" on: the episode's own files (episodefile-name.ext
    /// [+ episodefile-name1..20 with Multiple]), a separate list with its own Order. 2) The item's own backdrops.
    /// 3) The first ancestor with backdrops, walking GetParents() like Jellyfin's DtoService fills
    /// ParentBackdropImageTags (season, then show). Steps 2 and 3 read from the Listener's source only; Native
    /// never mixes with Custom.
    /// </summary>
    private (List<string> Images, string Source) ResolveDetailViewImages(BaseItem item, PluginConfiguration config)
    {
        var allowed = Helpers.BackdropFileResolver.ParseAllowedFormats(config.BackdropsAllowedFormats);

        if (item is Episode episode && config.BackdropsEpisodeEnabled && episode.IsFileProtocol && !string.IsNullOrEmpty(episode.Path))
        {
            var folder = episode.ContainingFolderPath;
            var fileName = episode.FileNameWithoutExtension;
            if (!string.IsNullOrEmpty(folder) && !string.IsNullOrEmpty(fileName))
            {
                var baseName = string.IsNullOrWhiteSpace(config.BackdropsEpisodeBaseName) ? "backdrop" : config.BackdropsEpisodeBaseName.Trim();
                var files = Helpers.BackdropFileResolver.ResolvePrefixed(folder, fileName, baseName, config.BackdropsEpisodeBackdropFiles == "Multiple", allowed);
                if (files.Count > 0)
                {
                    var urls = new List<string>();
                    for (var i = 0; i < files.Count; i++)
                    {
                        urls.Add("/Backdrops/episode-image?itemId=" + episode.Id.ToString("N") + "&index=" + i + "&v=" + Helpers.BackdropFileResolver.VersionTag(files[i]));
                    }

                    return (urls, "Episode");
                }
            }
        }

        var own = CandidateUrls(item, config, allowed);
        if (own.Count > 0) { return (own, "Item"); }

        foreach (var parent in item.GetParents())
        {
            if (parent is Folder && parent.IsTopParent) { break; } // library root - Jellyfin stops before CollectionFolder/UserView too
            var inherited = CandidateUrls(parent, config, allowed);
            if (inherited.Count > 0) { return (inherited, "Parent"); }
        }

        return (new List<string>(), string.Empty);
    }

    /// <summary>
    /// The Detail View list of a Playnite Bridge game, which has no BaseItem. Native = Playnite Bridge's own
    /// backdrop list (the BackdropImageTags of its DTO, served by its filter at Jellyfin's image URL), Custom = the
    /// configured base name in the game folder, read only. Same format filter and path dedupe as an item; no
    /// inheritance, a game has no parent with images.
    /// </summary>
    private static (List<string> Images, string Source) ResolveGameImages(Guid gameId, PluginConfiguration config)
    {
        var allowed = Helpers.BackdropFileResolver.ParseAllowedFormats(config.BackdropsAllowedFormats);
        var urls = new List<string>();
        var id = gameId.ToString("N");
        if (config.BackdropsListener == "Custom")
        {
            var files = ResolveGameCustomFiles(gameId, config, allowed);
            for (var i = 0; i < files.Count; i++)
            {
                urls.Add("/Backdrops/custom-image?itemId=" + id + "&index=" + i + "&v=" + Helpers.BackdropFileResolver.VersionTag(files[i]));
            }
        }
        else
        {
            var backdrops = Helpers.PlayniteBridgeLink.Backdrops(gameId);
            var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < backdrops.Count; i++)
            {
                var (path, tag) = backdrops[i];
                if (allowed is not null && !allowed.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase)) { continue; }
                if (!string.IsNullOrEmpty(path) && !seenPaths.Add(path)) { continue; }
                if (string.IsNullOrEmpty(tag)) { continue; }
                urls.Add("/Items/" + id + "/Images/Backdrop/" + i + "?tag=" + Uri.EscapeDataString(tag));
            }
        }

        return (urls, urls.Count > 0 ? "Item" : string.Empty);
    }

    /// <summary>Games: the Custom listener's files in the game folder - a folder of its own like a movie folder, no file name, not mixed.</summary>
    private static List<string> ResolveGameCustomFiles(Guid gameId, PluginConfiguration config, IReadOnlyCollection<string>? allowed)
    {
        var folder = Helpers.PlayniteBridgeLink.GameFolder(gameId);
        if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) { return new List<string>(); }
        var baseName = string.IsNullOrWhiteSpace(config.BackdropsCustomBaseName) ? "backdrop" : config.BackdropsCustomBaseName.Trim();
        return Helpers.BackdropFileResolver.ResolveLikeJellyfin(folder, null, false, baseName, allowed);
    }

    /// <summary>All allowed backdrop URLs of one item, in original index order, per Listener.</summary>
    private List<string> CandidateUrls(BaseItem item, PluginConfiguration config, IReadOnlyCollection<string>? allowed)
    {
        var urls = new List<string>();
        foreach (var c in GetBackdropCandidates(item, config))
        {
            urls.Add(c.Url ?? ("/Items/" + item.Id.ToString("N") + "/Images/Backdrop/" + c.Index + "?tag=" + Uri.EscapeDataString(c.Tag)));
        }

        return urls;
    }

    /// <summary>GET /Backdrops/episode-image?itemId=X&amp;index=N - one of the episode's own backdrop files.</summary>
    [AllowAnonymous]
    [HttpGet("episode-image")]
    public ActionResult GetEpisodeImage([FromQuery] Guid itemId, [FromQuery] int index)
    {
        // A file locked by a writing tool or removed between the scan and the open answers 404 + a warning, not
        // a 500.
        try
        {
            var config = Plugin.Instance!.Configuration;
            if (_libraryManager.GetItemById(itemId) is not Episode episode || !episode.IsFileProtocol || string.IsNullOrEmpty(episode.Path)) { return NotFound(); }
            var baseName = string.IsNullOrWhiteSpace(config.BackdropsEpisodeBaseName) ? "backdrop" : config.BackdropsEpisodeBaseName.Trim();
            var files = Helpers.BackdropFileResolver.ResolvePrefixed(episode.ContainingFolderPath, episode.FileNameWithoutExtension, baseName, config.BackdropsEpisodeBackdropFiles == "Multiple", Helpers.BackdropFileResolver.ParseAllowedFormats(config.BackdropsAllowedFormats));
            if (index < 0 || index >= files.Count) { return NotFound(); }
            return ServeLocalImage(files[index]);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Backdrops: GetEpisodeImage 404 - the file of {ItemId} index {Index} could not be served", itemId, index);
            return NotFound();
        }
    }

    /// <summary>
    /// GET /Backdrops/allowed-indices?sourceId=X: BackdropsAllowedFormats is not a file search but a display gate
    /// on the backdrops Jellyfin already resolved for the item. Given the sourceId the client computes (the item
    /// that owns the backdrops: itself, or the parent it inherits them from), returns the indices (in
    /// BackdropImageTags order, which the client uses for its image URLs) whose on-disk extension
    /// (ItemImageInfo.Path) is allowed. Does not apply to People Backdrops: those are Wallpapers.com URLs, not
    /// local files with a checkable extension.
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
    /// GET /Backdrops/genre-pool?genreId=X&amp;parentId=Y (parentId optional): the image pool for the Genre
    /// Backdrops rotation, one image per matching item. Mirrors jellyfin-web's list.js: no parentId = the global
    /// genre list (no library scope, Movie + Series); a parentId = a library-scoped genre list, whose library's
    /// CollectionType (movies/tvshows) picks the sub and the single item type, as moviegenres.js/tvgenres.js pass
    /// it. Any other CollectionType falls back to the Movies sub.
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

        // Sort/Traversal are one shared pair for all three subs (Global/Movies/TvShows).
        var sortMode = config.BackdropsGenreSortMode;
        var traversalMode = config.BackdropsGenreTraversalMode;
        var randomStart = config.BackdropsGenreRandomStart;

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

        if (config.BackdropsGenreSourceMode == "ResourceFolder")
        {
            // The images of the genre's own folder.
            result.SortMode = ResourceSortMode(sortMode);
            result.Images = ResourcePool("genre", genreId.ToString("N"), parentId, null, config);
            _logger.LogInformation("Backdrops: GetGenrePool - genreId={GenreId}, sub={Sub}, resource folder, imagesReturned={ImageCount}", genreId, subName, result.Images.Count);
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

        var (resolvedOrderBy, resolvedOrder, resolvedStartIndex, resolvedLimit) = ResolveRotationQuery(sortMode, traversalMode, randomStart, query);
        query.OrderBy = new[] { (resolvedOrderBy, resolvedOrder) };
        query.Limit = resolvedLimit;
        if (resolvedStartIndex.HasValue)
        {
            query.StartIndex = resolvedStartIndex.Value;
        }

        // Indices stay the original, unfiltered ones: GetImageCacheTag looks up by that index, so a filtered
        // list's position would point at the wrong image. Query + candidates run once per PoolCacheWindow.
        var poolUser = query.User?.Id.ToString("N") ?? "anon";
        var (images, fromCache) = CachedPool("genre|" + genreId.ToString("N") + "|" + (parentId?.ToString("N") ?? "") + "|" + poolUser, config,
            () => CollectPoolImages(_libraryManager.GetItemList(query), config.BackdropsGenreMainOnly == "Main", config.BackdropsAllowedFormats));

        result.Images = images;

        _logger.LogInformation(
            "Backdrops: GetGenrePool - genreId={GenreId}, sub={Sub}, sortMode={SortMode}, imagesReturned={ImageCount}, fromCache={FromCache}",
            genreId, subName, sortMode, images.Count, fromCache);

        return Ok(result);
    }

    /// <summary>
    /// GET /Backdrops/studio-pool?studioId=X[&amp;parentId=Y]: the pool for Studio Backdrops with
    /// Source=Appearances, the backdrops of the titles the studio appears in, like GetGenrePool with a StudioIds
    /// filter. Studio has only the Global/TvShows subs.
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
        var randomStart = config.BackdropsStudioRandomStart;
        var finalEnabled = tabAndRootEnabled && subEnabled && (config.BackdropsStudioSourceMode == "Appearances" || config.BackdropsStudioSourceMode == "ResourceFolder");
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

        if (config.BackdropsStudioSourceMode == "ResourceFolder")
        {
            // The images of the studio's own folder.
            result.SortMode = ResourceSortMode(sortMode);
            result.Images = ResourcePool("studio", studioId.ToString("N"), parentId, null, config);
            _logger.LogInformation("Backdrops: GetStudioPool - studioId={StudioId}, sub={Sub}, resource folder, imagesReturned={ImageCount}", studioId, subName, result.Images.Count);
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

        var (resolvedOrderBy, resolvedOrder, resolvedStartIndex, resolvedLimit) = ResolveRotationQuery(sortMode, traversalMode, randomStart, query);
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
    /// GET /Backdrops/tag-pool?tag=X: the pool for Tag Backdrops. One variant only: tags are global, so there is no
    /// parentId/CollectionType resolution, and the item type is never restricted. tag is the raw tag name, not a
    /// Guid (list.js passes params.tag with no lookup item), unlike Genre/Studio.
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

        if (config.BackdropsTagSourceMode == "ResourceFolder")
        {
            // The images of the tag's own folder.
            result.SortMode = ResourceSortMode(config.BackdropsTagSortMode);
            result.Images = ResourcePool("tag", tag, null, null, config);
            _logger.LogInformation("Backdrops: GetTagPool - tag={Tag}, resource folder, imagesReturned={ImageCount}", tag, result.Images.Count);
            return Ok(result);
        }

        var sortMode = config.BackdropsTagSortMode;
        var traversalMode = config.BackdropsTagTraversalMode;
        var randomStart = config.BackdropsTagRandomStart;

        // Deliberately no IncludeItemTypes: a tag pool takes everything carrying the tag (movies, series, ...).
        var query = new InternalItemsQuery(GetRequestUser())
        {
            Tags = new[] { tag },
            Recursive = true
        };
        var (resolvedOrderBy, resolvedOrder, resolvedStartIndex, resolvedLimit) = ResolveRotationQuery(sortMode, traversalMode, randomStart, query);
        query.OrderBy = new[] { (resolvedOrderBy, resolvedOrder) };
        query.Limit = resolvedLimit;
        if (resolvedStartIndex.HasValue)
        {
            query.StartIndex = resolvedStartIndex.Value;
        }

        // Query + candidates once per PoolCacheWindow (CachedPool).
        var poolUser = query.User?.Id.ToString("N") ?? "anon";
        var (images, fromCache) = CachedPool("tag|" + tag + "|" + poolUser, config,
            () => CollectPoolImages(_libraryManager.GetItemList(query), config.BackdropsTagMainOnly == "Main", config.BackdropsAllowedFormats));

        result.Images = images;
        _logger.LogInformation(
            "Backdrops: GetTagPool - tag={Tag}, sortMode={SortMode}, imagesReturned={ImageCount}, fromCache={FromCache}",
            tag, sortMode, images.Count, fromCache);

        return Ok(result);
    }

    /// <summary>
    /// GET /Backdrops/library-pool?page=X[&amp;parentId=Y]: Library View Backdrops, a replica of Jellyfin's random
    /// library backdrops (jellyfin-web scripts/autoBackdrops.js, getBackdropItemIds): 20 items with a backdrop,
    /// SortBy IsFavoriteOrLiked,Random, ImageTypes Backdrop, Recursive, per library (ParentId) or, for the Home
    /// set, across all libraries with MaxOfficialRating PG-13. page names the client's page kind:
    ///   home         Movie+Series+Book, all libraries, rating cap (vanilla Home incl. its Favourites tab)
    ///   movies       Movie in the library parentId (vanilla movies.html)
    ///   tv           Series in the library parentId (vanilla tv.html)
    ///   music        MusicArtist in the library parentId (vanilla music.html)
    ///   collections  BoxSet, only when parentId is a boxsets library (list.html?parentId - vanilla paints nothing there)
    ///   search       the Home set (search.html - vanilla paints nothing)
    ///   usersettings the Home set (mypreferences*.html/userprofile.html - vanilla paints nothing)
    /// Vanilla quirk kept as is: SortBy IsFavoriteOrLiked without a SortOrder is ascending, so favourites sort last
    /// and only reach the 20 when the library has fewer than 20 non-favourites.
    /// [Authorize]: IsFavoriteOrLiked is per-user data, and the user's own parental limit applies through
    /// InternalItemsQuery(user); the PG-13 cap only ever lowers that limit, never raises it.
    /// The client rotates the 20 with its own engine (Order/Cycle time/Ken Burns); Sequential + Random start
    /// rotates the finished list here.
    /// </summary>
    [Authorize]
    [HttpGet("library-pool")]
    public ActionResult<GenrePoolResult> GetLibraryPool([FromQuery] string page, [FromQuery] Guid? parentId)
    {
        var config = Plugin.Instance!.Configuration;
        var requestUser = GetRequestUser();
        var categoryEnabled = config.BackdropsTabEnabled && config.BackdropsLibraryEnabled && requestUser is not null;

        var result = new GenrePoolResult
        {
            Enabled = false,
            SortMode = config.BackdropsLibraryOrderMode,
            MainOnly = true,
            CycleTimeMs = config.BackdropsLibraryCycleTimeMs,
            KenBurnsEnabled = config.BackdropsLibraryKenBurnsEnabled,
            KenBurnsZoomMs = config.BackdropsLibraryKenBurnsZoomMs,
            KenBurnsPanMs = config.BackdropsLibraryKenBurnsPanMs
        };

        if (!categoryEnabled)
        {
            _logger.LogInformation("Backdrops: GetLibraryPool - page={Page}, category not enabled or anonymous", page);
            return Ok(result);
        }

        // Playnite Bridge's games library is a movies library in Jellyfin, but its virtual games are not in the
        // database: its own Show-on box and that plugin's list. Asked first, so "Movies" stays for real movie libraries.
        if (page == "movies" && parentId.HasValue)
        {
            var games = Helpers.PlayniteBridgeLink.LibraryBackdrops(parentId.Value, requestUser!.Id);
            if (games.Count > 0)
            {
                if (!config.BackdropsLibraryShowOnGames || !Helpers.PlayniteBridgeLink.DrawsGames)
                {
                    _logger.LogInformation("Backdrops: GetLibraryPool - page={Page}, parentId={ParentId} (games library), not enabled for this page", page, parentId);
                    return Ok(result);
                }

                var gameImages = GameLibraryPoolImages(games, config);
                if (config.BackdropsLibraryRandomStart && config.BackdropsLibraryOrderMode == "Sequential")
                {
                    gameImages = Helpers.RandomStart.Rotate(gameImages);
                }

                result.Enabled = true;
                result.Images = gameImages;
                _logger.LogInformation(
                    "Backdrops: GetLibraryPool - page={Page}, parentId={ParentId} (games library), order={Order}, gamesFound={GameCount}, imagesReturned={ImageCount}",
                    page, parentId, config.BackdropsLibraryOrderMode, games.Count, gameImages.Count);
                return Ok(result);
            }
        }

        bool pageEnabled;
        BaseItemKind[] types;
        Guid? queryParent = null;
        var homeSet = false;
        switch (page)
        {
            case "home": pageEnabled = config.BackdropsLibraryShowOnHome; types = new[] { BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.Book }; homeSet = true; break;
            case "search": pageEnabled = config.BackdropsLibraryShowOnSearch; types = new[] { BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.Book }; homeSet = true; break;
            case "usersettings": pageEnabled = config.BackdropsLibraryShowOnUserSettings; types = new[] { BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.Book }; homeSet = true; break;
            case "movies": pageEnabled = config.BackdropsLibraryShowOnMovies; types = new[] { BaseItemKind.Movie }; queryParent = parentId; break;
            case "tv": pageEnabled = config.BackdropsLibraryShowOnTvShows; types = new[] { BaseItemKind.Series }; queryParent = parentId; break;
            case "music": pageEnabled = config.BackdropsLibraryShowOnMusic; types = new[] { BaseItemKind.MusicArtist }; queryParent = parentId; break;
            case "collections":
                // list.html?parentId=X is every folder-like page (Folders view, Books,
                // Playlists, ...). Only a boxsets library qualifies; sets are global
                // in Jellyfin, so the query is not restricted to the folder.
                var isBoxsetLibrary = parentId.HasValue && _libraryManager.GetItemById(parentId.Value) is CollectionFolder { CollectionType: CollectionType.boxsets };
                pageEnabled = config.BackdropsLibraryShowOnCollections && isBoxsetLibrary;
                types = new[] { BaseItemKind.BoxSet };
                break;
            default:
                _logger.LogInformation("Backdrops: GetLibraryPool - unrecognized page {Page}", page);
                return Ok(result);
        }

        if (!pageEnabled)
        {
            _logger.LogInformation("Backdrops: GetLibraryPool - page={Page}, parentId={ParentId}, not enabled for this page", page, parentId);
            return Ok(result);
        }

        var query = new InternalItemsQuery(requestUser)
        {
            IncludeItemTypes = types,
            ImageTypes = new[] { ImageType.Backdrop },
            Recursive = true,
            Limit = 20,
            EnableTotalRecordCount = false,
            OrderBy = new[] { (ItemSortBy.IsFavoriteOrLiked, SortOrder.Ascending), (ItemSortBy.Random, SortOrder.Ascending) }
        };
        if (queryParent.HasValue)
        {
            query.ParentId = queryParent.Value;
        }

        if (homeSet && config.BackdropsLibraryHomeRatingCap == "PG-13")
        {
#if NET10_0_OR_GREATER
            // Jellyfin 12.1: ratings are a Score + optional SubScore (lower = stricter), compared like the server's
            // query builder (BaseItemRepository.QueryBuilding.cs: a missing SubScore counts as 0); the cap only
            // ever tightens.
            var cap = _localization.GetRatingScore("PG-13");
            var current = query.MaxParentalRating;
            if (cap is not null && (current is null || current.Score > cap.Score
                || (current.Score == cap.Score && (current.SubScore ?? 0) > (cap.SubScore ?? 0))))
            {
                query.MaxParentalRating = cap;
            }
#else
            var cap = _localization.GetRatingLevel("PG-13");
            if (cap.HasValue && (!query.MaxParentalRating.HasValue || query.MaxParentalRating.Value > cap.Value))
            {
                query.MaxParentalRating = cap;
            }
#endif
        }

        var items = _libraryManager.GetItemList(query);
        var images = CollectPoolImages(items, mainOnly: true, allowedFormatsCsv: config.BackdropsAllowedFormats);
        if (config.BackdropsLibraryRandomStart && config.BackdropsLibraryOrderMode == "Sequential")
        {
            images = Helpers.RandomStart.Rotate(images);
        }

        result.Enabled = true;
        result.Images = images;
        _logger.LogInformation(
            "Backdrops: GetLibraryPool - page={Page}, parentId={ParentId}, order={Order}, itemsFound={ItemCount}, imagesReturned={ImageCount}",
            page, parentId, config.BackdropsLibraryOrderMode, items.Count, images.Count);

        return Ok(result);
    }

    /// <summary>
    /// The Library View pool of the Playnite Bridge games library: the query above on Playnite Bridge's list (one
    /// entry per game: its backdrop 0 and its favourite flag): favourites last (IsFavoriteOrLiked ascending, the
    /// vanilla quirk), random otherwise, 20 games; then the main backdrop per Listener like CollectPoolImages with
    /// mainOnly. Native = backdrop 0 when its format is allowed (the list carries no other backdrop to fall back
    /// on), Custom = the first file of the game folder.
    /// </summary>
    private static List<GenrePoolImageEntry> GameLibraryPoolImages(IReadOnlyList<(Guid Id, string Path, string Tag, bool Favorite)> games, PluginConfiguration config)
    {
        var allowed = Helpers.BackdropFileResolver.ParseAllowedFormats(config.BackdropsAllowedFormats);
        var random = new Random();
        var images = new List<GenrePoolImageEntry>();
        foreach (var game in games.OrderBy(g => g.Favorite).ThenBy(_ => random.Next()).Take(20))
        {
            if (config.BackdropsListener == "Custom")
            {
                var files = ResolveGameCustomFiles(game.Id, config, allowed);
                if (files.Count == 0) { continue; }
                images.Add(new GenrePoolImageEntry { SourceId = game.Id, Tag = string.Empty, Index = 0, Url = "/Backdrops/custom-image?itemId=" + game.Id.ToString("N") + "&index=0&v=" + Helpers.BackdropFileResolver.VersionTag(files[0]) });
                continue;
            }

            if (string.IsNullOrEmpty(game.Tag)) { continue; }
            if (allowed is not null && !allowed.Contains(Path.GetExtension(game.Path), StringComparer.OrdinalIgnoreCase)) { continue; }
            images.Add(new GenrePoolImageEntry { SourceId = game.Id, Tag = game.Tag, Index = 0 });
        }

        return images;
    }

    /// <summary>
    /// The user behind the request, from Jellyfin's auth claim ("Jellyfin-UserId", InternalClaimTypes.UserId in
    /// Jellyfin.Api). IsFavorite is per-user data: Jellyfin joins UserDatas only when InternalItemsQuery.User is
    /// set (SqliteItemRepository.EnableJoinUserData); without it the IsFavorite filter fails with SQLite's
    /// "no such column: IsFavorite".
    /// </summary>
    private JfUser? GetRequestUser()
    {
        var claim = User?.FindFirst("Jellyfin-UserId")?.Value;
        if (string.IsNullOrEmpty(claim) || !Guid.TryParse(claim, out var userId))
        {
            return null;
        }
        return _userManager.GetUserById(userId);
    }

    /// <summary>
    /// GET /Backdrops/favorites-pool?type=X: the pool for one of the ten generic Favorites sections (People has its
    /// own endpoint). type is the raw BaseItemKind name (Movie/Series/Episode/Video/BoxSet/Playlist/MusicArtist/
    /// MusicAlbum/Audio/Book), as list.js builds its query (IncludeItemTypes: params.type, IsFavorite).
    /// MainOnly/CycleTimeMs/KenBurns are shared by all sections; only Enable and the order differ per section.
    /// </summary>
    [Authorize]
    [HttpGet("favorites-pool")]
    public ActionResult<GenrePoolResult> GetFavoritesPool([FromQuery] string type, [FromQuery] string? title)
    {
        var config = Plugin.Instance!.Configuration;
        var tabAndRootEnabled = config.BackdropsTabEnabled && config.BackdropsFavoritesEnabled;

        bool subEnabled;
        string perTypeSortMode;
        string perTypeTraversalMode;
        bool perTypeRandomStart;
        BaseItemKind includeType;
        switch (type)
        {
            case "Movie": subEnabled = config.BackdropsFavoritesMoviesEnabled; perTypeSortMode = config.BackdropsFavoritesMoviesSortMode; perTypeTraversalMode = config.BackdropsFavoritesMoviesTraversalMode; perTypeRandomStart = config.BackdropsFavoritesMoviesRandomStart; includeType = BaseItemKind.Movie; break;
            case "Series": subEnabled = config.BackdropsFavoritesShowsEnabled; perTypeSortMode = config.BackdropsFavoritesShowsSortMode; perTypeTraversalMode = config.BackdropsFavoritesShowsTraversalMode; perTypeRandomStart = config.BackdropsFavoritesShowsRandomStart; includeType = BaseItemKind.Series; break;
            case "Episode": subEnabled = config.BackdropsFavoritesEpisodesEnabled; perTypeSortMode = config.BackdropsFavoritesEpisodesSortMode; perTypeTraversalMode = config.BackdropsFavoritesEpisodesTraversalMode; perTypeRandomStart = config.BackdropsFavoritesEpisodesRandomStart; includeType = BaseItemKind.Episode; break;
            case "Video": subEnabled = config.BackdropsFavoritesVideosEnabled; perTypeSortMode = config.BackdropsFavoritesVideosSortMode; perTypeTraversalMode = config.BackdropsFavoritesVideosTraversalMode; perTypeRandomStart = config.BackdropsFavoritesVideosRandomStart; includeType = BaseItemKind.Video; break;
            case "BoxSet": subEnabled = config.BackdropsFavoritesCollectionsEnabled; perTypeSortMode = config.BackdropsFavoritesCollectionsSortMode; perTypeTraversalMode = config.BackdropsFavoritesCollectionsTraversalMode; perTypeRandomStart = config.BackdropsFavoritesCollectionsRandomStart; includeType = BaseItemKind.BoxSet; break;
            case "Playlist": subEnabled = config.BackdropsFavoritesPlaylistsEnabled; perTypeSortMode = config.BackdropsFavoritesPlaylistsSortMode; perTypeTraversalMode = config.BackdropsFavoritesPlaylistsTraversalMode; perTypeRandomStart = config.BackdropsFavoritesPlaylistsRandomStart; includeType = BaseItemKind.Playlist; break;
            case "MusicArtist": subEnabled = config.BackdropsFavoritesArtistsEnabled; perTypeSortMode = config.BackdropsFavoritesArtistsSortMode; perTypeTraversalMode = config.BackdropsFavoritesArtistsTraversalMode; perTypeRandomStart = config.BackdropsFavoritesArtistsRandomStart; includeType = BaseItemKind.MusicArtist; break;
            case "MusicAlbum": subEnabled = config.BackdropsFavoritesAlbumsEnabled; perTypeSortMode = config.BackdropsFavoritesAlbumsSortMode; perTypeTraversalMode = config.BackdropsFavoritesAlbumsTraversalMode; perTypeRandomStart = config.BackdropsFavoritesAlbumsRandomStart; includeType = BaseItemKind.MusicAlbum; break;
            case "Audio": subEnabled = config.BackdropsFavoritesSongsEnabled; perTypeSortMode = config.BackdropsFavoritesSongsSortMode; perTypeTraversalMode = config.BackdropsFavoritesSongsTraversalMode; perTypeRandomStart = config.BackdropsFavoritesSongsRandomStart; includeType = BaseItemKind.Audio; break;
            case "Book": subEnabled = config.BackdropsFavoritesBooksEnabled; perTypeSortMode = config.BackdropsFavoritesBooksSortMode; perTypeTraversalMode = config.BackdropsFavoritesBooksTraversalMode; perTypeRandomStart = config.BackdropsFavoritesBooksRandomStart; includeType = BaseItemKind.Book; break;
            default:
                _logger.LogInformation("Backdrops: GetFavoritesPool - unrecognized type {Type}", type);
                return Ok(new GenrePoolResult { Enabled = false });
        }

        // Manage "General" uses one shared Order/Traversal for every type instead of each section's own.
        var isGeneral = config.BackdropsFavoritesManageMode == "General";
        var sortMode = isGeneral ? config.BackdropsFavoritesGeneralSortMode : perTypeSortMode;
        var traversalMode = isGeneral ? config.BackdropsFavoritesGeneralTraversalMode : perTypeTraversalMode;
        var randomStart = isGeneral ? config.BackdropsFavoritesGeneralRandomStart : perTypeRandomStart;

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

        if (config.BackdropsFavoritesSourceMode == "ResourceFolder")
        {
            // The section's folder: the title Jellyfin displays (As shown) or the English section name. Manage is
            // not used here: the General Order pair decides Shuffle/Random.
            result.SortMode = ResourceSortMode(config.BackdropsFavoritesGeneralSortMode);
            // Collections, Playlists and Books pages show no title (list.js has no branch for them), so the
            // English folder is the only one there.
            var titled = type != "BoxSet" && type != "Playlist" && type != "Book";
            if (config.BackdropsFavoritesResourceSectionNames == "AsShown" && titled && string.IsNullOrWhiteSpace(title))
            {
                result.NeedsTitle = true;
                return Ok(result);
            }

            result.Images = ResourcePool("favorites", type, null, title, config);
            _logger.LogInformation("Backdrops: GetFavoritesPool - type={Type}, title={Title}, resource folder, imagesReturned={ImageCount}", type, title, result.Images.Count);
            return Ok(result);
        }

        var query = new InternalItemsQuery(requestUser)
        {
            IsFavorite = true,
            IncludeItemTypes = new[] { includeType },
            Recursive = true
        };
        var (resolvedOrderBy, resolvedOrder, resolvedStartIndex, resolvedLimit) = ResolveRotationQuery(sortMode, traversalMode, randomStart, query);
        query.OrderBy = new[] { (resolvedOrderBy, resolvedOrder) };
        query.Limit = resolvedLimit;
        if (resolvedStartIndex.HasValue)
        {
            query.StartIndex = resolvedStartIndex.Value;
        }

        // Query + candidates once per PoolCacheWindow (CachedPool, per user).
        var (images, fromCache) = CachedPool("favorites|" + type + "|" + requestUser!.Id.ToString("N"), config,
            () => CollectPoolImages(_libraryManager.GetItemList(query), config.BackdropsFavoritesMainOnly == "Main", config.BackdropsAllowedFormats));

        result.Images = images;
        _logger.LogInformation(
            "Backdrops: GetFavoritesPool - type={Type}, sortMode={SortMode}, imagesReturned={ImageCount}, fromCache={FromCache}",
            type, sortMode, images.Count, fromCache);

        return Ok(result);
    }

    /// <summary>
    /// GET /Backdrops/favorites-people-pool: the pool for the Favorites People section, with the two exclusive
    /// source shapes of FavoritesPeoplePoolResult.
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

        // Favourite persons are not reachable through an items query (Person items hang under no library, so
        // Recursive=true finds none). Jellyfin's PersonsController resolves them via
        // GetPeopleItems(InternalPeopleQuery { User, IsFavorite }), the People table joined with UserData; so does this.
        var favoritePeople = _libraryManager.GetPeopleItems(new InternalPeopleQuery
        {
            User = requestUser,
            IsFavorite = true
        })
#if NET10_0_OR_GREATER
            // Jellyfin 12.1 returns a QueryResult<BaseItem>; the code below needs Person (name, folder)
            .Items.OfType<Person>().ToList();
#else
            .Where(person => person is not null).ToList();
#endif

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

            // Same filter as the standalone People Backdrops appearances: movies only, shows only or both.
            var includeTypes = config.BackdropsFavoritesPeopleAppearancesFilter switch
            {
                "Movies" => new[] { BaseItemKind.Movie },
                "Series" => new[] { BaseItemKind.Series },
                _ => new[] { BaseItemKind.Movie, BaseItemKind.Series }
            };

            // Own Order/Traversal (like the standalone People Appearances block), the request user on the query,
            // pool cap.
            var appearancesQuery = new InternalItemsQuery(requestUser)
            {
                PersonIds = personIds,
                IncludeItemTypes = includeTypes,
                Recursive = true
            };
            var (apOrderBy, apOrder, apStart, apLimit) = ResolveRotationQuery(config.BackdropsFavoritesPeopleAppearancesSortMode, config.BackdropsFavoritesPeopleAppearancesTraversalMode, config.BackdropsFavoritesPeopleAppearancesRandomStart, appearancesQuery);
            appearancesQuery.OrderBy = new[] { (apOrderBy, apOrder) };
            appearancesQuery.Limit = apLimit;
            if (apStart.HasValue) { appearancesQuery.StartIndex = apStart.Value; }
            var items = _libraryManager.GetItemList(appearancesQuery);

            var random = new Random();
            var images = new List<GenrePoolImageEntry>();
            foreach (var item in items)
            {
                var candidates = GetBackdropCandidates(item, config);
                if (candidates.Count == 0) { continue; }
                var main = candidates.FirstOrDefault(c => c.Index == 0);
                images.Add(config.BackdropsFavoritesPeopleAppearancesMainOnly == "Main" && main is not null ? main : candidates[random.Next(candidates.Count)]);
            }

            result.Images = images;
            _logger.LogInformation(
                "Backdrops: GetFavoritesPeoplePool - Appearances, favoritePeople={PeopleCount}, itemsFound={ItemCount}, imagesReturned={ImageCount}",
                favoritePeople.Count, items.Count, images.Count);
            return Ok(result);
        }

        if (sourceMode == "Folder")
        {
            // Folder source: every favourite person's own backdrop.ext / backdropN.ext (same resolver and image
            // endpoint as the standalone People Folder source; the endpoint gets this Single/Multiple mode so the
            // indices match). Sequential keeps person order with each person's files in native order;
            // Shuffle/Random are applied by the client over all files.
            var folderMode = config.BackdropsFavoritesPeopleFolderBackdropFiles;
            var folderUrls = new List<string>();
            foreach (var person in favoritePeople)
            {
                var personFolder = PeopleBackdropsController.GetPersonFolder(person);
                // The same base name as the standalone People setting: GetFolderImage resolves with it, so the list must too.
                var paths = PeopleBackdropsController.ResolveFolderBackdropPaths(personFolder, folderMode, config.BackdropsAllowedFormats, config.PeopleBackdropsFolderBaseName);
                for (var i = 0; i < paths.Count; i++)
                {
                    folderUrls.Add("/PeopleBackdrops/" + person.Id + "/folder-image?index=" + i + "&mode=" + folderMode + "&v=" + Helpers.BackdropFileResolver.VersionTag(paths[i]));
                }
            }
            // Random start position (Sequential only; the client shuffles the other orders itself).
            if (config.BackdropsFavoritesPeopleFolderRandomStart && config.BackdropsFavoritesPeopleFolderOrderMode == "Sequential") { folderUrls = Helpers.RandomStart.Rotate(folderUrls); }
            result.WallpaperUrls = folderUrls;
            _logger.LogInformation(
                "Backdrops: GetFavoritesPeoplePool - Folder, favoritePeople={PeopleCount}, mode={Mode}, imagesReturned={ImageCount}",
                favoritePeople.Count, folderMode, folderUrls.Count);
            return Ok(result);
        }

        // WallpapersCom: reuses People Backdrops' cache files (ReadOrPopulateCacheFileAsync / GetCacheFilePath).
        // Two buckets, both randomly sampled so the pool stays mixed: cached people are read straight off disk (no
        // request), uncached people are hard-capped per visit, so even hundreds of favourites never hit the shared
        // Wallpapers.com rate limit (~30/min without a key, ~60/min with a free one).
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
                    else if (PeopleBackdropsController.IsEmptyCacheExpired(parsed))
                    {
                        // An empty result older than EmptyCacheRetryDays (or an empty file without a date) is looked
                        // up again like an uncached person.
                        uncachedPeople.Add(person);
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
    /// GET /Backdrops/studio-settings?studioId=X&amp;parentId=Y (parentId optional): settings only, no file list,
    /// since there is at most one image per studio. Same parentId/CollectionType resolution as GetGenrePool, but
    /// Studio has only the Global/TvShows subs.
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
        var hasImage = finalEnabled && config.BackdropsStudioSourceMode == "StudioImage"
            && studioItem is not null && ResolveStudioImagePath(studioItem.Name) is not null;

        _logger.LogInformation(
            "Backdrops: GetStudioSettings - studioId={StudioId}, enabled={Enabled}, hasImage={HasImage}",
            studioId, finalEnabled, hasImage);

        return Ok(new StudioSettingsResult
        {
            Enabled = finalEnabled,
            HasImage = hasImage,
            SourceMode = config.BackdropsStudioSourceMode is "Appearances" or "ResourceFolder" ? config.BackdropsStudioSourceMode : "StudioImage",
            KenBurnsEnabled = config.BackdropsStudioKenBurnsEnabled,
            KenBurnsZoomMs = config.BackdropsStudioKenBurnsZoomMs,
            KenBurnsPanMs = config.BackdropsStudioKenBurnsPanMs
        });
    }

    /// <summary>
    /// The backdrop candidates of one item as pool entries, per Listener. Native = Jellyfin's database images (tag
    /// URLs built by the client). Custom = the plugin's own file resolution (Helpers/BackdropFileResolver,
    /// Jellyfin's six stages with the configured base name) served through /Backdrops/custom-image. Both return
    /// original indices and both apply the Allowed image formats filter.
    /// </summary>
    private List<GenrePoolImageEntry> GetBackdropCandidates(BaseItem item, PluginConfiguration config)
    {
        var allowed = Helpers.BackdropFileResolver.ParseAllowedFormats(config.BackdropsAllowedFormats);
        var result = new List<GenrePoolImageEntry>();
        if (config.BackdropsListener == "Custom")
        {
            var files = ResolveCustomFiles(item, config, allowed);
            for (var i = 0; i < files.Count; i++)
            {
                result.Add(new GenrePoolImageEntry { SourceId = item.Id, Tag = string.Empty, Index = i, Url = "/Backdrops/custom-image?itemId=" + item.Id.ToString("N") + "&index=" + i + "&v=" + Helpers.BackdropFileResolver.VersionTag(files[i]) });
            }

            return result;
        }

        var allBackdrops = item.GetImages(ImageType.Backdrop).ToList();
        // Jellyfin's scan can list one file twice (e.g. "-fanart.jpg" at index 0 and 1, because its stages
        // overlap for that name); the picture would then run twice per round. Each path once, like the Custom
        // resolver.
        var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < allBackdrops.Count; i++)
        {
            if (allowed is not null && !allowed.Contains(Path.GetExtension(allBackdrops[i].Path), StringComparer.OrdinalIgnoreCase)) { continue; }
            if (!string.IsNullOrEmpty(allBackdrops[i].Path) && !seenPaths.Add(allBackdrops[i].Path)) { continue; }
            var tag = _imageProcessor.GetImageCacheTag(item, ImageType.Backdrop, i);
            if (tag is null) { continue; }
            result.Add(new GenrePoolImageEntry { SourceId = item.Id, Tag = tag, Index = i });
        }

        return result;
    }

    /// <summary>The Custom listener's file list for an item (its own folder, Jellyfin rules, configured base name).</summary>
    private static List<string> ResolveCustomFiles(BaseItem item, PluginConfiguration config, IReadOnlyCollection<string>? allowed)
    {
        if (!item.IsFileProtocol || string.IsNullOrEmpty(item.Path)) { return new List<string>(); }
        var folder = item.ContainingFolderPath;
        if (string.IsNullOrEmpty(folder)) { return new List<string>(); }
        var baseName = string.IsNullOrWhiteSpace(config.BackdropsCustomBaseName) ? "backdrop" : config.BackdropsCustomBaseName.Trim();
        // Folders (series, seasons, box sets) have no file name of their own - Jellyfin passes null there too.
        var fileName = item.IsFolder ? null : item.FileNameWithoutExtension;
        return Helpers.BackdropFileResolver.ResolveLikeJellyfin(folder, fileName, item.IsInMixedFolder, baseName, allowed);
    }

    /// <summary>
    /// GET /Backdrops/custom-image?itemId=X&amp;index=N: serves one file of the Custom listener's list for that
    /// item. Anonymous like Jellyfin's /Items/{id}/Images (the browser loads it as a plain image).
    /// </summary>
    [AllowAnonymous]
    [HttpGet("custom-image")]
    public ActionResult GetCustomImage([FromQuery] Guid itemId, [FromQuery] int index)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            // Nothing is reachable through this endpoint while the Listener is Native; it exists for the Custom lists only.
            if (config.BackdropsListener != "Custom") { return NotFound(); }
            var item = _libraryManager.GetItemById(itemId);
            var allowed = Helpers.BackdropFileResolver.ParseAllowedFormats(config.BackdropsAllowedFormats);
            List<string> files;
            if (item is not null) { files = ResolveCustomFiles(item, config, allowed); }
            else if (Helpers.PlayniteBridgeLink.IsGame(itemId)) { files = ResolveGameCustomFiles(itemId, config, allowed); } // a Playnite Bridge game
            else { return NotFound(); }
            if (index < 0 || index >= files.Count) { return NotFound(); }
            return ServeLocalImage(files[index]);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Backdrops: GetCustomImage 404 - the file of {ItemId} index {Index} could not be served", itemId, index);
            return NotFound();
        }
    }

    /// <summary>
    /// One local image file with ETag + one-day cache, like GetStudioImage/GetFolderImage. The URLs carry the same
    /// stamp as "v=", so a changed file is a new URL and an unchanged one a 304, never a stale picture after a
    /// base-name change.
    /// </summary>
    private ActionResult ServeLocalImage(string path)
    {
        // The stream is opened here, inside the caller's try: a PhysicalFile result opens the file only when the
        // result executes, outside any try/catch of the action, so a locked or vanished file would surface as a
        // 500 from Jellyfin's ExceptionMiddleware.
        var contentType = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png", ".webp" => "image/webp", ".gif" => "image/gif", ".svg" => "image/svg+xml", _ => "image/jpeg"
        };
        var etag = "\"" + Helpers.BackdropFileResolver.VersionTag(path) + "\"";
        Response.Headers.ETag = etag;
        Response.Headers.CacheControl = "public, max-age=86400";
        if (Request.Headers.IfNoneMatch.ToString() == etag) { return StatusCode(StatusCodes.Status304NotModified); }
        var stream = System.IO.File.OpenRead(path);
        return File(stream, contentType);
    }

    /// <summary>Runs <paramref name="build"/> once per PoolCacheWindow for a pool key; the key must include everything the pool depends on (category, user, config identity).</summary>
    private (List<GenrePoolImageEntry> Images, bool FromCache) CachedPool(string poolKey, PluginConfiguration config, Func<List<GenrePoolImageEntry>> build)
    {
        var key = "Backdrops:Pool|" + poolKey + "|" + System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(config);
        if (_cache.TryGetValue(key, out List<GenrePoolImageEntry>? cached) && cached is not null)
        {
            return (cached, true);
        }

        var built = build();
        _cache.Set(key, built, new MemoryCacheEntryOptions().SetAbsoluteExpiration(PoolCacheWindow));
        return (built, false);
    }

    /// <summary>
    /// The per-item backdrop pick shared by the pool endpoints. Indices stay the original, unfiltered ones, since
    /// GetImageCacheTag looks up by that index. Main = the candidate with original index 0 if it passed the format
    /// filter, otherwise a random allowed one.
    /// </summary>
    private List<GenrePoolImageEntry> CollectPoolImages(IReadOnlyList<BaseItem> items, bool mainOnly, string? allowedFormatsCsv)
    {
        var config = Plugin.Instance!.Configuration;
        var random = new Random();
        var images = new List<GenrePoolImageEntry>();
        foreach (var item in items)
        {
            var candidates = GetBackdropCandidates(item, config);
            if (candidates.Count == 0) { continue; }
            var main = candidates.FirstOrDefault(c => c.Index == 0);
            images.Add(mainOnly && main is not null ? main : candidates[random.Next(candidates.Count)]);
        }

        return images;
    }

    // Sorts on UserDatas columns, which Jellyfin joins only when the query carries a user.
    private static readonly HashSet<ItemSortBy> UserDataSorts = new()
    {
        ItemSortBy.PlayCount, ItemSortBy.DatePlayed, ItemSortBy.SeriesDatePlayed,
        ItemSortBy.IsPlayed, ItemSortBy.IsUnplayed, ItemSortBy.IsFavoriteOrLiked
    };

    /// <summary>
    /// Shared by the pool endpoints: resolves SortMode + TraversalMode into OrderBy/Order/StartIndex/Limit. Every
    /// mode is capped at the same 100-item pool, reached differently:
    /// - Shuffle/Random: ORDER BY RANDOM() LIMIT 100, no StartIndex.
    /// - BeginAscending/BeginDescending: the real field, StartIndex 0, Limit 100 (the same first/last 100 every visit).
    /// - Random start: the real field with a fresh random StartIndex per visit, so the whole category becomes
    ///   reachable over many visits. Needs the total count first, so baseQuery must carry only the filter fields
    ///   (GenreIds/Tags/IsFavorite/IncludeItemTypes/ParentId), no OrderBy/Limit/StartIndex yet.
    /// </summary>
    private (ItemSortBy OrderBy, SortOrder Order, int? StartIndex, int Limit) ResolveRotationQuery(string sortMode, string traversalMode, bool randomStart, InternalItemsQuery baseQuery)
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
        // UserData sorts need a user on the query (SqliteItemRepository.EnableJoinUserData); without one the query
        // dies with "no such column", so fall back to SortName instead of failing the whole pool.
        if (baseQuery.User is null && UserDataSorts.Contains(orderBy))
        {
            _logger.LogInformation("Backdrops: sort {Sort} needs a user, request is anonymous - using SortName", sortMode);
            orderBy = ItemSortBy.SortName;
        }

        var order = traversalMode == "BeginDescending"
            ? SortOrder.Descending
            : SortOrder.Ascending;

        int? startIndex = null;
        // The Random start position checkbox (Traversal keeps only its two directions).
        if (Helpers.RandomStart.ForTraversal(randomStart))
        {
            var total = _libraryManager.GetCount(baseQuery);
            var maxStart = Math.Max(0, total - PoolLimit);
            startIndex = maxStart > 0 ? new Random().Next(0, maxStart + 1) : 0;
        }

        return (orderBy, order, startIndex, PoolLimit);
    }

    /// <summary>A Resource folder has no sort fields: Random stays Random, everything else is Shuffle.</summary>
    private static string ResourceSortMode(string stored) => stored == "Random" ? "Random" : "Shuffle";

    /// <summary>
    /// The image files of one resource label folder, in name order. genre/studio: key = the item id (N), parentId
    /// picks the Individual subfolder like the pools pick their sub; tag: key = the tag; favorites: key = the
    /// section's BaseItemKind name, title = the page title the client read (As shown).
    /// </summary>
    private List<string> ResolveResourceImages(PluginConfiguration c, string category, string key, Guid? parentId, string? title)
    {
        var allowed = Helpers.BackdropFileResolver.ParseAllowedFormats(c.BackdropsAllowedFormats);
        var meta = _appPaths.InternalMetadataPath;
        switch (category)
        {
            case "genre":
            case "studio":
            {
                if (!Guid.TryParse(key, out var id)) { return new List<string>(); }
                var labelItem = _libraryManager.GetItemById(id);
                if (labelItem is null) { return new List<string>(); }
                var isTv = parentId.HasValue && _libraryManager.GetItemById(parentId.Value) is CollectionFolder { CollectionType: CollectionType.tvshows };
                string? sub = null;
                if (category == "genre")
                {
                    if (c.BackdropsGenreResourceMode == "Individual")
                    {
                        sub = isTv ? c.BackdropsGenreResourceTvShowsFolderName : parentId.HasValue ? c.BackdropsGenreResourceMoviesFolderName : c.BackdropsGenreResourceGlobalFolderName;
                    }

                    return Helpers.ResourceFolderResolver.Resolve(meta, c.BackdropsGenreResourceFolderName, sub, labelItem.Name, allowed);
                }

                if (c.BackdropsStudioResourceMode == "Individual")
                {
                    sub = isTv ? c.BackdropsStudioResourceTvShowsFolderName : c.BackdropsStudioResourceGlobalFolderName;
                }

                return Helpers.ResourceFolderResolver.Resolve(meta, c.BackdropsStudioResourceFolderName, sub, labelItem.Name, allowed);
            }

            case "tag":
                return Helpers.ResourceFolderResolver.Resolve(meta, c.BackdropsTagResourceFolderName, null, key, allowed);
            case "favorites":
            {
                if (!Helpers.ResourceFolderResolver.FavoritesSectionNames.TryGetValue(key, out var english)) { return new List<string>(); }
                if (c.BackdropsFavoritesResourceSectionNames == "AsShown" && !string.IsNullOrWhiteSpace(title))
                {
                    var shown = Helpers.ResourceFolderResolver.Resolve(meta, c.BackdropsFavoritesResourceFolderName, null, title, allowed);
                    if (shown.Count > 0) { return shown; }
                }

                return Helpers.ResourceFolderResolver.Resolve(meta, c.BackdropsFavoritesResourceFolderName, null, english, allowed);
            }

            default:
                return new List<string>();
        }
    }

    /// <summary>
    /// A resource label folder as pool entries: at most 100 drawn at random per visit (kept 30 s like every pool),
    /// each with a ready /Backdrops/resource-image URL whose index points into the full name-ordered list.
    /// </summary>
    private List<GenrePoolImageEntry> ResourcePool(string category, string key, Guid? parentId, string? title, PluginConfiguration c)
    {
        var poolKey = "resource|" + category + "|" + key + "|" + (parentId?.ToString("N") ?? string.Empty) + "|" + (title ?? string.Empty);
        return CachedPool(poolKey, c, () =>
        {
            var files = ResolveResourceImages(c, category, key, parentId, title);
            var indexed = Helpers.ResourceFolderResolver.Cap(Enumerable.Range(0, files.Count).ToList());
            return indexed.Select(i => new GenrePoolImageEntry
            {
                SourceId = Guid.Empty,
                Tag = string.Empty,
                Index = i,
                Url = "/Backdrops/resource-image?category=" + category + "&key=" + Uri.EscapeDataString(key)
                    + (parentId.HasValue ? "&parentId=" + parentId.Value.ToString("N") : string.Empty)
                    + (string.IsNullOrEmpty(title) ? string.Empty : "&title=" + Uri.EscapeDataString(title))
                    + "&index=" + i + "&v=" + Helpers.BackdropFileResolver.VersionTag(files[i])
            }).ToList();
        }).Images;
    }

    /// <summary>
    /// GET /Backdrops/resource-image?category&amp;key[&amp;parentId][&amp;title]&amp;index: one file of a
    /// resource label folder. Anonymous like custom-image (the browser loads it as a plain image); the server
    /// re-resolves the file from the same inputs and never takes a path from the URL; served only while that
    /// category's Source is Resource folder.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("resource-image")]
    public ActionResult GetResourceImage([FromQuery] string category, [FromQuery] string key, [FromQuery] Guid? parentId, [FromQuery] string? title, [FromQuery] int index)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            var sourceMode = category switch
            {
                "genre" => config.BackdropsGenreSourceMode,
                "studio" => config.BackdropsStudioSourceMode,
                "tag" => config.BackdropsTagSourceMode,
                "favorites" => config.BackdropsFavoritesSourceMode,
                _ => string.Empty
            };
            if (sourceMode != "ResourceFolder" || string.IsNullOrEmpty(key)) { return NotFound(); }
            var files = ResolveResourceImages(config, category, key, parentId, title);
            if (index < 0 || index >= files.Count) { return NotFound(); }
            return ServeLocalImage(files[index]);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Backdrops: GetResourceImage 404 - {Category} {Key} index {Index} could not be served", category, key, index);
            return NotFound();
        }
    }

    /// <summary>
    /// The studio's landscape.jpg/.png in the folder Jellyfin's own rule gives (Studio.GetPath: GetValidFilename +
    /// trim + trailing dot removed) instead of the raw name: "Foo: Bar" lives in "Foo  Bar", "Studio Inc." in
    /// "Studio Inc" (Linux).
    /// </summary>
    private static string? ResolveStudioImagePath(string studioName)
    {
        var folder = Studio.GetPath(studioName);
        foreach (var ext in new[] { ".jpg", ".png" })
        {
            var candidate = Path.Combine(folder, "landscape" + ext);
            if (System.IO.File.Exists(candidate)) { return candidate; }
        }
        return null;
    }

    /// <summary>
    /// GET /Backdrops/studio-image?studioId=X: serves the resolved landscape.jpg/png, with the same ETag /
    /// Cache-Control pattern as the plugin's other local image endpoints.
    /// </summary>
    [AllowAnonymous]
    [HttpGet("studio-image")]
    public ActionResult GetStudioImage([FromQuery] Guid studioId)
    {
        try
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
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Backdrops: GetStudioImage 404 - the studio image of {StudioId} could not be served", studioId);
            return NotFound();
        }
    }

    /// <summary>GET /Backdrops/script.js: serves the Backdrops client script.</summary>
    [AllowAnonymous]
    [HttpGet("script.js")]
    public ActionResult GetScript()
    {
        try
        {
            var scriptPath = Helpers.FeatureScripts.Resolve("Jellyfin-ArtworkPlus-Backdrops-v1.js");   // data folder first, then the copy shipped next to the DLL
            if (scriptPath is null)
            {
                _logger.LogWarning("Backdrops: GetScript 404 - backdrops.js not found in the data folder or next to the DLL");
                return NotFound();
            }

            // Revalidate on every load, 304 when unchanged.
            if (Helpers.ScriptCaching.NotModified(Request, Response, Helpers.ScriptCaching.FileTag(scriptPath))) { return StatusCode(StatusCodes.Status304NotModified); }
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
