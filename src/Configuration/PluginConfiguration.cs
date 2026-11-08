using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.ArtworkPlus.Configuration;

/// <summary>
/// Server-side persisted plugin settings, read and written by the admin config
/// page (Configuration/configPage.html).
///
/// Choices are plain string properties rather than C# enums: Jellyfin exchanges
/// plugin config as JSON over the REST API, where an enum would serialize as a
/// number instead of a readable value.
///
/// Each tab of the config page has its own region below, in the page's tab order.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    // ───────────────────────── General tab ─────────────────────────
    // One master switch per feature block. Not just a visual effect
    // (tab graying) - a real, server-side kill switch. The respective
    // controller checks this field itself before doing anything (see
    // ExtraposterController.GetPosterList).

    /// <summary>
    /// Master switch for the whole Extraposter tab (Extraposter + Extrakeyart).
    /// Each sub-feature additionally has its own switch, e.g. ExtraposterEnabled.
    /// </summary>
    public bool ExtraposterTabEnabled { get; set; } = true;

    /// <summary>Switch for the Extraposter sub-feature inside the Extraposter tab.</summary>
    public bool ExtraposterEnabled { get; set; } = true;

    /// <summary>Master switch for the whole Animated Poster tab (Animated Poster + Animated Keyart). Server-side kill switch, see AnimatedPosterController.</summary>
    public bool AnimatedPosterTabEnabled { get; set; } = true;

    /// <summary>Feature-level switch for Animated Poster specifically (as opposed to AnimatedPosterTabEnabled above, which gates the whole tab including Animated Keyart).</summary>
    public bool AnimatedPosterEnabled { get; set; } = true;

    /// <summary>Feature-level switch for Animated Keyart, the sibling of Animated Poster (same relationship as Keyart to Postercase).</summary>
    public bool AnimatedKeyartEnabled { get; set; } = true;

    /// <summary>"AnimatedPoster" or "AnimatedKeyart" - which one wins if both are enabled and applicable for the same item. See CustomPosterPriority for the identical pattern.</summary>
    public string AnimatedPosterPriority { get; set; } = "AnimatedPoster";

    // ───────────────────────── Case Mod tab ─────────────────────────
    // A case texture wrapped around the poster box, with an optional
    // "open case + spinning disc" animation. Not an artwork contender (it
    // does not compete in the poster arbiter): it applies to every detail
    // view regardless of which artwork type wins the poster slot.
    //
    // Gating in the admin page: Show on (Movies/Sets/TvShows) gates every
    // other field; the open angle and the disc fields additionally need at
    // least one open trigger, the spin direction also needs a spin option.
    // Greying is purely visual - a field's stored value is never reset just
    // because it became unreachable.

    /// <summary>Master switch for the Case Mod tab and the only gate of the whole feature, client-side (the tab's EP_TREE root) and server-side (CaseModController.GetInfo).</summary>
    public bool CaseModEnabled { get; set; } = true;

    // ════════════════════════════════════════════════════════════════════
    // FLAT (2D) CASE: OPEN / SPIN SETTINGS.
    //
    // The flat case carries the same settings as the Three.js case and
    // behaves the same way. Each field below has a CaseModThreejs* twin
    // with the same name after the prefix:
    //
    //     CaseMod2DOpenAutomatic       CaseModThreejsOpenAutomatic
    //     CaseMod2DOpenOnClick         CaseModThreejsOpenOnClick
    //     CaseMod2DOpenDelayMs         CaseModThreejsOpenDelayMs
    //     CaseMod2DOpenAngleDegrees    CaseModThreejsOpenAngleDegrees
    //     CaseMod2DSpinAutomatic       CaseModThreejsSpinAutomatic
    //     CaseMod2DSpinOnClick         CaseModThreejsSpinOnClick
    //     CaseMod2DSpinDirection       CaseModThreejsSpinDirection
    // ════════════════════════════════════════════════════════════════════

    /// <summary>
    /// First of the two triggers: the case opens by itself, once, after
    /// CaseMod2DOpenDelayMs.
    /// </summary>
    public bool CaseMod2DOpenAutomatic { get; set; } = true;

    /// <summary>
    /// Manual mode: a click opens the case and it stays open; the next
    /// click closes it. Nothing else closes it - neither a timer nor the
    /// disc settings.
    ///
    /// Mutually exclusive with CaseMod2DOpenOnClickAutomatic: both decide
    /// what a click on the case does, so the admin page unticks the other one.
    /// </summary>
    public bool CaseMod2DOpenOnClick { get; set; } = true;

    /// <summary>
    /// Click-started sequence: a click on the case plays the whole
    /// open/spin/close timeline, which closes itself - the same timeline
    /// CaseMod2DOpenAutomatic starts on a timer. Its own mode, so the disc
    /// settings never change what a click on the case does.
    /// Mutually exclusive with CaseMod2DOpenOnClick.
    /// </summary>
    public bool CaseMod2DOpenOnClickAutomatic { get; set; } = false;

    /// <summary>Delay before the automatic opening, in ms.</summary>
    public double CaseMod2DOpenDelayMs { get; set; } = 5000;

    /// <summary>
    /// How far the front cover swings open (degrees). Clamped defensively to
    /// [1, 180] in CaseModController.GetInfo(). Changing it needs a full
    /// browser reload, same as every other CaseMod value - the client bakes
    /// it into its injected CSS once per page load.
    /// </summary>
    public double CaseMod2DOpenAngleDegrees { get; set; } = 90;

    /// <summary>
    /// The disc turns inside the timer-started sequence (CaseMod2DOpenAutomatic).
    /// It does not decide whether a click runs a sequence - that is
    /// CaseMod2DOpenOnClickAutomatic's job.
    /// </summary>
    public bool CaseMod2DSpinAutomatic { get; set; } = true;

    /// <summary>
    /// The disc turns inside the click-started sequence
    /// (CaseMod2DOpenOnClickAutomatic). Each disc option belongs to the case
    /// option of the same name, which is why the admin page greys this one
    /// while its namesake is off.
    /// </summary>
    public bool CaseMod2DSpinOnClickAutomatic { get; set; } = false;

    /// <summary>
    /// A click on the disc itself turns it once - whenever the lid is out of
    /// the way and nothing else is turning the disc, including the hold phase
    /// of a sequence that does not spin it. With no second writer for the
    /// same rotation there is nothing to guard, so unlike the other two this
    /// one does not depend on CaseMod2DOpenOnClick.
    /// Default off, same as the 3D twin.
    /// </summary>
    public bool CaseMod2DSpinOnClick { get; set; } = false;

    /// <summary>
    /// "Left" or "Right". A plain string, not a bool, to keep the door open
    /// for more directions without a breaking rename - same reasoning as
    /// CaseModType.
    /// </summary>
    public string CaseMod2DSpinDirection { get; set; } = "Left";

    /// <summary>
    /// Fixed perspective tilt angle for "Viva Elite 3D Case", modelled on the
    /// Aeon MQ Kodi skin. Stored negative, range -10 to 0 degrees: the texture
    /// has the spine drawn on one fixed side, so a positive angle (mirrored
    /// hinge) would not match it. The admin UI shows the value positive.
    /// Default -5, matched against the Kodi skin's look.
    /// </summary>
    public double CaseModCaseAngle { get; set; } = -5;

    /// <summary>
    /// Shows the developer tuning block (case/disc/inner-case geometry fields
    /// + the preview checkboxes) in the admin page. Off = the block is hidden
    /// completely (display:none, not just greyed). Default false.
    /// </summary>
    public bool CaseModDeveloperSettingsEnabled { get; set; } = false;

    // Developer tuning: direct, absolute geometry fields (vw) for fitting the
    // "3D Case" type by eye against the real poster. Hidden behind
    // CaseModDeveloperSettingsEnabled.
    public double CaseMod3DTuneTop { get; set; } = -4.3;
    public double CaseMod3DTuneLeft { get; set; } = 2.8;
    public double CaseMod3DTuneWidth { get; set; } = 27.4;

    /// <summary>
    /// Case width (vw) for Sets (BoxSet) with the Viva Elite 3D Case: their own
    /// set.png artwork has slightly different proportions from the movie case.
    /// Only for this case type and only for Sets. Developer settings,
    /// "Case width Sets (vw)".
    /// </summary>
    public double CaseMod3DTuneWidthSets { get; set; } = 28.5;
    public double CaseMod3DTuneHeight { get; set; } = 42.6;

    // Developer tuning - inner-case position (the view when the case opens;
    // the graphic is reused as is from vivaelitecases). Defaults match the
    // case front, since the inner case sits at the same place.
    public double CaseMod3DTuneInnerTop { get; set; } = -4.2;
    public double CaseMod3DTuneInnerLeft { get; set; } = -1.1;
    public double CaseMod3DTuneInnerWidth { get; set; } = 31.5;
    public double CaseMod3DTuneInnerHeight { get; set; } = 43.8;

    // Developer tuning - disc position. Only 3 fields (no height) - a disc is
    // 1:1, Size is used as width AND height so it never distorts into an
    // oval.
    public double CaseMod3DTuneDiscTop { get; set; } = 5.55;
    public double CaseMod3DTuneDiscLeft { get; set; } = 4.25;
    public double CaseMod3DTuneDiscSize { get; set; } = 22.7;

    // The hub, the peg that holds the disc in the tray. It is its own decal,
    // not part of the inside texture, because the peg goes THROUGH the disc's
    // hole and therefore has to be drawn ON TOP of the disc. Three fields like
    // the disc's, Size is width AND height so it can never become an oval.
    // The defaults put it on the disc's centre, with the size taken from the
    // decal's share of the texture: 180 of 552 px.
    public double CaseMod3DTuneHubTop { get; set; } = 11.75;
    public double CaseMod3DTuneHubLeft { get; set; } = 10.5;
    public double CaseMod3DTuneHubSize { get; set; } = 10.27;

    // The same tuning fields for the other three case types, each shown
    // behind its own dropdown value. Defaults = the values the controller
    // uses, so nothing shifts until someone readjusts them.
    public double ClearCaseTuneTop { get; set; } = -3.35;
    public double ClearCaseTuneLeft { get; set; } = -1.3;
    public double ClearCaseTuneWidth { get; set; } = 31.5;
    public double ClearCaseTuneHeight { get; set; } = 43.2;
    // The disc centre is taken from the ring in the inside texture, not
    // from the hub, which sits a few pixels off that ring because the
    // artwork is an oblique render.
    public double ClearCaseTuneDiscTop { get; set; } = 6.25;
    public double ClearCaseTuneDiscLeft { get; set; } = 4.32;
    public double ClearCaseTuneDiscSize { get; set; } = 22.45;

    // The inside (the tray that shows when the case opens). Every case
    // type has its own box: the textures are pre-distorted so their ring
    // is round at exactly this stretch, so one shared box cannot serve
    // four different insides.
    public double ClearCaseTuneInnerTop { get; set; } = -4.2;
    public double ClearCaseTuneInnerLeft { get; set; } = -1.1;
    public double ClearCaseTuneInnerWidth { get; set; } = 31.5;
    public double ClearCaseTuneInnerHeight { get; set; } = 43.8;

    // The hub, see CaseMod3DTuneHubTop.
    public double ClearCaseTuneHubTop { get; set; } = 7.35;
    public double ClearCaseTuneHubLeft { get; set; } = 5.5;
    public double ClearCaseTuneHubSize { get; set; } = 20.09;

    public double VortexCaseTuneTop { get; set; } = -3.8;
    public double VortexCaseTuneLeft { get; set; } = -1.15;
    public double VortexCaseTuneWidth { get; set; } = 31.45;
    public double VortexCaseTuneHeight { get; set; } = 43.4;
    // The disc centre is taken from the ring in the inside texture, not
    // from the hub, which sits a few pixels off that ring because the
    // artwork is an oblique render.
    public double VortexCaseTuneDiscTop { get; set; } = 5.895;
    public double VortexCaseTuneDiscLeft { get; set; } = 4.05;
    public double VortexCaseTuneDiscSize { get; set; } = 23.05;

    // The inside (the tray that shows when the case opens), see
    // ClearCaseTuneInnerTop.
    public double VortexCaseTuneInnerTop { get; set; } = -4.2;
    public double VortexCaseTuneInnerLeft { get; set; } = -1.1;
    public double VortexCaseTuneInnerWidth { get; set; } = 31.5;
    public double VortexCaseTuneInnerHeight { get; set; } = 43.8;

    // The hub, see CaseMod3DTuneHubTop.
    public double VortexCaseTuneHubTop { get; set; } = 12.29;
    public double VortexCaseTuneHubLeft { get; set; } = 10.5;
    public double VortexCaseTuneHubSize { get; set; } = 10.26;

    public double VivaEliteCaseTuneTop { get; set; } = -3.8;
    public double VivaEliteCaseTuneLeft { get; set; } = -1.7;
    public double VivaEliteCaseTuneWidth { get; set; } = 32;
    public double VivaEliteCaseTuneHeight { get; set; } = 43.7;
    // The disc centre is taken from the ring in the inside texture, not
    // from the hub, which sits a few pixels off that ring because the
    // artwork is an oblique render.
    public double VivaEliteCaseTuneDiscTop { get; set; } = 5.775;
    public double VivaEliteCaseTuneDiscLeft { get; set; } = 3.75;
    public double VivaEliteCaseTuneDiscSize { get; set; } = 23;

    // The inside (the tray that shows when the case opens), see
    // ClearCaseTuneInnerTop.
    public double VivaEliteCaseTuneInnerTop { get; set; } = -4.2;
    public double VivaEliteCaseTuneInnerLeft { get; set; } = -1.1;
    public double VivaEliteCaseTuneInnerWidth { get; set; } = 31.5;
    public double VivaEliteCaseTuneInnerHeight { get; set; } = 43.8;

    // The hub, see CaseMod3DTuneHubTop.
    public double VivaEliteCaseTuneHubTop { get; set; } = 12.05;
    public double VivaEliteCaseTuneHubLeft { get; set; } = 10.15;
    public double VivaEliteCaseTuneHubSize { get; set; } = 10.3;

    // Developer tuning - preview switches for alignment, no function in
    // normal operation. They hide a layer while reading the same geometry
    // as the real flow (no separate preview copy of the values).
    public bool CaseMod3DTuneHidePoster { get; set; } = false;

    /// <summary>Hides the front cover and its rotator while tuning.</summary>
    public bool CaseMod3DTuneHideFrontCase { get; set; } = false;

    /// <summary>Hides the disc while tuning.</summary>
    public bool CaseMod3DTuneHideDisc { get; set; } = false;

    /// <summary>
    /// Hides the hub decal while tuning. The hub is part of the artwork and is
    /// always drawn, so the useful switch is one that takes it away for a moment.
    /// </summary>
    public bool CaseMod3DTuneHideHub { get; set; } = false;

    /// <summary>
    /// Colour mode of a flat case type, the counterpart to the
    /// CaseModThreejsColorMode* fields. "Original" draws the texture exactly as
    /// it is (default); "FullShell" composes the case out of its four layers and
    /// multiplies the plastic by a colour derived from the cover. One field per
    /// case type, because a clear case and a printed one do not want the same answer.
    /// </summary>
    public string ClearCaseColorMode { get; set; } = "Original";

    /// <summary>See <see cref="ClearCaseColorMode"/>.</summary>
    public string VivaEliteCaseColorMode { get; set; } = "Original";

    /// <summary>See <see cref="ClearCaseColorMode"/>.</summary>
    public string VortexCaseColorMode { get; set; } = "Original";

    /// <summary>
    /// See <see cref="ClearCaseColorMode"/>. This is the FLAT Viva Elite 3D
    /// case - the rendered texture set with the tilt, not the WebGL case,
    /// which carries its own CaseModThreejsColorMode* fields. Its
    /// reflections take the same colour as the case itself.
    /// </summary>
    public string VivaElite3dCaseColorMode { get; set; } = "Original";

    /// <summary>
    /// How the colour is derived from the cover when a case type is set to
    /// "FullShell". Same seven modes, names and order as the Three.js case's own
    /// CaseModThreejsColorBlend - a separate field because the two features
    /// are configured apart, not because they mean anything different.
    /// </summary>
    public string CaseModColorBlend { get; set; } = "DominantDark";

    // Disc geometry (Top/Left/Size per case type) is hard-coded in
    // CaseModController's constants, not configurable.

    /// <summary>
    /// Master switch for the Custom Poster tab, separate from each
    /// sub-feature's own switch (PostercaseEnabled, KeyartEnabled). Both the
    /// tab switch and the sub-feature switch must be true for Postercase to do
    /// anything - see CustomPosterController.IsTypeEnabled().
    /// </summary>
    public bool CustomPosterEnabled { get; set; } = true;

    /// <summary>Master switch for Characterart. Server-side kill switch, see CharacterartController.</summary>
    public bool CharacterartEnabled { get; set; } = true;

    /// <summary>
    /// Master switch for the Backdrops tab, same pattern as
    /// ExtraposterTabEnabled/CustomPosterEnabled; BackdropsEnabled below is the
    /// Detail View Backdrops sub-feature's own switch. PeopleBackdropsController
    /// checks THIS field, not BackdropsEnabled: People Backdrops is a sibling of
    /// Detail View Backdrops under the same tab, so it goes dark when the whole
    /// tab is off, not when the Detail View switch is.
    /// </summary>
    public bool BackdropsTabEnabled { get; set; } = true;

    /// <summary>
    /// Allowed backdrop file formats for the whole Backdrops tab.
    /// BackdropsController.GetAllowedIndices checks each of an item's
    /// backdrop images (as Jellyfin resolved them; the plugin never searches
    /// for them) by its on-disk file extension, and Detail View Backdrops
    /// shows only the matching ones. Does not apply to People Backdrops,
    /// whose images come from a Wallpapers.com URL, not a local file.
    /// </summary>
    public string BackdropsAllowedFormats { get; set; } = "jpg";

    /// <summary>
    /// Switch for Genre Backdrops (the collapse-level "Enable" of the
    /// category in the admin page). Studio and Tag have the same switch.
    /// </summary>
    public bool BackdropsGenreEnabled { get; set; } = true;

    /// <summary>
    /// Shared across all three Genre Backdrops subs (Global/Movies/TV
    /// shows) - one Main-vs-All switch for the whole category, not
    /// per sub. "Main": always the item's own Main backdrop (the file
    /// without a number - Jellyfin's LocalImageProvider.PopulateBackdrops
    /// always adds it first, so it lands at BackdropImageTags[0]).
    /// "All": a random one of the item's own backdrops each time.
    /// </summary>
    public string BackdropsGenreMainOnly { get; set; } = "Main";

    /// <summary>
    /// Shared timing/Ken Burns block for Genre Backdrops - its own copy of
    /// the options Detail View Backdrops has; each category keeps its own
    /// values.
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
    /// One shared field for all three subs (Global/Movies/TvShows):
    /// the rotation order of the items pulled into each sub's backdrop pool.
    /// A real ItemSortBy field name (e.g. "Name", "PremiereDate") is sent to
    /// Jellyfin's items query as SortBy, and rotation traverses the fetched
    /// order. "Shuffle"/"Random" use a stable fetch order (SortName) and let
    /// the shared createBackdropRotationEngine (Core.js) reshuffle/randomize
    /// during rotation, like Detail View Backdrops' OrderMode.
    /// </summary>
    public string BackdropsGenreSortMode { get; set; } = "Shuffle";

    /// <summary>
    /// Only relevant when the sort mode above is a real field (not
    /// Shuffle/Random). "BeginAscending" (default) takes up to 100 items
    /// from the start of the sorted list, "BeginDescending" the same in
    /// reverse; a random offset is the separate Random start checkbox - see
    /// GetGenrePool's doc comment for the mechanism.
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
    /// "Appearances" (default) = the backdrops of the genre's titles;
    /// "ResourceFolder" = the images in metadata\&lt;BackdropsGenreResourceFolderName&gt;\
    /// [&lt;subfolder&gt;\]&lt;genre&gt;\ (Helpers/ResourceFolderResolver).
    /// </summary>
    public string BackdropsGenreSourceMode { get; set; } = "Appearances";

    /// <summary>"General" = one folder for every genre page; "Individual" = one subfolder per Apply-to box.</summary>
    public string BackdropsGenreResourceMode { get; set; } = "General";

    /// <summary>The resource folder under Jellyfin's metadata path (name fields end in FolderName - ConfigNames cleans them on save).</summary>
    public string BackdropsGenreResourceFolderName { get; set; } = "Genre Backdrops";

    /// <summary>Individual only: subfolder for genre pages without a library.</summary>
    public string BackdropsGenreResourceGlobalFolderName { get; set; } = "Global Genres";

    /// <summary>Individual only: subfolder for genre pages of any non-TV library.</summary>
    public string BackdropsGenreResourceMoviesFolderName { get; set; } = "Movie Genres";

    /// <summary>Individual only: subfolder for genre pages of a TV show library.</summary>
    public string BackdropsGenreResourceTvShowsFolderName { get; set; } = "TV show Genres";

    /// <summary>
    /// Where backdrop files come from for every category
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
    /// Per-episode backdrop files (Jellyfin has none beyond
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
    /// Source of Studio Backdrops. "Appearances" rotates the backdrops of
    /// the titles the studio appears in (studio-pool, same mechanics as
    /// Genre); "StudioImage" (default) shows the single
    /// metadata\Studio\&lt;name&gt;\landscape.jpg; "ResourceFolder" reads a
    /// resource folder, see BackdropsGenreSourceMode.
    /// </summary>
    public string BackdropsStudioSourceMode { get; set; } = "StudioImage";

    /// <summary>See BackdropsGenreResourceMode.</summary>
    public string BackdropsStudioResourceMode { get; set; } = "General";

    /// <summary>See BackdropsGenreResourceFolderName.</summary>
    public string BackdropsStudioResourceFolderName { get; set; } = "Studio Backdrops";

    /// <summary>Individual only: subfolder for studio pages outside TV show libraries (movie libraries count as Global).</summary>
    public string BackdropsStudioResourceGlobalFolderName { get; set; } = "Global Studios";

    /// <summary>Individual only: subfolder for studio pages of a TV show library.</summary>
    public string BackdropsStudioResourceTvShowsFolderName { get; set; } = "TV show Studios";

    /// <summary>Appearances only - see BackdropsGenreMainOnly.</summary>
    public string BackdropsStudioMainOnly { get; set; } = "Main";

    /// <summary>Appearances only - see BackdropsGenreCycleTimeMs.</summary>
    public int BackdropsStudioCycleTimeMs { get; set; } = 10000;

    /// <summary>
    /// Studio Backdrops shared Ken Burns block - applies to every source,
    /// the single studio image included.
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
    /// TV shows-library Studios tab (tvstudios.js; jellyfin-web has no
    /// Movies equivalent, so there is no Movies sub for Studio).
    /// </summary>
    public bool BackdropsStudioTvShowsEnabled { get; set; } = true;

    /// <summary>Appearances only - see BackdropsGenreSortMode.</summary>
    public string BackdropsStudioSortMode { get; set; } = "Shuffle";

    /// <summary>Appearances only - see BackdropsGenreTraversalMode.</summary>
    public string BackdropsStudioTraversalMode { get; set; } = "BeginAscending";
    public bool BackdropsStudioRandomStart { get; set; }

    /// <summary>See BackdropsGenreEnabled's own doc comment.</summary>
    public bool BackdropsTagEnabled { get; set; } = true;

    /// <summary>See BackdropsGenreSourceMode (tags are global - no General/Individual).</summary>
    public string BackdropsTagSourceMode { get; set; } = "Appearances";

    /// <summary>See BackdropsGenreResourceFolderName.</summary>
    public string BackdropsTagResourceFolderName { get; set; } = "Tag Backdrops";

    /// <summary>
    /// Tag Backdrops has only one variant: a tag takes everything tagged
    /// with it, mixing movies and shows, so a Global/Movies/TvShows split like
    /// Genre's would be meaningless. Flat structure, same shape as Detail View
    /// Backdrops' settings. See BackdropsGenreMainOnly for the values.
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

    /// <summary>
    /// See BackdropsGenreSourceMode. Applies to the ten
    /// file-based sections; the People section keeps its own three sources.
    /// </summary>
    public string BackdropsFavoritesSourceMode { get; set; } = "Appearances";

    /// <summary>See BackdropsGenreResourceFolderName; the label folder is the section.</summary>
    public string BackdropsFavoritesResourceFolderName { get; set; } = "Favorites Backdrops";

    /// <summary>
    /// "English" = section folders Movies, Shows, ... Books;
    /// "AsShown" = the page title Jellyfin displays (read by the client),
    /// then the English folder.
    /// </summary>
    public string BackdropsFavoritesResourceSectionNames { get; set; } = "English";

    public string BackdropsFavoritesMainOnly { get; set; } = "Main";

    /// <summary>
    /// "General" or "Individual" - General uses
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
    /// simultaneously - per jellyfin-web's
    /// SortButton.tsx: Artists and Playlists have
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
    /// People Backdrops for Favorites - no Sort field, unlike the other ten
    /// sections, but a source dropdown. The sources are mutually exclusive,
    /// never a mixed pool, because they work in entirely different ways:
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
    /// Same concept as
    /// PeopleBackdropsAppearancesFilter (standalone People Backdrops) -
    /// restricts the Appearances query to movies-only/shows-only/both.
    /// Only relevant when BackdropsFavoritesPeopleSourceMode is
    /// "Appearances".
    /// </summary>
    public string BackdropsFavoritesPeopleAppearancesFilter { get; set; } = "MoviesAndSeries";

    /// <summary>
    /// Favorites-People mirrors the standalone People source
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

    // Independent per-type "Show on" switches for Detail View Backdrops.
    // Checked = override active for that type; unchecked = native Jellyfin
    // behaviour for that type, independent of the others.
    public bool BackdropsShowOnMovies { get; set; } = true;

    // BoxSet (Collections/Sets) items. BackdropsController.GetSettings()
    // checks this type explicitly; an unknown item type falls through to
    // "don't block", so without this switch Sets could not be turned off.
    public bool BackdropsShowOnSets { get; set; } = true;

    public bool BackdropsShowOnTvShows { get; set; } = true;

    public bool BackdropsShowOnSeasons { get; set; } = true;

    public bool BackdropsShowOnEpisodes { get; set; } = true;

    public bool BackdropsShowOnVideos { get; set; } = true;

    // Games: the virtual games of the Playnite Bridge plugin (no Jellyfin DB
    // entry, see Helpers/PlayniteBridgeLink). Default false = games keep the
    // vanilla backdrops.
    public bool BackdropsShowOnGames { get; set; }

    // Game collections: Playnite Bridge's virtual collection pages, the same function as its own Collection backdrops.
    public bool BackdropsShowOnGameCollections { get; set; }

    /// <summary>Master switch for Red Carpet. Server-side kill switch, see RedCarpetController.</summary>
    public bool RedCarpetEnabled { get; set; } = true;

    /// <summary>
    /// Image formats RedCarpetController's file search accepts, same pattern
    /// as every other feature's "Allowed image formats". Default "png".
    /// </summary>
    public string RedCarpetAllowedFormats { get; set; } = "png";

    // ───────────────────────── LogoArt tab ─────────────────────────
    // One block per item type: a source chain (Source -> Fallback -> Second
    // fallback) for the logo slot of detail pages, the inheritance level
    // (Source mode, inheriting types only), geometry PER STAGE KIND (logo:
    // Size/Offset/Vertical offset of the vanilla slot; Clearart: the same
    // three for its 16:9 box on the ribbon line; Characterart: the real
    // Characterart sizing block - Scale by / Height + max width / Width +
    // max height / Align / Offset - for its box on the ribbon line, height 0
    // = from the ribbon line up to the page top) and, where Characterart is
    // a possible stage (Movie/Series/Season/Episode/Set), the slot's OWN
    // rotation fields - independent of the Characterart tab (only the file
    // lookup is shared). Set / Season / Episode
    // carry a "Settings" switch: TakeOver = use the Movies / Series block
    // (only their own Source mode stays), Individual = their own rows.
    // Defaults are "zero intervention": VanillaLogo / None / None / Default /
    // 100 / 0 / 0 - the client never touches such a type.
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

    /// <summary>Characterart stage: the Characterart tab's sizing block (same defaults as its Top left set: 20 vh / max 12 vw) for the box standing on the ribbon line.</summary>
    public string LogoArtMovieCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtMovieCharacterartHeightVh { get; set; } = 20;

    public double LogoArtMovieCharacterartMaxWidthVw { get; set; } = 12;

    public double LogoArtMovieCharacterartWidthVw { get; set; } = 11.5;

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

    /// <summary>Characterart stage: the Characterart tab's sizing block (same defaults as its Top left set: 20 vh / max 12 vw) for the box standing on the ribbon line.</summary>
    public string LogoArtSeriesCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtSeriesCharacterartHeightVh { get; set; } = 20;

    public double LogoArtSeriesCharacterartMaxWidthVw { get; set; } = 12;

    public double LogoArtSeriesCharacterartWidthVw { get; set; } = 11.5;

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

    /// <summary>Characterart stage: the Characterart tab's sizing block (same defaults as its Top left set: 20 vh / max 12 vw) for the box standing on the ribbon line.</summary>
    public string LogoArtSeasonCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtSeasonCharacterartHeightVh { get; set; } = 20;

    public double LogoArtSeasonCharacterartMaxWidthVw { get; set; } = 12;

    public double LogoArtSeasonCharacterartWidthVw { get; set; } = 11.5;

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

    /// <summary>Characterart stage: the Characterart tab's sizing block (same defaults as its Top left set: 20 vh / max 12 vw) for the box standing on the ribbon line.</summary>
    public string LogoArtEpisodeCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtEpisodeCharacterartHeightVh { get; set; } = 20;

    public double LogoArtEpisodeCharacterartMaxWidthVw { get; set; } = 12;

    public double LogoArtEpisodeCharacterartWidthVw { get; set; } = 11.5;

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

    /// <summary>Characterart stage: the Characterart tab's sizing block (same defaults as its Top left set: 20 vh / max 12 vw) for the box standing on the ribbon line.</summary>
    public string LogoArtSetCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtSetCharacterartHeightVh { get; set; } = 20;

    public double LogoArtSetCharacterartMaxWidthVw { get; set; } = 12;

    public double LogoArtSetCharacterartWidthVw { get; set; } = 11.5;

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

    // --- LogoArt: Game (Playnite Bridge) ---
    // The Movie block without Source mode: a game has no parent chain.
    /// <summary>VanillaLogo / Clearart / Characterart / Hide - the first stage of the Game chain.</summary>
    public string LogoArtGameSource { get; set; } = "VanillaLogo";

    /// <summary>None / VanillaLogo / Clearart / Characterart - used when the source has no image.</summary>
    public string LogoArtGameFallback { get; set; } = "None";

    public string LogoArtGameSecondFallback { get; set; } = "None";

    /// <summary>Vanilla logo stage: percent of the vanilla slot (25vw x 16vh); 100 = as Jellyfin draws it.</summary>
    public double LogoArtGameLogoSizePercent { get; set; } = 100;

    public double LogoArtGameLogoOffsetVw { get; set; }

    public double LogoArtGameLogoVerticalOffsetVh { get; set; }

    /// <summary>Clearart stage: percent of the 25vw-wide 16:9 box standing on the ribbon line; no cap.</summary>
    public double LogoArtGameClearartSizePercent { get; set; } = 100;

    public double LogoArtGameClearartOffsetVw { get; set; }

    public double LogoArtGameClearartVerticalOffsetVh { get; set; }

    /// <summary>Characterart stage: the Characterart tab's sizing block (same defaults as its Top left set: 20 vh / max 12 vw) for the box standing on the ribbon line.</summary>
    public string LogoArtGameCharacterartScaleMode { get; set; } = "Height";

    public double LogoArtGameCharacterartHeightVh { get; set; } = 20;

    public double LogoArtGameCharacterartMaxWidthVw { get; set; } = 12;

    public double LogoArtGameCharacterartWidthVw { get; set; } = 11.5;

    public double LogoArtGameCharacterartMaxHeightVh { get; set; }

    public string LogoArtGameCharacterartHorizontalAlign { get; set; } = "Center";

    public double LogoArtGameCharacterartOffsetVw { get; set; }

    /// <summary>Rotation of the Characterart stage in the slot - same meaning as the Characterart tab's fields, but its own values.</summary>
    public bool LogoArtGameMultiImage { get; set; } = true;

    public string LogoArtGameOrderMode { get; set; } = "Shuffle";

    public bool LogoArtGameSinglePass { get; set; }

    public bool LogoArtGameRandomStart { get; set; }

    public bool LogoArtGameStaySingleImageStatic { get; set; }

    public int LogoArtGameCycleTimeMs { get; set; } = 5000;

    public int LogoArtGameFadeTimeMs { get; set; } = 1000;

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

    // --- LogoArt: Persons (the one type where LogoArt adds a logo:
    // vanilla never shows one on a person page) ---
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
    // (Sets)" - the internal name stays "Extraposter" everywhere.
    //
    // Four independent view switches (Movies/TV shows × Detail/Library, the
    // same pattern as Animated Poster), each view with its own full set of
    // timing/order/playback values. The naming mode is per content type,
    // because the naming convention differs (TV has no "Prefixed" option).

    /// <summary>
    /// "Standalone" (poster1.jpg in the movie folder), "Prefixed"
    /// (moviename-poster1.jpg in the movie folder), or "Folder" (an
    /// arbitrarily named subfolder, takes every image file inside it).
    /// Always exactly one variant active.
    /// </summary>
    public string ExtraposterMoviesNamingMode { get; set; } = "Prefixed";

    /// <summary>Only relevant when ExtraposterMoviesNamingMode == "Folder".</summary>
    public string ExtraposterMoviesFolderName { get; set; } = "extraposter";

    /// <summary>The word the numbered files start with in Prefixed / Standalone mode, freely changeable - independent of the folder name.</summary>
    public string ExtraposterMoviesTypeName { get; set; } = "poster";

    /// <summary>
    /// "Standalone" or "Folder" - deliberately WITHOUT "Prefixed": a
    /// series has its own exclusive main folder, prefix disambiguation
    /// isn't needed (the same reasoning as Characterart's TV naming).
    /// </summary>
    public string ExtraposterTvShowsNamingMode { get; set; } = "Standalone";

    /// <summary>Only relevant when ExtraposterTvShowsNamingMode == "Folder".</summary>
    public string ExtraposterTvShowsFolderName { get; set; } = "extraposter";

    /// <summary>The word the numbered files start with in Prefixed / Standalone mode, freely changeable - independent of the folder name.</summary>
    public string ExtraposterTvShowsTypeName { get; set; } = "poster";

    /// <summary>
    /// Comma-separated list of allowed image extensions without a dot,
    /// e.g. "jpg,png". A selection from the 7 formats Jellyfin itself
    /// supports (BaseItem.SupportedImageExtensions:
    /// png,jpg,jpeg,webp,tbn,gif,svg). Shared across Movies and TV shows,
    /// detail and library. If all are deselected, ExtraposterEnabled is
    /// also automatically disabled in the config page (self-correction
    /// logic, see configPage.html). Tab-level: Extrakeyart uses the same
    /// setting.
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

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesHomeContinueWatching { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnMoviesDetailPeoplePages { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnSetsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnSetsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnSetsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnSetsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterMoviesLibraryAlsoOnSetsListsFolderMore { get; set; }

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

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterTvShowsLibraryAlsoOnShowsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterTvShowsLibraryAlsoOnShowsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterTvShowsLibraryAlsoOnShowsHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterTvShowsLibraryAlsoOnShowsListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterTvShowsLibraryAlsoOnShowsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterTvShowsLibraryAlsoOnShowsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterTvShowsLibraryAlsoOnShowsListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterTvShowsLibraryAlsoOnShowsDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterTvShowsLibraryAlsoOnShowsDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtraposterTvShowsLibraryAlsoOnShowsDetailPeoplePages { get; set; }

    // ----- Extraposter / movies (and Sets) / detail pages: every view has its own
    // full set; nothing is shared between detail and library.
    // ExtraposterMoviesDetailEnabled is the view switch.
    /// <summary>Show on movies in this view.</summary>
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

    /// <summary>Second fallback: tried when the first fallback has nothing either; None skips the movie.</summary>
    public string ExtraposterMoviesDetailSetFallback2 { get; set; } = "None";

    /// <summary>Set slideshow with Keyart images: each movie's own Jellyfin Logo drawn over its keyart.</summary>
    public bool ExtraposterMoviesDetailSetKeyartLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int ExtraposterMoviesDetailSetKeyartLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int ExtraposterMoviesDetailSetKeyartLogoSizePercent { get; set; } = 60;

    public string ExtraposterMoviesDetailOrderMode { get; set; } = "Sequential";

    /// <summary>Whether a file without a number (e.g. "poster.jpg") is the first image - "Ignored" (default: poster.jpg is Jellyfin's own poster) or "Counts".</summary>
    public string ExtraposterMoviesDetailUnnumberedMode { get; set; } = "Ignored";

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

    // ----- Extraposter / movies (and Sets) / library views: every view has its own
    // full set; nothing is shared between detail and library.
    // ExtraposterMoviesLibraryEnabled is the view switch.
    /// <summary>Show on movies in this view.</summary>
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

    /// <summary>Second fallback: tried when the first fallback has nothing either; None skips the movie.</summary>
    public string ExtraposterMoviesLibrarySetFallback2 { get; set; } = "None";

    /// <summary>Set slideshow with Keyart images: each movie's own Jellyfin Logo drawn over its keyart.</summary>
    public bool ExtraposterMoviesLibrarySetKeyartLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int ExtraposterMoviesLibrarySetKeyartLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int ExtraposterMoviesLibrarySetKeyartLogoSizePercent { get; set; } = 80;

    public string ExtraposterMoviesLibraryOrderMode { get; set; } = "Sequential";

    /// <summary>Whether a file without a number (e.g. "poster.jpg") is the first image - "Ignored" (default: poster.jpg is Jellyfin's own poster) or "Counts".</summary>
    public string ExtraposterMoviesLibraryUnnumberedMode { get; set; } = "Ignored";

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

    /// <summary>Library views only: all tiles of a page change on one shared clock; a tile whose first image is late waits for the next tick.</summary>
    public bool ExtraposterMoviesLibrarySyncEnabled { get; set; } = true;

    /// <summary>Library views: on = the tile stays blank until our image is ready (no poster flash, slightly later); off = Jellyfin's poster shows first, ours replaces it.</summary>
    public bool ExtraposterMoviesLibrarySeamlessEnabled { get; set; } = true;

    // ----- Extraposter / TV shows / detail pages: every view has its own
    // full set; nothing is shared between detail and library.
    // ExtraposterTvShowsDetailEnabled is the view switch.
    /// <summary>Show on TV shows in this view.</summary>
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

    /// <summary>Whether a file without a number (e.g. "poster.jpg") is the first image - "Ignored" (default: poster.jpg is Jellyfin's own poster) or "Counts".</summary>
    public string ExtraposterTvShowsDetailUnnumberedMode { get; set; } = "Ignored";

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

    // ----- Extraposter / TV shows / library views: every view has its own
    // full set; nothing is shared between detail and library.
    // ExtraposterTvShowsLibraryEnabled is the view switch.
    /// <summary>Show on TV shows in this view.</summary>
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

    /// <summary>Whether a file without a number (e.g. "poster.jpg") is the first image - "Ignored" (default: poster.jpg is Jellyfin's own poster) or "Counts".</summary>
    public string ExtraposterTvShowsLibraryUnnumberedMode { get; set; } = "Ignored";

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

    /// <summary>Library views only: all tiles of a page change on one shared clock; a tile whose first image is late waits for the next tick.</summary>
    public bool ExtraposterTvShowsLibrarySyncEnabled { get; set; } = true;

    /// <summary>Library views: on = the tile stays blank until our image is ready (no poster flash, slightly later); off = Jellyfin's poster shows first, ours replaces it.</summary>
    public bool ExtraposterTvShowsLibrarySeamlessEnabled { get; set; } = true;

    /// <summary>
    /// Which of Extraposter/Extrakeyart wins when both are enabled and
    /// both have candidates for the same title: "Extraposter" or
    /// "Extrakeyart". Lives in the Extraposter tab, like
    /// CustomPosterPriority in the Custom Poster tab.
    /// </summary>
    public string ExtraposterPriority { get; set; } = "Extraposter";

    // ───────────────────────── Extraposter tab: Extrakeyart ─────────────────────────
    // Multi-image variant of Keyart - lives in the same controller/module
    // as Extraposter (ExtraposterController.cs / Posters-v1.js's
    // ExtraModule), just as Postercase/Keyart share CustomPosterController.cs.
    // Its own field set, mirroring Extraposter's one-to-one, independent of
    // Extraposter's values. Allowed formats are the tab-level
    // AllowedFormats.

    public bool ExtrakeyartEnabled { get; set; } = true;

    public string ExtrakeyartMoviesNamingMode { get; set; } = "Prefixed";

    public string ExtrakeyartMoviesFolderName { get; set; } = "keyart";

    /// <summary>The word the numbered files start with in Prefixed / Standalone mode, freely changeable - independent of the folder name.</summary>
    public string ExtrakeyartMoviesTypeName { get; set; } = "keyart";

    public bool ExtrakeyartMoviesDetailEnabled { get; set; } = true;

    public bool ExtrakeyartMoviesLibraryEnabled { get; set; } = true;

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesHomeContinueWatching { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnMoviesDetailPeoplePages { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnSetsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnSetsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnSetsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnSetsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartMoviesLibraryAlsoOnSetsListsFolderMore { get; set; }

    public string ExtrakeyartTvShowsNamingMode { get; set; } = "Standalone";

    public string ExtrakeyartTvShowsFolderName { get; set; } = "keyart";

    /// <summary>The word the numbered files start with in Prefixed / Standalone mode, freely changeable - independent of the folder name.</summary>
    public string ExtrakeyartTvShowsTypeName { get; set; } = "keyart";

    public bool ExtrakeyartTvShowsDetailEnabled { get; set; } = true;

    public bool ExtrakeyartTvShowsLibraryEnabled { get; set; } = true;

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartTvShowsLibraryAlsoOnShowsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartTvShowsLibraryAlsoOnShowsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartTvShowsLibraryAlsoOnShowsHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartTvShowsLibraryAlsoOnShowsListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartTvShowsLibraryAlsoOnShowsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartTvShowsLibraryAlsoOnShowsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartTvShowsLibraryAlsoOnShowsListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartTvShowsLibraryAlsoOnShowsDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartTvShowsLibraryAlsoOnShowsDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool ExtrakeyartTvShowsLibraryAlsoOnShowsDetailPeoplePages { get; set; }

    // ----- Extrakeyart / movies (and Sets) / detail pages: every view has its own
    // full set; nothing is shared between detail and library.
    // ExtrakeyartMoviesDetailEnabled is the view switch.
    /// <summary>Show on movies in this view.</summary>
    public bool ExtrakeyartMoviesDetailShowOnMovies { get; set; } = true;

    /// <summary>Show on Sets (collections) in this view - Sets use the Movies settings, always Standalone.</summary>
    public bool ExtrakeyartMoviesDetailShowOnSets { get; set; } = true;

    public string ExtrakeyartMoviesDetailOrderMode { get; set; } = "Sequential";
    /// <summary>Ignored | Counts - whether a file without a number (keyart.jpg) is picked up as the first image (per view).</summary>
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

    // ----- Extrakeyart / movies (and Sets) / library views: every view has its own
    // full set; nothing is shared between detail and library.
    // ExtrakeyartMoviesLibraryEnabled is the view switch.
    /// <summary>Show on movies in this view.</summary>
    public bool ExtrakeyartMoviesLibraryShowOnMovies { get; set; } = true;

    /// <summary>Show on Sets (collections) in this view - Sets use the Movies settings, always Standalone.</summary>
    public bool ExtrakeyartMoviesLibraryShowOnSets { get; set; } = true;

    public string ExtrakeyartMoviesLibraryOrderMode { get; set; } = "Sequential";
    /// <summary>Ignored | Counts - whether a file without a number (keyart.jpg) is picked up as the first image (per view).</summary>
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

    /// <summary>Library views only: all tiles of a page change on one shared clock; a tile whose first image is late waits for the next tick.</summary>
    public bool ExtrakeyartMoviesLibrarySyncEnabled { get; set; } = true;

    /// <summary>Library views: on = the tile stays blank until our image is ready (no poster flash, slightly later); off = Jellyfin's poster shows first, ours replaces it.</summary>
    public bool ExtrakeyartMoviesLibrarySeamlessEnabled { get; set; } = true;

    // ----- Extrakeyart / TV shows / detail pages: every view has its own
    // full set; nothing is shared between detail and library.
    // ExtrakeyartTvShowsDetailEnabled is the view switch.
    /// <summary>Show on TV shows in this view.</summary>
    public bool ExtrakeyartTvShowsDetailShowOnTvShows { get; set; } = true;

    public string ExtrakeyartTvShowsDetailOrderMode { get; set; } = "Sequential";
    /// <summary>Ignored | Counts - whether a file without a number (keyart.jpg) is picked up as the first image (per view).</summary>
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

    // ----- Extrakeyart / TV shows / library views: every view has its own
    // full set; nothing is shared between detail and library.
    // ExtrakeyartTvShowsLibraryEnabled is the view switch.
    /// <summary>Show on TV shows in this view.</summary>
    public bool ExtrakeyartTvShowsLibraryShowOnTvShows { get; set; } = true;

    public string ExtrakeyartTvShowsLibraryOrderMode { get; set; } = "Sequential";
    /// <summary>Ignored | Counts - whether a file without a number (keyart.jpg) is picked up as the first image (per view).</summary>
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

    /// <summary>Library views only: all tiles of a page change on one shared clock; a tile whose first image is late waits for the next tick.</summary>
    public bool ExtrakeyartTvShowsLibrarySyncEnabled { get; set; } = true;

    /// <summary>Library views: on = the tile stays blank until our image is ready (no poster flash, slightly later); off = Jellyfin's poster shows first, ours replaces it.</summary>
    public bool ExtrakeyartTvShowsLibrarySeamlessEnabled { get; set; } = true;

    // ───────────────────────── Characterart tab ─────────────────────────
    // A separate feature block, independent of Extraposter - its own
    // placement on the page instead of the poster slot, detail views only
    // (no library extension). Movies and TV (series/season/episode) are
    // configured separately, as everywhere else.

    /// <summary>
    /// Where Characterart may show up at all - independently selectable
    /// content types. Season/Episode always show
    /// the series' main-folder content (see CharacterartTvShows* below),
    /// these four switches only control on which PAGES Characterart shows
    /// up at all.
    /// </summary>
    public bool CharacterartShowOnMovies { get; set; } = true;

    // Sets (BoxSet/Collections). There are no Characterart*Sets* settings:
    // Sets share every Movies setting (TypeName, FolderName, MultiImage,
    // etc.), the way Season/Episode share the TvShows settings - except
    // NamingMode, which is always "Standalone" for Sets (a "prefixed" file
    // name needs a single movie's name, and a Set has none). Enforced in
    // CharacterartController.ResolveItem(); this field only controls
    // whether Sets participate at all.
    public bool CharacterartShowOnSets { get; set; } = true;

    public bool CharacterartShowOnTvShows { get; set; } = true;

    public bool CharacterartShowOnSeasons { get; set; } = true;

    public bool CharacterartShowOnEpisodes { get; set; } = true;

    /// <summary>
    /// Comma-separated allowed formats, the same 7 as Extraposter, but its
    /// own field - Characterart will usually be .png in practice, but
    /// deliberately not restricted to that in the code.
    /// </summary>
    public string CharacterartAllowedFormats { get; set; } = "png";

    /// <summary>
    /// Position on the movie detail page: "TopLeft", "TopRight",
    /// "BottomLeft" or "BottomRight". Position and size/offset are
    /// configured separately per content type (Movies vs. TV shows), since
    /// the two detail pages may want the artwork in different places.
    /// </summary>
    public string CharacterartMoviesPosition { get; set; } = "TopRight";

    /// <summary>
    /// Sizing is configured per position (one full set for each of the
    /// four positions), since the four spots on the page differ a lot. Only
    /// the selected position's set is used at runtime (see
    /// CharacterartController.GetCharacterart); the other three stay stored.
    ///
    /// A pure vw size cannot work across window shapes: the real constraint
    /// is vertical space (driven by em/vh values), which scales independently
    /// of the viewport width. So ScaleMode ("Height" or "Width") picks the
    /// primary, directly configured dimension; the other one follows the
    /// image's aspect ratio, capped by its Max*Vw/Max*Vh value when non-zero.
    /// HorizontalAlign places the image within leftover horizontal space in
    /// the box (relevant when a rotation image's aspect ratio differs from the
    /// image that set the box size); OffsetVw shifts the whole box.
    /// </summary>
    public string CharacterartMoviesTopLeftScaleMode { get; set; } = "Height";

    public double CharacterartMoviesTopLeftHeightVh { get; set; } = 20;

    public double CharacterartMoviesTopLeftMaxWidthVw { get; set; } = 12;

    public double CharacterartMoviesTopLeftWidthVw { get; set; } = 11.5;

    public double CharacterartMoviesTopLeftMaxHeightVh { get; set; }

    public string CharacterartMoviesTopLeftHorizontalAlign { get; set; } = "Center";

    public double CharacterartMoviesTopLeftOffsetVw { get; set; } = 4;

    // Per-position fullscreen offset (see
    // CharacterartMoviesTopRightFullscreenOffsetVw below) - added on top of
    // the OffsetVw above only while the browser tab is in fullscreen.
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
    /// client-side in characterart.js). One per position/media-type
    /// combination (same granularity as OffsetVw), because windowed and
    /// fullscreen need different corrections at different positions.
    /// Applied via a body class the client toggles, see
    /// Core.installFullscreenClass().
    /// </summary>
    public double CharacterartMoviesTopRightFullscreenOffsetVw { get; set; } = 2.5;

    public string CharacterartMoviesBottomLeftScaleMode { get; set; } = "Height";

    public double CharacterartMoviesBottomLeftHeightVh { get; set; } = 30;

    public double CharacterartMoviesBottomLeftMaxWidthVw { get; set; } = 30;

    public double CharacterartMoviesBottomLeftWidthVw { get; set; } = 11.5;

    public double CharacterartMoviesBottomLeftMaxHeightVh { get; set; }

    public string CharacterartMoviesBottomLeftHorizontalAlign { get; set; } = "Center";

    public double CharacterartMoviesBottomLeftOffsetVw { get; set; } = -1.5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw.
    public double CharacterartMoviesBottomLeftFullscreenOffsetVw { get; set; }

    public string CharacterartMoviesBottomRightScaleMode { get; set; } = "Height";

    public double CharacterartMoviesBottomRightHeightVh { get; set; } = 30;

    public double CharacterartMoviesBottomRightMaxWidthVw { get; set; } = 30;

    public double CharacterartMoviesBottomRightWidthVw { get; set; } = 11.5;

    public double CharacterartMoviesBottomRightMaxHeightVh { get; set; }

    public string CharacterartMoviesBottomRightHorizontalAlign { get; set; } = "Center";

    public double CharacterartMoviesBottomRightOffsetVw { get; set; } = 1.5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw.
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

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw.
    public double CharacterartTvShowsTopLeftFullscreenOffsetVw { get; set; } = -2.5;

    public string CharacterartTvShowsTopRightScaleMode { get; set; } = "Height";

    public double CharacterartTvShowsTopRightHeightVh { get; set; } = 20;

    public double CharacterartTvShowsTopRightMaxWidthVw { get; set; } = 12;

    public double CharacterartTvShowsTopRightWidthVw { get; set; } = 11.5;

    public double CharacterartTvShowsTopRightMaxHeightVh { get; set; }

    public string CharacterartTvShowsTopRightHorizontalAlign { get; set; } = "Center";

    public double CharacterartTvShowsTopRightOffsetVw { get; set; } = -5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw.
    public double CharacterartTvShowsTopRightFullscreenOffsetVw { get; set; } = 2.5;

    public string CharacterartTvShowsBottomLeftScaleMode { get; set; } = "Height";

    public double CharacterartTvShowsBottomLeftHeightVh { get; set; } = 30;

    public double CharacterartTvShowsBottomLeftMaxWidthVw { get; set; } = 30;

    public double CharacterartTvShowsBottomLeftWidthVw { get; set; } = 11.5;

    public double CharacterartTvShowsBottomLeftMaxHeightVh { get; set; }

    public string CharacterartTvShowsBottomLeftHorizontalAlign { get; set; } = "Center";

    public double CharacterartTvShowsBottomLeftOffsetVw { get; set; } = -1.5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw.
    public double CharacterartTvShowsBottomLeftFullscreenOffsetVw { get; set; }

    public string CharacterartTvShowsBottomRightScaleMode { get; set; } = "Height";

    public double CharacterartTvShowsBottomRightHeightVh { get; set; } = 30;

    public double CharacterartTvShowsBottomRightMaxWidthVw { get; set; } = 30;

    public double CharacterartTvShowsBottomRightWidthVw { get; set; } = 11.5;

    public double CharacterartTvShowsBottomRightMaxHeightVh { get; set; }

    public string CharacterartTvShowsBottomRightHorizontalAlign { get; set; } = "Center";

    public double CharacterartTvShowsBottomRightOffsetVw { get; set; } = 1.5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw.
    public double CharacterartTvShowsBottomRightFullscreenOffsetVw { get; set; }

    // --- Movies ---

    /// <summary>"Standalone", "Prefixed", or "Folder" - all three variants like Poster.</summary>
    public string CharacterartMoviesNamingMode { get; set; } = "Prefixed";

    /// <summary>
    /// The name/prefix component for Standalone/Prefixed, e.g. for
    /// Standalone, exactly "&lt;TypeName&gt;.png" is looked for, for
    /// Prefixed "&lt;MovieName&gt;-&lt;TypeName&gt;.png". No forced
    /// convention, freely changeable.
    /// </summary>
    public string CharacterartMoviesTypeName { get; set; } = "characterart";

    /// <summary>Only relevant when CharacterartMoviesNamingMode == "Folder".</summary>
    public string CharacterartMoviesFolderName { get; set; } = "characterart";

    /// <summary>
    /// true = multi-image slideshow like Poster (numbered files),
    /// false = always exactly 1 static image with no number.
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
    /// when an item has only 1 image despite MultiImage being on (the
    /// rotation timer never runs then, so single-pass would never fade it).
    /// true = the single image stays static. false (default) = it behaves
    /// like any single pass: fade out and disappear after one CycleTimeMs.
    /// </summary>
    public bool CharacterartMoviesStaySingleImageStatic { get; set; }

    /// <summary>
    /// Only relevant when CharacterartMoviesMultiImage == true - "Sequential"
    /// (natural numeric order) or "Random" (shuffled once per resolve, no
    /// repeats until every image has been shown - see ExtraposterController's
    /// identical Random handling, replicated here).
    /// </summary>
    public string CharacterartMoviesOrderMode { get; set; } = "Shuffle";

    /// <summary>Multi image - whether the file without a number (e.g. "characterart.png") is the first image - "Counts" (default) or "Ignored".</summary>
    public string CharacterartMoviesUnnumberedMode { get; set; } = "Counts";

    // --- TV (series/season/episode) ---

    /// <summary>
    /// "Standalone" or "Folder" - deliberately WITHOUT "Prefixed"
    /// (the series' main folder is always exclusive to
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
    /// Same as CharacterartMoviesStaySingleImageStatic, for TV shows.
    /// </summary>
    public bool CharacterartTvShowsStaySingleImageStatic { get; set; }

    /// <summary>Same as CharacterartMoviesOrderMode, for TV shows.</summary>
    public string CharacterartTvShowsOrderMode { get; set; } = "Shuffle";

    /// <summary>Multi image - whether the file without a number (e.g. "characterart.png") is the first image - "Counts" (default) or "Ignored".</summary>
    public string CharacterartTvShowsUnnumberedMode { get; set; } = "Counts";

    // ───────────── CharacterArt: Games (Playnite Bridge's virtual games) ─────────────
    // The Movies block without its naming rows: a game's files are read in its game folder with the
    // Movies naming (Prefixed reads as Standalone - the folder name carries Playnite Bridge's short id).
    // Default off: games show no CharacterArt until ticked.
    public bool CharacterartShowOnGames { get; set; }

    public string CharacterartGamesPosition { get; set; } = "TopRight";

    public string CharacterartGamesTopLeftScaleMode { get; set; } = "Height";

    public double CharacterartGamesTopLeftHeightVh { get; set; } = 20;

    public double CharacterartGamesTopLeftMaxWidthVw { get; set; } = 12;

    public double CharacterartGamesTopLeftWidthVw { get; set; } = 11.5;

    public double CharacterartGamesTopLeftMaxHeightVh { get; set; }

    public string CharacterartGamesTopLeftHorizontalAlign { get; set; } = "Center";

    public double CharacterartGamesTopLeftOffsetVw { get; set; } = 4;

    public double CharacterartGamesTopLeftFullscreenOffsetVw { get; set; } = -2.5;

    public string CharacterartGamesTopRightScaleMode { get; set; } = "Height";

    public double CharacterartGamesTopRightHeightVh { get; set; } = 20;

    public double CharacterartGamesTopRightMaxWidthVw { get; set; } = 12;

    public double CharacterartGamesTopRightWidthVw { get; set; } = 11.5;

    public double CharacterartGamesTopRightMaxHeightVh { get; set; }

    public string CharacterartGamesTopRightHorizontalAlign { get; set; } = "Center";

    public double CharacterartGamesTopRightOffsetVw { get; set; } = -5;

    public double CharacterartGamesTopRightFullscreenOffsetVw { get; set; } = 2.5;

    public string CharacterartGamesBottomLeftScaleMode { get; set; } = "Height";

    public double CharacterartGamesBottomLeftHeightVh { get; set; } = 30;

    public double CharacterartGamesBottomLeftMaxWidthVw { get; set; } = 30;

    public double CharacterartGamesBottomLeftWidthVw { get; set; } = 11.5;

    public double CharacterartGamesBottomLeftMaxHeightVh { get; set; }

    public string CharacterartGamesBottomLeftHorizontalAlign { get; set; } = "Center";

    public double CharacterartGamesBottomLeftOffsetVw { get; set; } = -1.5;

    public double CharacterartGamesBottomLeftFullscreenOffsetVw { get; set; }

    public string CharacterartGamesBottomRightScaleMode { get; set; } = "Height";

    public double CharacterartGamesBottomRightHeightVh { get; set; } = 30;

    public double CharacterartGamesBottomRightMaxWidthVw { get; set; } = 30;

    public double CharacterartGamesBottomRightWidthVw { get; set; } = 11.5;

    public double CharacterartGamesBottomRightMaxHeightVh { get; set; }

    public string CharacterartGamesBottomRightHorizontalAlign { get; set; } = "Center";

    public double CharacterartGamesBottomRightOffsetVw { get; set; } = 1.5;

    public double CharacterartGamesBottomRightFullscreenOffsetVw { get; set; }

    public bool CharacterartGamesMultiImage { get; set; } = true;

    public int CharacterartGamesCycleTimeMs { get; set; } = 5000;

    public int CharacterartGamesFadeTimeMs { get; set; } = 1000;

    public bool CharacterartGamesDelayEnabled { get; set; }

    public int CharacterartGamesDelayMs { get; set; } = 5000;

    public bool CharacterartGamesSinglePass { get; set; }

    public bool CharacterartGamesRandomStart { get; set; }

    public bool CharacterartGamesStaySingleImageStatic { get; set; }

    public string CharacterartGamesOrderMode { get; set; } = "Shuffle";

    // ───────────────────────── Animated Poster tab ─────────────────────────
    // Replaces the main poster entirely instead of
    // overlaying it (unlike Extraposter/Characterart). No multi-image
    // concept - always exactly one animated file, so no Folder mode and no
    // timing (cycle/fade/delay/single-pass) is needed either.

    /// <summary>
    /// Comma-separated from "gif", "apng", "webp" - the three researched
    /// animated formats renderable via background-image.
    /// Default: GIF only (the universal fallback with the widest
    /// compatibility - APNG/WEBP are opt-in).
    /// </summary>
    public string AnimatedPosterAllowedFormats { get; set; } = "gif";

    // --- Movies ---

    /// <summary>"Standalone" or "Prefixed" - deliberately WITHOUT "Folder" (no multi-image concept).</summary>
    public string AnimatedPosterMoviesNamingMode { get; set; } = "Prefixed";

    /// <summary>Naming-pattern component, no forced convention.</summary>
    public string AnimatedPosterMoviesTypeName { get; set; } = "animatedposter";

    /// <summary>
    /// Coarse gate over AnimatedPosterMoviesDetailEnabled/LibraryEnabled
    /// below - off disables Animated Poster for movies entirely. Unlike Extraposter/Postercase/Keyart's
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

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesHomeContinueWatching { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnMoviesDetailPeoplePages { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnSetsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnSetsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnSetsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnSetsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterMoviesLibraryAlsoOnSetsListsFolderMore { get; set; }

    // --- Sets (BoxSet/Collections) ---
    // Sets have no TypeName/Detail/Library fields of their own - they
    // reuse the Movies fields above, as in Extraposter/Extrakeyart/
    // Postercase/Keyart. Naming is always "Standalone" for Sets.

    /// <summary>Same as <see cref="AnimatedPosterShowOnMovies"/>, but for Sets. When checked, Sets uses Movies' own TypeName/Detail/Library settings above, always with Standalone naming.</summary>
    public bool AnimatedPosterShowOnSets { get; set; } = true;

    // --- TV shows (always the series' main level) ---

    /// <summary>
    /// Naming-pattern component for TV content. No separate NamingMode
    /// field needed - for TV, only "Standalone" ever makes sense anyway
    /// (a series has an exclusive main folder, no Prefixed/Folder).
    /// </summary>
    public string AnimatedPosterTvShowsTypeName { get; set; } = "animatedposter";

    /// <summary>Same as <see cref="AnimatedPosterShowOnMovies"/>, but for TV shows.</summary>
    public bool AnimatedPosterShowOnTvShows { get; set; } = true;

    public bool AnimatedPosterTvShowsDetailEnabled { get; set; } = true;

    public bool AnimatedPosterTvShowsLibraryEnabled { get; set; } = true;

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterTvShowsLibraryAlsoOnShowsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterTvShowsLibraryAlsoOnShowsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterTvShowsLibraryAlsoOnShowsHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterTvShowsLibraryAlsoOnShowsListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterTvShowsLibraryAlsoOnShowsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterTvShowsLibraryAlsoOnShowsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterTvShowsLibraryAlsoOnShowsListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterTvShowsLibraryAlsoOnShowsDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterTvShowsLibraryAlsoOnShowsDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedPosterTvShowsLibraryAlsoOnShowsDetailPeoplePages { get; set; }

    // ───────────────────────── Animated Poster tab: Animated Keyart ─────────────────────────
    // Sibling feature to Animated Poster above, same relationship as
    // Keyart to Postercase - structurally a 1:1 copy of the Animated
    // Poster block. Shares AnimatedPosterAllowedFormats/AnimatedPosterTabEnabled/
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

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesHomeContinueWatching { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnMoviesDetailPeoplePages { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnSetsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnSetsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnSetsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnSetsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartMoviesLibraryAlsoOnSetsListsFolderMore { get; set; }

    // --- Sets (BoxSet/Collections) --- reuses the Movies fields above, same as Animated Poster's Sets.

    /// <summary>Same as <see cref="AnimatedKeyartShowOnMovies"/>, but for Sets. When checked, Sets uses Movies' own TypeName/Detail/Library settings above, always with Standalone naming.</summary>
    public bool AnimatedKeyartShowOnSets { get; set; } = true;

    // --- TV shows (always the series' main level) ---
    public string AnimatedKeyartTvShowsTypeName { get; set; } = "animatedkeyart";

    /// <summary>Same as <see cref="AnimatedKeyartShowOnMovies"/>, but for TV shows.</summary>
    public bool AnimatedKeyartShowOnTvShows { get; set; } = true;

    public bool AnimatedKeyartTvShowsDetailEnabled { get; set; } = true;

    public bool AnimatedKeyartTvShowsLibraryEnabled { get; set; } = true;

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartTvShowsLibraryAlsoOnShowsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartTvShowsLibraryAlsoOnShowsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartTvShowsLibraryAlsoOnShowsHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartTvShowsLibraryAlsoOnShowsListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartTvShowsLibraryAlsoOnShowsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartTvShowsLibraryAlsoOnShowsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartTvShowsLibraryAlsoOnShowsListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartTvShowsLibraryAlsoOnShowsDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartTvShowsLibraryAlsoOnShowsDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool AnimatedKeyartTvShowsLibraryAlsoOnShowsDetailPeoplePages { get; set; }

    // ----- Animated Keyart logo overlay, detail pages (the same logo option every other Keyart variant has).
    /// <summary>Jellyfin's Logo image drawn over the animated keyart on detail pages.</summary>
    public bool AnimatedKeyartDetailLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int AnimatedKeyartDetailLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int AnimatedKeyartDetailLogoSizePercent { get; set; } = 60;

    // ----- Animated Keyart logo overlay, library views (the same logo option every other Keyart variant has).
    /// <summary>Jellyfin's Logo image drawn over the animated keyart on library views.</summary>
    public bool AnimatedKeyartLibraryLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int AnimatedKeyartLibraryLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int AnimatedKeyartLibraryLogoSizePercent { get; set; } = 80;

    // ───────────────────────── Custom Poster tab: Postercase ─────────────────────────
    // A retouched poster with no lettering - a complete replacement for the
    // native poster (layer 0 in the arbiter, priority 1 - see Core.js's
    // "Priority model" doc comment). Falls back to the native poster if no
    // file exists. Single-image only, like Animated Poster (no Folder mode).
    // Keyart below is a sibling with its own Enabled/ShowOn/NamingMode
    // fields: the two stay independently toggleable although they share
    // one controller, script and config tab.

    /// <summary>Master switch for Postercase. Server-side kill switch, mirrors AnimatedPosterEnabled's own role.</summary>
    public bool PostercaseEnabled { get; set; } = true;

    /// <summary>
    /// Coarse gate over PostercaseMoviesDetailEnabled/LibraryEnabled below -
    /// off disables Postercase for movies entirely, same pattern as
    /// ExtraposterShowOnMovies.
    /// </summary>
    public bool PostercaseShowOnMovies { get; set; } = true;

    /// <summary>Show on Sets (BoxSet/Collections); Sets use the Movies settings, always with Standalone naming.</summary>
    public bool PostercaseShowOnSets { get; set; } = true;

    /// <summary>Same as <see cref="PostercaseShowOnMovies"/>, but for TV shows.</summary>
    public bool PostercaseShowOnTvShows { get; set; } = true;

    /// <summary>
    /// Comma-separated from Jellyfin's supported still-image formats.
    /// Tab-level, shared by Postercase and Keyart (as Extraposter's
    /// AllowedFormats covers Extrakeyart). Default "jpg", the same as
    /// Extraposter's.
    /// </summary>
    public string CustomPosterAllowedFormats { get; set; } = "jpg";

    // --- Movies ---

    /// <summary>"Prefixed" or "Standalone". Single-image types have no Folder mode; a saved "Folder" is read as Standalone.</summary>
    public string PostercaseMoviesNamingMode { get; set; } = "Prefixed";

    /// <summary>Naming-pattern component, no forced convention.</summary>
    public string PostercaseMoviesTypeName { get; set; } = "postercase";

    public bool PostercaseMoviesDetailEnabled { get; set; } = true;

    public bool PostercaseMoviesLibraryEnabled { get; set; } = true;

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesHomeContinueWatching { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnMoviesDetailPeoplePages { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnSetsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnSetsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnSetsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnSetsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseMoviesLibraryAlsoOnSetsListsFolderMore { get; set; }

    // --- TV shows (always the series' main level; Season/Episode are out of scope) ---

    /// <summary>
    /// Naming-pattern component for TV content.
    /// </summary>
    public string PostercaseTvShowsTypeName { get; set; } = "postercase";

    public bool PostercaseTvShowsDetailEnabled { get; set; } = true;

    public bool PostercaseTvShowsLibraryEnabled { get; set; } = true;

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseTvShowsLibraryAlsoOnShowsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseTvShowsLibraryAlsoOnShowsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseTvShowsLibraryAlsoOnShowsHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseTvShowsLibraryAlsoOnShowsListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseTvShowsLibraryAlsoOnShowsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseTvShowsLibraryAlsoOnShowsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseTvShowsLibraryAlsoOnShowsListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseTvShowsLibraryAlsoOnShowsDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseTvShowsLibraryAlsoOnShowsDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool PostercaseTvShowsLibraryAlsoOnShowsDetailPeoplePages { get; set; }

    /// <summary>
    /// Which of Postercase/Keyart wins as the layer-0 image when both
    /// exist for the same title: "Postercase" or "Keyart".
    /// </summary>
    public string CustomPosterPriority { get; set; } = "Postercase";

    // ───────────────────────── Custom Poster tab: Keyart ─────────────────────────
    // A textless poster - same layer-0 role as Postercase, same single-
    // image/no-Folder-mode reasoning, purely file-based (no TMDB API; only
    // the naming convention is borrowed from there).

    /// <summary>Master switch for Keyart. Server-side kill switch, mirrors PostercaseEnabled's own role.</summary>
    public bool KeyartEnabled { get; set; } = true;

    /// <summary>Same as <see cref="PostercaseShowOnMovies"/>, but for Keyart.</summary>
    public bool KeyartShowOnMovies { get; set; } = true;

    /// <summary>Show on Sets (BoxSet/Collections); Sets use the Movies settings, always with Standalone naming.</summary>
    public bool KeyartShowOnSets { get; set; } = true;

    /// <summary>Same as <see cref="KeyartShowOnMovies"/>, but for TV shows.</summary>
    public bool KeyartShowOnTvShows { get; set; } = true;

    // Allowed formats: the tab-level CustomPosterAllowedFormats above.

    // --- Movies ---

    /// <summary>"Prefixed" or "Standalone" - see PostercaseMoviesNamingMode.</summary>
    public string KeyartMoviesNamingMode { get; set; } = "Prefixed";

    public string KeyartMoviesTypeName { get; set; } = "keyart";

    public bool KeyartMoviesDetailEnabled { get; set; } = true;

    public bool KeyartMoviesLibraryEnabled { get; set; } = true;

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesHomeContinueWatching { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnMoviesDetailPeoplePages { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnSetsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnSetsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnSetsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnSetsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartMoviesLibraryAlsoOnSetsListsFolderMore { get; set; }

    // --- TV shows (always the series' main level) ---

    public string KeyartTvShowsTypeName { get; set; } = "keyart";

    public bool KeyartTvShowsDetailEnabled { get; set; } = true;

    public bool KeyartTvShowsLibraryEnabled { get; set; } = true;

    // "Show also on" - the areas outside the library grid where the library tile is allowed, per item kind. All off by default.
    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartTvShowsLibraryAlsoOnShowsFavorites { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartTvShowsLibraryAlsoOnShowsSearch { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartTvShowsLibraryAlsoOnShowsHomeRecentlyAdded { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartTvShowsLibraryAlsoOnShowsListsGenre { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartTvShowsLibraryAlsoOnShowsListsStudio { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartTvShowsLibraryAlsoOnShowsListsTag { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartTvShowsLibraryAlsoOnShowsListsFolderMore { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartTvShowsLibraryAlsoOnShowsDetailMoreLikeThis { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartTvShowsLibraryAlsoOnShowsDetailSetMembers { get; set; }

    /// <summary>Also show the library tile on this area for this item kind. Default off.</summary>
    public bool KeyartTvShowsLibraryAlsoOnShowsDetailPeoplePages { get; set; }

    // ----- Keyart logo overlay, detail pages (separate per view).
    /// <summary>Jellyfin's Logo image drawn over the keyart on detail pages.</summary>
    public bool KeyartDetailLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int KeyartDetailLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int KeyartDetailLogoSizePercent { get; set; } = 60;

    // ----- Keyart logo overlay, library views (separate per view).
    /// <summary>Jellyfin's Logo image drawn over the keyart on library views.</summary>
    public bool KeyartLibraryLogoEnabled { get; set; } = false;

    /// <summary>Logo centre from the top of the poster box, 0-100 %.</summary>
    public int KeyartLibraryLogoVerticalPositionPercent { get; set; } = 87;

    /// <summary>Logo width as a percentage of the poster box width.</summary>
    public int KeyartLibraryLogoSizePercent { get; set; } = 60;

    // --- Optional logo overlay ---
    // A separate on/off, not implied by KeyartEnabled. Draws Jellyfin's
    // native Logo image (ImageType.Logo) centred over the Keyart image,
    // positioned in percentages of the poster box's own dimensions (not
    // the viewport) so it stays pinned to the poster across any
    // resize/fullscreen - unlike Characterart's free positioning. The logo
    // is fetched through Jellyfin's image API (apiClient.getScaledImageUrl
    // with type:'Logo'); no file convention of this plugin is involved.

    // ───────────────────────── Red Carpet tab ─────────────────────────
    // A different storage structure from all other feature blocks - one
    // global, shared folder instead of per-item, matched exactly by
    // Person.Name (no naming-pattern field needed). Deliberately minimal
    // settings.

    /// <summary>
    /// Name of the subfolder inside IServerApplicationPaths.
    /// InternalMetadataPath - chosen with a space, identical
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

    /// <summary>On the person's filmography list page (Episode). There is no separate "Season" type.</summary>
    public bool RedCarpetShowOnEpisodes { get; set; } = true;

    /// <summary>"BottomLeft" or "BottomRight" - like Characterart Position 3/4, scrolls normally, not fixed to the window.</summary>
    public string RedCarpetPosition { get; set; } = "BottomRight";

    /// <summary>
    /// Same system as Characterart's per-position sizing
    /// (see the comment there) - ScaleMode/Height or Width/an
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

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw.
    public double RedCarpetBottomLeftFullscreenOffsetVw { get; set; }

    public string RedCarpetBottomRightScaleMode { get; set; } = "Height";

    public double RedCarpetBottomRightHeightVh { get; set; } = 45;

    public double RedCarpetBottomRightMaxWidthVw { get; set; } = 45;

    public double RedCarpetBottomRightWidthVw { get; set; } = 10.5;

    public double RedCarpetBottomRightMaxHeightVh { get; set; }

    public string RedCarpetBottomRightHorizontalAlign { get; set; } = "Right";

    public double RedCarpetBottomRightOffsetVw { get; set; } = -5;

    // Per-position fullscreen offset - see CharacterartMoviesTopRightFullscreenOffsetVw.
    public double RedCarpetBottomRightFullscreenOffsetVw { get; set; }

    // ─────────────────────── People Backdrops ─────────────────────────
    // An independent feature in the Backdrops tab (it shares the
    // Backdrops script with Detail View Backdrops), with its own storage,
    // display logic and settings. Its master is BackdropsTabEnabled (the
    // tab switch, not Detail View Backdrops' BackdropsEnabled); below that
    // come PeopleBackdropsEnabled and the four ShowOn fields.
    // Images themselves are never stored locally - only their
    // Wallpapers.com URLs, in a small backdrops.json file placed
    // directly in each person's own real Jellyfin metadata folder
    // (InternalMetadataPath/People/<Letter>/<Name>/backdrops.json) -
    // see PeopleBackdropsController's doc comment for the population flow.

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
    /// to a low value (not the population flow's maximum) so a fresh
    /// install reaches the target quickly while still exercising the
    /// multi-image rotation.
    /// </summary>
    public int PeopleBackdropsMaxImages { get; set; } = 10;

    /// <summary>
    /// Strict/aggressive by design - any detected text region, however
    /// faint, causes a candidate image to be rejected. See
    /// PeopleBackdropsTextDetector's own doc comment for the detection
    /// approach used (a classical, dependency-free image-processing
    /// heuristic - not a neural network - deliberately tuned as a
    /// coarse "shield", not a precise scene-text detector).
    /// </summary>
    public bool PeopleBackdropsTextFilterEnabled { get; set; } = true;

    /// <summary>
    /// Feature-level switch for People Backdrops, like every other
    /// Backdrops category.
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

    // The fields below mirror Detail View Backdrops' rotation settings
    // (same types, same defaults). See BackdropsCycleTimeMs/
    // BackdropsOrderMode/etc. for what each one does.
    public int PeopleBackdropsCycleTimeMs { get; set; } = 10000;

    public string PeopleBackdropsOrderMode { get; set; } = "Shuffle";
    public bool PeopleBackdropsRandomStart { get; set; }

    public bool PeopleBackdropsKenBurnsEnabled { get; set; } = true;

    public int PeopleBackdropsKenBurnsZoomMs { get; set; } = 20000;

    public int PeopleBackdropsKenBurnsPanMs { get; set; } = 10000;

    /// <summary>
    /// Source of People Backdrops on a person's pages. "WallpapersCom" =
    /// cached Wallpapers.com images; "Appearances" = backdrops of the
    /// person's own movies/shows, delivered over the same NDJSON streaming
    /// protocol so the client is the same - only the URL source differs.
    /// "Folder" = files in the person's metadata folder. Mutually exclusive,
    /// never a mixed pool (same as Favorites People).
    /// </summary>
    public string PeopleBackdropsSourceMode { get; set; } = "WallpapersCom";

    /// <summary>
    /// Only relevant when PeopleBackdropsSourceMode is "Appearances".
    /// </summary>
    public string PeopleBackdropsAppearancesFilter { get; set; } = "MoviesAndSeries";

    /// <summary>
    /// Same "Order" label as PeopleBackdropsOrderMode (Wallpapers.com), but
    /// a separate field: real Jellyfin sort fields in native ItemSortBy enum
    /// order rather than alphabetical (unlike Genre/Tag/Favorites). Never
    /// visible together with OrderMode, since each belongs to its own
    /// source. Only relevant when PeopleBackdropsSourceMode is "Appearances".
    /// </summary>
    public string PeopleBackdropsAppearancesSortMode { get; set; } = "Shuffle";

    /// <summary>Traversal for the Appearances Order, same semantics as BackdropsGenreTraversalMode.</summary>
    public string PeopleBackdropsAppearancesTraversalMode { get; set; } = "BeginAscending";
    public bool PeopleBackdropsAppearancesRandomStart { get; set; }

    /// <summary>
    /// "Main" (the file without a number) or "All" (a random one of all
    /// allowed backdrops of the title), like Genre/Tag/Favorites'
    /// "Backdrops per item". Only relevant when PeopleBackdropsSourceMode
    /// is "Appearances".
    /// </summary>
    public string PeopleBackdropsAppearancesMainOnly { get; set; } = "Main";

    /// <summary>Base name of the person-folder files, default "backdrop".</summary>
    public string PeopleBackdropsFolderBaseName { get; set; } = "backdrop";

    /// <summary>
    /// "Single" looks for exactly one "&lt;base name&gt;.&lt;ext&gt;" in the
    /// person's folder; "Multiple" looks for the numbered
    /// "&lt;base name&gt;1.&lt;ext&gt;".."&lt;base name&gt;20.&lt;ext&gt;" instead - the
    /// two file sets deliberately do not overlap (see
    /// ResolveFolderBackdropPaths in PeopleBackdropsController.cs). Only
    /// relevant when PeopleBackdropsSourceMode is "Folder".
    /// </summary>
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
    // A different kind of feature from the others - no file matching, but
    // an override of Jellyfin's native backdrop rotation. There is no
    // browser or vanilla-setting gate: the admin page shows a hint while a
    // vanilla backdrop setting is still on (its backdrops load unseen), and
    // nothing is forced or written.

    /// <summary>
    /// Our own cycle time in ms instead of the natively hardcoded 24000.
    /// Deliberately without an artificial upper/lower bound.
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
    /// easing curve are fixed; only the two duration values below are
    /// configurable.
    /// </summary>
    public bool BackdropsKenBurnsEnabled { get; set; } = true;

    /// <summary>
    /// Only relevant when BackdropsKenBurnsEnabled is true. Duration (ms)
    /// of ONE direction of the zoom's back-and-forth cycle (the
    /// client's own animation runs it with direction:'alternate', so a
    /// full there-and-back cycle takes twice this).
    /// </summary>
    public int BackdropsKenBurnsZoomMs { get; set; } = 20000;

    /// <summary>
    /// Only relevant when BackdropsKenBurnsEnabled is true. Same as
    /// BackdropsKenBurnsZoomMs, for the pan's own back-and-forth cycle -
    /// independent of the zoom duration. At the defaults (half the zoom
    /// duration) two pan cycles run per zoom cycle, but nothing derives
    /// one value from the other.
    /// </summary>
    public int BackdropsKenBurnsPanMs { get; set; } = 10000;

    // ───────────── Backdrops tab: Detail View Manage ─────────────
    // "General" = every type uses the shared rows above (default);
    // "Individual" = each type's Settings decides: General (the shared rows),
    // Own (its own six rows below) or - Seasons/Episodes only - TvShows (the
    // TV shows type's effective settings, so series -> season does not
    // switch). Resolved on the server (BackdropsController.EffectiveDetailSettings).

    /// <summary>"General" or "Individual".</summary>
    public string BackdropsManageMode { get; set; } = "General";

    /// <summary>Movies - "General" / "Own"; the six rows below are used for "Own".</summary>
    public string BackdropsDetailMoviesSettings { get; set; } = "General";

    public int BackdropsDetailMoviesCycleTimeMs { get; set; } = 10000;

    public bool BackdropsDetailMoviesKenBurnsEnabled { get; set; } = true;

    public int BackdropsDetailMoviesKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsDetailMoviesKenBurnsPanMs { get; set; } = 10000;

    public string BackdropsDetailMoviesOrderMode { get; set; } = "Shuffle";

    public bool BackdropsDetailMoviesRandomStart { get; set; }

    /// <summary>Sets - "General" / "Own"; the six rows below are used for "Own".</summary>
    public string BackdropsDetailSetsSettings { get; set; } = "General";

    public int BackdropsDetailSetsCycleTimeMs { get; set; } = 10000;

    public bool BackdropsDetailSetsKenBurnsEnabled { get; set; } = true;

    public int BackdropsDetailSetsKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsDetailSetsKenBurnsPanMs { get; set; } = 10000;

    public string BackdropsDetailSetsOrderMode { get; set; } = "Shuffle";

    public bool BackdropsDetailSetsRandomStart { get; set; }

    /// <summary>TV shows - "General" / "Own"; the six rows below are used for "Own".</summary>
    public string BackdropsDetailTvShowsSettings { get; set; } = "General";

    public int BackdropsDetailTvShowsCycleTimeMs { get; set; } = 10000;

    public bool BackdropsDetailTvShowsKenBurnsEnabled { get; set; } = true;

    public int BackdropsDetailTvShowsKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsDetailTvShowsKenBurnsPanMs { get; set; } = 10000;

    public string BackdropsDetailTvShowsOrderMode { get; set; } = "Shuffle";

    public bool BackdropsDetailTvShowsRandomStart { get; set; }

    /// <summary>Seasons - "General" / "Own" / "TvShows"; the six rows below are used for "Own".</summary>
    public string BackdropsDetailSeasonsSettings { get; set; } = "General";

    public int BackdropsDetailSeasonsCycleTimeMs { get; set; } = 10000;

    public bool BackdropsDetailSeasonsKenBurnsEnabled { get; set; } = true;

    public int BackdropsDetailSeasonsKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsDetailSeasonsKenBurnsPanMs { get; set; } = 10000;

    public string BackdropsDetailSeasonsOrderMode { get; set; } = "Shuffle";

    public bool BackdropsDetailSeasonsRandomStart { get; set; }

    /// <summary>Episodes - "General" / "Own" / "TvShows"; the six rows below are used for "Own".</summary>
    public string BackdropsDetailEpisodesSettings { get; set; } = "General";

    public int BackdropsDetailEpisodesCycleTimeMs { get; set; } = 10000;

    public bool BackdropsDetailEpisodesKenBurnsEnabled { get; set; } = true;

    public int BackdropsDetailEpisodesKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsDetailEpisodesKenBurnsPanMs { get; set; } = 10000;

    public string BackdropsDetailEpisodesOrderMode { get; set; } = "Shuffle";

    public bool BackdropsDetailEpisodesRandomStart { get; set; }

    /// <summary>Videos - "General" / "Own"; the six rows below are used for "Own".</summary>
    public string BackdropsDetailVideosSettings { get; set; } = "General";

    public int BackdropsDetailVideosCycleTimeMs { get; set; } = 10000;

    public bool BackdropsDetailVideosKenBurnsEnabled { get; set; } = true;

    public int BackdropsDetailVideosKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsDetailVideosKenBurnsPanMs { get; set; } = 10000;

    public string BackdropsDetailVideosOrderMode { get; set; } = "Shuffle";

    public bool BackdropsDetailVideosRandomStart { get; set; }

    /// <summary>Games (Playnite Bridge) - "General" / "Own"; the six rows below are used for "Own".</summary>
    public string BackdropsDetailGamesSettings { get; set; } = "General";

    public int BackdropsDetailGamesCycleTimeMs { get; set; } = 10000;

    public bool BackdropsDetailGamesKenBurnsEnabled { get; set; } = true;

    public int BackdropsDetailGamesKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsDetailGamesKenBurnsPanMs { get; set; } = 10000;

    public string BackdropsDetailGamesOrderMode { get; set; } = "Shuffle";

    public bool BackdropsDetailGamesRandomStart { get; set; }

    // ───────────── Backdrops tab: Set backdrops override ─────────────
    // Off (default) = the set's own backdrops through the Detail View
    // chain. On, with its defaults = Jellyfin vanilla (own backdrops, all,
    // index order). The server builds the finished order once per visit.

    /// <summary>Switches the Set block on (Show on Sets must be on).</summary>
    public bool BackdropsSetOverrideEnabled { get; set; }

    /// <summary>"Set" / "Movies" / "SetThenMovies" / "Mixed" (Mixed = one flat list, always Shuffle).</summary>
    public string BackdropsSetSourceMode { get; set; } = "Set";

    /// <summary>"Single" (the main backdrop; a random allowed one when its format is not allowed) / "Multiple" (all).</summary>
    public string BackdropsSetImages { get; set; } = "Multiple";

    /// <summary>Order of the set's own images - "Sequential" / "Shuffle" / "Random" (Multiple only).</summary>
    public string BackdropsSetImageOrderMode { get; set; } = "Sequential";

    /// <summary>"Single" / "Multiple" per member title; Multiple runs one title after another.</summary>
    public string BackdropsSetMovieImages { get; set; } = "Single";

    /// <summary>Order of the images inside one member title (Multiple only).</summary>
    public string BackdropsSetMovieImageOrderMode { get; set; } = "Sequential";

    /// <summary>Order of the member titles - "Ascending" / "Descending" (release date, Jellyfin's rule) / "Shuffle" / "Random" (with repeats, each drawn title as one block). Values as Extraposter's Set order.</summary>
    public string BackdropsSetMovieOrder { get; set; } = "Ascending";

    /// <summary>Sorted Movie order only - start at a random title and continue in order.</summary>
    public bool BackdropsSetMovieRandomStart { get; set; }

    // ───────────── Backdrops tab: Game collections ─────────────
    // Playnite Bridge's collection pages. Values and defaults are the same as Playnite Bridge's own,
    // so both plugins offer the same function; the server builds the finished order once per visit, as for a Set.

    public string BackdropsDetailGameCollectionsSettings { get; set; } = "General";

    public int BackdropsDetailGameCollectionsCycleTimeMs { get; set; } = 10000;

    public bool BackdropsDetailGameCollectionsKenBurnsEnabled { get; set; } = true;

    public int BackdropsDetailGameCollectionsKenBurnsZoomMs { get; set; } = 20000;

    public int BackdropsDetailGameCollectionsKenBurnsPanMs { get; set; } = 10000;

    /// <summary>"Own" / "Games" / "OwnThenGames" / "Mixed" (Mixed = one flat list, always Shuffle).</summary>
    public string BackdropsGameCollectionSource { get; set; } = "Games";

    /// <summary>"Single" (the first own picture) / "Multiple" (all).</summary>
    public string BackdropsGameCollectionOwnImages { get; set; } = "Multiple";

    /// <summary>Order of the own pictures - "Sequential" / "Shuffle" / "Random" (Multiple only).</summary>
    public string BackdropsGameCollectionOwnImageOrder { get; set; } = "Sequential";

    /// <summary>"Single" / "Multiple" per game; Multiple runs one game after another.</summary>
    public string BackdropsGameCollectionGameImages { get; set; } = "Single";

    /// <summary>Order of the images inside one game (Multiple only).</summary>
    public string BackdropsGameCollectionGameImageOrder { get; set; } = "Sequential";

    /// <summary>Order of the games - "ReleaseAscending" / "ReleaseDescending" / "Shuffle" / "Random" (with repeats, each drawn game as one block).</summary>
    public string BackdropsGameCollectionGameOrder { get; set; } = "ReleaseAscending";

    /// <summary>Sorted Game order only - start at a random game and continue in order.</summary>
    public bool BackdropsGameCollectionRandomStart { get; set; } = true;


    // ───────────── Backdrops tab: Library View Backdrops ─────────────
    // Replica of Jellyfin's own random library backdrops (scripts/
    // autoBackdrops.js: 20 items with a backdrop, SortBy
    // IsFavoriteOrLiked,Random, per library or - on Home - across all
    // libraries with a PG-13 cap), rendered by this plugin through the same
    // transition bus as the other six categories. Vanilla's "Backdrops"
    // display setting is neither read nor written (the admin page only shows
    // a hint while it is still on); its container is hidden while ours
    // shows, like Detail View does on detail pages.

    /// <summary>Category switch. Off = Jellyfin's own backdrop settings apply unchanged.</summary>
    public bool BackdropsLibraryEnabled { get; set; } = true;

    /// <summary>Show on (vanilla): the pages vanilla's own setting covers. Home includes its Favourites tab.</summary>
    public bool BackdropsLibraryShowOnHome { get; set; } = true;
    public bool BackdropsLibraryShowOnMovies { get; set; } = true;
    public bool BackdropsLibraryShowOnTvShows { get; set; } = true;
    public bool BackdropsLibraryShowOnMusic { get; set; } = true;

    /// <summary>Games: the page of Playnite Bridge's games library (a movies library in Jellyfin) - own box, Movies then means real movie libraries only. Default false like the Detail View's Games box.</summary>
    public bool BackdropsLibraryShowOnGames { get; set; }

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
    // Physical disc-case artwork placed over the poster on detail pages
    // only (Movies, BoxSets/Collections, Series main level - not
    // Season/Episode). Applies over whatever is in the poster slot,
    // regardless of which artwork type won it.
    // Master switch is CaseModEnabled (General tab).
    // ---- Poster size -------------------------------
    // Scales the detail-page poster itself. Deliberately INDEPENDENT of
    // CaseModEnabled and of Show on: it serves a smaller poster without
    // any case, and it reaches kinds a case never appears on at all. So
    // the admin page must not grey it together with the case.
    //
    // The 2D case follows, because the client re-maps the case box with
    // the same transform it measured on the poster - the case has no
    // size of its own, its box is fixed vw/% geometry (see
    // CaseModController's own per-type tune values). The Three.js case
    // is unaffected: it has its own CaseModThreejsCaseSize.
    //
    // Kinds: Movies/Sets and Series/Seasons/Episodes are the named
    // ones; Videos is the CATCH-ALL for everything else (Movie, Episode,
    // then "video" for all the rest).

    /// <summary>Master switch for the poster-size override. Off by default - 100 % everywhere is what Jellyfin draws.</summary>
    public bool CaseModPosterSizeEnabled { get; set; }

    /// <summary>"General" (one size for every kind) or "Individual" (each kind its own). Same vocabulary as LogoArt's own Settings dropdowns.</summary>
    public string CaseModPosterSizeMode { get; set; } = "General";

    /// <summary>The one size used when Mode is "General". Percent of the normal poster size.</summary>
    public int CaseModPosterSizeAll { get; set; } = 100;

    /// <summary>Percent of the normal poster size on movie pages.</summary>
    public int CaseModPosterSizeMovies { get; set; } = 100;

    /// <summary>Percent of the normal poster size on set pages.</summary>
    public int CaseModPosterSizeSets { get; set; } = 100;

    /// <summary>Percent of the normal poster size on series pages.</summary>
    public int CaseModPosterSizeSeries { get; set; } = 100;

    /// <summary>Percent of the normal poster size on season pages.</summary>
    public int CaseModPosterSizeSeasons { get; set; } = 100;

    /// <summary>Percent of the normal poster size on episode pages.</summary>
    public int CaseModPosterSizeEpisodes { get; set; } = 100;

    /// <summary>Percent of the normal poster size on game pages (Playnite Bridge's virtual games).</summary>
    public int CaseModPosterSizeGames { get; set; } = 100;

    /// <summary>Percent of the normal poster size on every kind not named above - home videos, music videos, and anything else with a detail-page poster.</summary>
    public int CaseModPosterSizeVideos { get; set; } = 100;

    // ---- Poster size: the anchor ----------------------
    // Where the SHRUNKEN poster sits inside the footprint it had at 100 %.
    // "Default" means: leave Jellyfin's own anchor alone - and that anchor
    // differs per layout (desktop top-left, TV left and vertically centred,
    // mobile bottom-left), which is exactly why it cannot be expressed as one
    // of the nine grid positions and needs an entry of its own.
    //
    // One dropdown per kind rather than two (horizontal + vertical): nine
    // combinations plus Default fit in one list, and two dropdowns would
    // double the rows and allow states like "horizontal default, vertical
    // centred" that are hard to explain.
    //
    // Only meaningful below 100 %: at 100 the poster fills its own footprint
    // and there is nothing to place. The admin menu greys the row accordingly.

    /// <summary>"Default", or one of TopLeft/TopCenter/TopRight/CenterLeft/Center/CenterRight/BottomLeft/BottomCenter/BottomRight.</summary>
    public string CaseModPosterSizeAnchorAll { get; set; } = "Default";

    /// <summary>The anchor on movie pages. See CaseModPosterSizeAnchorAll.</summary>
    public string CaseModPosterSizeAnchorMovies { get; set; } = "Default";

    /// <summary>The anchor on set pages. See CaseModPosterSizeAnchorAll.</summary>
    public string CaseModPosterSizeAnchorSets { get; set; } = "Default";

    /// <summary>The anchor on series pages. See CaseModPosterSizeAnchorAll.</summary>
    public string CaseModPosterSizeAnchorSeries { get; set; } = "Default";

    /// <summary>The anchor on season pages. See CaseModPosterSizeAnchorAll.</summary>
    public string CaseModPosterSizeAnchorSeasons { get; set; } = "Default";

    /// <summary>The anchor on episode pages. See CaseModPosterSizeAnchorAll.</summary>
    public string CaseModPosterSizeAnchorEpisodes { get; set; } = "Default";

    /// <summary>The anchor on game pages. See CaseModPosterSizeAnchorAll.</summary>
    public string CaseModPosterSizeAnchorGames { get; set; } = "Default";

    /// <summary>The anchor on every kind not named above. See CaseModPosterSizeAnchorAll.</summary>
    public string CaseModPosterSizeAnchorVideos { get; set; } = "Default";

    /// <summary>
    /// Where the Three.js case's cover window sits inside the poster box.
    /// Same ten values as the flat case's anchor, and deliberately its OWN
    /// setting: the Three.js case is a separate case kind with its own size,
    /// and it exists for movies only, so one value is enough. NOT tied to
    /// Poster size - its anchor matters at 100 % too, because the cover window
    /// can be smaller than the box whenever Case size is below 100.
    /// </summary>
    public string CaseModThreejsCaseAnchor { get; set; } = "Default";

    public bool CaseModShowOnMovies { get; set; } = true;

    public bool CaseModShowOnSets { get; set; } = true;

    public bool CaseModShowOnTvShows { get; set; } = true;

    /// <summary>
    /// One of "vivaelitecases", "clearcases", "vortexcases" - matches the
    /// CaseTextures/ subfolder names exactly (see ArtworkPlus.csproj's
    /// Content-Include entry). A single global choice, not
    /// per-library/per-item: the per-case-type adjustment values only
    /// make sense against one active choice at a time.
    /// </summary>
    public string CaseModType { get; set; } = "vivaelitecases";

    /// <summary>
    /// The Three.js Case (a real 3D model in a WebGL renderer, texture
    /// folder CaseTextures/threejscases) for MOVIES only.
    /// Deliberately not a value of CaseModType: the three Show-on boxes share
    /// one merged row, so a movies-only dropdown value would need per-checkbox
    /// greying, and sets / TV shows would lose the other case types. As an own
    /// switch it simply overrides CaseModType for movies while sets and TV
    /// shows keep following the dropdown. Default off.
    /// </summary>
    public bool CaseModThreejsEnabled { get; set; } = false;

    // --- Three.js Case settings, in the admin page's order: first how the
    //     case stands when the page opens, then its color, then what is
    //     printed on it, then what happens over time or on a gesture.

    /// <summary>
    /// Whether the mouse wheel resizes the case while the pointer is over it.
    /// Default on.
    /// </summary>
    public bool CaseModThreejsZoomEnabled { get; set; } = true;

    /// <summary>
    /// How far the wheel may take the case from <see cref="CaseModThreejsCaseSize"/>,
    /// in percent, the same amount in both directions: 33 means down to two
    /// thirds and up to four thirds. 0 is allowed and means the wheel does
    /// nothing - the same effect as the switch being off, deliberately kept as
    /// a settable value rather than silently unticking the switch.
    /// The canvas is built for the upper end, so a large range costs fill rate
    /// even while the case sits at its resting size.
    /// </summary>
    public double CaseModThreejsZoomRange { get; set; } = 33;

    /// <summary>
    /// Where the case stands in the page's stacking order.
    /// "InFront" touches nothing: the canvas simply paints above the detail
    /// page, as any overlay would. "BehindText" puts the case between the
    /// page's dark tint and the page's own text, which the browser cannot do
    /// by z-index alone - the tint is the BACKGROUND of the very containers
    /// that carry the text, and nothing can paint between an element's
    /// background and its own content. The client moves the tint onto a layer
    /// of its own (a pseudo-element, so it keeps its geometry and cannot
    /// drift) and drops the case in between.
    /// Default "BehindText": the whole Three.js case already sits behind its
    /// own switch, which is off by default, and a case that covers the film's
    /// title is not what anyone turns it on for.
    /// </summary>
    public string CaseModThreejsCaseLayer { get; set; } = "BehindText";

    /// <summary>
    /// Size of the FRONT COVER, seen straight on, as a percentage of the
    /// vanilla poster's width (100 = exactly as wide as the poster).
    /// Deliberately defined straight-on and on the WIDTH: the case is
    /// proportionally wider than a 2:3 poster (135 x 171.5 mm = 0.787 against
    /// 0.667), horizontal space is the scarce one next to the detail text,
    /// and a definition that depended on the turn angle would couple size to
    /// rotation, a coupling that causes geometry bugs.
    /// Default 80: large enough to read the artwork, with room left for the
    /// lid to swing open.
    /// </summary>
    public double CaseModThreejsCaseSize { get; set; } = 80;

    /// <summary>
    /// Resting pose when the page opens - how far the case is turned to the
    /// side, in degrees. 31.5 is the renderer's fitted default
    /// (orbit.theta 0.55 rad). A turn is needed at all because the
    /// spine carries the movie logo, the studio logo, the format mark and the
    /// code - straight on, none of them is visible.
    /// </summary>
    public double CaseModThreejsCaseTurn { get; set; } = 320;

    /// <summary>
    /// Resting pose - how far the case leans back, in degrees. 12.7 =
    /// the renderer's orbit.phi 1.35 rad measured from the vertical.
    /// </summary>
    public double CaseModThreejsCaseTilt { get; set; } = 5;

    /// <summary>
    /// The automatic turn, as one field: "Off", "Left" or "Right".
    /// One setting rather than a switch plus a direction -
    /// a direction already says whether it turns, and a separate switch only
    /// adds a state where the two disagree. Default "Off".
    /// The client also receives a plain `AutoRotate` boolean, which the
    /// controller derives from this one value, so the renderer never sees a
    /// third state.
    /// </summary>
    public string CaseModThreejsAutoRotateDirection { get; set; } = "Off";

    /// <summary>
    /// How fast the automatic turn goes, as a name rather than a number:
    /// "VerySlow" 0.5, "Slow" 1, "Medium" 2, "Fast" 3, "VeryFast" 4 turns per
    /// minute. The client turns that into radians per SECOND and multiplies it
    /// by the real time between frames, so the speed is the same on a 60 Hz and
    /// a 144 Hz screen.
    /// Default "Medium": 2 turns a minute.
    /// </summary>
    public string CaseModThreejsRotateSpeed { get; set; } = "Medium";

    /// <summary>
    /// Whether a double click puts the case back to the state the settings
    /// describe - pose, size and the automatic turn. Default on; it is the only
    /// way back once the case has been touched, because touching it ends the
    /// automatic turn for good.
    /// Off is not just "nothing happens on a double click": with the reset off,
    /// a single click no longer has to wait to see whether a second one is
    /// coming, so the case opens the instant the button comes up.
    /// </summary>
    public bool CaseModThreejsResetOnDoubleClick { get; set; } = true;

    /// <summary>
    /// "Original" (the model color - black DVD, blue Blu-ray, black 4K),
    /// "FullShell" (the case color blend on the whole case) or
    /// "BackSpine" (the blend on back and spine only, plastic stays).
    /// The renderer implements BackSpine for the Blu-ray shell only
    /// (onlyBack &amp;&amp; M.name === 'bluray'), so on a DVD it behaves like
    /// FullShell.
    /// </summary>
    public string CaseModThreejsColorModeDvd { get; set; } = "Original";

    /// <summary>See <see cref="CaseModThreejsColorModeDvd"/>.</summary>
    public string CaseModThreejsColorModeBluRay { get; set; } = "Original";

    /// <summary>
    /// See <see cref="CaseModThreejsColorModeDvd"/>. 4K is not a third shell:
    /// it is the Blu-ray shell forced black with the UHD mark on the front
    /// band - a blue shell carrying a 4K mark does not exist in the wild.
    /// </summary>
    public string CaseModThreejsColorModeUhd { get; set; } = "Original";

    /// <summary>
    /// How the case color is derived from the front cover (Color Thief
    /// palette) when a mode other than "Original" is chosen. Seven modes:
    /// DominantDark (default), DominantColorful, Deep, MaterialYou, Accent,
    /// TopRegion, Vibrant. There is no "Off" entry - "Original" in the three
    /// fields above already is Off.
    /// </summary>
    public string CaseModThreejsColorBlend { get; set; } = "DominantDark";

    /// <summary>The printed back of the case.</summary>
    public bool CaseModThreejsBackCover { get; set; } = true;

    /// <summary>
    /// The booklet inside the lid, as one field: "Off", "Black", "BwFanart" or
    /// "BlurredFanart". Default "BwFanart".
    /// A film without fanart falls back to Black rather than losing the
    /// booklet - the opposite of the spine rule, and
    /// deliberately so: the booklet is a surface that has to be some colour,
    /// while the spine print is an addition that may simply be absent.
    /// </summary>
    public string CaseModThreejsBooklet { get; set; } = "BwFanart";

    /// <summary>
    /// The four spine elements. They form a STACK anchored at the foot
    /// (format mark at the bottom, studio logo above it, code above that);
    /// whatever is switched off - or has no match, e.g. a studio Jellyfin
    /// knows but the logo pack does not - leaves no hole, the ones above move
    /// down. A missing studio logo is NOT replaced by a stand-in: a wrong
    /// studio logo is worse than none.
    /// </summary>
    public bool CaseModThreejsSpineMovieLogo { get; set; } = true;

    /// <summary>See <see cref="CaseModThreejsSpineMovieLogo"/>.</summary>
    public bool CaseModThreejsSpineStudioLogo { get; set; } = true;

    /// <summary>See <see cref="CaseModThreejsSpineMovieLogo"/>.</summary>
    public bool CaseModThreejsSpineFormatMark { get; set; } = true;

    /// <summary>See <see cref="CaseModThreejsSpineMovieLogo"/>.</summary>
    public bool CaseModThreejsSpineCode { get; set; } = true;

    /// <summary>
    /// The two triggers that open the case. Two checkboxes give exactly
    /// four states (neither = never, either one, both).
    /// A click opens AND closes; a drag never opens, because the click is
    /// decided on release and only when the pointer never moved.
    /// </summary>
    public bool CaseModThreejsOpenAutomatic { get; set; } = true;

    /// <summary>
    /// Manual mode: a click opens the case and it stays open, the next
    /// click closes it. Mutually exclusive with
    /// CaseModThreejsOpenOnClickAutomatic - see that field.
    /// </summary>
    public bool CaseModThreejsOpenOnClick { get; set; } = false;

    /// <summary>
    /// Click-started sequence: a click plays the whole open/spin/close
    /// timeline. Its own mode (not a side effect of
    /// CaseModThreejsSpinAutomatic), the same on the flat case; mutually
    /// exclusive with CaseModThreejsOpenOnClick.
    /// </summary>
    public bool CaseModThreejsOpenOnClickAutomatic { get; set; } = false;

    /// <summary>Delay before the automatic opening, in milliseconds.</summary>
    public double CaseModThreejsOpenDelayMs { get; set; } = 5000;

    /// <summary>
    /// How far the lid swings open. 120 rather than the flat cases' 90:
    /// at 120 degrees one actually looks into the case. The base stays put,
    /// only the lid moves, and it swings away from the spine - so the side it
    /// opens to follows from the turn angle's sign, it is not a setting.
    /// </summary>
    public double CaseModThreejsOpenAngleDegrees { get; set; } = 120;

    /// <summary>
    /// Whether the disc spins for an automatic opening and/or for a click -
    /// the same two-checkbox shape as the opening itself, so the rows line up.
    /// </summary>
    public bool CaseModThreejsSpinAutomatic { get; set; } = false;

    /// <summary>
    /// The disc turns inside the CLICK-started sequence
    /// (CaseModThreejsOpenOnClickAutomatic) - the twin of
    /// CaseMod2DSpinOnClickAutomatic.
    /// </summary>
    public bool CaseModThreejsSpinOnClickAutomatic { get; set; } = false;

    /// <summary>
    /// A click on the disc itself turns it once - whenever the disc is the
    /// first thing the ray meets AND nothing else is turning it, which
    /// includes the hold phase of a sequence that does not spin.
    /// </summary>
    public bool CaseModThreejsSpinOnClick { get; set; } = false;

    /// <summary>"Left" or "Right", like the flat cases' spinning disc.</summary>
    public string CaseModThreejsSpinDirection { get; set; } = "Left";

    // --- Case mix. A layer on top of the settings above: when on, each detail
    //     page draws its case type - or No case - out of its kind's pool,
    //     and the look of that type out of its own ticked colour variants.
    //     Everything else (geometry, opening, the disc) stays with the drawn
    //     kind's own settings. Every field is additive and off/neutral by
    //     default, so an installation that never opens the block is not
    //     affected. Helpers/CaseMixConfig copies them into the draw.

    /// <summary>The block's own switch; off leaves Case type in charge.</summary>
    public bool CaseModMixEnabled { get; set; } = false;

    /// <summary>
    /// How long an item keeps its drawn case and look -
    /// "Visit" (only the one page view: its five requests must still agree, so
    /// a few seconds), "30s", "60s", "5m", "1h",
    /// "1d". A system setting: Randomize never touches it. Memory only, so a
    /// server restart forgets every draw; saving the page draws anew at once.
    /// </summary>
    public string CaseModMixNewDrawAfter { get; set; } = "60s";

    /// <summary>
    /// The No case size compensation: with a case the picture is
    /// larger by the case's frame (measured: the visible case is 104-112.5 %,
    /// mean 109.5 %, of the poster's height), so a drawn No case looks small
    /// beside it. Per kind, a tick switches the compensation on; it counts only
    /// where No case itself counts. System settings: Randomize never touches them.
    /// </summary>
    public bool CaseModMixNoCaseSizeMovies { get; set; } = false;

    /// <summary>See <see cref="CaseModMixNoCaseSizeMovies"/>.</summary>
    public bool CaseModMixNoCaseSizeSets { get; set; } = false;

    /// <summary>See <see cref="CaseModMixNoCaseSizeMovies"/>.</summary>
    public bool CaseModMixNoCaseSizeTvShows { get; set; } = false;

    /// <summary>
    /// Percent of the poster's CURRENT size (Poster size included) when No
    /// case is drawn, 50-150; 108 by default - a little under the measured mean,
    /// because with the anchor at the bottom the poster grows upward only.
    /// </summary>
    public int CaseModMixNoCaseSize { get; set; } = 108;

    /// <summary>
    /// The side that stays while the No case poster grows - the ten anchors of
    /// Poster size; "BottomCenter" by default (the poster grows upward,
    /// where most cases carry their top band).
    /// </summary>
    public string CaseModMixNoCaseAnchor { get; set; } = "BottomCenter";

    /// <summary>
    /// The Movies pool: which types are drawn on movie pages. An empty pool
    /// leaves movies to the settings above. Three.js counts only while the
    /// Three.js Case is on; No case draws no case at all.
    /// </summary>
    public bool CaseModMixMoviesClear { get; set; } = false;

    /// <summary>See <see cref="CaseModMixMoviesClear"/>.</summary>
    public bool CaseModMixMoviesVortex { get; set; } = false;

    /// <summary>See <see cref="CaseModMixMoviesClear"/>.</summary>
    public bool CaseModMixMoviesVivaElite { get; set; } = false;

    /// <summary>See <see cref="CaseModMixMoviesClear"/>.</summary>
    public bool CaseModMixMoviesVivaElite3d { get; set; } = false;

    /// <summary>See <see cref="CaseModMixMoviesClear"/>. Movies only - the server serves the Three.js case for nothing else.</summary>
    public bool CaseModMixMoviesThreejs { get; set; } = false;

    /// <summary>See <see cref="CaseModMixMoviesClear"/>.</summary>
    public bool CaseModMixMoviesNoCase { get; set; } = false;

    /// <summary>The Sets pool, separate from the Movies pool; no Three.js.</summary>
    public bool CaseModMixSetsClear { get; set; } = false;

    /// <summary>See <see cref="CaseModMixSetsClear"/>.</summary>
    public bool CaseModMixSetsVortex { get; set; } = false;

    /// <summary>See <see cref="CaseModMixSetsClear"/>.</summary>
    public bool CaseModMixSetsVivaElite { get; set; } = false;

    /// <summary>See <see cref="CaseModMixSetsClear"/>.</summary>
    public bool CaseModMixSetsVivaElite3d { get; set; } = false;

    /// <summary>See <see cref="CaseModMixSetsClear"/>.</summary>
    public bool CaseModMixSetsNoCase { get; set; } = false;

    /// <summary>The TV shows pool (series main pages); no Three.js.</summary>
    public bool CaseModMixTvShowsClear { get; set; } = false;

    /// <summary>See <see cref="CaseModMixTvShowsClear"/>.</summary>
    public bool CaseModMixTvShowsVortex { get; set; } = false;

    /// <summary>See <see cref="CaseModMixTvShowsClear"/>.</summary>
    public bool CaseModMixTvShowsVivaElite { get; set; } = false;

    /// <summary>See <see cref="CaseModMixTvShowsClear"/>.</summary>
    public bool CaseModMixTvShowsVivaElite3d { get; set; } = false;

    /// <summary>See <see cref="CaseModMixTvShowsClear"/>.</summary>
    public bool CaseModMixTvShowsNoCase { get; set; } = false;

    /// <summary>
    /// Poster chain while a CASE is drawn: which slots may deliver. A tick
    /// switches a whole slot (Postercase/Keyart, Animated Poster/Keyart,
    /// Extraposter/Extrakeyart); which variant comes stays with that
    /// feature's own tab. It can only suppress, never enable. Applied only
    /// while No case is in some pool - the rows are greyed otherwise.
    /// </summary>
    public bool CaseModMixChainCasesCustomPoster { get; set; } = true;

    /// <summary>See <see cref="CaseModMixChainCasesCustomPoster"/>.</summary>
    public bool CaseModMixChainCasesAnimatedPoster { get; set; } = true;

    /// <summary>See <see cref="CaseModMixChainCasesCustomPoster"/>.</summary>
    public bool CaseModMixChainCasesExtraposter { get; set; } = true;

    /// <summary>
    /// Poster chain while No case is drawn. Postercase/Keyart off by
    /// default: a Postercase image is a title-only poster made FOR a case.
    /// </summary>
    public bool CaseModMixChainNoCaseCustomPoster { get; set; } = false;

    /// <summary>See <see cref="CaseModMixChainNoCaseCustomPoster"/>.</summary>
    public bool CaseModMixChainNoCaseAnimatedPoster { get; set; } = true;

    /// <summary>See <see cref="CaseModMixChainNoCaseCustomPoster"/>.</summary>
    public bool CaseModMixChainNoCaseExtraposter { get; set; } = true;

    /// <summary>
    /// The flat types' colour variants in the mix: the ticked ones are drawn
    /// per item. A forced choice - the page never lets a row go empty; a
    /// type whose row is empty anyway is not drawn.
    /// </summary>
    public bool CaseModMixColorClearOriginal { get; set; } = true;

    /// <summary>See <see cref="CaseModMixColorClearOriginal"/>.</summary>
    public bool CaseModMixColorClearFullShell { get; set; } = false;

    /// <summary>See <see cref="CaseModMixColorClearOriginal"/>.</summary>
    public bool CaseModMixColorVortexOriginal { get; set; } = true;

    /// <summary>See <see cref="CaseModMixColorClearOriginal"/>.</summary>
    public bool CaseModMixColorVortexFullShell { get; set; } = false;

    /// <summary>See <see cref="CaseModMixColorClearOriginal"/>.</summary>
    public bool CaseModMixColorVivaEliteOriginal { get; set; } = true;

    /// <summary>See <see cref="CaseModMixColorClearOriginal"/>.</summary>
    public bool CaseModMixColorVivaEliteFullShell { get; set; } = false;

    /// <summary>See <see cref="CaseModMixColorClearOriginal"/>.</summary>
    public bool CaseModMixColorVivaElite3dOriginal { get; set; } = true;

    /// <summary>See <see cref="CaseModMixColorClearOriginal"/>.</summary>
    public bool CaseModMixColorVivaElite3dFullShell { get; set; } = false;

    /// <summary>Each flat type's own blend in the mix; the same seven as CaseModColorBlend.</summary>
    public string CaseModMixBlendClear { get; set; } = "DominantDark";

    /// <summary>See <see cref="CaseModMixBlendClear"/>.</summary>
    public string CaseModMixBlendVortex { get; set; } = "DominantDark";

    /// <summary>See <see cref="CaseModMixBlendClear"/>.</summary>
    public string CaseModMixBlendVivaElite { get; set; } = "DominantDark";

    /// <summary>See <see cref="CaseModMixBlendClear"/>.</summary>
    public string CaseModMixBlendVivaElite3d { get; set; } = "DominantDark";

    /// <summary>
    /// The Three.js case's colour variants in the mix, per format like
    /// CaseModThreejsColorMode*. A DVD has no Back spine (the shell renders it
    /// as Full Shell), so its row has two.
    /// </summary>
    public bool CaseModMixColorThreejsDvdOriginal { get; set; } = true;

    /// <summary>See <see cref="CaseModMixColorThreejsDvdOriginal"/>.</summary>
    public bool CaseModMixColorThreejsDvdFullShell { get; set; } = false;

    /// <summary>See <see cref="CaseModMixColorThreejsDvdOriginal"/>.</summary>
    public bool CaseModMixColorThreejsBluRayOriginal { get; set; } = true;

    /// <summary>See <see cref="CaseModMixColorThreejsDvdOriginal"/>.</summary>
    public bool CaseModMixColorThreejsBluRayFullShell { get; set; } = false;

    /// <summary>See <see cref="CaseModMixColorThreejsDvdOriginal"/>.</summary>
    public bool CaseModMixColorThreejsBluRayBackSpine { get; set; } = false;

    /// <summary>See <see cref="CaseModMixColorThreejsDvdOriginal"/>.</summary>
    public bool CaseModMixColorThreejsUhdOriginal { get; set; } = true;

    /// <summary>See <see cref="CaseModMixColorThreejsDvdOriginal"/>.</summary>
    public bool CaseModMixColorThreejsUhdFullShell { get; set; } = false;

    /// <summary>See <see cref="CaseModMixColorThreejsDvdOriginal"/>.</summary>
    public bool CaseModMixColorThreejsUhdBackSpine { get; set; } = false;

    /// <summary>The Three.js case's one blend in the mix, for all three formats.</summary>
    public string CaseModMixBlendThreejs { get; set; } = "DominantDark";


    // --- Per-case-type box geometry is not a config setting: the direct
    // Top/Left/Width/Height values are constants in CaseModController.cs.
    // Deliberately constants rather than config defaults: a config
    // property's default is silently overridden by any saved value in the
    // plugin's stored XML, and without an admin field such a stale value
    // would be invisible and unfixable from the UI. Unknown elements in a
    // saved XML are ignored by the deserializer.
}
