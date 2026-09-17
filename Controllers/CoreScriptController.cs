using System;
using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>
/// Serves Jellyfin-ArtworkPlus-Core-v1.js - the shared engine all five
/// feature scripts depend on. Deliberately its OWN small controller
/// (rather than adding this endpoint onto ExtraposterController or any
/// other single feature's controller) since Core isn't tied to any one
/// feature - it's shared, project-level infrastructure, matching the
/// "ArtworkPlus" project-level naming decided for the .js files
/// themselves.
///
/// UNLIKE the three feature scripts' own GetScript() endpoints (which read
/// a loose file from Plugin.Instance.DataFolderPath, on purpose, so users
/// can edit them post-install without a rebuild), this endpoint reads
/// from the plugin DLL's OWN embedded resource instead
/// (GetManifestResourceStream) - Core is "connection and bundling
/// functions, the switching center, the engine" (not a tunable setting a
/// user would want to hand-edit), so embedding it removes a manual-copy
/// step without losing anything actually meant to be editable. See
/// Extraposter.csproj's EmbeddedResource entry for this same file.
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
    /// &lt;LogicalName&gt; set in Extraposter.csproj (not MSBuild's
    /// default-generated name) - a deliberate, stated fact rather than a
    /// hand-predicted one, so there's no dependency on correctly
    /// guessing how CreateCSharpManifestResourceName sanitizes folder
    /// segments vs. the file name, and no risk of silently breaking if
    /// the file or its EmbeddedScripts folder is ever renamed (only the
    /// LogicalName here and in the .csproj need to stay in sync with
    /// each other, not with the actual on-disk path/RootNamespace).
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

            return File(stream, "application/javascript");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ArtworkPlusCore: Unexpected error in GetScript");
            return NotFound();
        }
    }
}
