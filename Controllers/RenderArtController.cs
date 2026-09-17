using System;
using System.IO;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Serves Jellyfin-ArtworkPlus-RenderArt-v1.js - CharacterArt and RedCarpet's
/// own, previously separate client scripts merged into one file, per
/// explicit user request. FILE-LEVEL MERGE ONLY: unlike the earlier
/// PostersPlus consolidation (which built one shared controller/state
/// machine for three sources that all competed for the same DOM element),
/// CharacterArt and RedCarpet never coordinated with each other and never
/// touch the same element (different page types entirely) - there is no
/// shared state or shared decision-making here, just two independently-
/// scoped IIFEs living in one file instead of two. Neither feature's own
/// behavior, admin-UI section, or settings changed because of this merge
/// - see RenderArt-v1.js's own header comment for the full reasoning.
///
/// Deliberately its own small controller, mirroring every other feature's
/// own identical GetScript() pattern (loose file in DataFolderPath, not
/// an embedded resource - editable post-install like every other feature
/// script, unlike Core.js).
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
    /// GET /RenderArt/script.js - serves the client script from the
    /// plugin's data folder, identical mechanism to every other
    /// feature's own GetScript endpoint.
    /// </summary>
    [HttpGet("script.js")]
    public ActionResult GetScript()
    {
        try
        {
            var scriptPath = Path.Combine(Plugin.Instance!.DataFolderPath, "Jellyfin-ArtworkPlus-RenderArt-v1.js");
            if (!System.IO.File.Exists(scriptPath))
            {
                _logger.LogWarning("RenderArt: GetScript 404 - script not found at \"{Path}\"", scriptPath);
                return NotFound();
            }

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
