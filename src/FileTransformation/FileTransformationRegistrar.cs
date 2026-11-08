using System;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.FileTransformation;

/// <summary>
/// Hook point: IPluginServiceRegistrator.RegisterServices is called once by
/// PluginManager.RegisterServices() on server start, in its own try/catch
/// per plugin - an error here only disables this plugin, it does not crash
/// the server.
///
/// RegisterServices() runs for all plugins in one loop with no guaranteed
/// order between them, and File Transformation's
/// PluginInterface.RegisterTransformation() reads
/// FileTransformationPlugin.Instance.ServiceProvider, which is only set in
/// that plugin's constructor. Calling it from RegisterServices can therefore
/// throw a NullReferenceException or silently never register.
///
/// So RegisterServices() only adds a hosted service, and the actual
/// registration happens in IHostedService.StartAsync(). In
/// Jellyfin.Server/Program.cs, host.Build() builds the DI container,
/// appHost.InitializeServices() runs PluginManager.CreatePlugins() (every
/// plugin's constructor, File Transformation's included), and only then
/// host.StartAsync() starts every registered IHostedService. By that point
/// FileTransformationPlugin.Instance is guaranteed to be non-null,
/// regardless of the order between plugins. A hosted service is also
/// constructed through DI, so a constructor-injected ILogger just works.
/// </summary>
public class ServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddHostedService<FileTransformationRegistrationHostedService>();
    }
}

/// <summary>
/// Runs once, after every plugin has been constructed (see the reasoning on
/// ServiceRegistrator above) - this is where the reflection call into File
/// Transformation's PluginInterface happens.
/// </summary>
public class FileTransformationRegistrationHostedService : IHostedService
{
    private readonly ILogger<FileTransformationRegistrationHostedService> _logger;

    public FileTransformationRegistrationHostedService(ILogger<FileTransformationRegistrationHostedService> logger)
    {
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        TryRegisterWithFileTransformation(_logger);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }

    private static void TryRegisterWithFileTransformation(ILogger logger)
    {
        logger.LogInformation("ArtworkPlus: FileTransformation registration START");

        var allAssemblies = AssemblyLoadContext.All.SelectMany(ctx => ctx.Assemblies).ToList();
        logger.LogInformation(
            "ArtworkPlus: FileTransformation registration - {Count} assemblies loaded in total across all AssemblyLoadContexts",
            allAssemblies.Count);

        var fileTransformationAssembly = allAssemblies
            .FirstOrDefault(asm => asm.FullName?.Contains(".FileTransformation", StringComparison.Ordinal) ?? false);

        if (fileTransformationAssembly is null)
        {
            // Don't throw an error: File Transformation is optional from
            // this plugin's point of view. If it isn't installed, only the
            // automatic script injection doesn't work - image delivery and
            // the config page remain usable independently of it.
            logger.LogWarning(
                "ArtworkPlus: FileTransformation registration ABORTED - no assembly with \".FileTransformation\" in its name was found. " +
                "Is Jellyfin.Plugin.FileTransformation installed and active? Automatic script injection doesn't work without this plugin " +
                "(image delivery/config page remain usable independently of it).");
            return;
        }

        logger.LogInformation(
            "ArtworkPlus: FileTransformation registration - assembly found: \"{FullName}\", loaded from \"{Location}\"",
            fileTransformationAssembly.FullName, fileTransformationAssembly.Location);

        var pluginInterfaceType = fileTransformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
        if (pluginInterfaceType is null)
        {
            logger.LogWarning(
                "ArtworkPlus: FileTransformation registration ABORTED - type \"Jellyfin.Plugin.FileTransformation.PluginInterface\" not present in the assembly found (possibly an incompatible version of File Transformation)");
            return;
        }

        var registerMethod = pluginInterfaceType.GetMethod("RegisterTransformation");
        if (registerMethod is null)
        {
            logger.LogWarning(
                "ArtworkPlus: FileTransformation registration ABORTED - method \"RegisterTransformation\" not found on PluginInterface (possibly an incompatible version of File Transformation)");
            return;
        }

        logger.LogInformation("ArtworkPlus: FileTransformation registration - PluginInterface.RegisterTransformation found, looking for Newtonsoft.Json...");

        // Find the same Newtonsoft.Json assembly File Transformation itself
        // has already loaded - don't bring our own.
        var newtonsoftAssembly = allAssemblies
            .FirstOrDefault(asm => string.Equals(asm.GetName().Name, "Newtonsoft.Json", StringComparison.Ordinal));

        if (newtonsoftAssembly is null)
        {
            logger.LogWarning(
                "ArtworkPlus: FileTransformation registration ABORTED - no loaded Newtonsoft.Json assembly found (normally brought in by File Transformation itself)");
            return;
        }

        logger.LogInformation(
            "ArtworkPlus: FileTransformation registration - Newtonsoft.Json found: \"{FullName}\"",
            newtonsoftAssembly.FullName);

        var jObjectType = newtonsoftAssembly.GetType("Newtonsoft.Json.Linq.JObject");
        var parseMethod = jObjectType?.GetMethod("Parse", new[] { typeof(string) });
        if (parseMethod is null)
        {
            logger.LogWarning(
                "ArtworkPlus: FileTransformation registration ABORTED - JObject.Parse(string) not found in the Newtonsoft.Json assembly");
            return;
        }

        var payloadJson = JsonSerializer.Serialize(new
        {
            id = Guid.Parse("a32fa765-c917-4c30-a58c-5998015cd046"),
            // NOT "^index\.html$": File Transformation
            // (WebFileTransformationService.cs, NeedsTransformation) runs the
            // regex fallback against the ORIGINAL, un-normalized path, which
            // starts with "/" ("/index.html", the "subpath" ASP.NET Core's
            // static-file middleware hands to
            // PhysicalTransformedFileProvider.GetFileInfo). A ^-anchored
            // pattern registers fine but never matches; the unanchored
            // "index.html" matches as a plain substring.
            fileNamePattern = "index.html",
            callbackAssembly = typeof(FileTransformCallback).Assembly.FullName,
            callbackClass = typeof(FileTransformCallback).FullName,
            callbackMethod = nameof(FileTransformCallback.TransformIndexHtml)
        });

        logger.LogInformation("ArtworkPlus: FileTransformation registration - payload JSON: {Json}", payloadJson);

        try
        {
            var jObjectPayload = parseMethod.Invoke(null, new object?[] { payloadJson });
            logger.LogInformation("ArtworkPlus: FileTransformation registration - JObject.Parse succeeded, calling RegisterTransformation...");

            registerMethod.Invoke(null, new object?[] { jObjectPayload });

            logger.LogInformation("ArtworkPlus: FileTransformation registration COMPLETED SUCCESSFULLY");
        }
        catch (Exception ex)
        {
            // Deliberately caught here too, so the exact spot (Parse vs.
            // Invoke) ends up in the log with a full stack trace.
            // Deliberately NOT rethrown: an exception thrown from
            // IHostedService.StartAsync() can abort the ENTIRE server startup
            // (all hosted services start in the same host startup sequence),
            // which is far worse than this plugin's script injection not
            // working - logging the failure clearly is enough.
            logger.LogError(ex, "ArtworkPlus: FileTransformation registration FAILED during the Parse/Invoke step");
        }
    }
}


/// <summary>
/// Called by File Transformation via reflection when index.html is served
/// - the signature (public static string, one object parameter) is fixed
/// by the plugin contract, not freely chosen.
/// </summary>
public static class FileTransformCallback
{
    private const string CoreScriptTag = "<script src=\"/ArtworkPlusCore/script.js\"></script>";
    private const string PostersPlusScriptTag = "<script src=\"/PostersPlus/script.js\"></script>";
    private const string RenderArtScriptTag = "<script src=\"/RenderArt/script.js\"></script>";
    private const string BackdropsScriptTag = "<script src=\"/Backdrops/script.js\"></script>";

    /// <summary>
    /// FOOC (Flash of Original Content) prehiding. Hides `.cardImageContainer`
    /// the instant it's inserted into `.detailImageContainer` (before ANY
    /// script, this plugin's or Jellyfin's own, has had a chance to run), via a
    /// dedicated class (`artworkplus-pending`, deliberately NOT `.lazy`
    /// itself, to avoid ambiguity with Jellyfin's own class of the same
    /// purpose) marked `!important` - needed for robustness against other
    /// later-loaded CSS (e.g. Jellyfin's "Custom CSS" setting).
    ///
    /// CSS animations can NEVER override an `!important` property (CSS
    /// Animations Level 1; `!important` is invalid inside `@keyframes`), so
    /// the safety net below can't be a pure CSS animation undoing this rule.
    /// Instead, `.artworkplus-pending` is removed via `classList.remove()` -
    /// once the class no longer matches, the `!important` rule no longer
    /// applies.
    /// </summary>
    private const string PrehidingStyleTag =
        "<style id=\"artworkplus-prehiding\">.detailImageContainer .cardImageContainer.artworkplus-pending{visibility:hidden!important}</style>";


    /// <summary>
    /// Library tiles: the tile arbiter in Posters-v1.js marks
    /// every poster tile `artworkplus-tile-pending` in the MutationObserver
    /// that sees the cards being inserted (a microtask, before the first
    /// paint) and releases it once Custom/Animated/Extra have answered for
    /// that tile and the winner's image is in place. While pending, the
    /// tile's own image is hidden and Jellyfin's blurhash canvas is kept
    /// visible (imageLoader.js hides it with `lazy-hidden` after its own
    /// fade-in) - the viewer sees the blurhash a moment longer, never the
    /// wrong image. `:has()` needs Chromium 105+/Firefox 121+; without it
    /// the canvas may hide early (a blank instead of the blurhash, still
    /// never the wrong image). The fade-in class is added when the arbiter
    /// swaps an already-painted tile itself.
    /// </summary>
    private const string LibraryTilesStyleTag =
        "<style id=\"artworkplus-library-tiles\">.cardImageContainer.artworkplus-tile-pending{opacity:0!important}.cardScalable:has(>.artworkplus-tile-pending)>.blurhash-canvas{opacity:1!important}.cardImageContainer.artworkplus-tile-fadein{animation:artworkplus-tile-fadein .5s!important}@keyframes artworkplus-tile-fadein{from{opacity:0}to{opacity:1}}</style>";

    /// <summary>
    /// The one fact the Three.js Case client needs before it may
    /// touch anything - is the feature switched on for movies at all? It is a
    /// server decision (three config switches), it cannot change while the
    /// page lives, and putting it in &lt;head&gt; means the client's first
    /// question costs no request. Everything else - web browser? WebGL? -
    /// only the browser can answer, which is why the CLIENT decides and not
    /// the server: a viewer without WebGL must still get the flat case type,
    /// and a server that simply answered "no case for movies" would leave
    /// them with nothing.
    /// </summary>
    private static string BuildThreejsFlagsScriptTag(Configuration.PluginConfiguration config)
    {
        var enabled = config.CaseModEnabled && config.CaseModShowOnMovies && config.CaseModThreejsEnabled;
        return "<script id=\"artworkplus-threejs-flags\">window.ArtworkPlusThreejs={enabled:"
               + (enabled ? "true" : "false") + "};</script>";
    }

    /// <summary>
    /// Is the Case mix on? The page predicts parts of the next
    /// detail page from the last one (the 3D tilt hold, the Three.js pending
    /// hold, the poster size) to avoid a flash. Under a mix each page draws
    /// anew, so the prediction would be wrong half the time and flash exactly
    /// what it exists to prevent; a longer load is preferred over a flicker.
    /// With this flag on, the page holds the poster until the
    /// answers are in instead of guessing.
    /// </summary>
    private static string BuildCaseMixFlagsScriptTag(Configuration.PluginConfiguration config)
    {
        var enabled = config.CaseModEnabled && config.CaseModMixEnabled;
        return "<script id=\"artworkplus-casemix-flags\">window.ArtworkPlusCaseMix={enabled:"
               + (enabled ? "true" : "false") + "};</script>";
    }

    /// <summary>
    /// Tells the tile arbiter which of the three library features are on
    /// (tab + feature + at least one Library switch), so it only waits for
    /// the answers that can come and pends nothing at all when none is on.
    /// </summary>
    private static string BuildLibraryTilesFlagsScriptTag(Configuration.PluginConfiguration config)
    {
        var custom = config.CustomPosterEnabled && (
            (config.PostercaseEnabled && (config.PostercaseMoviesLibraryEnabled || config.PostercaseTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Postercase", "Movies") || Helpers.AlsoOn.AnyBox(config, "Postercase", "TvShows")))
            || (config.KeyartEnabled && (config.KeyartMoviesLibraryEnabled || config.KeyartTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Keyart", "Movies") || Helpers.AlsoOn.AnyBox(config, "Keyart", "TvShows"))));
        var animated = config.AnimatedPosterTabEnabled && (
            (config.AnimatedPosterEnabled && (config.AnimatedPosterMoviesLibraryEnabled || config.AnimatedPosterTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "AnimatedPoster", "Movies") || Helpers.AlsoOn.AnyBox(config, "AnimatedPoster", "TvShows")))
            || (config.AnimatedKeyartEnabled && (config.AnimatedKeyartMoviesLibraryEnabled || config.AnimatedKeyartTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "AnimatedKeyart", "Movies") || Helpers.AlsoOn.AnyBox(config, "AnimatedKeyart", "TvShows"))));
        // A library view counts when it is on AND shows at least one type.
        // A "show also on" box counts like the grid switch (the participant is expected; a refused page answers empty).
        var epMoviesLib = (config.ExtraposterMoviesLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Extraposter", "Movies")) && (config.ExtraposterMoviesLibraryShowOnMovies || config.ExtraposterMoviesLibraryShowOnSets);
        var epTvLib = (config.ExtraposterTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Extraposter", "TvShows")) && config.ExtraposterTvShowsLibraryShowOnTvShows;
        var ekMoviesLib = (config.ExtrakeyartMoviesLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Extrakeyart", "Movies")) && (config.ExtrakeyartMoviesLibraryShowOnMovies || config.ExtrakeyartMoviesLibraryShowOnSets);
        var ekTvLib = (config.ExtrakeyartTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Extrakeyart", "TvShows")) && config.ExtrakeyartTvShowsLibraryShowOnTvShows;
        var extra = config.ExtraposterTabEnabled && (
            (config.ExtraposterEnabled && (epMoviesLib || epTvLib))
            || (config.ExtrakeyartEnabled && (ekMoviesLib || ekTvLib)));
        // Does any active Extra library block want the tile held
        // blank until its first image (Seamless loading)? Custom/Animated
        // always do (one image, nothing to wait for on top).
        var extraSeamless = config.ExtraposterTabEnabled && (
            (config.ExtraposterEnabled && ((epMoviesLib && config.ExtraposterMoviesLibrarySeamlessEnabled) || (epTvLib && config.ExtraposterTvShowsLibrarySeamlessEnabled)))
            || (config.ExtrakeyartEnabled && ((ekMoviesLib && config.ExtrakeyartMoviesLibrarySeamlessEnabled) || (ekTvLib && config.ExtrakeyartTvShowsLibrarySeamlessEnabled))));
        static string B(bool b) => b ? "true" : "false";
        return "<script id=\"artworkplus-library-tiles-flags\">window.ArtworkPlusLibraryTiles={custom:" + B(custom) + ",animated:" + B(animated) + ",extra:" + B(extra) + ",extraSeamless:" + B(extraSeamless) + "};</script>";
    }

    /// <summary>
    /// Backdrops' own static prehiding rule - same principle as
    /// PrehidingStyleTag above (a static CSS rule, present before any script
    /// runs), for a different problem. This plugin's JavaScript can never
    /// reliably run BEFORE Jellyfin's own `renderBackdrop()` for a navigation
    /// (a DOM event dispatch-order guarantee in jellyfin-web's viewManager.js
    /// and itemDetails/index.js, not a race a shorter delay could win), so
    /// Jellyfin's native `.backdropContainer` is hidden by this rule while the
    /// body class `artworkplus-backdrops-override` is present. Core's
    /// transition bus toggles that class exactly while one of the seven
    /// Backdrops implementations shows (or is claimed for) the page, Home and
    /// the library home pages included. The plugin's own containers do not
    /// carry `.backdropContainer` (Jellyfin caches
    /// `querySelector('.backdropContainer')` and would empty them in
    /// clearBackdrop()); the `:not(...)` guard is belt-and-braces.
    /// </summary>
    private const string BackdropsPrehidingStyleTag =
        "<style id=\"artworkplus-backdrops-prehiding\">body.artworkplus-backdrops-override .backdropContainer:not(.artworkplus-own-backdrop){visibility:hidden!important}</style>";

    /// <summary>
    /// LogoArt: a static
    /// rule cannot know the item type, so vanilla's .detailLogo is hidden
    /// globally as soon as at least one item type deviates from
    /// VanillaLogo / 100 / 0 / 0. The client asks /LogoArt/{itemId}; for a
    /// zero-intervention type it adds ONE class (artworkplus-logoart-vanilla)
    /// that releases the logo again and touches nothing else, for every
    /// other type the plugin's own container shows the winning stage. Source
    /// facts: itemDetails/index.html has an empty .detailLogo, the image
    /// arrives only in renderLogo() (index.js) after the item fetch through
    /// the lazy loader - so the release class never races a painted logo.
    /// visibility (not display): Characterart's top anchor uses .detailLogo
    /// as its DOM insertion point and the layout must not change.
    /// </summary>
    private const string LogoArtPrehidingStyleTag =
        "<style id=\"artworkplus-logoart-prehiding\">.detailLogo:not(.artworkplus-logoart-vanilla){visibility:hidden!important}</style>";

    /// <summary>true when at least one item type of the LogoArt tab is not at its zero-intervention default (effective values incl. Take over - see LogoArtSettings; Persons never need prehiding, vanilla shows nothing there).</summary>
    internal static bool LogoArtIntervenes(PluginConfiguration c)
    {
        if (!c.LogoArtEnabled) { return false; }
        foreach (var type in Helpers.LogoArtSettings.Types)
        {
            // Games: kept settings of an uninstalled Playnite Bridge must not prehide every logo.
            if (type == "Game" && !Helpers.PlayniteBridgeLink.Present) { continue; }
            if (!Helpers.LogoArtSettings.Effective(c, type).IsZeroIntervention) { return true; }
        }

        return false;
    }

    /// <summary>
    /// Deliberately standalone, minimal, inline - NOT part of Core.js - so
    /// this safety net still works if the script delivery fails entirely
    /// (script error, network failure loading the bigger bundle). Its own
    /// MutationObserver watches for ANY `.detailImageContainer
    /// .cardImageContainer.lazy` appearing (not gated on
    /// `.artworkplus-pending` already being present - the poster arbiter in
    /// Core.js adds that class asynchronously, and no ordering is assumed)
    /// and starts a per-element timer. If `.artworkplus-pending` is still
    /// present once that timer fires, it's removed. The arbiter's own, much
    /// earlier removal is the normal path; this is the last-resort fallback
    /// for a total JS failure.
    ///
    /// SAFETY_NET_MS: a tuning parameter, not a guarantee.
    /// </summary>
    private const string SafetyNetScriptTag = @"<script>(function(){
var SAFETY_NET_MS=700;
function armSafetyNet(el){
setTimeout(function(){
if(el.classList.contains('artworkplus-pending')){el.classList.remove('artworkplus-pending');}
},SAFETY_NET_MS);
}
new MutationObserver(function(records){
for(var i=0;i<records.length;i++){
var added=records[i].addedNodes;
for(var j=0;j<added.length;j++){
var node=added[j];
if(!(node instanceof Element)){continue;}
if(node.matches&&node.matches('.detailImageContainer .cardImageContainer.lazy')){armSafetyNet(node);}
var found=node.querySelectorAll?node.querySelectorAll('.detailImageContainer .cardImageContainer.lazy'):[];
for(var k=0;k<found.length;k++){armSafetyNet(found[k]);}
}
}
}).observe(document.body||document.documentElement,{childList:true,subtree:true});
})();</script>";

    /// <summary>
    /// "Hide by default, show as a decision" - the view-level rule behind
    /// Posters-v1.js's installPosterPendingByDefault() (see that function's
    /// doc comment for the full reasoning). Core adds
    /// `artworkplus-poster-pending` to the `.itemDetailPage` view element
    /// SYNCHRONOUSLY inside 'viewshow' - which jellyfin-web dispatches in
    /// the very same call chain that makes the view visible - so with
    /// this rule already in the CSSOM the native poster cannot paint even
    /// one frame before a feature has decided, for freshly loaded AND
    /// cache-restored views alike. opacity:0 (not visibility:hidden)
    /// deliberately mirrors Jellyfin's own `.lazy-hidden` so Jellyfin's
    /// own sibling placeholder (blurhash canvas / cardPadder icon) stays
    /// visible meanwhile; animation:none keeps Jellyfin's own fade-in
    /// from running invisibly and clearing that placeholder too early -
    /// releasing the class restarts the fade, Jellyfin's native reveal.
    /// </summary>
    private const string PosterPendingStyleTag =
        "<style id=\"artworkplus-poster-pending\">.itemDetailPage.artworkplus-poster-pending .detailImageContainer .cardImageContainer{opacity:0!important;animation:none!important}</style>";

    /// <summary>
    /// Independent last-resort net for the rule above, same philosophy as
    /// SafetyNetScriptTag: standalone, inline, no dependency on Core.js
    /// being loaded or working. If a view still carries
    /// `artworkplus-poster-pending` POSTER_PENDING_SAFETY_NET_MS after its
    /// 'viewshow', it is released. Generous on purpose: the plugin's own
    /// decision legitimately takes a server round-trip - this must only ever
    /// fire on a real failure, never on a slow but healthy decision, or it
    /// would itself re-create the very flash it exists to prevent.
    /// </summary>
    private const string PosterPendingSafetyNetScriptTag = @"<script>(function(){
var POSTER_PENDING_SAFETY_NET_MS=4000;
document.addEventListener('viewshow',function(e){
var v=e&&e.target;
if(!v||!v.classList||!v.classList.contains('itemDetailPage')){return;}
setTimeout(function(){
if(v.classList.contains('artworkplus-poster-pending')){v.classList.remove('artworkplus-poster-pending');}
},POSTER_PENDING_SAFETY_NET_MS);
});
})();</script>";

    // The File Transformation plugin keeps the ORIGINAL file only when the
    // callback returns null (TransformationHelper.cs: `if (transformedString
    // == null) return;` - an empty string is written back and the file is
    // truncated to it). A failed payload read therefore returns null, never
    // string.Empty: a blank index.html for everyone is the one outcome this
    // callback must never produce.
    public static string? TransformIndexHtml(object payload)
    {
        var logger = Plugin.Instance?.Logger;

        // payload is a Newtonsoft.Json.Linq.JObject from a foreign
        // AssemblyLoadContext - no direct cast possible. JObject has NO
        // real C# property "contents", only an indexer (this[string]) -
        // that's accessed via reflection on the "Item" property with a
        // string parameter, not via GetProperty("contents").
        string? contents = null;
        try
        {
            var indexer = payload?.GetType().GetProperty("Item", new[] { typeof(string) });
            var token = indexer?.GetValue(payload, new object[] { "contents" });
            contents = token?.ToString();

            logger?.LogInformation(
                "ArtworkPlus: TransformIndexHtml called, contents length={Length}",
                contents?.Length ?? 0);
        }
        catch (Exception ex)
        {
            logger?.LogError(ex, "ArtworkPlus: TransformIndexHtml - error reading payload.contents - returning null so File Transformation keeps the original file");
            return null;
        }

        if (string.IsNullOrEmpty(contents))
        {
            logger?.LogWarning("ArtworkPlus: TransformIndexHtml - contents was empty, returning null (original kept)");
            return null;
        }

        if (!contents.Contains("</body>", StringComparison.Ordinal))
        {
            // The "index.html" pattern also matches other HTML the File
            // Transformation plugin hands over - not the SPA page, nothing to
            // insert, no warning.
            logger?.LogDebug("ArtworkPlus: TransformIndexHtml - no </body> in the given HTML ({Length} bytes), not the SPA index - returned unchanged", contents.Length);
            return contents;
        }

        var result = contents;

        // FOOC prehiding - injected BEFORE </head> (earlier than the
        // script tags below, which all go before </body>) since </head>
        // is the earliest available insertion point via this mechanism -
        // meaningfully earlier for a cold direct-URL load; irrelevant for
        // ordinary SPA navigation since this index.html is only ever
        // parsed once per browser session either way.
        //
        // Conditional on admin config, checked here server-side BEFORE
        // injecting anything: with the poster features disabled, index.html
        // stays byte-for-byte vanilla - no CSS, no safety-net script, no
        // hide-then-reveal cost on every navigation.
        var config = Plugin.Instance?.Configuration;
        // This condition gates the ENTIRE pending-by-default infrastructure
        // (PrehidingStyleTag/SafetyNetScriptTag/PosterPendingStyleTag/
        // PosterPendingSafetyNetScriptTag). Posters-v1.js's
        // installPosterPendingByDefault() always runs and sets
        // 'artworkplus-poster-pending', but without the CSS rule the class has
        // no effect. Postercase takes part in the same poster controller as
        // Animated/Extra (priority 1, see Posters-v1.js's "Priority model"),
        // so with only Postercase enabled it still needs this protection
        // against a native-poster flash.
        var foocPrehidingNeeded = config is not null && (config.AnimatedPosterEnabled || config.ExtraposterEnabled || (config.CustomPosterEnabled && config.PostercaseEnabled));
        if (foocPrehidingNeeded && contents.Contains("</head>", StringComparison.Ordinal))
        {
            if (!result.Contains(PrehidingStyleTag, StringComparison.Ordinal))
            {
                result = result.Replace("</head>", PrehidingStyleTag + SafetyNetScriptTag + PosterPendingStyleTag + PosterPendingSafetyNetScriptTag + "</head>", StringComparison.Ordinal);
                logger?.LogDebug("ArtworkPlus: TransformIndexHtml - FOOC prehiding style + safety-net script + poster pending-by-default style + its safety net inserted");
            }
        }
        else if (foocPrehidingNeeded)
        {
            logger?.LogWarning("ArtworkPlus: TransformIndexHtml - FOOC prehiding needed but no </head> found in the given HTML, skipping");
        }
        else
        {
            logger?.LogDebug("ArtworkPlus: TransformIndexHtml - FOOC prehiding skipped, both AnimatedPoster and ExtraPoster are disabled");
        }

        // Library tiles: style + feature flags, always
        // injected - the flags say whether the arbiter has anything to
        // wait for; with all three off it pends nothing.
        if (config is not null && contents.Contains("</head>", StringComparison.Ordinal) && !result.Contains("artworkplus-library-tiles", StringComparison.Ordinal))
        {
            result = result.Replace("</head>", LibraryTilesStyleTag + BuildLibraryTilesFlagsScriptTag(config) + "</head>", StringComparison.Ordinal);
        }

        // The Three.js Case flag - same place and same reasoning
        // as the tile flags above, so the client can answer its first
        // question without a request.
        if (config is not null && contents.Contains("</head>", StringComparison.Ordinal) && !result.Contains("artworkplus-threejs-flags", StringComparison.Ordinal))
        {
            result = result.Replace("</head>", BuildThreejsFlagsScriptTag(config) + "</head>", StringComparison.Ordinal);
        }

        // The Case mix flag, same place and reasoning - the page
        // must know BEFORE its first answer that it cannot predict the next
        // detail page from the last one.
        if (config is not null && contents.Contains("</head>", StringComparison.Ordinal) && !result.Contains("artworkplus-casemix-flags", StringComparison.Ordinal))
        {
            result = result.Replace("</head>", BuildCaseMixFlagsScriptTag(config) + "</head>", StringComparison.Ordinal);
        }

        // Backdrops' own static prehiding rule - independent of the FOOC
        // one above (different target element, different feature,
        // different admin-config gate). Same reasoning: with Backdrops
        // disabled, index.html stays vanilla, no unnecessary CSS.
        // The body class is set by the bus for EVERY category, so the rule is
        // needed as soon as any category of the tab is on - not only Detail
        // View (Library View would otherwise leave vanilla's Home rotation
        // visible underneath).
        var backdropsPrehidingNeeded = config is not null && config.BackdropsTabEnabled
            && (config.BackdropsEnabled || config.BackdropsLibraryEnabled || config.PeopleBackdropsEnabled
                || config.BackdropsGenreEnabled || config.BackdropsStudioEnabled || config.BackdropsTagEnabled || config.BackdropsFavoritesEnabled);
        if (backdropsPrehidingNeeded && contents.Contains("</head>", StringComparison.Ordinal))
        {
            if (!result.Contains(BackdropsPrehidingStyleTag, StringComparison.Ordinal))
            {
                result = result.Replace("</head>", BackdropsPrehidingStyleTag + "</head>", StringComparison.Ordinal);
                logger?.LogDebug("ArtworkPlus: TransformIndexHtml - Backdrops prehiding style inserted");
            }
        }
        else if (backdropsPrehidingNeeded)
        {
            logger?.LogWarning("ArtworkPlus: TransformIndexHtml - Backdrops prehiding needed but no </head> found in the given HTML, skipping");
        }
        else
        {
            logger?.LogDebug("ArtworkPlus: TransformIndexHtml - Backdrops prehiding skipped, Backdrops is disabled");
        }

        // LogoArt prehiding - see LogoArtPrehidingStyleTag.
        var logoArtPrehidingNeeded = config is not null && LogoArtIntervenes(config);
        if (logoArtPrehidingNeeded && contents.Contains("</head>", StringComparison.Ordinal))
        {
            if (!result.Contains(LogoArtPrehidingStyleTag, StringComparison.Ordinal))
            {
                result = result.Replace("</head>", LogoArtPrehidingStyleTag + "</head>", StringComparison.Ordinal);
                logger?.LogDebug("ArtworkPlus: TransformIndexHtml - LogoArt prehiding style inserted");
            }
        }
        else
        {
            logger?.LogDebug("ArtworkPlus: TransformIndexHtml - LogoArt prehiding skipped (every type at its vanilla default or LogoArt off)");
        }

        // Check/insert the script tags independently of each other, so a
        // partly injected page still gets the missing ones. Each insertion
        // goes right before </body>, so insertion ORDER becomes the tag
        // order: Core is inserted FIRST and therefore loads before the
        // feature scripts that depend on it (none of the tags carry
        // defer/async, so classic scripts execute in DOM order).
        if (!result.Contains(CoreScriptTag, StringComparison.Ordinal))
        {
            result = result.Replace("</body>", CoreScriptTag + "</body>", StringComparison.Ordinal);
            logger?.LogDebug("ArtworkPlus: TransformIndexHtml - ArtworkPlus Core script tag inserted");
        }
        if (!result.Contains(PostersPlusScriptTag, StringComparison.Ordinal))
        {
            result = result.Replace("</body>", PostersPlusScriptTag + "</body>", StringComparison.Ordinal);
            logger?.LogDebug("ArtworkPlus: TransformIndexHtml - PostersPlus script tag inserted");
        }
        if (!result.Contains(RenderArtScriptTag, StringComparison.Ordinal))
        {
            result = result.Replace("</body>", RenderArtScriptTag + "</body>", StringComparison.Ordinal);
            logger?.LogDebug("ArtworkPlus: TransformIndexHtml - RenderArt script tag inserted");
        }
        if (!result.Contains(BackdropsScriptTag, StringComparison.Ordinal))
        {
            result = result.Replace("</body>", BackdropsScriptTag + "</body>", StringComparison.Ordinal);
            logger?.LogDebug("ArtworkPlus: TransformIndexHtml - BackdropsPlus script tag inserted");
        }

        return result;
    }
}
