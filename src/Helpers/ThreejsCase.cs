using System.Globalization;
using System.IO;
using System.Collections.Generic;
using System;
using System.Linq;
using System.Text;
using Jellyfin.Plugin.ArtworkPlus.Configuration;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Which case the Three.js renderer has to show for one movie.
///
/// The whole mapping in one table:
///
///   VideoType.Dvd                     -> DVD shell,     no band logo, DVD mark
///   VideoType.BluRay                  -> Blu-ray shell, Blu-ray logo, Blu-Ray mark
///   Iso, &lt;= 10 GB or size unknown   -> DVD shell
///   Iso, &gt; 10 GB                    -> Blu-ray shell
///   VideoFile &lt;= 576p               -> DVD shell
///   VideoFile 720p / 1080p            -> Blu-ray shell
///   VideoFile 4k                      -> Blu-ray shell, UHD band mark, BLACK
///   VideoFile without probe data      -> like Iso, by file size
///
/// Three decisions behind it that are easy to get wrong later:
///
/// * <b>4K is not a third shell.</b> It is the Blu-ray shell forced black with
///   the 4K mark on the FRONT BAND. Upstream's band logo mode named "3d" means
///   the embossed three-dimensional Blu-ray logo, NOT a 3D movie - and Black is
///   the actual property of a 4K keep case: a blue shell carrying a 4K mark
///   does not exist in the wild.
/// * <b>The spine mark stays Blu-Ray for 4K.</b> Not a missing asset: a 4K UHD
///   disc IS a Blu-ray disc, so the mark is correct.
/// * <b>3D movies get no special treatment.</b> The flat case types have their
///   own 3d texture; upstream has no marking for a 3D film, so such a movie is
///   an ordinary Blu-ray at its own resolution.
///
/// The 10 GB threshold sits in the real gap between the media: DVD-9 holds
/// 8.5 GB, BD-25 holds 25 GB, so nothing legitimate falls close to it. It is
/// deliberately NOT used to detect 4K - BD-50 (50 GB) and BD-66 (66 GB) overlap
/// far too much for that, and a guessed 4K badge is worse than none.
/// </summary>
public static class ThreejsCase
{
    /// <summary>Upstream's model names.</summary>
    public const string ShellBluRay = "bluray";
    public const string ShellDvd = "dvdgen";

    /// <summary>Upstream's band logo modes ("3d" = the embossed Blu-ray logo).</summary>
    public const string BandLogoBluRay = "3d";
    public const string BandLogoUhd = "uhd";
    public const string BandLogoNone = "none";

    /// <summary>File size that separates a DVD image from a Blu-ray image.</summary>
    public const long IsoSizeThresholdBytes = 10L * 1024 * 1024 * 1024;

    /// <summary>What the renderer has to build for one movie.</summary>
    /// <param name="Shell">"bluray" or "dvdgen".</param>
    /// <param name="BandLogo">"3d", "uhd" or "none".</param>
    /// <param name="SpineFormatMark">The studio-pack file name of the spine mark.</param>
    /// <param name="Black">Whether the model color is forced to black (4K).</param>
    /// <param name="ColorMode">"Original", "FullShell" or "BackSpine" for this item.</param>
    public sealed record Presentation(string Shell, string BandLogo, string SpineFormatMark, bool Black, string ColorMode);

    /// <summary>
    /// Resolves one movie against the configuration. Pure: no I/O, no Jellyfin
    /// lookups beyond the item that was passed in, so it stays testable.
    /// </summary>
    public static Presentation Resolve(Movie movie, PluginConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(movie);
        ArgumentNullException.ThrowIfNull(config);

        var isUhd = false;
        bool isBluRay;

        switch (movie.VideoType)
        {
            case VideoType.Dvd:
                isBluRay = false;
                break;

            case VideoType.BluRay:
                isBluRay = true;
                break;

            case VideoType.Iso:
                // An ISO does not reliably expose its resolution (the flat
                // cases fall back to their neutral p.png here). The Three.js case has no neutral shell,
                // so the file size decides - and when even that is missing, DVD:
                // ISO is the classic DVD archive format, and a DVD case on a
                // Blu-ray film is a milder error than the reverse.
                isBluRay = IsLargeFile(movie);
                break;

            default:
                var video = movie.GetMediaStreams()
                    .FirstOrDefault(s => s.Type == MediaStreamType.Video);

                if (video?.Width is null || video.Height is null)
                {
                    isBluRay = IsLargeFile(movie);
                }
                else
                {
                    var tier = ResolutionTier(video.Width.Value, video.Height.Value);
                    isUhd = tier == Tier.Uhd;
                    isBluRay = tier != Tier.Dvd;
                }

                break;
        }

        var shell = isBluRay ? ShellBluRay : ShellDvd;
        var band = !isBluRay ? BandLogoNone : (isUhd ? BandLogoUhd : BandLogoBluRay);

        // 4K UHD discs are Blu-ray discs - the spine mark is correct, not a
        // stand-in for a missing 4K variant.
        var mark = isBluRay ? "Blu-Ray.png" : "DVD.png";

        var mode = !isBluRay ? config.CaseModThreejsColorModeDvd
                 : isUhd ? config.CaseModThreejsColorModeUhd
                 : config.CaseModThreejsColorModeBluRay;

        // Upstream implements "Back Spine" for the Blu-ray shell only
        // (onlyBack && M.name === 'bluray'). Rather than offer a setting that
        // silently does nothing on a DVD, it falls back to the next strongest
        // configured mode. Remove this line the day upstream extends
        // onlyBack to the DVD shell - nothing else has to change.
        if (!isBluRay && string.Equals(mode, "BackSpine", StringComparison.Ordinal))
        {
            mode = "FullShell";
        }

        // Only the three values the page offers; anything else (empty, an unknown word from an
        // imported backup) is Original - the client would otherwise tint for any non-"Original" word.
        if (mode is not ("FullShell" or "BackSpine"))
        {
            mode = "Original";
        }

        return new Presentation(shell, band, mark, isUhd, mode);
    }

    private static bool IsLargeFile(Movie movie)
        => movie.Size is long size && size > IsoSizeThresholdBytes;

    private enum Tier
    {
        Dvd,
        HighDefinition,
        Uhd
    }

    /// <summary>
    /// The same "fits within" ceiling system the flat case textures use
    /// (a replica of Jellyfin's internal MediaStream.GetResolutionText), but
    /// collapsed onto the only question this case has to answer: DVD, HD or
    /// 4K. Kept separate from CaseModController.ResolveMovieTextureKey on
    /// purpose - that method also carries the 3d and p special cases, which
    /// must not change while a shipped feature depends on them.
    /// </summary>
    private static Tier ResolutionTier(int width, int height)
    {
        if (width <= 1024 && height <= 576)
        {
            // 480p / 540p / 576p - everything a DVD could hold.
            return Tier.Dvd;
        }

        if (width <= 2560 && height <= 1440)
        {
            // 720p / 1080p.
            return Tier.HighDefinition;
        }

        return Tier.Uhd;
    }
}

/// <summary>
/// What the spine can be printed with, resolved from the item. Every piece is
/// nullable on purpose: a missing one is a normal state, not an error, and the
/// badge column closes the gap where it would have stood.
/// </summary>
public static class ThreejsSpine
{
    /// <summary>
    /// The studio pack ships 3012 logos named after the studio. The lookup is
    /// deliberately dumb - exact name, then the name without a trailing
    /// ", Inc."-style suffix - because a fuzzy match that picks the WRONG
    /// studio is worse than no logo at all, and no logo is a state the case
    /// already handles.
    /// </summary>
    public static string? StudioAsset(IReadOnlyList<string> studios, string assetRoot)
    {
        if (studios is null)
        {
            return null;
        }

        foreach (var studio in studios)
        {
            if (string.IsNullOrWhiteSpace(studio))
            {
                continue;
            }

            var name = studio.Trim();
            foreach (var candidate in new[] { name, StripSuffix(name) })
            {
                if (string.IsNullOrEmpty(candidate))
                {
                    continue;
                }

                var file = Path.Combine(assetRoot, "studio-logos", candidate + ".png");
                if (File.Exists(file))
                {
                    return "studio-logos/" + candidate + ".png";
                }
            }
        }

        return null;
    }

    private static string StripSuffix(string name)
    {
        var cut = name.IndexOf(',', StringComparison.Ordinal);
        return cut > 0 ? name[..cut].Trim() : string.Empty;
    }
}

/// <summary>
/// The four icons of the back cover's flag row, chosen from the 279 that ship
/// with the plugin. Upstream reads them out of an ffprobe sidecar; here they
/// come from Jellyfin's own MediaStreams, which is the same information from a
/// different source.
/// Every one of them may be null. That is not an error and not a gap: the row
/// closes around a missing icon instead of leaving a hole.
/// </summary>
public static class ThreejsFlags
{
    /// <summary>The aspect ratios the pack has a plate for, as hundredths.</summary>
    private static readonly int[] AspectPlates =
    {
        119, 133, 137, 143, 144, 150, 156, 157, 166, 167, 175, 177, 178, 181, 185,
        200, 220, 221, 233, 235, 237, 239, 240, 255, 256, 259, 266, 267, 276, 300, 400
    };

    public static string? Aspect(int width, int height, string assetRoot)
    {
        if (width <= 0 || height <= 0)
        {
            return null;
        }

        // Nearest plate, not an exact match: a 1920x816 film is 2.3529, and the
        // pack's nearest plate is 2.35 - refusing it because the number is not
        // identical would drop an icon the viewer expects to see.
        var ratio = (int)Math.Round(width * 100.0 / height);
        var best = AspectPlates.OrderBy(p => Math.Abs(p - ratio)).First();
        if (Math.Abs(best - ratio) > 12)
        {
            return null;   // nothing in the pack is close enough to be honest about
        }

        var name = (best / 100) + "." + (best % 100).ToString("00", CultureInfo.InvariantCulture);
        return Exists(assetRoot, "aspectratio", name);
    }

    public static string? Resolution(int height, string assetRoot)
    {
        var name = height switch
        {
            >= 4320 => "8k",
            >= 2160 => "4k",
            >= 1000 => "1080",
            >= 700 => "720",
            >= 560 => "576",
            >= 520 => "540",
            >= 460 => "480",
            > 0 => "288",
            _ => null
        };
        return name is null ? null : Exists(assetRoot, "videoresolution", name);
    }

    /// <summary>
    /// The rating plate for an item, from the PORTED Aeon Tajo Omega table.
    ///
    /// Our 154 plates ARE that skin's 154 plates - same names, one to one - so
    /// its `VideoRatingFlagVar` is the reference implementation for them, and
    /// it is ported rather than re-derived. The table is machine-generated from
    /// the skin's own variables.xml so that no rule can be lost, reworded or
    /// reordered by hand.
    ///
    /// ORDER IS THE ALGORITHM. The rules are tried top to bottom and the first
    /// match wins, which is the only thing that keeps "PG-13" off the PG plate,
    /// "TV-PG" off both, "12A" off the 12, and "MA15" off the M. The bare age
    /// plates at the very bottom are the deliberate last resort, never a first
    /// guess. Reading the digits out of the rating instead can pick the wrong plate
    /// for an American value, which is the worse failure because it looks
    /// right.
    ///
    /// The one correction to their table: they have CA:PG and CA:G mapped to
    /// each other's plates. That is plainly a typo and is corrected here.
    /// </summary>
    public static string? Mpaa(string? officialRating, string assetRoot, string? countryCode)
    {
        if (string.IsNullOrWhiteSpace(officialRating))
        {
            return null;
        }

        var raw = Canonical(Unprefix(officialRating.Trim()));
        var hit = MatchPlate(raw, assetRoot);
        if (hit is not null)
        {
            return hit;
        }

        // Second pass, only if the table found nothing: the server's own country spliced in
        // front of a value that carried none. Jellyfin writes American ratings
        // bare and everything else with a country, so a bare value that got
        // this far is either American - already tried - or one whose country
        // only the server knows.
        if (!raw.Contains(':', StringComparison.Ordinal)
            && CountryIndex.TryGetValue(Squash(countryCode), out var iso))
        {
            var table = TableCode(iso);
            if (table.Length > 0)
            {
                hit = MatchPlate(table + ":" + raw, assetRoot);
            }
        }

        return hit;
    }

    /// <summary>
    /// Scrapers very commonly store the MPAA rating with its sentence prefix -
    /// "Rated R", "Rated: PG-13", "Rated X" - because that is how the rating is
    /// WRITTEN on the certificate ("Rated R: Restricted"). It has to come off
    /// before the table sees the value, and here is why it is not optional:
    ///
    ///   their us_r rule is  Contains("Rated") + Contains("R") + !"unrated"
    ///   and the word "Rated" CONTAINS an R.
    ///
    /// So every value beginning with "Rated" that no earlier rule caught lands
    /// on the R plate: "Rated X" would become us_r, and so would any future
    /// American rating that is not already in the table.
    /// Most of them are only saved by coming earlier in the order, which is
    /// luck rather than design.
    ///
    /// Two differences from Jellyfin's own version of this (LocalizationManager
    /// .GetRatingLevel), both deliberate:
    ///   - the prefix is stripped only at the START. Jellyfin replaces it
    ///     anywhere in the string, which turns "Not Rated" into "Not " - it
    ///     gets away with it only because it tests its unrated list first.
    ///   - the unrated values are checked first ANYWAY, so "NR", "Not Rated",
    ///     "Unrated" and "N/A" reach the table with their own spelling intact.
    /// </summary>
    private static string Unprefix(string raw)
    {
        // Jellyfin's own list, verbatim: Emby.Server.Implementations/
        // Localization/LocalizationManager.cs, _unratedValues.
        foreach (var unrated in new[] { "n/a", "unrated", "not rated", "nr" })
        {
            if (string.Equals(raw, unrated, StringComparison.OrdinalIgnoreCase))
            {
                return raw;
            }
        }

        if (!raw.StartsWith("Rated", StringComparison.OrdinalIgnoreCase))
        {
            return raw;
        }

        // Everything between the word and the value: "Rated R", "Rated: R",
        // "Rated : R", "Rated-R".
        var rest = raw.Substring(5).TrimStart(' ', ':', '-', '\t');
        return rest.Length == 0 ? raw : rest;
    }

    /// <summary>
    /// ONE canonical form, applied to BOTH sides - the rating that came in AND
    /// every literal in the ported table. That is what makes this systematic
    /// rather than a list of spellings someone thought of.
    ///
    /// A rating is read as an optional COUNTRY followed by a VALUE. The country
    /// is resolved through .NET's own region data, so every ISO code, every
    /// three-letter code and every English or native country name resolves
    /// without being typed out here ("Germany", "Deutschland", "Brasil",
    /// "Nederland"). The value keeps only its letters and digits, which is what
    /// collapses ":", ": ", " ", "-" and "_" onto one form:
    ///
    ///     AU:M   AU M   AU_M   AU: M   AU-M   Australia:M   AUS-M   -> AU:M
    ///     FSK16  FSK 16  FSK-16  FSK_16  FSK:16  DE:16  Germany: 16 -> DE:16
    ///     PG-13  PG 13  PG_13                                       -> PG13
    ///
    /// Because the table's own literals go through the same function, a rule
    /// written "Australia:M" and a rule written "AU:M" become the same key, and
    /// a value written any of seven ways meets both.
    ///
    /// Why it has to be a country LIST rather than all of ISO-3166: PG, TV, NR,
    /// NC and MA are real country codes (Papua New Guinea, Tuvalu, Nauru, New
    /// Caledonia, Morocco). Resolving those would turn "PG-13" into "Papua New
    /// Guinea, value 13". So only the countries we actually ship plates for are
    /// resolvable, and none of those codes is a rating token.
    /// </summary>
    private static string Canonical(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return string.Empty;
        }

        string? country = null;
        var value = raw.Trim();

        // C) The MPA writes its ratings as a sentence - "Rated R: Restricted",
        // "Rated G: General audiences - All ages admitted" - and scrapers store
        // the sentence. What follows the colon is prose, not part of the code.
        //
        // It is only cut when the tail cannot BE a code: longer than four
        // characters and carrying a letter. That is what keeps "PG:13",
        // "TV:MA", "GB:12A", "JP:PG12" and "HK:IIB" whole, where a blunter rule
        // would have thrown away half of each of them.
        var mark = value.IndexOf(':', StringComparison.Ordinal);
        if (mark > 0)
        {
            var sentenceHead = value.Substring(0, mark).Trim();
            var sentenceTail = value.Substring(mark + 1).Trim();
            if (sentenceTail.Length > 4 && sentenceTail.Any(char.IsLetter)
                && !CountryIndex.ContainsKey(Squash(sentenceHead)))
            {
                value = sentenceHead;
            }
        }

        // The country marker is stripped REPEATEDLY, because a value can carry
        // more than one. Jellyfin's de.csv lists "FSK-0" and "FSK 0", and its
        // TMDB provider prefixes every non-American country - so a German
        // rating arrives as "DE-FSK-0", naming the country twice. Resolving
        // once would leave "FSK 0" standing as the value and neither spelling
        // would match.
        //
        // Each pass must CONSUME a marker or stop, so the loop cannot spin; the
        // four-pass cap is belt and braces against a future change breaking
        // that property silently.
        for (var pass = 0; pass < 4; pass++)
        {
            var resolved = TakeCountry(ref value);
            if (resolved is null)
            {
                break;
            }

            country = resolved;
        }
        var squashed = Squash(value);
        if (country is null)
        {
            return squashed;
        }

        // The colon SURVIVES squashing, and only here. It is the one character
        // that says "what came before was a country", and a rule that tests for
        // it must not be satisfied by those letters appearing inside an
        // unrelated word.
        

        // The United States is the one country written WITHOUT a prefix -
        // Jellyfin stores "R", never "US-R" - so its marker is removed.
        var table = TableCode(country);
        return table.Length == 0 ? squashed : table + ":" + squashed;
    }

    /// <summary>
    /// Takes ONE leading country marker off the value and returns its ISO code,
    /// or null if the value does not start with a country. The value is only
    /// modified when a country was actually found, so a caller can loop until
    /// this returns null.
    /// </summary>
    private static string? TakeCountry(ref string value)
    {
        var cut = value.IndexOfAny(new[] { ':', ' ', '_', '-' });

        if (cut < 0)
        {
            // No separator at all: a body glued to its number, "FSK16".
            var split = 0;
            while (split < value.Length && !char.IsDigit(value[split]))
            {
                split++;
            }

            if (split > 0 && split < value.Length
                && CountryIndex.TryGetValue(Squash(value.Substring(0, split)), out var glued))
            {
                value = value.Substring(split);
                return glued;
            }

            return null;
        }

        if (cut == 0)
        {
            return null;
        }

        var head = value.Substring(0, cut).Trim();
        var rest = value.Substring(cut).TrimStart(':', ' ', '_', '-').Trim();

        // An EMPTY rest is allowed, and it matters: several of the table's own
        // rules are the bare marker "NO:" or "IT:", with the value left to a
        // second term.
        if (CountryIndex.TryGetValue(Squash(head), out var byHead))
        {
            value = rest;
            return byHead;
        }

        // A two-word country written WITHOUT a colon ("Great Britain - 15",
        // "New Zealand R16"): the head above was only half a name.
        var second = value.IndexOfAny(new[] { ':', ' ', '_', '-' }, cut + 1);
        if (second > cut + 1
            && CountryIndex.TryGetValue(Squash(value.Substring(0, second).Trim()), out var byPair))
        {
            value = value.Substring(second).TrimStart(':', ' ', '_', '-').Trim();
            return byPair;
        }

        // Everything before the colon, for a name the separator run split.
        var colon = value.IndexOf(':', StringComparison.Ordinal);
        if (colon <= 0)
        {
            return null;
        }

        var name = value.Substring(0, colon).Trim();
        var tail = value.Substring(colon + 1).Trim();
        if (tail.Length == 0)
        {
            return null;
        }

        if (CountryIndex.TryGetValue(Squash(name), out var byName))
        {
            value = tail;
            return byName;
        }

        // An UNRECOGNISED country prefix is DROPPED rather than passed on.
        // "Portugal:12" carries no plate of ours, and handing the whole string
        // to the table would let a loose rule catch it on a letter inside the
        // country's NAME - "Germany: 16" would produce the American G plate.
        //
        // Only a head that could plausibly BE a country name is dropped:
        // letters, and at least three of them. Every country we know is
        // resolved above, so an unresolved head of two letters is far more
        // likely a rating - and it is: PG, NC and TV are exactly that.
        // Dropping those would turn "PG:13" into the bare age plate 13, "NC:17"
        // into 17 and "TV:MA" into nothing at all.
        if (name.Length >= 3 && name.All(char.IsLetter))
        {
            value = tail;
        }

        return null;   // nothing was resolved either way, so the loop ends
    }

    /// <summary>Letters and digits only, upper case. Unicode-aware, because four Korean rules are written in Hangul.</summary>
    private static string Squash(string? s)
    {
        if (string.IsNullOrEmpty(s))
        {
            return string.Empty;
        }

        var sb = new StringBuilder(s.Length);
        foreach (var ch in s)
        {
            if (char.IsLetterOrDigit(ch))
            {
                sb.Append(char.ToUpperInvariant(ch));
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// The table's own spelling for a country: it says UK where the standard
    /// says GB, and the United States has no prefix at all.
    /// </summary>
    private static string TableCode(string iso) => iso switch
    {
        "GB" => "UK",
        "US" => string.Empty,
        _ => iso,
    };

    /// <summary>
    /// The countries we ship plates for, as ISO codes. Derived from the plate
    /// file names themselves (au_*, br_*, ... plus the NL- and bare-age sets).
    /// </summary>
    private static readonly string[] PackCodes =
    {
        "AU", "BR", "CA", "DE", "ES", "FI", "FR", "GB", "HK", "HU", "IT",
        "JP", "KR", "NL", "NO", "NZ", "RU", "SA", "SK", "TR", "TW", "US", "VN",
    };

    /// <summary>
    /// Every name those countries answer to, taken from .NET's region data
    /// rather than typed out - English names, native names, two- and
    /// three-letter codes - plus the rating BODIES, which are not countries at
    /// all but are what scrapers actually write.
    /// </summary>
    private static readonly Dictionary<string, string> CountryIndex = BuildCountryIndex();

    private static Dictionary<string, string> BuildCountryIndex()
    {
        var wanted = new HashSet<string>(PackCodes, StringComparer.Ordinal);
        var index = new Dictionary<string, string>(StringComparer.Ordinal);

        void Add(string? name, string iso)
        {
            var key = Squash(name);
            if (key.Length > 1)
            {
                index[key] = iso;
            }
        }

        foreach (var culture in CultureInfo.GetCultures(CultureTypes.SpecificCultures))
        {
            RegionInfo region;
            try
            {
                region = new RegionInfo(culture.Name);
            }
            catch (ArgumentException)
            {
                continue;   // a culture without a region, e.g. an invariant one
            }

            var iso = region.TwoLetterISORegionName.ToUpperInvariant();
            if (!wanted.Contains(iso))
            {
                continue;
            }

            Add(region.TwoLetterISORegionName, iso);
            Add(region.ThreeLetterISORegionName, iso);
            Add(region.EnglishName, iso);
            Add(region.NativeName, iso);
        }

        // Rating bodies and the names ISO does not carry. These are the ones
        // that actually appear in scraped data and in the Kodi skins.
        Add("FSK", "DE");          // Freiwillige Selbstkontrolle
        Add("USK", "DE");          // the games body, seen on some scrapes
        Add("BBFC", "GB");
        Add("UK", "GB");           // what every skin and IMDb write
        Add("BRITAIN", "GB");
        Add("GREATBRITAIN", "GB");
        Add("ENGLAND", "GB");
        Add("MPAA", "US");
        Add("AMERICA", "US");
        Add("USA", "US");
        Add("CSA", "FR");          // the French body, as the icon names carry it
        Add("EIRIN", "JP");
        Add("OFLC", "AU");
        Add("ACB", "AU");
        Add("KIJKWIJZER", "NL");
        Add("HOLLAND", "NL");
        Add("RUSSIAN", "RU");      // the skin writes the adjective, not the name
        Add("KMRB", "KR");
        // .NET calls it "Hong Kong SAR", so the plain name needs saying.
        Add("HONGKONG", "HK");
        Add("SOUTHKOREA", "KR");
        return index;
    }

    private static string? MatchPlate(string raw, string assetRoot)
    {
        // A) The American rules carry no country marker of their own - they
        // test for "G", "X", "PG" in the bare value - so against a value that
        // DOES name a country they fire on any letter that happens to be
        // present. Measured against Jellyfin's own 331 rating values:
        //
        //     GB-G, UK-G, IE-G      -> us_g      (the value contains a G)
        //     AU-X, CO-X, FR-X      -> us_x
        //     IE-PG, IE-12PG        -> us_pg
        //     SK-NR                 -> us_nr
        //     DE-Infoprogramm       -> us_g
        //
        // A value that names a country belongs to that country's block. The
        // exception is Canada, whose own rating table (Jellyfin's ca.csv)
        // genuinely carries the American television ratings, because Canada
        // broadcasts American television.
        var carriesCountry = raw.Contains(':', StringComparison.Ordinal);
        var americanAllowed = !carriesCountry || raw.StartsWith("CA:", StringComparison.Ordinal);

        foreach (var rule in RatingRules)
        {
            if (!americanAllowed && rule.Plate.StartsWith("us_", StringComparison.Ordinal))
            {
                continue;
            }

            foreach (var alt in rule.Alts)
            {
                var all = true;
                foreach (var term in alt)
                {
                    if (!term.Matches(raw))
                    {
                        all = false;
                        break;
                    }
                }

                if (!all)
                {
                    continue;
                }

                // A plate we do not actually ship must not stop the search:
                // the tail of the table is a generic age badge, which is a far
                // better answer than nothing at all.
                var hit = Exists(assetRoot, "mpaa", rule.Plate);
                if (hit is not null)
                {
                    return hit;
                }
            }
        }

        return null;
    }

    /// <summary>One test against the rating text. Case-insensitive, as Kodi's own String.Contains is.</summary>
    private readonly struct RatingTerm
    {
        private readonly char _kind;          // C ontains, E quals, N ot, A ny-of
        private readonly string[] _text;

        public RatingTerm(char kind, string[] text)
        {
            _kind = kind;
            _text = text;
        }

        // Ordinal, not OrdinalIgnoreCase: both sides came out of Canonical()
        // already folded to upper case, so a case-insensitive compare would
        // only cost time and hide a canonicalisation that failed to run.
        public bool Matches(string raw) => _kind switch
        {
            'E' => string.Equals(raw, _text[0], StringComparison.Ordinal),
            'N' => !raw.Contains(_text[0], StringComparison.Ordinal),
            'A' => _text.Any(t => t.Length > 0 && raw.Contains(t, StringComparison.Ordinal)),
            _ => _text[0].Length > 0 && raw.Contains(_text[0], StringComparison.Ordinal),
        };
    }

    private readonly struct RatingRule
    {
        public RatingRule(string plate, RatingTerm[][] alts)
        {
            Plate = plate;
            Alts = alts;
        }

        public string Plate { get; }

        public RatingTerm[][] Alts { get; }
    }

    // Every literal in the table below goes through the SAME Canonical() the
    // incoming rating does. That is the whole mechanism: a rule written
    // "Australia:M" and one written "AU:M" become one key, and a rating written
    // any of seven ways meets both. Nothing downstream has to know about
    // separators or country spellings, because by then there are none left.
    private static RatingTerm Has(string t) => new('C', new[] { Canonical(t) });

    private static RatingTerm Eq(string t) => new('E', new[] { Canonical(t) });

    private static RatingTerm Not(string t) => new('N', new[] { Canonical(t) });

    private static RatingTerm Any(params string[] t) => new('A', Array.ConvertAll(t, Canonical));

    private static RatingTerm[] Alt(params RatingTerm[] terms) => terms;

    private static RatingRule Rule(string plate, params RatingTerm[][] alts) => new(plate, alts);

    /// <summary>
    /// The 154 rules, in the skin's own order. Generated, not typed.
    /// </summary>
    private static readonly RatingRule[] RatingRules =
    {
        Rule("au_g", Alt(Has("AU:G")), Alt(Has("Australia:G")), Alt(Eq("AU-Exempt"))),
        Rule("au_ma15", Alt(Has("AU:MA15")), Alt(Has("Australia:MA15"))),
        Rule("au_m", Alt(Has("AU:M")), Alt(Has("Australia:M"))),
        Rule("au_pg", Alt(Has("AU:PG")), Alt(Has("Australia:PG"))),
        Rule("au_r18", Alt(Has("AU:R18")), Alt(Has("Australia:R18")), Alt(Eq("AU-R"))),
        Rule("au_x18", Alt(Has("AU:X18")), Alt(Has("Australia:X18")), Alt(Eq("AU-X"))),
        Rule("br_l", Alt(Has("BR:L")), Alt(Has("Brazil:L")), Alt(Eq("BR-AL"))),
        Rule("br_10", Alt(Has("BR:10")), Alt(Has("Brazil:10"))),
        Rule("br_12", Alt(Has("BR:12")), Alt(Has("Brazil:12"))),
        Rule("br_14", Alt(Has("BR:14")), Alt(Has("Brazil:14"))),
        Rule("br_16", Alt(Has("BR:16")), Alt(Has("Brazil:16"))),
        Rule("br_18", Alt(Has("BR:18")), Alt(Has("Brazil:18"))),
        Rule("br_er", Alt(Has("BR:ER")), Alt(Has("Brazil:ER"))),
        Rule("ca_14a", Alt(Has("CA:14A")), Alt(Has("Canada:14A"))),
        Rule("ca_18a", Alt(Has("CA:18A")), Alt(Has("Canada:18A"))),
        Rule("ca_g", Alt(Has("CA:G")), Alt(Has("Canada:G")), Alt(Eq("CA-E"))),
        Rule("ca_pg", Alt(Has("CA:PG")), Alt(Has("Canada:PG"))),
        Rule("ca_r", Alt(Has("CA:R")), Alt(Has("Canada:R")), Alt(Eq("CA-A"))),
        Rule("de_0", Alt(Has("FSK0")), Alt(Has("FSK 0")), Alt(Has("FSK-0")), Alt(Has("DE:0")), Alt(Has("FSK o.A.")), Alt(Eq("o.A.")), Alt(Has("ab 0")), Alt(Has("Germany:0")), Alt(Has("Germany:o.Al.")), Alt(Has("ohne Altersbeschränkung")), Alt(Has("ohne Altersbeschraenkung")), Alt(Has("Infoprogramm")), Alt(Has("Lehrprogramm")), Alt(Has("Educational"))),
        Rule("de_6", Alt(Has("FSK6")), Alt(Has("FSK 6")), Alt(Has("FSK-6")), Alt(Has("DE:6")), Alt(Has("ab 6")), Alt(Has("Germany:6"))),
        Rule("de_12", Alt(Has("FSK12")), Alt(Has("FSK 12")), Alt(Has("FSK-12")), Alt(Has("DE:12")), Alt(Has("ab 12")), Alt(Has("Germany:12"))),
        Rule("de_16", Alt(Has("FSK16")), Alt(Has("FSK 16")), Alt(Has("FSK-16")), Alt(Has("DE:16")), Alt(Has("ab 16")), Alt(Has("Germany:16"))),
        Rule("de_18", Alt(Has("FSK18")), Alt(Has("FSK 18")), Alt(Has("FSK-18")), Alt(Has("DE:18")), Alt(Has("ab 18")), Alt(Has("Germany:18")), Alt(Has("Keine Jugendfreigabe")), Alt(Has("Nicht freigegeben unter 18"))),
        Rule("es_7i", Alt(Has("ES:7I")), Alt(Eq("Spain:7I"))),
        Rule("es_7", Alt(Has("ES:7")), Alt(Eq("Spain:7"))),
        Rule("es_12", Alt(Has("ES:12")), Alt(Eq("Spain:12"))),
        Rule("es_16", Alt(Has("ES:16")), Alt(Eq("Spain:16"))),
        Rule("es_18", Alt(Has("ES:18")), Alt(Eq("Spain:18"))),
        Rule("es_ai", Alt(Has("ES:AI")), Alt(Eq("Spain:AI")), Alt(Has("APTA"))),
        Rule("es_a", Alt(Has("ES:A")), Alt(Eq("Spain:A")), Alt(Eq("ES-ERI")), Alt(Eq("ES-TP")), Alt(Eq("ES-0+"))),
        Rule("es_x", Alt(Has("ES:X")), Alt(Eq("Spain:X"))),
        Rule("fi_7", Alt(Has("FI:"), Has("7"))),
        Rule("fi_12", Alt(Has("FI:"), Has("12"))),
        Rule("fi_16", Alt(Has("FI:"), Has("16"))),
        Rule("fi_18", Alt(Has("FI:"), Has("18"))),
        Rule("fi_s", Alt(Has("FI:"), Has("S")), Alt(Eq("FI-T"))),
        Rule("fr_10", Alt(Has("FR:"), Has("10"))),
        Rule("fr_12", Alt(Has("FR:"), Has("12"))),
        Rule("fr_16", Alt(Has("FR:"), Has("16"))),
        Rule("fr_18", Alt(Has("FR:"), Has("18")), Alt(Eq("FR-X"))),
        Rule("fr_u", Alt(Has("FR:"), Has("U")), Alt(Eq("FR-TP")), Alt(Eq("FR-0+"))),
        Rule("gb_12a", Alt(Has("UK:"), Has("12A"))),
        Rule("gb_12", Alt(Has("UK:"), Has("12")), Alt(Eq("GB-Teen"))),
        Rule("gb_15", Alt(Has("UK:"), Has("15"))),
        Rule("gb_r18", Alt(Has("UK:"), Has("R18")), Alt(Eq("GB-Mature")), Alt(Eq("GB-Adult"))),
        Rule("gb_18", Alt(Has("UK:"), Has("18")), Alt(Eq("GB-Caution"))),
        Rule("gb_pg", Alt(Has("UK:"), Has("PG"))),
        Rule("gb_u", Alt(Eq("UK:U")), Alt(Eq("GB-All")), Alt(Eq("GB-E")), Alt(Eq("GB-G")), Alt(Eq("GB-0+"))),
        Rule("hk_III", Alt(Has("HK:"), Has("III"))),
        Rule("hk_IIb", Alt(Has("HK:"), Has("IIB"))),
        Rule("hk_IIa", Alt(Has("HK:"), Has("IIA"))),
        Rule("hk_II", Alt(Has("HK:"), Has("II"))),
        Rule("hk_I", Alt(Has("HK:"), Has("I"))),
        Rule("hu_x", Alt(Has("HU:"), Has("X"))),
        Rule("hu_kn", Alt(Has("HU:"), Has("KN"))),
        Rule("hu_18", Alt(Has("HU:"), Has("18"))),
        Rule("hu_16", Alt(Has("HU:"), Has("16"))),
        Rule("hu_12", Alt(Has("HU:"), Has("12"))),
        Rule("hu_6", Alt(Has("HU:"), Has("6"))),
        Rule("it_6", Alt(Has("IT:"), Has("6"))),
        Rule("it_14", Alt(Has("IT:"), Has("14"))),
        Rule("it_18", Alt(Has("IT:"), Has("18"))),
        Rule("it_t", Alt(Eq("IT:T"))),
        Rule("jp_r18", Alt(Has("JP:"), Has("18")), Alt(Eq("JP-D")), Alt(Eq("JP-Z"))),
        Rule("jp_r15", Alt(Has("JP:"), Has("15")), Alt(Eq("JP-C"))),
        Rule("jp_pg12", Alt(Has("JP:"), Has("12")), Alt(Eq("JP-B"))),
        Rule("jp_g", Alt(Has("JP:"), Has("G")), Alt(Eq("JP-A"))),
        Rule("kr_all", Alt(Has("KR:ALL")), Alt(Has("전체"))),
        Rule("kr_12", Alt(Has("KR:12")), Alt(Has("12세"))),
        Rule("kr_15", Alt(Has("KR:15")), Alt(Has("15세"))),
        Rule("kr_18", Alt(Has("KR:18")), Alt(Has("불가"))),
        Rule("NL-AL", Alt(Has("NL:"), Has("AL"))),
        Rule("NL-MG6", Alt(Has("NL:"), Has("MG6"))),
        Rule("NL-16", Alt(Has("NL:"), Has("16"))),
        Rule("NL-6", Alt(Has("NL:"), Has("6"))),
        Rule("NL-9", Alt(Has("NL:"), Has("9"))),
        Rule("NL-12", Alt(Has("NL:"), Has("12"))),
        Rule("NL-18", Alt(Has("NL:"), Has("18"))),
        Rule("no_6", Alt(Has("NO:"), Has("6"))),
        Rule("no_9", Alt(Has("NO:"), Has("9"))),
        Rule("no_12", Alt(Has("NO:"), Has("12"))),
        Rule("no_15", Alt(Has("NO:"), Has("15"))),
        Rule("no_18", Alt(Has("NO:"), Has("18")), Alt(Eq("NO-C"))),
        Rule("no_a", Alt(Has("NO:"), Has("A"))),
        Rule("nz_pg", Alt(Has("NZ:"), Has("PG"))),
        Rule("nz_g", Alt(Has("NZ:"), Has("G"))),
        Rule("nz_m", Alt(Has("NZ:"), Has("M"))),
        Rule("nz_r13", Alt(Has("NZ:"), Has("13"))),
        Rule("nz_r15", Alt(Has("NZ:"), Has("15"))),
        Rule("nz_r16", Alt(Has("NZ:"), Has("16"))),
        Rule("nz_r18", Alt(Has("NZ:"), Has("18"))),
        Rule("ru_0", Alt(Has("Russian:0")), Alt(Has("RU"), Has("0"))),
        Rule("ru_16", Alt(Has("Russian:16")), Alt(Has("RU"), Has("16"))),
        Rule("ru_12", Alt(Has("Russian:12")), Alt(Has("RU"), Has("12"))),
        Rule("ru_6", Alt(Has("Russian:6")), Alt(Has("RU"), Has("6"))),
        Rule("ru_18", Alt(Has("Russian:18")), Alt(Has("RU"), Has("18"))),
        Rule("sa_pg12", Alt(Has("SA:"), Has("PG"), Has("12"))),
        Rule("sa_pg15", Alt(Has("SA:"), Has("PG"), Has("15"))),
        Rule("sa_pg", Alt(Has("SA:"), Has("PG"))),
        Rule("sa_g", Alt(Has("SA:"), Has("G"))),
        Rule("sa_r12", Alt(Has("SA:"), Has("R"), Has("12"))),
        Rule("sa_r15", Alt(Has("SA:"), Has("R"), Has("15"))),
        Rule("sa_r18", Alt(Has("SA:"), Has("R"), Has("18"))),
        Rule("sk_7", Alt(Has("SK:"), Has("7"))),
        Rule("sk_12", Alt(Has("SK:"), Has("12"))),
        Rule("sk_15", Alt(Has("SK:"), Has("15"))),
        Rule("sk_18", Alt(Has("SK:"), Has("18"))),
        Rule("sk_t", Alt(Has("SK:"), Has("T"))),
        Rule("sk_u", Alt(Has("SK:"), Has("U")), Alt(Eq("SK-NR"))),
        Rule("tr_18+", Alt(Has("TR:"), Has("18"))),
        Rule("tr_16+", Alt(Has("TR:"), Has("16"))),
        Rule("tr_13+", Alt(Has("TR:"), Not("A"), Has("13"))),
        Rule("tr_13a", Alt(Has("TR:"), Has("A"), Has("13"))),
        Rule("tr_10+", Alt(Has("TR:"), Not("A"), Has("10"))),
        Rule("tr_10a", Alt(Has("TR:"), Has("A"), Has("10"))),
        Rule("tr_6+", Alt(Has("TR:"), Not("A"), Has("6"))),
        Rule("tr_6a", Alt(Has("TR:"), Has("A"), Has("6"))),
        Rule("tw_0", Alt(Has("TW:"), Has("0"))),
        Rule("tw_6", Alt(Has("TW:"), Has("6"))),
        Rule("tw_12", Alt(Has("TW:"), Has("12"))),
        Rule("tw_15", Alt(Has("TW:"), Has("15"))),
        Rule("tw_18", Alt(Has("TW:"), Has("18"))),
        Rule("vn_c13", Alt(Has("VN:"), Has("13"))),
        Rule("vn_c16", Alt(Has("VN:"), Has("16"))),
        Rule("vn_c18", Alt(Has("VN:"), Has("18"))),
        Rule("vn_p", Alt(Has("VN:"), Has("P"))),
        Rule("us_TV-PG", Alt(Has("TV"), Has("PG"))),
        Rule("us_TV-G", Alt(Has("TV"), Has("G"))),
        Rule("us_TV-y7fv", Alt(Has("TV"), Has("Y7FV")), Alt(Has("TV"), Has("Y7-FV"))),
        Rule("us_TV-y7", Alt(Has("TV"), Has("Y7"))),
        Rule("us_TV-y", Alt(Has("TV"), Has("Y"))),
        Rule("us_TV-14", Alt(Has("TV"), Has("14"))),
        Rule("us_TV-MA", Alt(Has("TV"), Has("MA"))),
        Rule("us_nr", Alt(Eq("NR")), Alt(Eq("Not rated"))),
        Rule("us_pg-13", Alt(Eq("PG13"))),
        Rule("us_pg", Alt(Eq("PG")), Alt(Eq("M")), Alt(Eq("GP"))),
        Rule("us_g", Alt(Eq("G")), Alt(Eq("Approved"))),
        Rule("us_nc-17", Alt(Eq("NC17"))),
        Rule("us_r", Alt(Eq("R"))),
        Rule("us_unrated", Alt(Has("unrated")), Alt(Eq("UR"))),
        Rule("us_x", Alt(Eq("X")), Alt(Eq("TV-X")), Alt(Eq("TV-AO"))),
        Rule("18", Alt(Has("18"))),
        Rule("17", Alt(Has("17"))),
        Rule("16", Alt(Has("16"))),
        Rule("15", Alt(Has("15"))),
        Rule("14", Alt(Has("14"))),
        Rule("13", Alt(Has("13"))),
        Rule("12", Alt(Has("12"))),
        Rule("11", Alt(Has("11"))),
        Rule("10", Alt(Has("10"))),
        Rule("9", Alt(Has("9"))),
        Rule("8", Alt(Has("8"))),
        Rule("7", Alt(Has("7"))),
        Rule("6", Alt(Has("6"))),
    };

    public static string? Codec(string? codec, string assetRoot)
    {
        if (string.IsNullOrWhiteSpace(codec))
        {
            return null;
        }

        var c = codec.Trim().ToLowerInvariant();
        return Exists(assetRoot, "videocodec", c)
            ?? (c == "h264" ? Exists(assetRoot, "videocodec", "avc") : null)
            ?? (c == "h265" ? Exists(assetRoot, "videocodec", "hevc") : null);
    }

    private static string? Exists(string assetRoot, string folder, string name)
    {
        // The path the CLIENT will ask for, which includes the pack folder;
        // without it every icon request would 404.
        var rel = "media-flags/" + folder + "/" + name + ".png";
        return File.Exists(Path.Combine(assetRoot, "media-flags", folder, name + ".png")) ? rel : null;
    }
}
