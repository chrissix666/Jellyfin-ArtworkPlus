using System;
using System.IO;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Serves Jellyfin-ArtworkPlus-Posters-v1.js, the poster script that drives
/// Custom, Animated and Extra posters through one shared state machine (render
/// paths, timers and observers). The script is a loose file in the data folder,
/// editable after install, unlike the embedded Core script.
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
    /// GET /PostersPlus/script.js - serves the client script from the plugin's data folder.
    /// </summary>
    [HttpGet("script.js")]
    public ActionResult GetScript()
    {
        try
        {
            var scriptPath = Helpers.FeatureScripts.Resolve("Jellyfin-ArtworkPlus-Posters-v1.js");   // data folder first, then the copy shipped next to the DLL
            if (scriptPath is null)
            {
                _logger.LogWarning("PostersPlus: GetScript 404 - script not found in the data folder or next to the DLL");
                return NotFound();
            }

            // Revalidate on every load; 304 when unchanged.
            if (Helpers.ScriptCaching.NotModified(Request, Response, Helpers.ScriptCaching.FileTag(scriptPath))) { return StatusCode(Microsoft.AspNetCore.Http.StatusCodes.Status304NotModified); }
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
