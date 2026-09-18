# ArtworkPlus — feature map

One page, read whole at the start of every session. Generated from the code in
Session 114 (2026-09-18); the Status and Fixture columns are filled by the live
test and kept current afterwards. Details: curriculum "Feature inventory",
Fibel, Backdrops concept.

## Delivery

| Piece | Where | Served as | Deploy |
|---|---|---|---|
| Admin UI `Configuration/configPage.html` | embedded in DLL | `/web/configurationpage?name=ArtworkPlus` | full |
| `PluginConfiguration.cs` (369 settings) | DLL | `/Plugins/<guid>/Configuration` | full |
| `EmbeddedScripts/Jellyfin-ArtworkPlus-Core-v1.js` | DLL | `/ArtworkPlusCore/script.js` | full |
| `Jellyfin-ArtworkPlus-Posters-v1.js` | data folder | `/PostersPlus/script.js` | scripts |
| `Jellyfin-ArtworkPlus-RenderArt-v1.js` | data folder | `/RenderArt/script.js` | scripts |
| `Jellyfin-ArtworkPlus-Backdrops-v1.js` | data folder | `/Backdrops/script.js` | scripts |
| `CaseTextures/**` | next to DLL | `/CaseMod/Texture/{caseType}/{key}` | full |
| index.html injection (4 script tags + FOOC styles) | `FileTransformation/FileTransformationRegistrar.cs` via File Transformation plugin | — | full |

Data folder = `C:\ProgramData\Jellyfin\Server\plugins\Jellyfin.Plugin.ArtworkPlus\`.
Admin tabs (`data-tab`): general, casemod, animatedposter, customposter, extraposter, characterart, redcarpet, backdrops.

## Features

Columns: where it renders · client module · controller + endpoints · config prefix (field count) · admin tab · status · fixture.
Status: ✅ verified live · ⚠️ gap known · ❓ not yet tested live · ❌ broken.

### Poster slot (all in `Posters-v1.js`, one shared state machine — "poster controller")

| Feature | Renders on | Module | Controller / endpoints | Config prefix | Tab | Status | Fixture |
|---|---|---|---|---|---|---|---|
| Case Mod | detail page poster (Movie, BoxSet, Series main) | CaseModModule | `CaseMod`: `{itemId}`, `Texture/{caseType}/{key}` | `CaseMod*` (27), `*CaseTune*` dev fields | casemod | ❓ | |
| Animated Poster | detail page main poster (Movie, Series, Set) — replaces image source | AnimatedModule | `AnimatedPoster`: `{itemId}?type=`, `batch`, `{itemId}/image` | `AnimatedPoster*` (14) | animatedposter | ❓ | |
| Animated Keyart | same, alternate base image | AnimatedModule | same controller, `type=animatedkeyart` | `AnimatedKeyart*` (11) | animatedposter | ❓ | |
| Postercase (Custom Poster) | detail page main poster; **no library view** (⚠️ never scoped) | CustomModule | `CustomPoster`: `{itemId}?type=`, `batch`, `{itemId}/image` | `Postercase*` (14), `CustomPoster*` (3) | customposter | ❓ | |
| Keyart (Custom Poster) | same, alternate base | CustomModule | same controller, `type=keyart` | `Keyart*` (17) | customposter | ❓ | |
| Extraposter | detail page + library grid tiles, overlay slideshow | ExtraModule | `Extraposter`: `{itemId}/quickcheck`, `{itemId}?type=`, `batch`, `{itemId}/image/{fileName}` | `Extraposter*` (14) | extraposter | ❓ | |
| Extrakeyart | same, alternate base | ExtraModule | same controller, `type=extrakeyart` | `Extrakeyart*` (22) | extraposter | ❓ | |

Priority when several want the poster slot: Custom (1) > Animated > Extra overlay, Extra's fallback reveals whatever is underneath (see curriculum "Poster controller").
Sets (BoxSets): supported by Animated/Custom/Extra since Sessions 87–92 (Movies' settings reused, naming Standalone).

### Positioned art (`RenderArt-v1.js`)

| Feature | Renders on | Controller / endpoints | Config prefix | Tab | Status | Fixture |
|---|---|---|---|---|---|---|
| Characterart | detail pages (Movie/Series/Season/Episode/Set), up to 4 screen positions | `Characterart`: `{itemId}`, `{itemId}/image/{fileName}` | `Characterart*` (95) | characterart | ❓ | |
| Red Carpet | person detail pages, actor-art overlay | `RedCarpet`: `{personId}`, `{personId}/image` | `RedCarpet*` (24); master switch on General tab only | redcarpet | ❓ | |

### Backdrops (`Backdrops-v1.js`, six independent IIFEs sharing `ArtworkPlusBackdropTransition`)

| Feature | Renders on | Controller / endpoints | Config prefix | Status | Fixture |
|---|---|---|---|---|---|
| Detail View Backdrops | item detail pages (replaces native rotation, Chromium only) | `Backdrops`: `settings`, `allowed-indices` | `Backdrops*` (14) | ❓ | |
| People Backdrops | person pages + filmography lists; sources Appearances / Folder / Wallpapers.com (JSON cache per person) | `PeopleBackdrops`: `{personId}?scope=`, `{personId}/folder-image`, POST `test-api-key`, POST `wipe` | `PeopleBackdrops*` (19) | ✅ Wallpapers.com (Session 113, Keanu Reeves `25fbc31c…`) | Appearances/Folder ❓ |
| Genre Backdrops | library view filtered by genre | `Backdrops/genre-pool` | `BackdropsGenre*` (11) | ❓ | |
| Studio Backdrops | library view / studio pages | `Backdrops/studio-settings`, `studio-image` | `BackdropsStudio*` (6) | ❓ | |
| Tag Backdrops | library view filtered by tag | `Backdrops/tag-pool` | `BackdropsTag*` (8) | ❓ | |
| Favorites Backdrops | favorites view; People cascade | `Backdrops/favorites-pool`, `favorites-people-pool` | `BackdropsFavorites*` (39), `BackdropsFavoritesPeople*` (3) | ❓ | |

All backdrop rotation timing runs through `Core.createBackdropRotationEngine()` (tested by `tests/test_rotation_engine.py`).

## Cross-cutting

- **Gate system** (`EP_TREE`/`EP_FIELDS` in configPage.html): every Show-on/Enable/greying rule — Fibel rules 0–26, `tests/run_checks.py`.
- **Naming modes**: Movies Standalone/Prefixed/Folder; TV Standalone/Folder (series main folder); Sets always Standalone.
- **Known gaps (never scoped)**: no library-view mechanism for Postercase/Keyart; Import button lacks `.raised`; no dedicated tests for Animated Poster/Keyart and the Sets checkboxes.
- **Client logging**: every module logs through `Core.makeLogger`; silent by default, enabled per page with `localStorage.ArtworkPlusDebug` = `all` or a tag list (`ArtworkPlusCore.setDebug('CaseMod,Backdrops')`, reload). Server side: `config\logging.json` overrides `Jellyfin.Plugin.ArtworkPlus` to Debug.

## Live-test order (Session 114+)

1. Case Mod → 2. Animated Poster/Keyart → 3. Custom Poster/Keyart → 4. Extraposter/Extrakeyart → 5. Characterart → 6. Red Carpet → 7. Detail View Backdrops → 8. People Backdrops (Appearances, Folder) → 9. Genre/Studio/Tag/Favorites Backdrops → 10. Gate system on the real config page.
Each step: find fixtures via API (`Items?…` + the feature's own endpoint), jump by hash, check DOM + console + screenshot, write the report, update this map.
