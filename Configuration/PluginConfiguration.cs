using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.ArtworkPlus.Configuration;

/// <summary>
/// Server-side persisted plugin settings. Set and read via the admin config
/// page (Configuration/configPage.html). Changes here need NO server
/// restart/rebuild - only building this class and the config page itself
/// does.
///
/// Deliberately modeled as string properties, not as a C# enum: Jellyfin's
/// plugin config is exchanged as JSON over the REST API; an enum would by
/// default serialize as a number there, not as a readable string - this also
/// matches the convention in the user's two reference plugins (e.g.
/// SortBy: 'PremiereDate' instead of an enum value).
///
/// STRUCTURE (consistency principle from the curriculum, section D0): every
/// tab/feature block gets its own region below, clearly marked with a
/// comment, in the same tab order as in the config page: General -> Animated
/// Poster -> Extraposter -> Characterart -> Backdrops -> Red Carpet. All six
/// regions are fully populated with settings.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    // ───────────────────────── General tab ─────────────────────────
    // One master switch per feature block. Not just a visual effect
    // (tab graying) - a real, server-side kill switch. The respective
    // controller checks this field itself before doing anything (see
    // ExtraposterController.GetPosterList).

    /// <summary>Master switch for the Extraposter feature block.</summary>
    /// <summary>
    /// Master switch for the "Extraposter" tab ITSELF (concept-session
    /// decision, same pattern as CustomPosterEnabled: one shared toggle
    /// for the whole tab, separate from each sub-feature's own Enabled
    /// field). Introduced when the Extraposter tab was restructured to
    /// give both Extraposter and Extrakeyart genuinely independent
    /// on/off switches of their own - previously ExtraposterEnabled did
    /// double duty as both the tab master AND Extraposter's own specific
    /// switch; now they're two real, separate fields, and
    /// ExtraposterEnabled below keeps its original name but is now ONLY
    /// the sub-feature switch (its own checkbox moved from General into
    /// the Extraposter sub-section itself).
    /// </summary>
    public bool ExtraposterTabEnabled { get; set; } = true;

    public bool ExtraposterEnabled { get; set; } = true;

    /// <summary>Master switch for the whole Animated Poster TAB (Animated Poster + Animated Keyart). Server-side kill switch, see AnimatedPosterController. Split from AnimatedPosterEnabled in Phase 2 (Session 90), same pattern as ExtraposterTabEnabled/ExtraposterEnabled above.</summary>
    public bool AnimatedPosterTabEnabled { get; set; } = true;

    /// <summary>Feature-level switch for Animated Poster specifically (as opposed to AnimatedPosterTabEnabled above, which gates the whole tab including Animated Keyart).</summary>
    public bool AnimatedPosterEnabled { get; set; } = true;

    /// <summary>Feature-level switch for Animated Keyart (Phase 2, Session 90 - new sibling feature to Animated Poster, same relationship as Keyart to Postercase).</summary>
    public bool AnimatedKeyartEnabled { get; set; } = true;

    /// <summary>"AnimatedPoster" or "AnimatedKeyart" - which one wins if both are enabled and applicable for the same item. See CustomPosterPriority for the identical pattern.</summary>
    public string AnimatedPosterPriority { get; set; } = "AnimatedPoster";

    // ───────────────────────── Case Mod tab ─────────────────────────
    // Concept-session decision: a case texture wrapped around the poster
    // box, with an optional further "open case + spinning disc"
    // animation - NOT an artwork-content contender (doesn't compete in
    // the poster arbiter), applies uniformly to every detail view
    // regardless of which artwork type currently wins the poster slot.
    // Deliberately its own tab (not folded into General, despite being
    // global/not tied to a specific container - explicit user decision
    // after weighing both options) placed directly after General.
    //
    // SESSION 18 (admin menu overhaul, explicit user request): the
    // original three-level dependency chain (Case -> Enable Open Case
    // -> Spinning Disc) is gone. The flat, current shape (verified
    // exhaustively via configPage.html's own EP_GATES + this session's
    // dedicated Playwright regression tests):
    //   1. Show on (Movies/Sets/TvShows) - gates everything below (2-8)
    //      via AnyChecked.
    //   2-5. Case type / Open Case / Delay / Open Case on click - gated
    //      on Show on (1) alone; Delay additionally needs Open Case
    //      itself checked.
    //   6-7. Open Case angle / Spinning Disc - gated on Show on (1) AND at
    //      least one of the two Open Case triggers.
    //   8. Spinning direction - gated on Spinning Disc (7) AND the same
    //      "at least one trigger" condition as 6/7.
    // Graying a field is PURELY VISUAL in every case above - a field's
    // underlying value is never reset just because it became
    // unreachable (explicit, general user requirement).
    //
    // SESSION 37 (user-identified inconsistency, explicit correction):
    // the former CaseModCaseEnabled sub-switch was removed entirely -
    // Case was the only single-sub-feature tab that still had its own
    // separate sub-Enable distinct from the General-tab root gate,
    // unlike Animated Poster/Characterart/Red Carpet (also single-
    // feature tabs, correctly have none - their tab-root IS already
    // the only Enable). CaseModEnabled is now the sole gate, both
    // client-side (this tab's own EP_TREE root) and server-side (see
    // CaseModController.cs's own GetInfo()).
    //
    // Movies/TvShows split: was left undecided at concept time, since
    // resolved (Show on above).

    /// <summary>Master switch for the "Case Mod" tab itself, same tab-master pattern as CustomPosterEnabled/ExtraposterTabEnabled/BackdropsTabEnabled. Since Session 37, also the SOLE gate for the whole feature - the former CaseModCaseEnabled sub-switch was removed as a redundant single-sub-feature exception.</summary>
    public bool CaseModEnabled { get; set; } = true;

    /// <summary>
    /// SESSION 18 (admin menu overhaul, explicit user request): the old
    /// separate "Enable Open Case" master switch is gone - Open Case is
    /// now considered active whenever at least one of the two triggers
    /// below (this one, or Open Case on click) is on, with no extra
    /// gate in between. This field IS the first trigger itself: the
    /// case opens automatically after the delay below. Default true -
    /// this WAS the only trigger before, so existing installs keep
    /// exactly their previous behavior after updating.
    /// </summary>
    public bool CaseModOpenCaseDelayEnabled { get; set; } = true;

    /// <summary>
    /// The delay itself (ms) before the automatic Open Case animation
    /// starts, once CaseModOpenCaseDelayEnabled is on. Default 5000
    /// (Session 18: raised from 4000 per explicit user request).
    /// </summary>
    public double CaseModOpenCaseDelayMs { get; set; } = 5000;

    /// <summary>
    /// Second of two independent Open Case triggers - clicking the
    /// poster itself (not the case texture - the case boxes already
    /// have pointer-events:none, so a click always reaches the real
    /// poster underneath) opens the case on demand. Default true
    /// (Session 18: changed from off-by-default per explicit user
    /// request - both triggers now on out of the box). Only registers
    /// while the poster is in its native, not-currently-animating
    /// resting state (explicit user requirement: "während die
    /// Animation schon am Laufen ist, ist der Klick gesperrt/ignoriert")
    /// - clicks during an active Open Case animation are ignored, not
    /// queued.
    /// </summary>
    public bool CaseModOpenCaseOnClickEnabled { get; set; } = true;

    /// <summary>
    /// How far the front cover swings open (degrees), admin-adjustable.
    /// Default 90 (Session 18: lowered from 135 per explicit user
    /// request). Clamped defensively to [1, 180] in
    /// CaseModController.GetInfo() in case a stale/manually-edited
    /// config value is out of range. Changing this requires a full
    /// browser reload to take effect (same as any other CaseMod value -
    /// the client caches its injected @keyframes on first use per page
    /// load, consistent with how the sized-per-type CSS classes already
    /// cache themselves once per case type).
    /// </summary>
    public double CaseModOpenAngleDegrees { get; set; } = 90;

    /// <summary>
    /// Fixed perspective tilt angle for "Viva Elite 3D Case", a concept
    /// adopted 1:1 from the Aeon MQ Kodi skin (Sessions 40/41/42).
    /// Permanent, admin-visible field - NOT part of the temporary tuning
    /// fields further down. Stored negative, range -10 to 0 degrees
    /// (Session 44, user correction: the positive half was removed again -
    /// the texture itself has the spine drawn on one fixed side, a positive
    /// angle/mirrored hinge would not match the texture; range widened
    /// 0-5 -> 0-10 in Session 69). The admin UI shows the value positive
    /// (Session 67). Default -5 (user-confirmed value after several test
    /// rounds against real Kodi screenshots).
    /// </summary>
    public double CaseModCaseAngle { get; set; } = -5;

    /// <summary>
    /// Session 52: hides the whole REFERENCE TECHNIQUE block (temporary
    /// case/disc/inner-case tuning fields + the three preview checkboxes)
    /// in the admin menu completely - real display:none, not just greying.
    /// Default false so the block is invisible for ordinary users.
    /// </summary>
    public bool CaseModDeveloperSettingsEnabled { get; set; } = false;

    // 📌 TEMPORARY - following the proven "REFERENCE TECHNIQUE" pattern
    // (see the curriculum): direct, absolute geometry fields for tuning
    // the "3D Case" type by eye against the real poster. As with the
    // other three case types: once the values fit they are copied into
    // CaseModController.cs's own switch and this admin field set is
    // removed again - the same lifecycle as the original case-box and
    // disc tuning tool (Sessions 10-11/18). Since Session 45 the fields
    // stay in the config but are hidden behind "Developer settings".
    public double CaseMod3DTuneTop { get; set; } = -4.3;
    public double CaseMod3DTuneLeft { get; set; } = 2.8;
    public double CaseMod3DTuneWidth { get; set; } = 27.35;

    /// <summary>
    /// Session 121: Sets (BoxSet) with the Viva Elite 3D Case have their own
    /// set.png artwork whose proportions differ slightly from the movie
    /// case - the case width alone is off there (user finding). Only for
    /// this case type and only for Sets; default = the movie value until
    /// the user has tuned it. Developer settings, "Case width Sets (vw)".
    /// </summary>
    public double CaseMod3DTuneWidthSets { get; set; } = 28.5;
    public double CaseMod3DTuneHeight { get; set; } = 42.6;

    // 📌 TEMPORARY - inner-case position (the view when the case opens;
    // the graphic is reused 1:1 from vivaelitecases). Default identical to
    // the original case values (user requirement), since the inner case
    // sits at the same place as the case front.
    public double CaseMod3DTuneInnerTop { get; set; } = -4.2;
    public double CaseMod3DTuneInnerLeft { get; set; } = -1.1;
    public double CaseMod3DTuneInnerWidth { get; set; } = 31.5;
    public double CaseMod3DTuneInnerHeight { get; set; } = 43.8;

    // 📌 TEMPORARY - disc position. Only 3 fields (no height) - a disc is
    // 1:1, Size is used as width AND height so it never distorts into an
    // oval.
    public double CaseMod3DTuneDiscTop { get; set; } = 5.2;
    public double CaseMod3DTuneDiscLeft { get; set; } = 4.05;
    public double CaseMod3DTuneDiscSize { get; set; } = 23.6;

    // 📌 Session 47: the same tuning fields for the three existing case
    // types as well, hidden (not removed - see the policy change in
    // Session 45) behind their own dropdown value. Defaults = the current
    // values already hard-coded in the controller, so nothing shifts on
    // first opening - only whoever actually readjusts changes something.
    public double ClearCaseTuneTop { get; set; } = -3.35;
    public double ClearCaseTuneLeft { get; set; } = -1.3;
    public double ClearCaseTuneWidth { get; set; } = 31.5;
    public double ClearCaseTuneHeight { get; set; } = 43.2;
    public double ClearCaseTuneDiscTop { get; set; } = 6.05;
    public double ClearCaseTuneDiscLeft { get; set; } = 4.1;
    public double ClearCaseTuneDiscSize { get; set; } = 22.9;

    public double VortexCaseTuneTop { get; set; } = -3.8;
    public double VortexCaseTuneLeft { get; set; } = -1.15;
    public double VortexCaseTuneWidth { get; set; } = 31.45;
    public double VortexCaseTuneHeight { get; set; } = 43.4;
    public double VortexCaseTuneDiscTop { get; set; } = 5.5;
    public double VortexCaseTuneDiscLeft { get; set; } = 3.9;
    public double VortexCaseTuneDiscSize { get; set; } = 23.7;

    public double VivaEliteCaseTuneTop { get; set; } = -3.8;
    public double VivaEliteCaseTuneLeft { get; set; } = -1.7;
    public double VivaEliteCaseTuneWidth { get; set; } = 32.0;
    public double VivaEliteCaseTuneHeight { get; set; } = 43.7;
    public double VivaEliteCaseTuneDiscTop { get; set; } = 5.4;
    public double VivaEliteCaseTuneDiscLeft { get; set; } = 3.55;
    public double VivaEliteCaseTuneDiscSize { get; set; } = 23.9;

    // 📌 TEMPORARY - pure preview switches for alignment, no function in
    // normal operation: they bring the respective layer to the front in
    // z-index while reading the same geometry as the real flow (no
    // separate preview copy of the values).
    public bool CaseMod3DTuneHidePoster { get; set; } = false;
    public bool CaseMod3DTuneShowInnerCase { get; set; } = false;
    public bool CaseMod3DTuneShowDisc { get; set; } = false;

    /// <summary>Whether the Disc spins once the case is open. Default true (Session 18: changed from off-by-default per explicit user request).</summary>
    public bool CaseModSpinningDiscEnabled { get; set; } = true;

    /// <summary>
    /// SESSION 18, new field: direction the Disc spins in, "Left" or
    /// "Right" - admin-selectable via a dropdown, only meaningful (and
    /// only selectable in the UI) while Spinning Disc above is on.
    /// Default "Left". Stored as a plain string (not a bool) to keep
    /// the door open for more directions later without a breaking
    /// rename, same reasoning as CaseModType's own string storage.
    /// </summary>
    public string CaseModSpinningDirection { get; set; } = "Left";

    // Disc geometry (Top/Left/Size per case type) is HARDCODED as of
    // Session 18 (measured and confirmed by the user) - see
    // CaseModController's own constants. The admin-facing tuning tool
    // and its nine per-type config fields (CaseModColorDiscTopPercent
    // etc.) are removed entirely, same lifecycle/reasoning as the
    // Case geometry's own tuning tool before it.

    /// <summary>
    /// Master switch for the "Custom Poster" tab ITSELF (concept-session
    /// decision: one shared toggle for the whole tab, separate from each
    /// sub-feature's own Enabled field - PostercaseEnabled, later
    /// KeyartEnabled). Mirrors AnimatedPosterEnabled's own role one level
    /// up: this one gates the tab's existence/visibility the same way
    /// AnimatedPosterEnabled gates the Animated Poster tab, while
    /// PostercaseEnabled/KeyartEnabled independently gate their own
    /// sub-feature WITHIN an enabled tab. Both must be true for
    /// Postercase to actually do anything - see CustomPosterController's
    /// own IsTypeEnabled().
    /// </summary>
    public bool CustomPosterEnabled { get; set; } = true;

    /// <summary>Master switch for Characterart (curriculum section E). Server-side kill switch, see CharacterartController.</summary>
    public bool CharacterartEnabled { get; set; } = true;

    /// <summary>
    /// Master switch for Backdrops (curriculum section G). Session 130:
    /// the only precondition besides the per-type Show on - the old
    /// Firefox and Details-Banner checks in the client are gone.
    /// </summary>
    /// <summary>
    /// Master switch for the "Backdrops" tab ITSELF - same pattern as
    /// ExtraposterTabEnabled/CustomPosterEnabled. Introduced together
    /// with the Extraposter tab's own equivalent change, for the same
    /// reason: BackdropsPlus's own switch (BackdropsEnabled below) becomes
    /// a genuinely independent sub-feature switch, moved from General
    /// into BackdropsPlus's own sub-section within the tab.
    /// PeopleBackdropsController's own "shared master switch" is
    /// re-pointed to THIS field (not BackdropsEnabled) - see that
    /// controller's own class doc comment for why: People Backdrops is a
    /// sibling of BackdropsPlus under the same tab, not a dependent of
    /// BackdropsPlus specifically, so it should go dark when the whole
    /// tab is off, not merely when BackdropsPlus's own specific switch is.
    /// </summary>
    public bool BackdropsTabEnabled { get; set; } = true;

    /// <summary>
    /// Tab-level, deliberately NOT tied to any one sub's own UI section -
    /// explicit user request ("da backdrops nur subs hat, machen wir es
    /// hier ganz oben losgeloest von den subs"). CHANGED (real gap fixed
    /// per explicit user correction - "sollte aber schon tied zu den sub
    /// below sein! sonst ist ja das alles unnuetz"): this IS a genuinely
    /// working display gate now, not a placeholder - BackdropsController's
    /// own GetAllowedIndices endpoint checks each of an item's own
    /// already-known backdrop images (Jellyfin itself resolved them, this
    /// plugin never searches for them) against this field, by their real
    /// on-disk file extension, and only the matching ones are shown by
    /// Detail View Backdrops (BackdropsPlus). Deliberately does NOT apply
    /// to People Backdrops - those come from a Wallpapers.com URL, not a
    /// local file with a checkable extension. Genre/Studio/Tag Backdrops
    /// remain empty placeholders for now and don't read this field yet,
    /// but can plug into the same shared setting once built rather than
    /// each inventing its own.
    /// </summary>
    public string BackdropsAllowedFormats { get; set; } = "jpg";

    /// <summary>
    /// BUG-ORPHANED-CHECKBOXES fixed here (Session 22): these three
    /// switches (Genre/Studio/Tag Backdrops' own collapse-level "Enable")
    /// were fully wired in the admin UI (checkbox, EP_FIELDS entry,
    /// dependency gate, change listener) but had no backing property at
    /// all here - any value the admin set was silently dropped by the
    /// server's own JSON deserializer on save, resetting to unchecked on
    /// every page reload. Genre/Studio/Tag Backdrops themselves remain
    /// empty placeholder features (see BackdropsAllowedFormats' own doc
    /// comment above) - these three fields exist now purely so the
    /// admin's own checkbox state persists correctly, ready for whenever
    /// each feature is actually built.
    /// </summary>
    public bool BackdropsGenreEnabled { get; set; } = true;

    /// <summary>
    /// Shared across all three Genre Backdrops subs (Global/Movies/TV
    /// shows) - one Main-vs-All switch for the whole category, not
    /// per sub. "Main": always the item's own Main backdrop (the file
    /// without a number, confirmed against Jellyfin's own
    /// LocalImageProvider.PopulateBackdrops - the no-number file is
    /// always added first, landing reliably at BackdropImageTags[0]).
    /// "All": a random one of the item's own backdrops each time.
    /// Phase B (Session 98): was a bool, now a string ("Main"/"All") to
    /// match the admin-UI dropdown replacing the old checkbox.
    /// </summary>
    public string BackdropsGenreMainOnly { get; set; } = "Main";

    /// <summary>
    /// Shared timing/Ken Burns block for Genre Backdrops - own copy of
    /// the same options Detail View Backdrops has, deliberately not
    /// shared with it (each category gets its own values, per explicit
    /// user decision - "auch einzeln pro kategorie").
    /// </summary>
    public int BackdropsGenreCycleTimeMs { get; set; } = 10000;

    public bool BackdropsGenreKenBurnsEnabled { get; set; } = true;

    public int BackdropsGenreKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsGenreKenBurnsPanMs { get; set; } = 10000;

    /// <summary>
    /// Global genre list - reached without any library scope (no
    /// parentId in the URL, see list.js's own getItem/query resolution).
    /// </summary>
    public bool BackdropsGenreGlobalEnabled { get; set; } = true;

    /// <summary>
    /// Phase A (Session 97): consolidated into ONE shared field for all
    /// three subs (Global/Movies/TvShows) - was three separate fields
    /// before, moved to the sandbox concept in Session 77 and finally
    /// ported back here. Determines the rotation order of items pulled
    /// into EACH sub's own backdrop pool. A real ItemSortBy field name
    /// (e.g. "Name", "PremiereDate") is sent to Jellyfin's own items
    /// query as SortBy, with rotation then simply traversing the
    /// fetched order (Sequential). "Shuffle"/"Random" instead use a
    /// stable server fetch order (SortName) and let the existing,
    /// shared createBackdropRotationEngine (Core.js) reshuffle/
    /// randomize during rotation, exactly like Detail View Backdrops'
    /// own OrderMode - reused, not reinvented.
    /// </summary>
    public string BackdropsGenreSortMode { get; set; } = "Shuffle";

    /// <summary>
    /// Phase A (Session 97): consolidated, same reasoning as
    /// BackdropsGenreSortMode above. F-2024-01 follow-up (explicit user
    /// decision - real sort fields had no Limit at all, unlike Shuffle/
    /// Random, which the user correctly pointed out was an
    /// inconsistency worth fixing too). Only relevant when SortMode
    /// above is a real field (not Shuffle/Random) - hidden/ignored
    /// otherwise. Four values: BeginAscending (default, matches the
    /// previous unlimited-from-the-start behavior, now capped at 100),
    /// BeginDescending (same but reversed), RandomStartAscending/
    /// RandomStartDescending (a fresh random offset each visit, via a
    /// cheap COUNT query first - see GetGenrePool's own doc comment for
    /// the full mechanism).
    /// </summary>
    public string BackdropsGenreTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsGenreRandomStart { get; set; }

    /// <summary>
    /// Movies-library genre list - reached with the Movies library's own
    /// id as parentId (confirmed in moviegenres.js: ParentId +
    /// IncludeItemTypes=Movie).
    /// </summary>
    public bool BackdropsGenreMoviesEnabled { get; set; } = true;

    /// <summary>
    /// TV shows-library genre list - reached with the TV library's own
    /// id as parentId (confirmed in tvgenres.js: ParentId +
    /// IncludeItemTypes=Series).
    /// </summary>
    public bool BackdropsGenreTvShowsEnabled { get; set; } = true;

    /// <summary>
    /// Session 118: where backdrop files come from for every category
    /// except People Folder. "Native" = Jellyfin's own database (what its
    /// LocalImageProvider found at scan time). "Custom" = the plugin reads
    /// the item folders itself with the same six-stage rules as Jellyfin
    /// (Helpers/BackdropFileResolver), only the last stage's base name
    /// "backdrop" is replaced by BackdropsCustomBaseName - Kodi-style
    /// "fanart, fanart1, fanart2" without duplicating files.
    /// </summary>
    public string BackdropsListener { get; set; } = "Native";

    /// <summary>Custom listener base name; "backdrop" makes Custom identical to Native.</summary>
    public string BackdropsCustomBaseName { get; set; } = "fanart";

    /// <summary>
    /// Session 118: per-episode backdrop files (Jellyfin has none beyond
    /// "episodefile-fanart"). Files next to the episode with the episode
    /// file name as prefix: episodefile-name.ext (+ episodefile-name1..20
    /// with Multiple). None found: the usual season, then show fallback.
    /// Own Order because episode files are a separate list from the
    /// inherited backdrops.
    /// </summary>
    public bool BackdropsEpisodeEnabled { get; set; } = true;

    public string BackdropsEpisodeBaseName { get; set; } = "backdrop";

    public string BackdropsEpisodeBackdropFiles { get; set; } = "Multiple";

    public string BackdropsEpisodeOrderMode { get; set; } = "Shuffle";
    public bool BackdropsEpisodeRandomStart { get; set; }

    /// <summary>See BackdropsGenreEnabled's own doc comment.</summary>
    public bool BackdropsStudioEnabled { get; set; } = true;

    /// <summary>
    /// Session 116: Studio gets a Source switch like People.
    /// "Appearances" rotates the backdrops of the titles the studio
    /// appears in (studio-pool, same mechanics as Genre); "StudioImage"
    /// shows the single metadata\Studio\&lt;name&gt;\landscape.jpg
    /// (the original behaviour, kept as the default so nothing changes
    /// after the update). Dropdown order: Appearances, Studio image.
    /// </summary>
    public string BackdropsStudioSourceMode { get; set; } = "StudioImage";

    /// <summary>Appearances only - see BackdropsGenreMainOnly.</summary>
    public string BackdropsStudioMainOnly { get; set; } = "Main";

    /// <summary>Appearances only - see BackdropsGenreCycleTimeMs.</summary>
    public int BackdropsStudioCycleTimeMs { get; set; } = 10000;

    /// <summary>
    /// Studio Backdrops shared Ken Burns block - applies to both
    /// sources (the single studio image was Ken-Burns-animated already
    /// before the Appearances source existed).
    /// </summary>
    public bool BackdropsStudioKenBurnsEnabled { get; set; } = true;

    public int BackdropsStudioKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsStudioKenBurnsPanMs { get; set; } = 10000;

    /// <summary>
    /// Global studio list - reached without a library scope (clicking
    /// any Studio item resolves via list.html?studioId=X, no parentId).
    /// </summary>
    public bool BackdropsStudioGlobalEnabled { get; set; } = true;

    /// <summary>
    /// TV shows-library Studios tab (tvstudios.js - confirmed no
    /// equivalent exists for Movies in jellyfin-web's own source, so
    /// there is no separate Movies sub for Studio).
    /// </summary>
    public bool BackdropsStudioTvShowsEnabled { get; set; } = true;

    /// <summary>Appearances only - see BackdropsGenreSortMode.</summary>
    public string BackdropsStudioSortMode { get; set; } = "Shuffle";

    /// <summary>Appearances only - see BackdropsGenreTraversalMode.</summary>
    public string BackdropsStudioTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsStudioRandomStart { get; set; }

    /// <summary>See BackdropsGenreEnabled's own doc comment.</summary>
    public bool BackdropsTagEnabled { get; set; } = true;

    /// <summary>
    /// Tag Backdrops has only one variant (explicit user decision -
    /// "tags nimmt alles was im tag ist" - tags are global and mix
    /// movies/shows by design, so a Global/Movies/TvShows split like
    /// Genre would be meaningless here). Flat structure, same shape as
    /// Detail View Backdrops' own settings, no sub-collapses needed.
    /// </summary>
    public string BackdropsTagMainOnly { get; set; } = "Main";

    public int BackdropsTagCycleTimeMs { get; set; } = 10000;

    public bool BackdropsTagKenBurnsEnabled { get; set; } = true;

    public int BackdropsTagKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsTagKenBurnsPanMs { get; set; } = 10000;

    /// <summary>See BackdropsGenreSortMode's own doc comment.</summary>
    public string BackdropsTagSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsTagTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsTagRandomStart { get; set; }

    /// <summary>
    /// Favorites Backdrops - one Enable per section (native order from
    /// favorites.js: Movies, Shows, Episodes, Videos, Collections,
    /// Playlists, People, Artists, Albums, Songs, Books), reached via
    /// each section's own "See All" list (list.html with IsFavorite=true
    /// + type=X, confirmed against list.js's own query construction) -
    /// not the scrollable rows on the Favorites home tab itself. Shared
    /// Main-vs-Random/Ken Burns/timing block for all eleven, same
    /// pattern as Genre/Tag. People is the one exception - no Sort field
    /// (see BackdropsFavoritesPeopleSourceMode's own doc comment), a
    /// source-mode dropdown instead.
    /// </summary>
    public bool BackdropsFavoritesEnabled { get; set; } = true;

    public string BackdropsFavoritesMainOnly { get; set; } = "Main";

    /// <summary>
    /// Phase C (Session 99): "General" or "Individual" - General uses
    /// ONE shared Order/Traversal pair (below) for all ten sub-types,
    /// limited to the fields valid for ALL of them (Artists/Playlists
    /// support little else in Jellyfin itself, see
    /// BackdropsFavoritesGeneralSortMode's own doc comment). Individual
    /// uses each sub's own SortMode/TraversalMode property instead,
    /// each restricted to that specific type's own valid fields.
    /// </summary>
    public string BackdropsFavoritesManageMode { get; set; } = "General";

    /// <summary>
    /// Only the fields valid for EVERY one of the ten sub-types
    /// simultaneously - verified against jellyfin-web's own
    /// SortButton.tsx (Session 77 research): Artists and Playlists have
    /// no sort button at all in real Jellyfin, only Name. DateCreated
    /// (date added) is the one other genuinely universal field across
    /// every item type. Only used when BackdropsFavoritesManageMode is
    /// "General".
    /// </summary>
    public string BackdropsFavoritesGeneralSortMode { get; set; } = "Shuffle";

    /// <summary>Same reasoning as the per-type TraversalMode properties below - only used when BackdropsFavoritesManageMode is "General".</summary>
    public string BackdropsFavoritesGeneralTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesGeneralRandomStart { get; set; }

    public int BackdropsFavoritesCycleTimeMs { get; set; } = 10000;

    public bool BackdropsFavoritesKenBurnsEnabled { get; set; } = true;

    public int BackdropsFavoritesKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsFavoritesKenBurnsPanMs { get; set; } = 10000;

    public bool BackdropsFavoritesMoviesEnabled { get; set; } = true;

    /// <summary>See BackdropsGenreSortMode's own doc comment.</summary>
    public string BackdropsFavoritesMoviesSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsFavoritesMoviesTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesMoviesRandomStart { get; set; }

    public bool BackdropsFavoritesShowsEnabled { get; set; } = true;

    public string BackdropsFavoritesShowsSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsFavoritesShowsTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesShowsRandomStart { get; set; }

    public bool BackdropsFavoritesEpisodesEnabled { get; set; } = true;

    public string BackdropsFavoritesEpisodesSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsFavoritesEpisodesTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesEpisodesRandomStart { get; set; }

    public bool BackdropsFavoritesVideosEnabled { get; set; } = true;

    public string BackdropsFavoritesVideosSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsFavoritesVideosTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesVideosRandomStart { get; set; }

    public bool BackdropsFavoritesCollectionsEnabled { get; set; } = true;

    public string BackdropsFavoritesCollectionsSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsFavoritesCollectionsTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesCollectionsRandomStart { get; set; }

    public bool BackdropsFavoritesPlaylistsEnabled { get; set; } = true;

    public string BackdropsFavoritesPlaylistsSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsFavoritesPlaylistsTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesPlaylistsRandomStart { get; set; }

    /// <summary>
    /// People Backdrops for Favorites - deliberately no Sort field,
    /// unlike the other ten sections. Two mutually exclusive sources
    /// (explicit user decision - "nur entweder, oder... 2 unterschiedliche
    /// Technologien"), never a mixed pool:
    /// Appearances = movies/shows the favorited people are in together,
    /// shuffled. WallpapersCom = reuses the EXISTING People Backdrops
    /// cache files directly (no separate API key field, no new cache -
    /// see PeopleBackdropsController's own class doc comment), with a
    /// staggered fetch: a random subset of already-cached people
    /// (cheap, disk-only) plus a hard-capped random few not-yet-cached
    /// people per page visit, so the shared Wallpapers.com rate limit
    /// (documented on PeopleBackdropsApiKey's own field: ~30/min without
    /// a key, ~60/min with a free one) is never at risk even for
    /// libraries with hundreds of favorited people.
    /// </summary>
    public bool BackdropsFavoritesPeopleEnabled { get; set; } = true;

    public string BackdropsFavoritesPeopleSourceMode { get; set; } = "WallpapersCom";

    /// <summary>
    /// Phase F (Session 103): same concept as
    /// PeopleBackdropsAppearancesFilter (standalone People Backdrops) -
    /// restricts the Appearances query to movies-only/shows-only/both.
    /// Only relevant when BackdropsFavoritesPeopleSourceMode is
    /// "Appearances".
    /// </summary>
    public string BackdropsFavoritesPeopleAppearancesFilter { get; set; } = "MoviesAndSeries";

    /// <summary>
    /// Session 116: Favorites-People mirrors the standalone People source
    /// blocks (Appearances filter / Backdrops per item / Order / Traversal,
    /// Folder files / Order); Wallpapers.com settings stay central in the
    /// People tab. Same labels, same option lists, same defaults.
    /// </summary>
    public string BackdropsFavoritesPeopleAppearancesMainOnly { get; set; } = "Main";

    public string BackdropsFavoritesPeopleAppearancesSortMode { get; set; } = "Shuffle";

    public string BackdropsFavoritesPeopleAppearancesTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesPeopleAppearancesRandomStart { get; set; }

    public string BackdropsFavoritesPeopleFolderBackdropFiles { get; set; } = "Single";

    public string BackdropsFavoritesPeopleFolderOrderMode { get; set; } = "Sequential";
    public bool BackdropsFavoritesPeopleFolderRandomStart { get; set; }

    public bool BackdropsFavoritesArtistsEnabled { get; set; } = true;

    public string BackdropsFavoritesArtistsSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsFavoritesArtistsTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesArtistsRandomStart { get; set; }

    public bool BackdropsFavoritesAlbumsEnabled { get; set; } = true;

    public string BackdropsFavoritesAlbumsSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsFavoritesAlbumsTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesAlbumsRandomStart { get; set; }

    public bool BackdropsFavoritesSongsEnabled { get; set; } = true;

    public string BackdropsFavoritesSongsSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsFavoritesSongsTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesSongsRandomStart { get; set; }

    public bool BackdropsFavoritesBooksEnabled { get; set; } = true;

    public string BackdropsFavoritesBooksSortMode { get; set; } = "Shuffle";

    /// <summary>See BackdropsGenreTraversalMode's own doc comment.</summary>
    public string BackdropsFavoritesBooksTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsFavoritesBooksRandomStart { get; set; }

    public bool BackdropsEnabled { get; set; } = true;

    // Five independent per-type switches, concept-session decision that
    // was never actually wired up until now (real gap found and fixed
    // per explicit user request - "das wir es ja einzeln schaltbar
    // machen wollten"). Checked = override active for that type;
    // unchecked = fall back to native Jellyfin behavior for that type
    // specifically, independent of the others. All default true -
    // matches this sub-feature's own previous, single-switch behavior
    // (which covered every type uniformly) so upgrading doesn't silently
    // turn anything off that was already on.
    public bool BackdropsShowOnMovies { get; set; } = true;

    // Real gap found via explicit user report: BoxSet (Collections/Sets)
    // items were never one of the explicit type checks in
    // BackdropsController.cs's own GetSettings() - they fell through to
    // that method's generic "an item type this feature has no opinion
    // on, don't block" else branch, which left the override silently
    // active for Sets regardless of this settings page's own state (no
    // checkbox existed to turn it off). Default true for the same
    // upgrade-compatibility reason as the five siblings above - Sets was
    // already effectively "on" before this fix, so this just makes that
    // existing behavior explicit and switchable rather than changing it.
    public bool BackdropsShowOnSets { get; set; } = true;

    public bool BackdropsShowOnTvShows { get; set; } = true;

    public bool BackdropsShowOnSeasons { get; set; } = true;

    public bool BackdropsShowOnEpisodes { get; set; } = true;

    public bool BackdropsShowOnVideos { get; set; } = true;

    /// <summary>Master switch for Red Carpet (curriculum section H). Server-side kill switch, see RedCarpetController.</summary>
    public bool RedCarpetEnabled { get; set; } = true;

    /// <summary>
    /// CHANGED: used to be hardcoded to ".png" only in
    /// RedCarpetController's own file search - real gap found and fixed
    /// per explicit user request ("Allowed image formats" added, "ganz
    /// oben", matching the pattern every other feature already has).
    /// Default stays "png" alone, matching the previous hardcoded
    /// behavior exactly - an upgrade must not silently start matching
    /// formats it never did before.
    /// </summary>
    public string RedCarpetAllowedFormats { get; set; } = "png";

    // ───────────────────────── LogoArt tab ─────────────────────────
    // Session 134 (concept: docs/artworkplus-logoart-concept.md, Parts B/H).
    // One block per item type: a source chain (Source -> Fallback -> Second
    // fallback) for the logo slot of detail pages, the inheritance level
    // (Source mode, inheriting types only), geometry PER STAGE KIND (logo:
    // Size/Offset/Vertical offset of the vanilla slot; Clearart: the same
    // three for its 16:9 box on the ribbon line; Characterart: the real
    // Characterart sizing block - Scale by / Height + max width / Width +
    // max height / Align / Offset - for its box on the ribbon line, height 0
    // = from the ribbon line up to the page top) and, where Characterart is
    // a possible stage (Movie/Series/Season/Episode/Set), the slot's OWN
    // rotation fields - independent of the Characterart tab (user decision
    // 2026-09-21; only the file lookup is shared). Set / Season / Episode
    // carry a "Settings" switch: TakeOver = use the Movies / Series block
    // (only their own Source mode stays), Individual = their own rows.
    // Defaults are "zero intervention": VanillaLogo / None / None / Default /
    // 100 / 0 / 0 - the client never touches such a type (concept B3).
    // Effective values: Helpers/LogoArtSettings.cs.

    /// <summary>Master switch for LogoArt (General tab). Server-side kill switch, see LogoArtController.</summary>
    public bool LogoArtEnabled { get; set; } = true;

    // --- LogoArt: Movie ---
    /// <summary>VanillaLogo / Clearart / Characterart / Hide - the first stage of the Movie chain.</summary>
    public string LogoArtMovieSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart / Characterart - used when the source has no image.</summary>
    public string LogoArtMovieFallback { get; set; } = "None";

    public string LogoArtMovieSecondFallback { get; set; } = "None";

    /// <summary>Default / ItemOnly / Parent / Grandparent - which inheritance level the VanillaLogo/Clearart stages read (Default = item first, then its parents like Jellyfin).</summary>
    public string LogoArtMovieSourceMode { get; set; } = "Default";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtMovieLogoSizePercent { get; set; } = 100;

    public double LogoArtMovieLogoOffsetVw { get; set; }

    public double LogoArtMovieLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtMovieClearartSizePercent { get; set; } = 100;

    public double LogoArtMovieClearartOffsetVw { get; set; }

    public double LogoArtMovieClearartVerticalOffsetVh { get; set; }

    /// <summary>Characterart stage: the Characterart tab's sizing block for the box standing on the ribbon line. Height 0 = from the ribbon line up to the page top.</summary>
    public string LogoArtMovieCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtMovieCharacterartHeightVh { get; set; }

    public double LogoArtMovieCharacterartMaxWidthVw { get; set; }

    public double LogoArtMovieCharacterartWidthVw { get; set; } = 20;

    public double LogoArtMovieCharacterartMaxHeightVh { get; set; }

    public string LogoArtMovieCharacterartHorizontalAlign { get; set; } = "Center";

    public double LogoArtMovieCharacterartOffsetVw { get; set; }

    /// <summary>Rotation of the Characterart stage in the slot - same meaning as the Characterart tab's fields, but its own values.</summary>
    public bool LogoArtMovieMultiImage { get; set; } = true;

    public string LogoArtMovieOrderMode { get; set; } = "Shuffle";

    public bool LogoArtMovieSinglePass { get; set; }

    public bool LogoArtMovieRandomStart { get; set; }

    public bool LogoArtMovieStaySingleImageStatic { get; set; }

    public int LogoArtMovieCycleTimeMs { get; set; } = 5000;

    public int LogoArtMovieFadeTimeMs { get; set; } = 1000;

    // --- LogoArt: Series ---
    /// <summary>VanillaLogo / Clearart / Characterart / Hide - the first stage of the Series chain.</summary>
    public string LogoArtSeriesSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart / Characterart - used when the source has no image.</summary>
    public string LogoArtSeriesFallback { get; set; } = "None";

    public string LogoArtSeriesSecondFallback { get; set; } = "None";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtSeriesLogoSizePercent { get; set; } = 100;

    public double LogoArtSeriesLogoOffsetVw { get; set; }

    public double LogoArtSeriesLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtSeriesClearartSizePercent { get; set; } = 100;

    public double LogoArtSeriesClearartOffsetVw { get; set; }

    public double LogoArtSeriesClearartVerticalOffsetVh { get; set; }

    /// <summary>Characterart stage: the Characterart tab's sizing block for the box standing on the ribbon line. Height 0 = from the ribbon line up to the page top.</summary>
    public string LogoArtSeriesCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtSeriesCharacterartHeightVh { get; set; }

    public double LogoArtSeriesCharacterartMaxWidthVw { get; set; }

    public double LogoArtSeriesCharacterartWidthVw { get; set; } = 20;

    public double LogoArtSeriesCharacterartMaxHeightVh { get; set; }

    public string LogoArtSeriesCharacterartHorizontalAlign { get; set; } = "Center";

    public double LogoArtSeriesCharacterartOffsetVw { get; set; }

    /// <summary>Rotation of the Characterart stage in the slot - same meaning as the Characterart tab's fields, but its own values.</summary>
    public bool LogoArtSeriesMultiImage { get; set; } = true;

    public string LogoArtSeriesOrderMode { get; set; } = "Shuffle";

    public bool LogoArtSeriesSinglePass { get; set; }

    public bool LogoArtSeriesRandomStart { get; set; }

    public bool LogoArtSeriesStaySingleImageStatic { get; set; }

    public int LogoArtSeriesCycleTimeMs { get; set; } = 5000;

    public int LogoArtSeriesFadeTimeMs { get; set; } = 1000;

    // --- LogoArt: Season ---
    /// <summary>TakeOverSeries / Individual - use the Series block (own Source mode kept) or this type's own rows.</summary>
    public string LogoArtSeasonSettings { get; set; } = "TakeOverSeries";

    /// <summary>VanillaLogo / Clearart / Characterart / Hide - the first stage of the Season chain.</summary>
    public string LogoArtSeasonSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart / Characterart - used when the source has no image.</summary>
    public string LogoArtSeasonFallback { get; set; } = "None";

    public string LogoArtSeasonSecondFallback { get; set; } = "None";

    /// <summary>Default / SeasonOnly / Series - which inheritance level the VanillaLogo/Clearart stages read (Default = item first, then its parents like Jellyfin).</summary>
    public string LogoArtSeasonSourceMode { get; set; } = "Default";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtSeasonLogoSizePercent { get; set; } = 100;

    public double LogoArtSeasonLogoOffsetVw { get; set; }

    public double LogoArtSeasonLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtSeasonClearartSizePercent { get; set; } = 100;

    public double LogoArtSeasonClearartOffsetVw { get; set; }

    public double LogoArtSeasonClearartVerticalOffsetVh { get; set; }

    /// <summary>Characterart stage: the Characterart tab's sizing block for the box standing on the ribbon line. Height 0 = from the ribbon line up to the page top.</summary>
    public string LogoArtSeasonCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtSeasonCharacterartHeightVh { get; set; }

    public double LogoArtSeasonCharacterartMaxWidthVw { get; set; }

    public double LogoArtSeasonCharacterartWidthVw { get; set; } = 20;

    public double LogoArtSeasonCharacterartMaxHeightVh { get; set; }

    public string LogoArtSeasonCharacterartHorizontalAlign { get; set; } = "Center";

    public double LogoArtSeasonCharacterartOffsetVw { get; set; }

    /// <summary>Rotation of the Characterart stage in the slot - same meaning as the Characterart tab's fields, but its own values.</summary>
    public bool LogoArtSeasonMultiImage { get; set; } = true;

    public string LogoArtSeasonOrderMode { get; set; } = "Shuffle";

    public bool LogoArtSeasonSinglePass { get; set; }

    public bool LogoArtSeasonRandomStart { get; set; }

    public bool LogoArtSeasonStaySingleImageStatic { get; set; }

    public int LogoArtSeasonCycleTimeMs { get; set; } = 5000;

    public int LogoArtSeasonFadeTimeMs { get; set; } = 1000;

    // --- LogoArt: Episode ---
    /// <summary>TakeOverSeries / Individual - use the Series block (own Source mode kept) or this type's own rows.</summary>
    public string LogoArtEpisodeSettings { get; set; } = "TakeOverSeries";

    /// <summary>VanillaLogo / Clearart / Characterart / Hide - the first stage of the Episode chain.</summary>
    public string LogoArtEpisodeSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart / Characterart - used when the source has no image.</summary>
    public string LogoArtEpisodeFallback { get; set; } = "None";

    public string LogoArtEpisodeSecondFallback { get; set; } = "None";

    /// <summary>Default / Season / Series - which inheritance level the VanillaLogo/Clearart stages read (Default = item first, then its parents like Jellyfin).</summary>
    public string LogoArtEpisodeSourceMode { get; set; } = "Default";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtEpisodeLogoSizePercent { get; set; } = 100;

    public double LogoArtEpisodeLogoOffsetVw { get; set; }

    public double LogoArtEpisodeLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtEpisodeClearartSizePercent { get; set; } = 100;

    public double LogoArtEpisodeClearartOffsetVw { get; set; }

    public double LogoArtEpisodeClearartVerticalOffsetVh { get; set; }

    /// <summary>Characterart stage: the Characterart tab's sizing block for the box standing on the ribbon line. Height 0 = from the ribbon line up to the page top.</summary>
    public string LogoArtEpisodeCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtEpisodeCharacterartHeightVh { get; set; }

    public double LogoArtEpisodeCharacterartMaxWidthVw { get; set; }

    public double LogoArtEpisodeCharacterartWidthVw { get; set; } = 20;

    public double LogoArtEpisodeCharacterartMaxHeightVh { get; set; }

    public string LogoArtEpisodeCharacterartHorizontalAlign { get; set; } = "Center";

    public double LogoArtEpisodeCharacterartOffsetVw { get; set; }

    /// <summary>Rotation of the Characterart stage in the slot - same meaning as the Characterart tab's fields, but its own values.</summary>
    public bool LogoArtEpisodeMultiImage { get; set; } = true;

    public string LogoArtEpisodeOrderMode { get; set; } = "Shuffle";

    public bool LogoArtEpisodeSinglePass { get; set; }

    public bool LogoArtEpisodeRandomStart { get; set; }

    public bool LogoArtEpisodeStaySingleImageStatic { get; set; }

    public int LogoArtEpisodeCycleTimeMs { get; set; } = 5000;

    public int LogoArtEpisodeFadeTimeMs { get; set; } = 1000;

    // --- LogoArt: Set ---
    /// <summary>TakeOverMovies / Individual - use the Movies block (own Source mode kept) or this type's own rows.</summary>
    public string LogoArtSetSettings { get; set; } = "TakeOverMovies";

    /// <summary>VanillaLogo / Clearart / Characterart / Hide - the first stage of the Set chain.</summary>
    public string LogoArtSetSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart / Characterart - used when the source has no image.</summary>
    public string LogoArtSetFallback { get; set; } = "None";

    public string LogoArtSetSecondFallback { get; set; } = "None";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtSetLogoSizePercent { get; set; } = 100;

    public double LogoArtSetLogoOffsetVw { get; set; }

    public double LogoArtSetLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtSetClearartSizePercent { get; set; } = 100;

    public double LogoArtSetClearartOffsetVw { get; set; }

    public double LogoArtSetClearartVerticalOffsetVh { get; set; }

    /// <summary>Characterart stage: the Characterart tab's sizing block for the box standing on the ribbon line. Height 0 = from the ribbon line up to the page top.</summary>
    public string LogoArtSetCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtSetCharacterartHeightVh { get; set; }

    public double LogoArtSetCharacterartMaxWidthVw { get; set; }

    public double LogoArtSetCharacterartWidthVw { get; set; } = 20;

    public double LogoArtSetCharacterartMaxHeightVh { get; set; }

    public string LogoArtSetCharacterartHorizontalAlign { get; set; } = "Center";

    public double LogoArtSetCharacterartOffsetVw { get; set; }

    /// <summary>Rotation of the Characterart stage in the slot - same meaning as the Characterart tab's fields, but its own values.</summary>
    public bool LogoArtSetMultiImage { get; set; } = true;

    public string LogoArtSetOrderMode { get; set; } = "Shuffle";

    public bool LogoArtSetSinglePass { get; set; }

    public bool LogoArtSetRandomStart { get; set; }

    public bool LogoArtSetStaySingleImageStatic { get; set; }

    public int LogoArtSetCycleTimeMs { get; set; } = 5000;

    public int LogoArtSetFadeTimeMs { get; set; } = 1000;

    // --- LogoArt: Video ---
    /// <summary>VanillaLogo / Clearart / Hide - the first stage of the Video chain.</summary>
    public string LogoArtVideoSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart - used when the source has no image.</summary>
    public string LogoArtVideoFallback { get; set; } = "None";

    public string LogoArtVideoSecondFallback { get; set; } = "None";

    /// <summary>Default / ItemOnly / Parent / Grandparent - which inheritance level the VanillaLogo/Clearart stages read (Default = item first, then its parents like Jellyfin).</summary>
    public string LogoArtVideoSourceMode { get; set; } = "Default";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtVideoLogoSizePercent { get; set; } = 100;

    public double LogoArtVideoLogoOffsetVw { get; set; }

    public double LogoArtVideoLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtVideoClearartSizePercent { get; set; } = 100;

    public double LogoArtVideoClearartOffsetVw { get; set; }

    public double LogoArtVideoClearartVerticalOffsetVh { get; set; }

    // --- LogoArt: Music video ---
    /// <summary>VanillaLogo / Clearart / Hide - the first stage of the Music video chain.</summary>
    public string LogoArtMusicVideoSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart - used when the source has no image.</summary>
    public string LogoArtMusicVideoFallback { get; set; } = "None";

    public string LogoArtMusicVideoSecondFallback { get; set; } = "None";

    /// <summary>Default / ItemOnly / Parent / Grandparent - which inheritance level the VanillaLogo/Clearart stages read (Default = item first, then its parents like Jellyfin).</summary>
    public string LogoArtMusicVideoSourceMode { get; set; } = "Default";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtMusicVideoLogoSizePercent { get; set; } = 100;

    public double LogoArtMusicVideoLogoOffsetVw { get; set; }

    public double LogoArtMusicVideoLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtMusicVideoClearartSizePercent { get; set; } = 100;

    public double LogoArtMusicVideoClearartOffsetVw { get; set; }

    public double LogoArtMusicVideoClearartVerticalOffsetVh { get; set; }

    // --- LogoArt: Album ---
    /// <summary>VanillaLogo / Clearart / Hide - the first stage of the Album chain.</summary>
    public string LogoArtAlbumSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart - used when the source has no image.</summary>
    public string LogoArtAlbumFallback { get; set; } = "None";

    public string LogoArtAlbumSecondFallback { get; set; } = "None";

    /// <summary>Default / AlbumOnly / Artist - which inheritance level the VanillaLogo/Clearart stages read (Default = item first, then its parents like Jellyfin).</summary>
    public string LogoArtAlbumSourceMode { get; set; } = "Default";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtAlbumLogoSizePercent { get; set; } = 100;

    public double LogoArtAlbumLogoOffsetVw { get; set; }

    public double LogoArtAlbumLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtAlbumClearartSizePercent { get; set; } = 100;

    public double LogoArtAlbumClearartOffsetVw { get; set; }

    public double LogoArtAlbumClearartVerticalOffsetVh { get; set; }

    // --- LogoArt: Artist ---
    /// <summary>VanillaLogo / Clearart / Hide - the first stage of the Artist chain.</summary>
    public string LogoArtArtistSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart - used when the source has no image.</summary>
    public string LogoArtArtistFallback { get; set; } = "None";

    public string LogoArtArtistSecondFallback { get; set; } = "None";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtArtistLogoSizePercent { get; set; } = 100;

    public double LogoArtArtistLogoOffsetVw { get; set; }

    public double LogoArtArtistLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtArtistClearartSizePercent { get; set; } = 100;

    public double LogoArtArtistClearartOffsetVw { get; set; }

    public double LogoArtArtistClearartVerticalOffsetVh { get; set; }

    // --- LogoArt: Book ---
    /// <summary>VanillaLogo / Clearart / Hide - the first stage of the Book chain.</summary>
    public string LogoArtBookSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart - used when the source has no image.</summary>
    public string LogoArtBookFallback { get; set; } = "None";

    public string LogoArtBookSecondFallback { get; set; } = "None";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtBookLogoSizePercent { get; set; } = 100;

    public double LogoArtBookLogoOffsetVw { get; set; }

    public double LogoArtBookLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtBookClearartSizePercent { get; set; } = 100;

    public double LogoArtBookClearartOffsetVw { get; set; }

    public double LogoArtBookClearartVerticalOffsetVh { get; set; }

    // --- LogoArt: Persons (concept Part D - the deliberate "add" exception,
    // vanilla never shows a logo on a person page) ---
    /// <summary>Off / FolderLogo / Text - Off (default) = no logo like Jellyfin; FolderLogo = "Base name".png|webp|jpg in the person's metadata folder; Text = the name rendered in a bundled font.</summary>
    public string LogoArtPersonsSource { get; set; } = "Off";

    /// <summary>None / FolderLogo / Text.</summary>
    public string LogoArtPersonsFallback { get; set; } = "Text";

    /// <summary>File name without extension in the person's folder (png, webp or jpg, first found wins) - also what the bulk creator writes.</summary>
    public string LogoArtPersonsBaseName { get; set; } = "clearlogo";

    /// <summary>Signature / Title / Both - which bundled pool the dropdown shows (Fonts/fonts.json).</summary>
    public string LogoArtPersonsFontPool { get; set; } = "Signature";

    /// <summary>
    /// Comma-separated font files (manifest "file" values) that are ticked
    /// in the dropdown; "*" = every font of the pool. One font = the same
    /// font for everyone; several = one per person, chosen by a stable hash
    /// of the name (LogoArtController.PickFont) - the bulk creator uses the
    /// same pick, so live text and written files always agree.
    /// </summary>
    public string LogoArtPersonsFonts { get; set; } = "*";

    /// <summary>Comma-separated sample names for the dropdown's hover preview.</summary>
    public string LogoArtPersonsPreviewNames { get; set; } = "Scarlett Johansson, Keanu Reeves";

    /// <summary>White stroke that thickens the glyphs, in percent of the font size (0 = font as drawn).</summary>
    public double LogoArtPersonsTextStroke { get; set; }

    /// <summary>Black rim around the letters, in percent of the font size (0 = none, 1 = a fine line).</summary>
    public double LogoArtPersonsOutline { get; set; } = 1;

    /// <summary>Title fonts only: render the name in capitals. Signature fonts always keep their case.</summary>
    public bool LogoArtPersonsUppercase { get; set; }

    public double LogoArtPersonsSizePercent { get; set; } = 100;

    public double LogoArtPersonsOffsetVw { get; set; }

    public double LogoArtPersonsVerticalOffsetVh { get; set; }

    // ───────────────────────── Extraposter tab ─────────────────────────
    // Tab label in the config page: "Extraposter aka Character Poster
    // (Sets)" - the internal name stays "Extraposter" everywhere, see
    // curriculum section D (naming clarification).

    // ───────────────────────── Extraposter tab ─────────────────────────
    // Restructured on user feedback: originally the detail page (Movies
    // only) and the library view (Movies + TV shows separately) had their
    // own, fully duplicated timing/format settings. Simplified to: ONE
    // shared set of timing/format/order/playback values for the whole
    // feature (no longer split by scope or content type at all), plus
    // four independent enable switches (Movies/TV shows × Detail/Library,
    // the same pattern Animated Poster already uses) and naming mode kept
    // separate per content type (Movies vs. TV shows), since the actual
    // naming CONVENTION genuinely differs there (TV has no "Prefixed"
    // option) - naming is the one thing that couldn't reasonably be
    // shared.

    /// <summary>
    /// "Standalone" (poster1.jpg in the movie folder), "Prefixed"
    /// (moviename-poster1.jpg in the movie folder), or "Folder" (an
    /// arbitrarily named subfolder, takes every image file inside it).
    /// Always exactly one variant active.
    /// </summary>
    public string ExtraposterMoviesNamingMode { get; set; } = "Prefixed";

    /// <summary>Only relevant when ExtraposterMoviesNamingMode == "Folder".</summary>
    public string ExtraposterMoviesFolderName { get; set; } = "extraposter";

    /// <summary>
    /// "Standalone" or "Folder" - deliberately WITHOUT "Prefixed": a
    /// series has its own exclusive main folder, prefix disambiguation
    /// isn't needed (the same reasoning as Characterart's TV naming).
    /// </summary>
    public string ExtraposterTvShowsNamingMode { get; set; } = "Standalone";

    /// <summary>Only relevant when ExtraposterTvShowsNamingMode == "Folder".</summary>
    public string ExtraposterTvShowsFolderName { get; set; } = "extraposter";

    /// <summary>
    /// Comma-separated list of allowed image extensions without a dot,
    /// e.g. "jpg,png". A selection from the 7 formats Jellyfin itself
    /// supports (BaseItem.SupportedImageExtensions:
    /// png,jpg,jpeg,webp,tbn,gif,svg). Shared across Movies and TV shows,
    /// detail and library. If all are deselected, ExtraposterEnabled is
    /// also automatically disabled in the config page (self-correction
    /// logic, see configPage.html).
    /// CHANGED: now ALSO shared by Extrakeyart (used to have its own,
    /// separate ExtrakeyartAllowedFormats field) - explicit user request
    /// to detach the format setting from both subs and make it
    /// tab-level, one shared setting for both.
    /// </summary>
    public string AllowedFormats { get; set; } = "jpg";

    /// <summary>Independent on/off switch for the movie detail page.</summary>
    public bool ExtraposterMoviesDetailEnabled { get; set; } = true;

    /// <summary>
    /// Independent on/off switch for the movie library view (library
    /// grid, home-screen rows, similar titles, search, genres,
    /// collections).
    /// </summary>
    public bool ExtraposterMoviesLibraryEnabled { get; set; } = true;

    /// <summary>
    /// Independent on/off switch for the TV show's own detail page.
    /// Applies exclusively to the series' main level, not season/episode.
    /// </summary>
    public bool ExtraposterTvShowsDetailEnabled { get; set; } = true;

    /// <summary>
    /// Independent on/off switch for the TV-show library view. Applies
    /// exclusively to the series' main level, not season/episode.
    /// </summary>
    public bool ExtraposterTvShowsLibraryEnabled { get; set; } = true;

    // ----- Extraposter / movies (and Sets) / detail pages (Session 123: every view has its own
    // full set; nothing is shared between detail and library any more).
    // ExtraposterMoviesDetailEnabled is the view switch and predates the split.
    /// <summary>Sequential | Shuffle | Random - order of the slideshow images.</summary>
    /// <summary>Show on movies in this view (Session 124: Show-on lives per view).</summary>
    public bool ExtraposterMoviesDetailShowOnMovies { get; set; } = true;

    /// <summary>Show on Sets (collections) in this view - Sets use the Movies settings, always Standalone.</summary>
    public bool ExtraposterMoviesDetailShowOnSets { get; set; } = true;

    /// <summary>Sets only (a movie has no children, its files are its only source): FilesFirst | FilesOnly | SetPostersFirst | SetPostersOnly - "first" = the other source only when this one has nothing, "only" = never the other one.</summary>
    public string ExtraposterMoviesDetailSourcePriority { get; set; } = "FilesOnly";

    /// <summary>Ascending | Descending - release date order of the Set's movies (Jellyfin's rule: PremiereDate, else 1 Jan of ProductionYear, else first).</summary>
    public string ExtraposterMoviesDetailSetOrder { get; set; } = "Ascending";
    public bool ExtraposterMoviesDetailSetRandomStart { get; set; }

    /// <summary>Poster | Postercase | Keyart | AnimatedPoster | AnimatedKeyart - which image of each movie in the Set (Postercase/Keyart = the movie's Custom Poster file, found by the Custom Poster tab's naming rules, regardless of that feature's switches).</summary>
    public string ExtraposterMoviesDetailSetImage { get; set; } = "Poster";

    /// <summary>None | Poster | Postercase | Keyart | AnimatedPoster | AnimatedKeyart - used for a movie without the chosen image; None skips the movie.</summary>
    public string ExtraposterMoviesDetailSetFallback { get; set; } = "None";

    /// <summary>Second fallback (Session 126): tried when the first fallback has nothing either; None skips the movie.</summary>
    public string ExtraposterMoviesDetailSetFallback2 { get; set; } = "None";

    /// <summary>Set slideshow with Keyart images: each movie's own Jellyfin Logo drawn over its keyart (Session 125).</summary>
    public bool ExtraposterMoviesDetailSetKeyartLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int ExtraposterMoviesDetailSetKeyartLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int ExtraposterMoviesDetailSetKeyartLogoSizePercent { get; set; } = 60;

    public string ExtraposterMoviesDetailOrderMode { get; set; } = "Sequential";

    /// <summary>true = one pass, then back to the original poster; false = loop.</summary>
    public bool ExtraposterMoviesDetailSinglePass { get; set; } = false;
    public bool ExtraposterMoviesDetailRandomStart { get; set; }

    /// <summary>How long each image is shown (ms).</summary>
    public int ExtraposterMoviesDetailCycleTimeMs { get; set; } = 5000;

    /// <summary>Crossfade duration (ms); clamped to CycleTimeMs.</summary>
    public int ExtraposterMoviesDetailFadeTimeMs { get; set; } = 1000;

    /// <summary>Wait before the slideshow starts (the original poster shows meanwhile).</summary>
    public bool ExtraposterMoviesDetailDelayEnabled { get; set; } = false;

    /// <summary>Length of that wait (ms).</summary>
    public int ExtraposterMoviesDetailDelayMs { get; set; } = 5000;

    // ----- Extraposter / movies (and Sets) / library views (Session 123: every view has its own
    // full set; nothing is shared between detail and library any more).
    // ExtraposterMoviesLibraryEnabled is the view switch and predates the split.
    /// <summary>Sequential | Shuffle | Random - order of the slideshow images.</summary>
    /// <summary>Show on movies in this view (Session 124: Show-on lives per view).</summary>
    public bool ExtraposterMoviesLibraryShowOnMovies { get; set; } = true;

    /// <summary>Show on Sets (collections) in this view - Sets use the Movies settings, always Standalone.</summary>
    public bool ExtraposterMoviesLibraryShowOnSets { get; set; } = true;

    /// <summary>Sets only (a movie has no children, its files are its only source): FilesFirst | FilesOnly | SetPostersFirst | SetPostersOnly - "first" = the other source only when this one has nothing, "only" = never the other one.</summary>
    public string ExtraposterMoviesLibrarySourcePriority { get; set; } = "FilesOnly";

    /// <summary>Ascending | Descending - release date order of the Set's movies (Jellyfin's rule: PremiereDate, else 1 Jan of ProductionYear, else first).</summary>
    public string ExtraposterMoviesLibrarySetOrder { get; set; } = "Ascending";
    public bool ExtraposterMoviesLibrarySetRandomStart { get; set; }

    /// <summary>Poster | Postercase | Keyart | AnimatedPoster | AnimatedKeyart - which image of each movie in the Set (Postercase/Keyart = the movie's Custom Poster file, found by the Custom Poster tab's naming rules, regardless of that feature's switches).</summary>
    public string ExtraposterMoviesLibrarySetImage { get; set; } = "Poster";

    /// <summary>None | Poster | Postercase | Keyart | AnimatedPoster | AnimatedKeyart - used for a movie without the chosen image; None skips the movie.</summary>
    public string ExtraposterMoviesLibrarySetFallback { get; set; } = "None";

    /// <summary>Second fallback (Session 126): tried when the first fallback has nothing either; None skips the movie.</summary>
    public string ExtraposterMoviesLibrarySetFallback2 { get; set; } = "None";

    /// <summary>Set slideshow with Keyart images: each movie's own Jellyfin Logo drawn over its keyart (Session 125).</summary>
    public bool ExtraposterMoviesLibrarySetKeyartLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int ExtraposterMoviesLibrarySetKeyartLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int ExtraposterMoviesLibrarySetKeyartLogoSizePercent { get; set; } = 80;

    public string ExtraposterMoviesLibraryOrderMode { get; set; } = "Sequential";

    /// <summary>true = one pass, then back to the original poster; false = loop.</summary>
    public bool ExtraposterMoviesLibrarySinglePass { get; set; } = false;
    public bool ExtraposterMoviesLibraryRandomStart { get; set; }

    /// <summary>How long each image is shown (ms).</summary>
    public int ExtraposterMoviesLibraryCycleTimeMs { get; set; } = 5000;

    /// <summary>Crossfade duration (ms); clamped to CycleTimeMs.</summary>
    public int ExtraposterMoviesLibraryFadeTimeMs { get; set; } = 1000;

    /// <summary>Wait before the slideshow starts (the original poster shows meanwhile).</summary>
    public bool ExtraposterMoviesLibraryDelayEnabled { get; set; } = false;

    /// <summary>Length of that wait (ms).</summary>
    public int ExtraposterMoviesLibraryDelayMs { get; set; } = 5000;

    /// <summary>Library views only (Session 123, Phase 2): all tiles of a page change on one shared clock; a tile whose first image is late waits for the next tick.</summary>
    public bool ExtraposterMoviesLibrarySyncEnabled { get; set; } = true;

    /// <summary>Library views (Session 124): on = the tile stays blank until our image is ready (no poster flash, slightly later); off = Jellyfin's poster shows first, ours replaces it.</summary>
    public bool ExtraposterMoviesLibrarySeamlessEnabled { get; set; } = true;

    // ----- Extraposter / TV shows / detail pages (Session 123: every view has its own
    // full set; nothing is shared between detail and library any more).
    // ExtraposterTvShowsDetailEnabled is the view switch and predates the split.
    /// <summary>Sequential | Shuffle | Random - order of the slideshow images.</summary>
    /// <summary>Show on TV shows in this view (Session 124: Show-on lives per view).</summary>
    public bool ExtraposterTvShowsDetailShowOnTvShows { get; set; } = true;

    /// <summary>FilesFirst | FilesOnly | SeasonPostersFirst | SeasonPostersOnly - "first" = the other source only when this one has nothing, "only" = never the other one.</summary>
    public string ExtraposterTvShowsDetailSourcePriority { get; set; } = "FilesOnly";

    /// <summary>Ascending | Descending - season number order.</summary>
    public string ExtraposterTvShowsDetailSeasonOrder { get; set; } = "Ascending";
    public bool ExtraposterTvShowsDetailSeasonRandomStart { get; set; }

    /// <summary>Season 0 (specials) included, always first.</summary>
    public bool ExtraposterTvShowsDetailIncludeSpecials { get; set; } = false;

    /// <summary>A series with only one season poster gets no season slideshow (falls back to the other source).</summary>
    public bool ExtraposterTvShowsDetailSkipSingleSeason { get; set; } = true;

    public string ExtraposterTvShowsDetailOrderMode { get; set; } = "Sequential";

    /// <summary>true = one pass, then back to the original poster; false = loop.</summary>
    public bool ExtraposterTvShowsDetailSinglePass { get; set; } = false;
    public bool ExtraposterTvShowsDetailRandomStart { get; set; }

    /// <summary>How long each image is shown (ms).</summary>
    public int ExtraposterTvShowsDetailCycleTimeMs { get; set; } = 5000;

    /// <summary>Crossfade duration (ms); clamped to CycleTimeMs.</summary>
    public int ExtraposterTvShowsDetailFadeTimeMs { get; set; } = 1000;

    /// <summary>Wait before the slideshow starts (the original poster shows meanwhile).</summary>
    public bool ExtraposterTvShowsDetailDelayEnabled { get; set; } = false;

    /// <summary>Length of that wait (ms).</summary>
    public int ExtraposterTvShowsDetailDelayMs { get; set; } = 5000;

    // ----- Extraposter / TV shows / library views (Session 123: every view has its own
    // full set; nothing is shared between detail and library any more).
    // ExtraposterTvShowsLibraryEnabled is the view switch and predates the split.
    /// <summary>Sequential | Shuffle | Random - order of the slideshow images.</summary>
    /// <summary>Show on TV shows in this view (Session 124: Show-on lives per view).</summary>
    public bool ExtraposterTvShowsLibraryShowOnTvShows { get; set; } = true;

    /// <summary>FilesFirst | FilesOnly | SeasonPostersFirst | SeasonPostersOnly - "first" = the other source only when this one has nothing, "only" = never the other one.</summary>
    public string ExtraposterTvShowsLibrarySourcePriority { get; set; } = "FilesOnly";

    /// <summary>Ascending | Descending - season number order.</summary>
    public string ExtraposterTvShowsLibrarySeasonOrder { get; set; } = "Ascending";
    public bool ExtraposterTvShowsLibrarySeasonRandomStart { get; set; }

    /// <summary>Season 0 (specials) included, always first.</summary>
    public bool ExtraposterTvShowsLibraryIncludeSpecials { get; set; } = false;

    /// <summary>A series with only one season poster gets no season slideshow (falls back to the other source).</summary>
    public bool ExtraposterTvShowsLibrarySkipSingleSeason { get; set; } = true;

    public string ExtraposterTvShowsLibraryOrderMode { get; set; } = "Sequential";

    /// <summary>true = one pass, then back to the original poster; false = loop.</summary>
    public bool ExtraposterTvShowsLibrarySinglePass { get; set; } = false;
    public bool ExtraposterTvShowsLibraryRandomStart { get; set; }

    /// <summary>How long each image is shown (ms).</summary>
    public int ExtraposterTvShowsLibraryCycleTimeMs { get; set; } = 5000;

    /// <summary>Crossfade duration (ms); clamped to CycleTimeMs.</summary>
    public int ExtraposterTvShowsLibraryFadeTimeMs { get; set; } = 1000;

    /// <summary>Wait before the slideshow starts (the original poster shows meanwhile).</summary>
    public bool ExtraposterTvShowsLibraryDelayEnabled { get; set; } = false;

    /// <summary>Length of that wait (ms).</summary>
    public int ExtraposterTvShowsLibraryDelayMs { get; set; } = 5000;

    /// <summary>Library views only (Session 123, Phase 2): all tiles of a page change on one shared clock; a tile whose first image is late waits for the next tick.</summary>
    public bool ExtraposterTvShowsLibrarySyncEnabled { get; set; } = true;

    /// <summary>Library views (Session 124): on = the tile stays blank until our image is ready (no poster flash, slightly later); off = Jellyfin's poster shows first, ours replaces it.</summary>
    public bool ExtraposterTvShowsLibrarySeamlessEnabled { get; set; } = true;

    /// <summary>
    /// Which of Extraposter/Extrakeyart wins when BOTH are enabled and
    /// both have candidates for the same title - concept-session
    /// decision, user-configurable, lives in the Extraposter tab itself
    /// (same placement pattern as CustomPosterPriority in the Custom
    /// Poster tab - corrected earlier this session after an initial
    /// wrong placement in General). "Extraposter" or "Extrakeyart".
    /// </summary>
    public string ExtraposterPriority { get; set; } = "Extraposter";

    // ───────────────────────── Extraposter tab: Extrakeyart ─────────────────────────
    // Multi-image variant of Keyart - lives in the SAME controller/module
    // as Extraposter (ExtraposterController.cs / Posters-v1.js's own
    // ExtraModule), concept-session decision, same reasoning as
    // Postercase/Keyart sharing CustomPosterController.cs. Own field set,
    // mirrors Extraposter's own one-to-one. Rotation timing (Order/Cycle/
    // Fade/Delay/SinglePass) is shared/global for Extraposter itself (no
    // Movies/TvShows split there) - Extrakeyart gets its own, equally
    // global set, independent of Extraposter's.

    public bool ExtrakeyartEnabled { get; set; } = true;

    // REMOVED: ExtrakeyartAllowedFormats - merged into the shared,
    // tab-level AllowedFormats above (explicit user request - detached
    // from both Extraposter and Extrakeyart, now covers both).

    public string ExtrakeyartMoviesNamingMode { get; set; } = "Prefixed";

    public string ExtrakeyartMoviesFolderName { get; set; } = "keyart";

    public bool ExtrakeyartMoviesDetailEnabled { get; set; } = true;

    public bool ExtrakeyartMoviesLibraryEnabled { get; set; } = true;

    public string ExtrakeyartTvShowsNamingMode { get; set; } = "Standalone";

    public string ExtrakeyartTvShowsFolderName { get; set; } = "keyart";

    public bool ExtrakeyartTvShowsDetailEnabled { get; set; } = true;

    public bool ExtrakeyartTvShowsLibraryEnabled { get; set; } = true;

    // ----- Extrakeyart / movies (and Sets) / detail pages (Session 123: every view has its own
    // full set; nothing is shared between detail and library any more).
    // ExtrakeyartMoviesDetailEnabled is the view switch and predates the split.
    /// <summary>Sequential | Shuffle | Random - order of the slideshow images.</summary>
    /// <summary>Show on movies in this view (Session 124: Show-on lives per view).</summary>
    public bool ExtrakeyartMoviesDetailShowOnMovies { get; set; } = true;

    /// <summary>Show on Sets (collections) in this view - Sets use the Movies settings, always Standalone.</summary>
    public bool ExtrakeyartMoviesDetailShowOnSets { get; set; } = true;

    public string ExtrakeyartMoviesDetailOrderMode { get; set; } = "Sequential";
    /// <summary>Ignored | Counts - whether a file without a number (keyart.jpg) is picked up as the first image (Session 125: per view).</summary>
    public string ExtrakeyartMoviesDetailUnnumberedMode { get; set; } = "Ignored";


    /// <summary>true = one pass, then back to the original poster; false = loop.</summary>
    public bool ExtrakeyartMoviesDetailSinglePass { get; set; } = false;
    public bool ExtrakeyartMoviesDetailRandomStart { get; set; }

    /// <summary>How long each image is shown (ms).</summary>
    public int ExtrakeyartMoviesDetailCycleTimeMs { get; set; } = 5000;

    /// <summary>Crossfade duration (ms); clamped to CycleTimeMs.</summary>
    public int ExtrakeyartMoviesDetailFadeTimeMs { get; set; } = 1000;

    /// <summary>Wait before the slideshow starts (the original poster shows meanwhile).</summary>
    public bool ExtrakeyartMoviesDetailDelayEnabled { get; set; } = false;

    /// <summary>Length of that wait (ms).</summary>
    public int ExtrakeyartMoviesDetailDelayMs { get; set; } = 5000;

    /// <summary>Jellyfin's Logo image drawn over the keyart (detail pages).</summary>
    public bool ExtrakeyartMoviesDetailLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int ExtrakeyartMoviesDetailLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int ExtrakeyartMoviesDetailLogoSizePercent { get; set; } = 60;

    // ----- Extrakeyart / movies (and Sets) / library views (Session 123: every view has its own
    // full set; nothing is shared between detail and library any more).
    // ExtrakeyartMoviesLibraryEnabled is the view switch and predates the split.
    /// <summary>Sequential | Shuffle | Random - order of the slideshow images.</summary>
    /// <summary>Show on movies in this view (Session 124: Show-on lives per view).</summary>
    public bool ExtrakeyartMoviesLibraryShowOnMovies { get; set; } = true;

    /// <summary>Show on Sets (collections) in this view - Sets use the Movies settings, always Standalone.</summary>
    public bool ExtrakeyartMoviesLibraryShowOnSets { get; set; } = true;

    public string ExtrakeyartMoviesLibraryOrderMode { get; set; } = "Sequential";
    /// <summary>Ignored | Counts - whether a file without a number (keyart.jpg) is picked up as the first image (Session 125: per view).</summary>
    public string ExtrakeyartMoviesLibraryUnnumberedMode { get; set; } = "Ignored";


    /// <summary>true = one pass, then back to the original poster; false = loop.</summary>
    public bool ExtrakeyartMoviesLibrarySinglePass { get; set; } = false;
    public bool ExtrakeyartMoviesLibraryRandomStart { get; set; }

    /// <summary>How long each image is shown (ms).</summary>
    public int ExtrakeyartMoviesLibraryCycleTimeMs { get; set; } = 5000;

    /// <summary>Crossfade duration (ms); clamped to CycleTimeMs.</summary>
    public int ExtrakeyartMoviesLibraryFadeTimeMs { get; set; } = 1000;

    /// <summary>Wait before the slideshow starts (the original poster shows meanwhile).</summary>
    public bool ExtrakeyartMoviesLibraryDelayEnabled { get; set; } = false;

    /// <summary>Length of that wait (ms).</summary>
    public int ExtrakeyartMoviesLibraryDelayMs { get; set; } = 5000;

    /// <summary>Jellyfin's Logo image drawn over the keyart (library views).</summary>
    public bool ExtrakeyartMoviesLibraryLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int ExtrakeyartMoviesLibraryLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int ExtrakeyartMoviesLibraryLogoSizePercent { get; set; } = 80;

    /// <summary>Library views only (Session 123, Phase 2): all tiles of a page change on one shared clock; a tile whose first image is late waits for the next tick.</summary>
    public bool ExtrakeyartMoviesLibrarySyncEnabled { get; set; } = true;

    /// <summary>Library views (Session 124): on = the tile stays blank until our image is ready (no poster flash, slightly later); off = Jellyfin's poster shows first, ours replaces it.</summary>
    public bool ExtrakeyartMoviesLibrarySeamlessEnabled { get; set; } = true;

    // ----- Extrakeyart / TV shows / detail pages (Session 123: every view has its own
    // full set; nothing is shared between detail and library any more).
    // ExtrakeyartTvShowsDetailEnabled is the view switch and predates the split.
    /// <summary>Sequential | Shuffle | Random - order of the slideshow images.</summary>
    /// <summary>Show on TV shows in this view (Session 124: Show-on lives per view).</summary>
    public bool ExtrakeyartTvShowsDetailShowOnTvShows { get; set; } = true;

    public string ExtrakeyartTvShowsDetailOrderMode { get; set; } = "Sequential";
    /// <summary>Ignored | Counts - whether a file without a number (keyart.jpg) is picked up as the first image (Session 125: per view).</summary>
    public string ExtrakeyartTvShowsDetailUnnumberedMode { get; set; } = "Ignored";


    /// <summary>true = one pass, then back to the original poster; false = loop.</summary>
    public bool ExtrakeyartTvShowsDetailSinglePass { get; set; } = false;
    public bool ExtrakeyartTvShowsDetailRandomStart { get; set; }

    /// <summary>How long each image is shown (ms).</summary>
    public int ExtrakeyartTvShowsDetailCycleTimeMs { get; set; } = 5000;

    /// <summary>Crossfade duration (ms); clamped to CycleTimeMs.</summary>
    public int ExtrakeyartTvShowsDetailFadeTimeMs { get; set; } = 1000;

    /// <summary>Wait before the slideshow starts (the original poster shows meanwhile).</summary>
    public bool ExtrakeyartTvShowsDetailDelayEnabled { get; set; } = false;

    /// <summary>Length of that wait (ms).</summary>
    public int ExtrakeyartTvShowsDetailDelayMs { get; set; } = 5000;

    /// <summary>Jellyfin's Logo image drawn over the keyart (detail pages).</summary>
    public bool ExtrakeyartTvShowsDetailLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int ExtrakeyartTvShowsDetailLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int ExtrakeyartTvShowsDetailLogoSizePercent { get; set; } = 60;

    // ----- Extrakeyart / TV shows / library views (Session 123: every view has its own
    // full set; nothing is shared between detail and library any more).
    // ExtrakeyartTvShowsLibraryEnabled is the view switch and predates the split.
    /// <summary>Sequential | Shuffle | Random - order of the slideshow images.</summary>
    /// <summary>Show on TV shows in this view (Session 124: Show-on lives per view).</summary>
    public bool ExtrakeyartTvShowsLibraryShowOnTvShows { get; set; } = true;

    public string ExtrakeyartTvShowsLibraryOrderMode { get; set; } = "Sequential";
    /// <summary>Ignored | Counts - whether a file without a number (keyart.jpg) is picked up as the first image (Session 125: per view).</summary>
    public string ExtrakeyartTvShowsLibraryUnnumberedMode { get; set; } = "Ignored";


    /// <summary>true = one pass, then back to the original poster; false = loop.</summary>
    public bool ExtrakeyartTvShowsLibrarySinglePass { get; set; } = false;
    public bool ExtrakeyartTvShowsLibraryRandomStart { get; set; }

    /// <summary>How long each image is shown (ms).</summary>
    public int ExtrakeyartTvShowsLibraryCycleTimeMs { get; set; } = 5000;

    /// <summary>Crossfade duration (ms); clamped to CycleTimeMs.</summary>
    public int ExtrakeyartTvShowsLibraryFadeTimeMs { get; set; } = 1000;

    /// <summary>Wait before the slideshow starts (the original poster shows meanwhile).</summary>
    public bool ExtrakeyartTvShowsLibraryDelayEnabled { get; set; } = false;

    /// <summary>Length of that wait (ms).</summary>
    public int ExtrakeyartTvShowsLibraryDelayMs { get; set; } = 5000;

    /// <summary>Jellyfin's Logo image drawn over the keyart (library views).</summary>
    public bool ExtrakeyartTvShowsLibraryLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int ExtrakeyartTvShowsLibraryLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int ExtrakeyartTvShowsLibraryLogoSizePercent { get; set; } = 80;

    /// <summary>Library views only (Session 123, Phase 2): all tiles of a page change on one shared clock; a tile whose first image is late waits for the next tick.</summary>
    public bool ExtrakeyartTvShowsLibrarySyncEnabled { get; set; } = true;

    /// <summary>Library views (Session 124): on = the tile stays blank until our image is ready (no poster flash, slightly later); off = Jellyfin's poster shows first, ours replaces it.</summary>
    public bool ExtrakeyartTvShowsLibrarySeamlessEnabled { get; set; } = true;

    // ───────────────────────── Characterart tab ─────────────────────────
    // Curriculum section E. A completely separate feature block,
    // independent of Extraposter - its own placement on the page instead
    // of in the poster slot, detail views only (no library extension).
    // Movies and TV (series/season/episode) again fully separately
    // configurable, as everywhere else (consistency principle D0).

    /// <summary>
    /// Where Characterart may show up at all - four independently
    /// selectable content types (curriculum E). Season/Episode always show
    /// the series' main-folder content (see CharacterartTvShows* below),
    /// these four switches only control on which PAGES Characterart shows
    /// up at all.
    /// </summary>
    public bool CharacterartShowOnMovies { get; set; } = true;

    // Real user request: Sets (BoxSet/Collections) added as a fifth
    // content type, positioned right after Movies. No dedicated
    // Characterart*Sets* settings of its own exist - it shares every
    // Movies setting (TypeName, FolderName, MultiImage, etc.) exactly the
    // way Season/Episode already share the TvShows settings above (see
    // this property's own class-level doc comment) - EXCEPT NamingMode,
    // which is always forced to "Standalone" for Sets regardless of
    // whatever CharacterartMoviesNamingMode is currently set to (a
    // "prefixed" filename needs a single, specific movie's own name to
    // prefix with - a Set has no single movie, so that mode has no
    // meaningful application here). Enforced in
    // CharacterartController.cs's own ResolveItem(), not here - this
    // field only controls whether Sets participates at all.
    public bool CharacterartShowOnSets { get; set; } = true;

    public bool CharacterartShowOnTvShows { get; set; } = true;

    public bool CharacterartShowOnSeasons { get; set; } = true;

    public bool CharacterartShowOnEpisodes { get; set; } = true;

    /// <summary>
    /// Comma-separated allowed formats, the same 7 as Extraposter, but its
    /// own field - Characterart will usually be .png in practice, but
    /// deliberately not restricted to that in the code (curriculum E).
    /// </summary>
    public string CharacterartAllowedFormats { get; set; } = "png";

    /// <summary>
    /// Position AND size/offset are now configured separately per content
    /// type (Movies vs. TV shows), not shared - added on user feedback:
    /// the Placement section now lives inside each of the Movies/TV
    /// shows collapsible sections in the config page, matching that a
    /// movie's detail page and a show's detail page could reasonably
    /// want the artwork positioned differently. "TopLeft", "TopRight",
    /// "BottomLeft", or "BottomRight" - exactly one of the four positions
    /// verified in the curriculum is active per content type.
    /// </summary>
    public string CharacterartMoviesPosition { get; set; } = "TopRight";

    /// <summary>
    /// Sizing is configured PER POSITION (one full set per one of the
    /// four positions), not shared - switching positions previously
    /// reused the same size/offset for all four, which doesn't make
    /// sense given how different the four spots on the page are. Only
    /// the currently selected position's set is actually used at runtime
    /// (see CharacterartController.GetCharacterart); the other three
    /// stay stored so values aren't lost when switching positions back
    /// and forth.
    ///
    /// REDESIGNED after a real construction flaw was found in the
    /// original single-SizeVw-in-vw approach: a pure vw (viewport WIDTH)
    /// size doesn't scale correctly against the actual constraint, which
    /// is VERTICAL space (header to available room, itself driven by em/
    /// vh values, not vw) - width and the real height constraint scale
    /// along genuinely independent axes depending on the window's aspect
    /// ratio, so no single fixed vw value works correctly across
    /// different window shapes. Now split into an explicit choice:
    /// ScaleMode ("Height" or "Width") picks which dimension is the
    /// primary, directly-configured one; the OTHER dimension either
    /// follows automatically (from the loaded image's own aspect ratio)
    /// or is additionally capped, if its own Max*Vw/Max*Vh value is
    /// non-zero. HorizontalAlign controls how the image sits within any
    /// LEFTOVER horizontal space (only ever relevant when a rotation
    /// image's own aspect ratio doesn't exactly match the reference
    /// image that first established the box's fixed size - see
    /// characterart.js's own object-position handling). OffsetVw
    /// (horizontal, unchanged from before) shifts the whole box - not to
    /// be confused with HorizontalAlign, which only affects where the
    /// image sits WITHIN the (unmoved) box.
    /// </summary>
    public string CharacterartMoviesTopLeftScaleMode { get; set; } = "Height";

    public double CharacterartMoviesTopLeftHeightVh { get; set; } = 20;

    public double CharacterartMoviesTopLeftMaxWidthVw { get; set; } = 12;

    public double CharacterartMoviesTopLeftWidthVw { get; set; } = 11.5;

    public double CharacterartMoviesTopLeftMaxHeightVh { get; set; }

    public string CharacterartMoviesTopLeftHorizontalAlign { get; set; } = "Center";

    public double CharacterartMoviesTopLeftOffsetVw { get; set; } = 4;

    // Per-position fullscreen offset (see the general doc comment on
    // CharacterartMoviesTopRightFullscreenOffsetVw below for the full
    // reasoning) - added on top of the OffsetVw above ONLY while the
    // browser tab is in fullscreen.
    public double CharacterartMoviesTopLeftFullscreenOffsetVw { get; set; } = -2.5;

    public string CharacterartMoviesTopRightScaleMode { get; set; } = "Height";

    public double CharacterartMoviesTopRightHeightVh { get; set; } = 20;

    public double CharacterartMoviesTopRightMaxWidthVw { get; set; } = 12;

    public double CharacterartMoviesTopRightWidthVw { get; set; } = 11.5;

    public double CharacterartMoviesTopRightMaxHeightVh { get; set; }

    public string CharacterartMoviesTopRightHorizontalAlign { get; set; } = "Center";

    public double CharacterartMoviesTopRightOffsetVw { get; set; } = -5;

    /// <summary>
    /// Extra horizontal offset (in vw) applied on top of the
    /// position-specific OffsetVw above, but ONLY while the browser tab
    /// is in fullscreen (document.fullscreenElement, checked
    /// client-side in characterart.js). One of these per
    /// position/media-type combination (same granularity as OffsetVw
    /// itself) - a direct, admin-tunable way to correct for a small
    /// residual positioning drift between windowed and fullscreen that
    /// wasn't fully eliminated by fixing the underlying proportional-
    /// scaling math alone (frozen-gap-width-fraction fix, matching the
    /// native .detailLogo's own display:none breakpoint at 1100px).
    /// Originally a single global value shared by every position; split
    /// per-position after the user found windowed and fullscreen need
    /// visibly different corrections at different positions, not one
    /// shared amount.
    /// Session 119: default 0 everywhere (was -2/+2 for the top
    /// positions) - the CSS clearlogo replica removed the poster anchor
    /// that caused the fullscreen drift, so no correction is needed by
    /// default; the field stays for fine-tuning (applied via a body class
    /// the client toggles, see Core.installFullscreenClass()).
    /// </summary>
    public double CharacterartMoviesTopRightFullscreenOffsetVw { get; set; } = 2.5;

    public string CharacterartMoviesBottomLeftScaleMode { get; set; } = "Height";

    public double CharacterartMoviesBottomLeftHeightVh { get; set; } = 30;

    public double CharacterartMoviesBottomLeftMaxWidthVw { get; set; } = 30;

    public double CharacterartMoviesBottomLeftWidthVw { get; set; } = 11.5;

    public double CharacterartMoviesBottomLeftMaxHeightVh { get; set; }

    public string CharacterartMoviesBottomLeftHorizontalAlign { get; set; } = "Center";

    public double CharacterartMoviesBottomLeftOffsetVw { get; set; } = -1.5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw's own doc comment for the full reasoning.
    public double CharacterartMoviesBottomLeftFullscreenOffsetVw { get; set; }

    public string CharacterartMoviesBottomRightScaleMode { get; set; } = "Height";

    public double CharacterartMoviesBottomRightHeightVh { get; set; } = 30;

    public double CharacterartMoviesBottomRightMaxWidthVw { get; set; } = 30;

    public double CharacterartMoviesBottomRightWidthVw { get; set; } = 11.5;

    public double CharacterartMoviesBottomRightMaxHeightVh { get; set; }

    public string CharacterartMoviesBottomRightHorizontalAlign { get; set; } = "Center";

    public double CharacterartMoviesBottomRightOffsetVw { get; set; } = 1.5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw's own doc comment for the full reasoning.
    public double CharacterartMoviesBottomRightFullscreenOffsetVw { get; set; }

    /// <summary>Same as <see cref="CharacterartMoviesPosition"/>, but for TV shows.</summary>
    public string CharacterartTvShowsPosition { get; set; } = "TopRight";

    public string CharacterartTvShowsTopLeftScaleMode { get; set; } = "Height";

    public double CharacterartTvShowsTopLeftHeightVh { get; set; } = 20;

    public double CharacterartTvShowsTopLeftMaxWidthVw { get; set; } = 12;

    public double CharacterartTvShowsTopLeftWidthVw { get; set; } = 11.5;

    public double CharacterartTvShowsTopLeftMaxHeightVh { get; set; }

    public string CharacterartTvShowsTopLeftHorizontalAlign { get; set; } = "Center";

    public double CharacterartTvShowsTopLeftOffsetVw { get; set; } = 4;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw's own doc comment for the full reasoning.
    public double CharacterartTvShowsTopLeftFullscreenOffsetVw { get; set; } = -2.5;

    public string CharacterartTvShowsTopRightScaleMode { get; set; } = "Height";

    public double CharacterartTvShowsTopRightHeightVh { get; set; } = 20;

    public double CharacterartTvShowsTopRightMaxWidthVw { get; set; } = 12;

    public double CharacterartTvShowsTopRightWidthVw { get; set; } = 11.5;

    public double CharacterartTvShowsTopRightMaxHeightVh { get; set; }

    public string CharacterartTvShowsTopRightHorizontalAlign { get; set; } = "Center";

    public double CharacterartTvShowsTopRightOffsetVw { get; set; } = -5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw's own doc comment for the full reasoning.
    public double CharacterartTvShowsTopRightFullscreenOffsetVw { get; set; } = 2.5;

    public string CharacterartTvShowsBottomLeftScaleMode { get; set; } = "Height";

    public double CharacterartTvShowsBottomLeftHeightVh { get; set; } = 30;

    public double CharacterartTvShowsBottomLeftMaxWidthVw { get; set; } = 30;

    public double CharacterartTvShowsBottomLeftWidthVw { get; set; } = 11.5;

    public double CharacterartTvShowsBottomLeftMaxHeightVh { get; set; }

    public string CharacterartTvShowsBottomLeftHorizontalAlign { get; set; } = "Center";

    public double CharacterartTvShowsBottomLeftOffsetVw { get; set; } = -1.5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw's own doc comment for the full reasoning.
    public double CharacterartTvShowsBottomLeftFullscreenOffsetVw { get; set; }

    public string CharacterartTvShowsBottomRightScaleMode { get; set; } = "Height";

    public double CharacterartTvShowsBottomRightHeightVh { get; set; } = 30;

    public double CharacterartTvShowsBottomRightMaxWidthVw { get; set; } = 30;

    public double CharacterartTvShowsBottomRightWidthVw { get; set; } = 11.5;

    public double CharacterartTvShowsBottomRightMaxHeightVh { get; set; }

    public string CharacterartTvShowsBottomRightHorizontalAlign { get; set; } = "Center";

    public double CharacterartTvShowsBottomRightOffsetVw { get; set; } = 1.5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw's own doc comment for the full reasoning.
    public double CharacterartTvShowsBottomRightFullscreenOffsetVw { get; set; }

    // --- Movies ---

    /// <summary>"Standalone", "Prefixed", or "Folder" - all three variants like Poster.</summary>
    public string CharacterartMoviesNamingMode { get; set; } = "Prefixed";

    /// <summary>
    /// The name/prefix component for Standalone/Prefixed, e.g. for
    /// Standalone, exactly "&lt;TypeName&gt;.png" is looked for, for
    /// Prefixed "&lt;MovieName&gt;-&lt;TypeName&gt;.png". No forced
    /// convention, freely changeable (curriculum E).
    /// </summary>
    public string CharacterartMoviesTypeName { get; set; } = "characterart";

    /// <summary>Only relevant when CharacterartMoviesNamingMode == "Folder".</summary>
    public string CharacterartMoviesFolderName { get; set; } = "characterart";

    /// <summary>
    /// true = multi-image slideshow like Poster (numbered files),
    /// false = always exactly 1 static image with no number (curriculum E).
    /// </summary>
    public bool CharacterartMoviesMultiImage { get; set; } = true;

    /// <summary>Only relevant when CharacterartMoviesMultiImage == true.</summary>
    public int CharacterartMoviesCycleTimeMs { get; set; } = 5000;

    public int CharacterartMoviesFadeTimeMs { get; set; } = 1000;

    public bool CharacterartMoviesDelayEnabled { get; set; }

    public int CharacterartMoviesDelayMs { get; set; } = 5000;

    public bool CharacterartMoviesSinglePass { get; set; }
    public bool CharacterartMoviesRandomStart { get; set; }

    /// <summary>
    /// Only relevant when CharacterartMoviesMultiImage AND
    /// CharacterartMoviesSinglePass are both true. Controls what happens
    /// specifically when an item ends up with only 1 image actually
    /// found (despite MultiImage being configured on) - the previous,
    /// only behavior was to leave that 1 image showing forever/statically
    /// (the client's own recursive rotation timer never gets scheduled
    /// at all when there's nothing to rotate between, which incidentally
    /// also means the SinglePass "fade out after one pass" logic never
    /// gets a chance to run either, even though the admin explicitly
    /// asked for single-pass/play-once behavior). true preserves that
    /// exact original (stay static) behavior. false (default, per user
    /// request) makes even a single found image behave consistently
    /// with what single-pass otherwise means: fade out and disappear
    /// after one CycleTimeMs - added after a user request to make the
    /// single-image case consistent with the multi-image single-pass
    /// case by default, rather than a silent special case exempt from
    /// it.
    /// </summary>
    public bool CharacterartMoviesStaySingleImageStatic { get; set; }

    /// <summary>
    /// Only relevant when CharacterartMoviesMultiImage == true - "Sequential"
    /// (natural numeric order) or "Random" (shuffled once per resolve, no
    /// repeats until every image has been shown - see ExtraposterController's
    /// identical Random handling, replicated here). Was missing entirely
    /// until now - Characterart's rotation had no order setting at all
    /// while Extraposter/AnimatedPoster's analogous settings already did,
    /// found by the user directly comparing the two tabs.
    /// </summary>
    public string CharacterartMoviesOrderMode { get; set; } = "Shuffle";

    // --- TV (series/season/episode) ---

    /// <summary>
    /// "Standalone" or "Folder" - deliberately WITHOUT "Prefixed"
    /// (curriculum E: the series' main folder is always exclusive to
    /// exactly one series, regardless of whether it's reached from
    /// episode/season/series itself, prefix disambiguation isn't needed).
    /// </summary>
    public string CharacterartTvShowsNamingMode { get; set; } = "Standalone";

    /// <summary>The name/prefix component for TV content, like the Movies counterpart above.</summary>
    public string CharacterartTvShowsTypeName { get; set; } = "characterart";

    /// <summary>Only relevant when CharacterartTvShowsNamingMode == "Folder".</summary>
    public string CharacterartTvShowsFolderName { get; set; } = "characterart";

    /// <summary>true = multi-image slideshow, false = 1 static image.</summary>
    public bool CharacterartTvShowsMultiImage { get; set; } = true;

    /// <summary>Only relevant when CharacterartTvShowsMultiImage == true.</summary>
    public int CharacterartTvShowsCycleTimeMs { get; set; } = 5000;

    public int CharacterartTvShowsFadeTimeMs { get; set; } = 1000;

    public bool CharacterartTvShowsDelayEnabled { get; set; }

    public int CharacterartTvShowsDelayMs { get; set; } = 5000;

    public bool CharacterartTvShowsSinglePass { get; set; }
    public bool CharacterartTvShowsRandomStart { get; set; }

    /// <summary>
    /// Same as CharacterartMoviesStaySingleImageStatic, for TV shows -
    /// see its own doc comment for the full reasoning.
    /// </summary>
    public bool CharacterartTvShowsStaySingleImageStatic { get; set; }

    /// <summary>Same as CharacterartMoviesOrderMode, for TV shows.</summary>
    public string CharacterartTvShowsOrderMode { get; set; } = "Shuffle";

    // ───────────────────────── Animated Poster tab ─────────────────────────
    // Curriculum section F. Replaces the main poster entirely instead of
    // overlaying it (unlike Extraposter/Characterart). No multi-image
    // concept - always exactly one animated file, so no Folder mode and no
    // timing (cycle/fade/delay/single-pass) is needed either.

    /// <summary>
    /// Comma-separated from "gif", "apng", "webp" - the three researched
    /// animated formats renderable via background-image (curriculum F).
    /// Default: GIF only (the universal fallback with the widest
    /// compatibility - APNG/WEBP are opt-in, per user feedback).
    /// </summary>
    public string AnimatedPosterAllowedFormats { get; set; } = "gif";

    // --- Movies ---

    /// <summary>"Standalone" or "Prefixed" - deliberately WITHOUT "Folder" (no multi-image concept, curriculum F).</summary>
    public string AnimatedPosterMoviesNamingMode { get; set; } = "Prefixed";

    /// <summary>Naming-pattern component, no forced convention (curriculum F).</summary>
    public string AnimatedPosterMoviesTypeName { get; set; } = "animatedposter";

    /// <summary>
    /// Coarse gate over AnimatedPosterMoviesDetailEnabled/LibraryEnabled
    /// below - off disables Animated Poster for movies entirely. Added
    /// per explicit user request. Unlike Extraposter/Postercase/Keyart's
    /// own Show-on rows (one shared row with both Movies and TV shows
    /// checkboxes together, since those tabs already group both types
    /// under one shared Enable), Animated Poster's own Movies/TV shows
    /// sections aren't nested under any shared collapse - each gets its
    /// OWN single-checkbox "Show on" living directly above its own
    /// "Enable on detail page", not a combined row.
    /// </summary>
    public bool AnimatedPosterShowOnMovies { get; set; } = true;

    public bool AnimatedPosterMoviesDetailEnabled { get; set; } = true;

    public bool AnimatedPosterMoviesLibraryEnabled { get; set; } = true;

    // --- Sets (BoxSet/Collections) ---
    // Phase 2 (Session 90): Sets no longer has its own TypeName/Detail/
    // Library fields - reuses Movies' own above, same simplification
    // already applied to Extraposter/Extrakeyart/Postercase/Keyart in
    // Phase 1 (Session 87). Naming is still always "Standalone" for
    // Sets - unchanged, just no longer a separate config field to track.

    /// <summary>Same as <see cref="AnimatedPosterShowOnMovies"/>, but for Sets. When checked, Sets uses Movies' own TypeName/Detail/Library settings above, always with Standalone naming.</summary>
    public bool AnimatedPosterShowOnSets { get; set; } = true;

    // --- TV shows (always the series' main level) ---

    /// <summary>
    /// Naming-pattern component for TV content. No separate NamingMode
    /// field needed - for TV, only "Standalone" ever makes sense anyway
    /// (a series has an exclusive main folder, no Prefixed/Folder,
    /// curriculum F).
    /// </summary>
    public string AnimatedPosterTvShowsTypeName { get; set; } = "animatedposter";

    /// <summary>Same as <see cref="AnimatedPosterShowOnMovies"/>, but for TV shows.</summary>
    public bool AnimatedPosterShowOnTvShows { get; set; } = true;

    public bool AnimatedPosterTvShowsDetailEnabled { get; set; } = true;

    public bool AnimatedPosterTvShowsLibraryEnabled { get; set; } = true;

    // ───────────────────────── Animated Poster tab: Animated Keyart ─────────────────────────
    // Phase 2 (Session 90/91): new sibling feature to Animated Poster
    // above, same relationship as Keyart to Postercase - structurally an
    // exact 1:1 copy of the whole Animated Poster block above, just
    // renamed. Shares AnimatedPosterAllowedFormats/AnimatedPosterTabEnabled/
    // AnimatedPosterPriority with Animated Poster (one tab-level format
    // list and priority choice for both, same convention as
    // Postercase/Keyart sharing CustomPosterAllowedFormats/CustomPosterEnabled).

    // --- Movies ---
    public string AnimatedKeyartMoviesNamingMode { get; set; } = "Prefixed";

    public string AnimatedKeyartMoviesTypeName { get; set; } = "animatedkeyart";

    /// <summary>Same as <see cref="AnimatedPosterShowOnMovies"/>, but for Animated Keyart.</summary>
    public bool AnimatedKeyartShowOnMovies { get; set; } = true;

    public bool AnimatedKeyartMoviesDetailEnabled { get; set; } = true;

    public bool AnimatedKeyartMoviesLibraryEnabled { get; set; } = true;

    // --- Sets (BoxSet/Collections) --- reuses Movies' own fields above, same as Animated Poster's own Sets simplification.

    /// <summary>Same as <see cref="AnimatedKeyartShowOnMovies"/>, but for Sets. When checked, Sets uses Movies' own TypeName/Detail/Library settings above, always with Standalone naming.</summary>
    public bool AnimatedKeyartShowOnSets { get; set; } = true;

    // --- TV shows (always the series' main level) ---
    public string AnimatedKeyartTvShowsTypeName { get; set; } = "animatedkeyart";

    /// <summary>Same as <see cref="AnimatedKeyartShowOnMovies"/>, but for TV shows.</summary>
    public bool AnimatedKeyartShowOnTvShows { get; set; } = true;

    public bool AnimatedKeyartTvShowsDetailEnabled { get; set; } = true;

    public bool AnimatedKeyartTvShowsLibraryEnabled { get; set; } = true;

    // ----- Animated Keyart logo overlay, detail pages (Session 126: closes the gap that every other Keyart variant had a logo).
    /// <summary>Jellyfin's Logo image drawn over the animated keyart on detail pages.</summary>
    public bool AnimatedKeyartDetailLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int AnimatedKeyartDetailLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int AnimatedKeyartDetailLogoSizePercent { get; set; } = 60;

    // ----- Animated Keyart logo overlay, library views (Session 126: closes the gap that every other Keyart variant had a logo).
    /// <summary>Jellyfin's Logo image drawn over the animated keyart on library views.</summary>
    public bool AnimatedKeyartLibraryLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int AnimatedKeyartLibraryLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int AnimatedKeyartLibraryLogoSizePercent { get; set; } = 80;

    // ───────────────────────── Custom Poster tab: Postercase ─────────────────────────
    // A retouched poster with no lettering - a complete replacement for the
    // native poster (Ebene 0 in the arbiter, priority 1 - see Core.js's own
    // "Priority model" doc comment). Falls back to the true native poster
    // if no file exists. Single-image only, same reasoning as
    // AnimatedPoster's own "deliberately WITHOUT Folder" choice above (no
    // multi-image concept for either). Keyart will be added later as a
    // sibling field set (own Enabled/ShowOn/NamingMode fields, not shared
    // with Postercase's - concept-session decision: the two stay
    // independently toggleable even though they share one controller/
    // script and one config tab) - see this project's own curriculum for
    // the full concept writeup.

    /// <summary>Master switch for Postercase. Server-side kill switch, mirrors AnimatedPosterEnabled's own role.</summary>
    public bool PostercaseEnabled { get; set; } = true;

    /// <summary>
    /// Coarse gate over PostercaseMoviesDetailEnabled/LibraryEnabled below -
    /// off disables Postercase for movies entirely, same pattern as
    /// ExtraposterShowOnMovies. Added per explicit user request ("so wie
    /// bei extraposter").
    /// </summary>
    public bool PostercaseShowOnMovies { get; set; } = true;

    /// <summary>See ExtraposterShowOnSets's own doc comment - identisches Muster.</summary>
    public bool PostercaseShowOnSets { get; set; } = true;

    /// <summary>Same as <see cref="PostercaseShowOnMovies"/>, but for TV shows.</summary>
    public bool PostercaseShowOnTvShows { get; set; } = true;

    /// <summary>
    /// Comma-separated from Jellyfin's own supported still-image formats.
    /// CHANGED: no longer per-sub (was PostercaseAllowedFormats/
    /// KeyartAllowedFormats, two separate fields) - explicit user request
    /// to detach the format setting from either sub and make it
    /// tab-level, shared by both Postercase and Keyart, same reasoning
    /// as Extraposter's own AllowedFormats now covering Extrakeyart too.
    /// Default narrowed to just "jpg" per explicit user request (matches
    /// Extraposter's own AllowedFormats default exactly) - was "jpg,png"
    /// before.
    /// </summary>
    public string CustomPosterAllowedFormats { get; set; } = "jpg";

    // --- Movies ---

    /// <summary>"Standalone", "Prefixed", or "Folder" - Folder added per explicit user request even though Postercase is single-image: same reasoning as Characterart's own Folder mode for single images (whole subfolder, only the first match in natural sort order is used).</summary>
    public string PostercaseMoviesNamingMode { get; set; } = "Prefixed";

    /// <summary>Naming-pattern component, no forced convention (matches the file names the user already uses).</summary>
    public string PostercaseMoviesTypeName { get; set; } = "postercase";

    /// <summary>Subfolder name when PostercaseMoviesNamingMode is "Folder".</summary>
    public string PostercaseMoviesFolderName { get; set; } = "postercase";

    public bool PostercaseMoviesDetailEnabled { get; set; } = true;

    public bool PostercaseMoviesLibraryEnabled { get; set; } = true;

    // --- TV shows (always the series' main level - Movies and Season/Episode explicitly out of scope, concept-session decision) ---

    /// <summary>
    /// "Standalone" or "Folder" - no "Prefixed" (a series has one
    /// exclusive main folder, a name prefix adds nothing there, same
    /// reasoning as Extraposter's own TvShows naming). CHANGED: this used
    /// to be hardcoded to "Standalone" with no config field at all - a
    /// real gap found and fixed per explicit user request ("die folder
    /// variante vergessen") - TV now gets its own genuine choice, same as
    /// Movies.
    /// </summary>
    public string PostercaseTvShowsNamingMode { get; set; } = "Standalone";

    /// <summary>
    /// Naming-pattern component for TV content.
    /// </summary>
    public string PostercaseTvShowsTypeName { get; set; } = "postercase";

    /// <summary>Subfolder name when PostercaseTvShowsNamingMode is "Folder".</summary>
    public string PostercaseTvShowsFolderName { get; set; } = "postercase";

    public bool PostercaseTvShowsDetailEnabled { get; set; } = true;

    public bool PostercaseTvShowsLibraryEnabled { get; set; } = true;

    /// <summary>
    /// Which of Postercase/Keyart wins as the Ebene-0 image when BOTH
    /// exist for the same title - concept-session decision, user-
    /// configurable, lives in the Custom Poster tab itself (NOT General -
    /// corrected earlier this session after an initial wrong placement).
    /// "Postercase" or "Keyart".
    /// </summary>
    public string CustomPosterPriority { get; set; } = "Postercase";

    // ───────────────────────── Custom Poster tab: Keyart ─────────────────────────
    // A textless poster - same Ebene-0 role as Postercase, same single-
    // image/no-Folder-mode reasoning, purely file-based (NOT the TMDB API
    // - explicitly corrected during the concept session, the API was only
    // ever mentioned to explain the wider naming convention this concept
    // borrows from, never as something to actually integrate).

    /// <summary>Master switch for Keyart. Server-side kill switch, mirrors PostercaseEnabled's own role.</summary>
    public bool KeyartEnabled { get; set; } = true;

    /// <summary>Same as <see cref="PostercaseShowOnMovies"/>, but for Keyart.</summary>
    public bool KeyartShowOnMovies { get; set; } = true;

    /// <summary>See ExtraposterShowOnSets's own doc comment - identisches Muster.</summary>
    public bool KeyartShowOnSets { get; set; } = true;

    /// <summary>Same as <see cref="KeyartShowOnMovies"/>, but for TV shows.</summary>
    public bool KeyartShowOnTvShows { get; set; } = true;

    // REMOVED: KeyartAllowedFormats - merged into the shared,
    // tab-level CustomPosterAllowedFormats above (explicit user request).

    // --- Movies ---

    /// <summary>"Standalone", "Prefixed", or "Folder" - same reasoning as PostercaseMoviesNamingMode's own doc comment.</summary>
    public string KeyartMoviesNamingMode { get; set; } = "Prefixed";

    public string KeyartMoviesTypeName { get; set; } = "keyart";

    /// <summary>Subfolder name when KeyartMoviesNamingMode is "Folder".</summary>
    public string KeyartMoviesFolderName { get; set; } = "keyart";

    public bool KeyartMoviesDetailEnabled { get; set; } = true;

    public bool KeyartMoviesLibraryEnabled { get; set; } = true;

    // --- TV shows (always the series' main level) ---

    /// <summary>"Standalone" or "Folder" - same reasoning as PostercaseTvShowsNamingMode's own doc comment (same gap, fixed at the same time).</summary>
    public string KeyartTvShowsNamingMode { get; set; } = "Standalone";

    public string KeyartTvShowsTypeName { get; set; } = "keyart";

    /// <summary>Subfolder name when KeyartTvShowsNamingMode is "Folder".</summary>
    public string KeyartTvShowsFolderName { get; set; } = "keyart";

    public bool KeyartTvShowsDetailEnabled { get; set; } = true;

    public bool KeyartTvShowsLibraryEnabled { get; set; } = true;

    // ----- Keyart logo overlay, detail pages (Session 123: separate per view).
    /// <summary>Jellyfin's Logo image drawn over the keyart on detail pages.</summary>
    public bool KeyartDetailLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int KeyartDetailLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int KeyartDetailLogoSizePercent { get; set; } = 60;

    // ----- Keyart logo overlay, library views (Session 123: separate per view).
    /// <summary>Jellyfin's Logo image drawn over the keyart on library views.</summary>
    public bool KeyartLibraryLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int KeyartLibraryLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int KeyartLibraryLogoSizePercent { get; set; } = 60;

    // --- Optional logo overlay ---
    // Independent of KeyartEnabled itself (user's own explicit
    // distinction: the overlay is a separate on/off, not implied by
    // Keyart being active) - draws Jellyfin's own native Logo image
    // (ImageType.Logo, the same one already shown in the library's own
    // "Logo" display setting for many titles via TheTVDB/fanart.tv
    // metadata) centered over the Keyart image, positioned via CSS
    // percentages of the poster box's OWN dimensions (not the viewport)
    // so it stays pinned to the poster across any resize/fullscreen -
    // the "klebend" (stuck) requirement from the concept session,
    // contrasted explicitly against Characterart's own free positioning.
    // No server-side image resolution needed for the logo itself - it is
    // fetched directly via Jellyfin's own existing image API
    // (apiClient.getScaledImageUrl with type:'Logo'), not a new file
    // convention of this plugin's own.

    // ───────────────────────── Red Carpet tab ─────────────────────────
    // Curriculum section H. A fundamentally different storage structure
    // than all other feature blocks - ONE global, shared folder instead of
    // per-item, name matching exactly via Person.Name (no naming-pattern
    // free-text field needed, unlike everywhere else). Deliberately
    // minimal settings (curriculum H: "the tab doesn't need many
    // settings").

    /// <summary>
    /// Name of the subfolder inside IServerApplicationPaths.
    /// InternalMetadataPath (curriculum H) - chosen with a space, identical
    /// to the tab name. Still modeled as a setting (not hardcoded),
    /// consistent with all other FolderName fields.
    /// </summary>
    public string RedCarpetFolderName { get; set; } = "Red Carpet";

    /// <summary>On the person's own info/detail page.</summary>
    public bool RedCarpetShowOnInfoPage { get; set; } = true;

    /// <summary>On the person's filmography list page (Movie).</summary>
    public bool RedCarpetShowOnMovies { get; set; } = true;

    /// <summary>On the person's filmography list page (Series/TV Show).</summary>
    public bool RedCarpetShowOnTvShows { get; set; } = true;

    /// <summary>On the person's filmography list page (Episode). No separate "Season" type (curriculum H, verified).</summary>
    public bool RedCarpetShowOnEpisodes { get; set; } = true;

    /// <summary>"BottomLeft" or "BottomRight" - like Characterart Position 3/4, scrolls normally, not fixed to the window.</summary>
    public string RedCarpetPosition { get; set; } = "BottomRight";

    /// <summary>
    /// Same redesigned system as Characterart's own per-position sizing
    /// (see the detailed comment there) - ScaleMode/Height or Width/an
    /// optional Max*/HorizontalAlign, plus OffsetVw, one full set for
    /// BottomLeft, one for BottomRight. Only the currently selected
    /// position's set is used at runtime.
    /// </summary>
    public string RedCarpetBottomLeftScaleMode { get; set; } = "Height";

    public double RedCarpetBottomLeftHeightVh { get; set; } = 45;

    public double RedCarpetBottomLeftMaxWidthVw { get; set; } = 45;

    public double RedCarpetBottomLeftWidthVw { get; set; } = 10.5;

    public double RedCarpetBottomLeftMaxHeightVh { get; set; }

    public string RedCarpetBottomLeftHorizontalAlign { get; set; } = "Left";

    public double RedCarpetBottomLeftOffsetVw { get; set; } = 5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw's own doc comment for the full reasoning.
    public double RedCarpetBottomLeftFullscreenOffsetVw { get; set; }

    public string RedCarpetBottomRightScaleMode { get; set; } = "Height";

    public double RedCarpetBottomRightHeightVh { get; set; } = 45;

    public double RedCarpetBottomRightMaxWidthVw { get; set; } = 45;

    public double RedCarpetBottomRightWidthVw { get; set; } = 10.5;

    public double RedCarpetBottomRightMaxHeightVh { get; set; }

    public string RedCarpetBottomRightHorizontalAlign { get; set; } = "Right";

    public double RedCarpetBottomRightOffsetVw { get; set; } = -5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw's own doc comment for the full reasoning.
    public double RedCarpetBottomRightFullscreenOffsetVw { get; set; }

    // ─────────────────────── People Backdrops ─────────────────────────
    // The sixth, fully independent feature - originally nested visually
    // under the RedCarpet tab in the admin UI, MOVED to the Backdrops tab
    // (own concept-session decision: both features already share the
    // same merged BackdropsPlus.js file, and grouping "person backdrops"
    // under "backdrops" in the UI reads more naturally than under
    // "person-page modifications"/RedCarpet) - has its own storage, own
    // display logic, and its own settings entirely separate from
    // BackdropsPlus's own. Shares BackdropsTabEnabled (the Backdrops
    // tab's own master switch, not BackdropsPlus's own now-independent
    // sub-feature switch) as a common master with BackdropsPlus (off =
    // both dead) - RE-COUPLED TWICE now: first from RedCarpetEnabled when
    // the UI moved, then from BackdropsEnabled once that field became
    // BackdropsPlus's own genuinely independent switch - deliberately has
    // NO separate master-enable field of its own; the four ShowOn fields
    // below serve as the real per-feature enable mechanism (all four
    // false = fully inert for this feature specifically, even with
    // BackdropsTabEnabled true).
    // Images themselves are never stored locally - only their
    // Wallpapers.com URLs, in a small backdrops.json file placed
    // directly in each person's own real Jellyfin metadata folder
    // (InternalMetadataPath/People/<Letter>/<Name>/backdrops.json) -
    // see PeopleBackdropsController's own doc comment for the full
    // population-flow reasoning.

    /// <summary>
    /// Optional. Without a key: ~30 requests/min (per-IP, soft cap) to
    /// the Wallpapers.com API. With a free key: 60 requests/min. Only
    /// affects the population flow (the JSON-API calls) - never affects
    /// actual image loading, since displayed images are hotlinked
    /// directly from Wallpapers.com by the browser, not proxied through
    /// this plugin or counted against this rate limit at all.
    /// </summary>
    public string PeopleBackdropsApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Target number of accepted (aspect-ratio + optionally text)
    /// candidate images to cache per person, 1-10. Deliberately defaults
    /// to a low value (not the population flow's actual maximum) so a
    /// fresh install both reaches the target quickly AND still
    /// genuinely exercises the multi-image rotation path during first
    /// real-world testing, per explicit user request.
    /// </summary>
    public int PeopleBackdropsMaxImages { get; set; } = 10;

    /// <summary>
    /// Strict/aggressive by design - any detected text region, however
    /// faint, causes a candidate image to be rejected. See
    /// PeopleBackdropsTextDetector's own doc comment for the detection
    /// approach used (a classical, dependency-free image-processing
    /// heuristic - not a neural network - deliberately tuned as a
    /// coarse "shield" per explicit user request, not a precise
    /// scene-text detector).
    /// </summary>
    public bool PeopleBackdropsTextFilterEnabled { get; set; } = true;

    /// <summary>
    /// Phase D1 (Session 100): own feature-level switch, matching every
    /// other Backdrops category - People Backdrops used to be the only
    /// exception without one, relying purely on the four ShowOn
    /// switches below to also carry that role.
    /// </summary>
    public bool PeopleBackdropsEnabled { get; set; } = true;

    /// <summary>On the person's own detail/info page.</summary>
    public bool PeopleBackdropsShowOnInfoPage { get; set; } = true;

    /// <summary>On the person's filmography list page (Movie).</summary>
    public bool PeopleBackdropsShowOnMovies { get; set; } = true;

    /// <summary>On the person's filmography list page (Series/TV Show).</summary>
    public bool PeopleBackdropsShowOnTvShows { get; set; } = true;

    /// <summary>On the person's filmography list page (Episode).</summary>
    public bool PeopleBackdropsShowOnEpisodes { get; set; } = true;

    // The five fields below are 1:1 copies of the existing Backdrops
    // tab's own rotation settings (same field types, same current
    // defaults) - deliberate, explicit user request, not independently
    // chosen. See BackdropsCycleTimeMs/BackdropsOrderMode/etc.'s own doc
    // comments for the full reasoning behind each; not repeated here.
    public int PeopleBackdropsCycleTimeMs { get; set; } = 10000;

    public string PeopleBackdropsOrderMode { get; set; } = "Shuffle";
    public bool PeopleBackdropsRandomStart { get; set; }

    public bool PeopleBackdropsKenBurnsEnabled { get; set; } = true;

    public int PeopleBackdropsKenBurnsZoomMs { get; set; } = 20000;

    public int PeopleBackdropsKenBurnsPanMs { get; set; } = 10000;

    /// <summary>
    /// New alternative mode for People Backdrops on a person's own
    /// filmography pages (explicit user decision - "bauen wir bei
    /// unseren schon bestehenden people backdrops ein"): WallpapersCom
    /// is the existing, unchanged behavior. Appearances shows the
    /// person's own movies/shows instead, reusing this feature's exact
    /// same NDJSON streaming protocol so the client-side JS needs no
    /// changes at all - only the URL SOURCE differs, never the shape.
    /// Mutually exclusive, never a mixed pool (same "entweder, oder"
    /// decision as Favorites People).
    /// </summary>
    public string PeopleBackdropsSourceMode { get; set; } = "WallpapersCom";

    /// <summary>
    /// Only relevant when PeopleBackdropsSourceMode is "Appearances".
    /// </summary>
    public string PeopleBackdropsAppearancesFilter { get; set; } = "MoviesAndSeries";

    /// <summary>
    /// Fix #7 (Session 105, ported aus der Sandbox, Session 74): dasselbe
    /// Label "Order" wie PeopleBackdropsOrderMode (Wallpapers.com), aber
    /// ein komplett separates Feld - echte Jellyfin-Sortierfelder in
    /// nativer ItemSortBy-Enum-Reihenfolge statt alphabetisch (anders als
    /// bei Genre/Tag/Favorites). Nie gleichzeitig mit OrderMode sichtbar -
    /// beide sind exklusiv je eine eigene Source (Wallpapers.com/
    /// Appearances). Only relevant when PeopleBackdropsSourceMode is
    /// "Appearances".
    /// </summary>
    public string PeopleBackdropsAppearancesSortMode { get; set; } = "Shuffle";

    /// <summary>Session 116: Traversal for the Appearances Order, same semantics as BackdropsGenreTraversalMode.</summary>
    public string PeopleBackdropsAppearancesTraversalMode { get; set; } = "BeginAscending";
    public bool PeopleBackdropsAppearancesRandomStart { get; set; }

    /// <summary>
    /// Fix #8 (Session 105, ported aus der Sandbox, Session 76): "Main"
    /// (die nummernlose Datei) oder "All" (zufällig aus allen erlaubten
    /// Backdrops der Person), analog zu Genre/Tag/Favorites' eigenem
    /// "Backdrops per item"-Konzept. Only relevant when
    /// PeopleBackdropsSourceMode is "Appearances".
    /// </summary>
    public string PeopleBackdropsAppearancesMainOnly { get; set; } = "Main";

    /// <summary>
    /// Phase D2 (Session 101, explicit user request): "Single" looks
    /// for exactly one "backdrop.&lt;ext&gt;" in the person's own
    /// folder. "Multiple" looks for the numbered
    /// "backdrop1.&lt;ext&gt;".."backdrop20.&lt;ext&gt;" instead - the
    /// two file sets are deliberately non-overlapping (see
    /// ResolveFolderBackdropPaths's own doc comment in
    /// PeopleBackdropsController.cs). Only relevant when
    /// PeopleBackdropsSourceMode is "Folder".
    /// </summary>
    /// <summary>Session 118: the base name of the person-folder files (was hardcoded "backdrop").</summary>
    public string PeopleBackdropsFolderBaseName { get; set; } = "backdrop";

    public string PeopleBackdropsFolderBackdropFiles { get; set; } = "Single";

    /// <summary>
    /// Same value space as PeopleBackdropsOrderMode above, kept as its
    /// own separate field rather than reused - Folder's own file order
    /// (numbered on disk) is a genuinely different rotation concept
    /// from Wallpapers.com's own cache order, and the two sources are
    /// mutually exclusive per person anyway. Only relevant when
    /// PeopleBackdropsSourceMode is "Folder".
    /// </summary>
    public string PeopleBackdropsFolderOrderMode { get; set; } = "Sequential";
    public bool PeopleBackdropsFolderRandomStart { get; set; }

    // ───────────────────────── Backdrops tab ─────────────────────────
    // Curriculum section G. A fundamentally different kind of feature than
    // all other five - no file matching, but an override of Jellyfin's
    // native rotation behavior. Session 130: no browser or vanilla-setting
    // gate any more - the admin page hints while a vanilla setting is still
    // on (its backdrops load unseen), nothing is forced or written.

    /// <summary>
    /// Our own cycle time in ms instead of the natively hardcoded 24000.
    /// Explicitly WITHOUT an artificial upper/lower bound (curriculum G).
    /// </summary>
    public int BackdropsCycleTimeMs { get; set; } = 10000;

    /// <summary>
    /// "Sequential" (native order), "Shuffle" (every image shown exactly
    /// once before any repeat, freshly re-shuffled each round), or
    /// "Random" (a plain, independent random pick each time - repeats
    /// and long gaps for a given image are both possible, same as any
    /// simple random number generator).
    /// </summary>
    public string BackdropsOrderMode { get; set; } = "Shuffle";
    public bool BackdropsRandomStart { get; set; }

    /// <summary>
    /// true = Ken Burns effect (zoom/pan) instead of the native plain fade.
    /// Zoom range (110%->130%), pan distance (15px diagonal) and the
    /// easing curve stay fixed/not user-configurable (curriculum G) -
    /// only the two duration values below are, per user request.
    /// </summary>
    public bool BackdropsKenBurnsEnabled { get; set; } = true;

    /// <summary>
    /// Only relevant when BackdropsKenBurnsEnabled is true. Duration (ms)
    /// of ONE direction of the zoom's back-and-forth cycle (the
    /// client's own animation runs it with direction:'alternate', so a
    /// full there-and-back cycle takes twice this). 10000 (10s) matches
    /// the original, not-yet-configurable default this plugin shipped
    /// with before the user asked to make timing adjustable.
    /// </summary>
    public int BackdropsKenBurnsZoomMs { get; set; } = 20000;

    /// <summary>
    /// Only relevant when BackdropsKenBurnsEnabled is true. Same as
    /// BackdropsKenBurnsZoomMs, for the pan's own back-and-forth cycle -
    /// independent of the zoom duration (the client deliberately keeps
    /// running two full pan cycles for every one zoom cycle when both
    /// are left at their defaults, 5000ms being exactly half of 10000ms,
    /// but this is no longer enforced/computed from the zoom value once
    /// the admin changes either one - each is its own independent
    /// setting from here on).
    /// </summary>
    public int BackdropsKenBurnsPanMs { get; set; } = 10000;

    // ───────────── Backdrops tab: Library View Backdrops (Session 130) ─────────────
    // Replica of Jellyfin's own random library backdrops (scripts/
    // autoBackdrops.js: 20 items with a backdrop, SortBy
    // IsFavoriteOrLiked,Random, per library or - on Home - across all
    // libraries with a PG-13 cap), rendered by this plugin through the same
    // transition bus as the other six categories. Vanilla's "Backdrops"
    // display setting is neither read nor written (the admin page only shows
    // a hint while it is still on); its container is hidden while ours
    // shows, like Detail View does on detail pages.

    /// <summary>Category switch. Off = Jellyfin behaves as the user configured it.</summary>
    public bool BackdropsLibraryEnabled { get; set; } = true;

    /// <summary>Show on (vanilla): the pages vanilla's own setting covers. Home includes its Favourites tab.</summary>
    public bool BackdropsLibraryShowOnHome { get; set; } = true;
    public bool BackdropsLibraryShowOnMovies { get; set; } = true;
    public bool BackdropsLibraryShowOnTvShows { get; set; } = true;
    public bool BackdropsLibraryShowOnMusic { get; set; } = true;

    /// <summary>Show on (custom): pages vanilla never paints. Collections = a boxsets library (set backdrops), Search and User settings = the Home set.</summary>
    public bool BackdropsLibraryShowOnCollections { get; set; } = true;
    public bool BackdropsLibraryShowOnSearch { get; set; } = true;
    public bool BackdropsLibraryShowOnUserSettings { get; set; } = true;

    /// <summary>"PG-13" (vanilla's cap on the Home set, autoBackdrops.js MaxOfficialRating) or "Off".</summary>
    public string BackdropsLibraryHomeRatingCap { get; set; } = "PG-13";

    public int BackdropsLibraryCycleTimeMs { get; set; } = 10000;

    /// <summary>"Sequential" (the pool as vanilla orders it), "Shuffle", "Random" - see BackdropsOrderMode.</summary>
    public string BackdropsLibraryOrderMode { get; set; } = "Shuffle";
    public bool BackdropsLibraryRandomStart { get; set; }

    public bool BackdropsLibraryKenBurnsEnabled { get; set; } = true;
    public int BackdropsLibraryKenBurnsZoomMs { get; set; } = 20000;
    public int BackdropsLibraryKenBurnsPanMs { get; set; } = 10000;

    // ───────────────────────── Case tab (Case Mod) ─────────────────────────
    // Curriculum: "boxes.zip" concept session. Physical disc-case artwork
    // (Classic/Clear/Steel Case) glued on top of the poster on detail
    // pages only (Movies, BoxSets/Collections, Series-main - explicitly
    // NOT Season/Episode). Front side only for this first version (no
    // back_*.png usage yet - that would need a flip interaction, out of
    // scope here). Applies unconditionally over whatever is currently in
    // the poster slot for now (explicit user decision - no Extraposter/
    // Keyart winner-awareness yet, this feature is still being built).
    // Master switch is CaseModEnabled (General tab) - the former,
    // redundant CaseModCaseEnabled sub-switch was removed in Session 37.
    public bool CaseModShowOnMovies { get; set; } = true;

    public bool CaseModShowOnSets { get; set; } = true;

    public bool CaseModShowOnTvShows { get; set; } = true;

    /// <summary>
    /// One of "vivaelitecases", "clearcases", "vortexcases" - matches the
    /// CaseTextures/ subfolder names exactly (see ArtworkPlus.csproj's
    /// own Content-Include entry). A single global choice, not
    /// per-library/per-item (explicit user decision) - simpler for this
    /// first version, and the per-case-type adjustment values below only
    /// make sense against one active choice at a time anyway.
    /// </summary>
    public string CaseModType { get; set; } = "vivaelitecases";

    // --- Per-case-type box geometry: NOT a config setting anymore.
    // The direct Top/Left/Width/Height values (explicit user
    // correction that replaced the old relative 5-value system - see
    // the curriculum for the counter-example proof of why relative
    // multipliers could never work) were tuned by the user with the
    // temporary admin adjustment tool and are now HARDCODED as
    // constants in CaseModController.cs (explicit user request: "tue
    // dann die position der 3 cases hart in den code"). Deliberately
    // constants rather than config defaults: a config property's
    // default is silently overridden by any previously-saved value in
    // the plugin's own stored XML - with the admin tool removed, a
    // stale saved value would be invisible and unfixable from the UI.
    // Stale <CaseModColorTopPercent>-style elements in an existing
    // saved XML are simply ignored by the deserializer. The adjustment
    // tool itself (see the curriculum's own REFERENCE TECHNIQUE entry)
    // returns later for Discart size/position tuning.
}
