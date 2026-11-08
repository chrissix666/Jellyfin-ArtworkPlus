using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using Jellyfin.Plugin.ArtworkPlus.Helpers;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// A single poster candidate with its own version fingerprint: the file's LastWriteTimeUtc (not the folder's,
/// which does not change when a file is overwritten in place). The fingerprint goes into the image URL (?v=...),
/// the same principle as Jellyfin's image tags, so a browser may cache an URL forever and a replaced file
/// still shows up at once under its new URL.
/// </summary>
public class PosterEntry
{
    public string FileName { get; set; } = string.Empty;

    /// <summary>Set for child posters (a Set's movies, a series' seasons); the client uses it instead of the file URL.</summary>
    public string? Url { get; set; }

    /// <summary>A Set movie shown as Keyart with "Set Keyart logo overlay" on: the movie's id, whose Jellyfin Logo is drawn over this slide.</summary>
    public string? LogoItemId { get; set; }

    public string Version { get; set; } = string.Empty;
}

/// <summary>
/// DTO for GET /Extraposter/{itemId}/quickcheck, the poster arbiter's lightweight applicability probe. Smaller than
/// PosterListResult on purpose: deciding "will something replace Main, and after how long" needs no poster entries
/// and no playback settings.
/// </summary>
public class QuickCheckResult
{
    public bool IsApplicable { get; set; }

    public bool DelayEnabled { get; set; }

    public int DelayMs { get; set; }

    /// <summary>
    /// "extraposter" or "extrakeyart"; only meaningful when the request's type was "auto" (see ResolvePosterType).
    /// The client uses it for the explicit-type follow-up requests (GetPosterList, image URLs).
    /// </summary>
    public string ResolvedType { get; set; } = string.Empty;
}

/// <summary>
/// Result DTO for the poster list: the file names in order plus every timing/behaviour value the client needs for
/// playback (cycle/fade/delay/single pass), so they are configured on the admin page rather than in the script.
/// Properties stay PascalCase without [JsonPropertyName]: Jellyfin's global JSON options are PascalCase.
/// </summary>
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

    /// <summary>Library views only: one shared clock per page for all tiles of this type.</summary>
    public bool SyncEnabled { get; set; }

    /// <summary>Library views only: tile blank until our image is ready (on) or Jellyfin's poster first (off).</summary>
    public bool SeamlessEnabled { get; set; }

    /// <summary>The item has a Jellyfin Logo image (the tile logo overlay needs no extra item request).</summary>
    public bool HasLogo { get; set; }

    /// <summary>Geometry of the per-slide Set Keyart logo (see PosterEntry.LogoItemId).</summary>
    public int SetLogoVerticalPositionPercent { get; set; }

    public int SetLogoSizePercent { get; set; }

    /// <summary>
    /// Logo overlay, the same three fields as CustomPosterResult. Set only when ResolvedType is "extrakeyart" and
    /// the Extrakeyart logo is enabled; the client has no other way to know the server's config. Extraposter never
    /// sets them (like Postercase, it has no logo overlay).
    /// </summary>
    public bool LogoEnabled { get; set; }

    public int LogoVerticalPositionPercent { get; set; }

    public int LogoSizePercent { get; set; }

    /// <summary>"Movie" | "Series" | "BoxSet": the kind the "Also on" filter of the batch endpoint needs (BoxSet follows the Movies settings).</summary>
    public string ItemKind { get; set; } = string.Empty;
}

/// <summary>
/// Result DTO of the library-view batch endpoint: one entry per requested itemId, keyed by the id as a string. Each
/// entry carries the Library Movies or Library TV shows settings of its item. There is deliberately no shared timing
/// for the whole response: Movies and TV shows can have different cycle/fade/delay values, so the client groups the
/// tiles by type and runs one synchronized clock per type.
/// </summary>
public class BatchPosterListResult
{
    public Dictionary<string, PosterListResult> Items { get; set; } = new();
}

/// <summary>
/// Serves character posters directly from the movie folder, entirely outside Jellyfin's ImageType system (the
/// backdrop slot is not reused for them). AllowAnonymous because the statically injected client script and its
/// plain image URLs cannot carry Jellyfin's auth token.
///
/// Logging: every decision that can lead to "no poster found" is logged, not only the outcome, so the server log
/// alone is enough to debug a case. All lines start with "Extraposter:". LogInformation covers the request-level
/// flow (GetPosterList / GetQuickCheck / batch start and end with timing); LogDebug the per-item and per-image
/// detail, because a library page asks for 200 items and every tile image (enable the Debug override for
/// Jellyfin.Plugin.ArtworkPlus to see it). LogWarning for suspicious states, LogError for unexpected exceptions.
/// </summary>
[ApiController]
[Route("Extraposter")]
[AllowAnonymous]
public class ExtraposterController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<ExtraposterController> _logger;
    private readonly IMemoryCache _cache;
    private readonly IUserManager _userManager;

    // Upper limit for the numbered variants (Standalone/Prefixed). Jellyfin's PopulateBackdrops stops after a few
    // gaps; this simply lists everything up to the limit. The Folder variant takes the whole folder anyway.
    private const int MaxNumberedPosters = 50;

    // Safety net against unbounded cache growth. Entries are not invalidated by time (the composite cache key
    // handles that, see ResolveCandidates), but an entry nobody asks for any more (its key orphaned by a changed
    // folder timestamp or setting) is evicted after this time.
    private static readonly TimeSpan CacheSlidingExpiration = TimeSpan.FromHours(6);

    /// <summary>
    /// How long a library batch answer per item is reused. The file list underneath is keyed by the folder's write
    /// time, so a new file is seen once this window has passed (or a config save replaces the config object). A cold
    /// 200-item batch can take seconds on slow drives, a cached one milliseconds.
    /// </summary>
    private static readonly TimeSpan LibraryResultCacheWindow = TimeSpan.FromSeconds(30);

    public ExtraposterController(ILibraryManager libraryManager, ILogger<ExtraposterController> logger, IMemoryCache cache, IUserManager userManager)
    {
        _libraryManager = libraryManager;
        _logger = logger;
        _cache = cache;
        _userManager = userManager;
    }

    // The user behind this request (the client sends its token), read once per request; the library batch
    // resolves items in parallel.
    private JfUser? _requestUser;
    private bool _requestUserRead;

    private JfUser? GetRequestUser()
    {
        if (_requestUserRead) { return _requestUser; }
        _requestUserRead = true;
        var claim = User?.FindFirst("Jellyfin-UserId")?.Value;
        _requestUser = !string.IsNullOrEmpty(claim) && Guid.TryParse(claim, out var userId) ? _userManager.GetUserById(userId) : null;
        return _requestUser;
    }

    /// <summary>TV shows have no Prefixed mode (a show folder is exclusive): Standalone or Folder.</summary>
    private static string TvNaming(string mode) => mode == "Folder" ? "Folder" : "Standalone";

    /// <summary>
    /// The word the numbered files start with in Prefixed / Standalone mode: its own setting per type and item kind,
    /// independent of the folder name. Sets use the Movies setting, like every other tab.
    /// </summary>
    private static string ExtraTypeName(PluginConfiguration c, string posterType, bool tv) => posterType == "extrakeyart"
        ? (tv ? c.ExtrakeyartTvShowsTypeName : c.ExtrakeyartMoviesTypeName)
        : (tv ? c.ExtraposterTvShowsTypeName : c.ExtraposterMoviesTypeName);

    /// <summary>
    /// The "is this applicable at all" check shared by GetPosterList and GetQuickCheck: item resolution plus the
    /// per-type enabled checks. Returns folderPath=null when not applicable for any reason; the caller logs it.
    /// posterType "extraposter" (default) reads the Extraposter* fields, "extrakeyart" the Extrakeyart* set.
    /// </summary>
    private (bool applicable, string? folderPath, string namingMode, string folderName) ResolveApplicability(Guid itemId, PluginConfiguration config, string posterType = "extraposter", bool isLibraryScope = false)
    {
        // Tab-level master switch, checked first; it covers both types, which live under the same Extraposter tab.
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
            var showOnMovies = isExtrakeyart
                ? (isLibraryScope ? config.ExtrakeyartMoviesLibraryShowOnMovies : config.ExtrakeyartMoviesDetailShowOnMovies)
                : (isLibraryScope ? config.ExtraposterMoviesLibraryShowOnMovies : config.ExtraposterMoviesDetailShowOnMovies);
            var moviesDetailOrLibraryEnabled = isExtrakeyart
                ? (isLibraryScope ? true : config.ExtrakeyartMoviesDetailEnabled)
                : (isLibraryScope ? true : config.ExtraposterMoviesDetailEnabled);
            if (!showOnMovies || !moviesDetailOrLibraryEnabled)
            {
                return (false, null, string.Empty, string.Empty);
            }

            var moviesNamingMode = isExtrakeyart ? config.ExtrakeyartMoviesNamingMode : config.ExtraposterMoviesNamingMode;
            var moviesFolderName = isExtrakeyart ? config.ExtrakeyartMoviesFolderName : config.ExtraposterMoviesFolderName;
            return (true, movieFolderPath, moviesNamingMode, moviesFolderName);
        }

        // Sets have no naming-mode / folder-name fields of their own. Naming is always "Standalone" here, whatever
        // the Movies mode says: a Set has one exclusive main folder (same as AnimatedPosterController's BoxSet branch).
        var (isSet, setFolderPath) = ResolveSetFolder(itemId);
        if (isSet && setFolderPath is not null)
        {
            var showOnSets = isExtrakeyart
                ? (isLibraryScope ? config.ExtrakeyartMoviesLibraryShowOnSets : config.ExtrakeyartMoviesDetailShowOnSets)
                : (isLibraryScope ? config.ExtraposterMoviesLibraryShowOnSets : config.ExtraposterMoviesDetailShowOnSets);
            var setsDetailOrLibraryEnabled = isExtrakeyart
                ? (isLibraryScope ? true : config.ExtrakeyartMoviesDetailEnabled)
                : (isLibraryScope ? true : config.ExtraposterMoviesDetailEnabled);
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

        var showOnTvShows = isExtrakeyart
            ? (isLibraryScope ? config.ExtrakeyartTvShowsLibraryShowOnTvShows : config.ExtrakeyartTvShowsDetailShowOnTvShows)
            : (isLibraryScope ? config.ExtraposterTvShowsLibraryShowOnTvShows : config.ExtraposterTvShowsDetailShowOnTvShows);
        var tvShowsDetailOrLibraryEnabled = isExtrakeyart
            ? (isLibraryScope ? true : config.ExtrakeyartTvShowsDetailEnabled)
            : (isLibraryScope ? true : config.ExtraposterTvShowsDetailEnabled);
        if (!showOnTvShows || !tvShowsDetailOrLibraryEnabled)
        {
            return (false, null, string.Empty, string.Empty);
        }

        // TV shows know Standalone and Folder only; a "Prefixed" in a saved config is read as Standalone.
        var tvShowsNamingMode = TvNaming(isExtrakeyart ? config.ExtrakeyartTvShowsNamingMode : config.ExtraposterTvShowsNamingMode);
        var tvShowsFolderName = isExtrakeyart ? config.ExtrakeyartTvShowsFolderName : config.ExtraposterTvShowsFolderName;
        return (true, seriesFolderPath, tvShowsNamingMode, tvShowsFolderName);
    }


    /// <summary>
    /// The per-view slideshow settings of one feature for one content type (Movies / TV shows x Detail page /
    /// Library views; nothing is shared between the views). Sets use the Movies settings, as everywhere else.
    /// </summary>
    private sealed record ExtraViewSettings(
        string OrderMode, bool SinglePass, int CycleTimeMs, int FadeTimeMs, bool DelayEnabled, int DelayMs,
        bool LogoEnabled, int LogoVerticalPositionPercent, int LogoSizePercent, bool SyncEnabled, bool SeamlessEnabled,
        string UnnumberedMode, bool SourceFiles, bool SourceChildren, bool ChildrenFirst, string ChildOrder, bool IncludeSpecials, bool SkipSingleSeason,
        string SetImage, string SetFallback, string SetFallback2, bool SetKeyartLogoEnabled, int SetKeyartLogoVerticalPositionPercent, int SetKeyartLogoSizePercent,
        bool FilesRandomStart, bool ChildRandomStart);

    // The four-value priority (FilesFirst | FilesOnly | SetPostersFirst | SetPostersOnly, TV: SeasonPosters...)
    // decides which sources a Set / series uses and in which order. A movie has no children, so its files are
    // always its only source (ResolveEntries falls back to files when an item has no children at all).
    // The single values "Files" / "SetPosters" / "SeasonPosters" are read as FilesOnly / ...First.
    private static string NormalizePriority(string priority) => priority switch
    {
        "Files" or "" or null => "FilesOnly",
        "SetPosters" => "SetPostersFirst",
        "SeasonPosters" => "SeasonPostersFirst",
        _ => priority
    };
    private static bool SourceUsesFiles(string priority) => !NormalizePriority(priority).EndsWith("PostersOnly", StringComparison.Ordinal);
    private static bool SourceUsesChildren(string priority) => NormalizePriority(priority) != "FilesOnly";
    private static bool SourceChildrenFirst(string priority) { var p = NormalizePriority(priority); return p.StartsWith("SetPosters", StringComparison.Ordinal) || p.StartsWith("SeasonPosters", StringComparison.Ordinal); }

    private ExtraViewSettings GetViewSettings(PluginConfiguration c, Guid itemId, string resolvedType, bool isLibraryScope)
    {
        var item = _libraryManager.GetItemById(itemId);
        var tv = item is Series;
        var keyart = resolvedType == "extrakeyart";
        if (!keyart)
        {
            if (!tv)
            {
                return isLibraryScope
                    ? new ExtraViewSettings(c.ExtraposterMoviesLibraryOrderMode, c.ExtraposterMoviesLibrarySinglePass, c.ExtraposterMoviesLibraryCycleTimeMs, c.ExtraposterMoviesLibraryFadeTimeMs, c.ExtraposterMoviesLibraryDelayEnabled, c.ExtraposterMoviesLibraryDelayMs, false, 0, 0, c.ExtraposterMoviesLibrarySyncEnabled, c.ExtraposterMoviesLibrarySeamlessEnabled,
                        c.ExtraposterMoviesLibraryUnnumberedMode, SourceUsesFiles(c.ExtraposterMoviesLibrarySourcePriority), SourceUsesChildren(c.ExtraposterMoviesLibrarySourcePriority), SourceChildrenFirst(c.ExtraposterMoviesLibrarySourcePriority), c.ExtraposterMoviesLibrarySetOrder, false, false, c.ExtraposterMoviesLibrarySetImage, c.ExtraposterMoviesLibrarySetFallback, c.ExtraposterMoviesLibrarySetFallback2, c.ExtraposterMoviesLibrarySetKeyartLogoEnabled, c.ExtraposterMoviesLibrarySetKeyartLogoVerticalPositionPercent, c.ExtraposterMoviesLibrarySetKeyartLogoSizePercent, c.ExtraposterMoviesLibraryRandomStart, c.ExtraposterMoviesLibrarySetRandomStart)
                    : new ExtraViewSettings(c.ExtraposterMoviesDetailOrderMode, c.ExtraposterMoviesDetailSinglePass, c.ExtraposterMoviesDetailCycleTimeMs, c.ExtraposterMoviesDetailFadeTimeMs, c.ExtraposterMoviesDetailDelayEnabled, c.ExtraposterMoviesDetailDelayMs, false, 0, 0, false, true,
                        c.ExtraposterMoviesDetailUnnumberedMode, SourceUsesFiles(c.ExtraposterMoviesDetailSourcePriority), SourceUsesChildren(c.ExtraposterMoviesDetailSourcePriority), SourceChildrenFirst(c.ExtraposterMoviesDetailSourcePriority), c.ExtraposterMoviesDetailSetOrder, false, false, c.ExtraposterMoviesDetailSetImage, c.ExtraposterMoviesDetailSetFallback, c.ExtraposterMoviesDetailSetFallback2, c.ExtraposterMoviesDetailSetKeyartLogoEnabled, c.ExtraposterMoviesDetailSetKeyartLogoVerticalPositionPercent, c.ExtraposterMoviesDetailSetKeyartLogoSizePercent, c.ExtraposterMoviesDetailRandomStart, c.ExtraposterMoviesDetailSetRandomStart);
            }
            return isLibraryScope
                ? new ExtraViewSettings(c.ExtraposterTvShowsLibraryOrderMode, c.ExtraposterTvShowsLibrarySinglePass, c.ExtraposterTvShowsLibraryCycleTimeMs, c.ExtraposterTvShowsLibraryFadeTimeMs, c.ExtraposterTvShowsLibraryDelayEnabled, c.ExtraposterTvShowsLibraryDelayMs, false, 0, 0, c.ExtraposterTvShowsLibrarySyncEnabled, c.ExtraposterTvShowsLibrarySeamlessEnabled,
                        c.ExtraposterTvShowsLibraryUnnumberedMode, SourceUsesFiles(c.ExtraposterTvShowsLibrarySourcePriority), SourceUsesChildren(c.ExtraposterTvShowsLibrarySourcePriority), SourceChildrenFirst(c.ExtraposterTvShowsLibrarySourcePriority), c.ExtraposterTvShowsLibrarySeasonOrder, c.ExtraposterTvShowsLibraryIncludeSpecials, c.ExtraposterTvShowsLibrarySkipSingleSeason, "Poster", "None", "None", false, 0, 0, c.ExtraposterTvShowsLibraryRandomStart, c.ExtraposterTvShowsLibrarySeasonRandomStart)
                : new ExtraViewSettings(c.ExtraposterTvShowsDetailOrderMode, c.ExtraposterTvShowsDetailSinglePass, c.ExtraposterTvShowsDetailCycleTimeMs, c.ExtraposterTvShowsDetailFadeTimeMs, c.ExtraposterTvShowsDetailDelayEnabled, c.ExtraposterTvShowsDetailDelayMs, false, 0, 0, false, true,
                        c.ExtraposterTvShowsDetailUnnumberedMode, SourceUsesFiles(c.ExtraposterTvShowsDetailSourcePriority), SourceUsesChildren(c.ExtraposterTvShowsDetailSourcePriority), SourceChildrenFirst(c.ExtraposterTvShowsDetailSourcePriority), c.ExtraposterTvShowsDetailSeasonOrder, c.ExtraposterTvShowsDetailIncludeSpecials, c.ExtraposterTvShowsDetailSkipSingleSeason, "Poster", "None", "None", false, 0, 0, c.ExtraposterTvShowsDetailRandomStart, c.ExtraposterTvShowsDetailSeasonRandomStart);
        }
        if (!tv)
        {
            return isLibraryScope
                ? new ExtraViewSettings(c.ExtrakeyartMoviesLibraryOrderMode, c.ExtrakeyartMoviesLibrarySinglePass, c.ExtrakeyartMoviesLibraryCycleTimeMs, c.ExtrakeyartMoviesLibraryFadeTimeMs, c.ExtrakeyartMoviesLibraryDelayEnabled, c.ExtrakeyartMoviesLibraryDelayMs, c.ExtrakeyartMoviesLibraryLogoEnabled, c.ExtrakeyartMoviesLibraryLogoVerticalPositionPercent, c.ExtrakeyartMoviesLibraryLogoSizePercent, c.ExtrakeyartMoviesLibrarySyncEnabled, c.ExtrakeyartMoviesLibrarySeamlessEnabled,
                        c.ExtrakeyartMoviesLibraryUnnumberedMode, true, false, false, "Ascending", false, false, "Poster", "None", "None", false, 0, 0, c.ExtrakeyartMoviesLibraryRandomStart, false)
                : new ExtraViewSettings(c.ExtrakeyartMoviesDetailOrderMode, c.ExtrakeyartMoviesDetailSinglePass, c.ExtrakeyartMoviesDetailCycleTimeMs, c.ExtrakeyartMoviesDetailFadeTimeMs, c.ExtrakeyartMoviesDetailDelayEnabled, c.ExtrakeyartMoviesDetailDelayMs, c.ExtrakeyartMoviesDetailLogoEnabled, c.ExtrakeyartMoviesDetailLogoVerticalPositionPercent, c.ExtrakeyartMoviesDetailLogoSizePercent, false, true,
                        c.ExtrakeyartMoviesDetailUnnumberedMode, true, false, false, "Ascending", false, false, "Poster", "None", "None", false, 0, 0, c.ExtrakeyartMoviesDetailRandomStart, false);
        }
        return isLibraryScope
            ? new ExtraViewSettings(c.ExtrakeyartTvShowsLibraryOrderMode, c.ExtrakeyartTvShowsLibrarySinglePass, c.ExtrakeyartTvShowsLibraryCycleTimeMs, c.ExtrakeyartTvShowsLibraryFadeTimeMs, c.ExtrakeyartTvShowsLibraryDelayEnabled, c.ExtrakeyartTvShowsLibraryDelayMs, c.ExtrakeyartTvShowsLibraryLogoEnabled, c.ExtrakeyartTvShowsLibraryLogoVerticalPositionPercent, c.ExtrakeyartTvShowsLibraryLogoSizePercent, c.ExtrakeyartTvShowsLibrarySyncEnabled, c.ExtrakeyartTvShowsLibrarySeamlessEnabled,
                        c.ExtrakeyartTvShowsLibraryUnnumberedMode, true, false, false, "Ascending", false, false, "Poster", "None", "None", false, 0, 0, c.ExtrakeyartTvShowsLibraryRandomStart, false)
            : new ExtraViewSettings(c.ExtrakeyartTvShowsDetailOrderMode, c.ExtrakeyartTvShowsDetailSinglePass, c.ExtrakeyartTvShowsDetailCycleTimeMs, c.ExtrakeyartTvShowsDetailFadeTimeMs, c.ExtrakeyartTvShowsDetailDelayEnabled, c.ExtrakeyartTvShowsDetailDelayMs, c.ExtrakeyartTvShowsDetailLogoEnabled, c.ExtrakeyartTvShowsDetailLogoVerticalPositionPercent, c.ExtrakeyartTvShowsDetailLogoSizePercent, false, true,
                        c.ExtrakeyartTvShowsDetailUnnumberedMode, true, false, false, "Ascending", false, false, "Poster", "None", "None", false, 0, 0, c.ExtrakeyartTvShowsDetailRandomStart, false);
    }


    // =====================================================================
    // Child posters as a slideshow source: a Set's movies (release-date
    // order, Jellyfin's PremiereDateComparer rule) or a series' seasons
    // (season number; specials optional and always first; a single usable
    // season poster counts as "nothing" when SkipSingleSeason is on). Only
    // children with a Primary image count. The client gets Jellyfin's own
    // image URL per child (PosterEntry.Url).
    // =====================================================================

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

    private static PosterEntry? PrimaryEntry(BaseItem child)
    {
        if (!child.HasImage(ImageType.Primary, 0)) { return null; }
        var info = child.GetImageInfo(ImageType.Primary, 0);
        var tag = info is null ? "0" : info.DateModified.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new PosterEntry
        {
            FileName = child.Id.ToString("N"),
            Version = tag,
            Url = "/Items/" + child.Id.ToString("N") + "/Images/Primary?tag=" + tag + "&maxWidth=800"
        };
    }

    /// <summary>A movie's Postercase/Keyart/Animated file as an entry (served by GetChildImage), or null.</summary>
    private static PosterEntry? CustomEntry(PluginConfiguration config, Movie movie, string posterType)
    {
        var path = posterType.StartsWith("animated", StringComparison.Ordinal)
            ? Helpers.AnimatedPosterFileResolver.Resolve(config, movie, posterType)
            : Helpers.CustomPosterFileResolver.Resolve(config, movie, posterType);
        if (path is null) { return null; }
        var v = Helpers.BackdropFileResolver.VersionTag(path);
        return new PosterEntry
        {
            FileName = movie.Id.ToString("N") + "|" + posterType,
            Version = v,
            Url = "/Extraposter/child-image?itemId=" + movie.Id.ToString("N") + "&type=" + posterType + "&v=" + v
        };
    }

    /// <summary>
    /// The chosen image of a Set's movie (Poster / Postercase / Keyart / AnimatedPoster / AnimatedKeyart), else its
    /// first fallback, else its second, else nothing. A Keyart slide of either kind gets the movie's own logo when
    /// the Set Keyart logo is on, decided by the kind actually shown.
    /// </summary>
    private static PosterEntry? SetMovieEntry(PluginConfiguration config, BaseItem child, ExtraViewSettings view)
    {
        PosterEntry? Pick(string kind)
        {
            if (kind == "Poster") { return PrimaryEntry(child); }
            if (child is not Movie movie) { return null; }
            var fileKind = kind switch { "Postercase" => "postercase", "Keyart" => "keyart", "AnimatedPoster" => "animatedposter", "AnimatedKeyart" => "animatedkeyart", _ => null };
            if (fileKind is null) { return null; }
            var entry = CustomEntry(config, movie, fileKind);
            if (entry is not null && (kind == "Keyart" || kind == "AnimatedKeyart") && view.SetKeyartLogoEnabled && child.HasImage(ImageType.Logo, 0))
            {
                entry.LogoItemId = child.Id.ToString("N");
            }
            return entry;
        }
        var tried = new System.Collections.Generic.HashSet<string> { view.SetImage };
        var entry0 = Pick(view.SetImage);
        if (entry0 is not null) { return entry0; }
        foreach (var fb in new[] { view.SetFallback, view.SetFallback2 })
        {
            if (fb == "None") { return null; }
            if (!tried.Add(fb)) { continue; }
            var e = Pick(fb);
            if (e is not null) { return e; }
        }
        return null;
    }

    /// <summary>
    /// Set order / Season order: Shuffle and Random have the same meanings as the files' Playback (Shuffle: one
    /// random permutation, no repeats per round; Random: as many random draws as entries, repeats allowed). The
    /// sorted values pass through.
    /// </summary>
    private static List<PosterEntry> ApplyEntryOrder(List<PosterEntry> entries, string childOrder, bool randomStart)
    {
        if (entries.Count < 2) { return entries; }
        // Random start position for the sorted orders (Shuffle/Random are random anyway).
        if (childOrder != "Shuffle" && childOrder != "Random") { return randomStart ? Helpers.RandomStart.Rotate(entries) : entries; }
        if (childOrder == "Shuffle") { return entries.OrderBy(_ => Guid.NewGuid()).ToList(); }
        var rnd = new Random();
        return Enumerable.Range(0, entries.Count).Select(_ => entries[rnd.Next(entries.Count)]).ToList();
    }

    private List<PosterEntry> ResolveChildPosters(PluginConfiguration config, BaseItem item, ExtraViewSettings view)
    {
        if (item is BoxSet boxSet)
        {
            // Only the members Jellyfin lists for this user: library access and parental rating / blocked tags,
            // the two steps of vanilla's Folder.AddChildren. No user, no members (the set's own files stay).
            var user = GetRequestUser();
            var movies = user is null ? new List<BaseItem>() : boxSet.GetLinkedChildren(user).Where(m => m.IsVisible(user)).ToList();
            var ordered = view.ChildOrder == "Descending"
                ? movies.OrderByDescending(PremiereSortDate).ToList()
                : movies.OrderBy(PremiereSortDate).ToList();
            return ApplyEntryOrder(ordered.Select(c => SetMovieEntry(config, c, view)).Where(e => e is not null).Select(e => e!).ToList(), view.ChildOrder, view.ChildRandomStart);
        }
        if (item is Series series)
        {
            var seasons = series.Children.OfType<Season>().Where(x => x.HasImage(ImageType.Primary, 0)).ToList();
            var specials = seasons.Where(x => (x.IndexNumber ?? 0) == 0).ToList();
            var regular = seasons.Where(x => (x.IndexNumber ?? 0) != 0).ToList();
            regular = view.ChildOrder == "Descending"
                ? regular.OrderByDescending(x => x.IndexNumber ?? 0).ToList()
                : regular.OrderBy(x => x.IndexNumber ?? 0).ToList();
            var usable = view.IncludeSpecials ? specials.Concat(regular).ToList() : regular;
            if (view.SkipSingleSeason && usable.Count <= 1) { return new List<PosterEntry>(); }
            return ApplyEntryOrder(usable.Select(PrimaryEntry).Where(e => e is not null).Select(e => e!).ToList(), view.ChildOrder, view.ChildRandomStart);
        }
        return new List<PosterEntry>();
    }

    /// <summary>
    /// The slideshow entries of an item for one view: the preferred source, the other one only when the preferred
    /// one has nothing (priority = fallback, as everywhere in the plugin). Files keep their FileName (served by
    /// GetPosterImage), children carry Jellyfin's own Url.
    /// </summary>
    private List<PosterEntry> ResolveEntries(Guid itemId, PluginConfiguration config, string resolvedType, bool isLibraryScope,
        string folderPath, string namingMode, string folderName, ExtraViewSettings view)
    {
        List<PosterEntry> files = new();
        var item0 = _libraryManager.GetItemById(itemId);
        var hasChildren = item0 is BoxSet || item0 is Series;
        if (view.SourceFiles || !hasChildren)
        {
            var candidates = ResolveCandidates(folderPath, namingMode, folderName, ExtraTypeName(config, resolvedType, item0 is Series), view.OrderMode, config.AllowedFormats, resolvedType, view.UnnumberedMode);
            files = BuildPosterEntries(folderPath, candidates);
            // Random start position: Sequential + Loop only (the admin page greys the box otherwise).
            if (view.FilesRandomStart && view.OrderMode == "Sequential" && !view.SinglePass) { files = Helpers.RandomStart.Rotate(files); }
        }
        List<PosterEntry> children = new();
        if (view.SourceChildren && hasChildren)
        {
            children = ResolveChildPosters(config, item0!, view);
        }
        if (view.ChildrenFirst) { return children.Count > 0 ? children : files; }
        return files.Count > 0 ? files : children;
    }

    private static string NormalizeType(string? type)
    {
        if (string.Equals(type, "extraposter", StringComparison.OrdinalIgnoreCase)) { return "extraposter"; }
        if (string.Equals(type, "extrakeyart", StringComparison.OrdinalIgnoreCase)) { return "extrakeyart"; }
        return "auto";
    }

    /// <summary>
    /// "auto" resolves Extraposter vs Extrakeyart by ExtraposterPriority: the preferred type first, but only if it
    /// actually has at least one entry (an enabled type with an empty folder falls through to the other one); null
    /// when neither has anything. An explicit type is honoured only while it is still applicable and has entries;
    /// the client sends one in its follow-up requests once GetQuickCheck's "auto" call has named the winner.
    /// </summary>
    private string? ResolvePosterType(Guid itemId, PluginConfiguration config, string requestedType, bool isLibraryScope = false)
    {
        // An explicit type goes through ResolveApplicability too, so a stale type parameter from the client cannot
        // bypass the Enable / Show-on / Detail-Library checks.
        if (requestedType != "auto")
        {
            var (explicitApplicable, explicitFolderPath, explicitNamingMode, explicitFolderName) = ResolveApplicability(itemId, config, requestedType, isLibraryScope);
            if (!explicitApplicable || explicitFolderPath is null) { return null; }

            var explicitView = GetViewSettings(config, itemId, requestedType, isLibraryScope);
            var explicitEntries = ResolveEntries(itemId, config, requestedType, isLibraryScope, explicitFolderPath, explicitNamingMode, explicitFolderName, explicitView);
            return explicitEntries.Count > 0 ? requestedType : null;
        }

        var order = string.Equals(config.ExtraposterPriority, "Extrakeyart", StringComparison.OrdinalIgnoreCase)
            ? new[] { "extrakeyart", "extraposter" }
            : new[] { "extraposter", "extrakeyart" };

        foreach (var candidateType in order)
        {
            var (applicable, folderPath, namingMode, folderName) = ResolveApplicability(itemId, config, candidateType, isLibraryScope);
            if (!applicable || folderPath is null) { continue; }

            var candidateView = GetViewSettings(config, itemId, candidateType, isLibraryScope);
            if (ResolveEntries(itemId, config, candidateType, isLibraryScope, folderPath, namingMode, folderName, candidateView).Count > 0) { return candidateType; }
        }

        return null;
    }

    /// <summary>
    /// GET /Extraposter/{itemId}/quickcheck: the poster arbiter's (Core.js) applicability check - will Extraposter
    /// show something for this item, and after which delay? Only the entry count matters here. One poster is
    /// enough to replace Main, matching the `&lt; 1` checks in GetPosterList, GetPosterListBatch and the
    /// client's ExtraModule.
    ///
    /// "type": "auto" (default, the client's first request) resolves Extraposter vs Extrakeyart by
    /// ExtraposterPriority, see ResolvePosterType.
    /// </summary>
    [HttpGet("{itemId}/quickcheck")]
    public ActionResult<QuickCheckResult> GetQuickCheck([FromRoute] Guid itemId, [FromQuery] string? type, [FromQuery] bool? webgl)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            var requestedType = NormalizeType(type);

            // Case mix poster chain: on a detail page whose draw has this slot unticked, the slot does not deliver
            // and the page's chain falls through to the next one. Only the detail page calls quickcheck; library
            // tiles use the batch.
            if (config.CaseModMixEnabled
                && !CaseMix.SlotAllowed(CaseMixConfig.DrawFor(config, _libraryManager.GetItemById(itemId), webgl ?? true), "extraposter", CaseMixConfig.From(config)))
            {
                return Ok(new QuickCheckResult { IsApplicable = false });
            }

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

            var view = GetViewSettings(config, itemId, resolvedType, isLibraryScope: false);
            var orderMode = view.OrderMode;
            var allowedFormats = config.AllowedFormats; // shared by the whole tab
            var delayEnabled = view.DelayEnabled;
            var delayMs = view.DelayMs;

            var candidates = ResolveEntries(itemId, config, resolvedType, isLibraryScope: false, folderPath, namingMode, folderName, view);
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
    /// GET /Extraposter/{itemId}: the poster file names plus all playback settings. "type" as in GetQuickCheck:
    /// "auto" (default) resolves via ExtraposterPriority, an explicit "extraposter"/"extrakeyart" is used by the
    /// client once GetQuickCheck has named the winner.
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
            var view = GetViewSettings(config, itemId, resolvedType, isLibraryScope: false);
            var orderMode = view.OrderMode;
            var allowedFormats = config.AllowedFormats; // shared by the whole tab
            var cycleTimeMs = Helpers.Timing.FloorCycle(view.CycleTimeMs);
            var fadeTimeMs = view.FadeTimeMs;
            var delayEnabled = view.DelayEnabled;
            var delayMs = view.DelayMs;
            var singlePass = view.SinglePass;

            // ETag-based browser caching. The fingerprint includes resolvedType: an "auto" request can resolve to
            // the other type after a priority/config change, which must invalidate the browser's copy.
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

            var entries = ResolveEntries(itemId, config, resolvedType, isLibraryScope: false, folderPath, namingMode, folderName, view);
            var candidates = entries.Select(e => e.Url ?? e.FileName).ToList();

            // Defensive clamp in addition to the config page's own live clamping, e.g. for an invalid state
            // imported via backup/restore.
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

            // Same logo overlay logic as CustomPosterController, but with its own independent config
            // (Extrakeyart logo, not Keyart logo), so the two overlays never affect each other.
            var logoEnabled = isExtrakeyart && view.LogoEnabled;

            return Ok(new PosterListResult
            {
                IsMovie = true,
                OrderMode = orderMode,
                Posters = entries,
                CycleTimeMs = cycleTimeMs,
                FadeTimeMs = effectiveFadeMs,
                DelayEnabled = delayEnabled,
                DelayMs = delayMs,
                SinglePass = singlePass,
                ResolvedType = resolvedType,
                LogoEnabled = logoEnabled,
                LogoVerticalPositionPercent = logoEnabled ? view.LogoVerticalPositionPercent : 0,
                LogoSizePercent = logoEnabled ? view.LogoSizePercent : 0,
                SetLogoVerticalPositionPercent = view.SetKeyartLogoVerticalPositionPercent,
                SetLogoSizePercent = view.SetKeyartLogoSizePercent
            });
        }
        catch (Exception ex)
        {
            // ASP.NET's exception middleware would catch this too (no crash), but with the Extraposter prefix the
            // log line names its component, e.g. for a permission error on the directory.
            _logger.LogError(ex, "Extraposter: Unexpected error in GetPosterList for {ItemId}", itemId);
            return Ok(new PosterListResult { IsMovie = false });
        }
    }

    // Upper bound for the batch endpoint: it is [AllowAnonymous] and reachable with any hand-made URL, not only
    // through the client (which stays well below it via IntersectionObserver + debounce). Each lookup is cheap,
    // but an unbounded list is needless exposure for a request without auth.
    private const int MaxBatchIds = 200;

    /// <summary>The shared "not applicable" answer (never mutated, so it can be shared).</summary>
    private static readonly PosterListResult NotApplicableResult = new() { IsMovie = false };

    /// <summary>
    /// GET /Extraposter/batch?ids=guid1,guid2,guid3: batch endpoint for the library view. Comma-separated itemIds,
    /// the same `ids` name and format as Jellyfin's ItemsController; Jellyfin's CommaDelimitedArrayModelBinder
    /// lives in Jellyfin.Api, which plugins cannot reference, so the split is done here.
    ///
    /// Each itemId is answered with the Movies or the TV shows library settings, depending on its type; an
    /// invalid, missing or disabled item returns IsMovie=false for that entry only.
    /// </summary>
    [HttpGet("batch")]
    public ActionResult<BatchPosterListResult> GetPosterListBatch([FromQuery] string? ids, [FromQuery] string? page)
    {
        var result = new BatchPosterListResult();
        var config = Plugin.Instance!.Configuration;
        // The page class of this batch (see AlsoOnAllowed). The per-item cache stays keyed by item only; the
        // filter is applied on the way out, on the cached answer.
        var pageClass = string.IsNullOrEmpty(page) ? "library" : page;
        var filteredOut = 0;

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

        _logger.LogInformation("Extraposter: === GetPosterListBatch START, {Count} unique itemIds requested", itemIds.Count);
        _logger.LogDebug("Extraposter: GetPosterListBatch ids: [{Ids}]", string.Join(", ", itemIds));
        var batchWatch = System.Diagnostics.Stopwatch.StartNew();
        var cacheHits = 0;
        long slowestTicks = 0; var slowestId = Guid.Empty;

        // Resolved in parallel and cached per item for 30 s: a cold 200-item batch (folder stats on slow drives)
        // can outlast the client's 2 s safety net, which releases the tiles with Jellyfin's poster and lets the
        // overlay flash in afterwards. The cache key carries the config object's identity: Jellyfin replaces it
        // on every save, so a saved change is seen at once; new files are seen after 30 s.
        var configStamp = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(config);
        // A set's answer depends on the user (its members are filtered per user), so only a set's key carries
        // the user; movies and series stay shared between users.
        var setUserKey = "|" + (GetRequestUser()?.Id.ToString("N") ?? "anonymous");
        var resolved = new System.Collections.Concurrent.ConcurrentDictionary<string, PosterListResult>();
        System.Threading.Tasks.Parallel.ForEach(itemIds, new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 8 }, itemId =>
        {
            var key = "Extraposter:LibResult|" + itemId.ToString("N") + "|" + configStamp
                + (_libraryManager.GetItemById(itemId) is BoxSet ? setUserKey : string.Empty);
            if (!_cache.TryGetValue(key, out PosterListResult? cachedResult) || cachedResult is null)
            {
                var itemWatch = System.Diagnostics.Stopwatch.StartNew();
                cachedResult = ResolveLibraryItemResult(itemId, config);
                _cache.Set(key, cachedResult, new MemoryCacheEntryOptions().SetAbsoluteExpiration(LibraryResultCacheWindow));
                lock (resolved)
                {
                    if (itemWatch.ElapsedTicks > slowestTicks) { slowestTicks = itemWatch.ElapsedTicks; slowestId = itemId; }
                }
            }
            else
            {
                System.Threading.Interlocked.Increment(ref cacheHits);
            }
            // "N" (no dashes): the client looks the answer up by the tile's data-id, which Jellyfin serialises
            // via JsonGuidConverter as 32 hex digits. Dictionary keys are plain strings and bypass that converter.
            if (cachedResult.IsMovie && !AlsoOnAllowed(config, pageClass, cachedResult))
            {
                System.Threading.Interlocked.Increment(ref filteredOut);
                cachedResult = NotApplicableResult;
            }
            resolved[itemId.ToString("N")] = cachedResult;
        });
        foreach (var kv in resolved) { result.Items[kv.Key] = kv.Value; }

        _logger.LogInformation(
            "Extraposter: === GetPosterListBatch END, page {Page}, {Count} entries answered, {WithPosters} of them with IsMovie=true, {Filtered} filtered by Also on, {Ms} ms, {Hits} from cache, slowest item {SlowestMs} ms ({SlowestId})",
            pageClass, result.Items.Count, result.Items.Values.Count(r => r.IsMovie), filteredOut, batchWatch.ElapsedMilliseconds, cacheHits,
            slowestTicks * 1000 / System.Diagnostics.Stopwatch.Frequency, slowestId);

        return Ok(result);
    }

    /// <summary>
    /// Resolves a single itemId for the batch endpoint with the library settings of its kind (Movies and TV shows
    /// are configured separately). Anything but a Movie, Series or BoxSet (or not found) returns IsMovie=false.
    /// </summary>
    private PosterListResult ResolveLibraryItemResult(Guid itemId, PluginConfiguration config)
    {
        var item = _libraryManager.GetItemById(itemId);
        _logger.LogDebug(
            "Extraposter: ResolveLibraryItemResult - {ItemId} resolved as type \"{Type}\"",
            itemId, item?.GetType().FullName ?? "null (not found)");

        // Goes through ResolvePosterType / ResolveApplicability (isLibraryScope: true), the same logic as the
        // detail endpoint, so the tab and type switches and Extrakeyart apply in the library view too.
        if (item is not Movie && item is not Series && item is not BoxSet)
        {
            _logger.LogDebug("Extraposter: ResolveLibraryItemResult - {ItemId} is neither a Movie, a Series nor a BoxSet, skipping", itemId);
            return new PosterListResult { IsMovie = false };
        }

        var resolvedType = ResolvePosterType(itemId, config, "auto", isLibraryScope: true);
        if (resolvedType is null)
        {
            _logger.LogDebug("Extraposter: ResolveLibraryItemResult - {ItemId} not applicable (Enable/Show-on/LibraryEnabled off, or no matching file)", itemId);
            return new PosterListResult { IsMovie = false };
        }

        var (applicable, folderPath, namingMode, folderName) = ResolveApplicability(itemId, config, resolvedType, isLibraryScope: true);
        if (!applicable || folderPath is null)
        {
            return new PosterListResult { IsMovie = false };
        }

        var isExtrakeyart = resolvedType == "extrakeyart";
        var allowedFormats = config.AllowedFormats;
        var view = GetViewSettings(config, itemId, resolvedType, isLibraryScope: true);
        var entries = ResolveEntries(itemId, config, resolvedType, isLibraryScope: true, folderPath, namingMode, folderName, view);
        var cycleFloored = Helpers.Timing.FloorCycle(view.CycleTimeMs);
        var effectiveFade = Math.Min(view.FadeTimeMs, cycleFloored);
        var logoEnabled = isExtrakeyart && view.LogoEnabled;

        return new PosterListResult
        {
            IsMovie = true, // here: a valid, enabled item, not only a movie
            OrderMode = view.OrderMode,
            Posters = entries,
            CycleTimeMs = cycleFloored,
            FadeTimeMs = effectiveFade,
            DelayEnabled = view.DelayEnabled,
            DelayMs = view.DelayMs,
            SinglePass = view.SinglePass,
            ResolvedType = resolvedType,
            LogoEnabled = logoEnabled,
            LogoVerticalPositionPercent = logoEnabled ? view.LogoVerticalPositionPercent : 0,
            LogoSizePercent = logoEnabled ? view.LogoSizePercent : 0,
            SyncEnabled = view.SyncEnabled,
            SeamlessEnabled = view.SeamlessEnabled,
            SetLogoVerticalPositionPercent = view.SetKeyartLogoVerticalPositionPercent,
            SetLogoSizePercent = view.SetKeyartLogoSizePercent,
            HasLogo = logoEnabled && (item?.HasImage(MediaBrowser.Model.Entities.ImageType.Logo, 0) ?? false),
            ItemKind = item is Series ? "Series" : item is BoxSet ? "BoxSet" : "Movie"
        };
    }

    /// <summary>
    /// The "Also on" rows. The client scanner is document-wide, so library-scope tiles could appear on every page
    /// that builds Movie/Series/BoxSet cards; the client names the page class of each batch, and the matching
    /// checkbox of the resolved feature (Extraposter / Extrakeyart) and kind (Movies, Sets follow Movies / TV
    /// shows) decides. No parameter = "library" = allowed; "dashboard" is never allowed; an unknown class is not
    /// allowed (the defaults are all off, so a page the plugin does not know stays vanilla).
    /// </summary>
    internal static bool AlsoOnAllowed(PluginConfiguration config, string? page, PosterListResult result)
    {
        // The library grid switch (page empty / "library") or the "show also on" box of the item kind
        // (Helpers/AlsoOn); the cached answer carries no view Enable, so this is the one gate.
        if (!result.IsMovie) { return true; }
        return Helpers.AlsoOn.Allowed(config, page, result.ResolvedType == "extrakeyart" ? "Extrakeyart" : "Extraposter", result.ItemKind);
    }

    /// <summary>
    /// GET /Extraposter/child-image?itemId=&amp;type=postercase|keyart|animatedposter|animatedkeyart: a Set movie's
    /// Custom Poster file for the Set slideshow. Found by the Custom Poster tab's naming rules only; that feature's
    /// own switches do not apply here, the file alone counts.
    /// </summary>
    [HttpGet("child-image")]
    public ActionResult GetChildImage([FromQuery] Guid itemId, [FromQuery] string? type)
    {
        // The stream is opened here (a PhysicalFile result opens outside the try), so a locked or vanished file
        // answers 404 + a warning.
        try
        {
            var config = Plugin.Instance!.Configuration;
            var kind = type switch { "keyart" => "keyart", "animatedposter" => "animatedposter", "animatedkeyart" => "animatedkeyart", _ => "postercase" };
            if (_libraryManager.GetItemById(itemId) is not Movie movie) { return NotFound(); }
            var animated = kind.StartsWith("animated", StringComparison.Ordinal);
            var path = animated ? Helpers.AnimatedPosterFileResolver.Resolve(config, movie, kind) : Helpers.CustomPosterFileResolver.Resolve(config, movie, kind);
            if (path is null || !System.IO.File.Exists(path)) { return NotFound(); }
            var etag = ComputeETag("child", itemId, kind, Helpers.BackdropFileResolver.VersionTag(path));
            if (IsETagStillValid(etag)) { return StatusCode(StatusCodes.Status304NotModified); }
            Response.Headers.CacheControl = "private, max-age=86400";
            var stream = System.IO.File.OpenRead(path);
            return File(stream, animated ? Helpers.AnimatedPosterFileResolver.ContentType(path) : Helpers.CustomPosterFileResolver.ContentType(path));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Extraposter: GetChildImage 404 - the {Kind} file of {ItemId} could not be served", type, itemId);
            return NotFound();
        }
    }

    /// <summary>
    /// GET /Extraposter/{itemId}/image/{fileName}: serves a single image file. The file name is never joined with
    /// the folder path directly but checked against the freshly resolved candidate list, which rules out path
    /// traversal without keeping state between the two endpoints. Tries Movie, then Set, then Series.
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
                // Should not happen: the client knows the resolved type (from GetPosterList / GetQuickCheck)
                // before it requests an image. Falls back to "extraposter" instead of failing.
                resolvedType = "extraposter";
            }

            _logger.LogDebug(
                "Extraposter: GetPosterImage START for {ItemId}, type={Type}, requested file=\"{FileName}\"",
                itemId, resolvedType, fileName);

            // Deliberately not ResolveApplicability: that checks *DetailEnabled only, but this image endpoint
            // serves both the detail page and the library view (no scope parameter), so it needs "Detail OR
            // Library" - otherwise a library-only setup would lose all its images.
            string? folderPath = null;
            string namingMode = string.Empty;
            string folderName = string.Empty;
            var tv = false;
            var isExtrakeyart = resolvedType == "extrakeyart";

            var typeEnabled = config.ExtraposterTabEnabled
                && (isExtrakeyart ? config.ExtrakeyartEnabled : config.ExtraposterEnabled);
            if (typeEnabled)
            {
                var (isMovie, movieFolderPath) = ResolveMovieFolder(itemId);
                // Show-on lives per view; the image URL carries no scope, so the file is served when any view of
                // the type wants it.
                var moviesDetailEnabled = isExtrakeyart ? (config.ExtrakeyartMoviesDetailEnabled && config.ExtrakeyartMoviesDetailShowOnMovies) : (config.ExtraposterMoviesDetailEnabled && config.ExtraposterMoviesDetailShowOnMovies);
                var moviesLibraryEnabled = isExtrakeyart ? (config.ExtrakeyartMoviesLibraryEnabled && config.ExtrakeyartMoviesLibraryShowOnMovies) : (config.ExtraposterMoviesLibraryEnabled && config.ExtraposterMoviesLibraryShowOnMovies);
                if (isMovie && movieFolderPath is not null && (moviesDetailEnabled || moviesLibraryEnabled))
                {
                    folderPath = movieFolderPath;
                    namingMode = isExtrakeyart ? config.ExtrakeyartMoviesNamingMode : config.ExtraposterMoviesNamingMode;
                    folderName = isExtrakeyart ? config.ExtrakeyartMoviesFolderName : config.ExtraposterMoviesFolderName;
                }
                else
                {
                    // Sets reuse the Movies Detail/Library flags and type name; naming is always "Standalone"
                    // (see ResolveApplicability).
                    var (isSet, setFolderPath) = ResolveSetFolder(itemId);
                    var setsDetailEnabled = isExtrakeyart ? (config.ExtrakeyartMoviesDetailEnabled && config.ExtrakeyartMoviesDetailShowOnSets) : (config.ExtraposterMoviesDetailEnabled && config.ExtraposterMoviesDetailShowOnSets);
                    var setsLibraryEnabled = isExtrakeyart ? (config.ExtrakeyartMoviesLibraryEnabled && config.ExtrakeyartMoviesLibraryShowOnSets) : (config.ExtraposterMoviesLibraryEnabled && config.ExtraposterMoviesLibraryShowOnSets);
                    if (isSet && setFolderPath is not null && (setsDetailEnabled || setsLibraryEnabled))
                    {
                        folderPath = setFolderPath;
                        namingMode = "Standalone";
                        folderName = string.Empty;
                    }
                    else
                    {
                        var (isSeries, seriesFolderPath) = ResolveSeriesFolder(itemId);
                        var tvShowsDetailEnabled = isExtrakeyart ? (config.ExtrakeyartTvShowsDetailEnabled && config.ExtrakeyartTvShowsDetailShowOnTvShows) : (config.ExtraposterTvShowsDetailEnabled && config.ExtraposterTvShowsDetailShowOnTvShows);
                        var tvShowsLibraryEnabled = isExtrakeyart ? (config.ExtrakeyartTvShowsLibraryEnabled && config.ExtrakeyartTvShowsLibraryShowOnTvShows) : (config.ExtraposterTvShowsLibraryEnabled && config.ExtraposterTvShowsLibraryShowOnTvShows);
                        if (isSeries && seriesFolderPath is not null && (tvShowsDetailEnabled || tvShowsLibraryEnabled))
                        {
                            folderPath = seriesFolderPath;
                            namingMode = TvNaming(isExtrakeyart ? config.ExtrakeyartTvShowsNamingMode : config.ExtraposterTvShowsNamingMode);
                            folderName = isExtrakeyart ? config.ExtrakeyartTvShowsFolderName : config.ExtraposterTvShowsFolderName;
                            tv = true;
                        }
                    }
                }
            }

            List<string>? candidates = null;
            if (folderPath is not null)
            {
                // This endpoint checks membership only, and the order never changes which files are candidates
                // (the order is per view, the image URL carries no scope).
                var allowedFormats = config.AllowedFormats; // shared by the whole tab
                // Unnumbered mode is per view: serve the unnumbered file when any view counts it.
                var unnumbered = (isExtrakeyart
                    ? (config.ExtrakeyartMoviesDetailUnnumberedMode == "Counts" || config.ExtrakeyartMoviesLibraryUnnumberedMode == "Counts"
                        || config.ExtrakeyartTvShowsDetailUnnumberedMode == "Counts" || config.ExtrakeyartTvShowsLibraryUnnumberedMode == "Counts")
                    : (config.ExtraposterMoviesDetailUnnumberedMode == "Counts" || config.ExtraposterMoviesLibraryUnnumberedMode == "Counts"
                        || config.ExtraposterTvShowsDetailUnnumberedMode == "Counts" || config.ExtraposterTvShowsLibraryUnnumberedMode == "Counts")) ? "Counts" : "Ignored";
                candidates = ResolveCandidates(folderPath, namingMode, folderName, ExtraTypeName(config, resolvedType, tv), "Sequential", allowedFormats, resolvedType, unnumbered);
            }

            if (folderPath is null || candidates is null)
            {
                _logger.LogWarning(
                    "Extraposter: GetPosterImage 404 - item {ItemId} couldn't be resolved as either an enabled Movie or an enabled Series (type={Type})",
                    itemId, resolvedType);
                return NotFound();
            }

            // Serve only what the scan just found: fileName comes from the client and is not trusted.
            if (!candidates.Contains(fileName, StringComparer.Ordinal))
            {
                _logger.LogWarning(
                    "Extraposter: GetPosterImage 404 - \"{FileName}\" not in the resolved candidate list for {ItemId}. Current candidate list: [{Candidates}]",
                    fileName, itemId, string.Join(", ", candidates));
                return NotFound();
            }

            var fullPath = Path.Combine(folderPath, fileName);
            var exists = System.IO.File.Exists(fullPath);
            _logger.LogDebug(
                "Extraposter: GetPosterImage - full path=\"{FullPath}\", File.Exists={Exists}",
                fullPath, exists);

            if (!exists)
            {
                // The candidate came from the same File.Exists check, so only a race (file deleted or renamed
                // between the two requests) gets here.
                _logger.LogWarning(
                    "Extraposter: GetPosterImage 404 - the file was in the candidate list, but no longer exists: \"{FullPath}\"",
                    fullPath);
                return NotFound();
            }

            var contentType = GetContentType(fullPath);
            var fileInfo = new FileInfo(fullPath);

            // Image caching like Jellyfin's own served images, so an unchanged poster shown again during a
            // rotation does not touch the disk. Fingerprint = LastWriteTimeUtc + size (cheap, and it changes when
            // the file is replaced under the same name). "public" with max-age, unlike the list endpoints'
            // "no-cache": this is static content, the browser may serve it without asking first.
            var imageEtag = "\"" + fileInfo.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-" + fileInfo.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";
            Response.Headers.ETag = imageEtag;
            Response.Headers.CacheControl = "public, max-age=86400";
            var ifNoneMatchImage = Request.Headers.IfNoneMatch.ToString();
            if (!string.IsNullOrEmpty(ifNoneMatchImage) && ifNoneMatchImage == imageEtag)
            {
                _logger.LogDebug("Extraposter: GetPosterImage - ETag unchanged, 304 for \"{FullPath}\"", fullPath);
                return StatusCode(StatusCodes.Status304NotModified);
            }

            _logger.LogDebug(
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

    /// <summary>
    /// A short, stable ETag fingerprint from any number of values, joined with "|" and hashed. SHA256 is
    /// convenience here, not a security requirement. Returned in quotes, as the ETag header requires.
    /// </summary>
    private static string ComputeETag(params object?[] parts)
    {
        var raw = string.Join('|', parts.Select(p => p?.ToString() ?? string.Empty));
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw));
        return "\"" + Convert.ToHexString(hash)[..16] + "\"";
    }

    /// <summary>
    /// Sets the ETag and Cache-Control headers and checks whether the browser's If-None-Match already matches, in
    /// which case the caller answers 304 Not Modified instead of the full JSON. `no-cache` (not `no-store`) lets
    /// the browser keep its previous response but always revalidate first.
    /// </summary>
    private bool IsETagStillValid(string etag)
    {
        Response.Headers.ETag = etag;
        Response.Headers.CacheControl = "no-cache";
        var ifNoneMatch = Request.Headers.IfNoneMatch.ToString();
        return !string.IsNullOrEmpty(ifNoneMatch) && ifNoneMatch == etag;
    }

    /// <summary>
    /// Like <see cref="Directory.GetLastWriteTimeUtc"/>, but a failed lookup (permissions etc.) returns a
    /// placeholder timestamp that never matches anything instead of failing the request.
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

        _logger.LogDebug(
            "Extraposter: ResolveMovieFolder - item {ItemId} resolved as type \"{Type}\"",
            itemId,
            item?.GetType().FullName ?? "null (not found)");

        if (item is not Movie movie)
        {
            _logger.LogDebug(
                "Extraposter: ResolveMovieFolder - not a Movie, aborting for {ItemId}",
                itemId);
            return (false, null);
        }

        var folderPath = movie.ContainingFolderPath;
        var exists = !string.IsNullOrEmpty(folderPath) && Directory.Exists(folderPath);

        _logger.LogDebug(
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
    /// Like <see cref="ResolveMovieFolder"/>, for a Series: like a movie it has its own exclusive main folder.
    /// Called with the series' own itemId (a library tile's itemId is always the series itself).
    /// </summary>
    private (bool IsSeries, string? FolderPath) ResolveSeriesFolder(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);

        _logger.LogDebug(
            "Extraposter: ResolveSeriesFolder - item {ItemId} resolved as type \"{Type}\"",
            itemId,
            item?.GetType().FullName ?? "null (not found)");

        if (item is not Series series)
        {
            _logger.LogDebug(
                "Extraposter: ResolveSeriesFolder - not a Series, aborting for {ItemId}",
                itemId);
            return (false, null);
        }

        var folderPath = series.ContainingFolderPath;
        var exists = !string.IsNullOrEmpty(folderPath) && Directory.Exists(folderPath);

        _logger.LogDebug(
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
    /// Like <see cref="ResolveMovieFolder"/>/<see cref="ResolveSeriesFolder"/>, for a BoxSet (Set / collection),
    /// which also has its own exclusive main folder, so ContainingFolderPath works the same way.
    /// </summary>
    private (bool IsSet, string? FolderPath) ResolveSetFolder(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);

        _logger.LogDebug(
            "Extraposter: ResolveSetFolder - item {ItemId} resolved as type \"{Type}\"",
            itemId,
            item?.GetType().FullName ?? "null (not found)");

        if (item is not BoxSet boxSet)
        {
            _logger.LogDebug(
                "Extraposter: ResolveSetFolder - not a BoxSet, aborting for {ItemId}",
                itemId);
            return (false, null);
        }

        var folderPath = boxSet.ContainingFolderPath;
        var exists = !string.IsNullOrEmpty(folderPath) && Directory.Exists(folderPath);

        _logger.LogDebug(
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
    /// Turns a comma-separated format list ("jpg,png,webp") into extensions with a dot (".jpg", ".png", ".webp").
    /// Falls back to ".jpg" when the list is empty or invalid (e.g. before the config page was first saved), so
    /// ResolveCandidates never searches with an empty list.
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
    /// Pairs each candidate file name with its version fingerprint (LastWriteTimeUtc.Ticks-Length, the same formula
    /// as the image endpoint's ETag), so the client can build a self-versioning image URL (?v=...) per poster. A
    /// file deleted between the folder scan and this call gets an empty version instead of aborting the list; the
    /// image endpoint answers 404 for it anyway.
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

    /// <summary>
    /// Finds the poster candidates in a folder, with a server cache in front. The cache key holds every value that
    /// affects the result: the folder's LastWriteTimeUtc (new/changed files) and the naming pattern, folder,
    /// type name and formats (settings changes). Any change creates a new key; the old entry is no longer asked for
    /// and expires after <see cref="CacheSlidingExpiration"/>. LastWriteTimeUtc rather than FileSystemWatcher,
    /// which Microsoft documents as unreliable on network drives.
    /// </summary>
    private List<string> ResolveCandidates(string folderPath, string namingMode, string folderName, string typeName, string orderMode, string? allowedFormatsCsv, string posterType = "extraposter", string unnumberedMode = "Ignored")
    {
        DateTime lastWriteUtc;
        try
        {
            lastWriteUtc = Directory.GetLastWriteTimeUtc(folderPath);
        }
        catch (Exception ex)
        {
            // E.g. a permission problem: scan uncached rather than keep a (possibly empty) cache entry under a
            // timestamp that never changes.
            _logger.LogWarning(ex, "Extraposter: ResolveCandidates - GetLastWriteTimeUtc failed for \"{Folder}\", skipping the cache for this request", folderPath);
            var uncachedResult = ResolveCandidatesUncached(folderPath, namingMode, folderName, typeName, "Sequential", allowedFormatsCsv, unnumberedMode, posterType);
            return orderMode == "Sequential" ? uncachedResult : ApplyOrder(uncachedResult, orderMode);
        }

            // orderMode is not part of the key: the cached list is always the raw, naturally sorted scan, the same
            // for every order. posterType is: both types could be given the same folder name, and their entries
            // would otherwise collide.
        var cacheKey = string.Join(
            '|',
            "Extraposter:Candidates",
            posterType,
            folderPath,
            lastWriteUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture),
            namingMode,
            folderName,
            typeName,
            allowedFormatsCsv ?? string.Empty,
            unnumberedMode);

        List<string> naturallyOrdered;
        if (_cache.TryGetValue(cacheKey, out List<string>? cached) && cached is not null)
        {
            _logger.LogDebug(
                "Extraposter: ResolveCandidates - cache hit, no disk access needed. Key: \"{Key}\"",
                cacheKey);
            naturallyOrdered = cached;
        }
        else
        {
            _logger.LogDebug(
                "Extraposter: ResolveCandidates - cache miss, scanning the disk. Key: \"{Key}\"",
                cacheKey);

            // Cache the natural order only, never a shuffled result: a cached shuffle would replay the same
            // "random" order for as long as the entry lives. Only the expensive part, the file system scan, is cached.
            naturallyOrdered = ResolveCandidatesUncached(folderPath, namingMode, folderName, typeName, "Sequential", allowedFormatsCsv, unnumberedMode, posterType);
            _cache.Set(cacheKey, naturallyOrdered, new MemoryCacheEntryOptions().SetSlidingExpiration(CacheSlidingExpiration));
        }

        // The order is applied fresh on every call: a plain in-memory shuffle of a known list, no file system
        // access. Never mutates naturallyOrdered (OrderBy returns a new list).
        return orderMode == "Sequential" ? naturallyOrdered : ApplyOrder(naturallyOrdered, orderMode);
    }

    /// <summary>
    /// "Shuffle": a permutation of the whole list, so every image appears exactly once per round.
    /// "Random": an independent draw with replacement for every position of a list of the same length, so a file
    /// can appear several times or not at all.
    /// Never called for "Sequential"; callers skip that case to avoid the allocation.
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

    /// <summary>The uncached scan behind <see cref="ResolveCandidates"/>.</summary>
    private List<string> ResolveCandidatesUncached(string folderPath, string namingMode, string folderName, string typeName, string orderMode, string? allowedFormatsCsv, string unnumberedMode = "Ignored", string posterType = "extraposter")
    {
        var allowedExtensions = GetAllowedExtensions(allowedFormatsCsv);
        List<string> fileNames;

        // Log the folder's actual contents first, whatever the naming pattern: comparing them with the expected
        // names is the fastest way to spot a typo or a differing character.
        try
        {
            var allFilesInFolder = Directory.EnumerateFiles(folderPath)
                .Select(Path.GetFileName)
                .ToList();
            _logger.LogDebug(
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
            _logger.LogDebug(
                "Extraposter: ResolveCandidates - Folder mode, expected subfolder=\"{SubFolder}\", Directory.Exists={Exists}",
                subFolder, subFolderExists);

            if (!subFolderExists)
            {
                return new List<string>();
            }

            var filesInSubFolder = Directory.EnumerateFiles(subFolder).Select(Path.GetFileName).ToList();
            _logger.LogDebug(
                "Extraposter: ResolveCandidates - contents of \"{SubFolder}\" ({Count} files): [{Files}]",
                subFolder, filesInSubFolder.Count, string.Join(", ", filesInSubFolder));

            // Folder variant: everything in it counts, no naming convention. The paths are relative to the item
            // folder, so GetPosterImage uses the same Path.Combine(folderPath, fileName) for all three variants.
            fileNames = filesInSubFolder
                .Where(f => f is not null && allowedExtensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase))
                .Select(f => Path.Combine(folderName, f!))
                .ToList();

            var skipped = filesInSubFolder.Count - fileNames.Count;
            if (skipped > 0)
            {
                _logger.LogDebug(
                    "Extraposter: ResolveCandidates - {Skipped} file(s) in the subfolder skipped due to an unsupported extension (allowed: {Allowed})",
                    skipped, string.Join(", ", allowedExtensions));
            }
        }
        else
        {
            // The word the numbered files start with is the type's own Type name setting.
            var prefixWord = typeName;
            var prefix = namingMode == "Prefixed"
                ? Path.GetFileName(folderPath) + "-" + prefixWord
                : prefixWord;

            // The first complete path checked, for a character-by-character comparison (a different hyphen, a
            // missing space, ...).
            var exampleCandidate = Path.Combine(folderPath, prefix + "1" + allowedExtensions[0]);
            _logger.LogDebug(
                "Extraposter: ResolveCandidates - NamingMode={NamingMode}, searched prefix=\"{Prefix}\", example full path #1=\"{Example}\"",
                namingMode, prefix, exampleCandidate);

            fileNames = new List<string>();

            // Unnumbered file (e.g. "keyart.jpg", no number): "Counts" adds it as the first image ahead of the
            // numbered ones, "Ignored" skips the check. Extraposter defaults to Ignored, because poster.jpg is
            // Jellyfin's own poster.
            if (unnumberedMode == "Counts")
            {
                foreach (var ext in allowedExtensions)
                {
                    var unnumberedCandidate = prefix + ext;
                    if (System.IO.File.Exists(Path.Combine(folderPath, unnumberedCandidate)))
                    {
                        fileNames.Add(unnumberedCandidate);
                        _logger.LogDebug(
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

                // When the first 3 numbers found nothing, stop instead of counting up to MaxNumberedPosters,
                // which saves File.Exists calls for empty sets.
                if (!found && i >= 3 && fileNames.Count == 0)
                {
                    _logger.LogDebug(
                        "Extraposter: ResolveCandidates - the first 3 numbers (1-3) had no match, aborting the search early instead of continuing to {Max}",
                        MaxNumberedPosters);
                    break;
                }
            }

            _logger.LogDebug(
                "Extraposter: ResolveCandidates - search performed up to number {Last}, {Count} matches: [{Files}]",
                lastCheckedNumber, fileNames.Count, string.Join(", ", fileNames));
        }

        List<string> result;
        if (orderMode == "Shuffle")
        {
            // A permutation of the whole list: every image exactly once per round.
            result = fileNames.OrderBy(_ => Guid.NewGuid()).ToList();
        }
        else if (orderMode == "Random")
        {
            // Independent draws with replacement, as many as candidates: a file can appear several times or
            // not at all.
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

        _logger.LogDebug(
            "Extraposter: ResolveCandidates - final order ({OrderMode}): [{Files}]",
            orderMode, string.Join(", ", result));

        return result;
    }

    /// <summary>
    /// Alphanumeric natural sort, so "poster2" comes before "poster11". The stem (file name without extension;
    /// Folder mode allows any name) is split into text and digit chunks, compared chunk by chunk: text
    /// case-insensitively, digits numerically by length first and then lexicographically, so numbers of any length
    /// never overflow. A name that is a prefix of another sorts first ("banana" before "banana1"). Used for the
    /// "Sequential" order.
    /// </summary>
    private static List<string> NaturalSort(List<string> fileNames)
    {
        var result = new List<string>(fileNames);
        result.Sort(NaturalFileNameComparer.Instance);
        return result;
    }

    /// <summary>
    /// The comparer behind <see cref="NaturalSort"/>; a real IComparer because two names need a chunk-by-chunk
    /// walk, not a single sort key per file.
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

            // All shared chunks equal: the one with fewer chunks sorts first ("banana" before "banana1").
            if (chunksA.Count != chunksB.Count)
            {
                return chunksA.Count - chunksB.Count;
            }

            // Identical stems (differing only by extension or case): the full name as a deterministic tie-breaker.
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
        // .tbn is not an image type of its own but a Kodi convention for JPEG data.
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
