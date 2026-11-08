using System;
using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Serves Jellyfin-ArtworkPlus-Core-v1.js, the shared engine every feature
/// script depends on. It has its own controller because it belongs to no single
/// feature. Unlike the feature scripts, which are loose files in the data folder
/// so they can be edited after install, Core is an embedded resource of the DLL:
/// it is infrastructure, not something to hand-edit, and embedding it saves a copy
/// step. See the EmbeddedResource entry in the .csproj.
/// </summary>
[ApiController]
[Route("ArtworkPlusCore")]
[AllowAnonymous]
public class CoreScriptController : ControllerBase
{
    private readonly ILogger<CoreScriptController> _logger;

    public CoreScriptController(ILogger<CoreScriptController> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// GET /ArtworkPlusCore/script.js - serves the embedded
    /// Jellyfin-ArtworkPlus-Core-v1.js. The resource name is an explicit
    /// &lt;LogicalName&gt; set in the .csproj rather than MSBuild's generated
    /// name, so it does not depend on how CreateCSharpManifestResourceName
    /// mangles folder names and survives a rename of the file or folder. Only
    /// this constant and the LogicalName must stay in sync.
    /// </summary>
    [HttpGet("script.js")]
    public ActionResult GetScript()
    {
        try
        {
            const string resourceName = "Jellyfin-ArtworkPlus-Core-v1.js";
            var assembly = typeof(CoreScriptController).Assembly;
            var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream is null)
            {
                _logger.LogError(
                    "ArtworkPlusCore: GetScript 404 - embedded resource \"{ResourceName}\" not found. Available resources: [{Available}]",
                    resourceName, string.Join(", ", assembly.GetManifestResourceNames()));
                return NotFound();
            }

            // Revalidate on every load; 304 when this build is already in the browser.
            if (Helpers.ScriptCaching.NotModified(Request, Response, Helpers.ScriptCaching.AssemblyTag(assembly))) { stream.Dispose(); return StatusCode(Microsoft.AspNetCore.Http.StatusCodes.Status304NotModified); }
            return File(stream, "application/javascript");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ArtworkPlusCore: Unexpected error in GetScript");
            return NotFound();
        }
    }
}
