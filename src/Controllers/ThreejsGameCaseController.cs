using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.ArtworkPlus.Helpers;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Three.js Case Games: the 3D case for Playnite Bridge's virtual games - the Game Disc Case and the
/// Game Box Case. Its own controller and its own settings (CaseModThreejsGames*), independent of the movie
/// case, of CaseModEnabled / CaseModShowOnMovies and of Playnite Bridge's "Settings From". The pictures and the
/// form come from Playnite Bridge's ArtworkPlusLink.GameCase.
///   GET /ThreejsCase/game/{id}                    what to build for one game version (signed-in user)
///   GET /ThreejsCase/game/{id}/image/{part}?tag=  one case picture, anonymous like Jellyfin's image routes,
///                                                 bound to the tag GameCase handed out
/// The answer has the movie answer's shape (GET /ThreejsCase/{itemId}), so the client's mount takes it the
/// same way; the game-specific part is in Game.
/// </summary>
[ApiController]
[Route("ThreejsCase/game")]
[Authorize]
public class ThreejsGameCaseController : ControllerBase
{
    /// <summary>The parts an image request may name; anything else is a 404 without asking Playnite Bridge.</summary>
    private static readonly HashSet<string> Parts = new(StringComparer.Ordinal) { "front", "back", "spine", "disc", "logo" };

    /// <summary>The same ten anchors the movie case accepts.</summary>
    private static readonly HashSet<string> ValidCaseAnchors = new(StringComparer.Ordinal)
    {
        "Default", "TopLeft", "TopCenter", "TopRight", "CenterLeft", "Center", "CenterRight", "BottomLeft", "BottomCenter", "BottomRight"
    };

    /// <summary>Platforms the renderer knows (GAME_SHELL); anything else is drawn as pc.</summary>
    private static readonly HashSet<string> Platforms = new(StringComparer.Ordinal) { "pc", "ps3", "ps4", "ps5", "xbox", "xbox360", "xboxone", "xboxseries" };

    /// <summary>Pictures are scaled down to this height at most: the case never shows them larger on a detail page.</summary>
    private const int MaxPictureHeight = 1024;

    /// <summary>JPEG/WebP quality of the scaled pictures.</summary>
    private const int PictureQuality = 92;

    /// <summary>
    /// Part of every picture URL: the URLs are cached for a year, so a change of the cap or the quality must change the
    /// URL, or browsers keep showing the old rendition.
    /// </summary>
    private static readonly string PictureVersion = MaxPictureHeight.ToString(CultureInfo.InvariantCulture) + "q"
                                                    + PictureQuality.ToString(CultureInfo.InvariantCulture);

    /// <summary>A picture that cannot be served is logged once per file and tag, not on every request.</summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> Logged = new(StringComparer.Ordinal);

    /// <summary>The values the admin page offers; anything else stored falls back to the default.</summary>
    private static string OneOf(string? value, string fallback, params string[] allowed)
        => value is not null && allowed.Contains(value, StringComparer.Ordinal) ? value : fallback;

    private readonly ILogger<ThreejsGameCaseController> _logger;
    private readonly IImageProcessor _imageProcessor;
    private readonly IServerApplicationPaths _appPaths;

    public ThreejsGameCaseController(ILogger<ThreejsGameCaseController> logger, IImageProcessor imageProcessor, IServerApplicationPaths appPaths)
    {
        _logger = logger;
        _imageProcessor = imageProcessor;
        _appPaths = appPaths;
    }

    /// <summary>
    /// GET /ThreejsCase/game/{id} - Enabled=false (with a Reason) for anything that gets no case: the feature off,
    /// not a game, no case from Playnite Bridge (front or back missing, hidden for this user), or the version's
    /// form switched off. The client then keeps the 2D poster.
    /// </summary>
    [HttpGet("{id}")]
    public ActionResult GetGameCase([FromRoute] Guid id)
    {
        try
        {
            var config = Plugin.Instance?.Configuration;
            if (config is null)
            {
                return Ok(new { Enabled = false, Reason = "no configuration" });
            }

            if (!config.CaseModThreejsGamesEnabled)
            {
                return Ok(new { Enabled = false, Reason = "switched off" });
            }

            var claim = User?.FindFirst("Jellyfin-UserId")?.Value;
            if (string.IsNullOrEmpty(claim) || !Guid.TryParse(claim, out var userId))
            {
                return Ok(new { Enabled = false, Reason = "no user" });
            }

            if (!PlayniteBridgeLink.IsGame(id))
            {
                return Ok(new { Enabled = false, Reason = "not a game" });
            }

            var rows = PlayniteBridgeLink.GameCase(id, userId);
            if (rows.Count == 0)
            {
                return Ok(new { Enabled = false, Reason = "no case" });
            }

            string? One(string part) => rows.FirstOrDefault(r => r.Part == part).Value is { Length: > 0 } v ? v : null;
            string[] All(string part) => rows.Where(r => r.Part == part && r.Value.Length > 0).Select(r => r.Value).ToArray();
            string? Picture(string part)
            {
                var row = rows.FirstOrDefault(r => r.Part == part);
                return string.IsNullOrEmpty(row.Value) || string.IsNullOrEmpty(row.Tag)
                    ? null
                    : "/ThreejsCase/game/" + id.ToString("N") + "/image/" + part + "?tag=" + Uri.EscapeDataString(row.Tag)
                      + "&v=" + PictureVersion;
            }

            var box = One("kind") == "box";
            if (box ? !config.CaseModThreejsGamesBox : !config.CaseModThreejsGamesDisc)
            {
                return Ok(new { Enabled = false, Reason = box ? "box switched off" : "disc case switched off" });
            }

            var front = Picture("front");
            var back = Picture("back");
            if (front is null || back is null)
            {
                return Ok(new { Enabled = false, Reason = "no case" });
            }

            var platform = One("platform") is { } p && Platforms.Contains(p) ? p : "pc";
            double? depth = box && double.TryParse(One("depth"), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && d > 0 ? d : null;
            var disc = box ? null : Picture("disc");
            // a box has no booklet
            var booklet = box ? "Off" : OneOf(config.CaseModThreejsGamesBooklet, "Black", "Off", "Black", "BwFanart", "BlurredFanart");

            return Ok(new
            {
                Enabled = true,
                Shell = box ? "gamebox" : "gamedisc",
                Layer = OneOf(config.CaseModThreejsGamesCaseLayer, "BehindText", "BehindText", "InFront"),
                Zoom = new { Enabled = config.CaseModThreejsGamesZoomEnabled, Range = Math.Clamp(config.CaseModThreejsGamesZoomRange, 0, 99) },
                Size = Math.Clamp(config.CaseModThreejsGamesCaseSize, 1, 200),
                Anchor = ValidCaseAnchors.Contains(config.CaseModThreejsGamesCaseAnchor) ? config.CaseModThreejsGamesCaseAnchor : "Default",
                Turn = Math.Clamp(config.CaseModThreejsGamesCaseTurn, 0, 360),
                Tilt = Math.Clamp(config.CaseModThreejsGamesCaseTilt, -90, 90),
                AutoRotate = !string.Equals(config.CaseModThreejsGamesAutoRotateDirection, "Off", StringComparison.OrdinalIgnoreCase),
                AutoRotateDirection = OneOf(config.CaseModThreejsGamesAutoRotateDirection, "Off", "Off", "Left", "Right"),
                RotateSpeed = OneOf(config.CaseModThreejsGamesRotateSpeed, "Medium", "VerySlow", "Slow", "Medium", "Fast", "VeryFast"),
                ResetOnDoubleClick = config.CaseModThreejsGamesResetOnDoubleClick,
                BackCover = config.CaseModThreejsGamesBackCover,
                Booklet = booklet,
                // the disc decides whether the case may open; a box never opens
                HasDisc = disc is not null,
                Open = new
                {
                    Automatic = !box && config.CaseModThreejsGamesOpenAutomatic,
                    OnClickAutomatic = !box && config.CaseModThreejsGamesOpenOnClickAutomatic,
                    OnClick = !box && config.CaseModThreejsGamesOpenOnClick,
                    DelayMs = Math.Clamp(config.CaseModThreejsGamesOpenDelayMs, 0, 60000),
                    AngleDegrees = box ? 0 : Math.Clamp(config.CaseModThreejsGamesOpenAngleDegrees, 0, 180)
                },
                Spin = new
                {
                    Automatic = !box && config.CaseModThreejsGamesSpinAutomatic,
                    OnClickAutomatic = !box && config.CaseModThreejsGamesSpinOnClickAutomatic,
                    OnClick = !box && config.CaseModThreejsGamesSpinOnClick,
                    Direction = OneOf(config.CaseModThreejsGamesSpinDirection, "Left", "Left", "Right")
                },
                Game = new
                {
                    Kind = box ? "box" : "disc",
                    Platform = platform,
                    Source = One("source") ?? string.Empty,
                    Depth = depth,
                    Name = One("name") ?? string.Empty,
                    Publisher = All("publisher"),
                    Developer = All("developer"),
                    ShapeFrom = OneOf(config.CaseModThreejsGamesShapeFrom, "Front", "Front", "Mean", "Back"),
                    BoxSides = OneOf(config.CaseModThreejsGamesBoxSides, "Coloured", "Coloured", "ColouredSpineBlack", "Black"),
                    BoxEdgeMm = Math.Clamp(config.CaseModThreejsGamesBoxEdgeMm, 0, 15),
                    SpineLogo = config.CaseModThreejsGamesSpineLogo,
                    Pictures = new
                    {
                        Front = front,
                        Back = back,
                        Spine = Picture("spine"),
                        Disc = disc,
                        Logo = Picture("logo"),
                        Fanart = booklet is "BwFanart" or "BlurredFanart" ? GameCasePictures.FanartUrl(id, PlayniteBridgeLink.Backdrops(id)) : null
                    }
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ThreejsGameCase: unexpected error for {Id}", id);
            return Ok(new { Enabled = false, Reason = "error" });
        }
    }

    /// <summary>
    /// GET /ThreejsCase/game/{id}/image/{part}?tag= - one case picture. Anonymous because a texture request
    /// (&lt;img&gt;) cannot send auth; the tag handed out by GameCase is the capability, Playnite Bridge checks it.
    /// Scaled down by Jellyfin's image processor to MaxPictureHeight at most (its own cache keeps the result).
    /// A broken or unknown picture is a 404, never a 500.
    /// </summary>
    [HttpGet("{id}/image/{part}")]
    [AllowAnonymous]
    public async Task<ActionResult> GetGameCaseImage([FromRoute] Guid id, [FromRoute] string part, [FromQuery] string? tag)
    {
        if (!Parts.Contains(part) || string.IsNullOrEmpty(tag))
        {
            return BadRequest();
        }

        // Pictures exist only while the feature is on, like the case itself.
        if (Plugin.Instance?.Configuration is not { CaseModThreejsGamesEnabled: true })
        {
            return NotFound();
        }

        var path = PlayniteBridgeLink.GameCasePart(id, part, tag);
        if (string.IsNullOrEmpty(path) || !System.IO.File.Exists(path))
        {
            return NotFound();
        }

        try
        {
            // A JPEG with an EXIF orientation is served upright: Jellyfin's processor turns only photo items, and
            // Playnite Bridge measures a JPEG spine upright too, so both mean the same picture.
            var upright = await GameCasePictures.UprightCopy(path, tag, PictureVersion, part is "logo" or "disc", MaxPictureHeight,
                PictureQuality, Path.Combine(_appPaths.CachePath, GameCasePictures.CacheFolderName)).ConfigureAwait(false);
            if (upright is { } u)
            {
                var uprightStream = System.IO.File.OpenRead(u.Path);
                Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
                Response.Headers.Append("Vary", "Origin");   // a no-CORS copy in the cache must not answer a CORS request
                return File(uprightStream, u.Mime);
            }

            var image = new ItemImageInfo { Path = path, Type = ImageType.Primary, DateModified = System.IO.File.GetLastWriteTimeUtc(path) };
            // A picture whose size cannot be read cannot be decoded either: no case from it. (On a server without an
            // image encoder this is every picture, so it is logged once per start, not per request.)
            ImageDimensions size;
            try
            {
                size = _imageProcessor.GetImageDimensions(path);
            }
            catch (Exception ex)
            {
                if (Logged.TryAdd("dimensions", 0))
                {
                    _logger.LogWarning(ex, "ThreejsGameCase: picture sizes cannot be read on this server - game cases need an image encoder");
                }

                return NotFound();
            }

            image.Width = size.Width;
            image.Height = size.Height;

            // logo and disc carry transparency; the covers do not
            var transparent = part is "logo" or "disc";
            var options = new ImageProcessingOptions
            {
                Image = image,
                MaxHeight = MaxPictureHeight,
                Quality = PictureQuality,
                SupportedOutputFormats = transparent ? new[] { ImageFormat.Webp, ImageFormat.Png } : new[] { ImageFormat.Webp, ImageFormat.Jpg }
            };
            var (resultPath, mime, _) = await _imageProcessor.ProcessImage(options).ConfigureAwait(false);
            // ProcessImage hands back the original when encoding fails. The original may only come back when nothing had
            // to change: not taller than the cap and already in one of the allowed output formats. Otherwise the original
            // means the picture could not be decoded or encoded - a 404, never a cached 200. (A small picture in an output
            // format is passed through undecoded; if its body is broken the browser fails it and the client falls back to
            // the 2D poster. Its URL carries the file's tag, so a repaired file gets a new URL despite the long cache.)
            var ext = Path.GetExtension(path).ToLowerInvariant();
            var originalIsOutput = ext == ".webp" || (transparent ? ext == ".png" : ext is ".jpg" or ".jpeg");
            if ((size.Height > MaxPictureHeight || !originalIsOutput)
                && string.Equals(Path.GetFullPath(resultPath), Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase))
            {
                if (Logged.TryAdd(path + "|" + tag, 0))
                {
                    _logger.LogWarning("ThreejsGameCase: picture {Part} of {Id} could not be scaled", part, id);
                }

                return NotFound();
            }

            // Opened inside the try: a cache file that vanished is a 404, not a 500. The long cache header is set only
            // once the file is open, so a 404 never carries it.
            var stream = System.IO.File.OpenRead(resultPath);
            Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
            Response.Headers.Append("Vary", "Origin");
            return File(stream, string.IsNullOrEmpty(mime) ? "application/octet-stream" : mime);
        }
        catch (Exception ex)
        {
            if (Logged.TryAdd(path + "|" + tag, 0))
            {
                _logger.LogWarning(ex, "ThreejsGameCase: picture {Part} of {Id} could not be served", part, id);
            }

            return NotFound();
        }
    }
}
