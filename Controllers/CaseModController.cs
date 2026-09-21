using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Result DTO for the Case (Case Mod tab) "which texture, positioned
/// how" decision. Deliberately separate from the actual image bytes
/// (see GetTexture() below) - the client fetches this once per
/// navigation, then builds an absolutely-positioned &lt;img&gt; pointing
/// at the second endpoint, exactly the same two-step shape as every
/// other poster feature in this plugin (quickcheck/list, then image).
/// </summary>
public class CaseModInfoResult
{
    public bool IsApplicable { get; set; }

    /// <summary>
    /// First trigger: automatic delay-after-page-load (see
    /// PluginConfiguration.CaseModOpenCaseDelayEnabled's own doc
    /// comment). SESSION 18: the old separate "Enable Open Case" master
    /// switch (and this field's own former sibling, OpenCaseEnabled) is
    /// gone - the client now considers Open Case active whenever EITHER
    /// this OR OpenCaseOnClickEnabled below is true, with no extra gate
    /// in between.
    /// </summary>
    public bool OpenCaseDelayEnabled { get; set; }

    /// <summary>The delay itself (ms), admin-adjustable.</summary>
    public double OpenCaseDelayMs { get; set; }

    /// <summary>
    /// Second trigger: clicking the poster itself opens the case (see
    /// PluginConfiguration.CaseModOpenCaseOnClickEnabled's own doc
    /// comment).
    /// </summary>
    public bool OpenCaseOnClickEnabled { get; set; }

    /// <summary>"vivaelitecases", "clearcases", or "vortexcases".</summary>
    public string CaseType { get; set; } = string.Empty;

    /// <summary>
    /// File name (without extension) inside CaseTextures/{CaseType}/ -
    /// one of: 480p, 540p, 576p, 720p, 1080p, 4k, 3d, p, tvseries.
    /// </summary>
    public string TextureKey { get; set; } = string.Empty;

    /// <summary>
    /// Back-cover texture key ("back_" + TextureKey) - reintroduced
    /// (was removed while the front's own geometry was being re-tuned
    /// with the direct Top/Left/Width/Height fields; that tuning is
    /// done and the values are locked in as C# defaults now). The back
    /// box reuses the front's exact same geometry values - a real
    /// case's front and back cover share the same physical outer
    /// dimensions, so there is no separate back-specific geometry.
    /// Layering (explicit user request): back case BEHIND the real
    /// poster card (z-index 2, under the card's own z-index 3 from
    /// Jellyfin's librarybrowser.scss), front case above it (z-index
    /// 4) - three layers total: back / poster / front.
    /// </summary>
    public string BackTextureKey { get; set; } = string.Empty;

    /// <summary>
    /// Whether this item has a Disc image (Jellyfin-native
    /// ImageType.Disc - locally sourced from "disc"/"cdart"/"discart"
    /// files per LocalImageProvider.cs, or from any remote provider).
    /// The Open Case animation, AND the disc rendering itself, both run
    /// only when Open Case is enabled in the admin UI AND a discart
    /// exists for the item (explicit user requirement) - without one
    /// the case stays fully static and no disc is drawn. Session 12:
    /// the disc is now actually rendered (previously only this gating
    /// boolean existed) - fetched the standard Jellyfin way, directly
    /// via /Items/{itemId}/Images/Disc (verified against
    /// Jellyfin.Api's own ImageController.GetItemImage - no
    /// [Authorize] on that route, same mechanism every other native
    /// poster/backdrop/logo <img> already uses), no separate server
    /// endpoint needed here.
    /// </summary>
    public bool HasDiscart { get; set; }

    /// <summary>
    /// How far the front cover swings open (degrees) - see
    /// PluginConfiguration.CaseModOpenAngleDegrees's own doc comment
    /// for the full reasoning. Clamped to [1, 180] here defensively.
    /// </summary>
    public double OpenAngleDegrees { get; set; }

    /// <summary>
    /// Whether the Disc's SpinningDisc effect (continuous rotation, own
    /// axis, independent of the Open Case hinge animation - explicit
    /// user correction: "nein, nur die disc dreht sich" referring to
    /// spin specifically, not the hinge-opening motion) should run.
    /// Only meaningful when the disc itself is being rendered at all
    /// (Open Case active && HasDiscart).
    /// </summary>
    public bool SpinningDiscEnabled { get; set; }

    /// <summary>
    /// SESSION 18, new field: direction the Disc spins in, "Left" or
    /// "Right" - see PluginConfiguration.CaseModSpinningDirection's own
    /// doc comment.
    /// </summary>
    public string SpinningDirection { get; set; } = "Left";

    /// <summary>
    /// The box's own literal desktop-layout position/size - direct,
    /// absolute geometry instead of a relative Offset/Width/Height/
    /// Size multiplier system (explicit user correction; relative
    /// multipliers could never actually solve "box exactly matches the
    /// visible case artwork" - see the curriculum for the proof). The
    /// values themselves are hardcoded per case type in GetInfo()
    /// below (explicit user request), no longer config-driven.
    /// CaseModModule's own client-side code derives the mobile/tv
    /// equivalents from how these compare to the shared desktop base.
    /// </summary>
    public double TopPercent { get; set; }

    public double LeftPercent { get; set; }

    public double WidthVw { get; set; }

    public double HeightVw { get; set; }

    /// <summary>
    /// Disc geometry - same unit conventions as the Case box above
    /// (Top = vw offset from the poster's own -80% base, Left = %), but
    /// only ONE size value instead of Width/Height (explicit user
    /// correction: a disc is circular/1:1, so it gets used as BOTH
    /// width and height with no independent stretch, unlike the
    /// rectangular case box). SESSION 18: hardcoded per case type in
    /// GetInfo() below (explicit user request, measured values
    /// provided), same lifecycle/pattern as the Case box geometry
    /// above - no longer config-driven, no more admin tuning tool.
    /// </summary>
    public double DiscTopPercent { get; set; }

    public double DiscLeftPercent { get; set; }

    public double DiscSizeVw { get; set; }

    /// <summary>
    /// Session 42/43: fixed perspective tilt angle for "Viva Elite 3D
    /// Case" - 0 for every other case type (no effect, stays flat). The
    /// sign determines the hinge side on the client.
    /// </summary>
    public double CaseAngleDegrees { get; set; }

    /// <summary>Inner-case geometry (only relevant for Viva Elite 3D Case) - the graphic is reused 1:1 from vivaelitecases, only its own position/size.</summary>
    public double InnerCaseTopPercent { get; set; }
    public double InnerCaseLeftPercent { get; set; }
    public double InnerCaseWidthVw { get; set; }
    public double InnerCaseHeightVw { get; set; }

    /// <summary>TEMPORAER - reine Admin-Vorschau-Schalter zum Einmessen, siehe PluginConfiguration's eigene Doc-Kommentare.</summary>
    public bool TuneHidePoster { get; set; }
    public bool TuneShowInnerCase { get; set; }
    public bool TuneShowDisc { get; set; }
}

/// <summary>
/// Curriculum: "boxes.zip" concept session. Serves the physical
/// disc-case overlay (the "Case" tab) - which texture applies to a
/// given item, at what position/size (both driven by
/// PluginConfiguration, see its own Case tab section for the full
/// reasoning), and the actual PNG bytes. Gated by CaseModEnabled
/// (General tab) alone - Session 37 removed the former,
/// single-sub-feature-redundant CaseModCaseEnabled sub-switch. Front
/// side only,
/// detail pages only (Movie/BoxSet/Series-main) - this first version
/// applies unconditionally over whatever is currently in the poster
/// slot (explicit user decision, no Extraposter/Keyart
/// winner-awareness yet). The client side of this feature lives inside
/// Jellyfin-ArtworkPlus-Posters-v1.js's own CaseModModule (explicit
/// user request: no separate feature script for this one) - this
/// controller therefore has no GetScript() endpoint of its own, unlike
/// every other feature controller in this plugin.
/// </summary>
[ApiController]
[Route("CaseMod")]
// No authorization attribute on purpose-by-convention (audit 2026-09, S1-05):
// both routes are read by <img>/fetch without a token, and Jellyfin 10.10.7
// has no fallback authorization policy, so an attribute-less action is
// anonymous - the same state [AllowAnonymous] would declare explicitly.
public class CaseModController : ControllerBase
{
    /// <summary>
    /// Allowlist for the "caseType"/"key" URL segments in GetTexture() -
    /// both end up in a filesystem Path.Combine() call, so an unchecked
    /// value would be a path-traversal risk (e.g. "../../../etc/passwd"
    /// as "key") even though these normally only ever come from our own
    /// GetInfo() response and admin-configured CaseModType.
    /// </summary>
    private static readonly HashSet<string> ValidCaseTypes = new(StringComparer.Ordinal)
    {
        "vivaelitecases", "clearcases", "vortexcases", "vivaelite3dcases"
    };

    private static readonly HashSet<string> ValidTextureKeys = new(StringComparer.Ordinal)
    {
        "480p", "540p", "576p", "720p", "1080p", "4k", "3d", "p", "tvseries",
        // Back-cover counterparts (explicit user request: "hinter das
        // poster, die jeweilige Rückseite der cases") - same resolution
        // keys, "back_" prefix, same folder as the front ones.
        "back_480p", "back_540p", "back_576p", "back_720p", "back_1080p",
        "back_4k", "back_3d", "back_p", "back_tvseries",
        // Session 48: "set" - an own category only for vivaelite3dcases
        // (see the ResolveMovieTextureKey/BoxSet branch below); for the
        // other three case types Set stays at "p" (unchanged, no own set
        // artwork exists there).
        "set", "back_set"
    };

    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<CaseModController> _logger;

    public CaseModController(ILibraryManager libraryManager, ILogger<CaseModController> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
    }

    /// <summary>
    /// GET /CaseMod/{itemId} - resolves whether the case overlay
    /// applies to this item, and if so, which texture and at what
    /// position/size.
    /// </summary>
    [HttpGet("{itemId}")]
    public ActionResult<CaseModInfoResult> GetInfo([FromRoute] Guid itemId)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;

            if (!config.CaseModEnabled)
            {
                return Ok(new CaseModInfoResult { IsApplicable = false });
            }

            var item = _libraryManager.GetItemById(itemId);
            if (item is null)
            {
                return Ok(new CaseModInfoResult { IsApplicable = false });
            }

            string textureKey;

            // Explicit user scope: Movies, BoxSets(=Collections), and
            // Series at the MAIN level only - never Season/Episode. A
            // Season/Episode item is neither a BoxSet nor a Series nor a
            // Movie, so it already falls through to the final "not
            // applicable" branch below without needing its own check.
            if (item is BoxSet)
            {
                if (!config.CaseModShowOnSets)
                {
                    return Ok(new CaseModInfoResult { IsApplicable = false });
                }

                // Sets have no video file of their own to read a
                // resolution/VideoType from - always the same generic
                // texture, matching the user's own explicit plan
                // ("sets, iso, und fallback ist p.png").
                //
                // Session 48 EXCEPTION (explicit user request): Viva
                // Elite 3D Case has its OWN dedicated Set artwork
                // (set.png/back_set.png/reflect_back_set.png, borrowed
                // from the same Aeon-MQ Kodi skin as the other 8
                // categories) - only for THIS case type, Set gets its
                // own key instead of falling back to "p". The other
                // three case types have no Set-specific art at all and
                // keep using "p" exactly as before, unchanged.
                textureKey = config.CaseModType == "vivaelite3dcases" ? "set" : "p";
            }
            else if (item is Series)
            {
                if (!config.CaseModShowOnTvShows)
                {
                    return Ok(new CaseModInfoResult { IsApplicable = false });
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
                    return Ok(new CaseModInfoResult { IsApplicable = false });
                }

                textureKey = ResolveMovieTextureKey(movie);
            }
            else
            {
                return Ok(new CaseModInfoResult { IsApplicable = false });
            }

            // 📌 REFERENCE VALUES - DO NOT DELETE - hardcoded per-case-
            // type box geometry (explicit user request: "tue dann die
            // position der 3 cases hart in den code"), from the user's
            // own manual tuning with the (since removed again) admin
            // adjustment tool, tuned by eye against the real poster on
            // .layout-desktop. Deliberately constants here rather than
            // PluginConfiguration defaults - a stored config XML would
            // silently override a default, and with the tool gone such
            // a stale value would be invisible and unfixable from the
            // UI. Units: Top = vw OFFSET on the poster's own -80% base
            // (drift-proof, see the curriculum's Session-10 fix),
            // Left = %, Width/Height = vw. If the case texture PNGs
            // are ever regenerated/resized/re-cropped, these values
            // become invalid and must be re-tuned with a re-added tool
            // (see the curriculum's own REFERENCE TECHNIQUE entry).
            var (top, left, widthVw, heightVw) = config.CaseModType switch
            {
                // Session 47: all four case types now read from their
                // own tune fields instead of a hard-wired value - the
                // defaults match exactly what used to stand here (see
                // PluginConfiguration.cs's own doc comments). Hidden
                // instead of removed (policy, Session 45) - the fields
                // stay in the admin menu, only greyed when another type
                // is selected.
                "clearcases" => (config.ClearCaseTuneTop, config.ClearCaseTuneLeft, config.ClearCaseTuneWidth, config.ClearCaseTuneHeight),
                "vortexcases" => (config.VortexCaseTuneTop, config.VortexCaseTuneLeft, config.VortexCaseTuneWidth, config.VortexCaseTuneHeight),
                "vivaelite3dcases" => (config.CaseMod3DTuneTop, config.CaseMod3DTuneLeft, config.CaseMod3DTuneWidth, config.CaseMod3DTuneHeight),
                _ => (config.VivaEliteCaseTuneTop, config.VivaEliteCaseTuneLeft, config.VivaEliteCaseTuneWidth, config.VivaEliteCaseTuneHeight)
            };

            // Session 121: the 3D Case's own Set artwork needs its own width
            // (user finding: "kleiner Ausreißer, nur case width, nur Sets").
            if (item is BoxSet && config.CaseModType == "vivaelite3dcases")
            {
                widthVw = config.CaseMod3DTuneWidthSets;
            }

            // 📌 REFERENCE VALUES - DO NOT DELETE - hardcoded per-case-
            // type disc geometry (Session 18, explicit user request:
            // "tue dann das hardcoden" - measured values provided by
            // the user). Same lifecycle/pattern as the Case box
            // geometry above: constants here rather than
            // PluginConfiguration defaults, so a stale saved config
            // value can never silently override them. Units match the
            // Case box: Top = vw offset on the poster's own -80% base,
            // Left = %, Size = vw (single value, disc is 1:1 - no
            // independent stretch).
            var (discTop, discLeft, discSize) = config.CaseModType switch
            {
                // Session 47: siehe Kommentar bei der Case-Box-
                // Geometrie oben - gleiches Muster.
                "clearcases" => (config.ClearCaseTuneDiscTop, config.ClearCaseTuneDiscLeft, config.ClearCaseTuneDiscSize),
                "vortexcases" => (config.VortexCaseTuneDiscTop, config.VortexCaseTuneDiscLeft, config.VortexCaseTuneDiscSize),
                "vivaelite3dcases" => (config.CaseMod3DTuneDiscTop, config.CaseMod3DTuneDiscLeft, config.CaseMod3DTuneDiscSize),
                _ => (config.VivaEliteCaseTuneDiscTop, config.VivaEliteCaseTuneDiscLeft, config.VivaEliteCaseTuneDiscSize)
            };

            // Defensive clamp - a stale/manually-edited config value
            // outside [1, 180] would otherwise reach the client
            // unfiltered (the admin UI's own min/max only constrains
            // the input widget, not what could already be saved).
            var openAngle = Math.Clamp(config.CaseModOpenAngleDegrees, 1, 180);

            // Same defensive idea as openAngle above - a stale/manually
            // edited config value outside the two real options would
            // otherwise reach the client unfiltered.
            var spinDirection = config.CaseModSpinningDirection == "Right" ? "Right" : "Left";

            return Ok(new CaseModInfoResult
            {
                IsApplicable = true,
                CaseType = config.CaseModType,
                TextureKey = textureKey,
                BackTextureKey = "back_" + textureKey,
                OpenCaseDelayEnabled = config.CaseModOpenCaseDelayEnabled,
                OpenCaseDelayMs = config.CaseModOpenCaseDelayMs,
                OpenCaseOnClickEnabled = config.CaseModOpenCaseOnClickEnabled,
                // ImageType.Disc, index 0 - covers every source
                // (local disc/cdart/discart file or remote provider),
                // verified against BaseItem.HasImage()'s own signature
                // in the real 10.10.7 server source.
                HasDiscart = item.HasImage(ImageType.Disc, 0),
                OpenAngleDegrees = openAngle,
                SpinningDiscEnabled = config.CaseModSpinningDiscEnabled,
                SpinningDirection = spinDirection,
                TopPercent = top,
                LeftPercent = left,
                WidthVw = widthVw,
                HeightVw = heightVw,
                DiscTopPercent = discTop,
                DiscLeftPercent = discLeft,
                DiscSizeVw = discSize,
                // Session 43: only relevant for vivaelite3dcases - 0 (no
                // effect) for every other case type, so an accidentally
                // saved value can never leak into the other three case
                // types.
                CaseAngleDegrees = config.CaseModType == "vivaelite3dcases"
                    ? Math.Clamp(config.CaseModCaseAngle, -10, 0)
                    : 0,
                InnerCaseTopPercent = config.CaseMod3DTuneInnerTop,
                InnerCaseLeftPercent = config.CaseMod3DTuneInnerLeft,
                InnerCaseWidthVw = config.CaseMod3DTuneInnerWidth,
                InnerCaseHeightVw = config.CaseMod3DTuneInnerHeight,
                TuneHidePoster = config.CaseMod3DTuneHidePoster,
                TuneShowInnerCase = config.CaseMod3DTuneShowInnerCase,
                TuneShowDisc = config.CaseMod3DTuneShowDisc
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CaseMod: Unexpected error in GetInfo for {ItemId}", itemId);
            return Ok(new CaseModInfoResult { IsApplicable = false });
        }
    }

    /// <summary>
    /// GET /CaseMod/Texture/{caseType}/{key} - the actual PNG bytes,
    /// read directly from CaseTextures/{caseType}/{key}.png next to this
    /// plugin's own DLL (see ArtworkPlus.csproj's own Content-Include
    /// entry and reasoning: normal build output, not an EmbeddedResource
    /// - lands there automatically on every install/update, no manual
    /// copy step, no DLL size increase, no resource-name-prediction risk
    /// unlike Core.js's own embedded approach).
    /// </summary>
    [HttpGet("Texture/{caseType}/{key}")]
    public ActionResult GetTexture([FromRoute] string caseType, [FromRoute] string key)
    {
        try
        {
            if (!ValidCaseTypes.Contains(caseType) || !ValidTextureKeys.Contains(key))
            {
                return BadRequest();
            }

            var assemblyDir = Path.GetDirectoryName(Plugin.Instance!.AssemblyFilePath);
            if (string.IsNullOrEmpty(assemblyDir))
            {
                _logger.LogError("CaseMod: Could not determine assembly directory");
                return StatusCode(StatusCodes.Status500InternalServerError);
            }

            var texturePath = Path.Combine(assemblyDir, "CaseTextures", caseType, key + ".png");

            if (!System.IO.File.Exists(texturePath))
            {
                _logger.LogWarning("CaseMod: Texture not found at \"{Path}\"", texturePath);
                return NotFound();
            }

            // Static, versioned asset - shipped as part of the plugin
            // build itself, changes only when the plugin itself updates.
            // Long, immutable cache: once a client has it, never ask
            // again until a genuinely new plugin version changes the
            // underlying file.
            Response.Headers.CacheControl = "public, max-age=2592000, immutable";

            // Audit S1-04b (Session 138): opened here, inside the try - a PhysicalFile
            // result opens the file only when it executes, outside the catch.
            return File(System.IO.File.OpenRead(texturePath), "image/png");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CaseMod: Unexpected error in GetTexture for {CaseType}/{Key}", caseType, key);
            return StatusCode(StatusCodes.Status500InternalServerError);
        }
    }

    /// <summary>
    /// 1:1 replica of MediaStream.GetResolutionText()'s own official
    /// bucketing logic (MediaBrowser.Model.Entities.MediaStream - marked
    /// `internal`, not directly callable from this assembly, so
    /// reimplemented here) - a "fits within" ceiling system: the
    /// smallest tier whose own width AND height bounds are not exceeded
    /// wins. NOT a floor/round-down system - an earlier assumption in
    /// this feature's own curriculum milestone (that resolution should
    /// round DOWN, e.g. 558p -> 540p) was corrected once this real,
    /// authoritative server-side implementation was found: 558p actually
    /// falls into the 576p tier by Jellyfin's own official rule.
    ///
    /// Collapsed onto only the tiers this plugin actually has texture
    /// assets for: anything smaller than the official 480p tier's own
    /// bounds still lands on 480p, our lowest available; anything bigger
    /// than 1080p's own bounds (including the official 4K/8K tiers)
    /// lands on 4k, our highest available.
    /// </summary>
    private static string ResolveMovieTextureKey(Movie movie)
    {
        // 3D takes priority over resolution - its own dedicated spine
        // design applies regardless of the underlying video's actual
        // resolution (matches the user's own explicit plan: 3D is its
        // own separate bucket, not combined with a resolution number).
        if (movie.Is3D)
        {
            return "3d";
        }

        // ISO: reliable resolution extraction is not guaranteed the same
        // way it is for a real Dvd/BluRay FOLDER structure (see this
        // project's own earlier Jellyfin-source-code investigation).
        // Rather than risk a wrong badge from an uncertain read, ISO
        // always falls back to the same generic texture as Sets -
        // matches the user's own explicit plan ("sets, iso, und
        // fallback ist p.png").
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
