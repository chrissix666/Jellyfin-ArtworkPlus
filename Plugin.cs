using System;
using System.Collections.Generic;
using System.IO;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;
using Jellyfin.Plugin.ArtworkPlus.Configuration;

namespace Jellyfin.Plugin.ArtworkPlus;

/// <summary>
/// Main entry point of the plugin. Constructor signature verified against
/// MediaBrowser.Common.Plugins.BasePluginOfT (10.10.7 source) - Jellyfin
/// injects applicationPaths/xmlSerializer via DI when loading.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, ILogger<Plugin> logger)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        Logger = logger;

        // DataFolderPath is derived from PluginsPath + the assembly file
        // name (verified against BasePluginOfT.cs:49) - not always obvious
        // to predict in advance, hence logged explicitly here. IMPORTANT
        // for installation: the THREE feature scripts (
        // Jellyfin-ArtworkPlus-Posters-v1.js, -RenderArt-v1.js,
        // -Backdrops-v1.js)
        // must be placed in this folder manually, see the dashboard logs
        // after the first start. RenderArt-v1.js replaced the two
        // previously separate CharacterArt-v1.js/RedCarpet-v1.js files
        // (file-level merge only, per explicit user request - neither
        // feature's own behavior, admin-UI section, or settings changed;
        // see RenderArt-v1.js's own header comment). The Case tab's own
        // client logic (CaseModModule, boxes.zip concept session) lives
        // inside Posters-v1.js itself (explicit user request: no
        // separate feature script for it), so it needs no additional
        // entry here. Jellyfin-ArtworkPlus-
        // Core-v1.js (the shared engine all three depend on) is NOT among
        // these - it's embedded directly in the plugin DLL instead, no
        // manual copy step needed for it.
        logger.LogInformation(
            "ArtworkPlus: Plugin instance created. DataFolderPath is \"{Path}\" - the three feature scripts (Jellyfin-ArtworkPlus-Posters-v1.js, -RenderArt-v1.js, -Backdrops-v1.js) must be placed there manually. Jellyfin-ArtworkPlus-Core-v1.js is embedded in the DLL - no manual copy needed for it.",
            DataFolderPath);
    }

    /// <summary>
    /// Static access to the running plugin instance - needed, among other
    /// things, so the controllers can reach Configuration/DataFolderPath
    /// without a DI detour, and for the file-transformation callback
    /// method (see FileTransformation/FileTransformationRegistrar.cs),
    /// which is called as a static method via reflection and therefore has
    /// no DI instance of its own.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <summary>
    /// The logger exposed publicly: IPluginServiceRegistrator, per its own
    /// XML doc comment, requires a parameterless constructor ("DI is not
    /// yet instantiated yet") - so it can't have an ILogger injected.
    /// FileTransformationRegistrar.cs uses this path instead, to still log
    /// comprehensively.
    /// </summary>
    public ILogger<Plugin> Logger { get; }

    public override string Name => "ArtworkPlus";

    /// <summary>Session 138 (S4-04): Jellyfin rewrites meta.json's "description" from this property on load - without an override it is blanked.</summary>
    public override string Description => "Poster, logo, character art and backdrop customisation for Jellyfin 10.10: 3D cases, animated and custom posters, Extraposter slideshows, LogoArt, CharacterArt, Red Carpet, seven backdrop categories.";

    public override Guid Id => Guid.Parse("a32fa765-c917-4c30-a58c-5998015cd046");

    /// <summary>
    /// Audit S1-07 (Session 138): every save (admin page and API) reduces the
    /// base / type / folder names to one path segment - see Helpers.ConfigNames.
    /// </summary>
    public override void UpdateConfiguration(MediaBrowser.Model.Plugins.BasePluginConfiguration configuration)
    {
        if (configuration is PluginConfiguration ours)
        {
            var changed = Helpers.ConfigNames.Sanitize(ours);
            if (changed > 0)
            {
                Logger.LogWarning("ArtworkPlus: {Count} name field(s) contained a directory part and were reduced to the file name on save", changed);
            }
        }

        base.UpdateConfiguration(configuration);
    }

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = "ArtworkPlus",
            EmbeddedResourcePath = string.Format(
                System.Globalization.CultureInfo.InvariantCulture,
                "{0}.Configuration.configPage.html",
                GetType().Namespace)
        };
    }

    // Session 71 (user request: the logo should ship with the plugin and
    // appear in Jellyfin's plugin catalog without a manual copy step).
    // CHANGED during the first real `dotnet build` (Session 110, migration
    // from the sandbox): the `IHasThumbImage` interface assumed here does
    // not exist in Jellyfin 10.10 (Emby-era leftover, CS0246). Jellyfin
    // 10.8+ reads the catalog image from the manifest instead
    // (`PluginManifest.ImagePath`, verified against MediaBrowser.Common
    // 10.10.6): meta.json carries `"imagePath": "logo.png"`, and the
    // .csproj copies logo.png next to the DLL as a plain build-output file
    // (same pattern as CaseTextures) - no code needed in this class.
}
