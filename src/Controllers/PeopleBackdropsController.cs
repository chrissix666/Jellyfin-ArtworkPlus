using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using Jellyfin.Plugin.ArtworkPlus.Helpers;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Net;
// For the GetImageCacheTag(item, ImageType, index) extension method (ImageProcessorExtensions): a fully
// qualified type name does not bring extension methods into scope.
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// A single cached wallpaper entry in backdrops.json: just the URL, no local copy of the pixels (see the class
/// comment of PeopleBackdropsController for why images are hotlinked). Attribution is one static Wallpapers.com
/// line in the admin page, so there is no per-image credit data.
/// </summary>
public class PeopleBackdropsImageEntry
{
    public string Url { get; set; } = string.Empty;
}

/// <summary>
/// A candidate that was found but not accepted, kept for the admin's information only; the client reads only the
/// accepted Images list. Covers only the two image-quality judgments (aspect ratio, text detected); technical
/// failures (download failed, unsafe URL) say nothing about the image and are in the server log.
/// </summary>
public class PeopleBackdropsRejectedEntry
{
    public string Url { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
}

/// <summary>
/// The full contents of a person's own backdrops.json file.
/// </summary>
public class PeopleBackdropsCacheFile
{
    public List<PeopleBackdropsImageEntry> Images { get; set; } = new();

    public List<PeopleBackdropsRejectedEntry> RejectedImages { get; set; } = new();

    /// <summary>
    /// Why a cache file holds 0 images: "NotFound" (Wallpapers.com answered 404 for the slug), "NoCandidates" (200
    /// with an empty list), "AllRejected" (candidates existed, none passed the filters), "NoSlug" (name without
    /// Latin letters). null on files with images and on files written without a reason. Only these definite
    /// outcomes are cached; a lookup that failed for an unknown reason (network, 401/403/429, 5xx) never writes a file.
    /// </summary>
    public string? EmptyReason { get; set; }

    /// <summary>UTC time of the lookup that produced an empty file; after EmptyCacheRetryDays the file counts as absent.</summary>
    public DateTime? CheckedAt { get; set; }

    /// <summary>Transient, never serialized: the lookup failed for a reason that says nothing about the person (network, auth, rate limit, server error).</summary>
    [JsonIgnore]
    public bool LookupFailed { get; set; }
}

/// <summary>
/// One line of the NDJSON (newline-delimited JSON) stream GetPeopleBackdrops sends, so the client can show the
/// first accepted image as soon as it is found instead of waiting for the whole (first-time, possibly
/// several-second) population flow.
///
/// One flat DTO with a Type discriminator rather than polymorphic serialization: a small first-party protocol
/// between this controller and the client, not a public API.
///
/// Exactly one "Header" line comes first (also when the request is not applicable; Reason is set then), then zero
/// or more "Image" lines (one per accepted image, sent as soon as it is accepted), then exactly one "Done" line so
/// the client knows the stream is complete, which matters when zero images arrive.
/// </summary>
public class PeopleBackdropsStreamLine
{
    public string Type { get; set; } = string.Empty; // "Header" | "Image" | "Done"

    /// <summary>The source the Header announces ("WallpapersCom" | "Appearances" | "Folder"); the client chooses its handover window from it.</summary>
    public string? SourceMode { get; set; }

    // Only populated when Type == "Header".
    public bool IsApplicable { get; set; }
    public string? Reason { get; set; }
    public int CycleTimeMs { get; set; }
    public string? OrderMode { get; set; }
    public bool KenBurnsEnabled { get; set; }
    public int KenBurnsZoomMs { get; set; }
    public int KenBurnsPanMs { get; set; }

    // Only populated when Type == "Image".
    public string? Url { get; set; }
}

/// <summary>
/// People Backdrops: shows wallpapers from Wallpapers.com (or the person's appearances / own folder) on Person
/// detail pages and their filmography pages.
/// - Hotlinking, not downloading: only Wallpapers.com URLs are stored (backdrops.json, one per person, in that
///   person's Jellyfin metadata folder); the browser loads the pixels at display time, the plugin never proxies
///   or stores them.
/// - backdrops.json is the cache signal. Present = pure read, never re-requested (an empty result is retried after
///   EmptyCacheRetryDays). Absent = run the population flow once, then write it. "Wipe cache" removes it.
/// - Population flow: escalating `limit` calls to the Wallpapers.com keyword API (start at target x 2, double up
///   to the API's maximum of 60), checking only newly appeared candidates each time. Each candidate's `webp` image
///   is downloaded once and checked against a strict 16:9 lock and (if enabled) text detection, both on the same
///   bytes.
/// - BackdropsTabEnabled is the master switch; there is no separate enable field, the four ShowOn fields are the
///   per-feature switches. People Backdrops is a sibling of the Detail View backdrops under the same tab, so it
///   goes dark with the tab, not with the Detail View switch.
/// </summary>
[ApiController]
[Route("PeopleBackdrops")]
// Deliberately no class-level [AllowAnonymous]: it overrides every [Authorize] on the actions (Microsoft Learn's
// authorization docs, dotnet/aspnetcore #56310), including WipeCache's
// [Authorize(Policy = Policies.RequiresElevation)], which would leave WipeCache open to anyone.
// [AllowAnonymous] sits on GetPeopleBackdrops instead. GetFolderImage carries no attribute and is anonymous all
// the same: Jellyfin 10.10.7 registers no fallback authorization policy (only a DefaultPolicy where [Authorize]
// stands, Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs), so an attribute-less action is
// reachable without a token, which the client's <img> requests rely on.
public class PeopleBackdropsController : ControllerBase
{
    private const string WallpapersApiBase = "https://wallpapers.com/api/v1";

    // Strict 16:9 lock, not just any landscape image. The small tolerance covers pixel-rounded dimensions.
    private const double TargetAspectRatio = 16.0 / 9.0;
    private const double AspectRatioTolerance = 0.02;

    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<PeopleBackdropsController> _logger;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly MediaBrowser.Controller.Drawing.IImageProcessor _imageProcessor;

    // Request coalescing: several concurrent requests for the same person (the client's navigation burst while
    // the first one is still populating, or several visitors on the same actor) would each see backdrops.json as
    // missing and run the whole population flow in parallel: redundant Wallpapers.com calls against its rate
    // limit, redundant downloads and conflicting writes of the same file. Concurrent callers for one personId
    // await the same in-flight Lazy<Task>. Entries are removed when the task completes (success or failure), so
    // the dictionary holds only people currently being populated.
    private static readonly ConcurrentDictionary<Guid, Lazy<Task<PeopleBackdropsCacheFile>>> PopulateLocks = new();

    // Indented, so backdrops.json is readable with one URL per line. One shared instance, as System.Text.Json
    // caches type metadata per options instance.
    private static readonly JsonSerializerOptions IndentedJsonOptions = new() { WriteIndented = true };

    /// <summary>Upper bound for one candidate image download (a wallpaper is 0.2-6 MB).</summary>
    private const long MaxCandidateImageBytes = 25L * 1024 * 1024;

    private readonly MediaBrowser.Controller.Library.IUserManager _userManager;

    public PeopleBackdropsController(
        ILibraryManager libraryManager,
        ILogger<PeopleBackdropsController> logger,
        IHttpClientFactory httpClientFactory,
        MediaBrowser.Controller.Drawing.IImageProcessor imageProcessor,
        MediaBrowser.Controller.Library.IUserManager userManager)
    {
        _userManager = userManager;
        _libraryManager = libraryManager;
        _logger = logger;
        _httpClientFactory = httpClientFactory;
        _imageProcessor = imageProcessor;
    }

    /// <summary>
    /// GET /PeopleBackdrops/{personId}?scope=info|movie|series|episode, the same "scope" convention as RedCarpet
    /// (missing = "info"). The server checks whether personId is a Person and whether the scope is enabled; the
    /// client does not detect the page type, it asks and trusts the result.
    ///
    /// Streams NDJSON (see PeopleBackdropsStreamLine) so the client can show the first accepted image while a
    /// first-time population is still running. The return type is a plain Task: the lines are written to
    /// Response.Body directly, since the MVC result pipeline produces one complete JSON object only.
    /// </summary>
    [HttpGet("{personId}")]
    [AllowAnonymous]
    public async Task GetPeopleBackdrops([FromRoute] Guid personId, [FromQuery] string? scope)
    {
        // NDJSON has no single registered MIME type; this private protocol needs only the client to agree on it.
        Response.ContentType = "application/x-ndjson";
        var anyLineWritten = false;

        try
        {
            var config = Plugin.Instance!.Configuration;

        // BackdropsTabEnabled is the master switch shared with the Detail View backdrops (see the class comment).
            if (!config.BackdropsTabEnabled)
            {
                _logger.LogDebug("PeopleBackdrops: GetPeopleBackdrops - BackdropsTabEnabled is off (shared master switch), not applicable for {PersonId}", personId);
                await WriteNotApplicableStreamAsync("BackdropsTabEnabled (shared master switch) is off in plugin settings", config).ConfigureAwait(false);
                return;
            }

            // The feature's own switch, below the shared tab-level one, like every other Backdrops category.
            if (!config.PeopleBackdropsEnabled)
            {
                _logger.LogDebug("PeopleBackdrops: GetPeopleBackdrops - PeopleBackdropsEnabled is off, not applicable for {PersonId}", personId);
                await WriteNotApplicableStreamAsync("PeopleBackdropsEnabled is off in plugin settings", config).ConfigureAwait(false);
                return;
            }

            if (!IsScopeEnabled(scope, config))
            {
                _logger.LogDebug("PeopleBackdrops: GetPeopleBackdrops - scope \"{Scope}\" is disabled in settings for {PersonId}", scope ?? "info", personId);
                await WriteNotApplicableStreamAsync("The \"Show on\" setting for scope \"" + (scope ?? "info") + "\" is unchecked in plugin settings", config).ConfigureAwait(false);
                return;
            }

            var item = _libraryManager.GetItemById(personId);
            if (item is not Person person)
            {
                _logger.LogInformation("PeopleBackdrops: GetPeopleBackdrops - {PersonId} isn't a Person (actual type: {ActualType}), skipping", personId, item?.GetType().Name ?? "null/not found");
                await WriteNotApplicableStreamAsync("The requested id does not resolve to a Person item (actual type: " + (item?.GetType().Name ?? "null/not found") + ")", config).ConfigureAwait(false);
                return;
            }

            // Appearances mode: the person's own titles instead of the wallpaper cache, same streaming protocol.
            // WallpapersCom (the default) falls through to the code below.
            if (config.PeopleBackdropsSourceMode == "Appearances")
            {
                await WriteAppearancesStreamAsync(person, config).ConfigureAwait(false);
                return;
            }

            // Folder mode: local files only, independent of the wallpaper cache and Appearances, same streaming
            // protocol.
            if (config.PeopleBackdropsSourceMode == "Folder")
            {
                await WriteFolderStreamAsync(person, config).ConfigureAwait(false);
                return;
            }

            // The Header goes out before population starts: the client needs the order/cycle/Ken Burns settings at
            // once, however long finding images takes. IsApplicable=true promises zero or more Image lines and a
            // final Done line, not that any image exists.
            await WriteStreamLineAsync(new PeopleBackdropsStreamLine
            {
                Type = "Header",
                IsApplicable = true,
                SourceMode = config.PeopleBackdropsSourceMode,
                CycleTimeMs = config.PeopleBackdropsCycleTimeMs,
                OrderMode = config.PeopleBackdropsOrderMode,
                KenBurnsEnabled = config.PeopleBackdropsKenBurnsEnabled,
                KenBurnsZoomMs = config.PeopleBackdropsKenBurnsZoomMs,
                KenBurnsPanMs = config.PeopleBackdropsKenBurnsPanMs
            }).ConfigureAwait(false);
            anyLineWritten = true;

            var (cacheFile, alreadyStreamed) = await ReadOrPopulateCacheFileAsync(
                person,
                config,
                async image => await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Image", Url = image.Url }).ConfigureAwait(false)).ConfigureAwait(false);

            if (cacheFile is null)
            {
                _logger.LogWarning("PeopleBackdrops: GetPeopleBackdrops - ReadOrPopulateCacheFileAsync returned null for {PersonName} ({PersonId}) - likely a corrupt cache file that also failed to repopulate; check preceding log entries", person.Name, personId);
                await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Done" }).ConfigureAwait(false);
                return;
            }

            // Reached for a cache hit (alreadyStreamed=false) or a "joiner" (a concurrent request that only awaited
            // another request's population, see ReadOrPopulateCacheFileAsync). Nothing has been streamed to this
            // response yet, so every image is written now, through the same Image lines as the live path, so the
            // client has a single parsing path.
            if (!alreadyStreamed)
            {
                // Shuffle/Random reorder a copy, never cacheFile.Images itself: for a joiner, cacheFile is the
                // instance held in PopulateLocks and possibly shared by several concurrent joiners, so an in-place
                // shuffle would race. Random.Shared is thread-safe across concurrent requests.
                // Sequential keeps the same order on purpose.
                var streamOrder = config.PeopleBackdropsOrderMode == "Shuffle" || config.PeopleBackdropsOrderMode == "Random"
                    ? new List<PeopleBackdropsImageEntry>(cacheFile.Images)
                    : cacheFile.Images;
                if (streamOrder != cacheFile.Images)
                {
                    Random.Shared.Shuffle(System.Runtime.InteropServices.CollectionsMarshal.AsSpan(streamOrder));
                }
                else if (config.PeopleBackdropsRandomStart)
                {
                    // Random start position: Sequential keeps its order, only the entry point moves.
                    streamOrder = Helpers.RandomStart.Rotate(cacheFile.Images);
                }

                foreach (var image in streamOrder)
                {
                    await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Image", Url = image.Url }).ConfigureAwait(false);
                }
            }

            if (cacheFile.Images.Count == 0)
            {
                _logger.LogInformation("PeopleBackdrops: GetPeopleBackdrops - {PersonName} ({PersonId}) has 0 accepted images (no wallpapers found, or all candidates rejected by the aspect-ratio/text filters) - this is a legitimate, silent outcome, not an error; use \"Wipe cache\" in plugin settings to retry after e.g. changing filter settings", person.Name, personId);
            }
            else
            {
                _logger.LogDebug("PeopleBackdrops: GetPeopleBackdrops - served {Count} image(s) for {PersonName} ({PersonId}), scope \"{Scope}\"", cacheFile.Images.Count, person.Name, personId, scope ?? "info");
            }

            await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Done" }).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PeopleBackdrops: Unexpected error in GetPeopleBackdrops for {PersonId}, scope \"{Scope}\"", personId, scope ?? "info");

            // Nothing written yet: a clean Header + Done pair gives the client a well-formed stream (its usual "not
            // applicable" path). A Header already sent: a bare Done lets the client stop waiting instead of
            // hanging until its read times out.
            try
            {
                if (!anyLineWritten)
                {
                    await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Header", IsApplicable = false, Reason = "Internal server error - see the Jellyfin server log for the exception (search for \"Unexpected error in GetPeopleBackdrops\")" }).ConfigureAwait(false);
                }

                await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Done" }).ConfigureAwait(false);
            }
            catch (Exception writeEx)
            {
                // The response is unusable (e.g. the connection is gone); the real error is logged above.
                _logger.LogDebug(writeEx, "PeopleBackdrops: GetPeopleBackdrops - failed to write the error-path Done line, response is likely already unusable");
            }
        }
    }

    /// <summary>
    /// The early "not applicable" exits: a well-formed Header + Done stream with no Image lines, which looks like a
    /// legitimate "0 images" outcome to the client. The settings fields are filled anyway; the client ignores them
    /// while IsApplicable is false.
    /// </summary>
    private async Task WriteNotApplicableStreamAsync(string reason, PluginConfiguration config)
    {
        await WriteStreamLineAsync(new PeopleBackdropsStreamLine
        {
            Type = "Header",
            IsApplicable = false,
            Reason = reason,
            CycleTimeMs = config.PeopleBackdropsCycleTimeMs,
            OrderMode = config.PeopleBackdropsOrderMode,
            KenBurnsEnabled = config.PeopleBackdropsKenBurnsEnabled,
            KenBurnsZoomMs = config.PeopleBackdropsKenBurnsZoomMs,
            KenBurnsPanMs = config.PeopleBackdropsKenBurnsPanMs
        }).ConfigureAwait(false);
        await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Done" }).ConfigureAwait(false);
    }

    /// <summary>The request user from Jellyfin's auth claim (null on anonymous calls).</summary>
    private JfUser? GetRequestUser()
    {
        var claim = User?.FindFirst("Jellyfin-UserId")?.Value;
        if (string.IsNullOrEmpty(claim) || !Guid.TryParse(claim, out var userId)) { return null; }
        return _userManager.GetUserById(userId);
    }

    /// <summary>
    /// Appearances mode: the person's own movies/shows instead of Wallpapers.com, streamed through the same
    /// Header/Image/Done protocol, so the client needs no special case. The URL is Jellyfin's own image route
    /// (/Items/{id}/Images/Backdrop/{index}?tag=..., ImageController), which the client renders like any other URL.
    /// </summary>
    private async Task WriteAppearancesStreamAsync(Person person, PluginConfiguration config)
    {
        // Appearances has its own Order field with real Jellyfin sort fields (not just Sequential/Shuffle/Random)
        // and its own Main/All backdrop choice per person.
        var sortMode = config.PeopleBackdropsAppearancesSortMode;

        await WriteStreamLineAsync(new PeopleBackdropsStreamLine
        {
            Type = "Header",
            IsApplicable = true,
            SourceMode = config.PeopleBackdropsSourceMode,
            CycleTimeMs = config.PeopleBackdropsCycleTimeMs,
            OrderMode = sortMode,
            KenBurnsEnabled = config.PeopleBackdropsKenBurnsEnabled,
            KenBurnsZoomMs = config.PeopleBackdropsKenBurnsZoomMs,
            KenBurnsPanMs = config.PeopleBackdropsKenBurnsPanMs
        }).ConfigureAwait(false);

        var includeTypes = config.PeopleBackdropsAppearancesFilter switch
        {
            "Movies" => new[] { BaseItemKind.Movie },
            "Series" => new[] { BaseItemKind.Series },
            _ => new[] { BaseItemKind.Movie, BaseItemKind.Series }
        };

        // "Shuffle"/"Random" fetch in a stable order (SortName) and let the client's rotation engine reorder; a
        // real ItemSortBy name sorts on the server and the client plays that order (Core.js treats anything but
        // "Shuffle"/"Random" as Sequential, as for Genre/Tag/Favorites).
        var orderByField = ItemSortBy.SortName;
        if (sortMode != "Shuffle" && sortMode != "Random" && Enum.TryParse<ItemSortBy>(sortMode, out var parsedSortField))
        {
            orderByField = parsedSortField;
        }
        // Traversal + the request user on the query. UserData sorts (PlayCount, DatePlayed, ...) need a user, which
        // Jellyfin joins only then; without one the query fails ("no such column"), so fall back to SortName.
        var traversal = config.PeopleBackdropsAppearancesTraversalMode;
        var order = traversal == "BeginDescending" ? SortOrder.Descending : SortOrder.Ascending;
        var requestUser = GetRequestUser();
        if (requestUser is null && (orderByField == ItemSortBy.PlayCount || orderByField == ItemSortBy.DatePlayed || orderByField == ItemSortBy.SeriesDatePlayed
            || orderByField == ItemSortBy.IsPlayed || orderByField == ItemSortBy.IsUnplayed || orderByField == ItemSortBy.IsFavoriteOrLiked))
        {
            orderByField = ItemSortBy.SortName;
        }
        var appearancesQuery = new MediaBrowser.Controller.Entities.InternalItemsQuery(requestUser)
        {
            PersonIds = new[] { person.Id },
            IncludeItemTypes = includeTypes,
            Recursive = true,
            OrderBy = new[] { (orderByField, order) }
        };
        // The Random start position checkbox.
        if (Helpers.RandomStart.ForTraversal(config.PeopleBackdropsAppearancesRandomStart))
        {
            var total = _libraryManager.GetCount(appearancesQuery);
            var maxStart = Math.Max(0, total - 100);
            appearancesQuery.StartIndex = maxStart > 0 ? new Random().Next(0, maxStart + 1) : 0;
            appearancesQuery.Limit = 100;
        }
        var items = _libraryManager.GetItemList(appearancesQuery);

        var extensions = (config.BackdropsAllowedFormats ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .Distinct()
            .ToArray();

        var mainOnly = config.PeopleBackdropsAppearancesMainOnly == "Main";
        var random = new Random();
        var written = 0;
        foreach (var appearanceItem in items)
        {
            // Honours the global Listener. Custom = the plugin's own file resolution (Jellyfin's rules, configured
            // base name) served via /Backdrops/custom-image; Native = the database images. Main = original index 0
            // in both cases.
            string? url = null;
            if (config.BackdropsListener == "Custom")
            {
                var folder = appearanceItem.IsFileProtocol ? appearanceItem.ContainingFolderPath : null;
                if (string.IsNullOrEmpty(folder)) { continue; }
                var baseName = string.IsNullOrWhiteSpace(config.BackdropsCustomBaseName) ? "backdrop" : config.BackdropsCustomBaseName.Trim();
                var allowed = Helpers.BackdropFileResolver.ParseAllowedFormats(config.BackdropsAllowedFormats);
                var files = Helpers.BackdropFileResolver.ResolveLikeJellyfin(folder, appearanceItem.IsFolder ? null : appearanceItem.FileNameWithoutExtension, appearanceItem.IsInMixedFolder, baseName, allowed);
                if (files.Count == 0) { continue; }
                var customIndex = mainOnly ? 0 : random.Next(files.Count);
                url = "/Backdrops/custom-image?itemId=" + appearanceItem.Id.ToString("N") + "&index=" + customIndex + "&v=" + Helpers.BackdropFileResolver.VersionTag(files[customIndex]);
            }
            else
            {
                var backdrops = appearanceItem.GetImages(MediaBrowser.Model.Entities.ImageType.Backdrop).ToList();
                var allowedIndices = new List<int>();
                for (var i = 0; i < backdrops.Count; i++)
                {
                    if (extensions.Length == 0 || extensions.Contains(Path.GetExtension(backdrops[i].Path), StringComparer.OrdinalIgnoreCase))
                    {
                        allowedIndices.Add(i);
                    }
                }
                if (allowedIndices.Count == 0) { continue; }

                // Main = the file without a number, which Jellyfin's LocalImageProvider.PopulateBackdrops always
                // adds first, so it is index 0.
                var index = mainOnly && allowedIndices.Contains(0)
                    ? 0
                    : allowedIndices[random.Next(allowedIndices.Count)];

                var tag = _imageProcessor.GetImageCacheTag(appearanceItem, MediaBrowser.Model.Entities.ImageType.Backdrop, index);
                if (tag is null) { continue; }
                url = "/Items/" + appearanceItem.Id + "/Images/Backdrop/" + index + "?tag=" + Uri.EscapeDataString(tag);
            }
            await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Image", Url = url }).ConfigureAwait(false);
            written++;
        }

        _logger.LogDebug(
            "PeopleBackdrops: WriteAppearancesStreamAsync - {PersonName} ({PersonId}), filter={Filter}, itemsFound={ItemCount}, imagesWritten={Written}",
            person.Name, person.Id, config.PeopleBackdropsAppearancesFilter, items.Count, written);

        await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Done" }).ConfigureAwait(false);
    }

    /// <summary>
    /// Folder mode: local files in the person's own folder only, no Wallpapers.com call, no library query. File
    /// names per <see cref="ResolveFolderBackdropPaths"/>. A one-image list needs no special case: the client's
    /// rotation engine shows a single image statically.
    /// </summary>
    private async Task WriteFolderStreamAsync(Person person, PluginConfiguration config)
    {
        await WriteStreamLineAsync(new PeopleBackdropsStreamLine
        {
            Type = "Header",
            IsApplicable = true,
            SourceMode = config.PeopleBackdropsSourceMode,
            CycleTimeMs = config.PeopleBackdropsCycleTimeMs,
            OrderMode = config.PeopleBackdropsFolderOrderMode,
            KenBurnsEnabled = config.PeopleBackdropsKenBurnsEnabled,
            KenBurnsZoomMs = config.PeopleBackdropsKenBurnsZoomMs,
            KenBurnsPanMs = config.PeopleBackdropsKenBurnsPanMs
        }).ConfigureAwait(false);

        var personFolder = GetPersonFolder(person);
        var paths = ResolveFolderBackdropPaths(personFolder, config.PeopleBackdropsFolderBackdropFiles, config.BackdropsAllowedFormats, config.PeopleBackdropsFolderBaseName);

        // Random start position: the URLs keep their file index, only the stream order is rotated.
        var folderUrls = new List<string>(paths.Count);
        for (var i = 0; i < paths.Count; i++)
        {
            folderUrls.Add("/PeopleBackdrops/" + person.Id + "/folder-image?index=" + i + "&v=" + Helpers.BackdropFileResolver.VersionTag(paths[i]));
        }
        if (config.PeopleBackdropsFolderRandomStart && config.PeopleBackdropsFolderOrderMode == "Sequential") { folderUrls = Helpers.RandomStart.Rotate(folderUrls); }
        foreach (var url in folderUrls)
        {
            await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Image", Url = url }).ConfigureAwait(false);
        }

        _logger.LogDebug(
            "PeopleBackdrops: WriteFolderStreamAsync - {PersonName} ({PersonId}), mode={Mode}, folder=\"{Folder}\", imagesWritten={Written}",
            person.Name, person.Id, config.PeopleBackdropsFolderBackdropFiles, personFolder, paths.Count);

        await WriteStreamLineAsync(new PeopleBackdropsStreamLine { Type = "Done" }).ConfigureAwait(false);
    }

    /// <summary>
    /// Shared by WriteFolderStreamAsync and GetFolderImage: both need the same ordered list, so a streamed index
    /// resolves to the same file when it is requested. Uses Helpers/BackdropFileResolver.ResolvePlain with the
    /// configurable base name (default "backdrop"): "Single" = "name.ext" only; "Multiple" = "name.ext" as index 0,
    /// then name1..name20, the same rule as Jellyfin's backdrop stage and the episode files. Extensions follow
    /// BackdropsAllowedFormats, ".jpg" when the list is empty.
    /// </summary>
    internal static List<string> ResolveFolderBackdropPaths(string personFolder, string backdropFilesMode, string? allowedFormatsCsv, string? baseName = null)
    {
        var name = string.IsNullOrWhiteSpace(baseName) ? "backdrop" : baseName.Trim();
        var allowed = Helpers.BackdropFileResolver.ParseAllowedFormats(allowedFormatsCsv) ?? new[] { ".jpg" };
        return Helpers.BackdropFileResolver.ResolvePlain(personFolder, name, backdropFilesMode == "Multiple", allowed);
    }

    /// <summary>
    /// GET /PeopleBackdrops/{personId}/folder-image?index=N: serves one of the resolved local backdrop files, with
    /// the same ETag / Cache-Control convention as the plugin's other local image endpoints.
    /// </summary>
    [HttpGet("{personId}/folder-image")]
    public ActionResult GetFolderImage([FromRoute] Guid personId, [FromQuery] int index, [FromQuery] string? mode)
    {
        // A locked or vanished file answers 404 + a warning, not a 500.
        try
        {
            var config = Plugin.Instance!.Configuration;
            var item = _libraryManager.GetItemById(personId);
            if (item is not Person person)
            {
                return NotFound();
            }

            // "mode" lets the Favorites People pool address its own Backdrop files setting (Single/Multiple);
            // without it the index would resolve against the standalone People setting.
            var filesMode = mode == "Single" || mode == "Multiple" ? mode : config.PeopleBackdropsFolderBackdropFiles;
            var personFolder = GetPersonFolder(person);
            var paths = ResolveFolderBackdropPaths(personFolder, filesMode, config.BackdropsAllowedFormats, config.PeopleBackdropsFolderBaseName);
            if (index < 0 || index >= paths.Count)
            {
                return NotFound();
            }

            var fullPath = paths[index];
            if (!System.IO.File.Exists(fullPath))
            {
                return NotFound();
            }

            var contentType = Path.GetExtension(fullPath).ToLowerInvariant() switch
            {
                ".webp" => "image/webp",
                ".png" => "image/png",
                ".gif" => "image/gif",
                ".svg" => "image/svg+xml",
                _ => "image/jpeg"
            };
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
            _logger.LogWarning(ex, "PeopleBackdrops: GetFolderImage 404 - the folder image of {PersonId} index {Index} could not be served", personId, index);
            return NotFound();
        }
    }

    /// <summary>
    /// Serializes one line, writes it and flushes at once. The explicit FlushAsync is the point: without it the
    /// response buffering can hold several lines back and send them together, defeating the streaming.
    /// </summary>
    private async Task WriteStreamLineAsync(PeopleBackdropsStreamLine line)
    {
        var json = JsonSerializer.Serialize(line);
        var bytes = Encoding.UTF8.GetBytes(json + "\n");
        await Response.Body.WriteAsync(bytes).ConfigureAwait(false);
        await Response.Body.FlushAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// POST /PeopleBackdrops/test-api-key: an indicator whether the API key works. Makes one tiny request against
    /// Wallpapers.com (limit=1, a slug known to have results, so a working key never reads as "0 results") with
    /// the given or saved key, like a real population request. Admin-only like WipeCache: it triggers an outbound
    /// request on demand.
    ///
    /// Limitation: what Wallpapers.com answers for an invalid key is not known for certain. A status code only
    /// proves its server responded (as opposed to DNS/timeout/network failures); the message reports the status
    /// that came back and leaves the judgement to the admin instead of claiming the key is wrong.
    /// </summary>
    [HttpPost("test-api-key")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public async Task<ActionResult> TestApiKey([FromQuery] string? apiKey)
    {
        var config = Plugin.Instance!.Configuration;
        // Prefers the key from the admin page's input field (possibly not saved yet) over the saved config, so a
        // freshly typed key can be tested without saving; an empty field tests the saved key (or no key).
        var keyToTest = !string.IsNullOrEmpty(apiKey) ? apiKey : config.PeopleBackdropsApiKey;
        var hasKey = !string.IsNullOrEmpty(keyToTest);
        _logger.LogInformation("PeopleBackdrops: TestApiKey - testing connectivity to Wallpapers.com ({KeyState})", hasKey ? "with an API key" : "without an API key");

        var httpClient = _httpClientFactory.CreateClient(NamedClient.Default);
        if (hasKey)
        {
            httpClient.DefaultRequestHeaders.Remove("X-API-Key");
            httpClient.DefaultRequestHeaders.Add("X-API-Key", keyToTest);
        }

        try
        {
            var url = WallpapersApiBase + "/keyword/keanu-reeves?limit=1";
            var response = await httpClient.GetFromJsonAsync<WallpapersApiKeywordResponse>(url).ConfigureAwait(false);
            var count = response?.Items?.Count ?? 0;

            _logger.LogInformation("PeopleBackdrops: TestApiKey - succeeded, {Count} result(s) for the test query", count);
            return Ok(new
            {
                success = true,
                usedApiKey = hasKey,
                message = count > 0
                    ? "Connected successfully" + (hasKey ? " with your API key." : " (no API key configured).")
                    : "Connected successfully, but the test query itself returned 0 results - this would be unusual for \"keanu-reeves\" specifically, worth a second look even though the connection itself worked."
            });
        }
        catch (HttpRequestException ex)
        {
            // A status code at least confirms Wallpapers.com's server responded (as opposed to a network failure
            // below); what a specific code means for this API is not certain (see the doc comment).
            _logger.LogWarning(ex, "PeopleBackdrops: TestApiKey - HTTP error testing Wallpapers.com connectivity, status {StatusCode}", ex.StatusCode);
            return Ok(new
            {
                success = false,
                usedApiKey = hasKey,
                message = "Request failed with HTTP status " + (ex.StatusCode.HasValue ? ((int)ex.StatusCode.Value) + " (" + ex.StatusCode.Value + ")" : "unknown") + (hasKey ? " - this could mean the API key is invalid, but has not been specifically confirmed against a known-bad key; check the Jellyfin server log for the full detail." : ".")
            });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PeopleBackdrops: TestApiKey - unexpected error testing Wallpapers.com connectivity");
            return Ok(new
            {
                success = false,
                usedApiKey = hasKey,
                message = "Request failed: " + ex.Message + " - this looks like a network/connectivity issue (DNS, timeout, firewall) rather than an API key problem specifically; check the Jellyfin server log for the full detail."
            });
        }
    }

    /// <summary>
    /// POST /PeopleBackdrops/wipe: deletes every person's backdrops.json across the library. Runs at once on click
    /// in the admin page (a one-time action, not a setting). Iterates the Person items Jellyfin knows rather than
    /// scanning the People folder on disk, so it never touches anything Jellyfin does not know about.
    /// </summary>
    [HttpPost("wipe")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult WipeCache()
    {
        _logger.LogInformation("PeopleBackdrops: WipeCache - starting wipe of all cached backdrops.json files");
        try
        {
            var people = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Person }
            });

            var deletedCount = 0;
            foreach (var item in people)
            {
                if (item is not Person person)
                {
                    continue;
                }

                var jsonPath = GetCacheFilePath(person);
                if (System.IO.File.Exists(jsonPath))
                {
                    System.IO.File.Delete(jsonPath);
                    deletedCount++;
                }
            }

            _logger.LogInformation("PeopleBackdrops: WipeCache - deleted {Count} backdrops.json file(s)", deletedCount);
            return Ok(new { deleted = deletedCount });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PeopleBackdrops: Unexpected error in WipeCache");
            return StatusCode(StatusCodes.Status500InternalServerError);
        }
    }

    /// <summary>
    /// "info"/no parameter -> the person's own detail page. The same four-way mapping as RedCarpet's
    /// IsScopeEnabled, not shared because the two features have entirely separate ShowOn fields.
    /// </summary>
    private static bool IsScopeEnabled(string? scope, PluginConfiguration config)
    {
        return scope switch
        {
            "movie" => config.PeopleBackdropsShowOnMovies,
            "series" => config.PeopleBackdropsShowOnTvShows,
            "episode" => config.PeopleBackdropsShowOnEpisodes,
            _ => config.PeopleBackdropsShowOnInfoPage // "info" or no parameter
        };
    }

    /// <summary>
    /// Jellyfin's own folder rule (Person.GetPath in MediaBrowser.Controller.Entities.Person): the first
    /// alphanumeric character of the sanitized name, unchanged in case, as a subfolder under PeoplePath, then the
    /// full sanitized name. Computed from person.Name rather than trusting person.Path, which can lag behind a
    /// renamed person until Jellyfin's refresh catches up. Internal: BackdropsController reuses it for the
    /// Favorites People pool.
    /// </summary>
    internal static string GetPersonFolder(Person person)
    {
        return Person.GetPath(person.Name);
    }

    /// <summary>How long an empty lookup result is trusted before Wallpapers.com is asked again.</summary>
    internal const int EmptyCacheRetryDays = 7;

    /// <summary>
    /// True when a cache file holds no images and should be treated as absent: an empty file without CheckedAt, or
    /// an empty result older than EmptyCacheRetryDays. Files with images never expire (only Wipe cache removes
    /// them).
    /// </summary>
    internal static bool IsEmptyCacheExpired(PeopleBackdropsCacheFile? file)
    {
        if (file is null) { return true; }
        return EmptyCachePolicy.IsExpired(file.Images.Count, file.CheckedAt, DateTime.UtcNow, EmptyCacheRetryDays);
    }

    internal static string GetCacheFilePath(Person person)
    {
        return Path.Combine(GetPersonFolder(person), "backdrops.json");
    }

    /// <summary>
    /// The caching rule in one method: file present -> pure read (an expired empty result counts as absent, see
    /// IsEmptyCacheExpired). File absent -> run the population flow once and write the result, also with fewer
    /// images than the target; a definite empty result is written too, so a person without qualifying wallpapers
    /// does not cost a Wallpapers.com call on every page view. Internal: BackdropsController reuses the same rule
    /// for the Favorites People pool.
    /// </summary>
    /// <returns>
    /// The cache file (or null if it could not be read or populated), plus whether its images were already streamed
    /// through onImageAccepted during this call: true only when this request started a fresh population. False for
    /// a cache hit (the caller must stream the images itself) and for a "joiner" (this request only awaited
    /// another request's population, whose streaming went to that other response).
    /// </returns>
    internal async Task<(PeopleBackdropsCacheFile? File, bool AlreadyStreamed)> ReadOrPopulateCacheFileAsync(Person person, PluginConfiguration config, Func<PeopleBackdropsImageEntry, Task> onImageAccepted)
    {
        var jsonPath = GetCacheFilePath(person);

        if (System.IO.File.Exists(jsonPath))
        {
            try
            {
                var existingJson = await System.IO.File.ReadAllTextAsync(jsonPath).ConfigureAwait(false);
                var parsed = JsonSerializer.Deserialize<PeopleBackdropsCacheFile>(existingJson);
                if (IsEmptyCacheExpired(parsed))
                {
                    // An empty result is remembered for EmptyCacheRetryDays (no Wallpapers.com call on every
                    // visit), then checked again.
                    _logger.LogInformation("PeopleBackdrops: ReadOrPopulateCacheFileAsync - empty cache for {PersonName} ({Reason}, checked {CheckedAt}) is older than {Days} days - looking up Wallpapers.com again", person.Name, parsed?.EmptyReason ?? "unspecified", parsed?.CheckedAt, EmptyCacheRetryDays);
                }
                else
                {
                    _logger.LogDebug("PeopleBackdrops: ReadOrPopulateCacheFileAsync - cache hit for {PersonName} at \"{Path}\" ({Count} image(s){Empty})", person.Name, jsonPath, parsed?.Images.Count ?? 0, parsed?.EmptyReason is null ? string.Empty : ", empty: " + parsed.EmptyReason);
                    return (parsed, false);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "PeopleBackdrops: ReadOrPopulateCacheFileAsync - failed to read/parse existing backdrops.json at \"{Path}\", treating as absent and repopulating", jsonPath);
                // Falls through to the population flow, like a missing file: a corrupt cache file must not
                // strand a person with nothing.
            }
        }

        // Request coalescing (see PopulateLocks): only one population flow runs per personId at a time; everyone
        // else awaits the same Task. Only the owner's onImageAccepted fires, since the owner's Lazy is the one stored.
        // Atomic on purpose: a separate ContainsKey check before GetOrAdd would leave a window in which a request
        // believes it is the owner while it got another request's Lazy, and its response would end up with no
        // Image lines. So our own Lazy is built first (cheap: the work runs only on .Value), passed to the
        // GetOrAdd(key, value) overload, and the result compared by reference: owner or joiner, no gap between.
        var myLazyPopulate = new Lazy<Task<PeopleBackdropsCacheFile>>(() => PopulateAndWriteAsync(person, config, onImageAccepted));
        var lazyPopulate = PopulateLocks.GetOrAdd(person.Id, myLazyPopulate);
        var joiningExistingPopulation = !ReferenceEquals(lazyPopulate, myLazyPopulate);

        if (joiningExistingPopulation)
        {
            _logger.LogInformation("PeopleBackdrops: ReadOrPopulateCacheFileAsync - a population flow for {PersonName} ({PersonId}) is already in progress (concurrent request), joining it instead of starting a second one", person.Name, person.Id);
        }

        try
        {
            var result = await lazyPopulate.Value.ConfigureAwait(false);
            return (result, !joiningExistingPopulation);
        }
        finally
        {
            // Removed once settled (success or failure), so a later request reads the written file or starts a
            // fresh attempt instead of awaiting a finished Lazy. The KeyValuePair overload removes the entry only
            // if it is still this exact Lazy, never a newer in-flight population re-added for the same key.
            ((ICollection<KeyValuePair<Guid, Lazy<Task<PeopleBackdropsCacheFile>>>>)PopulateLocks)
                .Remove(new KeyValuePair<Guid, Lazy<Task<PeopleBackdropsCacheFile>>>(person.Id, lazyPopulate));
        }
    }

    /// <summary>
    /// Runs the population flow once and persists the result; a method of its own so it can be wrapped in the
    /// Lazy&lt;Task&lt;...&gt;&gt; request coalescing above.
    /// </summary>
    private async Task<PeopleBackdropsCacheFile> PopulateAndWriteAsync(Person person, PluginConfiguration config, Func<PeopleBackdropsImageEntry, Task>? onImageAccepted)
    {
        _logger.LogInformation("PeopleBackdrops: PopulateAndWriteAsync - starting population flow for {PersonName} ({PersonId}) - no cached backdrops.json found yet, this may take a few seconds (Wallpapers.com API calls + image downloads + text detection)", person.Name, person.Id);

        var populated = await PopulateAsync(person, config, onImageAccepted).ConfigureAwait(false);

        _logger.LogInformation("PeopleBackdrops: PopulateAndWriteAsync - population flow for {PersonName} finished with {Count} accepted image(s)", person.Name, populated.Images.Count);

        // A definite empty outcome (404, empty list, all candidates rejected, no slug) is cached with its reason
        // and time and re-checked after EmptyCacheRetryDays, so a person without a Wallpapers.com page does not
        // cost a lookup on every visit. A lookup that failed for a reason that says nothing about the person
        // (network, auth, rate limit, server error) writes nothing, so the next visit tries again.
        if (populated.Images.Count == 0)
        {
            if (populated.LookupFailed || populated.EmptyReason is null)
            {
                _logger.LogInformation("PeopleBackdrops: PopulateAndWriteAsync - {PersonName} -> 0 images but the lookup did not answer definitively (network/auth/rate limit/server error) - not caching, next visit retries", person.Name);
                return populated;
            }

            populated.CheckedAt = DateTime.UtcNow;
            _logger.LogInformation("PeopleBackdrops: PopulateAndWriteAsync - {PersonName} -> 0 images ({Reason}) - caching the empty result for {Days} days", person.Name, populated.EmptyReason, EmptyCacheRetryDays);
        }

        try
        {
            var folder = GetPersonFolder(person);
            var jsonPath = GetCacheFilePath(person);
            Directory.CreateDirectory(folder);
            var json = JsonSerializer.Serialize(populated, IndentedJsonOptions);
            await System.IO.File.WriteAllTextAsync(jsonPath, json).ConfigureAwait(false);
            _logger.LogDebug("PeopleBackdrops: PopulateAndWriteAsync - wrote backdrops.json for {PersonName} at \"{Path}\"", person.Name, jsonPath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PeopleBackdrops: PopulateAndWriteAsync - failed to write backdrops.json for {PersonName} - result will be shown for this request but not cached, will re-populate next time", person.Name);
        }

        return populated;
    }

    /// <summary>The population flow summarised in the class comment.</summary>
    private async Task<PeopleBackdropsCacheFile> PopulateAsync(Person person, PluginConfiguration config, Func<PeopleBackdropsImageEntry, Task>? onImageAccepted)
    {
        var result = new PeopleBackdropsCacheFile();
        var slug = GenerateSlug(person.Name);
        var targetCount = Math.Clamp(config.PeopleBackdropsMaxImages, 1, 10);

        if (slug.Length == 0)
        {
            // A name without Latin letters (e.g. a Japanese or Cyrillic credit) gives an empty slug; a request for
            // "/keyword/?limit=N" could only return unrelated results or an error, so stop with 0 images.
            _logger.LogInformation("PeopleBackdrops: PopulateAsync - {PersonName} has no Latin letters to build a Wallpapers.com search slug from - skipping the lookup (0 images)", person.Name);
            result.EmptyReason = "NoSlug";
            return result;
        }

        _logger.LogDebug("PeopleBackdrops: PopulateAsync - {PersonName} -> slug \"{Slug}\", target {Target} image(s), text filter {TextFilter}", person.Name, slug, targetCount, config.PeopleBackdropsTextFilterEnabled ? "ON" : "off");

        var httpClient = _httpClientFactory.CreateClient(NamedClient.Default);
        // The candidate images are downloaded in full for the aspect / text checks (GetByteArrayAsync); the cap
        // keeps one oversized answer from being buffered whole (a real wallpaper is 0.2-6 MB).
        httpClient.MaxResponseContentBufferSize = MaxCandidateImageBytes;
        if (!string.IsNullOrEmpty(config.PeopleBackdropsApiKey))
        {
            httpClient.DefaultRequestHeaders.Remove("X-API-Key");
            httpClient.DefaultRequestHeaders.Add("X-API-Key", config.PeopleBackdropsApiKey);
        }

        var alreadyCheckedCount = 0;
        var limit = Math.Min(60, targetCount * 2);
        var rejectedAspectRatio = 0;
        var rejectedText = 0;
        var rejectedUnsafeUrl = 0;
        var rejectedDownloadFailed = 0;

        while (true)
        {
            List<WallpapersApiEntry>? candidates;
            try
            {
                var url = WallpapersApiBase + "/keyword/" + Uri.EscapeDataString(slug) + "?limit=" + limit.ToString(CultureInfo.InvariantCulture);
                _logger.LogDebug("PeopleBackdrops: PopulateAsync - {PersonName} -> requesting {Url}", person.Name, url);
                var response = await httpClient.GetFromJsonAsync<WallpapersApiKeywordResponse>(url).ConfigureAwait(false);
                candidates = response?.Items;
                _logger.LogDebug("PeopleBackdrops: PopulateAsync - {PersonName} -> API returned {Count} candidate(s) at limit={Limit}", person.Name, candidates?.Count ?? 0, limit);
            }
            catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                // 404 = Wallpapers.com has no page for this slug: a definite "no wallpapers", cached.
                _logger.LogInformation("PeopleBackdrops: PopulateAsync - Wallpapers.com has no page for slug \"{Slug}\" ({PersonName}) - 404, a definite empty result ({AcceptedSoFar} image(s) so far)", slug, person.Name, result.Images.Count);
                if (result.Images.Count == 0) { result.EmptyReason = "NotFound"; }
                break;
            }
            catch (Exception ex)
            {
                // Anything else (no internet, DNS, timeout, 401/403/429, 5xx) says nothing about the person and is
                // never cached as empty.
                result.LookupFailed = true;
                _logger.LogWarning(ex, "PeopleBackdrops: PopulateAsync - Wallpapers.com API request failed for slug \"{Slug}\" ({PersonName}) at limit={Limit}, stopping with whatever was already accepted ({AcceptedSoFar} image(s)) - not a definite result, the next visit retries", slug, person.Name, limit, result.Images.Count);
                break;
            }

            if (candidates is null || candidates.Count == 0)
            {
                // No results for this slug at all; a higher limit would not change that.
                _logger.LogInformation("PeopleBackdrops: PopulateAsync - {PersonName} -> 0 candidates from Wallpapers.com for slug \"{Slug}\" - nothing to try at a higher limit either, stopping", person.Name, slug);
                if (result.Images.Count == 0) { result.EmptyReason = "NoCandidates"; }
                break;
            }

            // Only the newly appeared candidates past what a smaller-limit round already checked are evaluated.
            // This assumes the API returns a stable order across different `limit` values for the same slug
            // (limit=40 starts with limit=20's full result). If it reordered results, candidates could be skipped;
            // the safe alternative would be re-checking the whole list on every escalation.
            for (var i = alreadyCheckedCount; i < candidates.Count; i++)
            {
                var candidate = candidates[i];
                if (string.IsNullOrEmpty(candidate.Webp) || !IsSafeHttpsUrl(candidate.Webp))
                {
                    // candidate.Webp comes unvalidated from a third-party API: without this check a malicious
                    // response could point the server-side GetByteArrayAsync at an internal address (SSRF: cloud
                    // metadata endpoint, localhost, other internal services), and the same string would be stored
                    // and handed to the browser as a CSS url(). Requiring an absolute https:// URL closes both
                    // (see IsSafeHttpsUrl).
                    rejectedUnsafeUrl++;
                    if (!string.IsNullOrEmpty(candidate.Webp))
                    {
                        _logger.LogWarning("PeopleBackdrops: PopulateAsync - {PersonName} -> rejected a candidate with a non-https/malformed \"webp\" URL: \"{Url}\"", person.Name, candidate.Webp);
                    }

                    continue;
                }

                byte[] imageBytes;
                try
                {
                    imageBytes = await httpClient.GetByteArrayAsync(candidate.Webp).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    rejectedDownloadFailed++;
                    _logger.LogWarning(ex, "PeopleBackdrops: PopulateAsync - failed to download candidate image for {PersonName} from \"{Url}\", skipping this one", person.Name, candidate.Webp);
                    continue;
                }

                if (!PassesAspectRatioCheck(imageBytes))
                {
                    rejectedAspectRatio++;
                    result.RejectedImages.Add(new PeopleBackdropsRejectedEntry { Url = candidate.Webp, Reason = "AspectRatio" });
                    _logger.LogDebug("PeopleBackdrops: PopulateAsync - {PersonName} -> candidate \"{Url}\" rejected: not 16:9", person.Name, candidate.Webp);
                    continue;
                }

                if (config.PeopleBackdropsTextFilterEnabled && PeopleBackdropsTextDetector.ContainsText(imageBytes, _logger))
                {
                    rejectedText++;
                    result.RejectedImages.Add(new PeopleBackdropsRejectedEntry { Url = candidate.Webp, Reason = "Text" });
                    _logger.LogDebug("PeopleBackdrops: PopulateAsync - {PersonName} -> candidate \"{Url}\" rejected: text detected", person.Name, candidate.Webp);
                    continue;
                }

                var acceptedImage = new PeopleBackdropsImageEntry { Url = candidate.Webp };
                result.Images.Add(acceptedImage);
                _logger.LogDebug("PeopleBackdrops: PopulateAsync - {PersonName} -> accepted candidate {Accepted}/{Target}: \"{Url}\"", person.Name, result.Images.Count, targetCount, candidate.Webp);

                // Streams the image to the client as soon as it is accepted (see PeopleBackdropsStreamLine).
                // Null for a "joiner" on another request's population (see ReadOrPopulateCacheFileAsync): it
                // gets the full result at the end instead of a live stream of its own.
                if (onImageAccepted is not null)
                {
                    try
                    {
                        await onImageAccepted(acceptedImage).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        // A broken response (client navigated away, network blip) must not abort the population:
                        // the result is still worth caching for the next request.
                        _logger.LogDebug(ex, "PeopleBackdrops: PopulateAsync - {PersonName} -> streaming callback failed for an accepted image (client likely disconnected) - continuing population regardless, result will still be cached normally", person.Name);
                    }
                }

                if (result.Images.Count >= targetCount)
                {
                    _logger.LogInformation("PeopleBackdrops: PopulateAsync - {PersonName} -> reached target of {Target} image(s) (rejected: {AspectRatio} aspect-ratio, {Text} text-detected, {UnsafeUrl} unsafe-url, {DownloadFailed} download-failed)", person.Name, targetCount, rejectedAspectRatio, rejectedText, rejectedUnsafeUrl, rejectedDownloadFailed);
                    return result;
                }
            }

            alreadyCheckedCount = candidates.Count;

            if (limit >= 60)
            {
                // At the API's maximum and still short of the target: fewer images is a legitimate outcome.
                _logger.LogInformation("PeopleBackdrops: PopulateAsync - {PersonName} -> reached the API's own max limit (60) with only {Accepted}/{Target} image(s) accepted (rejected: {AspectRatio} aspect-ratio, {Text} text-detected, {UnsafeUrl} unsafe-url, {DownloadFailed} download-failed) - stopping, this is a legitimate outcome not an error", person.Name, result.Images.Count, targetCount, rejectedAspectRatio, rejectedText, rejectedUnsafeUrl, rejectedDownloadFailed);
                // Every candidate rejected by the filters is a definite empty result (cached); failed downloads
                // are not definite.
                if (result.Images.Count == 0) { if (rejectedDownloadFailed == 0) { result.EmptyReason = "AllRejected"; } else { result.LookupFailed = true; } }
                break;
            }

            _logger.LogDebug("PeopleBackdrops: PopulateAsync - {PersonName} -> only {Accepted}/{Target} accepted so far, escalating limit {OldLimit} -> {NewLimit}", person.Name, result.Images.Count, targetCount, limit, Math.Min(60, limit * 2));
            limit = Math.Min(60, limit * 2);
        }

        return result;
    }

    /// <summary>
    /// Automatic name-to-slug conversion, no per-person override: lowercase, spaces to hyphens, accents stripped
    /// (Wallpapers.com spells Beyoncé as wallpapers.com/beyonce).
    /// </summary>
    private static string GenerateSlug(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            // A Person without a usable name has nothing to search for; PopulateAsync skips an empty slug (0
            // images). name.Normalize below would throw otherwise.
            return string.Empty;
        }

        var normalized = name.Normalize(NormalizationForm.FormD);
        var withoutDiacritics = new StringBuilder();
        foreach (var c in normalized)
        {
            var category = CharUnicodeInfo.GetUnicodeCategory(c);
            if (category != UnicodeCategory.NonSpacingMark)
            {
                withoutDiacritics.Append(c);
            }
        }

        var slug = withoutDiacritics.ToString().Normalize(NormalizationForm.FormC).ToLowerInvariant();

        // The FormD decomposition above only separates base + combining-mark pairs (é, ë, ö, ñ, ç ...). Letters
        // that are their own code point (ø, æ, œ, ß, ł, đ, þ, ð, dotless ı) would survive it and then be deleted
        // by the [a-z0-9-] filter below ("Bjørn" -> "bjrn", "Łukasz" -> "ukasz"), a slug with no results. They
        // are mapped to their standard ASCII transliterations instead. (Whether Wallpapers.com spells a name
        // "bjorn" or "bjoern" cannot be known here; "bjrn" is certainly wrong.)
        slug = slug
            .Replace("ø", "o").Replace("æ", "ae").Replace("œ", "oe")
            .Replace("ß", "ss").Replace("ł", "l").Replace("đ", "d")
            .Replace("þ", "th").Replace("ð", "d").Replace("ı", "i");

        slug = slug.Replace(' ', '-');

        // Keep only lowercase letters, digits and hyphens (punctuation as in "Michael J. Fox").
        var cleaned = new StringBuilder();
        foreach (var c in slug)
        {
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')
            {
                cleaned.Append(c);
            }
        }

        // Collapse runs of hyphens and trim leading/trailing ones: "Cheech & Chong" would otherwise become
        // "cheech--chong" (the stripped '&' leaves two separators), " Tom Hanks " "-tom-hanks-".
        var collapsed = new StringBuilder();
        foreach (var c in cleaned.ToString())
        {
            if (c == '-' && (collapsed.Length == 0 || collapsed[collapsed.Length - 1] == '-'))
            {
                continue;
            }

            collapsed.Append(c);
        }

        return collapsed.ToString().TrimEnd('-');
    }

    /// <summary>
    /// Strict 16:9 lock, with no admin toggle (unlike the text filter). The small tolerance covers pixel-rounded
    /// dimensions.
    /// </summary>
    private static bool PassesAspectRatioCheck(byte[] imageBytes)
    {
        try
        {
            var info = SixLabors.ImageSharp.Image.Identify(imageBytes);
            if (info is null || info.Height == 0)
            {
                return false;
            }

            var ratio = (double)info.Width / info.Height;
            return Math.Abs(ratio - TargetAspectRatio) <= AspectRatioTolerance;
        }
        catch (Exception)
        {
            // Unreadable or corrupt image data cannot be confirmed to pass, so it does not.
            return false;
        }
    }

    /// <summary>
    /// DTOs for the Wallpapers.com /api/v1/keyword/&lt;slug&gt; response, e.g. for
    /// `https://wallpapers.com/api/v1/keyword/keanu-reeves?limit=5`:
    /// <c>{"items":[{"alt":"...","credit":"Wallpapers.com","credit_url":"...","high":"https://wallpapers.com/images/high/....jpg","id":158609,"thumb":"...","title":"...","type":"wallpaper","url":"...","webp":"https://wallpapers.com/images/high/....webp"}],"keyword":"keanu-reeves","success":true,"total":75}</c>
    /// The array is "items". Only "webp" is read: "high" (a .jpg/.png of the same image) is larger.
    /// </summary>
    private sealed class WallpapersApiKeywordResponse
    {
        [JsonPropertyName("items")]
        public List<WallpapersApiEntry>? Items { get; set; }
    }

    private sealed class WallpapersApiEntry
    {
        [JsonPropertyName("webp")]
        public string? Webp { get; set; }
    }

    /// <summary>
    /// SSRF hardening (see the call site): requires an absolute, well-formed https:// URL before the server requests
    /// it or stores and returns it to the browser. Deliberately no wallpapers.com host allowlist: the image CDN
    /// domain of the `webp` URLs is not guaranteed, and an allowlist could reject every legitimate image. https
    /// only still rules out http:// internal targets, file:// and other schemes.
    /// </summary>
    private static bool IsSafeHttpsUrl(string url)
    {
        return Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps;
    }
}
