using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// The Case mix settings the draw needs - the 44 CaseModMix*
/// fields under their config names, plus the four existing switches the mix
/// hangs on. A plain class so the draw can be tested without Jellyfin;
/// <c>CaseMixConfig</c> copies it out of the real
/// configuration. Defaults are the config defaults.
/// </summary>
public sealed class CaseMixSettings
{
    public bool CaseModShowOnMovies { get; set; } = true;
    public bool CaseModShowOnSets { get; set; } = true;
    public bool CaseModShowOnTvShows { get; set; } = true;
    public bool CaseModThreejsEnabled { get; set; }

    public bool CaseModMixEnabled { get; set; }

    public string CaseModMixNewDrawAfter { get; set; } = "60s";

    public bool CaseModMixNoCaseSizeMovies { get; set; }
    public bool CaseModMixNoCaseSizeSets { get; set; }
    public bool CaseModMixNoCaseSizeTvShows { get; set; }
    public int CaseModMixNoCaseSize { get; set; } = 108;
    public string CaseModMixNoCaseAnchor { get; set; } = "BottomCenter";

    public bool CaseModMixMoviesClear { get; set; }
    public bool CaseModMixMoviesVortex { get; set; }
    public bool CaseModMixMoviesVivaElite { get; set; }
    public bool CaseModMixMoviesVivaElite3d { get; set; }
    public bool CaseModMixMoviesThreejs { get; set; }
    public bool CaseModMixMoviesNoCase { get; set; }

    public bool CaseModMixSetsClear { get; set; }
    public bool CaseModMixSetsVortex { get; set; }
    public bool CaseModMixSetsVivaElite { get; set; }
    public bool CaseModMixSetsVivaElite3d { get; set; }
    public bool CaseModMixSetsNoCase { get; set; }

    public bool CaseModMixTvShowsClear { get; set; }
    public bool CaseModMixTvShowsVortex { get; set; }
    public bool CaseModMixTvShowsVivaElite { get; set; }
    public bool CaseModMixTvShowsVivaElite3d { get; set; }
    public bool CaseModMixTvShowsNoCase { get; set; }

    public bool CaseModMixChainCasesCustomPoster { get; set; } = true;
    public bool CaseModMixChainCasesAnimatedPoster { get; set; } = true;
    public bool CaseModMixChainCasesExtraposter { get; set; } = true;
    public bool CaseModMixChainNoCaseCustomPoster { get; set; }
    public bool CaseModMixChainNoCaseAnimatedPoster { get; set; } = true;
    public bool CaseModMixChainNoCaseExtraposter { get; set; } = true;

    public bool CaseModMixColorClearOriginal { get; set; } = true;
    public bool CaseModMixColorClearFullShell { get; set; }
    public bool CaseModMixColorVortexOriginal { get; set; } = true;
    public bool CaseModMixColorVortexFullShell { get; set; }
    public bool CaseModMixColorVivaEliteOriginal { get; set; } = true;
    public bool CaseModMixColorVivaEliteFullShell { get; set; }
    public bool CaseModMixColorVivaElite3dOriginal { get; set; } = true;
    public bool CaseModMixColorVivaElite3dFullShell { get; set; }

    public string CaseModMixBlendClear { get; set; } = "DominantDark";
    public string CaseModMixBlendVortex { get; set; } = "DominantDark";
    public string CaseModMixBlendVivaElite { get; set; } = "DominantDark";
    public string CaseModMixBlendVivaElite3d { get; set; } = "DominantDark";

    public bool CaseModMixColorThreejsDvdOriginal { get; set; } = true;
    public bool CaseModMixColorThreejsDvdFullShell { get; set; }
    public bool CaseModMixColorThreejsBluRayOriginal { get; set; } = true;
    public bool CaseModMixColorThreejsBluRayFullShell { get; set; }
    public bool CaseModMixColorThreejsBluRayBackSpine { get; set; }
    public bool CaseModMixColorThreejsUhdOriginal { get; set; } = true;
    public bool CaseModMixColorThreejsUhdFullShell { get; set; }
    public bool CaseModMixColorThreejsUhdBackSpine { get; set; }

    public string CaseModMixBlendThreejs { get; set; } = "DominantDark";

    /// <summary>
    /// Which saved configuration these settings came from. Part of the window
    /// key, so saving the admin page never serves a draw the new settings
    /// would not allow.
    /// </summary>
    public int Stamp { get; set; }
}

/// <summary>One item's draw: the case (or No case) and how it looks.</summary>
public sealed class CaseMixDraw
{
    /// <summary>clearcases | vortexcases | vivaelitecases | vivaelite3dcases | threejs | nocase (No case: the plain poster).</summary>
    public string Outcome { get; set; } = string.Empty;

    /// <summary>Flat case: Original or FullShell. Null for threejs and nocase.</summary>
    public string? ColorMode { get; set; }

    /// <summary>The drawn type's own blend. Null for nocase.</summary>
    public string? Blend { get; set; }

    /// <summary>Three.js only: Original or FullShell - a DVD has no Back spine.</summary>
    public string? ThreejsDvd { get; set; }

    /// <summary>Three.js only: Original, FullShell or BackSpine.</summary>
    public string? ThreejsBluRay { get; set; }

    /// <summary>Three.js only: Original, FullShell or BackSpine.</summary>
    public string? ThreejsUhd { get; set; }
}

/// <summary>
/// The Case mix: per detail page, draw a case type - or No case - out of the
/// item kind's pool, and the look of that type out of its own ticked colour
/// variants.
///
/// The randomizer is a layer on top: <see cref="Draw"/> returns null whenever
/// the mix does not apply (switch off, the kind's Show-on box off, its pool
/// empty, nothing in it drawable), and the caller then behaves as without
/// the mix.
///
/// Five requests of one page (CaseMod, ThreejsCase, CustomPoster,
/// AnimatedPoster, Extraposter quickcheck) each ask for the draw, two of them
/// in parallel. They must agree, so the first one draws and the rest read it:
/// one entry per item, WebGL flag and saved configuration, kept for
/// <see cref="Window"/>. The entry is written through ConcurrentDictionary's
/// AddOrUpdate, which hands every racing caller the one value that was
/// stored - the memory-cache TryGet-then-Set used elsewhere in the plugin is
/// not atomic, and two parallel draws there could each win.
/// </summary>
public static class CaseMix
{
    /// <summary>How long an item keeps its draw by default: one minute.</summary>
    public static readonly TimeSpan Window = TimeSpan.FromSeconds(60);

    /// <summary>
    /// "Every visit" still has to hold for the one page view: its five requests
    /// arrive within a second or two and must agree. Ten seconds covers a slow
    /// server without a revisit feeling remembered.
    /// </summary>
    public static readonly TimeSpan VisitWindow = TimeSpan.FromSeconds(10);

    /// <summary>The window New draw after asks for; an unknown value is the default minute.</summary>
    public static TimeSpan WindowOf(CaseMixSettings s) => s.CaseModMixNewDrawAfter switch
    {
        "Visit" => VisitWindow,
        "30s" => TimeSpan.FromSeconds(30),
        "5m" => TimeSpan.FromMinutes(5),
        "1h" => TimeSpan.FromHours(1),
        "1d" => TimeSpan.FromDays(1),
        _ => Window
    };

    private static readonly string[] Blends = { "DominantDark", "DominantColorful", "Deep", "MaterialYou", "Accent", "TopRegion", "Vibrant" };

    private static readonly ConcurrentDictionary<(Guid Item, bool WebGl, int Stamp), (DateTime Created, CaseMixDraw Draw)> Drawn = new();

    /// <summary>
    /// The draw for one item, or null when the mix does not apply.
    /// <paramref name="kind"/> is Movie, BoxSet or Series; anything else has
    /// no case and gets null.
    /// </summary>
    public static CaseMixDraw? Draw(Guid itemId, string kind, bool webGl, CaseMixSettings s, DateTime nowUtc)
    {
        var pool = Pool(kind, webGl, s);
        if (pool.Count == 0)
        {
            return null;
        }

        var window = WindowOf(s);
        var entry = Drawn.AddOrUpdate(
            (itemId, webGl, s.Stamp),
            _ => (nowUtc, Roll(pool, s)),
            // Only an entry OLDER than the window is replaced. Every request
            // reads its own clock, so the one that reads the draw back may be
            // a few milliseconds "earlier" than the one that stored it - that
            // negative age is fresh, not stale; a ">= Created" guard would
            // re-roll exactly then and the page's requests would disagree.
            (_, old) => nowUtc - old.Created < window ? old : (nowUtc, Roll(pool, s)));

        // Entries of an older saved configuration can never be read again
        // (their Stamp is gone), and a day-long window can grow with the library:
        // swept on insert once the dictionary is large.
        if (Drawn.Count > 1024)
        {
            foreach (var stale in Drawn.Where(e => e.Key.Stamp != s.Stamp || nowUtc - e.Value.Created >= window).Select(e => e.Key).ToList())
            {
                Drawn.TryRemove(stale, out _);
            }
        }

        return entry.Draw;
    }

    /// <summary>
    /// The poster size a page gets when No case is drawn - the
    /// poster's CURRENT size (Poster size included) times the compensation, with
    /// the compensation's own anchor. Anything else, or a kind whose tick is off,
    /// or No case not counting at all (standing alone, greyed): unchanged.
    /// </summary>
    public static (int Pct, string Anchor) NoCaseSize(CaseMixDraw? draw, string kind, int basePct, string baseAnchor, CaseMixSettings s)
    {
        var ticked = kind switch
        {
            "Movie" => s.CaseModMixNoCaseSizeMovies,
            "BoxSet" => s.CaseModMixNoCaseSizeSets,
            "Series" => s.CaseModMixNoCaseSizeTvShows,
            _ => false
        };
        if (draw is null || draw.Outcome != "nocase" || !ticked || !AnyLiveNoCase(s))
        {
            return (basePct, baseAnchor);
        }

        var factor = Math.Clamp(s.CaseModMixNoCaseSize, 50, 150);
        var pct = (int)Math.Round(basePct * factor / 100.0, MidpointRounding.AwayFromZero);
        return (Math.Clamp(pct, 10, 200), string.IsNullOrEmpty(s.CaseModMixNoCaseAnchor) ? baseAnchor : s.CaseModMixNoCaseAnchor);
    }

    /// <summary>
    /// May this poster slot deliver on this item? A tick in the poster chain
    /// switches a whole slot (customposter = the Custom Poster tab,
    /// animatedposter = Animated Poster, extraposter = Extraposter), each
    /// with the variant its own tab resolves; an unticked one answers "not
    /// available" and the chain falls through to the next. No draw, or No
    /// case in no LIVE pool - the chain rows are greyed then, and greyed is
    /// not applied: every slot delivers as usual. A pool counts as live when its kind
    /// shows cases and its No case does not stand alone - the same two rules
    /// that grey the ticks on the admin page.
    /// </summary>
    public static bool SlotAllowed(CaseMixDraw? draw, string slot, CaseMixSettings s)
    {
        if (draw is null || !AnyLiveNoCase(s))
        {
            return true;
        }

        var noCase = draw.Outcome == "nocase";
        return slot switch
        {
            "customposter" => noCase ? s.CaseModMixChainNoCaseCustomPoster : s.CaseModMixChainCasesCustomPoster,
            "animatedposter" => noCase ? s.CaseModMixChainNoCaseAnimatedPoster : s.CaseModMixChainCasesAnimatedPoster,
            "extraposter" => noCase ? s.CaseModMixChainNoCaseExtraposter : s.CaseModMixChainCasesExtraposter,
            _ => true
        };
    }

    /// <summary>
    /// Whether some pool holds a No case that counts, judged by the ticks
    /// alone - as the admin page sees them, so page and server grey and
    /// apply the chain alike. The browser's WebGL answer plays no part here:
    /// the page cannot know it either.
    /// </summary>
    private static bool AnyLiveNoCase(CaseMixSettings s)
    {
        if (!s.CaseModMixEnabled)
        {
            return false;
        }

        var movies = s.CaseModShowOnMovies && s.CaseModMixMoviesNoCase
            && (s.CaseModMixMoviesClear || s.CaseModMixMoviesVortex || s.CaseModMixMoviesVivaElite || s.CaseModMixMoviesVivaElite3d
                || (s.CaseModMixMoviesThreejs && s.CaseModThreejsEnabled));
        var sets = s.CaseModShowOnSets && s.CaseModMixSetsNoCase
            && (s.CaseModMixSetsClear || s.CaseModMixSetsVortex || s.CaseModMixSetsVivaElite || s.CaseModMixSetsVivaElite3d);
        var tv = s.CaseModShowOnTvShows && s.CaseModMixTvShowsNoCase
            && (s.CaseModMixTvShowsClear || s.CaseModMixTvShowsVortex || s.CaseModMixTvShowsVivaElite || s.CaseModMixTvShowsVivaElite3d);
        return movies || sets || tv;
    }

    /// <summary>
    /// The drawable entries of the kind's pool, all equally likely. A type
    /// with no colour ticked is off for the randomizer; Three.js only for
    /// movies, only while its own block is on and only when the browser can
    /// draw it (otherwise it is skipped).
    /// No case never stands alone: it joins the draw
    /// only beside at least one case type that can be drawn right here -
    /// alone it would only repeat what unticking the kind in Show Cases on
    /// already does.
    /// </summary>
    private static List<string> Pool(string kind, bool webGl, CaseMixSettings s)
    {
        var list = new List<string>();
        if (!s.CaseModMixEnabled)
        {
            return list;
        }

        var noCase = false;
        switch (kind)
        {
            case "Movie" when s.CaseModShowOnMovies:
                AddFlat(list, s, s.CaseModMixMoviesClear, s.CaseModMixMoviesVortex, s.CaseModMixMoviesVivaElite, s.CaseModMixMoviesVivaElite3d);
                if (s.CaseModMixMoviesThreejs && s.CaseModThreejsEnabled && webGl && ThreejsDrawable(s))
                {
                    list.Add("threejs");
                }

                noCase = s.CaseModMixMoviesNoCase;
                break;
            case "BoxSet" when s.CaseModShowOnSets:
                AddFlat(list, s, s.CaseModMixSetsClear, s.CaseModMixSetsVortex, s.CaseModMixSetsVivaElite, s.CaseModMixSetsVivaElite3d);
                noCase = s.CaseModMixSetsNoCase;
                break;
            case "Series" when s.CaseModShowOnTvShows:
                AddFlat(list, s, s.CaseModMixTvShowsClear, s.CaseModMixTvShowsVortex, s.CaseModMixTvShowsVivaElite, s.CaseModMixTvShowsVivaElite3d);
                noCase = s.CaseModMixTvShowsNoCase;
                break;
        }

        if (noCase && list.Count > 0)
        {
            list.Add("nocase");
        }

        return list;
    }

    private static void AddFlat(List<string> list, CaseMixSettings s, bool clear, bool vortex, bool vivaElite, bool vivaElite3d)
    {
        if (clear && FlatVariants(s, "clearcases").Count > 0) { list.Add("clearcases"); }
        if (vortex && FlatVariants(s, "vortexcases").Count > 0) { list.Add("vortexcases"); }
        if (vivaElite && FlatVariants(s, "vivaelitecases").Count > 0) { list.Add("vivaelitecases"); }
        if (vivaElite3d && FlatVariants(s, "vivaelite3dcases").Count > 0) { list.Add("vivaelite3dcases"); }
    }

    private static List<string> FlatVariants(CaseMixSettings s, string type)
    {
        var (original, fullShell) = type switch
        {
            "clearcases" => (s.CaseModMixColorClearOriginal, s.CaseModMixColorClearFullShell),
            "vortexcases" => (s.CaseModMixColorVortexOriginal, s.CaseModMixColorVortexFullShell),
            "vivaelitecases" => (s.CaseModMixColorVivaEliteOriginal, s.CaseModMixColorVivaEliteFullShell),
            _ => (s.CaseModMixColorVivaElite3dOriginal, s.CaseModMixColorVivaElite3dFullShell)
        };
        var v = new List<string>();
        if (original) { v.Add("Original"); }
        if (fullShell) { v.Add("FullShell"); }
        return v;
    }

    private static string FlatBlend(CaseMixSettings s, string type) => ValidBlend(type switch
    {
        "clearcases" => s.CaseModMixBlendClear,
        "vortexcases" => s.CaseModMixBlendVortex,
        "vivaelitecases" => s.CaseModMixBlendVivaElite,
        _ => s.CaseModMixBlendVivaElite3d
    });

    private static List<string> Variants(bool original, bool fullShell, bool backSpine)
    {
        var v = new List<string>();
        if (original) { v.Add("Original"); }
        if (fullShell) { v.Add("FullShell"); }
        if (backSpine) { v.Add("BackSpine"); }
        return v;
    }

    private static List<string> Dvd(CaseMixSettings s) => Variants(s.CaseModMixColorThreejsDvdOriginal, s.CaseModMixColorThreejsDvdFullShell, false);

    private static List<string> BluRay(CaseMixSettings s) => Variants(s.CaseModMixColorThreejsBluRayOriginal, s.CaseModMixColorThreejsBluRayFullShell, s.CaseModMixColorThreejsBluRayBackSpine);

    private static List<string> Uhd(CaseMixSettings s) => Variants(s.CaseModMixColorThreejsUhdOriginal, s.CaseModMixColorThreejsUhdFullShell, s.CaseModMixColorThreejsUhdBackSpine);

    private static bool ThreejsDrawable(CaseMixSettings s) => Dvd(s).Count > 0 && BluRay(s).Count > 0 && Uhd(s).Count > 0;

    private static string ValidBlend(string? blend) => blend is not null && Blends.Contains(blend) ? blend : "DominantDark";

    private static string Pick(List<string> from) => from[Random.Shared.Next(from.Count)];

    private static CaseMixDraw Roll(List<string> pool, CaseMixSettings s)
    {
        var outcome = Pick(pool);
        return outcome switch
        {
            "nocase" => new CaseMixDraw { Outcome = outcome },
            "threejs" => new CaseMixDraw
            {
                Outcome = outcome,
                Blend = ValidBlend(s.CaseModMixBlendThreejs),
                ThreejsDvd = Pick(Dvd(s)),
                ThreejsBluRay = Pick(BluRay(s)),
                ThreejsUhd = Pick(Uhd(s))
            },
            _ => new CaseMixDraw { Outcome = outcome, ColorMode = Pick(FlatVariants(s, outcome)), Blend = FlatBlend(s, outcome) }
        };
    }
}
