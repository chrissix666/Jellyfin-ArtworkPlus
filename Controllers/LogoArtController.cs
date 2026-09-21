using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ArtworkPlus.Controllers;

/// <summary>One stage of the resolved logo-slot chain (concept B2): the client shows the first stage whose image loads.</summary>
public class LogoArtStage
{
    /// <summary>VanillaLogo / Clearart / Characterart / Hide / FolderLogo / Text.</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>Single-image stages: the image URL (null = this stage has no image and is skipped).</summary>
    public string? Url { get; set; }

    /// <summary>Characterart stage: the image list (empty = skipped).</summary>
    public IReadOnlyList<ImageEntry> Images { get; set; } = Array.Empty<ImageEntry>();

    /// <summary>Which inheritance level delivered the image (Item / Parent / Grandparent / Ancestor / Season / Series / Artist).</summary>
    public string? Level { get; set; }

    /// <summary>Text stage (Persons): the name to render and the picked font.</summary>
    public string? Text { get; set; }

    public string? FontFile { get; set; }

    public string? FontFamily { get; set; }

    public bool Uppercase { get; set; }
}

/// <summary>
/// Result DTO of GET /LogoArt/{itemId}. The server resolves the whole chain
/// (inheritance levels, Source mode, Characterart files, person font) so
/// the client stays dumb: it walks Stages, preloads, shows the first hit.
/// </summary>
public class LogoArtResult
{
    public bool IsApplicable { get; set; }

    /// <summary>Movie / Series / Season / Episode / Set / Video / MusicVideo / Album / Artist / Book / Persons.</summary>
    public string ItemType { get; set; } = string.Empty;

    /// <summary>
    /// true = the type is at VanillaLogo / None / None / 100 / 0 / 0: the
    /// client only releases the prehiding on .detailLogo and touches
    /// nothing else (concept B3, sharpened 2026-09-21).
    /// </summary>
    public bool ZeroIntervention { get; set; }

    public IReadOnlyList<LogoArtStage> Stages { get; set; } = Array.Empty<LogoArtStage>();

    public double SizePercent { get; set; } = 100;

    public double OffsetVw { get; set; }

    public double VerticalOffsetVh { get; set; }

    // Rotation of the Characterart stage (the type's own fields).
    public bool MultiImage { get; set; }

    public string OrderMode { get; set; } = "Shuffle";

    public bool SinglePass { get; set; }

    public bool StaySingleImageStatic { get; set; }

    public int CycleTimeMs { get; set; } = 5000;

    public int FadeTimeMs { get; set; } = 1000;

    // Text stage (Persons).
    public double TextStroke { get; set; }

    public double Outline { get; set; } = 1;
}

/// <summary>One bundled font as listed in Fonts/fonts.json.</summary>
public class LogoArtFont
{
    [JsonPropertyName("group")]
    public string Group { get; set; } = string.Empty;

    [JsonPropertyName("family")]
    public string Family { get; set; } = string.Empty;

    [JsonPropertyName("file")]
    public string File { get; set; } = string.Empty;

    [JsonPropertyName("licence")]
    public string Licence { get; set; } = string.Empty;

    [JsonPropertyName("coreAccents")]
    public bool CoreAccents { get; set; }
}

public class LogoArtCreateLogosRequest
{
    /// <summary>Update = only persons without the file, Replace = every person.</summary>
    public string Mode { get; set; } = "Update";

    /// <summary>Optional, API only (no admin field): comma-separated person names to restrict the run to - for tests and one-offs.</summary>
    public string? Names { get; set; }
}

public class LogoArtCreateLogosResult
{
    public int Persons { get; set; }

    public int Written { get; set; }

    public int Skipped { get; set; }

    public int Failed { get; set; }

    public string Message { get; set; } = string.Empty;
}

/// <summary>
/// LogoArt (Session 134, docs/artworkplus-logoart-concept.md): the logo slot
/// of detail pages - Jellyfin's own logo, the clearart image or our
/// Characterart, per item type with a fallback chain and inheritance level
/// (Source mode), plus a logo for person pages (folder file or the name
/// rendered in a bundled font). Everything is resolved here; the client
/// (RenderArt-v1.js, third section) only preloads and shows.
/// Logging prefix "LogoArt:".
/// </summary>
[ApiController]
[Route("LogoArt")]
// [AllowAnonymous] per endpoint, NOT at class level: a class-level one
// would override CreateLogos' [Authorize(Policy = RequiresElevation)]
// (see PeopleBackdropsController's own note with the sources).
public class LogoArtController : ControllerBase
{
    private const string FontsFolderName = "Fonts";
    private const string ManifestFileName = "fonts.json";
    private static readonly string[] PersonLogoExtensions = { ".png", ".webp", ".jpg" };

    private readonly ILibraryManager _libraryManager;
    private readonly IImageProcessor _imageProcessor;
    private readonly IServerApplicationPaths _applicationPaths;
    private readonly CharacterartController _characterart;
    private readonly ILogger<LogoArtController> _logger;

    private static readonly object ManifestLock = new();
    private static IReadOnlyList<LogoArtFont>? _manifest;
    private static DateTime _manifestWriteUtc;

    public LogoArtController(
        ILibraryManager libraryManager,
        IImageProcessor imageProcessor,
        IServerApplicationPaths applicationPaths,
        CharacterartController characterart,
        ILogger<LogoArtController> logger)
    {
        _libraryManager = libraryManager;
        _imageProcessor = imageProcessor;
        _applicationPaths = applicationPaths;
        _characterart = characterart;
        _logger = logger;
    }

    // ───────────────────────── GET /LogoArt/{itemId} ─────────────────────────

    /// <summary>
    /// The resolved chain of one detail page. Persons land here too (the
    /// details page has one route for every type) and get the Persons
    /// chain (FolderLogo / Text) in the same shape.
    /// </summary>
    [HttpGet("{itemId}")]
    [AllowAnonymous]
    public ActionResult<LogoArtResult> Get([FromRoute] Guid itemId)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            if (!config.LogoArtEnabled)
            {
                return Ok(new LogoArtResult { IsApplicable = false });
            }

            var item = _libraryManager.GetItemById(itemId);
            if (item is null)
            {
                _logger.LogInformation("LogoArt: Get - {ItemId} not found", itemId);
                return Ok(new LogoArtResult { IsApplicable = false });
            }

            if (item is Person person)
            {
                return Ok(ResolvePerson(person, config));
            }

            var type = ItemTypeOf(item);
            if (type is null)
            {
                _logger.LogInformation("LogoArt: Get - {ItemId} is a {Type}, not a LogoArt type", itemId, item.GetType().Name);
                return Ok(new LogoArtResult { IsApplicable = false });
            }

            var settings = TypeSettings.For(config, type);
            var result = new LogoArtResult
            {
                IsApplicable = true,
                ItemType = type,
                ZeroIntervention = settings.IsZeroIntervention,
                SizePercent = settings.SizePercent,
                OffsetVw = settings.OffsetVw,
                VerticalOffsetVh = settings.VerticalOffsetVh,
                MultiImage = settings.MultiImage,
                OrderMode = settings.OrderMode,
                SinglePass = settings.SinglePass,
                StaySingleImageStatic = settings.StaySingleImageStatic,
                CycleTimeMs = settings.CycleTimeMs,
                FadeTimeMs = Math.Min(settings.FadeTimeMs, settings.CycleTimeMs)
            };
            if (settings.IsZeroIntervention)
            {
                _logger.LogInformation("LogoArt: Get - {ItemId} ({Type}) is zero-intervention, vanilla works alone", itemId, type);
                return Ok(result);
            }

            var levels = InheritanceLevels(item);
            var wanted = LevelsForSourceMode(settings.SourceMode);
            var stages = new List<LogoArtStage>();
            foreach (var kind in settings.Chain)
            {
                stages.Add(ResolveStage(kind, item, levels, wanted, settings, config));
            }

            result.Stages = stages;
            _logger.LogInformation(
                "LogoArt: Get END for {ItemId} ({Type}) - levels [{Levels}], source mode {Mode}, chain [{Chain}]",
                itemId, type, string.Join(" > ", levels.Select(l => l.Name + ":" + l.Item.GetType().Name)), settings.SourceMode,
                string.Join(", ", stages.Select(s => s.Kind + (s.Url is not null ? "@" + s.Level : s.Images.Count > 0 ? "x" + s.Images.Count : s.Kind == "Hide" ? string.Empty : "(none)"))));
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "LogoArt: Unexpected error in Get for {ItemId}", itemId);
            return Ok(new LogoArtResult { IsApplicable = false });
        }
    }

    private LogoArtStage ResolveStage(string kind, BaseItem item, IReadOnlyList<Level> levels, HashSet<string>? wanted, TypeSettings settings, PluginConfiguration config)
    {
        var stage = new LogoArtStage { Kind = kind };
        switch (kind)
        {
            case "VanillaLogo":
                FillImageStage(stage, ImageType.Logo, levels, wanted);
                break;
            case "Clearart":
                FillImageStage(stage, ImageType.Art, levels, wanted);
                break;
            case "Characterart":
                var resolved = _characterart.ResolveSlotImages(item, config, settings.MultiImage, settings.OrderMode);
                if (resolved is not null && resolved.Value.Images.Count > 0)
                {
                    var images = resolved.Value.Images;
                    if (settings.RandomStart && settings.OrderMode == "Sequential" && !settings.SinglePass && settings.MultiImage) { images = Helpers.RandomStart.Rotate(images); }
                    stage.Images = images.Select(f => new ImageEntry { FileName = f, Version = VersionOf(Path.Combine(resolved.Value.FolderPath, f)) }).ToList();
                }

                break;
            case "Hide":
                break;
        }

        return stage;
    }

    /// <summary>First level (in chain order, filtered by Source mode) that owns an image of the type - Jellyfin's own DtoService order.</summary>
    private void FillImageStage(LogoArtStage stage, ImageType type, IReadOnlyList<Level> levels, HashSet<string>? wanted)
    {
        foreach (var level in levels)
        {
            if (wanted is not null && !wanted.Contains(level.Name)) { continue; }
            if (!level.Item.HasImage(type, 0)) { continue; }
            string? tag;
            try
            {
                tag = _imageProcessor.GetImageCacheTag(level.Item, type, 0);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "LogoArt: no cache tag for {ItemId} {Type}", level.Item.Id, type);
                continue;
            }

            if (string.IsNullOrEmpty(tag)) { continue; }
            stage.Url = "/Items/" + level.Item.Id.ToString("N") + "/Images/" + type + "?tag=" + Uri.EscapeDataString(tag);
            stage.Level = level.Name;
            return;
        }
    }

    // ───────────────────────── inheritance chain ─────────────────────────

    private sealed record Level(BaseItem Item, string Name);

    /// <summary>
    /// The item and its image-inheritance ancestors, exactly the walk of
    /// DtoService.AddInheritedImages / GetImageDisplayParent (jellyfin
    /// 10.10.7, DtoService.cs:1273-1385): only if the item
    /// SupportsInheritedParentImages; MusicAlbum -> its artist; otherwise
    /// DisplayParent ?? Owner ?? Parent, last resort the collection folder;
    /// an ancestor's images are checked BEFORE its own
    /// SupportsInheritedParentImages stops the walk (Series, MusicArtist,
    /// CollectionFolder are such stops).
    /// </summary>
    private List<Level> InheritanceLevels(BaseItem item)
    {
        var levels = new List<Level> { new(item, "Item") };
        if (!item.SupportsInheritedParentImages) { return levels; }
        var current = item;
        var depth = 0;
        while (depth < 12)
        {
            var parent = ImageDisplayParent(current, item);
            if (parent is null) { break; }
            depth++;
            levels.Add(new Level(parent, LevelName(item, parent, depth)));
            if (!parent.SupportsInheritedParentImages) { break; }
            current = parent;
        }

        return levels;
    }

    private BaseItem? ImageDisplayParent(BaseItem current, BaseItem original)
    {
        if (current is MusicAlbum album)
        {
            var artist = album.GetMusicArtist(new MediaBrowser.Controller.Dto.DtoOptions(false));
            if (artist is not null) { return artist; }
        }

        var parent = current.DisplayParent ?? current.GetOwner() ?? current.GetParent();
        if (parent is null && original is not UserRootFolder && original is not UserView && original is not AggregateFolder && original is not ICollectionFolder)
        {
            parent = _libraryManager.GetCollectionFolders(original).FirstOrDefault();
        }

        return parent;
    }

    /// <summary>Level names the Source mode values refer to (concept B2).</summary>
    private static string LevelName(BaseItem original, BaseItem parent, int depth)
    {
        if (original is Episode) { return parent is Season ? "Season" : parent is Series ? "Series" : "Ancestor"; }
        if (original is Season) { return parent is Series ? "Series" : "Ancestor"; }
        if (original is MusicAlbum) { return parent is MusicArtist ? "Artist" : "Ancestor"; }
        return depth == 1 ? "Parent" : depth == 2 ? "Grandparent" : "Ancestor";
    }

    /// <summary>null = every level (Default); otherwise the one level the mode names.</summary>
    private static HashSet<string>? LevelsForSourceMode(string mode) => mode switch
    {
        "ItemOnly" or "SeasonOnly" or "AlbumOnly" => new HashSet<string> { "Item" },
        "Parent" => new HashSet<string> { "Parent" },
        "Grandparent" => new HashSet<string> { "Grandparent" },
        "Season" => new HashSet<string> { "Season" },
        "Series" => new HashSet<string> { "Series" },
        "Artist" => new HashSet<string> { "Artist" },
        _ => null
    };

    /// <summary>The LogoArt type of an item, null for anything without a block (concept A4; Trailer is no type, Folder has no detail page).</summary>
    internal static string? ItemTypeOf(BaseItem item) => item switch
    {
        Movie => "Movie",
        Series => "Series",
        Season => "Season",
        Episode => "Episode",
        BoxSet => "Set",
        MusicVideo => "MusicVideo",
        Video v when v.GetType() == typeof(Video) => "Video",
        MusicAlbum => "Album",
        MusicArtist => "Artist",
        Book or AudioBook => "Book",
        _ => null
    };

    // ───────────────────────── per-type settings ─────────────────────────

    private sealed class TypeSettings
    {
        public string Source = "VanillaLogo";
        public string Fallback = "None";
        public string SecondFallback = "None";
        public string SourceMode = "Default";
        public double SizePercent = 100;
        public double OffsetVw;
        public double VerticalOffsetVh;
        public bool MultiImage = true;
        public string OrderMode = "Shuffle";
        public bool SinglePass;
        public bool RandomStart;
        public bool StaySingleImageStatic;
        public int CycleTimeMs = 5000;
        public int FadeTimeMs = 1000;

        public bool IsZeroIntervention => Source == "VanillaLogo" && SizePercent == 100 && OffsetVw == 0 && VerticalOffsetVh == 0;

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

        public static TypeSettings For(PluginConfiguration c, string type) => type switch
        {
            "Movie" => new TypeSettings { Source = c.LogoArtMovieSource, Fallback = c.LogoArtMovieFallback, SecondFallback = c.LogoArtMovieSecondFallback, SourceMode = c.LogoArtMovieSourceMode, SizePercent = c.LogoArtMovieSizePercent, OffsetVw = c.LogoArtMovieOffsetVw, VerticalOffsetVh = c.LogoArtMovieVerticalOffsetVh, MultiImage = c.LogoArtMovieMultiImage, OrderMode = c.LogoArtMovieOrderMode, SinglePass = c.LogoArtMovieSinglePass, RandomStart = c.LogoArtMovieRandomStart, StaySingleImageStatic = c.LogoArtMovieStaySingleImageStatic, CycleTimeMs = c.LogoArtMovieCycleTimeMs, FadeTimeMs = c.LogoArtMovieFadeTimeMs },
            "Series" => new TypeSettings { Source = c.LogoArtSeriesSource, Fallback = c.LogoArtSeriesFallback, SecondFallback = c.LogoArtSeriesSecondFallback, SizePercent = c.LogoArtSeriesSizePercent, OffsetVw = c.LogoArtSeriesOffsetVw, VerticalOffsetVh = c.LogoArtSeriesVerticalOffsetVh, MultiImage = c.LogoArtSeriesMultiImage, OrderMode = c.LogoArtSeriesOrderMode, SinglePass = c.LogoArtSeriesSinglePass, RandomStart = c.LogoArtSeriesRandomStart, StaySingleImageStatic = c.LogoArtSeriesStaySingleImageStatic, CycleTimeMs = c.LogoArtSeriesCycleTimeMs, FadeTimeMs = c.LogoArtSeriesFadeTimeMs },
            "Season" => new TypeSettings { Source = c.LogoArtSeasonSource, Fallback = c.LogoArtSeasonFallback, SecondFallback = c.LogoArtSeasonSecondFallback, SourceMode = c.LogoArtSeasonSourceMode, SizePercent = c.LogoArtSeasonSizePercent, OffsetVw = c.LogoArtSeasonOffsetVw, VerticalOffsetVh = c.LogoArtSeasonVerticalOffsetVh, MultiImage = c.LogoArtSeasonMultiImage, OrderMode = c.LogoArtSeasonOrderMode, SinglePass = c.LogoArtSeasonSinglePass, RandomStart = c.LogoArtSeasonRandomStart, StaySingleImageStatic = c.LogoArtSeasonStaySingleImageStatic, CycleTimeMs = c.LogoArtSeasonCycleTimeMs, FadeTimeMs = c.LogoArtSeasonFadeTimeMs },
            "Episode" => new TypeSettings { Source = c.LogoArtEpisodeSource, Fallback = c.LogoArtEpisodeFallback, SecondFallback = c.LogoArtEpisodeSecondFallback, SourceMode = c.LogoArtEpisodeSourceMode, SizePercent = c.LogoArtEpisodeSizePercent, OffsetVw = c.LogoArtEpisodeOffsetVw, VerticalOffsetVh = c.LogoArtEpisodeVerticalOffsetVh, MultiImage = c.LogoArtEpisodeMultiImage, OrderMode = c.LogoArtEpisodeOrderMode, SinglePass = c.LogoArtEpisodeSinglePass, RandomStart = c.LogoArtEpisodeRandomStart, StaySingleImageStatic = c.LogoArtEpisodeStaySingleImageStatic, CycleTimeMs = c.LogoArtEpisodeCycleTimeMs, FadeTimeMs = c.LogoArtEpisodeFadeTimeMs },
            "Set" => new TypeSettings { Source = c.LogoArtSetSource, Fallback = c.LogoArtSetFallback, SecondFallback = c.LogoArtSetSecondFallback, SizePercent = c.LogoArtSetSizePercent, OffsetVw = c.LogoArtSetOffsetVw, VerticalOffsetVh = c.LogoArtSetVerticalOffsetVh, MultiImage = c.LogoArtSetMultiImage, OrderMode = c.LogoArtSetOrderMode, SinglePass = c.LogoArtSetSinglePass, RandomStart = c.LogoArtSetRandomStart, StaySingleImageStatic = c.LogoArtSetStaySingleImageStatic, CycleTimeMs = c.LogoArtSetCycleTimeMs, FadeTimeMs = c.LogoArtSetFadeTimeMs },
            "Video" => new TypeSettings { Source = c.LogoArtVideoSource, Fallback = c.LogoArtVideoFallback, SecondFallback = c.LogoArtVideoSecondFallback, SourceMode = c.LogoArtVideoSourceMode, SizePercent = c.LogoArtVideoSizePercent, OffsetVw = c.LogoArtVideoOffsetVw, VerticalOffsetVh = c.LogoArtVideoVerticalOffsetVh },
            "MusicVideo" => new TypeSettings { Source = c.LogoArtMusicVideoSource, Fallback = c.LogoArtMusicVideoFallback, SecondFallback = c.LogoArtMusicVideoSecondFallback, SourceMode = c.LogoArtMusicVideoSourceMode, SizePercent = c.LogoArtMusicVideoSizePercent, OffsetVw = c.LogoArtMusicVideoOffsetVw, VerticalOffsetVh = c.LogoArtMusicVideoVerticalOffsetVh },
            "Album" => new TypeSettings { Source = c.LogoArtAlbumSource, Fallback = c.LogoArtAlbumFallback, SecondFallback = c.LogoArtAlbumSecondFallback, SourceMode = c.LogoArtAlbumSourceMode, SizePercent = c.LogoArtAlbumSizePercent, OffsetVw = c.LogoArtAlbumOffsetVw, VerticalOffsetVh = c.LogoArtAlbumVerticalOffsetVh },
            "Artist" => new TypeSettings { Source = c.LogoArtArtistSource, Fallback = c.LogoArtArtistFallback, SecondFallback = c.LogoArtArtistSecondFallback, SizePercent = c.LogoArtArtistSizePercent, OffsetVw = c.LogoArtArtistOffsetVw, VerticalOffsetVh = c.LogoArtArtistVerticalOffsetVh },
            "Book" => new TypeSettings { Source = c.LogoArtBookSource, Fallback = c.LogoArtBookFallback, SecondFallback = c.LogoArtBookSecondFallback, SizePercent = c.LogoArtBookSizePercent, OffsetVw = c.LogoArtBookOffsetVw, VerticalOffsetVh = c.LogoArtBookVerticalOffsetVh },
            _ => new TypeSettings()
        };
    }

    // ───────────────────────── Characterart stage image ─────────────────────────

    /// <summary>GET /LogoArt/{itemId}/characterart/{fileName} - one file of the Characterart stage, independent of the Characterart tab's gates.</summary>
    [HttpGet("{itemId}/characterart/{fileName}")]
    [AllowAnonymous]
    public ActionResult GetCharacterartImage([FromRoute] Guid itemId, [FromRoute] string fileName)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            if (!config.LogoArtEnabled) { return NotFound(); }
            var item = _libraryManager.GetItemById(itemId);
            if (item is null) { return NotFound(); }
            var file = _characterart.ResolveSlotImageFile(item, config, fileName);
            if (file is null)
            {
                _logger.LogWarning("LogoArt: GetCharacterartImage 404 - \"{FileName}\" is not a candidate of {ItemId}", fileName, itemId);
                return NotFound();
            }

            return ServeFile(file.Value.FullPath, file.Value.ContentType, 86400);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "LogoArt: Unexpected error in GetCharacterartImage for {ItemId}/{FileName}", itemId, fileName);
            return NotFound();
        }
    }

    // ───────────────────────── Persons ─────────────────────────

    private LogoArtResult ResolvePerson(Person person, PluginConfiguration config)
    {
        var result = new LogoArtResult
        {
            IsApplicable = true,
            ItemType = "Persons",
            ZeroIntervention = config.LogoArtPersonsSource == "Hide" || (config.LogoArtPersonsSource == "None"),
            SizePercent = config.LogoArtPersonsSizePercent,
            OffsetVw = config.LogoArtPersonsOffsetVw,
            VerticalOffsetVh = config.LogoArtPersonsVerticalOffsetVh,
            TextStroke = config.LogoArtPersonsTextStroke,
            Outline = config.LogoArtPersonsOutline
        };
        var stages = new List<LogoArtStage>();
        foreach (var kind in new[] { config.LogoArtPersonsSource, config.LogoArtPersonsFallback })
        {
            if (kind == "None" || stages.Any(s => s.Kind == kind)) { break; }
            var stage = new LogoArtStage { Kind = kind };
            if (kind == "FolderLogo")
            {
                var path = FindPersonLogo(person, config);
                if (path is not null)
                {
                    stage.Url = "/LogoArt/person/" + person.Id.ToString("N") + "/image?v=" + VersionOf(path);
                    stage.Level = "Folder";
                }
            }
            else if (kind == "Text")
            {
                var font = PickFont(person.Name, config);
                if (font is not null)
                {
                    stage.Text = GlyphSafeName(person.Name, font);
                    stage.FontFile = font.File;
                    stage.FontFamily = font.Family;
                    stage.Uppercase = config.LogoArtPersonsUppercase && font.Group == "title";
                }
            }

            stages.Add(stage);
            if (kind == "Hide") { break; }
        }

        result.Stages = stages;
        result.ZeroIntervention = stages.Count == 0;
        _logger.LogInformation("LogoArt: person {Name} - chain [{Chain}]", person.Name, string.Join(", ", stages.Select(s => s.Kind + (s.Url is not null || s.FontFile is not null ? string.Empty : "(none)"))));
        return result;
    }

    /// <summary>"Base name".png|webp|jpg in the person's metadata folder (Person.GetPath, like People Backdrops Folder), first found wins.</summary>
    private static string? FindPersonLogo(Person person, PluginConfiguration config)
    {
        var baseName = string.IsNullOrWhiteSpace(config.LogoArtPersonsBaseName) ? "clearlogo" : config.LogoArtPersonsBaseName.Trim();
        var folder = Person.GetPath(person.Name);
        if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) { return null; }
        foreach (var ext in PersonLogoExtensions)
        {
            var path = Path.Combine(folder, baseName + ext);
            if (System.IO.File.Exists(path)) { return path; }
        }

        return null;
    }

    /// <summary>GET /LogoArt/person/{personId}/image - the folder logo file (ETag/304 like RedCarpet).</summary>
    [HttpGet("person/{personId}/image")]
    [AllowAnonymous]
    public ActionResult GetPersonImage([FromRoute] Guid personId)
    {
        try
        {
            var config = Plugin.Instance!.Configuration;
            if (!config.LogoArtEnabled) { return NotFound(); }
            if (_libraryManager.GetItemById(personId) is not Person person) { return NotFound(); }
            var path = FindPersonLogo(person, config);
            if (path is null) { return NotFound(); }
            return ServeFile(path, ContentTypeOf(path), 86400);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "LogoArt: Unexpected error in GetPersonImage for {PersonId}", personId);
            return NotFound();
        }
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, SkiaSharp.SKTypeface?> Typefaces = new();

    /// <summary>
    /// The glyph rule of concept D2 with the real font file (SkiaSharp,
    /// the same check the bulk creator uses): a font that lacks a letter of
    /// the name gets the NFD-normalised name (Á -> A, ß -> ss, ...). The
    /// typeface is opened once per font and kept; a font that cannot be
    /// opened leaves the name as it is (the browser falls back to Noto Sans).
    /// </summary>
    private string GlyphSafeName(string name, LogoArtFont font)
    {
        var typeface = Typefaces.GetOrAdd(font.File, file =>
        {
            try
            {
                return SkiaSharp.SKTypeface.FromFile(Path.Combine(FontsFolder, file.Replace('/', Path.DirectorySeparatorChar)));
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "LogoArt: typeface not readable for {File}", file);
                return null;
            }
        });
        return typeface is null ? name : Helpers.LogoTextRenderer.GlyphSafeText(typeface, name);
    }

    /// <summary>
    /// The font for a name: the ticked fonts of the pool (config "*" = all),
    /// one ticked = that one for everyone, several = index
    /// FNV-1a(name) mod count - stable per name on every device and in the
    /// bulk creator, changes only when the list changes (concept D2).
    /// </summary>
    internal LogoArtFont? PickFont(string name, PluginConfiguration config)
    {
        var fonts = CheckedFonts(config);
        if (fonts.Count == 0) { return null; }
        if (fonts.Count == 1) { return fonts[0]; }
        return fonts[(int)(Fnv1a(name) % (uint)fonts.Count)];
    }

    internal List<LogoArtFont> CheckedFonts(PluginConfiguration config)
    {
        var pool = Manifest().Where(f => config.LogoArtPersonsFontPool == "Both" || string.Equals(f.Group, config.LogoArtPersonsFontPool, StringComparison.OrdinalIgnoreCase)).ToList();
        var csv = (config.LogoArtPersonsFonts ?? string.Empty).Trim();
        if (csv == "*") { return pool; }
        var ticked = new HashSet<string>(csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries), StringComparer.OrdinalIgnoreCase);
        return pool.Where(f => ticked.Contains(f.File)).ToList();
    }

    private static uint Fnv1a(string s)
    {
        var hash = 2166136261u;
        foreach (var b in Encoding.UTF8.GetBytes(s.Normalize(NormalizationForm.FormC)))
        {
            hash ^= b;
            hash *= 16777619u;
        }

        return hash;
    }

    // ───────────────────────── fonts ─────────────────────────

    private string FontsFolder => Path.Combine(Path.GetDirectoryName(Plugin.Instance!.AssemblyFilePath) ?? string.Empty, FontsFolderName);

    /// <summary>Fonts/fonts.json next to the DLL (Content in the csproj like CaseTextures), re-read when the file changes.</summary>
    internal IReadOnlyList<LogoArtFont> Manifest()
    {
        var path = Path.Combine(FontsFolder, ManifestFileName);
        lock (ManifestLock)
        {
            try
            {
                var writeUtc = System.IO.File.GetLastWriteTimeUtc(path);
                if (_manifest is null || writeUtc != _manifestWriteUtc)
                {
                    var json = System.IO.File.ReadAllText(path);
                    _manifest = JsonSerializer.Deserialize<List<LogoArtFont>>(json) ?? new List<LogoArtFont>();
                    _manifestWriteUtc = writeUtc;
                    _logger.LogInformation("LogoArt: font manifest loaded - {Count} fonts from \"{Path}\"", _manifest.Count, path);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "LogoArt: font manifest not readable at \"{Path}\"", path);
                _manifest ??= new List<LogoArtFont>();
            }

            return _manifest;
        }
    }

    /// <summary>GET /LogoArt/fonts - the manifest for the admin page's checklist.</summary>
    [HttpGet("fonts")]
    [AllowAnonymous]
    public ActionResult<IReadOnlyList<LogoArtFont>> GetFonts()
    {
        return Ok(Manifest());
    }

    /// <summary>
    /// GET /LogoArt/font/{group}/{file} - one bundled font file. Whitelisted
    /// against the manifest (anything else is 400), no auth like
    /// /CaseMod/Texture, immutable cache: the file changes only with a
    /// plugin update.
    /// </summary>
    [HttpGet("font/{group}/{file}")]
    [AllowAnonymous]
    public ActionResult GetFont([FromRoute] string group, [FromRoute] string file)
    {
        try
        {
            var rel = group + "/" + file;
            if (!Manifest().Any(f => string.Equals(f.File, rel, StringComparison.Ordinal)))
            {
                return BadRequest();
            }

            var path = Path.Combine(FontsFolder, group, file);
            if (!System.IO.File.Exists(path))
            {
                _logger.LogWarning("LogoArt: font not found at \"{Path}\"", path);
                return NotFound();
            }

            Response.Headers.CacheControl = "public, max-age=2592000, immutable";
            return PhysicalFile(path, "font/otf");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "LogoArt: Unexpected error in GetFont for {Group}/{File}", group, file);
            return StatusCode(StatusCodes.Status500InternalServerError);
        }
    }

    // ───────────────────────── bulk creator ─────────────────────────

    /// <summary>
    /// POST /LogoArt/create-logos {Mode: Update|Replace} - writes
    /// "Base name".png (800 x 310, transparent, white text with a black
    /// outline, fitted and centred - the user's create_clearlogos script
    /// 1:1) into every person folder with the same font pick as the live
    /// Text stage. Admin only, like PeopleBackdrops/wipe.
    /// </summary>
    [HttpPost("create-logos")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult<LogoArtCreateLogosResult> CreateLogos([FromBody] LogoArtCreateLogosRequest request)
    {
        var config = Plugin.Instance!.Configuration;
        var replace = string.Equals(request?.Mode, "Replace", StringComparison.OrdinalIgnoreCase);
        var fonts = CheckedFonts(config);
        if (fonts.Count == 0)
        {
            return Ok(new LogoArtCreateLogosResult { Message = "No font is ticked - nothing written." });
        }

        var baseName = string.IsNullOrWhiteSpace(config.LogoArtPersonsBaseName) ? "clearlogo" : config.LogoArtPersonsBaseName.Trim();
        var persons = _libraryManager.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { BaseItemKind.Person } }).OfType<Person>().ToList();
        if (!string.IsNullOrWhiteSpace(request?.Names))
        {
            var only = new HashSet<string>(request.Names.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries), StringComparer.OrdinalIgnoreCase);
            persons = persons.Where(p => only.Contains(p.Name)).ToList();
        }

        var result = new LogoArtCreateLogosResult { Persons = persons.Count };
        var renderer = new Helpers.LogoTextRenderer(FontsFolder);
        foreach (var person in persons)
        {
            try
            {
                var folder = Person.GetPath(person.Name);
                if (string.IsNullOrEmpty(folder)) { result.Skipped++; continue; }
                var target = Path.Combine(folder, baseName + ".png");
                if (!replace && PersonLogoExtensions.Any(ext => System.IO.File.Exists(Path.Combine(folder, baseName + ext)))) { result.Skipped++; continue; }
                var font = PickFont(person.Name, config)!;
                var text = config.LogoArtPersonsUppercase && font.Group == "title" ? person.Name.ToUpperInvariant() : person.Name;
                Directory.CreateDirectory(folder);
                renderer.WritePng(text, font.File, target, config.LogoArtPersonsTextStroke, config.LogoArtPersonsOutline);
                result.Written++;
            }
            catch (Exception ex)
            {
                result.Failed++;
                _logger.LogWarning(ex, "LogoArt: CreateLogos failed for {Name}", person.Name);
            }
        }

        result.Message = (replace ? "Replace" : "Update") + ": " + result.Written + " written, " + result.Skipped + " skipped, " + result.Failed + " failed of " + result.Persons + " persons.";
        _logger.LogInformation("LogoArt: CreateLogos - {Message}", result.Message);
        return Ok(result);
    }

    // ───────────────────────── helpers ─────────────────────────

    private ActionResult ServeFile(string fullPath, string contentType, int maxAgeSeconds)
    {
        var fileInfo = new FileInfo(fullPath);
        var etag = "\"" + fileInfo.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture) + "-" + fileInfo.Length.ToString(CultureInfo.InvariantCulture) + "\"";
        Response.Headers.ETag = etag;
        Response.Headers.CacheControl = "public, max-age=" + maxAgeSeconds.ToString(CultureInfo.InvariantCulture);
        var ifNoneMatch = Request.Headers.IfNoneMatch.ToString();
        if (!string.IsNullOrEmpty(ifNoneMatch) && ifNoneMatch == etag)
        {
            return StatusCode(StatusCodes.Status304NotModified);
        }

        return PhysicalFile(fullPath, contentType);
    }

    private static string VersionOf(string path)
    {
        try
        {
            var info = new FileInfo(path);
            return info.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture) + "-" + info.Length.ToString(CultureInfo.InvariantCulture);
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    private static string ContentTypeOf(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".jpg" or ".jpeg" => "image/jpeg",
        _ => "application/octet-stream"
    };
}
