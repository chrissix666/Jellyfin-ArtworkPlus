using System.Globalization;
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Jellyfin.Plugin.ArtworkPlus.Helpers;
using System.Collections.Generic;
using System.Security.Cryptography;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities.Movies;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Delivery path for the Three.js Case: the vendor libraries, the ported
/// renderer, its geometry, textures and printed assets, and the per-item answer.
/// There is deliberately no script.js here: the Three.js Case competes for the
/// poster slot, so its decision lives in Posters-v1.js next to the arbiter. The
/// renderer is loaded from here on demand, like three.js itself.
///   GET /ThreejsCase/lib/three.js  the pinned three.js r128 build, a plain
///                                build-output file next to the DLL like the
///                                case textures and the LogoArt fonts
///   GET /ThreejsCase/{itemId}    what to build for one movie
/// </summary>
[ApiController]
[Route("ThreejsCase")]
[AllowAnonymous]
public class ThreejsCaseController : ControllerBase
{
    /// <summary>
    /// The ten anchor values, shared with the flat case: "Default" plus the
    /// 3x3 grid. Default is not a grid position - it means "leave it where the
    /// renderer puts it", which the grid cannot express.
    /// </summary>
    private static readonly HashSet<string> ValidCaseAnchors = new(StringComparer.Ordinal)
    {
        "Default",
        "TopLeft", "TopCenter", "TopRight",
        "CenterLeft", "Center", "CenterRight",
        "BottomLeft", "BottomCenter", "BottomRight"
    };

    private readonly ILogger<ThreejsCaseController> _logger;
    private readonly ILibraryManager _libraryManager;
    /// The server's own MetadataCountryCode - the same setting Jellyfin uses
    /// to decide WHICH national certification it stores on an item, so it is
    /// also the right one for deciding which rating plate to draw.
    private readonly IServerConfigurationManager _serverConfig;

    public ThreejsCaseController(ILogger<ThreejsCaseController> logger, ILibraryManager libraryManager,
                                 IServerConfigurationManager serverConfig)
    {
        _logger = logger;
        _libraryManager = libraryManager;
        _serverConfig = serverConfig;
    }

    /// <summary>
    /// GET /ThreejsCase/lib/three.js - the pinned three.js r128 build the
    /// whole upstream renderer is written against. Served from next to the
    /// DLL, not embedded: it travels with the plugin like the case textures,
    /// and a third-party file does not belong inside the plugin's own assembly.
    /// Cached like the scripts (revalidate, 304 when unchanged) - the file
    /// only ever changes when the pinned version is raised.
    /// </summary>
    [HttpGet("lib/three.js")]
    public ActionResult GetThreeJs() => ServeVendor("three.min.js");

    /// <summary>
    /// The indices of the backdrops that are actually DIFFERENT pictures, in
    /// their original order. Identical ones after the first are dropped, so
    /// index 1 becomes the second distinct image rather than the second entry.
    /// </summary>
    private List<int> DistinctBackdrops(Movie movie)
    {
        var images = movie.GetImages(ImageType.Backdrop).ToList();
        var kept = new List<int>();
        var seen = new List<(long Length, string? Hash, string? Path)>();

        for (var i = 0; i < images.Count; i++)
        {
            var path = images[i].Path;
            long length;
            try
            {
                var info = new FileInfo(path);
                if (!info.Exists)
                {
                    // Not on disk is not the same as a duplicate - keep it and
                    // let the browser's own error path stand in.
                    kept.Add(i);
                    continue;
                }

                length = info.Length;
            }
            catch (IOException)
            {
                kept.Add(i);
                continue;
            }

            var duplicate = false;
            for (var k = 0; k < seen.Count && !duplicate; k++)
            {
                if (string.Equals(seen[k].Path, path, StringComparison.OrdinalIgnoreCase))
                {
                    duplicate = true;
                    break;
                }

                if (seen[k].Length != length)
                {
                    continue;   // different size, different picture - no read
                }

                var mine = HashOf(path);
                if (mine is null)
                {
                    continue;
                }

                var theirs = seen[k].Hash ?? HashOf(seen[k].Path);
                if (theirs is not null)
                {
                    seen[k] = (seen[k].Length, theirs, seen[k].Path);
                    duplicate = string.Equals(mine, theirs, StringComparison.Ordinal);
                }
            }

            if (!duplicate)
            {
                kept.Add(i);
                seen.Add((length, null, path));
            }
            else
            {
                _logger.LogDebug("ArtworkPlus Three.js case: backdrop {Index} duplicates an earlier one, skipped", i);
            }
        }

        return kept;
    }

    /// <summary>
    /// A content hash, used only to confirm that two files of the SAME length
    /// really are the same picture. Never reached unless a length matched.
    /// </summary>
    private static string? HashOf(string? path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return null;
        }

        try
        {
            using var stream = System.IO.File.OpenRead(path);
            using var sha = SHA256.Create();
            return Convert.ToHexString(sha.ComputeHash(stream));
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// One way out of the vendor folder, by explicit file name. Both libraries
    /// this case needs are plain browser UMD files that ship with the plugin;
    /// nothing here takes a path from the request.
    /// </summary>
    private ActionResult ServeVendor(string fileName)
    {
        try
        {
            var assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrEmpty(assemblyDir))
            {
                return NotFound();
            }

            var libPath = Path.Combine(assemblyDir, "CaseTextures", "threejscases", "vendor", fileName);
            if (!System.IO.File.Exists(libPath))
            {
                _logger.LogWarning("ThreejsCase: vendor file not found at \"{Path}\"", libPath);
                return NotFound();
            }

            if (ScriptCaching.NotModified(Request, Response, ScriptCaching.FileTag(libPath)))
            {
                return StatusCode(Microsoft.AspNetCore.Http.StatusCodes.Status304NotModified);
            }

            return File(System.IO.File.OpenRead(libPath), "application/javascript");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ThreejsCase: vendor file could not be served");
            return NotFound();
        }
    }

    /// <summary>
    /// GET /ThreejsCase/lib/renderer.js - the ported upstream geometry core.
    /// A loose file in the data folder like the feature scripts, so it can be
    /// replaced without restarting the server. Loaded on demand, only after
    /// the decision.
    /// </summary>
    [HttpGet("lib/renderer.js")]
    public ActionResult GetRenderer()
    {
        try
        {
            var path = Helpers.FeatureScripts.Resolve("Jellyfin-ArtworkPlus-ThreejsRenderer-v1.js");   // data folder first, then the copy shipped next to the DLL
            if (path is null)
            {
                _logger.LogWarning("ThreejsCase: renderer not found in the data folder or next to the DLL");
                return NotFound();
            }

            if (ScriptCaching.NotModified(Request, Response, ScriptCaching.FileTag(path)))
            {
                return StatusCode(Microsoft.AspNetCore.Http.StatusCodes.Status304NotModified);
            }

            return File(System.IO.File.OpenRead(path), "application/javascript");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ThreejsCase: Unexpected error in GetRenderer");
            return NotFound();
        }
    }

    /// <summary>
    /// The asset folders the case is allowed to serve from. Named one by one,
    /// not discovered: a folder that appears in CaseTextures later must be let
    /// in deliberately, never by existing.
    /// </summary>
    private static readonly HashSet<string> AssetFolders = new(StringComparer.Ordinal)
    {
        "studio-logos", "media-flags", "back-cover", "back-print", "case-maps", "fonts"
    };

    /// <summary>
    /// The only file types this route hands out. A folder allowlist alone is
    /// not enough - the fonts and hyphenation folders sit next to these, and a
    /// route that serves "whatever is in there" ages badly.
    /// </summary>
    private static readonly Dictionary<string, string> AssetTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".webp"] = "image/webp",
        // The back cover's plot is set in upstream's own text face. Without it
        // the typesetter measures a different font than the one it draws with,
        // and every line breaks in the wrong place.
        [".ttf"] = "font/ttf"
    };

    /// <summary>
    /// GET /ThreejsCase/asset/{**path} - the printed artwork: 3012 studio
    /// logos, 279 media flags, the back-cover plates. Too many to allowlist by
    /// name, so the guard is structural instead: the path must resolve INSIDE
    /// one of the folders above, and the check is done on the resolved full
    /// path, not on the text of the request. A "..\..\meta.json" therefore
    /// fails on the only question that matters - where does this end up - and
    /// not on a pattern someone can spell around.
    /// </summary>
    [HttpGet("asset/{**path}")]
    public ActionResult GetAsset([FromRoute] string path)
    {
        try
        {
            if (string.IsNullOrEmpty(path))
            {
                return NotFound();
            }

            var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2 || !AssetFolders.Contains(parts[0]))
            {
                return NotFound();
            }

            if (!AssetTypes.TryGetValue(Path.GetExtension(path), out var mime))
            {
                return NotFound();
            }

            var assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrEmpty(assemblyDir))
            {
                return NotFound();
            }

            var root = Path.GetFullPath(Path.Combine(assemblyDir, "CaseTextures", "threejscases"));
            var full = Path.GetFullPath(Path.Combine(root, Path.Combine(parts)));
            if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                _logger.LogWarning("ThreejsCase: asset path escaped the root, refused");
                return NotFound();
            }

            if (!System.IO.File.Exists(full))
            {
                return NotFound();
            }

            if (ScriptCaching.NotModified(Request, Response, ScriptCaching.FileTag(full)))
            {
                return StatusCode(Microsoft.AspNetCore.Http.StatusCodes.Status304NotModified);
            }

            return File(System.IO.File.OpenRead(full), mime);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ThreejsCase: asset could not be served");
            return NotFound();
        }
    }

    /// <summary>
    /// GET /ThreejsCase/lib/texture/{file} - the interior maps (tray, lid, hub)
    /// and the procedural frame, derived from the upstream PNGs; together
    /// about 63 KB. The renderer tints
    /// them with the case colour, so without them the inside of an open case is
    /// not untextured but FLAT - white times the case colour has no shading.
    /// Allowlisted by name: this endpoint must never serve an arbitrary path.
    /// </summary>
    [HttpGet("lib/texture/{file}")]
    public ActionResult GetInteriorTexture([FromRoute] string file)
    {
        try
        {
            if (!InteriorFiles.TryGetValue(file ?? string.Empty, out var mime))
            {
                return NotFound();
            }

            var assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrEmpty(assemblyDir))
            {
                return NotFound();
            }

            var path = Path.Combine(assemblyDir, "CaseTextures", "threejscases", "interior", file!); // file passed the allowlist above, so it is not null
            if (!System.IO.File.Exists(path))
            {
                _logger.LogWarning("ThreejsCase: interior texture missing at \"{Path}\"", path);
                return NotFound();
            }

            if (ScriptCaching.NotModified(Request, Response, ScriptCaching.FileTag(path)))
            {
                return StatusCode(Microsoft.AspNetCore.Http.StatusCodes.Status304NotModified);
            }

            return File(System.IO.File.OpenRead(path), mime);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ThreejsCase: Unexpected error in GetInteriorTexture");
            return NotFound();
        }
    }

    /// <summary>The only file names this endpoint will ever serve.</summary>
    private static readonly System.Collections.Generic.Dictionary<string, string> InteriorFiles = new(StringComparer.Ordinal)
    {
        ["R5.webp"] = "image/webp",
        ["L9.webp"] = "image/webp",
        ["H5.webp"] = "image/webp",
        ["frame_plain.png"] = "image/png"
    };

    /// <summary>
    /// GET /ThreejsCase/lib/colorthief.js - Color Thief 2.4.0 (MIT), 6.4 KB,
    /// plain browser UMD. It is what turns a poster into the palette the ten
    /// case-colour modes pick from; without it every mode answers with the
    /// shell colour.
    /// It is shipped rather than re-implemented: a different quantiser gives
    /// different swatches, so the colour of the same poster would differ from
    /// the reference renderer.
    /// </summary>
    [HttpGet("lib/colorthief.js")]
    public ActionResult GetColorThief() => ServeVendor("color-thief.umd.js");

    /// <summary>
    /// GET /ThreejsCase/lib/mesh.json - the case geometry, generated from the
    /// model package. Upstream embeds the same
    /// arrays into its built page; this plugin has no build step, so it is a
    /// plain asset. ~1 MB, loaded on demand right after three.js and cached like it.
    /// </summary>
    [HttpGet("lib/mesh.json")]
    public ActionResult GetMesh()
    {
        try
        {
            var assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrEmpty(assemblyDir))
            {
                return NotFound();
            }

            var meshPath = Path.Combine(assemblyDir, "CaseTextures", "threejscases", "mesh", "mesh.json");
            if (!System.IO.File.Exists(meshPath))
            {
                _logger.LogWarning("ThreejsCase: mesh not found at \"{Path}\"", meshPath);
                return NotFound();
            }

            if (ScriptCaching.NotModified(Request, Response, ScriptCaching.FileTag(meshPath)))
            {
                return StatusCode(Microsoft.AspNetCore.Http.StatusCodes.Status304NotModified);
            }

            return File(System.IO.File.OpenRead(meshPath), "application/json");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ThreejsCase: Unexpected error in GetMesh");
            return NotFound();
        }
    }

    /// <summary>
    /// GET /ThreejsCase/{itemId} - everything the renderer needs to decide
    /// WHAT to build for this item. Answers <c>Enabled=false</c> for anything
    /// that is not a movie with the feature switched on, so the client can
    /// stop without a second request.
    /// </summary>
    [HttpGet("{itemId}")]
    public ActionResult GetCase([FromRoute] Guid itemId, [FromQuery] bool? webgl)
    {
        try
        {
            var config = Plugin.Instance?.Configuration;
            if (config is null)
            {
                return Ok(new { Enabled = false, Reason = "no configuration" });
            }

            // The same three gates the admin page shows: the tab's master
            // switch on the General tab, "Show on Movies", and the feature's
            // own switch at the bottom of the Case tab.
            if (!config.CaseModEnabled || !config.CaseModShowOnMovies || !config.CaseModThreejsEnabled)
            {
                return Ok(new { Enabled = false, Reason = "switched off" });
            }

            if (_libraryManager.GetItemById(itemId) is not Movie movie)
            {
                // Movies only - sets and TV shows keep the flat case type.
                return Ok(new { Enabled = false, Reason = "not a movie" });
            }

            // The Case mix: when it applies and drew anything but Three.js,
            // this item gets no Three.js case and the flat answer or the plain
            // poster takes over. When it drew Three.js, its colour comes from
            // the mix's own tick row for this format.
            var draw = CaseMixConfig.DrawFor(config, movie, webgl ?? true);
            if (draw is not null && draw.Outcome != "threejs")
            {
                return Ok(new { Enabled = false, Reason = "case mix drew " + draw.Outcome });
            }

            var p = ThreejsCase.Resolve(movie, config);
            if (draw is not null)
            {
                var drawnMode = p.Shell == ThreejsCase.ShellDvd ? draw.ThreejsDvd
                              : p.Black ? draw.ThreejsUhd
                              : draw.ThreejsBluRay;
                p = p with { ColorMode = drawnMode ?? p.ColorMode };
            }

            var blend = draw?.Blend ?? config.CaseModThreejsColorBlend;

            // Everything the spine and the back can be printed with, named
            // here and nowhere else: the client does not guess file names and
            // does not know the folder layout. A null means "there is none",
            // which is a normal answer - the badge column closes the gap.
            var assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? string.Empty;
            var assetRoot = Path.Combine(assemblyDir, "CaseTextures", "threejscases");
            var studioAsset = ThreejsSpine.StudioAsset(movie.Studios, assetRoot);
            var formatAsset = string.IsNullOrEmpty(p.SpineFormatMark)
                ? null : "studio-logos/" + p.SpineFormatMark;
            movie.ProviderIds.TryGetValue("Tmdb", out var tmdbId);
            var hasLogo = movie.GetImageInfo(ImageType.Logo, 0) is not null;
            var hasDisc = movie.GetImageInfo(ImageType.Disc, 0) is not null;

            // The back cover's own data. Upstream reads a generated sidecar
            // per film; the same fields are read off the item here, and the
            // four flag icons are chosen from the pack that ships with us.
            var streams = movie.GetMediaStreams();
            var video = streams?.FirstOrDefault(st => st.Type == MediaStreamType.Video);
            // The first audio track's language, in the three-letter form the
            // barcode's country table is keyed on. It is the single most
            // load-bearing field on the back: without it there is no region
            // prefix, so there is no honest per-film barcode and the legal
            // footer's catalogue number falls to the template with it.
            var audioLang = streams?.FirstOrDefault(st => st.Type == MediaStreamType.Audio)?.Language;

            // Shapes, not just values - the painters read these positionally.
            // director and genre are arrays (sliced to 2 and 3), runtime is a
            // preformatted string: a bare number renders as "108" where the
            // corpus says "108 min".
            var directors = _libraryManager.GetPeople(movie)
                .Where(pp => pp.Type == PersonKind.Director)
                .Select(pp => pp.Name)
                .Where(n => !string.IsNullOrWhiteSpace(n))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(4)
                .ToArray();
            var runtime = movie.RunTimeTicks is > 0
                ? ((int)TimeSpan.FromTicks(movie.RunTimeTicks.Value).TotalMinutes).ToString(CultureInfo.InvariantCulture) + " min"
                : string.Empty;

            // WHICH backdrops the back cover may use, not just how many.
            // Asking Jellyfin for Backdrop/1 when only one exists hands back
            // the first one again, and Jellyfin's database often holds the SAME
            // image as the main backdrop and as Backdrop/1. Either way the top
            // band and the still box would show one picture twice.
            // This is settled here, before anything is visible: the server can
            // compare the files without decoding them, while the client would
            // have to load both images first. Lengths are compared first, and
            // bytes are read only when two lengths match.
            var backdropIndices = DistinctBackdrops(movie);
            var backdropCount = backdropIndices.Count;

            var back = new
            {
                Stem = movie.FileNameWithoutExtension ?? movie.Name ?? string.Empty,
                Title = movie.Name ?? string.Empty,
                Year = movie.ProductionYear,
                Plot = movie.Overview ?? string.Empty,
                Tagline = movie.Tagline ?? string.Empty,
                Studio = movie.Studios is { Length: > 0 } ? movie.Studios[0] : string.Empty,
                Genre = movie.Genres ?? Array.Empty<string>(),
                Director = directors,
                Runtime = runtime,
                AudioLanguage = string.IsNullOrWhiteSpace(audioLang) ? null : audioLang,
                BackdropCount = backdropCount,
                BackdropIndices = backdropIndices,
                Tmdb = tmdbId,
                Flags = new
                {
                    Aspect = ThreejsFlags.Aspect(video?.Width ?? 0, video?.Height ?? 0, assetRoot),
                    Resolution = ThreejsFlags.Resolution(video?.Height ?? 0, assetRoot),
                    Mpaa = ThreejsFlags.Mpaa(movie.OfficialRating, assetRoot,
                                             _serverConfig?.Configuration?.MetadataCountryCode),
                    Codec = ThreejsFlags.Codec(video?.Codec, assetRoot)
                }
            };

            return Ok(new
            {
                Enabled = true,
                p.Shell,
                p.BandLogo,
                p.SpineFormatMark,
                p.Black,
                p.ColorMode,
                Blend = blend,
                Layer = config.CaseModThreejsCaseLayer,
                Zoom = new
                {
                    Enabled = config.CaseModThreejsZoomEnabled,
                    Range = config.CaseModThreejsZoomRange
                },
                Size = config.CaseModThreejsCaseSize,
                // Where the cover window sits inside the poster box. Ten
                // values, the same list the flat case uses; anything else
                // falls back to "Default" rather than reaching the client.
                Anchor = ValidCaseAnchors.Contains(config.CaseModThreejsCaseAnchor)
                    ? config.CaseModThreejsCaseAnchor
                    : "Default",
                Turn = config.CaseModThreejsCaseTurn,
                Tilt = config.CaseModThreejsCaseTilt,
                // Derived here, not stored: "Off" in the one field IS the
                // switch. The client keeps its plain boolean and needs no
                // knowledge of the third state.
                AutoRotate = !string.Equals(config.CaseModThreejsAutoRotateDirection, "Off",
                                            StringComparison.OrdinalIgnoreCase),
                AutoRotateDirection = config.CaseModThreejsAutoRotateDirection,
                RotateSpeed = config.CaseModThreejsRotateSpeed,
                ResetOnDoubleClick = config.CaseModThreejsResetOnDoubleClick,
                BackCover = config.CaseModThreejsBackCover,
                Booklet = config.CaseModThreejsBooklet,
                Spine = new
                {
                    // The switch, and beside it what there actually IS. Both
                    // halves have to travel together: a switch that is on and a
                    // source that is missing must end up as "no badge", and
                    // that decision belongs where the item is, not in the page.
                    MovieLogo = config.CaseModThreejsSpineMovieLogo,
                    StudioLogo = config.CaseModThreejsSpineStudioLogo,
                    FormatMark = config.CaseModThreejsSpineFormatMark,
                    Code = config.CaseModThreejsSpineCode,
                    HasMovieLogo = hasLogo,
                    StudioAsset = studioAsset,
                    FormatAsset = formatAsset,
                    TmdbId = string.IsNullOrWhiteSpace(tmdbId) ? null : tmdbId
                },
                Back = back,
                // The disc decides whether the case may open at all: an empty
                // case that swings open is worse than one that stays shut.
                HasDisc = hasDisc,
                Open = new
                {
                    Automatic = config.CaseModThreejsOpenAutomatic,
                    // The click-started sequence is its own mode, mutually
                    // exclusive with OnClick (the manual toggle).
                    OnClickAutomatic = config.CaseModThreejsOpenOnClickAutomatic,
                    OnClick = config.CaseModThreejsOpenOnClick,
                    DelayMs = config.CaseModThreejsOpenDelayMs,
                    AngleDegrees = config.CaseModThreejsOpenAngleDegrees
                },
                Spin = new
                {
                    // One disc box per open mode of the same name.
                    Automatic = config.CaseModThreejsSpinAutomatic,
                    OnClickAutomatic = config.CaseModThreejsSpinOnClickAutomatic,
                    OnClick = config.CaseModThreejsSpinOnClick,
                    Direction = config.CaseModThreejsSpinDirection
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ThreejsCase: Unexpected error in GetCase for {ItemId}", itemId);
            return Ok(new { Enabled = false, Reason = "error" });
        }
    }
}
