# ArtworkPlus - "Show also on" concept (Session 140 rework)

The library-scope poster tiles (Postercase / Keyart, Animated Poster / Animated
Keyart, Extraposter / Extrakeyart) act on every Jellyfin page that builds
poster cards. Sessions 136-139 gated that with "Also on" rows; this rework
replaces them with one structure that says, per item kind and per area,
whether the library tile is allowed there - independent of the library grid.

## Part A - Where our cards appear (jellyfin-web 10.10.7, verified)

| Area | page class | Movie | Set (BoxSet) | Series | Source |
|---|---|---|---|---|---|
| Home - Recently added | `home-recent` | yes | no (`excludeViewTypes` boxsets) | yes | `components/homesections/sections/recentlyAdded.ts:140` |
| Home - Continue Watching | `home-resume` | yes | no | no (episode cards) | `resume.ts` (`MediaTypes: Video`) |
| Favorites tab | `favorites` | Movies row | Collections row | Shows row | `controllers/favorites.js:21-59` |
| Search results | `search` | Movies row | Collections row | Shows row | `hooks/searchHook/useSearchItems.ts:261-496` |
| Lists - Genre | `list-genre` | yes | no (`Movie,Series,Video`) | yes | `controllers/list.js:312-318` |
| Lists - Studio | `list-studio` | yes | only a set with a studio, via a link without parentId | yes | `list.js:293-323` |
| Lists - Tag | `list-tag` | yes | yes (`IncludeItemTypes=tag` is dropped by `CommaDelimitedArrayModelBinder`) | yes | `list.js:283` + server binder |
| Lists - Folder & More | `list-other` | yes | yes (Collections library folder, Favorites "More") | yes | `list.js:326` |
| Detail - More like this | `detail-similar` | yes | no (no section on a set page) | yes | `controllers/itemDetails/index.js:1234` |
| Detail - Set members | `detail-collection` | yes | no | yes | `itemDetails/index.js:1476` |
| Detail - People pages | `detail-person` | Movies row | no | Shows row | `scripts/itemsByName.js` |
| Library grid | `library` | yes | - | yes | `movies.html` / `tv.html` |
| Admin dashboard | `dashboard` | never | never | never | - |

Consequences: a Set menu offers only Favorites, Search, Studio, Tag, Folder &
More; a TV menu has no Continue Watching (the Session 136 box was a dummy).

## Part B - Admin page structure (every tile feature, Movies and TV shows block)

Movies block (Extra: inside "Library views"; Custom / Animated: the Movies collapse):

```
Enable for library views     [x]  Replaces the poster on the library grid pages.
  > For Movies show also on                     (nested collapse)
      Favorites & Search     [ ] Favorites  [ ] Search
      Home                   [ ] Recently added  [ ] Continue Watching
      Lists                  [ ] Genre  [ ] Studio  [ ] Tag  [ ] Folder & More
      Detail pages           [ ] More like this  [ ] Set members  [ ] People pages
  > For Sets show also on                       (nested collapse)
      Favorites & Search     [ ] Favorites  [ ] Search
      Lists                  [ ] Studio  [ ] Tag  [ ] Folder & More
```

TV shows block:

```
Enable for library views     [x]
  > Show also on
      Favorites & Search     [ ] Favorites  [ ] Search
      Home                   [ ] Recently added
      Lists                  [ ] Genre  [ ] Studio  [ ] Tag  [ ] Folder & More
      Detail pages           [ ] More like this  [ ] Set members  [ ] People pages
```

- Collapse keys `<feature><Kind>AlsoOn<Movies|Sets|Shows>` (e.g.
  `extraposterMoviesAlsoOnSets`), one nesting step below the block they sit
  in (`epCollapseNested`, plus `epCollapseNested2` at depth >= 2 - rule 19).
- Show on rows stay exactly as they are (feature level in Custom / Animated,
  per view in Extra).
- Row descriptions (one line, <= 105 chars):
  - Favorites & Search: `The Movies rows of the Favorites tab and the search page.` (Sets: `The Collections rows ...`, TV: `The Shows rows ...`)
  - Home: `Latest Movies row; Continue Watching for a movie without thumb or backdrop.` (TV: `Latest Shows row.`)
  - Lists: `Genre, studio and tag lists; folder views and every "More" list.` (Sets: `Studio and tag lists; the Collections folder and its "More" lists.`)
  - Detail pages: `Similar titles below a movie, the movies of a Set, the Movies row of a person.` (TV: series / Shows row)
  - Enable for library views: `Replaces the poster on the library grid pages (Movies / TV shows).` (Extra keeps `... slideshow on library grid tiles.`)

## Part C - Fields

`<Feature><Movies|TvShows>LibraryAlsoOn<Movies|Sets|Shows><Area>`, bool, default off.
Areas: `Favorites`, `Search`, `HomeRecentlyAdded`, `HomeContinueWatching`,
`ListsGenre`, `ListsStudio`, `ListsTag`, `ListsFolderMore`,
`DetailMoreLikeThis`, `DetailSetMembers`, `DetailPeoplePages`.

| menu | areas | fields |
|---|---|---|
| Movies block - Movies | all 11 | 11 |
| Movies block - Sets | Favorites, Search, ListsStudio, ListsTag, ListsFolderMore | 5 |
| TV block - Shows | all but HomeContinueWatching | 10 |

26 per feature, 156 in total (6 features). The 108 fields of Sessions 136-139
are removed (all were default off; a saved config loses nothing that was on).

## Part D - Gates and sync (the Fibel rules apply)

- Tree: per menu one node `<block>_alsoon_<movies|sets|shows>` with
  `headerTarget` = its collapse header, `target` = its collapse body,
  `when: [AllChecked([<the block's Show on box for that kind>])]` (Extra:
  the library block's `...LibraryShowOnMovies/Sets/TvShows`; Custom /
  Animated: the feature-level `...ShowOnMovies/Sets/TvShows`). The body holds
  only the rows (rule 10 ok: header + body targeted, trigger outside). The
  library Enable does NOT grey the menus (they are siblings of the grid
  switch, not children); the feature Enable / format gates grey them through
  their ancestors as everything else in the block.
- Rule 3: the menus never contain their own trigger (Show on lives outside).
  Rule 25b: the block's view node targets `<...>LibraryFields` /
  `DependentFields`; the menus sit outside those targets.
- Sync, user rule "only when every sub is off":
  - Custom / Animated: `Show on Movies` unticks itself only when Movies
    Detail Enable, Movies Library Enable AND every box of the Movies menu are
    off; `Show on Sets` when Movies Library Enable AND every Sets box are
    off (Sets have no own detail switch); `Show on TV shows` when TV Detail,
    TV Library AND every Shows box are off. (`epSyncDetailLibraryToShowOn`
    gets the menu's box ids as further inputs.)
  - Extra: the library Show on -> Library Enable chain stays (an empty Show
    on means nothing can show anywhere); the "all four views off -> feature
    Enable off" chain counts the menus' boxes as views (any box on keeps the
    feature Enable).
  - No chain ever unticks a menu box.

## Part E - Server

- `Helpers/AlsoOn.Allowed(config, page, feature, kindBlock, itemKind)`:
  `page == "library"` -> `<Feature><Kind>LibraryEnabled`; `dashboard` ->
  false; else the box `<Feature><Kind>LibraryAlsoOn<Item><Area>` for the
  page class (`favorites` -> Favorites, `search` -> Search, ...). Item =
  Movies / Sets (Movies block) or Shows (TV block); an area the item does
  not have (e.g. Sets + `home-recent`) -> false.
- The resolvers no longer read `...LibraryEnabled` for the library scope;
  the Show on gate stays inside (Extra: the library block's Show on). The
  per-item cache (Extra) therefore holds the view-independent answer and
  the page gate is applied on the way out (as `AlsoOnAllowed` does today).
- `BuildLibraryTilesFlagsScriptTag`: a participant is expected when a
  library Enable OR any also-on box of an enabled feature is on.
- Batch endpoints: unchanged signature (`page=`), Custom / Animated pass
  the page into the resolver gate instead of filtering afterwards.

## Part F - Client

Unchanged (Session 139: `pageClassOf`, per-class batches, per-class cache).

## Part G - Tests and docs

- `test_configpage.py`: block S140 replaces S136/S139 - 18 menus (12 Movies
  blocks x 2 + 6 TV) with rows / boxes / descriptions; menus grey with
  their Show on box only, never with the library Enable; the three sync
  rules (box on keeps Show on and the feature Enable; all off unticks).
- `test_alsoon_mapping.py`: page classes <-> areas <-> 156 properties (per
  item kind) <-> checkboxes; the Sets and Shows menus offer exactly Part A's
  areas.
- `test_library_tiles.py`: S28-S30 keep; S31 - library Enable off + a box on
  still answers on that page class (server contract via the stub flags).
- Feature map (counts, rows), Fibel Part C (this structure), curriculum,
  README line. Rollback: tag `alsoon-rework-before`.
