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
        // name (BasePluginOfT.cs) - not obvious to predict, hence logged.
        // A feature script (Posters-v1.js, RenderArt-v1.js, Backdrops-v1.js)
        // placed there can override the copy shipped next to the DLL (see
        // Helpers/FeatureScripts.cs). RenderArt-v1.js holds both CharacterArt
        // and Red Carpet; the Case tab's client logic (CaseModModule) lives in
        // Posters-v1.js. Core-v1.js, the shared engine all three depend on, is
        // embedded in the plugin DLL.
        logger.LogInformation(
            "ArtworkPlus: Plugin instance created. DataFolderPath is \"{Path}\" - a feature script placed there overrides the copy shipped next to the DLL.",
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

    /// <summary>Jellyfin rewrites meta.json's "description" from this property on load - without an override it is blanked.
    /// Word for word the manifest description, shared by both builds.</summary>
    public override string Description => "Poster, logo, character art and backdrop customisation for Jellyfin 10.10.7 and 12.0+: 2D and 3D cases including a real Three.js keep case for movies, animated and custom posters, Extraposter slideshows, LogoArt, CharacterArt, Red Carpet, seven backdrop categories.";

    public override Guid Id => Guid.Parse("a32fa765-c917-4c30-a58c-5998015cd046");

    /// <summary>
    /// Every save (admin page and API) reduces the
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

    // Catalog logo: Jellyfin 10.8+ reads the catalog image from the manifest
    // (`PluginManifest.ImagePath`; there is no `IHasThumbImage` in 10.10):
    // meta.json carries `"imagePath": "logo.png"`, and the .csproj copies
    // logo.png next to the DLL as a plain build-output file (same pattern as
    // CaseTextures) - no code needed in this class.
}
