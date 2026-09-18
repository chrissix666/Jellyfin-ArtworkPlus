# ArtworkPlus — Backdrops concept

**Purpose of this file:** the single entry point for everything around Backdrops — what exists, which Fibel rules apply, how the six categories (Detail View, People, Genre, Studio, Tag, Favorites) are designed and where the implementation lives. **State: fully implemented** (server, client, admin UI, gate wiring for all six areas, Sessions 63–109). Extended whenever new decisions are made, bugs turn up or major changes become necessary.

Parts A–F describe the design as it is today. Parts G–N record the individual extensions in the order they were decided (limit/traversal, defaults, People field structure, Genre/Favorites consolidation, Folder source, format exemption, fade concept). Part O condenses the sandbox-era history (Sessions 71–86, ported for real in Sessions 97–105). Part P is the field-order reference of the whole tab.

---

## Part A — The six categories

### Detail View Backdrops (`BackdropsController.cs`, `Backdrops-v1.js`, first IIFE)
- Completely replaces Jellyfin's own native multi-backdrop rotation (switches it off via the `enableBackdrops` localStorage key, rebuilds the rotation from scratch). Detail pages only, Chrome/Chromium only (the override technique is not reliably available elsewhere).
- No file search of its own — uses exclusively the images Jellyfin already knows for the item (`BackdropImageTags`/`ParentBackdropImageTags`, i.e. `item.GetImages(ImageType.Backdrop)` — the in-memory image infos filled by the library scan, verified in Session 97).
- Settings: `CycleTimeMs`, `OrderMode` (Sequential/Shuffle/Random — Sequential: native order, Shuffle: no repeats per round, Random: repeats allowed), `KenBurnsEnabled`, `KenBurnsZoomMs`, `KenBurnsPanMs`.
- **No cache** — on every navigation to an item everything is fetched fresh (`{cache: 'no-store'}`). Sensible, because only already known, local metadata of a single item is read, no external call.
- `BackdropsAllowedFormats` is a real display gate (not a file-search filter) on the already known images, via `/Backdrops/allowed-indices?sourceId=X`. Jellyfin's `LocalImageProvider` itself only recognizes `.png .jpg .jpeg .webp .tbn .gif .svg`; the plugin filters again by the allowed-formats list (`GetAllowedIndices`).
- Show-on fields (Movies/TvShows/Seasons/Episodes/Videos, five) lie outside `BackdropsDependentFields` (deadlock avoidance, see Fibel rule 3).
- Field order deliberately differs from the pool categories (Order before Ken Burns): Detail View rotates within ONE item's own backdrops, there is no pool of several items — not an inconsistency (user clarification, Session 78).

### People Backdrops (`PeopleBackdropsController.cs`, `Helpers/PeopleBackdropsTextDetector.cs`, `Backdrops-v1.js`, second independent IIFE)
- Runs on person detail pages AND their filmography lists.
- Three sources, selected by `PeopleBackdropsSourceMode` (dropdown order Appearances → Folder → Wallpapers.com, default `WallpapersCom`):
  - **Wallpapers.com** — person-specific images by URL (hotlinks, never downloaded). **Persistent cache**: one JSON file per person on disk, **without expiry** ("present = pure read, never re-request; absent = populate once"). Own text-presence filter (`PeopleBackdropsTextDetector`, pure static utility, Otsu threshold + connected components in ImageSharp). API key optional (~30 requests/min without, ~60 with a free key). Fields: API Key (+ Test API Key button), Order (Sequential/Shuffle/Random), Max images per person (default 10), Enable text filter. The Wipe-cache button (deletes the per-person `backdrops.json` files) sits right-aligned in the Source row and is only active for this source.
  - **Appearances** — the person's own movies/shows, streamed progressively over the same NDJSON protocol (`WriteAppearancesStreamAsync`). Fields: Appearances filter (Movies and shows / Movies only / Shows only), Order (`PeopleBackdropsAppearancesSortMode`: Shuffle, Random, then real `ItemSortBy` fields in native enum order), Backdrops per item (`PeopleBackdropsAppearancesMainOnly`: Main/All).
  - **Folder** — `backdrop.ext` (Single) or `backdrop1.ext`, `backdrop2.ext`, … (Multiple) directly in the person's metadata folder (`WriteFolderStreamAsync`, Session 101). Fields: Backdrop files (Single/Multiple), Order (Sequential/Shuffle/Random). Numbered search stops after 3 consecutive gaps, same convention as Jellyfin's own `LocalImageProvider`. If Multiple finds only one file, the rotator silently behaves like Single (no crossfade between an image and itself).
- Shared for all sources (always usable): Enable, Show on (four boxes; all off → Enable unticks itself), Cycle time, Ken Burns effect + Zoom speed + Pan speed.
- The format list exemption applies only to Wallpapers.com (Appearances and Folder read real files) — see Part M.
- Two real production bugs fixed early on: crossfade when leaving a person page, and real synchronization of that crossfade with Detail View Backdrops (now generalized to all six categories, Part N).

### Genre Backdrops
- Library-view pages (genre grid). Pool loaded once per navigation, rotated locally. One shared Order/Traversal pair (`BackdropsGenreSortMode`/`BackdropsGenreTraversalMode`) and a flat "Apply to" multi-checkbox (Global / Movies / TV shows: `BackdropsGenreGlobalEnabled`/`MoviesEnabled`/`TvShowsEnabled`). Movies/TV shows are bound to their own library (`ParentId`, confirmed in `moviegenres.js`/`tvgenres.js`), Global is unbound. Endpoint `/Backdrops/genre-pool`.

### Studio Backdrops
- **Source** (Session 116): **Appearances** rotates the backdrops of the titles the studio appears in (`/Backdrops/studio-pool`, StudioIds filter, same pool mechanics/sort fields/cap as Genre); **Studio image** (default, the original behaviour) shows the single image from `metadata\Studio\<exact studio name>\landscape.jpg` (fallback `.png`), folder name 1:1 like the studio name incl. special characters/brackets, no escaping needed (424 real folders checked). Two checkboxes (Global / TV shows), both off → Enable unticks itself. Endpoints `/Backdrops/studio-settings` + `/studio-image`.

### Tag Backdrops
- One global pool (deliberately mixes movies/series, no further filter — tags are global, no library separation found in the code). Endpoint `/Backdrops/tag-pool`.

### Favorites Backdrops
- 11 subs in the native order of `favorites.js`: Movies, Shows, Episodes, Videos, Collections, Playlists, People, Artists, Albums, Songs, Books. "Subs" means the "show all" full lists with `IsFavorite` filter (technically the same `list.js` page as Genre/Tag).
- **Manage: General / Individual.** General uses one shared Order/Traversal pair (`BackdropsFavoritesGeneralSortMode`/`...TraversalMode`) limited to the fields valid for ALL types (Shuffle, Random, Name, Date added); in each of the 10 file-based subs only the Order/Traversal rows grey out — the sub headers and their Enable stay active, the types are still shown (corrected in Session 116; the earlier "whole arrow greys out" was a misunderstanding). Individual activates the 10 type-specific pairs (table in Part K).
- The People sub has its own Source (Wallpapers.com/Appearances) + Appearances filter; it reuses `PeopleBackdropsController`'s cache methods and the Wallpapers.com pool is bounded per visit: up to 25 already cached persons (`MaxCachedSample`, pure disk reads) plus at most 5 not-yet-cached persons (`MaxNewFetchesPerVisit`, real fetches), both drawn at random so the cache fills evenly over many visits. Appearances = movies/shows the favorite persons appear in, shuffled. Endpoints `/Backdrops/favorites-pool`, `/Backdrops/favorites-people-pool`.

### Naming collision (do not confuse!)
There is a **different** "Library View" term in the project — at Extraposter/Extrakeyart it denotes whether a rotating extra graphic appears on the **single grid tile of an item** (`DetailEnabled` vs. `LibraryEnabled`, same item). That is **not** this concept (whole page background depending on the genre/tag/studio filter). Transferable lesson: an endpoint shared by two contexts without a scope parameter can silently break images for users with only one setting if the release logic is wrong (AND instead of OR).

---

## Part B — Fibel rules relevant for everything here

- **Rule 0**: the tab root switch (`BackdropsTabEnabled`) changes only through a direct click — never automatically, whatever happens in Genre/Studio/Tag/Favorites.
- **Rule 1**: greying flows downwards only (parent → child).
- **Rule 2 / Part B2**: the Show-on-empty→Enable-off mutation applies to every sub with an own Enable distinguishable from the tab root (Detail View, People, Genre, Studio, Tag, Favorites). Bug #11 in the log came from forgetting one of five structurally identical groups.
- **Rule 3**: `target` must never contain its own trigger checkbox (self-deadlock). Rules 3c/3d cover the Sort/Traversal sibling pairs.
- **Rules 7/13**: sort dropdowns (`<select>` fields) are `structural: true` — otherwise they fake "always active" to the tab effectiveness check.
- **Rule 14**: one grey level only, never nested/additive.
- **Rules 22–26**: explicit listeners for fields read only by post-process functions; full ancestor chain for exception functions; the Favorites/People cascade reference.
- **Process duty**: the per-tab table in the Fibel (Part C there) must be updated **before** the first new node is written.

---

## Part C — Common design of the pool categories (Genre, Tag, Favorites)

- Context: **library-view pages** (genre/tag/favorites grid), not detail pages.
- The pool is loaded **once per navigation to a new filtered page** (not per rotation), then rotated locally — replicates Detail View Backdrops' "no cache, always fresh on navigation" pattern, since both only read Jellyfin's own, already known metadata (no external call). **No new, third cache concept.**
- Every renewed visit of the same filtered page: fresh shuffle. Within one stay the order stays stable.
- The sort order determines the **rotation order**, not just the first image.
- **Backdrops per item** (`*MainOnly`, stored as `"Main"`/`"All"`): Main uses only the item's primary backdrop (the file without a number — `LocalImageProvider.PopulateBackdrops` enters it FIRST, so it reliably lands on `BackdropImageTags[0]`), All picks a random one per item.
- Ken Burns/timing: per category (own copy of the options, no values shared with Detail View Backdrops). Defaults everywhere: Cycle time 10000, Order Shuffle, Ken Burns on, Zoom speed 20000, Pan speed 10000 (Session 73).
- Common field skeleton: `Enable → Backdrops per item → Cycle time → Ken Burns effect → Zoom speed → Pan speed → [Manage] → Order → [Traversal]` (Genre appends "Apply to", Favorites inserts "Manage"). Full reference in Part P.
- Server load: an `ILibraryManager` query with `GenreIds`/`TagIds`/`StudioIds`/`PersonIds` filter is indexed (SQLite) — even several hundred hits are in the millisecond range for a pure ID/image-path query; every pool query is additionally capped at 100 items (Part G/H).

### Sort options (curated from Jellyfin's `ItemSortBy` enum, server source checked)
Generally applicable (movies + TV mixed): Name, SortName, DateCreated, PremiereDate, ProductionYear, StartDate, CommunityRating, CriticRating, OfficialRating, Runtime, PlayCount, DatePlayed, VideoBitRate, IsPlayed, IsUnplayed, IsFavoriteOrLiked, Studio. Plus Shuffle and Random (Random maps to native `ItemSortBy.Random`, no duplication).
Excluded (type-exclusive): Album/AlbumArtist/Artist (music), AiredEpisodeOrder/IndexNumber/ParentIndexNumber/AirTime (episodes), SeriesSortName/SeriesDatePlayed/DateLastContentAdded (series), SimilarityScore/SearchScore (only meaningful in their own context), IsFolder. Favorites' per-type lists are narrower (Part K).

### Order of the categories in the Backdrops tab
1. Detail View Backdrops, 2. People Backdrops, 3. Genre, 4. Studio, 5. Tag, 6. Favorites — Detail-view features on top (unchanged, most used), the library-view categories below.

---

## Part D — Decisions (all confirmed by the user)

- **No whitelisting of individual genres/tags/studios/persons.** A sub switch (e.g. "Movie genres on") applies to all genres of that list without exception. Only the defined sub-types themselves are distinguished, never entries inside a list.
- **No new format gate.** All categories (including Studio's local `landscape.jpg`/`.png`) use the existing, overarching `BackdropsAllowedFormats`. Only People with Source=Wallpapers.com is exempt (Part M).
- **Admin-wide, no per-user switch.** All settings apply server-wide for all users, consistent with the rest of the plugin.
- **Empty pool** (e.g. a genre without matching items): the native display stays untouched, no hint, no placeholder.
- Descriptions in the admin menu: short, informative, one line, hyphens only when necessary, matching the rest of the menu. Dropdown options are explained in the order they appear (Main first, then All).

---

## Part E — How the implementation was approached (reminder to ourselves)

0. **Core.js vs. Backdrops-v1.js — what belongs where.** `Core.js` provides `createBackdropRotationEngine()` (pure Sequential/Shuffle/Random timing/order logic as a factory, every caller gets its own independent instance). Exactly this function is **reused** for Genre/Studio/Tag/Favorites, not rebuilt a third time. The ability to detect which library-view page/filter is active (from the URL hash) lives **entirely in `Backdrops-v1.js`**, not in Core.js — only Backdrops needs it (CaseMod/CustomPoster/Extraposter/AnimatedPoster are detail-page features, Characterart/RedCarpet in RenderArt-v1.js are detail/filmography features).
1. Before the first node: extend the Fibel table (Part C there).
2. Do not change the existing Detail View/People Backdrops logic — replicate, do not reinvent.
3. Finish and test every category individually before the next one starts.

---

## Part F — Where the implementation lives

- **Config:** `PluginConfiguration.cs` — all fields grouped directly after the respective `Backdrops<Category>Enabled`, the People fields in the People Backdrops block.
- **Server:** `BackdropsController.cs` — `/Backdrops/genre-pool`, `/Backdrops/studio-settings` + `/studio-image`, `/Backdrops/tag-pool`, `/Backdrops/favorites-pool`, `/Backdrops/favorites-people-pool`, shared helper `ResolveRotationQuery`. `PeopleBackdropsController.cs` — `WriteAppearancesStreamAsync`/`WriteFolderStreamAsync` branches in the existing `GetPeopleBackdrops` method; `ReadOrPopulateCacheFileAsync`/`GetCacheFilePath` are `internal` so Favorites' People sub can reuse them.
- **Client:** `Jellyfin-ArtworkPlus-Backdrops-v1.js` — six independent IIFEs (Detail View, People Backdrops, Genre, Studio, Tag, Favorites). All use `Core.js`' `createBackdropRotationEngine()` and the shared `ArtworkPlusBackdropTransition` signal (Part N).
- **Admin UI:** `configPage.html` — six collapse areas in the Backdrops tab, EP_TREE nodes `backdropsmod`/`peoplebackdrops`/`backdropsgenre`/`backdropsstudio`/`backdropstag`/`backdropsfavorites`, plus the post-process functions `epUpdatePeopleBackdropsWipeBtnState`, `epUpdatePeopleBackdropsFormatDependency`, `epApplyFavoritesPeopleFormatException`, `epUpdateFavoritesHeaderFormatException`.
- **Tests:** `tests/run_checks.py` (105/105, 0 self-containment violations, 0 rule-14 violations, 0 default mismatches, 0 duplicate IDs, 0 missing nested-collapse classes). Real bugs found while testing (image index after format filtering, timer-tracker signature, test artifact from an empty stub config) are documented in the respective code comments.

---

## Part G — F-2024-01: pool queries capped (audit addendum, Session 72)

A repeated audit found: `GetGenrePool`/`GetTagPool`/`GetFavoritesPool` queried the local item pool **unbounded**, identically for every SortMode. Fix: for `SortMode` = `Shuffle`/`Random` the server additionally sets `OrderBy = ItemSortBy.Random` + `Limit = 100` (`isRandomRotation` flag).

**N=100 derived**, not arbitrary: at the then default `CycleTimeMs`=24000ms it covers a 1200s visit with double margin, and lies in the flat region of an own synthetic SQLite benchmark (100,000 candidates: unbounded 314ms vs. `LIMIT 100` ~73ms).

**Deliberately NOT changed:** `GetFavoritesPeoplePool`'s two queries (favorite-people lookup, appearances items) — `FavoritesPeoplePoolResult` has no `SortMode` field, the client always falls back to `Sequential` there. `MaxNewFetchesPerVisit=5`/`MaxCachedSample=25` (Wallpapers.com rate-limit protection) unchanged — an independent concern.

(The temporary static check script `audit_f2024_01_static_check.py` was retired in Session 111: it asserted that real sort fields stay unbounded, which Part H changed, and a real compiler is available now.)

---

## Part H — Traversal mode for real sort fields (user extension of F-2024-01)

User objection, justified: the F-2024-01 fix treated Shuffle/Random (Limit=100) differently from real sort fields (still unbounded) — inconsistent, since nobody sees hundreds of backdrops in one session with "Sort: Name" either. Extension: **every** mode now gets `Limit=100`, with 4 variants for real sort fields:

- **BeginAscending** (default, = previous behaviour, now capped)
- **BeginDescending**
- **RandomStartAscending** — fresh random offset per visit (via a cheap `GetCount` query, no materialization): `maxStart = max(0, N-100)`, `StartIndex = Random.Next(0, maxStart+1)`, so the whole sorted list stays reachable over many visits instead of always the first 100
- **RandomStartDescending** — as above, descending

Shared helper `ResolveRotationQuery(sortMode, traversalMode, baseQuery)` in `BackdropsController.cs`, used by `GetGenrePool`/`GetTagPool`/`GetFavoritesPool`. The count query and the item query run on the SAME `InternalItemsQuery` object, so their filters can never drift apart. SQL order confirmed in `SqliteItemRepository`: `ORDER BY`, then `LIMIT`, then `OFFSET`.

Admin UI: a Traversal dropdown after every Order dropdown, gated with `ValueIn` so it is only usable when Order is a real field (not Shuffle/Random). Since the Session 99–101 consolidation there are 1 (Genre) + 1 (Tag) + 1 (Favorites General) + 10 (Favorites individual) pairs.

---

## Part I — Ken Burns/timing defaults (Session 73)

Changed for all four pool/single-image categories (Genre, Studio, Tag, Favorites) on explicit request: Cycle time 10000, Ken Burns effect on (was off), Zoom speed 20000 (was 10000), Pan speed 10000 (was 5000). 15 values in total (Studio has no cycle time — single image). Order defaults (Shuffle) were already correct. Changed in `PluginConfiguration.cs` and `EP_FIELDS` in sync.

---

## Part J — People Backdrops: final field structure (designed Sessions 74–82, implemented Sessions 101–105)

Order inside the People Backdrops block:

```
Enable
Show on (Info page / Movies / TV shows / Episodes)          ← all off → Enable unticks itself
Cycle time
Ken Burns effect → Zoom speed → Pan speed                    ← always usable, shared by all sources
Source (Appearances / Folder / Wallpapers.com)  [Wipe cache]  ← button right-aligned, active only for Wallpapers.com
  Appearances filter                                          ← Appearances only
  Order (Appearances sort, ItemSortBy enum order)             ← Appearances only
  Backdrops per item (Main / All)                             ← Appearances only
  Backdrop files (Single / Multiple)                          ← Folder only
  Order (Sequential / Shuffle / Random)                       ← Folder only
  API Key  [Test API Key]                                     ← Wallpapers.com only
  Order (Sequential / Shuffle / Random)                       ← Wallpapers.com only
  Max images per person (default 10)                          ← Wallpapers.com only
  Enable text filter                                          ← Wallpapers.com only
```

Three fields labelled "Order", each bound to its own source block and never visible at the same time — a deliberate decision, discussed several times. The section headings (Global/Appearance/Wallpaper settings) used during the design were only for the discussion; the real UI has none.

Description texts: intro "Shows appearance backdrops or wallpapers from [Wallpapers.com](https://wallpapers.com/) on person pages."; Source "Wallpapers.com: images from the web. Appearances: this person's own movies/shows instead."; Backdrop files "Looks in the person's folder for backdrop.ext (Single) or backdrop1.ext, backdrop2.ext, ... (Multiple)."; Backdrops per item "All picks a random backdrop per item instead of the main one. Only used for Appearances."

The Wipe-cache button needs its own disable function (`epUpdatePeopleBackdropsWipeBtnState`, buttons are never disabled by the shared `epSetRowDisabled`) with the rule-14 ancestor check — the first version forgot it (Fibel bug log, Session 76).

---

## Part K — Genre consolidation and Favorites Manage mode (designed Session 77, implemented Sessions 99–101)

**Genre:** 6 separate Order/Traversal properties (Global/Movies/TvShows) → 2 shared (`BackdropsGenreSortMode`/`BackdropsGenreTraversalMode`); the three sub-collapses became a flat "Apply to" multi-checkbox row. `GetGenrePool` still resolves `subEnabled`/`includeTypes` per sub but reads Order/Traversal from the two shared fields.

**Favorites:** `BackdropsFavoritesManageMode` (General/Individual), `BackdropsFavoritesGeneralSortMode`/`GeneralTraversalMode`. `GetFavoritesPool` reads either the General pair or the per-type pair. Per-type sort fields, researched in jellyfin-web's `SortButton.tsx`:

| Type | Valid fields (in addition to Shuffle/Random) |
|---|---|
| Movies | Name(SortName), Community rating, Critic rating, Date added, Date played, Parental rating, Play count, Premiere date, Runtime |
| Shows | Name(SortName), Community rating, Date added, Date episode added, Date played(SeriesDatePlayed), Parental rating, Premiere date |
| Episodes | Name(**SeriesSortName**), Community rating, Date added, Premiere date, Date played, Parental rating, Play count, Runtime |
| Videos | Name(SortName), Date added, Date played, Play count, Runtime |
| Collections | Name(SortName), Community rating, Critic rating, Date added, Premiere date, Parental rating |
| Playlists | **only** Name(SortName) — real Jellyfin has no sort button here at all |
| Artists | **only** Name(SortName) — real Jellyfin has no sort button here at all |
| Albums | Name(SortName), Album artist, Community rating, Critic rating, Production year, Date added |
| Songs | Name(SortName), Album, Album artist, Artist, Date added, Date played, Play count, Premiere date, Runtime |
| Books | Name(SortName), Date added, Community rating, Critic rating, Parental rating, Premiere date (no explicit Jellyfin source found, chosen conservatively) |

General mode = intersection of all lists (Shuffle, Random, Name, Date added — determined by Artists/Playlists). Safety check (Fibel rule 3d): `_sort` nodes now carry a real condition instead of `when: []`; safe because `_sort` and `_traversal` share the same primary condition (`ManageMode`).

**Studio:** Show-on→Enable mutation `[['BackdropsStudioGlobalEnabled', 'BackdropsStudioTvShowsEnabled'], 'BackdropsStudioEnabled']` added (Session 105).

---

## Part L — People Backdrops: third source "Folder" (designed Session 80, implemented Session 101)

Searches directly in the Jellyfin person folder for `backdrop.ext` (Single) or `backdrop1.ext`, `backdrop2.ext`, … (Multiple) — no external API, no appearances logic. Server: third branch `WriteFolderStreamAsync` next to Appearances/Wallpapers.com plus an image endpoint; file search verified against a real test folder (Single finds only the unnumbered file; Multiple stops after 3 consecutive gaps and correctly excludes an isolated later file). Properties `PeopleBackdropsFolderMode`, `PeopleBackdropsFolderOrderMode`. Order is the simple Sequential/Shuffle/Random concept, NOT Order/Traversal (numbered files have no real sort fields).

Jellyfin facts verified in Session 97 (10.10.7 source): the prefixes `backdrop`, `fanart`, `background`, `art` are hard-coded in `LocalImageProvider`; the numbered form is `backdrop1..20` (no dash) but `fanart-1`, `background-1`, `art-1` (with dash); Prefixed (`moviename-backdrop`) is always detected, Standalone (`backdrop`) only when the item is not in a mixed folder; if both exist both are added, prefixed first. Season inherits parent images, Series does not, Episodes have no own backdrop.

---

## Part M — Format-list exemption for People with Source=Wallpapers.com (Sessions 81–82 design, 102–109 implementation)

**Requirement:** the exemption from "Allowed image formats" is NOT wholesale for People, only for **Source=Wallpapers.com** (external API + own cache, independent of file format). Appearances (real library backdrop files) and Folder (the format list determines the searched extension) need the list normally. Additionally the outer "▶ Favorites Backdrops" header must not dim while People with Wallpapers.com still works, even if all ten file-based subs are grey because of an empty format list.

**Implementation:** no fourth condition type in the tree (rule 8) — own post-process functions following the Align-field pattern:
- `epUpdatePeopleBackdropsFormatDependency` (standalone People): additionally greys only the Appearances/Folder rows when Source ≠ Wallpapers.com AND the format list is empty; the Source dropdown itself always stays usable (otherwise the user could never switch back — the first draft in Session 105 would have caused exactly that deadlock, Fibel rule 23).
- `epApplyFavoritesPeopleFormatException` (Favorites' People sub) + `epUpdateFavoritesHeaderFormatException` (outer header): the only place in the project where an additional function takes back a tree-own greying (justified: same node corrects itself).
- `BackdropsFavoritesPeopleSourceMode` appears in EP_TREE only as a target, so it needed an explicit `change` listener (Fibel rule 22).

**Why it took four attempts (Sessions 102/106/107/108/109):** every attempt handled only the level of the currently reported symptom. The full cascade the normal tree pass sets for an empty format list, which an exception must take back symmetrically:

```
backdropsfavorites (root node)
  when: AnyChecked(BdFormat_*) AND AllChecked(BackdropsFavoritesEnabled)
  target: BackdropsFavoritesDependentFields  ← level 1: container class + .disabled on ALL descendant inputs
  headerTarget: backdropsFavorites            ← level 2: outer header
  │
  ├─ level 3a: BackdropsFavoritesCycleTimeMs/KenBurnsEnabled/KenBurnsZoomMs/KenBurnsPanMs
  │             (directly in the container, NO own node - level-1 cascade only)
  ├─ level 3b: Manage/Order/Traversal (own structural nodes, ManageMode-dependent)
  ├─ level 3c: MainOnly/ManageMode/GeneralSortMode/GeneralTraversalMode are IRRELEVANT
  │             for People (pure pool-sorting concepts) - stay .disabled but STILL need
  │             their own epFieldDisabled class (via .closest('.epRow')), otherwise only
  │             inconsistent native browser looks (field slightly dimmed, label bright)
  │
  ├─ backdropsfavorites_movies/_shows/_episodes/_videos/_collections/
  │  _playlists/_artists/_albums/_songs/_books  ← level 4: own header+body each,
  │             skip=true (rule 14, level 1 already covers them visually)
  │
  └─ backdropsfavorites_people                  ← level 5: own header+body, also skip=true
```

Removing the container class alone is NOT enough — CSS inheritance would also brighten the other 10 subs although they correctly stay `disabled=true`; they therefore get the class directly on their own header+body. Everything the exception sets itself is tagged with `data-ep-format-exception-grey` and withdrawn only by that marker when the exception ends (Fibel rule 26; before that, 255 rule-14 violations on every format-empty-then-full transition). Verified with a full `parentElement` chain check up to `<html>` and screenshots (Fibel rule 24).

---

## Part N — Fade concept for all six categories (Sessions 84–86)

**Baseline verified in code:** fade-in exists everywhere (`FADE_MS` = 800ms, opacity 0→1); crossfade when rotating WITHIN a page exists everywhere; switching between two instances of the same category (Genre A → Genre B) never calls the hard reset. Two findings: Studio hard-reset (`innerHTML=''`) before EVERY new image, and only People ↔ Detail View were coordinated across category borders.

**Counter-audit corrections:** (1) Appearances is NOT a preloaded pool — both People sources stream progressively over NDJSON (`rotationEngine.addImages([parsed.Url])` per received line); the real difference is how long the first image takes (Jellyfin-local vs. external round trip). (2) `ArtworkPlusBackdropTransition` needed no change — `_pending` is already an array, `notifyIncomingReady()` fires and clears it, `onNextIncomingReady(fn)` pushes; Detail View calls `notifyIncomingReady()` on every render (no-op without listeners).

**Implemented (Session 86, `Jellyfin-ArtworkPlus-Backdrops-v1.js`):**
1. Studio follows Genre's pattern (old image fades out itself, removed after `FADE_MS`); `loadStudioBackdrop` only bumps `renderGeneration` before a new image; own `FADE_MS` constant.
2. All six categories call `notifyIncomingReady()` on every own render.
3. All six `clearOwnRotation()`/`clearOwn()`/`destroyVisit()` functions wait on real leaving for `onNextIncomingReady(...)` with `MAX_WAIT_FOR_INCOMING_MS = 1200` fallback before fading their own container out and clearing it afterwards.
4. Wallpapers.com joins the same signal without special handling — its typically longer latency naturally produces the accepted "fade out, then (later) plain fade in" behaviour; a cached image even gets a real crossfade as a bonus.

Verified: `node --check`, the signal mechanism re-built in isolation with two simultaneous participants, each new call counted exactly 6× in the code. The visual timing feel on a real server was still unverified at the time.

---

## Part O — Sandbox era (Sessions 71–86) and its port (Sessions 97–105), condensed

From Session 71 the Backdrops admin UI was redesigned in a standalone replica (`sandbox/admin-config-replica.html`: the real `configPage.html` with ApiClient/Dashboard stubs, ~350 defaults extracted from `PluginConfiguration.cs`, the real jellyfin-web `theme.css` embedded because `.raised`/`.button-submit` and `html { background-color: #101010 }` only come from the theme). Parts J, K, L and M above were designed there; the fade concept (Part N) and the Sets extension were done directly in the real files.

Session 98 established honestly which of it was **sandbox only**: Genre consolidation, "Backdrops per item" dropdown, Favorites Manage mode + type-specific sort fields, People Enable, Folder source, the format exemption, the Favorites-People Appearances filter. Sessions 99–103 ported them for real (phases A–F), Session 104 compared the sandbox file against the real file directly (not just the curriculum summaries — 7 of 9 gaps were only found that way) and Session 105 closed the remaining nine gaps (Tag field order, Studio mutation, MaxImages default 10, Wipe-cache button position/behaviour, Source dropdown order, Order gated to Wallpapers.com only, the separate Appearances Order and Backdrops-per-item fields, standalone People format dependency). The replica was retired in Session 111; `build_preview.py` is the preview mechanism.

Sandbox test caveat (kept for the record): the replica had its own embedded `window.ApiClient` stub that overrode any mock injected by the official suite, so `test_configpage.py`'s LOAD-FIX block could never run against it — a test artifact, not a regression.

---

## Part P — Field-order reference of the whole Backdrops tab

Uniform grid since Session 116 (user decision "greatest possible consistency"):
**Enable → where it applies → Source (if any) → Backdrops per item → Cycle time →
Ken Burns effect → Zoom speed → Pan speed → Order → Traversal → category-specific rest.**
"Where it applies" is Show on for the detail-view categories, Apply to for the
library categories, the 11 sub-Enables for Favorites; Tag has no Apply to (tags
are global by design).

| # | Detail View | People | Genre | Studio | Tag | Favorites |
|---|---|---|---|---|---|---|
| 1 | Enable *(native override)* | Enable | Enable | Enable | Enable | Enable |
| 2 | Show on (multi) | Show on (multi) | Apply to (Global/Movies/TV shows) | Apply to (Global/TV shows) | — | Backdrops per item |
| 3 | Cycle time | Cycle time | Backdrops per item | **Source** (Appearances / Studio image) | Backdrops per item | Cycle time |
| 4 | Ken Burns effect | Ken Burns effect | Cycle time | Backdrops per item *(Appearances)* | Cycle time | Ken Burns effect |
| 5 | Zoom speed | Zoom speed | Ken Burns effect | Cycle time *(Appearances)* | Ken Burns effect | Zoom speed |
| 6 | Pan speed | Pan speed | Zoom speed | Ken Burns effect | Zoom speed | Pan speed |
| 7 | **Order** | Source [Wipe cache] | Pan speed | Zoom speed | Pan speed | Manage |
| 8 | — | Appearances filter | **Order** | Pan speed | **Order** | **Order** *(General)* |
| 9 | — | Backdrops per item *(Appearances)* | **Traversal** | **Order** *(Appearances)* | **Traversal** | **Traversal** *(General)* |
| 10 | — | **Order** *(Appearances)* | — | **Traversal** *(Appearances)* | — | 11 sub-types |
| 11 | — | **Traversal** *(Appearances)* | — | — | — | — |
| 12 | — | Backdrop files *(Folder)* | — | — | — | — |
| 13 | — | **Order** *(Folder)* | — | — | — | — |
| 14 | — | API Key [Test API Key] | — | — | — | — |
| 15 | — | **Order** *(Wallpapers.com)* | — | — | — | — |
| 16 | — | Max images per person | — | — | — | — |
| 17 | — | Enable text filter | — | — | — | — |

People keeps its Source on row 7 with the three source blocks after it (a field
cannot be gated by a control below it); inside the Appearances block the order is
filter → Backdrops per item → Order, matching the grid. Studio's Source greys
rows 4, 5, 9, 10 when Studio image is selected; Ken Burns applies to both sources.

**Favorites' 11 sub-types:** all `Enable → Order → Traversal` — except **People**, which mirrors the standalone People source blocks (Session 116): `Enable → Source (Appearances / Folder / Wallpapers.com) → Appearances filter → Backdrops per item → Order → Traversal → Backdrop files → Order`; the Wallpapers.com settings (API key, Max images, text filter, Order) stay central in the People tab and apply to both. With Manage=General only the Order/Traversal rows inside the 10 file-based subs grey out; the sub headers and Enable checkboxes stay active (Session 116 correction); People is unaffected.
