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
// Needed for the GetImageCacheTag(item, ImageType, index) EXTENSION method
// (ImageProcessorExtensions) - a fully qualified type name alone does not
// bring extension methods into scope (found by the first real dotnet build).
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// A single cached wallpaper entry, as written to/read from
/// backdrops.json. Just the URL - no local copy of the pixel data is
/// ever kept (see this controller's own class doc comment for the full
/// reasoning behind hotlinking over downloading). Per-image credit
/// fields (CreditUrl/CreditText) were removed during an audit pass -
/// the concept phase settled on a single, static Wallpapers.com
/// attribution line in the admin UI's own section description instead
/// (see configPage.html), so per-image credit data was written to every
/// cache file and returned in every API response but never actually
/// read by BackdropsPeople-v1.js at all - genuinely dead data, not kept
/// "just in case".
/// </summary>
public class PeopleBackdropsImageEntry
{
    public string Url { get; set; } = string.Empty;
}

/// <summary>
/// One candidate that was found but NOT accepted, kept purely for the
/// admin's own informational reference (explicit user request: "rein
/// zur info, drinnen wenn ein bild verworfen wurde wegen falsche
/// apsekt ratio oder wegen text erkannt") - never read by
/// BackdropsPeople-v1.js, which only ever looks at the accepted
/// Images list. Deliberately only covers the two REAL image-quality
/// judgment calls (aspect ratio, text detected) - not
/// download-failed/unsafe-URL rejections, which are technical
/// failures rather than a judgment about the image itself, and are
/// already visible in the server log for anyone who needs them.
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
    /// Session 131: why a cache file holds 0 images - "NotFound" (Wallpapers.com
    /// answered 404 for the slug), "NoCandidates" (200 with an empty list),
    /// "AllRejected" (candidates existed, none passed the filters), "NoSlug"
    /// (name without Latin letters). null on files with images and on legacy
    /// files. Only these definite outcomes are cached; a lookup that failed for
    /// an unknown reason (network, 401/403/429, 5xx) never writes a file.
    /// </summary>
    public string? EmptyReason { get; set; }

    /// <summary>Session 131: UTC time of the lookup that produced an empty file; after EmptyCacheRetryDays the file counts as absent.</summary>
    public DateTime? CheckedAt { get; set; }

    /// <summary>Transient, never serialized: the lookup failed for a reason that says nothing about the person (network, auth, rate limit, server error).</summary>
    [JsonIgnore]
    public bool LookupFailed { get; set; }
}

/// <summary>
/// One single line of the NDJSON (newline-delimited JSON) stream
/// GetPeopleBackdrops now sends, instead of one large, complete
/// PeopleBackdropsResult object all at once - added specifically so the
/// frontend can show the FIRST accepted image as soon as it's found,
/// rather than waiting for the entire (potentially several-seconds-long,
/// first-time) population flow to finish before anything appears at
/// all. Explicit user request: "erstes laden, gleich anzeigen wenn
/// fertig, im hintergrund schon die nächsten laden".
///
/// One flat DTO with a Type discriminator (rather than several distinct
/// classes with polymorphic JSON serialization) - simpler to reason
/// about and serialize/deserialize for a small, fully first-party
/// protocol only this controller and BackdropsPeople-v1.js ever need to
/// agree on; not a general-purpose public API.
///
/// Exactly one "Header" line is sent first (whether or not the request
/// is even applicable at all - Reason is populated when IsApplicable is
/// false, exactly like the old single-response Reason field), followed
/// by zero or more "Image" lines (one per accepted image, sent AS SOON
/// as each one is accepted - not batched), followed by exactly one
/// final "Done" line so the frontend knows the stream is complete and
/// can stop reading (matters even when zero images arrive, so a
/// legitimate "not applicable"/"0 images" outcome doesn't leave the
/// frontend waiting for more that will never come).
/// </summary>
public class PeopleBackdropsStreamLine
{
    public string Type { get; set; } = string.Empty; // "Header" | "Image" | "Done"

    /// <summary>Session 120: the source the Header announces ("WallpapersCom" | "Appearances" | "Folder") - the client chooses its handover window from it (concept Part R3).</summary>
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
/// The sixth, fully independent feature (see curriculum's own "People
/// Backdrops" milestone for the complete concept-phase reasoning this
/// implementation is based on). Shows wallpapers from Wallpapers.com on
/// Person detail pages and their filmography pages.
///
/// Architecture summary (see the curriculum entry for the full "why"
/// behind each of these):
/// - Hotlinking, not downloading: only Wallpapers.com URLs are ever
///   stored (in backdrops.json, one per person, in that person's own
///   real Jellyfin metadata folder) - the actual pixel bytes are loaded
///   directly by the browser at display time, never proxied or stored
///   locally by this plugin.
/// - backdrops.json existing at all is the entire cache signal - no
///   expiration, no TTL. Present = pure read, never re-request. Absent =
///   run the full population flow once, then write it. Only "Wipe
///   cache" (see WipeCache endpoint) ever removes it again.
/// - Population flow: escalating `limit` calls to the Wallpapers.com
///   keyword API (start at target×2, double up to the API's own max of
///   60), only re-checking newly-appeared candidates each escalation.
///   Each surviving candidate gets its `webp` image downloaded ONCE and
///   checked against BOTH a strict 16:9 aspect-ratio lock and (if
///   enabled) text-presence detection, in that order, against the same
///   already-downloaded bytes - deliberately unified into one image
///   source per candidate rather than juggling a separate, smaller
///   thumbnail for the aspect-ratio check specifically (an earlier
///   design that was simplified away - see curriculum).
/// - Shares BackdropsTabEnabled as a common master switch with BackdropsPlus -
///   deliberately has no separate master-enable field of its own; the
///   four ShowOn fields are the real per-feature enable mechanism.
///   CHANGED (twice now): originally shared RedCarpetEnabled, re-coupled
///   to BackdropsEnabled when this feature's own UI moved from the Red
///   Carpet tab to the Backdrops tab, then re-coupled AGAIN to the newly
///   introduced BackdropsTabEnabled once BackdropsEnabled itself became
///   BackdropsPlus's own genuinely independent sub-feature switch (own
///   concept-session decision - Extraposter got the identical treatment
///   at the same time, see ExtraposterTabEnabled's own doc comment).
///   People Backdrops is a SIBLING of BackdropsPlus under the same tab,
///   not a dependent of BackdropsPlus specifically - it should go dark
///   when the whole Backdrops tab is off, not merely when BackdropsPlus's
///   own specific switch is off while the tab otherwise stays on.
/// </summary>
[ApiController]
[Route("PeopleBackdrops")]
// Deliberately NOT [AllowAnonymous] at the class level - confirmed via
// multiple official sources (Microsoft Learn's own authorization docs,
// dotnet/aspnetcore GitHub issue #56310) that a class-level
// [AllowAnonymous] unconditionally overrides EVERY [Authorize] attribute
// on every action within that class, including WipeCache's own
// [Authorize(Policy = Policies.RequiresElevation)] below - an earlier
// draft had it here and would have left WipeCache completely
// unprotected, reachable by anyone including unauthenticated users.
// [AllowAnonymous] is instead applied individually to the endpoint that
// needs it (GetPeopleBackdrops). Audit 2026-09 (S1-05): GetFolderImage
// (Session 101) carries NO attribute and is anonymous all the same -
// Jellyfin 10.10.7 registers no fallback authorization policy
// (Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs, only a
// DefaultPolicy that applies where [Authorize] stands), so an attribute-less
// action is reachable without a token, which the <img> requests of the
// client rely on. Functionally identical to a marked endpoint; the
// earlier wording "the two endpoints" predates Session 101. Note:
// RedCarpetController.cs has [AllowAnonymous] at its own class level
// too, but that controller has no [Authorize]-protected endpoint at all
// to conflict with - not a precedent for doing the same here, since this
// controller specifically does have one (WipeCache).
public class PeopleBackdropsController : ControllerBase
{
    private const string WallpapersApiBase = "https://wallpapers.com/api/v1";

    // Strict 16:9 lock, not just "any landscape orientation" - explicit,
    // deliberately restrictive user decision. A small tolerance is still
    // needed since real-world image dimensions are pixel-rounded and
    // will essentially never be an exact, mathematically perfect 16:9
    // ratio.
    private const double TargetAspectRatio = 16.0 / 9.0;
    private const double AspectRatioTolerance = 0.02;

    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<PeopleBackdropsController> _logger;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly MediaBrowser.Controller.Drawing.IImageProcessor _imageProcessor;

    // Real concurrency bug found during audit: without this, several
    // concurrent requests for the SAME person (very plausible in
    // practice - the frontend's own navigation "burst" mechanism can
    // fire multiple fetches for the same person if the first one is
    // still slow-populating, and multiple simultaneous visitors browsing
    // the same actor is an entirely ordinary scenario) would each
    // independently see backdrops.json as not-yet-existing and each run
    // the ENTIRE population flow in parallel - redundant Wallpapers.com
    // API calls (burning through its own rate limit faster), redundant
    // image downloads, and a real risk of a file-write conflict when
    // multiple of them try to write the same backdrops.json at once.
    // Request coalescing via a static, per-personId Lazy<Task<...>>:
    // concurrent callers for the same personId all await the SAME
    // in-flight population task instead of starting their own. Entries
    // are removed once the task completes (success or failure) so this
    // dictionary doesn't grow unbounded - it only ever holds entries for
    // people currently being actively populated, never a permanent
    // cache of everyone ever requested.
    private static readonly ConcurrentDictionary<Guid, Lazy<Task<PeopleBackdropsCacheFile>>> PopulateLocks = new();

    // Explicit user request: "ich würde in der .json icht alles in der
    // wurst haben, sondern ein url dann zeilesprung" (a readable file,
    // not everything crammed onto one line) - WriteIndented naturally
    // puts each object/property on its own line, so each image's own
    // URL ends up readable at a glance rather than needing a JSON
    // formatter to inspect. Kept as one shared, static instance rather
    // than constructing a fresh JsonSerializerOptions on every write -
    // System.Text.Json's own documented best practice, since it caches
    // reflection/type metadata internally per-options-instance.
    private static readonly JsonSerializerOptions IndentedJsonOptions = new() { WriteIndented = true };

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
    /// GET /PeopleBackdrops/{personId}?scope=info|movie|series|episode -
    /// mirrors RedCarpet's own identical "scope" convention exactly
    /// (missing parameter defaults to "info"). Server checks for itself
    /// whether personId even belongs to a Person and whether this
    /// specific scope is enabled - the frontend doesn't have to detect
    /// the page type itself, it just always asks and trusts the result
    /// (same "the plugin stays dumb" principle the other controllers'
    /// own doc comments describe).
    ///
    /// STREAMING (NDJSON), not a single JSON object - changed from the
    /// original single-response design specifically so the frontend can
    /// show the FIRST accepted image immediately, rather than waiting
    /// for however long the entire population flow takes (several real
    /// seconds on a genuinely first-time, several-escalating-API-calls
    /// population). See PeopleBackdropsStreamLine's own doc comment for
    /// the exact line-by-line protocol. Return type is plain Task (not
    /// ActionResult&lt;...&gt;) since the response is written directly
    /// to Response.Body below rather than through the normal MVC
    /// result-serialization pipeline, which only ever produces one
    /// single, complete JSON object - incompatible with streaming
    /// multiple, independently-flushed lines over time.
    /// </summary>
    [HttpGet("{personId}")]
    [AllowAnonymous]
    public async Task GetPeopleBackdrops([FromRoute] Guid personId, [FromQuery] string? scope)
    {
        // NDJSON = "newline-delimited JSON" - not a registered/standard
        // MIME type with a single universally-agreed string; this is a
        // private protocol only this controller and BackdropsPeople-v1.js
        // ever need to agree on, so the exact content-type string here
        // is not load-bearing for any other consumer.
        Response.ContentType = "application/x-ndjson";
        var anyLineWritten = false;

        try
        {
            var config = Plugin.Instance!.Configuration;

            // BackdropsTabEnabled is the deliberately SHARED master
            // switch for both BackdropsPlus and People Backdrops - see
            // this controller's own class doc comment for the full
            // reasoning. Re-coupled (again) from BackdropsEnabled, which
            // is now BackdropsPlus's own independent sub-feature switch,
            // not the right thing for a sibling feature to depend on.
            if (!config.BackdropsTabEnabled)
            {
                _logger.LogDebug("PeopleBackdrops: GetPeopleBackdrops - BackdropsTabEnabled is off (shared master switch), not applicable for {PersonId}", personId);
                await WriteNotApplicableStreamAsync("BackdropsTabEnabled (shared master switch) is off in plugin settings", config).ConfigureAwait(false);
                return;
            }

            // Phase D1 (Session 100): own feature-level switch, added
            // alongside the shared tab-level one above - matches every
            // other Backdrops category now (see
            // PeopleBackdropsEnabled's own doc comment).
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

            // NEW BRANCH (explicit user decision - "bauen wir bei
            // unseren schon bestehenden people backdrops ein"):
            // Appearances mode never touches the wallpaper cache at
            // all - completely separate data source, same streaming
            // protocol. WallpapersCom (the default) falls through to
            // the existing, byte-for-byte unchanged code below.
            if (config.PeopleBackdropsSourceMode == "Appearances")
            {
                await WriteAppearancesStreamAsync(person, config).ConfigureAwait(false);
                return;
            }

            // Phase D2 (Session 101): third source, local files only -
            // never touches the wallpaper cache or Appearances logic,
            // completely independent data source, same streaming
            // protocol as both.
            if (config.PeopleBackdropsSourceMode == "Folder")
            {
                await WriteFolderStreamAsync(person, config).ConfigureAwait(false);
                return;
            }

            // Header line sent BEFORE population even starts - the
            // frontend needs OrderMode/CycleMs/KenBurns settings right
            // away regardless of how long finding actual images takes,
            // and IsApplicable=true here is a promise that at least
            // zero-or-more Image lines and a final Done line will
            // follow, not a claim that any images actually exist yet.
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

            // Only reached for a CACHE HIT (the file already existed -
            // ReadOrPopulateCacheFileAsync's own alreadyStreamed=false
            // in that case) or the rare "joiner" case (a second,
            // concurrent request for the same person that only awaited
            // someone ELSE's in-progress population - see
            // ReadOrPopulateCacheFileAsync's own doc comment). Either
            // way, nothing has been streamed to THIS response yet, so
            // every image gets written out now, all at once - still
            // through the exact same per-line Image protocol the live-
            // streaming path uses, so BackdropsPeople-v1.js needs only
            // ONE parsing code path regardless of which case produced
            // the result.
            if (!alreadyStreamed)
            {
                // Per-request Shuffle/Random re-ordering. Deliberately
                // operates on a COPY, never on cacheFile.Images itself:
                // for the cache-hit path (the common case, file already
                // existed) each request already gets its own freshly
                // deserialized cacheFile, but for the "joiner" case
                // above (a concurrent request that only awaited someone
                // ELSE's in-progress population) this cacheFile object
                // is the SAME instance stored in the static PopulateLocks
                // dictionary and potentially returned to multiple
                // concurrent joiners at once - mutating cacheFile.Images
                // in place would be a genuine, if narrow, race condition
                // (concurrent Fisher-Yates swaps corrupting the same
                // list, or two joiners' own local shuffle attempts
                // stepping on each other). Random.Shared is .NET's own
                // thread-safe shared instance (available since .NET 6) -
                // exactly the right tool for a Random used across
                // concurrent web requests, unlike a plain `new Random()`
                // per call.
                //
                // Sequential is deliberately left untouched: "always the
                // same order" is that mode's whole point, not a bug -
                // only Shuffle and Random are about varying the order
                // per visit/reload (user's own explicit request).
                var streamOrder = config.PeopleBackdropsOrderMode == "Shuffle" || config.PeopleBackdropsOrderMode == "Random"
                    ? new List<PeopleBackdropsImageEntry>(cacheFile.Images)
                    : cacheFile.Images;
                if (streamOrder != cacheFile.Images)
                {
                    Random.Shared.Shuffle(System.Runtime.InteropServices.CollectionsMarshal.AsSpan(streamOrder));
                }
                else if (config.PeopleBackdropsRandomStart)
                {
                    // Session 127: Random start position - Sequential keeps its order, only the entry point moves.
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

            // If nothing was written yet, a clean Header+Done pair still
            // gives the frontend a well-formed, parseable stream (its
            // usual "not applicable" path) rather than a truncated,
            // invalid one. If a Header (or images) already went out,
            // writing a fresh Header now would just be a second,
            // confusing one - a bare Done line at least lets the
            // frontend stop waiting cleanly instead of hanging until
            // its own read eventually errors out or times out.
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
                // The response itself is unusable at this point (e.g.
                // the underlying connection is already gone) - nothing
                // further to do, already logged the real error above.
                _logger.LogDebug(writeEx, "PeopleBackdrops: GetPeopleBackdrops - failed to write the error-path Done line, response is likely already unusable");
            }
        }
    }

    /// <summary>
    /// Convenience for the several early "not applicable" exit points
    /// above - a well-formed two-line stream (Header + Done) with zero
    /// Image lines in between, exactly like a legitimate "0 images"
    /// outcome looks from the frontend's own perspective. Settings
    /// fields are still populated even though IsApplicable is false -
    /// harmless (the frontend already ignores them whenever
    /// IsApplicable is false) and cheaper than a second, differently-
    /// shaped DTO just for this case.
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

    /// <summary>
    /// Appearances mode (see PluginConfiguration.PeopleBackdropsSourceMode's
    /// own doc comment) - the person's own movies/shows instead of
    /// Wallpapers.com, streamed through the EXACT SAME Header/Image/Done
    /// protocol as the existing WallpapersCom path, so
    /// BackdropsPeople-v1.js needs zero changes. Url is built from
    /// Jellyfin's own real image route
    /// (/Items/{id}/Images/Backdrop/{index}?tag=...) - confirmed against
    /// Jellyfin.Api.Controllers.ImageController's own route attribute,
    /// not invented - which the client already knows how to render,
    /// since it never distinguishes a wallpaper URL from any other kind
    /// of URL string.
    /// </summary>
    /// <summary>Session 116: the request user from Jellyfin's auth claim (null on anonymous calls).</summary>
    private Jellyfin.Data.Entities.User? GetRequestUser()
    {
        var claim = User?.FindFirst("Jellyfin-UserId")?.Value;
        if (string.IsNullOrEmpty(claim) || !Guid.TryParse(claim, out var userId)) { return null; }
        return _userManager.GetUserById(userId);
    }

    private async Task WriteAppearancesStreamAsync(Person person, PluginConfiguration config)
    {
        // Fixes #7/#8 (Session 105, ported aus der Sandbox, Session 74/76):
        // eigenes Sort-Feld (dasselbe Label "Order" wie das
        // Wallpapers.com-eigene, aber ein komplett separates Config-Feld
        // mit echten Jellyfin-Sortierfeldern statt nur Sequential/
        // Shuffle/Random) plus Main/All-Backdrop-Auswahl je Person -
        // beide vorher nur Sandbox-Konzept.
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

        // "Shuffle"/"Random" fall back to a stable server fetch order
        // (SortName) and let the client-side rotation engine (see
        // OrderMode above) reshuffle/randomize during rotation - a real
        // ItemSortBy field name instead sorts server-side by that field,
        // with the client then simply playing the already-correct order
        // (Core.js's own rotation engine treats anything other than the
        // two literal strings "Shuffle"/"Random" as Sequential, same
        // convention as Genre/Tag/Favorites' own SortMode). Same
        // Enum.TryParse conversion as BackdropsController's own
        // ResolveRotationQuery - ItemSortBy is a real enum, not a string.
        var orderByField = ItemSortBy.SortName;
        if (sortMode != "Shuffle" && sortMode != "Random" && Enum.TryParse<ItemSortBy>(sortMode, out var parsedSortField))
        {
            orderByField = parsedSortField;
        }
        // Session 116: Traversal (new) + the request user on the query.
        // PlayCount/DatePlayed/IsPlayed/IsUnplayed/IsFavoriteOrLiked sort
        // on UserDatas, which Jellyfin only joins with a user - without
        // one the query fails ("no such column"), see BackdropsController.
        var traversal = config.PeopleBackdropsAppearancesTraversalMode;
        var order = (traversal == "BeginDescending" || traversal == "RandomStartDescending") ? SortOrder.Descending : SortOrder.Ascending;
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
        // Session 127: the Random start position checkbox (legacy RandomStart* traversal words still count).
        if (Helpers.RandomStart.ForTraversal(config.PeopleBackdropsAppearancesRandomStart, traversal))
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
            // Session 118: honour the global Listener. Custom = the plugin's
            // own file resolution (same rules as Jellyfin, configured base
            // name) served via /Backdrops/custom-image; Native = the DB
            // images as before. Main = original index 0 in both cases.
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

                // Main = the file without a number, confirmed always added
                // FIRST by Jellyfin's own LocalImageProvider.PopulateBackdrops
                // - lands reliably at index 0.
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
    /// Phase D2 (Session 101, explicit user request): third source,
    /// purely local files in the person's own folder - no Wallpapers.com
    /// API call, no Appearances library query. "Single" looks for
    /// exactly one file named "backdrop.&lt;ext&gt;". "Multiple" looks
    /// for numbered files "backdrop1.&lt;ext&gt;" through
    /// "backdrop20.&lt;ext&gt;" (stops after 3 consecutive misses, same
    /// convention as Jellyfin's own LocalImageProvider.PopulateBackdrops
    /// for its "backdrop"/"fanart"/"background"/"art" prefixes -
    /// confirmed against jellyfin-web's real source during this
    /// feature's own concept discussion). If "Multiple" is selected but
    /// only one file is actually found, the resulting one-image list is
    /// streamed exactly like "Single" would be - the existing, shared
    /// rotation engine on the client already treats a one-image pool as
    /// a plain static show with no crossfade partner, same as it always
    /// has for a one-image Wallpapers.com/Appearances result. No special
    /// case needed here for that - it falls out of the existing,
    /// generic client behavior for free.
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

        // Session 127: Random start position - the URLs keep their file index, only the stream order is rotated.
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
    /// Shared by WriteFolderStreamAsync and GetFolderImage - both need
    /// the EXACT same ordered list so an index streamed to the client
    /// resolves to the same file when it's later requested. "Single":
    /// only "backdrop.&lt;ext&gt;", at most one entry. "Multiple": only
    /// the numbered "backdrop1.&lt;ext&gt;".."backdrop20.&lt;ext&gt;"
    /// (the bare, unnumbered file is deliberately NOT included here -
    /// "Single" and "Multiple" are two distinct, non-overlapping file
    /// sets by design, matching this feature's own admin-UI description
    /// text). Extension search order follows BackdropsAllowedFormats,
    /// same convention as every other local-file lookup in this project
    /// (Studio's own ResolveStudioImagePath, Extraposter's candidate
    /// resolution) - falls back to ".jpg" if the list is empty.
    /// </summary>
    internal static List<string> ResolveFolderBackdropPaths(string personFolder, string backdropFilesMode, string? allowedFormatsCsv, string? baseName = null)
    {
        // Session 118: shared resolver (Helpers/BackdropFileResolver.ResolvePlain).
        // Base name configurable (PeopleBackdropsFolderBaseName, default
        // "backdrop"); Multiple now includes the plain "name.ext" as index 0
        // before name1..name20 - the same rule as Jellyfin's backdrop stage
        // and the episode files (user decision, Session 118).
        var name = string.IsNullOrWhiteSpace(baseName) ? "backdrop" : baseName.Trim();
        var allowed = Helpers.BackdropFileResolver.ParseAllowedFormats(allowedFormatsCsv) ?? new[] { ".jpg" };
        return Helpers.BackdropFileResolver.ResolvePlain(personFolder, name, backdropFilesMode == "Multiple", allowed);
    }

    /// <summary>
    /// GET /PeopleBackdrops/{personId}/folder-image?index=N - serves one
    /// of the resolved local backdrop files directly, same ETag/
    /// CacheControl convention as every other local-file endpoint in
    /// this project (Studio's own GetStudioImage, Extraposter's
    /// GetPosterImage).
    /// </summary>
    [HttpGet("{personId}/folder-image")]
    public ActionResult GetFolderImage([FromRoute] Guid personId, [FromQuery] int index, [FromQuery] string? mode)
    {
        // Audit S1-04 (Session 138): guarded like every other file endpoint -
        // a locked or vanished file answers 404 + a warning, not a 500.
        try
        {
            var config = Plugin.Instance!.Configuration;
            var item = _libraryManager.GetItemById(personId);
            if (item is not Person person)
            {
                return NotFound();
            }

            // Session 116: "mode" lets the Favorites-People pool address its
            // own Backdrop files setting (Single/Multiple) - without it the
            // index would resolve against the standalone People setting.
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
    /// Serializes one line and writes+flushes it immediately - the
    /// explicit FlushAsync is the entire point: without it, ASP.NET
    /// Core's own internal response buffering could hold multiple
    /// "written" lines back and send them to the client all at once
    /// anyway, silently defeating the whole purpose of streaming.
    /// </summary>
    private async Task WriteStreamLineAsync(PeopleBackdropsStreamLine line)
    {
        var json = JsonSerializer.Serialize(line);
        var bytes = Encoding.UTF8.GetBytes(json + "\n");
        await Response.Body.WriteAsync(bytes).ConfigureAwait(false);
        await Response.Body.FlushAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// POST /PeopleBackdrops/test-api-key - explicit user request ("mir
    /// müssen in der log oder ist es möglich irgendwie einen indikator
    /// ob unser api key funktioniert? können wir mit unserem api key
    /// requesten? testen?"). Makes ONE real, deliberately tiny request
    /// against Wallpapers.com (limit=1, a well-known slug this project
    /// has already confirmed real results for - see this session's own
    /// earlier Keanu Reeves testing - rather than a generic "test"
    /// keyword that could legitimately return 0 results even with a
    /// perfectly working key, which would then be misread as a
    /// failure) using whatever API key is CURRENTLY SAVED in
    /// PeopleBackdropsApiKey, exactly like a real population request
    /// would. Admin-only, same reasoning as WipeCache above - this
    /// makes a real outbound network request on demand, not something
    /// an unauthenticated caller should be able to trigger freely.
    ///
    /// HONEST LIMITATION, stated directly rather than glossed over:
    /// this project has never actually observed what Wallpapers.com's
    /// own API returns for a genuinely INVALID key (no test account
    /// with a deliberately-wrong key was available to confirm this
    /// against) - HttpRequestException's own StatusCode is used to
    /// distinguish "some HTTP error occurred" from "no HTTP error, but
    /// something else went wrong" (DNS/timeout/network), but this
    /// endpoint cannot claim with certainty that any specific status
    /// code definitively means "your key is wrong" versus some other
    /// server-side condition - the response's own Detail message says
    /// exactly what status code and body came back, so the admin can
    /// judge for themselves rather than trusting a possibly-wrong
    /// interpretation.
    /// </summary>
    [HttpPost("test-api-key")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public async Task<ActionResult> TestApiKey([FromQuery] string? apiKey)
    {
        var config = Plugin.Instance!.Configuration;
        // Prefers the key passed directly from the admin UI's own
        // input field (which may not be saved yet) over the persisted
        // config - lets the admin test a key they just typed without
        // first having to click the page's own separate Save button.
        // Falls back to the saved config only when the field itself
        // was left empty (e.g. testing "does no-key access still
        // work").
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
            // See this method's own doc comment above - StatusCode
            // being present at least confirms Wallpapers.com's own
            // server responded (as opposed to a network-level failure
            // below), even though this endpoint can't claim certainty
            // about what any specific code means for THIS API
            // specifically.
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
    /// POST /PeopleBackdrops/wipe - deletes every person's backdrops.json
    /// across the entire library. Fires immediately on click in the
    /// admin UI (not gated behind the settings page's normal Save
    /// action) since this is a one-time action, not a persisted setting
    /// - see the curriculum's own "Wipe cache" section for the full
    /// admin-UI reasoning. Iterates via ILibraryManager (real, known
    /// Person items) rather than raw-scanning the People folder on disk,
    /// so it can never touch anything Jellyfin itself doesn't actually
    /// know about.
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

    // NOTE: this controller used to have its own GET /PeopleBackdrops/script.js
    // endpoint here, serving Jellyfin-ArtworkPlus-BackdropsPeople-v1.js from
    // disk. Confirmed genuinely dead code, found during a pluginwide
    // consistency pass, not just recently obsolete: the actual People
    // Backdrops CODE has lived as its own, second, fully separate IIFE
    // inside Jellyfin-ArtworkPlus-Backdrops-v1.js since the original
    // People-Backdrops-into-BackdropsMod merge - this endpoint was left
    // in place at that time with an explicit note that it was "harmless"
    // since it was never automatically invoked (no PeopleBackdropsScriptTag
    // ever existed in FileTransformationRegistrar.cs, unlike BackdropsPlus's
    // own script.js endpoint) - the user always pasted People Backdrops'
    // own code into JavaScript Injector by hand, both before AND after
    // that merge. Removed now rather than left standing: it served a file
    // (Jellyfin-ArtworkPlus-BackdropsPeople-v1.js) that has never existed
    // anywhere in this project since that merge, and kept it around risked
    // exactly the kind of confusion a future reader could reasonably have
    // ("is there a separate People Backdrops script after all?"). This
    // controller's OWN data endpoints above (image search/resolution,
    // cache management) are entirely unaffected.

    /// <summary>
    /// "info"/no parameter -> the person's own detail page. Same four-
    /// way mapping RedCarpet's own IsScopeEnabled uses, duplicated here
    /// rather than shared, since the two controllers' underlying config
    /// fields are deliberately entirely separate (PeopleBackdrops* vs
    /// RedCarpet*, not shared) - see PluginConfiguration's own doc
    /// comment on the People Backdrops ShowOn fields for why they're a
    /// full, independent copy rather than reusing RedCarpet's own.
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
    /// Real Jellyfin folder-resolution algorithm, confirmed directly
    /// against the real Jellyfin server source (Person.GetPath(), in
    /// MediaBrowser.Controller.Entities.Person) rather than assumed or
    /// reconstructed from a single example: finds the first alphanumeric
    /// character in the (filesystem-sanitized) person name, uses it
    /// UNCHANGED (no case conversion) as a one-level subfolder under
    /// IServerApplicationPaths.PeoplePath, then the full sanitized name
    /// as the final folder. Deliberately calls this same static method
    /// Jellyfin itself uses (via person.Name) rather than trusting
    /// person.Path directly, since GetPath() is the authoritative,
    /// current-truth computation (person.Path could theoretically be
    /// stale relative to the current name until Jellyfin's own
    /// RequiresRefresh()/rebase logic catches up).
    /// </summary>
    /// <remarks>
    /// CHANGED: access widened from private to internal, same reasoning
    /// as ReadOrPopulateCacheFileAsync's own remark above - reused by
    /// BackdropsController for the Favorites People pool, behavior
    /// unchanged.
    /// </remarks>
    internal static string GetPersonFolder(Person person)
    {
        return Person.GetPath(person.Name);
    }

    /// <remarks>See GetPersonFolder's own remark above.</remarks>
    /// <summary>Session 131: how long an empty lookup result is trusted before Wallpapers.com is asked again.</summary>
    internal const int EmptyCacheRetryDays = 7;

    /// <summary>
    /// Session 131: true when a cache file holds no images and should be treated as
    /// absent - a legacy empty file (no CheckedAt; written before the "never write
    /// empty" rule of the sandbox era) or an empty result older than EmptyCacheRetryDays.
    /// Files with images never expire (only Wipe cache removes them).
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
    /// The entire caching rule in one method: file exists -> pure read,
    /// never re-request, no expiration ever (see class doc comment).
    /// File absent -> run the full population flow once, write the
    /// result (even if it ends up with fewer than the target count, or
    /// even zero - a zero-image result is still written, so we don't
    /// keep hammering Wallpapers.com on every single page view for a
    /// person who genuinely has no qualifying wallpapers available -
    /// matches this project's own "0 accepted images is a legitimate,
    /// silent outcome" philosophy used elsewhere).
    /// </summary>
    /// <returns>
    /// The cache file (or null if it couldn't be read/populated), plus
    /// whether its images were ALREADY streamed to the caller's own
    /// onImageAccepted callback during this call (true only when this
    /// request was the one that actually started a fresh population -
    /// see PopulateAsync's own doc comment on the callback). False for
    /// a cache hit (the file already existed, nothing was streamed -
    /// the caller must stream the returned images itself) and false for
    /// a "joiner" request (see PopulateLocks' own doc comment - this
    /// request only awaited someone ELSE's already-in-progress
    /// population, whose own streaming, if any, went to that OTHER
    /// request's response, not this one's).
    /// </returns>
    /// <remarks>
    /// CHANGED (Favorites People Backdrops, explicit user decision -
    /// "wir nehmen die selbe tech"): access widened from private to
    /// internal ONLY so BackdropsController can reuse this exact same
    /// caching rule for the Favorites People pool, without duplicating
    /// it. The method's own behavior is completely unchanged - not a
    /// single line inside it was touched.
    /// </remarks>
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
                    // Session 131: an empty result is remembered for EmptyCacheRetryDays
                    // (no Wallpapers.com call on every visit), then checked again.
                    _logger.LogInformation("PeopleBackdrops: ReadOrPopulateCacheFileAsync - empty cache for {PersonName} ({Reason}, checked {CheckedAt}) is older than {Days} days - looking up Wallpapers.com again", person.Name, parsed?.EmptyReason ?? "legacy", parsed?.CheckedAt, EmptyCacheRetryDays);
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
                // Falls through to the population flow below, same as a
                // genuinely-missing file - a corrupt cache file
                // shouldn't permanently strand a person with nothing.
            }
        }

        // Request coalescing (see PopulateLocks' own doc comment above
        // for the full "why") - GetOrAdd + Lazy ensures only ONE
        // population flow ever actually runs per personId at a time,
        // even under concurrent requests; everyone else awaits that
        // same Task. The Lazy's own lambda captures person/config/
        // onImageAccepted by closure - safe since all three are
        // effectively immutable for the duration of a single request.
        // Only the actual OWNER's onImageAccepted ever fires - a
        // "joiner" call's own callback is simply never used, since the
        // owner's Lazy instance (not theirs) is what ends up stored and
        // awaited. That's the entire mechanism behind the "only the
        // owner gets live streaming" design.
        //
        // REAL RACE CONDITION FOUND AND FIXED (via a full audit of this
        // feature, not a reported bug) - an earlier version of this
        // code checked PopulateLocks.ContainsKey(person.Id) SEPARATELY,
        // before calling GetOrAdd(key, factory): two genuinely
        // different, non-atomic operations. In the narrow window
        // between them, a second, concurrent request for the exact
        // same NOT-YET-CACHED person could win the race inside GetOrAdd
        // itself, meaning this request's own ContainsKey read (from
        // just before) no longer reflected reality by the time GetOrAdd
        // actually ran - it could wrongly believe it was the "owner"
        // while actually only receiving the OTHER request's Lazy
        // instance. Its own onImageAccepted would then never fire, and
        // because it wrongly thought AlreadyStreamed=true, the caller
        // (GetPeopleBackdrops) would never fall back to writing the
        // images out afterward either - a real, if narrow, path to a
        // response with zero Image lines despite a successful
        // population. Fixed atomically: build OUR OWN Lazy instance
        // first (its constructor is trivial - the actual expensive
        // PopulateAndWriteAsync call inside it only ever runs on first
        // .Value access, so creating-but-not-using it costs nothing),
        // pass it directly to the GetOrAdd(key, VALUE) overload
        // (not GetOrAdd(key, factory)), and compare the returned
        // instance by REFERENCE - GetOrAdd either stores exactly this
        // instance (we're the owner) or returns someone else's
        // already-stored one (we're a joiner), with no gap for a
        // second operation to race into.
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
            // Removed once settled (success or failure) - a later,
            // separate request for the same person (e.g. after this one
            // completes) must be free to either read the now-existing
            // file or start a fresh population attempt if this one
            // failed, not be stuck awaiting a long-finished Lazy forever.
            // Only removes the entry if it's still THIS exact Lazy
            // instance (TryRemove with the KeyValuePair overload) - an
            // extremely unlikely but theoretically possible race where a
            // new Lazy for the same key was already re-added between
            // this task settling and this cleanup running would
            // otherwise remove a DIFFERENT, newer in-flight population's
            // entry instead of this stale one.
            ((ICollection<KeyValuePair<Guid, Lazy<Task<PeopleBackdropsCacheFile>>>>)PopulateLocks)
                .Remove(new KeyValuePair<Guid, Lazy<Task<PeopleBackdropsCacheFile>>>(person.Id, lazyPopulate));
        }
    }

    /// <summary>
    /// Runs the population flow once and persists the result -
    /// separated out from ReadOrPopulateCacheFileAsync specifically so
    /// it can be wrapped in the Lazy&lt;Task&lt;...&gt;&gt; request-
    /// coalescing above; contains exactly the same population + write
    /// logic that lived inline in ReadOrPopulateCacheFileAsync before
    /// this audit's concurrency fix, unchanged otherwise.
    /// </summary>
    private async Task<PeopleBackdropsCacheFile> PopulateAndWriteAsync(Person person, PluginConfiguration config, Func<PeopleBackdropsImageEntry, Task>? onImageAccepted)
    {
        _logger.LogInformation("PeopleBackdrops: PopulateAndWriteAsync - starting population flow for {PersonName} ({PersonId}) - no cached backdrops.json found yet, this may take a few seconds (Wallpapers.com API calls + image downloads + text detection)", person.Name, person.Id);

        var populated = await PopulateAsync(person, config, onImageAccepted).ConfigureAwait(false);

        _logger.LogInformation("PeopleBackdrops: PopulateAndWriteAsync - population flow for {PersonName} finished with {Count} accepted image(s)", person.Name, populated.Images.Count);

        // History: the sandbox era wrote NO file for zero images (user
        // decision then), so every visit re-ran the lookup. Session 131
        // revised that (see below): definite empties are cached with a
        // reason and a retry date, indefinite failures still write nothing.
        // Session 131 (user decision after the smoke test measured 3.9 s per
        // Favorites-People visit for four persons without a Wallpapers.com page,
        // re-fetched every time): a DEFINITE empty outcome (404, empty list, all
        // candidates rejected, no slug) is now cached with its reason and time
        // and re-checked after EmptyCacheRetryDays. A lookup that failed for a
        // reason that says nothing about the person (network, auth, rate limit,
        // server error) still writes nothing, so the next visit tries again.
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

    /// <summary>
    /// The actual population flow - see class doc comment for the full
    /// step-by-step summary this implements.
    /// </summary>
    private async Task<PeopleBackdropsCacheFile> PopulateAsync(Person person, PluginConfiguration config, Func<PeopleBackdropsImageEntry, Task>? onImageAccepted)
    {
        var result = new PeopleBackdropsCacheFile();
        var slug = GenerateSlug(person.Name);
        var targetCount = Math.Clamp(config.PeopleBackdropsMaxImages, 1, 10);

        if (slug.Length == 0)
        {
            // REAL BUG FOUND AND FIXED (audit of special-character names):
            // a name with no Latin letters at all (e.g. a Japanese or
            // Cyrillic credit) used to reduce to an empty slug and be
            // sent to Wallpapers.com as "/keyword/?limit=N" - a
            // meaningless request that can only return unrelated
            // results or an error. There is nothing sensible to search
            // for, so stop here with 0 images (a legitimate outcome,
            // same as "no wallpapers found").
            _logger.LogInformation("PeopleBackdrops: PopulateAsync - {PersonName} has no Latin letters to build a Wallpapers.com search slug from - skipping the lookup (0 images)", person.Name);
            result.EmptyReason = "NoSlug";
            return result;
        }

        _logger.LogDebug("PeopleBackdrops: PopulateAsync - {PersonName} -> slug \"{Slug}\", target {Target} image(s), text filter {TextFilter}", person.Name, slug, targetCount, config.PeopleBackdropsTextFilterEnabled ? "ON" : "off");

        var httpClient = _httpClientFactory.CreateClient(NamedClient.Default);
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
                // Session 131: 404 = Wallpapers.com has no page for this slug - a
                // definite "no wallpapers" (Morena Baccarin, Michael Bay, ...), cached.
                _logger.LogInformation("PeopleBackdrops: PopulateAsync - Wallpapers.com has no page for slug \"{Slug}\" ({PersonName}) - 404, a definite empty result ({AcceptedSoFar} image(s) so far)", slug, person.Name, result.Images.Count);
                if (result.Images.Count == 0) { result.EmptyReason = "NotFound"; }
                break;
            }
            catch (Exception ex)
            {
                // Session 131: anything else (no internet, DNS, timeout, 401/403/429,
                // 5xx) says nothing about the person - never cached as empty.
                result.LookupFailed = true;
                _logger.LogWarning(ex, "PeopleBackdrops: PopulateAsync - Wallpapers.com API request failed for slug \"{Slug}\" ({PersonName}) at limit={Limit}, stopping with whatever was already accepted ({AcceptedSoFar} image(s)) - not a definite result, the next visit retries", slug, person.Name, limit, result.Images.Count);
                break;
            }

            if (candidates is null || candidates.Count == 0)
            {
                // Genuinely no results for this slug at all (e.g. a
                // less-known person with no matching wallpapers) -
                // nothing more to try, even at a higher limit.
                _logger.LogInformation("PeopleBackdrops: PopulateAsync - {PersonName} -> 0 candidates from Wallpapers.com for slug \"{Slug}\" - nothing to try at a higher limit either, stopping", person.Name, slug);
                if (result.Images.Count == 0) { result.EmptyReason = "NoCandidates"; }
                break;
            }

            // Only evaluate the NEWLY-appeared candidates past what a
            // previous, smaller-limit iteration of this same loop
            // already checked and rejected - avoids redundant work on
            // an escalation.
            // !!! STILL AN UNVERIFIED ASSUMPTION - separate from the
            // response-shape question resolved above (that one WAS
            // confirmed against a real response and fixed): this relies
            // on the API returning a STABLE order across calls with
            // different `limit` values for the same slug (i.e.
            // limit=40's own first 20 entries are identical to
            // limit=20's own full result, just with 20 more appended)
            // - never confirmed, since confirming it needs two real
            // calls at different limits compared against each other,
            // not just the one real example response obtained so far.
            // If the API instead reorders results between calls (e.g.
            // genuinely random per-request), this optimization would
            // incorrectly skip re-checking candidates that moved to a
            // different position, and could miss some never-yet-checked
            // ones that landed earlier. Worth a real test before relying
            // on this; the safe fallback if it turns out unstable would
            // be to just re-check the entire `candidates` list on every
            // escalation instead of only the tail.
            for (var i = alreadyCheckedCount; i < candidates.Count; i++)
            {
                var candidate = candidates[i];
                if (string.IsNullOrEmpty(candidate.Webp) || !IsSafeHttpsUrl(candidate.Webp))
                {
                    // Real security gap found during audit: candidate.Webp
                    // comes directly from an external, third-party API
                    // response with zero prior validation - without this
                    // check, an unexpected/malicious response could point
                    // this server-side GetByteArrayAsync() call at an
                    // internal address (SSRF - e.g. a cloud metadata
                    // endpoint, localhost, or another internal service),
                    // and the same unvalidated string would also be
                    // persisted and returned directly to the browser as a
                    // CSS background-image url(). Requiring an absolute
                    // https:// URL closes both paths at once - see
                    // IsSafeHttpsUrl's own doc comment for what it checks.
                    rejectedUnsafeUrl++;
                    if (!string.IsNullOrEmpty(candidate.Webp))
                    {
                        _logger.LogWarning("PeopleBackdrops: PopulateAsync - {PersonName} -> rejected a candidate with a non-https/malformed \"webp\" URL: \"{Url}\" - the response schema itself is now confirmed correct (see WallpapersApiKeywordResponse's own doc comment), so this specific candidate's URL is a genuinely unusual/unexpected value, not a sign the schema assumption is wrong", person.Name, candidate.Webp);
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

                // Streams this image to the frontend the instant it's
                // accepted, rather than only after the entire flow
                // finishes - see PeopleBackdropsStreamLine's own doc
                // comment for the full "why". Null when this request is
                // only a "joiner" on an already-in-progress population
                // for the same person (see ReadOrPopulateCacheFileAsync)
                // rather than the one that actually started it - a rare
                // case (two simultaneous requests for the exact same
                // person mid-population), deliberately kept simple: the
                // joiner just gets the full result at the very end
                // instead of a live stream of its own.
                if (onImageAccepted is not null)
                {
                    try
                    {
                        await onImageAccepted(acceptedImage).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        // A broken/disconnected HTTP response (the user
                        // navigated away mid-stream, a network blip,
                        // etc.) must NOT abort the population flow
                        // itself - the result is still worth completing
                        // and caching for the NEXT request, even if
                        // nobody's listening to this particular stream
                        // anymore.
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
                // Already at the API's own absolute maximum and still
                // short of the target - accept fewer than requested,
                // silently, per this project's own established "0/fewer
                // available is a legitimate outcome" philosophy.
                _logger.LogInformation("PeopleBackdrops: PopulateAsync - {PersonName} -> reached the API's own max limit (60) with only {Accepted}/{Target} image(s) accepted (rejected: {AspectRatio} aspect-ratio, {Text} text-detected, {UnsafeUrl} unsafe-url, {DownloadFailed} download-failed) - stopping, this is a legitimate outcome not an error", person.Name, result.Images.Count, targetCount, rejectedAspectRatio, rejectedText, rejectedUnsafeUrl, rejectedDownloadFailed);
                // Session 131: every candidate was rejected by our own filters - a
                // definite empty result (cached); failed downloads are not definite.
                if (result.Images.Count == 0) { if (rejectedDownloadFailed == 0) { result.EmptyReason = "AllRejected"; } else { result.LookupFailed = true; } }
                break;
            }

            _logger.LogDebug("PeopleBackdrops: PopulateAsync - {PersonName} -> only {Accepted}/{Target} accepted so far, escalating limit {OldLimit} -> {NewLimit}", person.Name, result.Images.Count, targetCount, limit, Math.Min(60, limit * 2));
            limit = Math.Min(60, limit * 2);
        }

        return result;
    }

    /// <summary>
    /// Automatic name-to-slug conversion only - no manual per-person
    /// override field (explicit user decision - "wir hardcoden das").
    /// Lowercase, spaces to hyphens, accented characters stripped -
    /// confirmed necessary via a real example (Beyoncé's own actual
    /// Wallpapers.com URL is wallpapers.com/beyonce, no accent), not
    /// assumed.
    /// </summary>
    private static string GenerateSlug(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            // A Person item without a usable name has nothing to search
            // for; an empty slug is handled by PopulateAsync (lookup
            // skipped, 0 images). Without this, name.Normalize below
            // would throw a NullReferenceException -> HTTP 500.
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

        // REAL BUG FOUND AND FIXED (audit of special-character names,
        // reproduced with a 1:1 re-implementation of this exact function):
        // the FormD decomposition above only separates letters that are
        // base+combining-mark pairs (é, ë, ö, ñ, ç ...). Letters that are
        // their OWN code point with no decomposition - ø, æ, œ, ß, ł, đ,
        // þ, ð, dotless ı - survived it intact and were then silently
        // deleted by the [a-z0-9-] filter below: "Bjørn" -> "bjrn",
        // "Søren" -> "sren", "Łukasz" -> "ukasz", "Straße" -> "strae".
        // A wrong slug means 0 Wallpapers.com results, which (by design)
        // writes no cache file - so every visit re-queried the API for
        // nothing. Mapped to their standard ASCII transliterations
        // instead. (Whether Wallpapers.com itself spells a given name
        // "bjorn" or "bjoern" cannot be verified from here; "bjrn" is
        // certainly wrong.)
        slug = slug
            .Replace("ø", "o").Replace("æ", "ae").Replace("œ", "oe")
            .Replace("ß", "ss").Replace("ł", "l").Replace("đ", "d")
            .Replace("þ", "th").Replace("ð", "d").Replace("ı", "i");

        slug = slug.Replace(' ', '-');

        // Strip anything that isn't a lowercase letter, digit, or hyphen
        // - defensive cleanup for names containing punctuation (e.g.
        // "Michael J. Fox") that would otherwise end up in the slug
        // verbatim.
        var cleaned = new StringBuilder();
        foreach (var c in slug)
        {
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')
            {
                cleaned.Append(c);
            }
        }

        // Collapse runs of hyphens and trim leading/trailing ones -
        // "Cheech & Chong" used to become "cheech--chong" (the stripped
        // '&' left two adjacent separators), " Tom Hanks " -> "-tom-hanks-".
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
    /// Strict 16:9 lock - hardcoded, no admin-facing toggle (explicit
    /// user decision, unlike the text filter which does have its own
    /// enable/disable checkbox). A small tolerance accounts for pixel
    /// rounding on real-world image dimensions, which will essentially
    /// never be a mathematically exact 16:9 ratio.
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
            // Unreadable/corrupt image data - can't confirm it passes,
            // so it doesn't.
            return false;
        }
    }

    /// <summary>
    /// DTOs for deserializing the Wallpapers.com /api/v1/keyword/&lt;slug&gt;
    /// response - CONFIRMED against a real response (not the earlier
    /// guessed shape), obtained by the user running
    /// `curl "https://wallpapers.com/api/v1/keyword/keanu-reeves?limit=5"`
    /// directly. Real shape, verbatim:
    /// <c>{"items":[{"alt":"...","credit":"Wallpapers.com","credit_url":"...","high":"https://wallpapers.com/images/high/....jpg","id":158609,"thumb":"...","title":"...","type":"wallpaper","url":"...","webp":"https://wallpapers.com/images/high/....webp"}],"keyword":"keanu-reeves","success":true,"total":75}</c>
    /// The earlier, unverified guess (inferred from the /daily-wallpaper
    /// endpoint's own single-object example during the concept phase,
    /// since the official docs never showed a real example for THIS
    /// endpoint specifically) had exactly one wrong field: the wrapper
    /// array was assumed to be named "wallpapers" - it's actually
    /// "items". This single mismatch was the entire root cause of every
    /// person populating to 0 images: since System.Text.Json found no
    /// "wallpapers" property in the real response, this field
    /// deserialized to null every time, `candidates is null` was always
    /// true, and the population loop stopped immediately believing the
    /// API had returned nothing - even though a real search (e.g. this
    /// exact Keanu Reeves request) returns up to `total` results (75 in
    /// this real example). The "webp" field name itself was already
    /// correct by coincidence. "high" (a .jpg/.png equivalent of the
    /// same image) exists too but is deliberately not used - "webp" was
    /// the explicit original design choice for file size.
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
    /// SSRF hardening (see the call site's own doc comment for the full
    /// "why") - requires an absolute, well-formed https:// URL before
    /// this server ever makes an outbound request to it, or persists/
    /// returns it to the browser. Deliberately does NOT restrict to the
    /// wallpapers.com host specifically - unlike the API endpoint itself
    /// (which is hardcoded to WallpapersApiBase), the actual image CDN
    /// domain Wallpapers.com uses for `webp` URLs was never confirmed
    /// during the concept phase (same unverified-response-shape
    /// limitation noted elsewhere in this file), so a host allowlist
    /// here risks rejecting every genuinely legitimate image if that CDN
    /// turns out to be a different domain. Scheme-restriction to https
    /// alone still closes the concrete risks that matter here (no
    /// internal-network http:// targets, no file://, no other exotic
    /// schemes).
    /// </summary>
    private static bool IsSafeHttpsUrl(string url)
    {
        return Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps;
    }
}
