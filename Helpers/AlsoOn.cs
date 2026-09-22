using System;
using System.Linq;
using Jellyfin.Plugin.ArtworkPlus.Configuration;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// "Show also on" (Session 140, concept docs/artworkplus-alsoon-concept.md;
/// Sessions 136-139 before it): a library-scope tile answer is gated by the
/// page class the client sends with the batch (<c>page=</c>) and the item
/// kind. The library grid itself (<c>page</c> empty or "library") is the
/// block's <c>...LibraryEnabled</c> switch; the dashboard is never allowed;
/// every other class maps to one area box of the item kind's menu,
/// <c>&lt;Feature&gt;&lt;Movies|TvShows&gt;LibraryAlsoOn&lt;Movies|Sets|Shows&gt;&lt;Area&gt;</c>,
/// read by reflection (the same name pattern the admin page and the tests
/// use). The menus are independent of the grid switch: a tile can be on
/// Home without being on the library page.
/// </summary>
public static class AlsoOn
{
    /// <summary>The page classes the client produces (Posters-v1.js pageClassOf) and the area each one reads.</summary>
    public static string? AreaOf(string page) => page switch
    {
        "favorites" => "Favorites",
        "search" => "Search",
        "home-recent" => "HomeRecentlyAdded",
        "home-resume" => "HomeContinueWatching",
        "list-genre" => "ListsGenre",
        "list-studio" => "ListsStudio",
        "list-tag" => "ListsTag",
        "list-other" => "ListsFolderMore",
        "detail-similar" => "DetailMoreLikeThis",
        "detail-collection" => "DetailSetMembers",
        "detail-person" => "DetailPeoplePages",
        _ => null
    };

    /// <summary>Whether the library tile of <paramref name="feature"/> may show for this item kind on this page class.</summary>
    /// <param name="config">The plugin configuration.</param>
    /// <param name="page">The page class of the batch (null/empty = library grid).</param>
    /// <param name="feature">Extraposter, Extrakeyart, Postercase, Keyart, AnimatedPoster or AnimatedKeyart.</param>
    /// <param name="itemKind">Movie, Series or BoxSet.</param>
    public static bool Allowed(PluginConfiguration config, string? page, string feature, string itemKind)
    {
        var kind = itemKind == "Series" ? "TvShows" : "Movies";
        var item = itemKind == "Series" ? "Shows" : itemKind == "BoxSet" ? "Sets" : "Movies";
        if (string.IsNullOrEmpty(page) || page == "library")
        {
            return Read(config, feature + kind + "LibraryEnabled");
        }

        if (page == "dashboard") { return false; }
        var area = AreaOf(page);
        if (area is null) { return false; }
        return Read(config, feature + kind + "LibraryAlsoOn" + item + area);
    }

    /// <summary>True when any "show also on" box of the feature's block is ticked (the tile arbiter expects the participant then).</summary>
    public static bool AnyBox(PluginConfiguration config, string feature, string kind)
    {
        var prefix = feature + kind + "LibraryAlsoOn";
        return typeof(PluginConfiguration).GetProperties()
            .Where(p => p.PropertyType == typeof(bool) && p.Name.StartsWith(prefix, StringComparison.Ordinal))
            .Any(p => p.GetValue(config) is true);
    }

    private static bool Read(PluginConfiguration config, string name)
    {
        var property = typeof(PluginConfiguration).GetProperty(name);
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
