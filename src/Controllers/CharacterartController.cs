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
/// A single characterart candidate paired with its version fingerprint;
/// see ExtraposterController.PosterEntry (same structure, kept as a separate
/// type like the other per-controller DTOs).
/// </summary>
public class ImageEntry
{
    public string FileName { get; set; } = string.Empty;

    public string Version { get; set; } = string.Empty;
}

/// <summary>
/// Result DTO for Characterart. The existence field is "IsApplicable"
/// because Characterart also applies to series, seasons and episodes. Even
/// with a single static image (MultiImage=false) a list with exactly one
/// entry is returned, so the client handles only one response shape.
/// </summary>
public class CharacterartResult
{
    public bool IsApplicable { get; set; }

    public IReadOnlyList<ImageEntry> Images { get; set; } = Array.Empty<ImageEntry>();

    public bool MultiImage { get; set; }

    public string Position { get; set; } = "BottomLeft";

    public string ScaleMode { get; set; } = "Height";

    public double HeightVh { get; set; } = 15;

    public double MaxWidthVw { get; set; }

    public double WidthVw { get; set; } = 11.5;

    public double MaxHeightVh { get; set; }

    public string HorizontalAlign { get; set; } = "Center";

    public double HorizontalOffsetVw { get; set; }

    // Same per-position/per-media-type granularity as HorizontalOffsetVw
    // above. Added to HorizontalOffsetVw ONLY while
    // document.fullscreenElement is truthy: windowed and fullscreen layouts
    // leave a small residual drift that differs per position, and this lets
    // the admin correct it directly.
    public double FullscreenHorizontalOffsetVw { get; set; }

    public int CycleTimeMs { get; set; } = 5000;

    public int FadeTimeMs { get; set; } = 500;

    public bool DelayEnabled { get; set; }

    public int DelayMs { get; set; }

    public bool SinglePass { get; set; }

    public bool StaySingleImageStatic { get; set; }

    /// <summary>See PluginConfiguration.CharacterartMoviesOrderMode - purely
    /// informational for the client (the ordering already happened on the
    /// server by the time Images is populated), matching
    /// ExtraposterController's OrderMode field.</summary>
    public string OrderMode { get; set; } = "Sequential";
}

/// <summary>
/// Characterart: character artwork on detail pages of movies, sets, series,
/// seasons, episodes and Playnite Bridge games. Its own controller and route,
/// separate from ExtraposterController like the two blocks of the config
/// page. All log lines are prefixed with "Characterart:".
/// </summary>
[ApiController]
[Route("Characterart")]
[AllowAnonymous]
public class CharacterartController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<CharacterartController> _logger;
    private readonly IMemoryCache _cache;

    private const int MaxNumberedImages = 50;
    private static readonly TimeSpan CacheSlidingExpiration = TimeSpan.FromHours(6);

    public CharacterartController(ILibraryManager libraryManager, ILogger<CharacterartController> logger, IMemoryCache cache)
    {
        _libraryManager = libraryManager;
        _logger = logger;
        _cache = cache;
    }

    /// <summary>
    /// GET /Characterart/{itemId} - returns the image list (in
    /// single-image mode: a list with exactly one entry) plus the
    /// position/timing settings for this item. Works the same for Movie,
    /// Series, Season, and Episode.
    /// </summary>
    [HttpGet("{itemId}")]
    public ActionResult<CharacterartResult> GetCharacterart([FromRoute] Guid itemId, [FromQuery] Guid? first)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;

            if (!config.CharacterartEnabled)
            {
                _logger.LogInformation("Characterart: GetCharacterart - CharacterartEnabled is off (General tab), {ItemId}", itemId);
                return Ok(new CharacterartResult { IsApplicable = false });
            }

            var resolved = ResolveItem(itemId, config, first);
            if (resolved is null)
            {
                return Ok(new CharacterartResult { IsApplicable = false });
            }

            var (folderPath, namingMode, typeName, folderName, multiImage, allowedFormatsCsv,
                cycleMs, fadeMs, delayEnabled, delayMs, singlePass, staySingleImageStatic, orderMode, kind, randomStart) = resolved.Value;

            var position = kind switch { "Movies" => config.CharacterartMoviesPosition, "Games" => config.CharacterartGamesPosition, _ => config.CharacterartTvShowsPosition };
            var lastWriteUtc = SafeGetLastWriteTimeUtc(folderPath);
            var sizing = ResolvePositionSizing(config, kind, position);
            var etag = ComputeETag(
                itemId, lastWriteUtc.Ticks, namingMode, typeName, folderName, multiImage,
                allowedFormatsCsv, position, sizing.ScaleMode, sizing.HeightVh, sizing.MaxWidthVw,
                sizing.WidthVw, sizing.MaxHeightVh, sizing.HorizontalAlign,
                sizing.OffsetVw, cycleMs, fadeMs, delayEnabled, delayMs, singlePass, staySingleImageStatic, orderMode);

            if (IsETagStillValid(etag))
            {
                _logger.LogInformation("Characterart: GetCharacterart - ETag unchanged, 304 for {ItemId}", itemId);
                return StatusCode(StatusCodes.Status304NotModified);
            }

            var images = ResolveCandidates(folderPath, namingMode, typeName, folderName, multiImage, orderMode, allowedFormatsCsv, UnnumberedFor(config, kind));
            // Random start position applies to Sequential + Loop only (the page greys the box otherwise).
            if (randomStart && orderMode == "Sequential" && !singlePass && multiImage) { images = Helpers.RandomStart.Rotate(images); }

            cycleMs = Helpers.Timing.FloorCycle(cycleMs); // lower bound for the cycle time
            var effectiveFadeMs = Math.Min(fadeMs, cycleMs);

            // If MultiImage is on but only one (or zero) image exists for this
            // item, the response reports single-image, so the API answer
            // matches what actually exists. The config value is not touched.
            var effectiveMultiImage = multiImage && images.Count > 1;

            _logger.LogInformation(
                "Characterart: GetCharacterart END for {ItemId} -> {Count} image(s) found (effective MultiImage={EffectiveMultiImage}): [{Files}]",
                itemId, images.Count, effectiveMultiImage, string.Join(", ", images));

            return Ok(new CharacterartResult
            {
                IsApplicable = images.Count > 0,
                Images = BuildImageEntries(folderPath, images),
                MultiImage = effectiveMultiImage,
                Position = position,
                ScaleMode = sizing.ScaleMode,
                HeightVh = sizing.HeightVh,
                MaxWidthVw = sizing.MaxWidthVw,
                WidthVw = sizing.WidthVw,
                MaxHeightVh = sizing.MaxHeightVh,
                HorizontalAlign = sizing.HorizontalAlign,
                HorizontalOffsetVw = sizing.OffsetVw,
                FullscreenHorizontalOffsetVw = sizing.FullscreenOffsetVw,
                CycleTimeMs = cycleMs,
                FadeTimeMs = effectiveFadeMs,
                DelayEnabled = delayEnabled,
                DelayMs = delayMs,
                SinglePass = singlePass,
                StaySingleImageStatic = staySingleImageStatic,
                OrderMode = orderMode
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Characterart: Unexpected error in GetCharacterart for {ItemId}", itemId);
            return Ok(new CharacterartResult { IsApplicable = false });
        }
    }

    /// <summary>
    /// GET /Characterart/{itemId}/image/{fileName} - serves a single image
    /// file, following the same path-traversal-safe pattern as
    /// ExtraposterController.GetPosterImage (freshly resolve the candidate
    /// list, check fileName against it instead of trusting it blindly).
    /// </summary>
    [HttpGet("{itemId}/image/{fileName}")]
    public ActionResult GetCharacterartImage([FromRoute] Guid itemId, [FromRoute] string fileName, [FromQuery] Guid? first)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            if (!config.CharacterartEnabled)
            {
                return NotFound();
            }

            var resolved = ResolveItem(itemId, config, first);
            if (resolved is null)
            {
                _logger.LogWarning("Characterart: GetCharacterartImage 404 - item {ItemId} couldn't be resolved/isn't enabled for this type", itemId);
                return NotFound();
            }

            var (folderPath, namingMode, typeName, folderName, multiImage, allowedFormatsCsv, _, _, _, _, _, _, orderMode, kind, _) = resolved.Value;
            var images = ResolveCandidates(folderPath, namingMode, typeName, folderName, multiImage, orderMode, allowedFormatsCsv, UnnumberedFor(config, kind));

            if (!images.Contains(fileName, StringComparer.Ordinal))
            {
                _logger.LogWarning(
                    "Characterart: GetCharacterartImage 404 - \"{FileName}\" not in the candidate list for {ItemId}. List: [{Images}]",
                    fileName, itemId, string.Join(", ", images));
                return NotFound();
            }

            var fullPath = Path.Combine(folderPath, fileName);
            if (!System.IO.File.Exists(fullPath))
            {
                _logger.LogWarning("Characterart: GetCharacterartImage 404 - file no longer exists: \"{Path}\"", fullPath);
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
                _logger.LogDebug("Characterart: GetCharacterartImage - ETag unchanged, 304 for \"{Path}\"", fullPath);
                return StatusCode(StatusCodes.Status304NotModified);
            }

            var stream = System.IO.File.OpenRead(fullPath);
            _logger.LogDebug("Characterart: GetCharacterartImage 200 - serving \"{Path}\", Content-Type={ContentType}", fullPath, contentType);
            return File(stream, contentType);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Characterart: Unexpected error in GetCharacterartImage for {ItemId}/{FileName}", itemId, fileName);
            return NotFound();
        }
    }

    // The client script is served by RenderArtController (GET /RenderArt/script.js).

    /// <summary>
    /// Resolves an itemId and, if applicable, returns all the values
    /// needed for further processing: the folder path AND the matching
    /// Movies, TvShows or Games settings (Kind), depending on the actual type. Returns
    /// null if the type isn't supported, the corresponding "where to show"
    /// checkbox is off, or the folder can't be resolved.
    ///
    /// TV resolution (Episode/Season/Series) always navigates to the
    /// series' main folder (Series inherits from Folder, so, like a movie,
    /// it has its own exclusive folder), regardless of which of the three
    /// levels you start from.
    /// </summary>
    private (string FolderPath, string NamingMode, string TypeName, string FolderName, bool MultiImage,
        string AllowedFormatsCsv, int CycleMs, int FadeMs, bool DelayEnabled, int DelayMs, bool SinglePass, bool StaySingleImageStatic, string OrderMode, string Kind, bool RandomStart)?
        ResolveItem(Guid itemId, PluginConfiguration config, Guid? first)
    {
        var item = _libraryManager.GetItemById(itemId);
        _logger.LogDebug(
            "Characterart: ResolveItem - {ItemId} resolved as type \"{Type}\"",
            itemId, item?.GetType().FullName ?? "null (not found)");

        string? folderPath = null;

        // A Playnite Bridge game has no library entry; its files lie in its game folder,
        // read with the Movies naming (Prefixed as Standalone, like a Set) and the Games rows.
        if (item is null && Helpers.PlayniteBridgeLink.IsGame(itemId))
        {
            if (!config.CharacterartShowOnGames || !Helpers.PlayniteBridgeLink.DrawsGames)
            {
                _logger.LogDebug("Characterart: ResolveItem - {ItemId} is a game, but CharacterartShowOnGames is off or Playnite Bridge draws games", itemId);
                return null;
            }

            folderPath = Helpers.PlayniteBridgeLink.GameFolder(itemId, first); // the folder of the game version shown
            if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath))
            {
                _logger.LogDebug("Characterart: ResolveItem - game folder not found for {ItemId}: \"{Path}\"", itemId, folderPath ?? "(empty)");
                return null;
            }

            var name = GameCharacterartName();
            return (folderPath, GameNaming(config.CharacterartMoviesNamingMode), name ?? config.CharacterartMoviesTypeName,
                name ?? config.CharacterartMoviesFolderName, config.CharacterartGamesMultiImage, config.CharacterartAllowedFormats,
                config.CharacterartGamesCycleTimeMs, config.CharacterartGamesFadeTimeMs,
                config.CharacterartGamesDelayEnabled, config.CharacterartGamesDelayMs, config.CharacterartGamesSinglePass,
                config.CharacterartGamesStaySingleImageStatic, config.CharacterartGamesOrderMode, "Games", config.CharacterartGamesRandomStart);
        }

        if (item is Movie movie)
        {
            if (!config.CharacterartShowOnMovies)
            {
                _logger.LogDebug("Characterart: ResolveItem - {ItemId} is a Movie, but CharacterartShowOnMovies is off", itemId);
                return null;
            }

            folderPath = movie.ContainingFolderPath;
            if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath))
            {
                _logger.LogWarning("Characterart: ResolveItem - movie folder not found for {ItemId}: \"{Path}\"", itemId, folderPath ?? "(empty)");
                return null;
            }

            return (folderPath, config.CharacterartMoviesNamingMode, config.CharacterartMoviesTypeName,
                config.CharacterartMoviesFolderName, config.CharacterartMoviesMultiImage, config.CharacterartAllowedFormats,
                config.CharacterartMoviesCycleTimeMs, config.CharacterartMoviesFadeTimeMs,
                config.CharacterartMoviesDelayEnabled, config.CharacterartMoviesDelayMs, config.CharacterartMoviesSinglePass,
                config.CharacterartMoviesStaySingleImageStatic, config.CharacterartMoviesOrderMode, "Movies", config.CharacterartMoviesRandomStart);
        }

        if (item is BoxSet boxSet)
        {
            if (!config.CharacterartShowOnSets)
            {
                _logger.LogDebug("Characterart: ResolveItem - {ItemId} is a BoxSet, but CharacterartShowOnSets is off", itemId);
                return null;
            }

            folderPath = boxSet.ContainingFolderPath;
            if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath))
            {
                _logger.LogWarning("Characterart: ResolveItem - set folder not found for {ItemId}: \"{Path}\"", itemId, folderPath ?? "(empty)");
                return null;
            }

            // Shares every other Movies setting (see CharacterartShowOnSets
            // in PluginConfiguration.cs). NamingMode is the one exception,
            // fixed to "Standalone": a "Prefixed" file name needs a movie's
            // folder name to prefix with, which a Set does not have.
            return (folderPath, "Standalone", config.CharacterartMoviesTypeName,
                config.CharacterartMoviesFolderName, config.CharacterartMoviesMultiImage, config.CharacterartAllowedFormats,
                config.CharacterartMoviesCycleTimeMs, config.CharacterartMoviesFadeTimeMs,
                config.CharacterartMoviesDelayEnabled, config.CharacterartMoviesDelayMs, config.CharacterartMoviesSinglePass,
                config.CharacterartMoviesStaySingleImageStatic, config.CharacterartMoviesOrderMode, "Movies", config.CharacterartMoviesRandomStart);
        }

        if (item is Series series)
        {
            if (!config.CharacterartShowOnTvShows)
            {
                _logger.LogDebug("Characterart: ResolveItem - {ItemId} is a Series, but CharacterartShowOnTvShows is off", itemId);
                return null;
            }

            folderPath = series.ContainingFolderPath;
        }
        else if (item is Season season)
        {
            if (!config.CharacterartShowOnSeasons)
            {
                _logger.LogDebug("Characterart: ResolveItem - {ItemId} is a Season, but CharacterartShowOnSeasons is off", itemId);
                return null;
            }

            folderPath = season.Series?.ContainingFolderPath;
            _logger.LogDebug("Characterart: ResolveItem - Season {ItemId} -> navigated to the series' main folder via Season.Series", itemId);
        }
        else if (item is Episode episode)
        {
            if (!config.CharacterartShowOnEpisodes)
            {
                _logger.LogDebug("Characterart: ResolveItem - {ItemId} is an Episode, but CharacterartShowOnEpisodes is off", itemId);
                return null;
            }

            folderPath = episode.Series?.ContainingFolderPath;
            _logger.LogDebug("Characterart: ResolveItem - Episode {ItemId} -> navigated to the series' main folder via Episode.Series", itemId);
        }
        else
        {
            _logger.LogDebug("Characterart: ResolveItem - {ItemId} is none of the supported types (Movie/Series/Season/Episode)", itemId);
            return null;
        }

        if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath))
        {
            _logger.LogWarning("Characterart: ResolveItem - the TV series' main folder wasn't found for {ItemId}: \"{Path}\"", itemId, folderPath ?? "(empty)");
            return null;
        }

        return (folderPath, TvNaming(config.CharacterartTvShowsNamingMode), config.CharacterartTvShowsTypeName,
            config.CharacterartTvShowsFolderName, config.CharacterartTvShowsMultiImage, config.CharacterartAllowedFormats,
            config.CharacterartTvShowsCycleTimeMs, config.CharacterartTvShowsFadeTimeMs,
            config.CharacterartTvShowsDelayEnabled, config.CharacterartTvShowsDelayMs, config.CharacterartTvShowsSinglePass,
            config.CharacterartTvShowsStaySingleImageStatic, config.CharacterartTvShowsOrderMode, "TvShows", config.CharacterartTvShowsRandomStart);
    }

    /// <summary>
    /// The Characterart stage of LogoArt's logo-slot chain. Returns the SAME
    /// files this tab would show for the item (Naming mode / Type name /
    /// Folder name / Allowed formats are the tab's), but deliberately WITHOUT
    /// this tab's Enable and Show-on gates and rotation settings: the slot is
    /// independent of the Characterart tab, and only the file lookup is
    /// shared so the admin page needs no second naming block.
    /// multiImage/orderMode come from the LogoArt type's own fields.
    /// </summary>
    internal (string FolderPath, List<string> Images)? ResolveSlotImages(MediaBrowser.Controller.Entities.BaseItem item, PluginConfiguration config, bool multiImage, string orderMode)
    {
        string? folderPath;
        string namingMode;
        string typeName;
        string folderName;
        var isMovieKind = true;
        if (item is Movie movie)
        {
            folderPath = movie.ContainingFolderPath;
            namingMode = config.CharacterartMoviesNamingMode;
            typeName = config.CharacterartMoviesTypeName;
            folderName = config.CharacterartMoviesFolderName;
        }
        else if (item is BoxSet boxSet)
        {
            folderPath = boxSet.ContainingFolderPath;
            namingMode = "Standalone"; // same exception as ResolveItem's BoxSet branch
            typeName = config.CharacterartMoviesTypeName;
            folderName = config.CharacterartMoviesFolderName;
        }
        else if (item is Series || item is Season || item is Episode)
        {
            folderPath = item is Series s ? s.ContainingFolderPath : item is Season se ? se.Series?.ContainingFolderPath : ((Episode)item).Series?.ContainingFolderPath;
            namingMode = TvNaming(config.CharacterartTvShowsNamingMode);
            typeName = config.CharacterartTvShowsTypeName;
            isMovieKind = false;
            folderName = config.CharacterartTvShowsFolderName;
        }
        else
        {
            return null;
        }

        if (string.IsNullOrEmpty(folderPath) || !Directory.Exists(folderPath))
        {
            _logger.LogDebug("Characterart: ResolveSlotImages - folder not found for {ItemId}: \"{Path}\"", item.Id, folderPath ?? "(empty)");
            return null;
        }

        var images = ResolveCandidates(folderPath, namingMode, typeName, folderName, multiImage, orderMode, config.CharacterartAllowedFormats, UnnumberedFor(config, isMovieKind ? "Movies" : "TvShows"));
        return (folderPath, images);
    }

    /// <summary>
    /// The slot images of a Playnite Bridge game, read in its
    /// game folder (no BaseItem). The Movies naming applies - Prefixed reads as
    /// Standalone, because the folder name carries Playnite Bridge's short id
    /// ("Title [65b32c14]") - the same exception as a Set; no new naming block.
    /// </summary>
    internal (string FolderPath, List<string> Images)? ResolveGameSlotImages(string? gameFolder, PluginConfiguration config, bool multiImage, string orderMode)
    {
        if (string.IsNullOrEmpty(gameFolder) || !Directory.Exists(gameFolder)) { return null; }
        var name = GameCharacterartName();
        var images = ResolveCandidates(gameFolder, GameNaming(config.CharacterartMoviesNamingMode), name ?? config.CharacterartMoviesTypeName, name ?? config.CharacterartMoviesFolderName, multiImage, orderMode, config.CharacterartAllowedFormats, UnnumberedFor(config, "Games"));
        return (gameFolder, images);
    }

    /// <summary>Games: one slot image file of a game, validated against its candidate list like ResolveSlotImageFile.</summary>
    internal (string FullPath, string ContentType)? ResolveGameSlotImageFile(string? gameFolder, PluginConfiguration config, string fileName)
    {
        var resolved = ResolveGameSlotImages(gameFolder, config, true, "Sequential");
        if (resolved is null || !resolved.Value.Images.Contains(fileName, StringComparer.Ordinal)) { return null; }
        var fullPath = Path.Combine(resolved.Value.FolderPath, fileName);
        return System.IO.File.Exists(fullPath) ? (fullPath, GetContentType(fullPath)) : null;
    }

    /// <summary>The file bytes of one slot image (validated against the candidate list like GetCharacterartImage). Null = not a candidate / gone.</summary>
    internal (string FullPath, string ContentType)? ResolveSlotImageFile(MediaBrowser.Controller.Entities.BaseItem item, PluginConfiguration config, string fileName)
    {
        var resolved = ResolveSlotImages(item, config, true, "Sequential");
        if (resolved is null || !resolved.Value.Images.Contains(fileName, StringComparer.Ordinal)) { return null; }
        var fullPath = Path.Combine(resolved.Value.FolderPath, fileName);
        return System.IO.File.Exists(fullPath) ? (fullPath, GetContentType(fullPath)) : null;
    }

    /// <summary>
    /// Sizing is configured separately per position AND per content type
    /// (Movies vs. TV shows): each of the four spots on the page differs, and
    /// a movie's and a show's detail page may want the artwork placed
    /// differently. Picks the set for the position currently selected for the
    /// given content type; the other sets stay stored, unused until the admin
    /// switches to them.
    /// </summary>
    private static (string ScaleMode, double HeightVh, double MaxWidthVw, double WidthVw, double MaxHeightVh, string HorizontalAlign, double OffsetVw, double FullscreenOffsetVw)
        ResolvePositionSizing(PluginConfiguration config, string kind, string position)
    {
        if (kind == "Games")
        {
            return position switch
            {
                "TopLeft" => (config.CharacterartGamesTopLeftScaleMode, config.CharacterartGamesTopLeftHeightVh, config.CharacterartGamesTopLeftMaxWidthVw, config.CharacterartGamesTopLeftWidthVw, config.CharacterartGamesTopLeftMaxHeightVh, config.CharacterartGamesTopLeftHorizontalAlign, config.CharacterartGamesTopLeftOffsetVw, config.CharacterartGamesTopLeftFullscreenOffsetVw),
                "TopRight" => (config.CharacterartGamesTopRightScaleMode, config.CharacterartGamesTopRightHeightVh, config.CharacterartGamesTopRightMaxWidthVw, config.CharacterartGamesTopRightWidthVw, config.CharacterartGamesTopRightMaxHeightVh, config.CharacterartGamesTopRightHorizontalAlign, config.CharacterartGamesTopRightOffsetVw, config.CharacterartGamesTopRightFullscreenOffsetVw),
                "BottomRight" => (config.CharacterartGamesBottomRightScaleMode, config.CharacterartGamesBottomRightHeightVh, config.CharacterartGamesBottomRightMaxWidthVw, config.CharacterartGamesBottomRightWidthVw, config.CharacterartGamesBottomRightMaxHeightVh, config.CharacterartGamesBottomRightHorizontalAlign, config.CharacterartGamesBottomRightOffsetVw, config.CharacterartGamesBottomRightFullscreenOffsetVw),
                _ => (config.CharacterartGamesBottomLeftScaleMode, config.CharacterartGamesBottomLeftHeightVh, config.CharacterartGamesBottomLeftMaxWidthVw, config.CharacterartGamesBottomLeftWidthVw, config.CharacterartGamesBottomLeftMaxHeightVh, config.CharacterartGamesBottomLeftHorizontalAlign, config.CharacterartGamesBottomLeftOffsetVw, config.CharacterartGamesBottomLeftFullscreenOffsetVw)
            };
        }

        if (kind == "Movies")
        {
            return position switch
            {
                "TopLeft" => (config.CharacterartMoviesTopLeftScaleMode, config.CharacterartMoviesTopLeftHeightVh, config.CharacterartMoviesTopLeftMaxWidthVw, config.CharacterartMoviesTopLeftWidthVw, config.CharacterartMoviesTopLeftMaxHeightVh, config.CharacterartMoviesTopLeftHorizontalAlign, config.CharacterartMoviesTopLeftOffsetVw, config.CharacterartMoviesTopLeftFullscreenOffsetVw),
                "TopRight" => (config.CharacterartMoviesTopRightScaleMode, config.CharacterartMoviesTopRightHeightVh, config.CharacterartMoviesTopRightMaxWidthVw, config.CharacterartMoviesTopRightWidthVw, config.CharacterartMoviesTopRightMaxHeightVh, config.CharacterartMoviesTopRightHorizontalAlign, config.CharacterartMoviesTopRightOffsetVw, config.CharacterartMoviesTopRightFullscreenOffsetVw),
                "BottomRight" => (config.CharacterartMoviesBottomRightScaleMode, config.CharacterartMoviesBottomRightHeightVh, config.CharacterartMoviesBottomRightMaxWidthVw, config.CharacterartMoviesBottomRightWidthVw, config.CharacterartMoviesBottomRightMaxHeightVh, config.CharacterartMoviesBottomRightHorizontalAlign, config.CharacterartMoviesBottomRightOffsetVw, config.CharacterartMoviesBottomRightFullscreenOffsetVw),
                _ => (config.CharacterartMoviesBottomLeftScaleMode, config.CharacterartMoviesBottomLeftHeightVh, config.CharacterartMoviesBottomLeftMaxWidthVw, config.CharacterartMoviesBottomLeftWidthVw, config.CharacterartMoviesBottomLeftMaxHeightVh, config.CharacterartMoviesBottomLeftHorizontalAlign, config.CharacterartMoviesBottomLeftOffsetVw, config.CharacterartMoviesBottomLeftFullscreenOffsetVw)
            };
        }

        return position switch
        {
            "TopLeft" => (config.CharacterartTvShowsTopLeftScaleMode, config.CharacterartTvShowsTopLeftHeightVh, config.CharacterartTvShowsTopLeftMaxWidthVw, config.CharacterartTvShowsTopLeftWidthVw, config.CharacterartTvShowsTopLeftMaxHeightVh, config.CharacterartTvShowsTopLeftHorizontalAlign, config.CharacterartTvShowsTopLeftOffsetVw, config.CharacterartTvShowsTopLeftFullscreenOffsetVw),
            "TopRight" => (config.CharacterartTvShowsTopRightScaleMode, config.CharacterartTvShowsTopRightHeightVh, config.CharacterartTvShowsTopRightMaxWidthVw, config.CharacterartTvShowsTopRightWidthVw, config.CharacterartTvShowsTopRightMaxHeightVh, config.CharacterartTvShowsTopRightHorizontalAlign, config.CharacterartTvShowsTopRightOffsetVw, config.CharacterartTvShowsTopRightFullscreenOffsetVw),
            "BottomRight" => (config.CharacterartTvShowsBottomRightScaleMode, config.CharacterartTvShowsBottomRightHeightVh, config.CharacterartTvShowsBottomRightMaxWidthVw, config.CharacterartTvShowsBottomRightWidthVw, config.CharacterartTvShowsBottomRightMaxHeightVh, config.CharacterartTvShowsBottomRightHorizontalAlign, config.CharacterartTvShowsBottomRightOffsetVw, config.CharacterartTvShowsBottomRightFullscreenOffsetVw),
            _ => (config.CharacterartTvShowsBottomLeftScaleMode, config.CharacterartTvShowsBottomLeftHeightVh, config.CharacterartTvShowsBottomLeftMaxWidthVw, config.CharacterartTvShowsBottomLeftWidthVw, config.CharacterartTvShowsBottomLeftMaxHeightVh, config.CharacterartTvShowsBottomLeftHorizontalAlign, config.CharacterartTvShowsBottomLeftOffsetVw, config.CharacterartTvShowsBottomLeftFullscreenOffsetVw)
        };
    }

    private string[] GetAllowedExtensions(string? allowedFormatsCsv)
    {
        var extensions = (allowedFormatsCsv ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => "." + f.ToLowerInvariant())
            .ToArray();

        return extensions.Length == 0 ? new[] { ".png" } : extensions;
    }

    /// <summary>
    /// Pairs each candidate file name with its own version fingerprint -
    /// see ExtraposterController.BuildPosterEntries (same logic, kept
    /// separate like the other per-controller helpers).
    /// </summary>
    private static List<ImageEntry> BuildImageEntries(string folderPath, List<string> fileNames)
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

            return new ImageEntry { FileName = fileName, Version = version };
        }).ToList();
    }

    /// <summary>TV shows have no Prefixed mode (a show folder is exclusive) - Standalone or Folder.</summary>
    private static string TvNaming(string mode) => mode == "Folder" ? "Folder" : "Standalone";

    /// <summary>The "Unnumbered file" setting of the Movies (also Sets and Games, which use the Movies naming) or TV shows section.</summary>
    private static string UnnumberedFor(PluginConfiguration c, string kind) => kind == "TvShows" ? c.CharacterartTvShowsUnnumberedMode : c.CharacterartMoviesUnnumberedMode;

    /// <summary>Games: the Movies naming, Prefixed read as Standalone (the folder name carries the short id).</summary>
    private static string GameNaming(string mode) => mode == "Prefixed" ? "Standalone" : mode;

    /// <summary>
    /// The CharacterArt base name chosen on Playnite Bridge's admin page (characterart, cutout or its
    /// own name); it names the files (name.ext, name1.ext ...) and the Folder-mode subfolder. Null = Playnite Bridge
    /// gives none, so this plugin's Movies type and folder names apply.
    /// </summary>
    private static string? GameCharacterartName()
        => Helpers.PlayniteBridgeLink.FileNames("CharacterArt") is { Length: > 0 } names && !string.IsNullOrWhiteSpace(names[0]) ? names[0].Trim() : null;

    /// <summary>
    /// Finds the Characterart candidates, with a server cache in front of it,
    /// as in ExtraposterController.ResolveCandidates (a composite key from the
    /// folder's change date and all relevant settings).
    /// </summary>
    private List<string> ResolveCandidates(string folderPath, string namingMode, string typeName, string folderName, bool multiImage, string orderMode, string? allowedFormatsCsv, string unnumberedMode)
    {
        var lastWriteUtc = SafeGetLastWriteTimeUtc(folderPath);
        // orderMode is not part of the cache key: the cached list is always
        // the raw, naturally sorted discovery result, the same for every
        // orderMode.
        var cacheKey = string.Join(
            '|',
            "Characterart:Candidates",
            folderPath,
            lastWriteUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture),
            namingMode,
            typeName,
            folderName,
            multiImage,
            allowedFormatsCsv ?? string.Empty,
            unnumberedMode);

        List<string> naturallyOrdered;
        if (_cache.TryGetValue(cacheKey, out List<string>? cached) && cached is not null)
        {
            _logger.LogDebug("Characterart: ResolveCandidates - cache hit for \"{Key}\"", cacheKey);
            naturallyOrdered = cached;
        }
        else
        {
            // Cache the list in natural order, never a shuffled result:
            // otherwise one shuffle outcome would sit behind the sliding
            // cache and keep reappearing while the title is accessed. Only
            // the expensive part, the filesystem discovery, is cached.
            naturallyOrdered = ResolveCandidatesUncached(folderPath, namingMode, typeName, folderName, multiImage, "Sequential", allowedFormatsCsv, unnumberedMode);
            _cache.Set(cacheKey, naturallyOrdered, new MemoryCacheEntryOptions().SetSlidingExpiration(CacheSlidingExpiration));
        }

            // The order is applied fresh on every call: shuffling a known
            // list in memory is cheap. ApplyOrder() returns a new list and
            // never mutates the cached one.
        return orderMode == "Sequential" ? naturallyOrdered : ApplyOrder(naturallyOrdered, orderMode);
    }

    /// <summary>
    /// Uncached candidate resolution. Four combinations are possible:
    /// Standalone+single image ("typeName.ext"), Standalone+multi-image
    /// ("typeName1.ext", "typeName2.ext", ...), Prefixed+single image
    /// ("MovieFolderName-typeName.ext", only available for Movies),
    /// Prefixed+multi-image, plus Folder (always everything in the
    /// subfolder, for single image only the first match in natural sort
    /// order is returned, a valid combination).
    /// </summary>
    private List<string> ResolveCandidatesUncached(string folderPath, string namingMode, string typeName, string folderName, bool multiImage, string orderMode, string? allowedFormatsCsv, string unnumberedMode)
    {
        var allowedExtensions = GetAllowedExtensions(allowedFormatsCsv);
        List<string> fileNames;

        if (namingMode == "Folder")
        {
            var subFolder = Path.Combine(folderPath, folderName);
            if (!Directory.Exists(subFolder))
            {
                _logger.LogDebug("Characterart: ResolveCandidatesUncached - Folder mode, subfolder not found: \"{SubFolder}\"", subFolder);
                return new List<string>();
            }

            var filesInSubFolder = Directory.EnumerateFiles(subFolder).Select(Path.GetFileName).ToList();
            fileNames = filesInSubFolder
                .Where(f => f is not null && allowedExtensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase))
                .Select(f => Path.Combine(folderName, f!))
                .ToList();
            fileNames = ApplyOrder(fileNames, orderMode);

            if (!multiImage && fileNames.Count > 1)
            {
                _logger.LogDebug(
                    "Characterart: ResolveCandidatesUncached - Folder mode + single image: {Count} files found, only the first is used: \"{First}\"",
                    fileNames.Count, fileNames[0]);
                fileNames = new List<string> { fileNames[0] };
            }

            return fileNames;
        }

        var prefix = namingMode == "Prefixed"
            ? Path.GetFileName(folderPath) + "-" + typeName
            : typeName;

        fileNames = new List<string>();

        if (!multiImage)
        {
            // Single image: exactly "<prefix>.ext", no digit at all.
            foreach (var ext in allowedExtensions)
            {
                var candidate = prefix + ext;
                if (System.IO.File.Exists(Path.Combine(folderPath, candidate)))
                {
                    fileNames.Add(candidate);
                    break;
                }
            }

            _logger.LogDebug(
                "Characterart: ResolveCandidatesUncached - single-image mode, searched pattern=\"{Prefix}.<ext>\", match: [{Files}]",
                prefix, string.Join(", ", fileNames));
            return fileNames;
        }

        // Multi-image: when "Unnumbered file" is Counts (the default), the
        // FIRST image is the unnumbered one, named like in single-image
        // mode, and numbering starts at 1 from the SECOND image on. This is
        // the opposite of Extraposter, where the unnumbered file is
        // Jellyfin's native main poster and never a candidate: Characterart
        // has no native image, so the unnumbered file is a regular member of
        // its own candidate list.
        var unnumberedFound = false;
        foreach (var ext in unnumberedMode == "Counts" ? allowedExtensions : Array.Empty<string>())
        {
            var candidate = prefix + ext;
            if (System.IO.File.Exists(Path.Combine(folderPath, candidate)))
            {
                fileNames.Add(candidate);
                unnumberedFound = true;
                break;
            }
        }

        var numberedFilesFound = 0;
        for (var i = 1; i <= MaxNumberedImages; i++)
        {
            var found = false;
            foreach (var ext in allowedExtensions)
            {
                var candidate = prefix + i.ToString(System.Globalization.CultureInfo.InvariantCulture) + ext;
                if (System.IO.File.Exists(Path.Combine(folderPath, candidate)))
                {
                    fileNames.Add(candidate);
                    found = true;
                    numberedFilesFound++;
                    break;
                }
            }

            // Early-abort gap tolerance, counted independently of whether
            // the unnumbered file was found - otherwise "only the
            // unnumbered file exists, no numbered ones at all" would
            // needlessly probe all the way up to MaxNumberedImages before
            // giving up (correct result either way, just wasteful).
            if (!found && i >= 3 && numberedFilesFound == 0)
            {
                break;
            }
        }

        _logger.LogDebug(
            "Characterart: ResolveCandidatesUncached - multi-image mode, searched prefix=\"{Prefix}\", unnumbered found={UnnumberedFound}, {NumberedCount} numbered match(es), {TotalCount} total: [{Files}]",
            prefix, unnumberedFound, numberedFilesFound, fileNames.Count, string.Join(", ", fileNames));

        // Deliberately NOT using ApplyOrder/NaturalSort here (the Folder-mode
        // branch above does): NaturalSort puts unnumbered files AFTER
        // numbered ones, but here the unnumbered file must come first.
        // "Shuffle" and "Random" mix everything, the unnumbered file
        // included. "Sequential" needs no sorting: fileNames was built in
        // the right order (unnumbered first, then 1, 2, 3...).
        if (orderMode == "Shuffle")
        {
            return fileNames.OrderBy(_ => Guid.NewGuid()).ToList();
        }

        if (orderMode == "Random")
        {
            var rnd = new Random();
            var result = new List<string>(fileNames.Count);
            for (var i = 0; i < fileNames.Count; i++)
            {
                result.Add(fileNames[rnd.Next(fileNames.Count)]);
            }

            return result;
        }

        return fileNames;
    }

    /// <summary>
    /// Applies the admin-configured order. "Shuffle" returns a permutation,
    /// "Random" independent draws; anything else (including the default
    /// "Sequential") keeps the natural numeric order. Called fresh on every
    /// request by ResolveCandidates, which caches only the unordered
    /// discovery result. For 0 or 1 entries it makes no difference.
    /// </summary>
    private static List<string> ApplyOrder(List<string> fileNames, string orderMode)
    {
        if (orderMode == "Shuffle")
        {
            // A full permutation, re-rolled on every call: every image
            // appears exactly once before any repeat.
            return fileNames.OrderBy(_ => Guid.NewGuid()).ToList();
        }

        if (orderMode == "Random")
        {
            // The simplest random pick, distinct from "Shuffle": independent
            // draws WITH replacement for every position, so the same file can
            // appear more than once, or not at all.
            var rnd = new Random();
            var result = new List<string>(fileNames.Count);
            for (var i = 0; i < fileNames.Count; i++)
            {
                result.Add(fileNames[rnd.Next(fileNames.Count)]);
            }

            return result;
        }

        return NaturalSort(fileNames);
    }

    /// <summary>
    /// Alphanumeric "natural sort"; see ExtraposterController.NaturalSort for
    /// the reasoning (kept as a separate copy like the other per-controller
    /// helpers). Used by the Folder-mode branch (arbitrary file names, where
    /// "banana before banana1" matters); the Standalone/Prefixed multi-image
    /// branch builds its list in the right order itself.
    /// </summary>
    private static List<string> NaturalSort(List<string> fileNames)
    {
        var result = new List<string>(fileNames);
        result.Sort(NaturalFileNameComparer.Instance);
        return result;
    }

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

            if (chunksA.Count != chunksB.Count)
            {
                return chunksA.Count - chunksB.Count;
            }

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
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            ".svg" => "image/svg+xml",
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
            _logger.LogWarning(ex, "Characterart: SafeGetLastWriteTimeUtc failed for \"{Folder}\"", folderPath);
            return DateTime.MinValue;
        }
    }
}
