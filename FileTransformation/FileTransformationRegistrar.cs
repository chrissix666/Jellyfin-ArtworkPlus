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
/// per plugin (see PluginManager.cs:223-235) - an error here only disables
/// our plugin, doesn't crash the server.
///
/// ROOT CAUSE FOUND via a real server log across three separate boot
/// cycles (not caught by any earlier round despite multiple audits): this
/// used to call TryRegisterWithFileTransformation directly, synchronously,
/// from RegisterServices itself - but RegisterServices() is called for
/// ALL plugins in one pass, in a loop, with NO guaranteed ordering between
/// plugins (confirmed: PluginManager.cs iterates plugins and calls each
/// one's RegisterServices in turn). On one observed boot cycle, our own
/// RegisterServices ran ~15ms BEFORE File Transformation's own
/// RegisterServices, causing a NullReferenceException inside
/// PluginInterface.RegisterTransformation() - confirmed directly from File
/// Transformation's own real source (not guessed): RegisterTransformation
/// reads FileTransformationPlugin.Instance.ServiceProvider, and
/// FileTransformationPlugin's constructor (FileTransformationPlugin.cs:
/// "Instance = this;") is what actually sets Instance - NOT
/// RegisterServices() (an earlier version of this comment said the
/// opposite, which was imprecise/wrong - RegisterServices() only
/// registers DI services via PluginServiceRegistrator.cs, it doesn't
/// construct the plugin itself). On another boot cycle the order was
/// reversed (no crash, but TransformIndexHtml was still never invoked in
/// a full-log grep across all three cycles either way) - i.e. even the
/// "lucky" ordering didn't actually work end-to-end.
///
/// FIX: move the actual RegisterTransformation call out of
/// RegisterServices() entirely and into an IHostedService.StartAsync()
/// instead - confirmed directly against the real Jellyfin server source
/// (not IServerEntryPoint, which doesn't exist in this Jellyfin version;
/// an earlier round's plan named the wrong, outdated interface before
/// this was checked), line by line, in Jellyfin.Server/Program.cs:
///   line 154: host.Build()                      - DI container built
///   line 157: appHost.ServiceProvider = host.Services;
///   line 159: await appHost.InitializeServices() - contains FindParts()
///             -&gt; PluginManager.CreatePlugins() -&gt; EVERY plugin's
///             constructor runs here, File Transformation's included
///             (its constructor is exactly where "Instance = this;" and
///             "ServiceProvider = serviceProvider;" happen)
///   line 164: await host.StartAsync()            - starts every
///             registered IHostedService, ours included
/// host.StartAsync() is therefore structurally guaranteed to run after
/// EVERY plugin's constructor has already completed, File Transformation
/// included, regardless of the ordering BETWEEN plugins within any
/// earlier phase (RegisterServices or construction). RegisterServices()
/// itself now only registers this hosted service; the actual reflection
/// call into File Transformation happens later, in StartAsync(), by which
/// point FileTransformationPlugin.Instance is structurally guaranteed to
/// already be non-null.
///
/// As a genuinely nice side effect, this also cleanly resolves the
/// earlier logging problem on its own merits, not as a workaround: a
/// normal IHostedService is constructed through DI like any other
/// service, so a constructor-injected ILogger works exactly as expected -
/// no more applicationHost.Resolve&lt;ILoggerFactory&gt;() special-casing
/// needed at all.
/// </summary>
public class ServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddHostedService<FileTransformationRegistrationHostedService>();
    }
}

/// <summary>
/// Runs once, after every plugin's RegisterServices() has completed (see
/// the detailed reasoning on ServiceRegistrator above) - this is where the
/// actual reflection call into File Transformation's PluginInterface now
/// happens, instead of directly inside RegisterServices().
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
            // NOT "^index\.html$" (this project's previous value) - confirmed
            // via File Transformation's own real source
            // (WebFileTransformationService.cs, NeedsTransformation): the
            // regex fallback match is run against the ORIGINAL, un-normalized
            // path argument (leading "/" still present, e.g. "/index.html",
            // as handed in by PhysicalTransformedFileProvider.GetFileInfo's
            // own "subpath" from ASP.NET Core's static-file middleware) -
            // NOT the NormalizePath()'d version used for the plain
            // dictionary-key lookup a few lines above it in that same
            // method. A ^-anchored pattern requiring the string to literally
            // START with "index" therefore never matches, since the actual
            // string starts with "/" instead - this is exactly why our
            // registration itself succeeded (confirmed in a real server log:
            // "Received transformation registration for '^index\.html$'
            // with ID '<our GUID>'") but TransformIndexHtml itself was NEVER
            // actually invoked on any real request, unlike every other
            // installed plugin using File Transformation, which all use an
            // unanchored "index.html" pattern (confirmed identically in
            // their own real log lines - no ^/$ at all) that matches as a
            // plain substring search regardless of the leading "/".
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
            // Deliberately caught here too - this way, the exact spot
            // (Parse vs. Invoke) ends up in the log with a full stack
            // trace, instead of just a bare failure with no detail.
            // Deliberately NOT rethrown here (unlike the old
            // RegisterServices-based version, which rethrew to let
            // PluginManager mark the plugin Malfunctioned): an exception
            // thrown from IHostedService.StartAsync() can abort the
            // ENTIRE server startup (all hosted services are started as
            // part of the same host startup sequence), which would be a
            // far worse outcome than this one plugin's script injection
            // just not working - logging the failure clearly is enough.
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
    /// FOOC (Flash of Original Content) prehiding - see the curriculum's own
    /// "MAJOR INVESTIGATION" section for the full research/audit trail
    /// behind this. Hides `.cardImageContainer` the instant it's inserted
    /// into `.detailImageContainer` (before ANY script, ours or Jellyfin's
    /// own, has had a chance to run), via a dedicated class
    /// (`artworkplus-pending`, deliberately NOT `.lazy` itself, to avoid
    /// ambiguity with Jellyfin's own class of the same purpose) marked
    /// `!important` - needed for robustness against other later-loaded CSS
    /// (e.g. the user's own Jellyfin "Custom CSS" setting).
    ///
    /// Real, source/spec-confirmed constraint this design works around:
    /// CSS animations can NEVER override an `!important` property (CSS
    /// Animations Level 1 spec; `!important` is itself invalid inside
    /// `@keyframes`) - so the safety-net below can't be a pure CSS
    /// animation undoing this rule. Instead, `.artworkplus-pending` is
    /// removed via `classList.remove()` (a real DOM mutation, not a
    /// competing CSS value) - once the class no longer matches, the
    /// `!important` rule simply no longer applies, regardless of its own
    /// specificity/importance.
    /// </summary>
    private const string PrehidingStyleTag =
        "<style id=\"artworkplus-prehiding\">.detailImageContainer .cardImageContainer.artworkplus-pending{visibility:hidden!important}</style>";


    /// <summary>
    /// Library tiles (Session 122): the tile arbiter in Posters-v1.js marks
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
    /// Tells the tile arbiter which of the three library features are on
    /// (tab + feature + at least one Library switch), so it only waits for
    /// the answers that can come and pends nothing at all when none is on.
    /// A page served by an older build has no flag object - the arbiter
    /// then expects all three (each answers empty when disabled).
    /// </summary>
    private static string BuildLibraryTilesFlagsScriptTag(Configuration.PluginConfiguration config)
    {
        var custom = config.CustomPosterEnabled && (
            (config.PostercaseEnabled && (config.PostercaseMoviesLibraryEnabled || config.PostercaseTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Postercase", "Movies") || Helpers.AlsoOn.AnyBox(config, "Postercase", "TvShows")))
            || (config.KeyartEnabled && (config.KeyartMoviesLibraryEnabled || config.KeyartTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Keyart", "Movies") || Helpers.AlsoOn.AnyBox(config, "Keyart", "TvShows"))));
        var animated = config.AnimatedPosterTabEnabled && (
            (config.AnimatedPosterEnabled && (config.AnimatedPosterMoviesLibraryEnabled || config.AnimatedPosterTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "AnimatedPoster", "Movies") || Helpers.AlsoOn.AnyBox(config, "AnimatedPoster", "TvShows")))
            || (config.AnimatedKeyartEnabled && (config.AnimatedKeyartMoviesLibraryEnabled || config.AnimatedKeyartTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "AnimatedKeyart", "Movies") || Helpers.AlsoOn.AnyBox(config, "AnimatedKeyart", "TvShows"))));
        // Session 124: a library view counts when it is on AND shows at least one type.
        // Session 140: a "show also on" box counts like the grid switch (the participant is expected; a refused page answers empty).
        var epMoviesLib = (config.ExtraposterMoviesLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Extraposter", "Movies")) && (config.ExtraposterMoviesLibraryShowOnMovies || config.ExtraposterMoviesLibraryShowOnSets);
        var epTvLib = (config.ExtraposterTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Extraposter", "TvShows")) && config.ExtraposterTvShowsLibraryShowOnTvShows;
        var ekMoviesLib = (config.ExtrakeyartMoviesLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Extrakeyart", "Movies")) && (config.ExtrakeyartMoviesLibraryShowOnMovies || config.ExtrakeyartMoviesLibraryShowOnSets);
        var ekTvLib = (config.ExtrakeyartTvShowsLibraryEnabled || Helpers.AlsoOn.AnyBox(config, "Extrakeyart", "TvShows")) && config.ExtrakeyartTvShowsLibraryShowOnTvShows;
        var extra = config.ExtraposterTabEnabled && (
            (config.ExtraposterEnabled && (epMoviesLib || epTvLib))
            || (config.ExtrakeyartEnabled && (ekMoviesLib || ekTvLib)));
        // Session 124: does any active Extra library block want the tile held
        // blank until its first image (Seamless loading)? Custom/Animated
        // always do (one image, nothing to wait for on top).
        var extraSeamless = config.ExtraposterTabEnabled && (
            (config.ExtraposterEnabled && ((epMoviesLib && config.ExtraposterMoviesLibrarySeamlessEnabled) || (epTvLib && config.ExtraposterTvShowsLibrarySeamlessEnabled)))
            || (config.ExtrakeyartEnabled && ((ekMoviesLib && config.ExtrakeyartMoviesLibrarySeamlessEnabled) || (ekTvLib && config.ExtrakeyartTvShowsLibrarySeamlessEnabled))));
        static string B(bool b) => b ? "true" : "false";
        return "<script id=\"artworkplus-library-tiles-flags\">window.ArtworkPlusLibraryTiles={custom:" + B(custom) + ",animated:" + B(animated) + ",extra:" + B(extra) + ",extraSeamless:" + B(extraSeamless) + "};</script>";
    }

    /// <summary>
    /// Backdrops' own static prehiding rule - same underlying principle as
    /// PrehidingStyleTag above (a static CSS rule, present before any
    /// script runs, applying the instant its target element exists,
    /// regardless of timing), but for a genuinely different, separately
    /// investigated problem. See Backdrops-v1.js's own
    /// resolveOverrideState() doc comment for the full, source-verified
    /// reasoning this replaced: this project's own JavaScript can never
    /// reliably run BEFORE Jellyfin's own `renderBackdrop()` for a given
    /// navigation (a DOM event dispatch-order guarantee, not a timing
    /// race that could be won with a shorter delay - confirmed against
    /// jellyfin-web's own viewManager.js and itemDetails/index.js
    /// sources), so detailsBanner is no longer written by this project at
    /// all. Instead, Jellyfin's own native `.backdropContainer` is hidden
    /// by this static rule whenever this project's own `body` class
    /// (`artworkplus-backdrops-override`, toggled by Backdrops-v1.js
    /// itself based on its own settings/browser/detailsBanner checks) is
    /// present. Session 120: our own containers no longer carry
    /// Jellyfin's `.backdropContainer` class at all (Core's
    /// createBackdropOwner copies the three positioning rules instead -
    /// Jellyfin caches `querySelector('.backdropContainer')` on first use
    /// and would otherwise empty OUR container in clearBackdrop()); the
    /// `:not(...)` guard stays as a harmless belt-and-braces. The body
    /// class is now toggled by the transition bus in Core, exactly while
    /// one of our seven implementations shows (or is claimed for) the page
    /// (concept Part R; since Session 130 that includes Home and the
    /// library home pages through Library View Backdrops).
    /// </summary>
    private const string BackdropsPrehidingStyleTag =
        "<style id=\"artworkplus-backdrops-prehiding\">body.artworkplus-backdrops-override .backdropContainer:not(.artworkplus-own-backdrop){visibility:hidden!important}</style>";

    /// <summary>
    /// LogoArt (Session 134, concept B3 sharpened 2026-09-21): a static
    /// rule cannot know the item type, so vanilla's .detailLogo is hidden
    /// globally as soon as at least one item type deviates from
    /// VanillaLogo / 100 / 0 / 0. The client asks /LogoArt/{itemId}; for a
    /// zero-intervention type it adds ONE class (artworkplus-logoart-vanilla)
    /// that releases the logo again and touches nothing else, for every
    /// other type our own container shows the winning stage. Source facts:
    /// itemDetails/index.html:4 has an empty .detailLogo, the image arrives
    /// only in renderLogo() (index.js:678-687) after the item fetch through
    /// the lazy loader - so the release class never races a painted logo.
    /// visibility (not display): Characterart's top anchor uses .detailLogo
    /// as its DOM insertion point and the layout must not change.
    /// </summary>
    private const string LogoArtPrehidingStyleTag =
        "<style id=\"artworkplus-logoart-prehiding\">.detailLogo:not(.artworkplus-logoart-vanilla){visibility:hidden!important}</style>";

    /// <summary>true when at least one item type of the LogoArt tab is not at its zero-intervention default (effective values incl. Take over - Helpers/LogoArtSettings; Persons never need prehiding, vanilla shows nothing there).</summary>
    internal static bool LogoArtIntervenes(PluginConfiguration c)
    {
        if (!c.LogoArtEnabled) { return false; }
        foreach (var type in Helpers.LogoArtSettings.Types)
        {
            if (!Helpers.LogoArtSettings.Effective(c, type).IsZeroIntervention) { return true; }
        }

        return false;
    }

    /// <summary>
    /// Deliberately standalone, minimal, inline - NOT part of Core.js or
    /// anything delivered via JavaScript Injector - specifically so this
    /// safety net still works even if that larger delivery path fails
    /// entirely (script error, JavaScript Injector disabled, network
    /// failure loading the bigger bundle). Its own, independent
    /// MutationObserver watches for ANY `.detailImageContainer
    /// .cardImageContainer.lazy` appearing (not gated on
    /// `.artworkplus-pending` already being present - the real poster
    /// arbiter in Core.js adds that class asynchronously, and this safety
    /// net must not assume any particular ordering relative to that) and
    /// starts an independent, per-element timer. If `.artworkplus-pending`
    /// is still present once that timer fires, it's removed - the poster
    /// arbiter's own, much earlier removal (on an actual applicability
    /// decision) is expected to already have happened in the overwhelming
    /// majority of cases; this is purely the last-resort fallback for a
    /// total JS failure, not the primary reveal mechanism.
    ///
    /// SAFETY_NET_MS: a starting value, NOT independently verified against
    /// real network conditions (see curriculum's own audit notes) - a
    /// tuning parameter, not a guarantee.
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
    /// Posters-v1.js's installPosterPendingByDefault() (see that function's own
    /// doc comment for the full, source-verified reasoning). Core adds
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
    /// decision legitimately takes a server round-trip (and the user
    /// explicitly accepts that wait) - this must only ever fire on a real
    /// failure, never on a slow but healthy decision, or it would itself
    /// re-create the very flash it exists to prevent.
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

    // Audit S1-13 (Session 138): the File Transformation plugin keeps the ORIGINAL
    // file only when the callback returns null (TransformationHelper.cs: `if
    // (transformedString == null) return;` - an empty string is written back and
    // the file is truncated to it). A failed payload read therefore returns null,
    // never string.Empty: a blank index.html for everyone is the one outcome this
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
            // Audit S1-08 (Session 138): the "index.html" pattern also matches
            // other HTML the File Transformation plugin hands us (three calls
            // with 1 134 / 5 062 / 11 361 bytes against the real 11 108 on
            // 2026-09-20/21) - not our page, nothing to insert, no warning.
            logger?.LogDebug("ArtworkPlus: TransformIndexHtml - no </body> in the given HTML ({Length} bytes), not the SPA index - returned unchanged", contents.Length);
            return contents;
        }

        var result = contents;

        // FOOC prehiding - injected BEFORE </head> (earlier than the three
        // script tags below, which all go before </body>) since </head>
        // is the earliest available insertion point via this mechanism -
        // meaningfully earlier for a cold direct-URL load; irrelevant for
        // ordinary SPA navigation since this index.html is only ever
        // parsed once per browser session either way.
        //
        // Conditional on admin config, checked here in real, server-side
        // C# BEFORE deciding whether to inject anything at all: a user
        // who has disabled BOTH AnimatedPoster and ExtraPoster gets
        // byte-for-byte unmodified vanilla behavior - no CSS, no safety-net
        // script, no momentary hide-then-reveal cost on every navigation
        // for a mechanism that would never have anything to decide.
        var config = Plugin.Instance?.Configuration;
        // REAL BUG FOUND AND FIXED (Custom Poster / Postercase groundwork):
        // this condition gates the ENTIRE pending-by-default infrastructure
        // (PrehidingStyleTag/SafetyNetScriptTag/PosterPendingStyleTag/
        // PosterPendingSafetyNetScriptTag) - without it,
        // Posters-v1.js's own installPosterPendingByDefault() still
        // RUNS (it's called unconditionally, PostersPlus.js itself is
        // always injected) and sets the 'artworkplus-poster-pending'
        // class, but with no CSS rule reacting to that class, the class
        // has zero visible effect. Postercase now participates in the
        // same poster controller as Animated/Extra (priority 1, see
        // Posters-v1.js's own "Priority model" doc comment) and
        // needs the exact same protection against a native-poster flash
        // while it decides - a user with ONLY Postercase enabled (neither
        // Animated nor Extra) would otherwise get zero flash protection,
        // reintroducing the very bug this whole mechanism exists to solve.
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

        // Library tiles (Session 122): style + feature flags, always
        // injected - the flags say whether the arbiter has anything to
        // wait for; with all three off it pends nothing.
        if (config is not null && contents.Contains("</head>", StringComparison.Ordinal) && !result.Contains("artworkplus-library-tiles", StringComparison.Ordinal))
        {
            result = result.Replace("</head>", LibraryTilesStyleTag + BuildLibraryTilesFlagsScriptTag(config) + "</head>", StringComparison.Ordinal);
        }

        // Backdrops' own static prehiding rule - independent of the FOOC
        // one above (different target element, different feature,
        // different admin-config gate). Same reasoning: a user with
        // Backdrops disabled gets byte-for-byte unmodified vanilla
        // behavior, no unnecessary CSS.
        // Session 130 (found live: Detail View off + Library View on left
        // vanilla's Home rotation visible under ours): the body class is
        // set by the bus for EVERY category, so the rule is needed as soon
        // as any category of the tab is on - not only Detail View. Before
        // Library View this never showed because vanilla paints nothing on
        // the list pages of the other five.
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

        // LogoArt prehiding (Session 134) - see LogoArtPrehidingStyleTag.
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

        // Check/insert all three script tags independently of each other -
        // this stays robust in case, e.g., only some of them are already
        // present. Core's tag is inserted FIRST and deliberately checked
        // first here too - each insertion appends right before </body>,
        // meaning insertion ORDER becomes the resulting tag order in the
        // HTML (Replace() keeps </body> itself intact, so the next
        // insertion lands right after whatever was inserted before it) -
        // Core being first in this sequence is what makes it load before
        // any of the two feature scripts that depend on it, since none
        // of these three tags carry defer/async (classic scripts execute in
        // DOM order).
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
