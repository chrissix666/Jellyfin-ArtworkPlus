using System.Collections.Generic;
using Jellyfin.Plugin.ArtworkPlus.Configuration;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Session 134b: the effective LogoArt settings of one item type - the
/// type's own block, or (Set: "Take over Movies", Season/Episode: "Take over
/// Series") the source type's block with the type's OWN Source mode kept.
/// Shared by LogoArtController (the chain) and FileTransformationRegistrar
/// (the prehiding decision), so both agree on what "zero intervention" is:
/// Source = VanillaLogo and the logo geometry at 100 / 0 / 0.
/// </summary>
public sealed class LogoArtSettings
{
    public string Source = "VanillaLogo";
    public string Fallback = "None";
    public string SecondFallback = "None";
    public string SourceMode = "Default";
    public double LogoSizePercent = 100;
    public double LogoOffsetVw;
    public double LogoVerticalOffsetVh;
    public double ClearartSizePercent = 100;
    public double ClearartOffsetVw;
    public double ClearartVerticalOffsetVh;
    public string CharacterartScaleMode = "Height";
    public double CharacterartHeightVh = 20;
    public double CharacterartMaxWidthVw = 12;
    public double CharacterartWidthVw = 11.5;
    public double CharacterartMaxHeightVh;
    public string CharacterartHorizontalAlign = "Center";
    public double CharacterartOffsetVw;
    public bool MultiImage = true;
    public string OrderMode = "Shuffle";
    public bool SinglePass;
    public bool RandomStart;
    public bool StaySingleImageStatic;
    public int CycleTimeMs = 5000;
    public int FadeTimeMs = 1000;

    public bool IsZeroIntervention => Source == "VanillaLogo" && LogoSizePercent == 100 && LogoOffsetVw == 0 && LogoVerticalOffsetVh == 0;

    /// <summary>Source, then the fallbacks up to the first None - Hide is a terminal stage too.</summary>
    public List<string> Chain
    {
        get
        {
            var chain = new List<string>();
            foreach (var k in new[] { Source, Fallback, SecondFallback })
            {
                if (k == "None") { break; }
                if (chain.Contains(k)) { continue; }
                chain.Add(k);
                if (k == "Hide") { break; }
            }

            return chain;
        }
    }

    public static readonly string[] Types = { "Movie", "Series", "Season", "Episode", "Set", "Video", "MusicVideo", "Album", "Artist", "Book" };

    public static LogoArtSettings Effective(PluginConfiguration c, string type)
    {
        var s = Own(c, type);
        var takeOver = type switch
        {
            "Set" when c.LogoArtSetSettings == "TakeOverMovies" => "Movie",
            "Season" when c.LogoArtSeasonSettings == "TakeOverSeries" => "Series",
            "Episode" when c.LogoArtEpisodeSettings == "TakeOverSeries" => "Series",
            _ => null
        };
        if (takeOver is null) { return s; }
        var src = Own(c, takeOver);
        src.SourceMode = s.SourceMode; // the inheritance level stays the type's own (Series has none)
        return src;
    }

    private static LogoArtSettings Own(PluginConfiguration c, string type) => type switch
    {
        "Movie" => new LogoArtSettings { Source = c.LogoArtMovieSource, Fallback = c.LogoArtMovieFallback, SecondFallback = c.LogoArtMovieSecondFallback, SourceMode = c.LogoArtMovieSourceMode, LogoSizePercent = c.LogoArtMovieLogoSizePercent, LogoOffsetVw = c.LogoArtMovieLogoOffsetVw, LogoVerticalOffsetVh = c.LogoArtMovieLogoVerticalOffsetVh, ClearartSizePercent = c.LogoArtMovieClearartSizePercent, ClearartOffsetVw = c.LogoArtMovieClearartOffsetVw, ClearartVerticalOffsetVh = c.LogoArtMovieClearartVerticalOffsetVh, CharacterartScaleMode = c.LogoArtMovieCharacterartScaleMode, CharacterartHeightVh = c.LogoArtMovieCharacterartHeightVh, CharacterartMaxWidthVw = c.LogoArtMovieCharacterartMaxWidthVw, CharacterartWidthVw = c.LogoArtMovieCharacterartWidthVw, CharacterartMaxHeightVh = c.LogoArtMovieCharacterartMaxHeightVh, CharacterartHorizontalAlign = c.LogoArtMovieCharacterartHorizontalAlign, CharacterartOffsetVw = c.LogoArtMovieCharacterartOffsetVw, MultiImage = c.LogoArtMovieMultiImage, OrderMode = c.LogoArtMovieOrderMode, SinglePass = c.LogoArtMovieSinglePass, RandomStart = c.LogoArtMovieRandomStart, StaySingleImageStatic = c.LogoArtMovieStaySingleImageStatic, CycleTimeMs = c.LogoArtMovieCycleTimeMs, FadeTimeMs = c.LogoArtMovieFadeTimeMs },
        "Series" => new LogoArtSettings { Source = c.LogoArtSeriesSource, Fallback = c.LogoArtSeriesFallback, SecondFallback = c.LogoArtSeriesSecondFallback, LogoSizePercent = c.LogoArtSeriesLogoSizePercent, LogoOffsetVw = c.LogoArtSeriesLogoOffsetVw, LogoVerticalOffsetVh = c.LogoArtSeriesLogoVerticalOffsetVh, ClearartSizePercent = c.LogoArtSeriesClearartSizePercent, ClearartOffsetVw = c.LogoArtSeriesClearartOffsetVw, ClearartVerticalOffsetVh = c.LogoArtSeriesClearartVerticalOffsetVh, CharacterartScaleMode = c.LogoArtSeriesCharacterartScaleMode, CharacterartHeightVh = c.LogoArtSeriesCharacterartHeightVh, CharacterartMaxWidthVw = c.LogoArtSeriesCharacterartMaxWidthVw, CharacterartWidthVw = c.LogoArtSeriesCharacterartWidthVw, CharacterartMaxHeightVh = c.LogoArtSeriesCharacterartMaxHeightVh, CharacterartHorizontalAlign = c.LogoArtSeriesCharacterartHorizontalAlign, CharacterartOffsetVw = c.LogoArtSeriesCharacterartOffsetVw, MultiImage = c.LogoArtSeriesMultiImage, OrderMode = c.LogoArtSeriesOrderMode, SinglePass = c.LogoArtSeriesSinglePass, RandomStart = c.LogoArtSeriesRandomStart, StaySingleImageStatic = c.LogoArtSeriesStaySingleImageStatic, CycleTimeMs = c.LogoArtSeriesCycleTimeMs, FadeTimeMs = c.LogoArtSeriesFadeTimeMs },
        "Season" => new LogoArtSettings { Source = c.LogoArtSeasonSource, Fallback = c.LogoArtSeasonFallback, SecondFallback = c.LogoArtSeasonSecondFallback, SourceMode = c.LogoArtSeasonSourceMode, LogoSizePercent = c.LogoArtSeasonLogoSizePercent, LogoOffsetVw = c.LogoArtSeasonLogoOffsetVw, LogoVerticalOffsetVh = c.LogoArtSeasonLogoVerticalOffsetVh, ClearartSizePercent = c.LogoArtSeasonClearartSizePercent, ClearartOffsetVw = c.LogoArtSeasonClearartOffsetVw, ClearartVerticalOffsetVh = c.LogoArtSeasonClearartVerticalOffsetVh, CharacterartScaleMode = c.LogoArtSeasonCharacterartScaleMode, CharacterartHeightVh = c.LogoArtSeasonCharacterartHeightVh, CharacterartMaxWidthVw = c.LogoArtSeasonCharacterartMaxWidthVw, CharacterartWidthVw = c.LogoArtSeasonCharacterartWidthVw, CharacterartMaxHeightVh = c.LogoArtSeasonCharacterartMaxHeightVh, CharacterartHorizontalAlign = c.LogoArtSeasonCharacterartHorizontalAlign, CharacterartOffsetVw = c.LogoArtSeasonCharacterartOffsetVw, MultiImage = c.LogoArtSeasonMultiImage, OrderMode = c.LogoArtSeasonOrderMode, SinglePass = c.LogoArtSeasonSinglePass, RandomStart = c.LogoArtSeasonRandomStart, StaySingleImageStatic = c.LogoArtSeasonStaySingleImageStatic, CycleTimeMs = c.LogoArtSeasonCycleTimeMs, FadeTimeMs = c.LogoArtSeasonFadeTimeMs },
        "Episode" => new LogoArtSettings { Source = c.LogoArtEpisodeSource, Fallback = c.LogoArtEpisodeFallback, SecondFallback = c.LogoArtEpisodeSecondFallback, SourceMode = c.LogoArtEpisodeSourceMode, LogoSizePercent = c.LogoArtEpisodeLogoSizePercent, LogoOffsetVw = c.LogoArtEpisodeLogoOffsetVw, LogoVerticalOffsetVh = c.LogoArtEpisodeLogoVerticalOffsetVh, ClearartSizePercent = c.LogoArtEpisodeClearartSizePercent, ClearartOffsetVw = c.LogoArtEpisodeClearartOffsetVw, ClearartVerticalOffsetVh = c.LogoArtEpisodeClearartVerticalOffsetVh, CharacterartScaleMode = c.LogoArtEpisodeCharacterartScaleMode, CharacterartHeightVh = c.LogoArtEpisodeCharacterartHeightVh, CharacterartMaxWidthVw = c.LogoArtEpisodeCharacterartMaxWidthVw, CharacterartWidthVw = c.LogoArtEpisodeCharacterartWidthVw, CharacterartMaxHeightVh = c.LogoArtEpisodeCharacterartMaxHeightVh, CharacterartHorizontalAlign = c.LogoArtEpisodeCharacterartHorizontalAlign, CharacterartOffsetVw = c.LogoArtEpisodeCharacterartOffsetVw, MultiImage = c.LogoArtEpisodeMultiImage, OrderMode = c.LogoArtEpisodeOrderMode, SinglePass = c.LogoArtEpisodeSinglePass, RandomStart = c.LogoArtEpisodeRandomStart, StaySingleImageStatic = c.LogoArtEpisodeStaySingleImageStatic, CycleTimeMs = c.LogoArtEpisodeCycleTimeMs, FadeTimeMs = c.LogoArtEpisodeFadeTimeMs },
        "Set" => new LogoArtSettings { Source = c.LogoArtSetSource, Fallback = c.LogoArtSetFallback, SecondFallback = c.LogoArtSetSecondFallback, LogoSizePercent = c.LogoArtSetLogoSizePercent, LogoOffsetVw = c.LogoArtSetLogoOffsetVw, LogoVerticalOffsetVh = c.LogoArtSetLogoVerticalOffsetVh, ClearartSizePercent = c.LogoArtSetClearartSizePercent, ClearartOffsetVw = c.LogoArtSetClearartOffsetVw, ClearartVerticalOffsetVh = c.LogoArtSetClearartVerticalOffsetVh, CharacterartScaleMode = c.LogoArtSetCharacterartScaleMode, CharacterartHeightVh = c.LogoArtSetCharacterartHeightVh, CharacterartMaxWidthVw = c.LogoArtSetCharacterartMaxWidthVw, CharacterartWidthVw = c.LogoArtSetCharacterartWidthVw, CharacterartMaxHeightVh = c.LogoArtSetCharacterartMaxHeightVh, CharacterartHorizontalAlign = c.LogoArtSetCharacterartHorizontalAlign, CharacterartOffsetVw = c.LogoArtSetCharacterartOffsetVw, MultiImage = c.LogoArtSetMultiImage, OrderMode = c.LogoArtSetOrderMode, SinglePass = c.LogoArtSetSinglePass, RandomStart = c.LogoArtSetRandomStart, StaySingleImageStatic = c.LogoArtSetStaySingleImageStatic, CycleTimeMs = c.LogoArtSetCycleTimeMs, FadeTimeMs = c.LogoArtSetFadeTimeMs },
        "Video" => new LogoArtSettings { Source = c.LogoArtVideoSource, Fallback = c.LogoArtVideoFallback, SecondFallback = c.LogoArtVideoSecondFallback, SourceMode = c.LogoArtVideoSourceMode, LogoSizePercent = c.LogoArtVideoLogoSizePercent, LogoOffsetVw = c.LogoArtVideoLogoOffsetVw, LogoVerticalOffsetVh = c.LogoArtVideoLogoVerticalOffsetVh, ClearartSizePercent = c.LogoArtVideoClearartSizePercent, ClearartOffsetVw = c.LogoArtVideoClearartOffsetVw, ClearartVerticalOffsetVh = c.LogoArtVideoClearartVerticalOffsetVh },
        "MusicVideo" => new LogoArtSettings { Source = c.LogoArtMusicVideoSource, Fallback = c.LogoArtMusicVideoFallback, SecondFallback = c.LogoArtMusicVideoSecondFallback, SourceMode = c.LogoArtMusicVideoSourceMode, LogoSizePercent = c.LogoArtMusicVideoLogoSizePercent, LogoOffsetVw = c.LogoArtMusicVideoLogoOffsetVw, LogoVerticalOffsetVh = c.LogoArtMusicVideoLogoVerticalOffsetVh, ClearartSizePercent = c.LogoArtMusicVideoClearartSizePercent, ClearartOffsetVw = c.LogoArtMusicVideoClearartOffsetVw, ClearartVerticalOffsetVh = c.LogoArtMusicVideoClearartVerticalOffsetVh },
        "Album" => new LogoArtSettings { Source = c.LogoArtAlbumSource, Fallback = c.LogoArtAlbumFallback, SecondFallback = c.LogoArtAlbumSecondFallback, SourceMode = c.LogoArtAlbumSourceMode, LogoSizePercent = c.LogoArtAlbumLogoSizePercent, LogoOffsetVw = c.LogoArtAlbumLogoOffsetVw, LogoVerticalOffsetVh = c.LogoArtAlbumLogoVerticalOffsetVh, ClearartSizePercent = c.LogoArtAlbumClearartSizePercent, ClearartOffsetVw = c.LogoArtAlbumClearartOffsetVw, ClearartVerticalOffsetVh = c.LogoArtAlbumClearartVerticalOffsetVh },
        "Artist" => new LogoArtSettings { Source = c.LogoArtArtistSource, Fallback = c.LogoArtArtistFallback, SecondFallback = c.LogoArtArtistSecondFallback, LogoSizePercent = c.LogoArtArtistLogoSizePercent, LogoOffsetVw = c.LogoArtArtistLogoOffsetVw, LogoVerticalOffsetVh = c.LogoArtArtistLogoVerticalOffsetVh, ClearartSizePercent = c.LogoArtArtistClearartSizePercent, ClearartOffsetVw = c.LogoArtArtistClearartOffsetVw, ClearartVerticalOffsetVh = c.LogoArtArtistClearartVerticalOffsetVh },
        "Book" => new LogoArtSettings { Source = c.LogoArtBookSource, Fallback = c.LogoArtBookFallback, SecondFallback = c.LogoArtBookSecondFallback, LogoSizePercent = c.LogoArtBookLogoSizePercent, LogoOffsetVw = c.LogoArtBookLogoOffsetVw, LogoVerticalOffsetVh = c.LogoArtBookLogoVerticalOffsetVh, ClearartSizePercent = c.LogoArtBookClearartSizePercent, ClearartOffsetVw = c.LogoArtBookClearartOffsetVw, ClearartVerticalOffsetVh = c.LogoArtBookClearartVerticalOffsetVh },
        _ => new LogoArtSettings()
    };
}
