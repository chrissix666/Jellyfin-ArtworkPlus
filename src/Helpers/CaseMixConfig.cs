using System;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// The bridge between the real configuration / library item and the
/// Jellyfin-free <see cref="CaseMix"/> draw. Kept apart from CaseMix.cs so
/// the draw compiles and can be tested without Jellyfin.
/// </summary>
public static class CaseMixConfig
{
    /// <summary>The mix settings out of the saved configuration.</summary>
    public static CaseMixSettings From(PluginConfiguration config) => new()
    {
        CaseModShowOnMovies = config.CaseModShowOnMovies,
        CaseModShowOnSets = config.CaseModShowOnSets,
        CaseModShowOnTvShows = config.CaseModShowOnTvShows,
        CaseModThreejsEnabled = config.CaseModThreejsEnabled,
        CaseModMixEnabled = config.CaseModMixEnabled,
        CaseModMixNewDrawAfter = config.CaseModMixNewDrawAfter,
        CaseModMixNoCaseSizeMovies = config.CaseModMixNoCaseSizeMovies,
        CaseModMixNoCaseSizeSets = config.CaseModMixNoCaseSizeSets,
        CaseModMixNoCaseSizeTvShows = config.CaseModMixNoCaseSizeTvShows,
        CaseModMixNoCaseSize = config.CaseModMixNoCaseSize,
        CaseModMixNoCaseAnchor = config.CaseModMixNoCaseAnchor,
        CaseModMixMoviesClear = config.CaseModMixMoviesClear,
        CaseModMixMoviesVortex = config.CaseModMixMoviesVortex,
        CaseModMixMoviesVivaElite = config.CaseModMixMoviesVivaElite,
        CaseModMixMoviesVivaElite3d = config.CaseModMixMoviesVivaElite3d,
        CaseModMixMoviesThreejs = config.CaseModMixMoviesThreejs,
        CaseModMixMoviesNoCase = config.CaseModMixMoviesNoCase,
        CaseModMixSetsClear = config.CaseModMixSetsClear,
        CaseModMixSetsVortex = config.CaseModMixSetsVortex,
        CaseModMixSetsVivaElite = config.CaseModMixSetsVivaElite,
        CaseModMixSetsVivaElite3d = config.CaseModMixSetsVivaElite3d,
        CaseModMixSetsNoCase = config.CaseModMixSetsNoCase,
        CaseModMixTvShowsClear = config.CaseModMixTvShowsClear,
        CaseModMixTvShowsVortex = config.CaseModMixTvShowsVortex,
        CaseModMixTvShowsVivaElite = config.CaseModMixTvShowsVivaElite,
        CaseModMixTvShowsVivaElite3d = config.CaseModMixTvShowsVivaElite3d,
        CaseModMixTvShowsNoCase = config.CaseModMixTvShowsNoCase,
        CaseModMixChainCasesCustomPoster = config.CaseModMixChainCasesCustomPoster,
        CaseModMixChainCasesAnimatedPoster = config.CaseModMixChainCasesAnimatedPoster,
        CaseModMixChainCasesExtraposter = config.CaseModMixChainCasesExtraposter,
        CaseModMixChainNoCaseCustomPoster = config.CaseModMixChainNoCaseCustomPoster,
        CaseModMixChainNoCaseAnimatedPoster = config.CaseModMixChainNoCaseAnimatedPoster,
        CaseModMixChainNoCaseExtraposter = config.CaseModMixChainNoCaseExtraposter,
        CaseModMixColorClearOriginal = config.CaseModMixColorClearOriginal,
        CaseModMixColorClearFullShell = config.CaseModMixColorClearFullShell,
        CaseModMixColorVortexOriginal = config.CaseModMixColorVortexOriginal,
        CaseModMixColorVortexFullShell = config.CaseModMixColorVortexFullShell,
        CaseModMixColorVivaEliteOriginal = config.CaseModMixColorVivaEliteOriginal,
        CaseModMixColorVivaEliteFullShell = config.CaseModMixColorVivaEliteFullShell,
        CaseModMixColorVivaElite3dOriginal = config.CaseModMixColorVivaElite3dOriginal,
        CaseModMixColorVivaElite3dFullShell = config.CaseModMixColorVivaElite3dFullShell,
        CaseModMixBlendClear = config.CaseModMixBlendClear,
        CaseModMixBlendVortex = config.CaseModMixBlendVortex,
        CaseModMixBlendVivaElite = config.CaseModMixBlendVivaElite,
        CaseModMixBlendVivaElite3d = config.CaseModMixBlendVivaElite3d,
        CaseModMixColorThreejsDvdOriginal = config.CaseModMixColorThreejsDvdOriginal,
        CaseModMixColorThreejsDvdFullShell = config.CaseModMixColorThreejsDvdFullShell,
        CaseModMixColorThreejsBluRayOriginal = config.CaseModMixColorThreejsBluRayOriginal,
        CaseModMixColorThreejsBluRayFullShell = config.CaseModMixColorThreejsBluRayFullShell,
        CaseModMixColorThreejsBluRayBackSpine = config.CaseModMixColorThreejsBluRayBackSpine,
        CaseModMixColorThreejsUhdOriginal = config.CaseModMixColorThreejsUhdOriginal,
        CaseModMixColorThreejsUhdFullShell = config.CaseModMixColorThreejsUhdFullShell,
        CaseModMixColorThreejsUhdBackSpine = config.CaseModMixColorThreejsUhdBackSpine,
        CaseModMixBlendThreejs = config.CaseModMixBlendThreejs,
        Stamp = RuntimeHelpers.GetHashCode(config)
    };

    /// <summary>Movie, BoxSet or Series - the three kinds a case exists for; null otherwise.</summary>
    public static string? KindOf(BaseItem? item) => item switch
    {
        Movie => "Movie",
        BoxSet => "BoxSet",
        Series => "Series",
        _ => null
    };

    /// <summary>
    /// The item's draw, or null when the mix does not apply. The master switch
    /// is checked first, so an installation without the mix pays nothing.
    /// </summary>
    public static CaseMixDraw? DrawFor(PluginConfiguration config, BaseItem? item, bool webGl)
    {
        if (!config.CaseModEnabled || !config.CaseModMixEnabled || item is null)
        {
            return null;
        }

        var kind = KindOf(item);
        return kind is null ? null : CaseMix.Draw(item.Id, kind, webGl, From(config), DateTime.UtcNow);
    }
}
