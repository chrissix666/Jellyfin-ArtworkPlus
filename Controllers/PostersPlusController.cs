using System;
using System.IO;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Serves Jellyfin-ArtworkPlus-Posters-v1.js - the unified poster
/// system that replaced the three previously independent
/// CustomPoster/AnimatedPoster/ExtraPoster scripts (architecture
/// consolidation: logical arbitration was already centralized, this
/// merges the previously separate visual render paths, timers, and
/// observers into one consistent state machine - see PostersPlus's own
/// header comment for the full reasoning).
///
/// Deliberately its OWN small controller, mirroring CustomPosterController/
/// AnimatedPosterController/ExtraposterController's own identical
/// GetScript() pattern (loose file in DataFolderPath, not an embedded
/// resource - editable post-install like every other feature script,
/// unlike Core.js).
///
/// IMPORTANT deployment note: this endpoint does NOT replace the three
/// old controllers' own script.js endpoints (CustomPosterController,
/// AnimatedPosterController, ExtraposterController still serve their own
/// old files if those files still exist in DataFolderPath) - it is the
/// ADMIN's own JavaScript Injector configuration (external to this
/// plugin, not something this code can see or change) that decides which
/// script tags actually get loaded in the browser. After this
/// consolidation, the admin must remove the three old
/// &lt;script src=".../CustomPoster/script.js"&gt; (and Animated/Extraposter)
/// tags and add exactly one new
/// &lt;script src=".../PostersPlus/script.js"&gt; tag instead. The old three
/// .js files should also be deleted from DataFolderPath so an
/// accidentally-still-present old JavaScript Injector entry cannot
/// silently keep running the old, now-unmaintained render paths side by
/// side with the new one.
/// </summary>
[ApiController]
[Route("PostersPlus")]
[AllowAnonymous]
public class PostersPlusController : ControllerBase
{
    private readonly ILogger<PostersPlusController> _logger;

    public PostersPlusController(ILogger<PostersPlusController> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// GET /PostersPlus/script.js - serves the client script from the
    /// plugin's data folder, identical mechanism to every other
    /// feature's own GetScript endpoint.
    /// </summary>
    [HttpGet("script.js")]
    public ActionResult GetScript()
    {
        try
        {
            var scriptPath = Path.Combine(Plugin.Instance!.DataFolderPath, "Jellyfin-ArtworkPlus-Posters-v1.js");
            if (!System.IO.File.Exists(scriptPath))
            {
                _logger.LogWarning("PostersPlus: GetScript 404 - script not found at \"{Path}\"", scriptPath);
                return NotFound();
            }

            var stream = System.IO.File.OpenRead(scriptPath);
            return File(stream, "application/javascript");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PostersPlus: Unexpected error in GetScript");
            return NotFound();
        }
    }
}
