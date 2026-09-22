using System;
using Jellyfin.Plugin.ArtworkPlus.Configuration;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// "Also on" (Session 136 for Extraposter/Extrakeyart, Session 139 for
/// Postercase/Keyart and AnimatedPoster/AnimatedKeyart): the library-scope
/// tile answer is filtered by the page class the client sends with the
/// batch (<c>page=</c>). No class = the library view itself, the dashboard
/// never, an unknown class never; every other class maps to exactly one
/// <c>&lt;Feature&gt;&lt;Kind&gt;LibraryAlsoOn&lt;Area&gt;</c> switch, read by
/// reflection (the same name pattern the admin page and the tests use).
/// </summary>
public static class AlsoOn
{
    /// <summary>The page classes the client produces (Posters-v1.js pageClassOf) and the area switch each one reads.</summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="page">The page class of the batch (null/empty = library view).</param>
    /// <param name="feature">Extraposter, Extrakeyart, Postercase, Keyart, AnimatedPoster or AnimatedKeyart.</param>
    /// <param name="itemKind">Movie, Series or BoxSet (a BoxSet takes the Collections subs of the Movies block).</param>
    public static bool Allowed(PluginConfiguration config, string? page, string feature, string itemKind)
    {
        if (string.IsNullOrEmpty(page) || page == "library") { return true; }
        if (page == "dashboard") { return false; }
        var tv = itemKind == "Series";
        var kind = tv ? "TvShows" : "Movies";
        var boxSet = itemKind == "BoxSet";
        string? sub = page switch
        {
            "home-recent" => "HomeRecentlyAdded",
            "home-resume" => "HomeContinueWatching",
            "favorites" => tv ? "FavoritesShows" : (boxSet ? "FavoritesCollections" : "FavoritesMovies"),
            "list-genre" => "ListsGenre",
            "list-studio" => "ListsStudio",
            "list-tag" => "ListsTag",
            "list-other" => "ListsFolderMore",
            "search" => tv ? "SearchShows" : (boxSet ? "SearchCollections" : "SearchMovies"),
            "detail-similar" => "DetailMoreLikeThis",
            "detail-collection" => "DetailCollectionMembers",
            "detail-person" => "DetailPersonPages",
            _ => null
        };
        if (sub is null) { return false; }
        var property = typeof(PluginConfiguration).GetProperty(feature + kind + "LibraryAlsoOn" + sub);
        return property is not null && property.GetValue(config) is true;
    }

    /// <summary>The feature prefix of a resolved poster type (the admin page's config prefix).</summary>
    public static string FeatureOf(string? resolvedType) => resolvedType switch
    {
        "extrakeyart" => "Extrakeyart",
        "extraposter" => "Extraposter",
        "keyart" => "Keyart",
        "postercase" => "Postercase",
        "animatedkeyart" => "AnimatedKeyart",
        "animatedposter" => "AnimatedPoster",
        _ => string.Empty
    };

    /// <summary>Movie / Series / BoxSet for the item, the way PosterListResult.ItemKind spells it.</summary>
    public static string KindOf(MediaBrowser.Controller.Entities.BaseItem? item) => item switch
    {
        MediaBrowser.Controller.Entities.TV.Series => "Series",
        MediaBrowser.Controller.Entities.Movies.BoxSet => "BoxSet",
        _ => "Movie"
    };
}
