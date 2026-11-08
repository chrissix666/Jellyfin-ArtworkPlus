using System;
using System.Collections.Generic;
using System.IO;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using Jellyfin.Plugin.ArtworkPlus.Helpers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Result DTO for the flat case's "which texture, positioned how" decision.
/// Separate from the image bytes (see GetTexture()): the client fetches this
/// once per navigation, then builds an absolutely positioned &lt;img&gt;
/// pointing at the texture endpoint - the same two-step shape as the other
/// poster features (info, then image).
/// </summary>
public class CaseModInfoResult
{
    public bool IsApplicable { get; set; }

    // The seven trigger fields below use the names of the Three.js case's
    // answer (Open.Automatic, Spin.OnClick and so on, see
    // ThreejsCaseController) with its nesting flattened, so both answers can
    // be read side by side. Their config counterparts are the CaseMod2D*
    // fields.

    /// <summary>
    /// First trigger: the case opens by itself after OpenDelayMs (see
    /// PluginConfiguration.CaseMod2DOpenAutomatic). The client considers Open
    /// Case active whenever EITHER this OR OpenOnClick is true, with no extra
    /// gate in between.
    /// </summary>
    public bool OpenAutomatic { get; set; }

    /// <summary>The delay itself (ms), admin-adjustable.</summary>
    public double OpenDelayMs { get; set; }

    /// <summary>
    /// Second trigger: a click on the poster. It is a toggle - the case opens
    /// and stays open, and the next click closes it, unless SpinAutomatic is
    /// on, in which case the click runs the whole open/spin/close timeline.
    /// See PluginConfiguration.CaseMod2DOpenOnClick.
    /// </summary>
    public bool OpenOnClick { get; set; }

    /// <summary>
    /// Third mode: a click plays the whole open/spin/close timeline, the one
    /// OpenAutomatic starts on a timer. Mutually exclusive with OpenOnClick -
    /// see PluginConfiguration.CaseMod2DOpenOnClickAutomatic.
    /// </summary>
    public bool OpenOnClickAutomatic { get; set; }

    /// <summary>"vivaelitecases", "clearcases", or "vortexcases".</summary>
    public string CaseType { get; set; } = string.Empty;

    /// <summary>
    /// A token that changes whenever a texture file does - the newest write
    /// time in the CaseTextures tree. The client puts it in every texture URL
    /// as ?v=, which makes a changed delivery a NEW address. The texture
    /// endpoint answers with "max-age=2592000, immutable"; without this token
    /// a browser would keep drawing an old texture after an update.
    /// </summary>
    public string TextureVersion { get; set; } = string.Empty;

    /// <summary>
    /// File name (without extension) inside CaseTextures/{CaseType}/ -
    /// one of: 480p, 540p, 576p, 720p, 1080p, 4k, 3d, p, tvseries.
    /// </summary>
    public string TextureKey { get; set; } = string.Empty;

    /// <summary>
    /// Back-cover texture key ("back_" + TextureKey). The back box reuses the
    /// front's geometry: a real case's front and back cover share the same
    /// outer dimensions. Layering: back case BEHIND the poster card (z-index
    /// 2, under the card's z-index 3 from Jellyfin's librarybrowser.scss),
    /// front case above it (z-index 4) - three layers: back / poster / front.
    /// </summary>
    public string BackTextureKey { get; set; } = string.Empty;

    /// <summary>
    /// Whether this item has a Disc image (Jellyfin-native
    /// ImageType.Disc - locally sourced from "disc"/"cdart"/"discart"
    /// files per LocalImageProvider.cs, or from any remote provider).
    /// The Open Case animation and the disc itself run only when Open Case
    /// is enabled AND a discart exists; without one the case stays static and
    /// no disc is drawn. The client loads the disc from
    /// /Items/{itemId}/Images/Disc (Jellyfin's ImageController.GetItemImage,
    /// no [Authorize] on that route), so no endpoint is needed here.
    /// </summary>
    public bool HasDiscart { get; set; }

    /// <summary>
    /// How far the front cover swings open (degrees); see
    /// PluginConfiguration.CaseMod2DOpenAngleDegrees. Clamped to [0, 180]
    /// in GetInfo().
    /// </summary>
    public double OpenAngleDegrees { get; set; }

    /// <summary>
    /// Whether the disc turns when the case OPENS - its own axis, independent
    /// of the hinge motion. Only meaningful when the disc is rendered at all
    /// (Open Case active &amp;&amp; HasDiscart). See
    /// PluginConfiguration.CaseMod2DSpinAutomatic.
    /// </summary>
    public bool SpinAutomatic { get; set; }

    /// <summary>
    /// Whether the disc turns inside the CLICK-started sequence. One disc flag
    /// per open mode of the same name.
    /// </summary>
    public bool SpinOnClickAutomatic { get; set; }

    /// <summary>
    /// Whether a click on the disc itself turns it once, as in the Three.js
    /// case. See PluginConfiguration.CaseMod2DSpinOnClick.
    /// </summary>
    public bool SpinOnClick { get; set; }

    /// <summary>
    /// Direction the disc turns in, "Left" or "Right"; see
    /// PluginConfiguration.CaseMod2DSpinDirection.
    /// </summary>
    public string SpinDirection { get; set; } = "Left";

    /// <summary>
    /// The box's literal desktop-layout position and size: absolute geometry,
    /// because relative multipliers cannot make the box exactly match the
    /// visible case artwork. The values come from the per-case-type tune
    /// settings in GetInfo(). The client's CaseModModule derives the mobile/TV
    /// equivalents from how these compare to the shared desktop base.
    /// </summary>
    public double TopPercent { get; set; }

    public double LeftPercent { get; set; }

    public double WidthVw { get; set; }

    public double HeightVw { get; set; }

    /// <summary>
    /// Poster size, in percent of what Jellyfin itself draws. Rides on
    /// EVERY answer, including the not-applicable ones: the override is
    /// independent of the case and must reach Seasons and Episodes,
    /// where a case never appears. 100 means "leave it alone".
    /// </summary>
    public int PosterSizePercent { get; set; } = 100;

    /// <summary>
    /// Where the shrunken poster sits inside its own 100 % footprint.
    /// "Default" leaves Jellyfin's own anchor alone. Rides on every answer,
    /// for the same reason PosterSizePercent does.
    /// </summary>
    public string PosterSizeAnchor { get; set; } = "Default";

    /// <summary>
    /// Disc geometry - same units as the Case box above (Top = vw offset from
    /// the poster's -80% base, Left = %), but only ONE size value: a disc is
    /// round, so the size is used as both width and height. Per case type,
    /// like the Case box.
    /// </summary>
    public double DiscTopPercent { get; set; }

    public double DiscLeftPercent { get; set; }

    public double DiscSizeVw { get; set; }

    /// <summary>
    /// Fixed perspective tilt angle for "Viva Elite 3D Case" - 0 for every
    /// other case type (no effect, stays flat). The sign determines the hinge
    /// side on the client.
    /// </summary>
    public double CaseAngleDegrees { get; set; }

    /// <summary>Inner-case geometry (only relevant for Viva Elite 3D Case) - the graphic is reused 1:1 from vivaelitecases, only its own position/size.</summary>
    public double InnerCaseTopPercent { get; set; }
    public double InnerCaseLeftPercent { get; set; }
    public double InnerCaseWidthVw { get; set; }
    public double InnerCaseHeightVw { get; set; }

    /// <summary>The hub decal over the disc - Top vw, Left %, Size vw, exactly like the disc.</summary>
    public double HubTopPercent { get; set; }
    public double HubLeftPercent { get; set; }
    public double HubSizeVw { get; set; }

    /// <summary>"Original" or "FullShell" for this case type, and how the colour is derived.</summary>
    public string? ColorMode { get; set; }
    public string? ColorBlend { get; set; }

    /// <summary>Admin preview switches for calibrating the boxes; see PluginConfiguration.</summary>
    public bool TuneHidePoster { get; set; }
    public bool TuneShowInnerCase { get; set; }
    public bool TuneShowDisc { get; set; }

    /// <summary>Hides the hub decal while tuning.</summary>
    public bool TuneHideHub { get; set; }

    /// <summary>Hides the front cover, and the disc, while tuning.</summary>
    public bool TuneHideFrontCase { get; set; }
    public bool TuneHideDisc { get; set; }
}

/// <summary>
/// Serves the physical disc-case overlay (the "Case" tab): which texture
/// applies to an item, at what position and size, and the PNG bytes. Gated by
/// CaseModEnabled (General tab). Detail pages only (Movie/BoxSet/Series at
/// the main level). The client side lives in the CaseModModule of
/// Jellyfin-ArtworkPlus-Posters-v1.js, so this controller has no GetScript()
/// endpoint.
/// </summary>
[ApiController]
[Route("CaseMod")]
// No authorization attribute on purpose: both routes are read by <img>/fetch
// without a token, and Jellyfin 10.10.7 has no fallback authorization
// policy, so an attribute-less action is anonymous - the same state
// [AllowAnonymous] would declare explicitly.
public class CaseModController : ControllerBase
{
    /// <summary>
    /// Allowlist for the "caseType"/"key" URL segments in GetTexture() -
    /// both end up in a filesystem Path.Combine() call, so an unchecked
    /// value would be a path-traversal risk (e.g. "../../../etc/passwd"
    /// as "key"), even though these normally only come from this plugin's
    /// GetInfo() response and the admin-configured CaseModType.
    /// </summary>
    private static readonly HashSet<string> ValidCaseTypes = new(StringComparer.Ordinal)
    {
        "vivaelitecases", "clearcases", "vortexcases", "vivaelite3dcases"
    };

    /// <summary>
    /// The ten anchor values: "Default" plus the 3x3 grid. Default is not a
    /// grid position - it means "leave Jellyfin's own anchor alone", and that
    /// anchor differs per layout, so it cannot be expressed as one of the nine.
    /// </summary>
    private static readonly HashSet<string> ValidAnchors = new(StringComparer.Ordinal)
    {
        "Default",
        "TopLeft", "TopCenter", "TopRight",
        "CenterLeft", "Center", "CenterRight",
        "BottomLeft", "BottomCenter", "BottomRight"
    };

    /// <summary>A base key, or a base key with exactly one layer suffix.</summary>
    private static bool IsValidTextureKey(string key)
    {
        if (ValidTextureKeys.Contains(key)) { return true; }
        foreach (var suffix in TextureLayerSuffixes)
        {
            if (key.EndsWith(suffix, StringComparison.Ordinal)
                && ValidTextureKeys.Contains(key.Substring(0, key.Length - suffix.Length)))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>The seven colour derivations, same names as the Three.js case's.</summary>
    private static readonly HashSet<string> ValidColorBlends = new(StringComparer.Ordinal)
    {
        "DominantDark", "DominantColorful", "Deep", "MaterialYou", "Accent", "TopRegion", "Vibrant"
    };

    /// <summary>
    /// The four layers a tintable case is composed of. A key is valid as
    /// itself and with any one of these suffixes, so the set below stays a
    /// list of BASE keys instead of growing to 226 entries, and a new format
    /// needs only one line.
    /// </summary>
    private static readonly string[] TextureLayerSuffixes = { "_shell", "_shell2", "_print", "_gloss" };

    private static readonly HashSet<string> ValidTextureKeys = new(StringComparer.Ordinal)
    {
        "480p", "540p", "576p", "720p", "1080p", "4k", "3d", "p", "tvseries",
        // Back-cover counterparts: same resolution keys, "back_" prefix,
        // same folder as the front ones.
        "back_480p", "back_540p", "back_576p", "back_720p", "back_1080p",
        "back_4k", "back_3d", "back_p", "back_tvseries",
        // "set": a category only for vivaelite3dcases (see the BoxSet branch
        // in GetInfo()); the other case types use "p" for sets, as they have
        // no set artwork.
        "set", "back_set",
        // The hub decal, cut out of the inside so it can be
        // drawn ON TOP of the disc - the peg goes through the disc's hole,
        // so a hub baked into the inside makes a correctly seated disc
        // impossible. One key per inside key.
        "back_480p_hub", "back_540p_hub", "back_576p_hub", "back_720p_hub",
        "back_1080p_hub", "back_4k_hub", "back_3d_hub", "back_p_hub",
        "back_tvseries_hub", "back_set_hub",
        // The Viva Elite 3D set keeps its own inside under an
        // `inside_` prefix, because its back_* files are the OUTSIDE back of
        // the rendered case and must not be overwritten by one.
        "inside_480p", "inside_540p", "inside_576p", "inside_720p",
        "inside_1080p", "inside_4k", "inside_3d", "inside_p",
        "inside_tvseries", "inside_set",
        "inside_480p_hub", "inside_540p_hub", "inside_576p_hub", "inside_720p_hub",
        "inside_1080p_hub", "inside_4k_hub", "inside_3d_hub", "inside_p_hub",
        "inside_tvseries_hub", "inside_set_hub"
    };

    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<CaseModController> _logger;

    public CaseModController(ILibraryManager libraryManager, ILogger<CaseModController> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
    }

    /// <summary>
    /// The poster-size override for one item, in percent.
    /// </summary>
    /// <remarks>
    /// Resolved on its own, BEFORE any of the case's own exits: the
    /// override works precisely when no case is drawn, so it cannot sit
    /// behind CaseModEnabled or Show on, and it must reach Seasons and
    /// Episodes where a case never appears at all. "Videos" is the
    /// catch-all for every kind not named (Movie, Episode, then "video" for
    /// all the rest). Movie/Episode/Season are checked
    /// BEFORE the fallback because Movie : Video and Episode : Video in
    /// Jellyfin's own model - an "is Video" test first would swallow
    /// them.
    /// </remarks>
    private static int ResolvePosterSize(PluginConfiguration config, BaseItem? item, bool isGame)
    {
        if (!config.CaseModPosterSizeEnabled)
        {
            return 100;
        }

        if (config.CaseModPosterSizeMode == "General")
        {
            return Math.Clamp(config.CaseModPosterSizeAll, 10, 200);
        }

        var pct = isGame ? config.CaseModPosterSizeGames : item switch
        {
            Movie => config.CaseModPosterSizeMovies,
            BoxSet => config.CaseModPosterSizeSets,
            Series => config.CaseModPosterSizeSeries,
            Season => config.CaseModPosterSizeSeasons,
            Episode => config.CaseModPosterSizeEpisodes,
            _ => config.CaseModPosterSizeVideos
        };

        return Math.Clamp(pct, 10, 200);
    }

    /// <summary>The poster-size anchor for one item.</summary>
    /// <remarks>
    /// Same shape as ResolvePosterSize, and the same kind order for the same
    /// reason - Movie and Episode both derive from Video in Jellyfin's own
    /// model, so they must be tested before the fallback. An unknown stored
    /// value falls back to "Default" rather than reaching the client, where it
    /// would silently mean "no offset" anyway but without saying so.
    /// </remarks>
    private static string ResolvePosterAnchor(PluginConfiguration config, BaseItem? item, bool isGame)
    {
        if (!config.CaseModPosterSizeEnabled)
        {
            return "Default";
        }

        var value = config.CaseModPosterSizeMode == "General"
            ? config.CaseModPosterSizeAnchorAll
            : isGame ? config.CaseModPosterSizeAnchorGames : item switch
            {
                Movie => config.CaseModPosterSizeAnchorMovies,
                BoxSet => config.CaseModPosterSizeAnchorSets,
                Series => config.CaseModPosterSizeAnchorSeries,
                Season => config.CaseModPosterSizeAnchorSeasons,
                Episode => config.CaseModPosterSizeAnchorEpisodes,
                _ => config.CaseModPosterSizeAnchorVideos
            };

        return ValidAnchors.Contains(value) ? value : "Default";
    }

    /// <summary>
    /// GET /CaseMod/{itemId} - resolves whether the case overlay
    /// applies to this item, and if so, which texture and at what
    /// position/size.
    /// </summary>
    [HttpGet("{itemId}")]
    public ActionResult<CaseModInfoResult> GetInfo([FromRoute] Guid itemId, [FromQuery] bool? webgl)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;

            // The item is resolved BEFORE the case's own master switch,
            // because Poster size needs the item's kind and is independent of
            // the case (see ResolvePosterSize). It is looked up only when at
            // least one of the two features is on.
            var item = (config.CaseModEnabled || config.CaseModPosterSizeEnabled)
                ? _libraryManager.GetItemById(itemId)
                : null;
            // A Playnite Bridge game is not in the library (item null); it
            // gets the Games values instead of falling into the Videos catch-all.
            var isGame = item is null && config.CaseModPosterSizeEnabled && Helpers.PlayniteBridgeLink.IsGame(itemId);
            // With "Settings From: Playnite Bridge" the game keeps Jellyfin's own poster size.
            var gameStoodDown = isGame && !Helpers.PlayniteBridgeLink.DrawsGames;
            var posterSize = gameStoodDown ? 100 : ResolvePosterSize(config, item, isGame);
            var posterAnchor = gameStoodDown ? "Default" : ResolvePosterAnchor(config, item, isGame);

            if (!config.CaseModEnabled)
            {
                return Ok(new CaseModInfoResult { IsApplicable = false, PosterSizePercent = posterSize, PosterSizeAnchor = posterAnchor });
            }

            if (item is null)
            {
                return Ok(new CaseModInfoResult { IsApplicable = false, PosterSizePercent = posterSize, PosterSizeAnchor = posterAnchor });
            }

            // The Case mix, a layer on top. Null when it does not apply, and
            // then everything below behaves as without it. The page says
            // whether it can draw WebGL (a browser without it never gets
            // Three.js); a page that does not say is taken as able.
            var draw = CaseMixConfig.DrawFor(config, item, webgl ?? true);
            if (draw?.Outcome == "nocase")
            {
                // No case: the poster may be shown larger so the page does not
                // look small beside the cases around it. The page applies
                // PosterSizePercent/Anchor on every answer, not-applicable included.
                var kind = CaseMixConfig.KindOf(item) ?? string.Empty;
                var (noCasePct, noCaseAnchor) = CaseMix.NoCaseSize(draw, kind, posterSize, posterAnchor, CaseMixConfig.From(config));
                return Ok(new CaseModInfoResult { IsApplicable = false, PosterSizePercent = noCasePct, PosterSizeAnchor = ValidAnchors.Contains(noCaseAnchor) ? noCaseAnchor : posterAnchor });
            }

            // The case type, read ONCE: the drawn flat type, or else the one
            // Case type of the settings (also when Three.js was drawn - the
            // flat answer is then only the page's fallback). Everything below
            // - texture, box, inside, disc, hub, colour, tilt - follows this
            // variable; a second read of the setting would give a drawn case
            // the right texture with the wrong geometry.
            var caseType = draw is not null && draw.Outcome != "threejs" ? draw.Outcome : config.CaseModType;

            string textureKey;

            // Scope: Movies, BoxSets (collections) and Series at the MAIN
            // level only, never Season/Episode. A Season/Episode item is
            // neither, so it falls through to the final "not applicable"
            // branch below without its own check.
            if (item is BoxSet)
            {
                if (!config.CaseModShowOnSets)
                {
                    return Ok(new CaseModInfoResult { IsApplicable = false, PosterSizePercent = posterSize, PosterSizeAnchor = posterAnchor });
                }

                // Sets have no video file to read a resolution/VideoType
                // from, so they get the generic "p" texture. Exception: Viva
                // Elite 3D Case has its own Set artwork (set.png/back_set.png/
                // reflect_back_set.png, from the same Aeon MQ Kodi skin as the
                // other categories).
                textureKey = caseType == "vivaelite3dcases" ? "set" : "p";
            }
            else if (item is Series)
            {
                if (!config.CaseModShowOnTvShows)
                {
                    return Ok(new CaseModInfoResult { IsApplicable = false, PosterSizePercent = posterSize, PosterSizeAnchor = posterAnchor });
                }

                // Same reasoning as BoxSet above - Series itself has no
                // video file; always tvseries.png regardless of any
                // episode's own resolution.
                textureKey = "tvseries";
            }
            else if (item is Movie movie)
            {
                if (!config.CaseModShowOnMovies)
                {
                    return Ok(new CaseModInfoResult { IsApplicable = false, PosterSizePercent = posterSize, PosterSizeAnchor = posterAnchor });
                }

                textureKey = ResolveMovieTextureKey(movie);
            }
            else
            {
                return Ok(new CaseModInfoResult { IsApplicable = false, PosterSizePercent = posterSize, PosterSizeAnchor = posterAnchor });
            }

            // Box geometry per case type, from the type's tune settings
            // (greyed in the admin menu while another type is selected).
            // Tuned by eye against the real poster on .layout-desktop.
            // Units: Top = vw OFFSET on the poster's -80% base (independent
            // of the poster's height), Left = %, Width/Height = vw. If the
            // case texture PNGs are regenerated, resized or re-cropped, the
            // values must be re-tuned.
            var (top, left, widthVw, heightVw) = caseType switch
            {
                "clearcases" => (config.ClearCaseTuneTop, config.ClearCaseTuneLeft, config.ClearCaseTuneWidth, config.ClearCaseTuneHeight),
                "vortexcases" => (config.VortexCaseTuneTop, config.VortexCaseTuneLeft, config.VortexCaseTuneWidth, config.VortexCaseTuneHeight),
                "vivaelite3dcases" => (config.CaseMod3DTuneTop, config.CaseMod3DTuneLeft, config.CaseMod3DTuneWidth, config.CaseMod3DTuneHeight),
                _ => (config.VivaEliteCaseTuneTop, config.VivaEliteCaseTuneLeft, config.VivaEliteCaseTuneWidth, config.VivaEliteCaseTuneHeight)
            };

            // The 3D Case's Set artwork needs its own width.
            if (item is BoxSet && caseType == "vivaelite3dcases")
            {
                widthVw = config.CaseMod3DTuneWidthSets;
            }

            // Disc geometry per case type, from the type's tune settings.
            // Units match the Case box: Top = vw offset on the poster's -80%
            // base, Left = %, Size = vw (single value, the disc is round).
            var (discTop, discLeft, discSize) = caseType switch
            {
                "clearcases" => (config.ClearCaseTuneDiscTop, config.ClearCaseTuneDiscLeft, config.ClearCaseTuneDiscSize),
                "vortexcases" => (config.VortexCaseTuneDiscTop, config.VortexCaseTuneDiscLeft, config.VortexCaseTuneDiscSize),
                "vivaelite3dcases" => (config.CaseMod3DTuneDiscTop, config.CaseMod3DTuneDiscLeft, config.CaseMod3DTuneDiscSize),
                _ => (config.VivaEliteCaseTuneDiscTop, config.VivaEliteCaseTuneDiscLeft, config.VivaEliteCaseTuneDiscSize)
            };

            // The inside box is per case type: each type has its own inside
            // graphic, pre-distorted so its ring is round at ITS box's
            // stretch, so a shared box would make the other rings oval.
            var (innerTop, innerLeft, innerWidth, innerHeight) = caseType switch
            {
                "clearcases" => (config.ClearCaseTuneInnerTop, config.ClearCaseTuneInnerLeft,
                                 config.ClearCaseTuneInnerWidth, config.ClearCaseTuneInnerHeight),
                "vortexcases" => (config.VortexCaseTuneInnerTop, config.VortexCaseTuneInnerLeft,
                                  config.VortexCaseTuneInnerWidth, config.VortexCaseTuneInnerHeight),
                "vivaelite3dcases" => (config.CaseMod3DTuneInnerTop, config.CaseMod3DTuneInnerLeft,
                                       config.CaseMod3DTuneInnerWidth, config.CaseMod3DTuneInnerHeight),
                _ => (config.VivaEliteCaseTuneInnerTop, config.VivaEliteCaseTuneInnerLeft,
                      config.VivaEliteCaseTuneInnerWidth, config.VivaEliteCaseTuneInnerHeight)
            };

            var devTools = config.CaseModDeveloperSettingsEnabled;

            // The colour mode is per case type (all four flat types have
            // colour layers); a drawn case brings its own mode and blend.
            var colorMode = caseType switch
            {
                "clearcases" => config.ClearCaseColorMode,
                "vortexcases" => config.VortexCaseColorMode,
                "vivaelitecases" => config.VivaEliteCaseColorMode,
                "vivaelite3dcases" => config.VivaElite3dCaseColorMode,
                _ => "Original"
            };
            if (draw?.ColorMode is not null) { colorMode = draw.ColorMode; }
            // Anything but FullShell is Original.
            colorMode = colorMode is "FullShell" ? "FullShell" : "Original";
            var colorBlend = draw?.Blend ?? config.CaseModColorBlend;

            // The hub decal, same three units as the disc.
            var (hubTop, hubLeft, hubSize) = caseType switch
            {
                "clearcases" => (config.ClearCaseTuneHubTop, config.ClearCaseTuneHubLeft, config.ClearCaseTuneHubSize),
                "vortexcases" => (config.VortexCaseTuneHubTop, config.VortexCaseTuneHubLeft, config.VortexCaseTuneHubSize),
                "vivaelite3dcases" => (config.CaseMod3DTuneHubTop, config.CaseMod3DTuneHubLeft, config.CaseMod3DTuneHubSize),
                _ => (config.VivaEliteCaseTuneHubTop, config.VivaEliteCaseTuneHubLeft, config.VivaEliteCaseTuneHubSize)
            };

            // Clamp to the admin field's range 0..180 (0 is legal: the case
            // stays shut). The admin UI's min/max only constrains the input
            // widget, not a value that is already saved or edited by hand.
            var openAngle = Math.Clamp(config.CaseMod2DOpenAngleDegrees, 0, 180);

            // Same idea as openAngle above: anything but the two real
            // options must not reach the client.
            var spinDirection = config.CaseMod2DSpinDirection == "Right" ? "Right" : "Left";

            return Ok(new CaseModInfoResult
            {
                IsApplicable = true,
                PosterSizePercent = posterSize,
                PosterSizeAnchor = posterAnchor,
                CaseType = caseType,
                TextureVersion = TextureVersionToken(),
                TextureKey = textureKey,
                BackTextureKey = "back_" + textureKey,
                OpenAutomatic = config.CaseMod2DOpenAutomatic,
                OpenDelayMs = config.CaseMod2DOpenDelayMs,
                OpenOnClick = config.CaseMod2DOpenOnClick,
                OpenOnClickAutomatic = config.CaseMod2DOpenOnClickAutomatic,
                // ImageType.Disc, index 0 - covers every source
                // (local disc/cdart/discart file or remote provider);
                // see BaseItem.HasImage() in the 10.10.7 server source.
                HasDiscart = item.HasImage(ImageType.Disc, 0),
                OpenAngleDegrees = openAngle,
                SpinAutomatic = config.CaseMod2DSpinAutomatic,
                SpinOnClickAutomatic = config.CaseMod2DSpinOnClickAutomatic,
                SpinOnClick = config.CaseMod2DSpinOnClick,
                SpinDirection = spinDirection,
                TopPercent = top,
                LeftPercent = left,
                WidthVw = widthVw,
                HeightVw = heightVw,
                DiscTopPercent = discTop,
                DiscLeftPercent = discLeft,
                DiscSizeVw = discSize,
                // Only relevant for vivaelite3dcases - 0 (no effect) for
                // every other case type, so a saved value never leaks into
                // the other case types.
                CaseAngleDegrees = caseType == "vivaelite3dcases"
                    ? Math.Clamp(config.CaseModCaseAngle, -90, 90) // the admin field's range (both directions)
                    : 0,
                InnerCaseTopPercent = innerTop,
                InnerCaseLeftPercent = innerLeft,
                InnerCaseWidthVw = innerWidth,
                InnerCaseHeightVw = innerHeight,
                HubTopPercent = hubTop,
                HubLeftPercent = hubLeft,
                HubSizeVw = hubSize,
                // The preview switches keep their saved state but only
                // reach the client while Developer settings is on: turning
                // Developer settings off turns all of them off at once, and
                // the saved ticks are still there when it goes on again.
                TuneHidePoster = devTools && config.CaseMod3DTuneHidePoster,
                TuneHideFrontCase = devTools && config.CaseMod3DTuneHideFrontCase,
                TuneHideDisc = devTools && config.CaseMod3DTuneHideDisc,
                TuneHideHub = devTools && config.CaseMod3DTuneHideHub,
                ColorMode = colorMode,
                ColorBlend = ValidColorBlends.Contains(colorBlend) ? colorBlend : "DominantDark"
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CaseMod: Unexpected error in GetInfo for {ItemId}", itemId);
            // 100, not the resolved size: `posterSize` lives inside the try,
            // and on an unexpected error leaving the poster untouched is the
            // right answer anyway.
            return Ok(new CaseModInfoResult { IsApplicable = false });
        }
    }

    /// <summary>
    /// The newest write time anywhere under CaseTextures, as a short token.
    /// Computed once per process: the textures are shipped with the build, so
    /// they cannot change while the server runs - an update restarts it.
    /// Failure is not an error here; an empty token simply means the URLs
    /// carry no ?v= parameter.
    /// </summary>
    private static string? _textureVersion;

    private static string TextureVersionToken()
    {
        if (_textureVersion is not null)
        {
            return _textureVersion;
        }

        var token = string.Empty;
        try
        {
            var dir = Path.Combine(
                Path.GetDirectoryName(typeof(CaseModController).Assembly.Location) ?? string.Empty,
                "CaseTextures");
            if (Directory.Exists(dir))
            {
                var newest = Directory.EnumerateFiles(dir, "*.png", SearchOption.AllDirectories)
                    .Select(f => System.IO.File.GetLastWriteTimeUtc(f))
                    .DefaultIfEmpty(DateTime.MinValue)
                    .Max();
                if (newest > DateTime.MinValue)
                {
                    token = newest.Ticks.ToString("x", CultureInfo.InvariantCulture);
                }
            }
        }
        catch (Exception)
        {
            token = string.Empty;
        }

        _textureVersion = token;
        return token;
    }

    /// <summary>
    /// GET /CaseMod/Texture/{caseType}/{key} - the actual PNG bytes,
    /// read directly from CaseTextures/{caseType}/{key}.png next to this
    /// plugin's DLL. They are Content in ArtworkPlus.csproj, not an
    /// EmbeddedResource: normal build output that lands there on every
    /// install or update, without increasing the DLL size.
    /// </summary>
    [HttpGet("Texture/{caseType}/{key}")]
    public ActionResult GetTexture([FromRoute] string caseType, [FromRoute] string key)
    {
        try
        {
            if (!ValidCaseTypes.Contains(caseType) || !IsValidTextureKey(key))
            {
                return BadRequest();
            }

            var assemblyDir = Path.GetDirectoryName(Plugin.Instance!.AssemblyFilePath);
            if (string.IsNullOrEmpty(assemblyDir))
            {
                _logger.LogError("CaseMod: Could not determine assembly directory");
                return StatusCode(StatusCodes.Status500InternalServerError);
            }

            // The four colour layers live one folder down, in
            // CaseTextures/<type>/color/, so the originals (drawn while Case
            // color is "Original") sit directly in the type's folder. The
            // KEY does not change, so clients do not know about this.
            var layerFolder = TextureLayerSuffixes.Any(sfx => key.EndsWith(sfx, StringComparison.Ordinal))
                ? "color" : string.Empty;
            var texturePath = Path.Combine(assemblyDir, "CaseTextures", caseType, layerFolder, key + ".png");

            if (!System.IO.File.Exists(texturePath))
            {
                _logger.LogWarning("CaseMod: Texture not found at \"{Path}\"", texturePath);
                return NotFound();
            }

            // Long, immutable cache: the client appends ?v=<TextureVersion>
            // to every texture URL, so a changed file is a changed ADDRESS
            // and the promise below only covers bytes that cannot change.
            Response.Headers.CacheControl = "public, max-age=2592000, immutable";

            // Opened here, inside the try: a PhysicalFile result opens the
            // file only when it executes, outside the catch.
            return File(System.IO.File.OpenRead(texturePath), "image/png");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CaseMod: Unexpected error in GetTexture for {CaseType}/{Key}", caseType, key);
            return StatusCode(StatusCodes.Status500InternalServerError);
        }
    }

    /// <summary>
    /// Replica of MediaStream.GetResolutionText()'s bucketing logic
    /// (MediaBrowser.Model.Entities.MediaStream; marked `internal`, so it is
    /// reimplemented here). A "fits within" ceiling system: the smallest tier
    /// whose width AND height bounds are not exceeded wins, so 558p falls into
    /// the 576p tier, not 540p.
    ///
    /// Collapsed onto the tiers this plugin has textures for: anything below
    /// the 480p bounds lands on 480p, anything above 1080p (including 4K/8K)
    /// lands on 4k.
    /// </summary>
    private static string ResolveMovieTextureKey(Movie movie)
    {
        // 3D takes priority over resolution: it has its own spine design
        // regardless of the video's resolution.
        if (movie.Is3D)
        {
            return "3d";
        }

        // ISO: resolution cannot be read as reliably as from a real
        // Dvd/BluRay folder structure. Rather than risk a wrong badge, ISO
        // always gets the same generic texture as Sets.
        if (movie.VideoType == VideoType.Iso)
        {
            return "p";
        }

        var videoStream = movie.GetMediaStreams()
            .FirstOrDefault(s => s.Type == MediaStreamType.Video);

        if (videoStream?.Width is null || videoStream.Height is null)
        {
            // No resolution info at all yet (not probed, or probing
            // failed) - same generic fallback as ISO/Sets above, for the
            // same reason: an uncertain badge is worse than a neutral
            // one.
            return "p";
        }

        var width = videoStream.Width.Value;
        var height = videoStream.Height.Value;

        if (width <= 854 && height <= 480)
        {
            return "480p";
        }

        if (width <= 960 && height <= 544)
        {
            return "540p";
        }

        if (width <= 1024 && height <= 576)
        {
            return "576p";
        }

        if (width <= 1280 && height <= 962)
        {
            return "720p";
        }

        if (width <= 2560 && height <= 1440)
        {
            return "1080p";
        }

        return "4k";
    }
}
