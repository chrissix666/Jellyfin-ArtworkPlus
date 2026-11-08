using System;
using System.IO;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Serves Jellyfin-ArtworkPlus-RenderArt-v1.js, which holds the CharacterArt and
/// RedCarpet client code as two independent IIFEs (they act on different page
/// types and share no state). The script is a loose file in the data folder,
/// editable after install, unlike the embedded Core script.
/// </summary>
[ApiController]
[Route("RenderArt")]
[AllowAnonymous]
public class RenderArtController : ControllerBase
{
    private readonly ILogger<RenderArtController> _logger;

    public RenderArtController(ILogger<RenderArtController> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// GET /RenderArt/script.js - serves the client script from the plugin's data folder.
    /// </summary>
    [HttpGet("script.js")]
    public ActionResult GetScript()
    {
        try
        {
            var scriptPath = Helpers.FeatureScripts.Resolve("Jellyfin-ArtworkPlus-RenderArt-v1.js");   // data folder first, then the copy shipped next to the DLL
            if (scriptPath is null)
            {
                _logger.LogWarning("RenderArt: GetScript 404 - script not found in the data folder or next to the DLL");
                return NotFound();
            }

            // Revalidate on every load; 304 when unchanged.
            if (Helpers.ScriptCaching.NotModified(Request, Response, Helpers.ScriptCaching.FileTag(scriptPath))) { return StatusCode(Microsoft.AspNetCore.Http.StatusCodes.Status304NotModified); }
            var stream = System.IO.File.OpenRead(scriptPath);
            return File(stream, "application/javascript");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "RenderArt: Unexpected error in GetScript");
            return NotFound();
        }
    }
}
