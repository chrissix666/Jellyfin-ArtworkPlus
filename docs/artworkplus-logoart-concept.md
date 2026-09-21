# ArtworkPlus — LogoArt concept

**Purpose of this file:** the single entry point for the LogoArt tab (Session 133 design,
2026-09-20/21) — what vanilla does with logos, what the tab replaces, every decision the
user made, the field structure, and what is deliberately out of scope. Written BEFORE the
first line of code (Fibel header rule, rule 28). Parts A–F are the design; Part G lists
the open points; Part H records the implementation once it exists.

Category: **intervene / replace** (like Posters and Backdrops), not *add* (like Characterart
and Red Carpet). The target is vanilla's own logo slot on detail pages; everything LogoArt
does happens in that slot. Persons are the one deliberate exception (vanilla never shows a
logo there — LogoArt adds one).

---

## Part A — What vanilla does (jellyfin-web / jellyfin 10.10.7, verified in source)

### A1 Where a logo is displayed
| # | Place | Source | What | Scope |
|---|---|---|---|---|
| 1 | **Detail page** `.detailLogo` | `itemDetails/index.js:677 renderLogo()`, `logoImageUrl()` `:660` | item logo, else parent logo (`ParentLogoImageTag`/`ParentLogoItemId`) | the ONLY logo-as-logo place; no setting |
| 2 | Logo view of lists | `list.js:531 preferLogo` → `cardBuilder.js:290` | logo **as the card image** (backdrop shape) when the user picks image type "Logo" in a `list.html` view (per list, per user, key `items-<parentId|type>-imageType`) | **out of scope** (Part F) |
| 3 | Card footer logo | `cardBuilder.js:922 showLogo` | 40 px parent logo in the card footer | dead path: no page passes `showLogo` |
| 4 | Dashboard now-playing | `dashboard.js:507` | admin dashboard | out of scope |

Not a logo: `splashLogo`, `pageTitleWithLogo`, `logoScreensaver` (Jellyfin's own brand).

### A2 The `.detailLogo` box (`librarybrowser.scss:495`)
```
width: 25vw; height: 16vh; position: absolute; top: 10vh; right: 25vw;
background-size: contain; background-repeat: no-repeat; background-position: center center;
```
→ right edge 75vw, left edge 50vw, **centre 62.5vw**, no fixed aspect ratio. Hidden by
`display:none` in `.layout-mobile`, `.layout-tv` and below `max-width: 68.75em` (1100 px)
(`:928-936`). Requested without a size (`logoImageUrl(item, apiClient, {})` → original file).
Nothing in vanilla anchors to `.detailLogo`.

### A3 Which items can carry a logo (server)
`LocalImageProvider.cs:194-208`: `logo.*`, else `clearlogo.*` → `ImageType.Logo`;
`clearart.*` → `ImageType.Art`; NOT for **Episode, Audio (song), Person** (Photo has no local
metadata). Folder prefix rule: in a mixed folder `<name>-logo.*`, otherwise `logo.*` in the
item's own folder — folders themselves (Home Videos sub-folders, collections) can therefore
carry `logo.png`.
`DtoService.cs:1296-1350`: an item without its own Logo/Art inherits the first one found
**up the parent chain** (`while` loop: parent → grandparent → …; MusicAlbum → artist) as
`ParentLogo*` / `ParentArt*`. A home video in `Urlaub/Tag 3/` shows `Tag 3/logo.png`.
Default download options (`TypeOptions.cs`): Logo on for Movie/Series/BoxSet/MusicVideo/
MusicArtist; **Art off everywhere (limit 0)** and no built-in provider fetches clearart —
clearart exists only when the user (or a third-party scraper) puts it there.

### A4 Item groups that end on a detail page with a logo slot (each type verified to be
instantiated by a resolver — lesson A15: a class alone proves nothing)
| Group | Types | Logo | Note |
|---|---|---|---|
| Movies | Movie | own | |
| TV shows | Series, Season, Episode | own / own→series / series only | Episode never has a file |
| Sets | BoxSet | own | |
| Videos | Video (Home Videos, Mixed), MusicVideo | own or inherited from the folder | **Trailer is not a type any more** (0 instantiations; trailers are a movie's extras) |
| Music | MusicAlbum, MusicArtist | own; album ← artist | |
| Books | Book, AudioBook | own (AudioBook passes the provider's `typeof(Audio)` check) | practically never has logos; offered for completeness |
| — | Folder, CollectionFolder, PhotoAlbum, Playlist | own | **no detail page** (`appRouter.js:457` → `list.html`) → only in the logo view → out of scope |
| — | Person | none possible (provider) | Part D |
| — | Live TV | remote only, unusual | out of scope |

### A5 Clearart facts
`ImageType.Art`, file `clearart.*`, the item's OWN clearart is in every detail DTO
(`DtoOptions` default = all image types), URL `/Items/{id}/Images/Art`. **Correction
(Session 134, source):** `DtoService.AddInheritedImages` hard-codes `artLimit = 0` ("Emby
apps are not using this") - vanilla never fills `ParentArt*`; clearart inheritance up the
parent chain exists only through our own `/LogoArt/{itemId}` walk. Never rendered by the web client. Fanart.tv norm: **1000 × 562
(16:9)**, transparent, character + logo.

### A6 Our own related pieces
- Characterart (`RenderArt-v1.js`, `CharacterartController.cs:324-396`): Movie, BoxSet,
  Series, Season, Episode only; 1…n images, rotation block; **Top positions**: box bottom on
  the ribbon line (`.itemBackdrop` bottom − `.detailRibbon` 7.2em), TopLeft ends at 50vw,
  TopRight starts at 75vw — vanilla logo edges as CSS constants, `.detailLogo` used only as
  the DOM insertion point (`:113-128`), never measured. Moving/replacing the logo does NOT
  move Characterart (user decision: overlap is the user's business).
- Keyart / Animated Keyart burn a logo into the poster server-side — unrelated.
- Red Carpet / People Backdrops Folder: person-folder file lookup via our own endpoint
  (`InternalMetadataPath`) — the pattern for Part D's Folder mode.

---

## Part B — Tab structure (user decisions)

- Tab **LogoArt**, `data-tab="logoart"`, positioned **before Characterart**. Client code in
  `Jellyfin-ArtworkPlus-RenderArt-v1.js` (third IIFE — "invisible images" script).
- Main switch on the General tab (F-rule). **No format list** (the sources come from
  Jellyfin's image DB / our endpoints, a list would filter nothing); therefore no in-tab
  Enable from a format list — the Case-Mod pattern.
- Groups everywhere, same labels and order: **Movies · TV shows · Sets · Videos · Music ·
  Books** (+ **Persons** as its own block, Part D).
- Consistency ground rule (Fibel rule 28): every building block reuses an existing one —
  tab head, collapses, Show-on multi-checkboxes, Enable⇄Show-on sync, `EP_TREE`, config
  prefix `LogoArt*`, one-line descriptions, tests. Parallel structures only where noted in
  Part E.

### B1 One block per item type (user decision, 2026-09-21)
Groups are collapsible headings only; every item type below them has its own settings:
**Movies** → Movie · **TV shows** → Series, Season, Episode · **Sets** → Set · **Videos** →
Video, Music video · **Music** → Album, Artist · **Books** → Book · **Persons** (Part D).
"Movies on Clearart, series hidden, episodes on Characterart" is therefore just three
dropdowns. There is NO separate "Hide" block and no "Hide all" switch: Hide is a value of
`Source`; a switch overriding eleven dropdowns has no precedent in the plugin (rule 28).

### B2 Rows per item type (order as listed)
| Label | Values (dropdown order) | Description (≤ 105, house style) |
|---|---|---|
| `Source` | Vanilla logo · Clearart · Characterart¹ · Hide | Vanilla logo: Jellyfin's own. Clearart: the clearart image. Characterart: our art. Hide: empty slot. |
| `Fallback` | None (Skip) · Vanilla logo · Clearart · Characterart¹ | Used when the source has no image. None: the slot stays empty. |
| `Second fallback` | None (Skip) · … | Used when source and fallback both have no image. |
| `Source mode`² | Movie / Video / Music video: Default · Item only · Parent folder · Grandparent folder — Season: Default · Season only · Series — Episode: Default · Season · Series — Album: Default · Album only · Artist | Default: item first, then its parents like Jellyfin. Any other value: that level only. |
| `Size` | number, 100 | Percent of the vanilla slot. 100 = as Jellyfin draws it. |
| `Offset` | number, 0 | Shifts the whole slot in vw (negative = left, positive = right). 0 = vanilla position. |
| `Vertical offset` | number, 0 | Shifts the whole slot in vh (negative = up, positive = down). 0 = vanilla position. |
| Rotation rows¹ (shown while any stage is Characterart) | Image mode · Order · Playback · Random start · Stay static · Display duration · Transition duration | texts 1:1 from the Characterart tab |

¹ Characterart only for Movie, Series, Season, Episode, Set (our controller knows no other
types; Season/Episode always resolve to the series folder, so no Source mode applies to it).
² Only inheriting types (`SupportsInheritedParentImages`: Video/Movie/MusicVideo via Video,
Season, Episode, Album). Series, Set, Artist, Book inherit nothing → no row. Values follow
the user's own OSD script (`movieSourceMode: default | file | parent | grandparent`,
`tvShowSourceMode: default | episode | season | series`) — verified against the server's
`AddInheritedImages` chain (item → parent → grandparent … → collection folder; episode →
season → series; album → artist). "Item only" = the vanilla "no fallback"; "Episode only"
does not exist (episodes never own a logo/art file). The chain selects use the
`epSyncSetFallback` pattern (later stages disable chosen values, None ends the chain);
the Source mode applies to the Vanilla logo and Clearart stages alike (both are the
server's inheritance chain); the Characterart stage ignores it (our controller resolves
Season/Episode to the series folder regardless).

Resolution (`/LogoArt/{itemId}`, server): walks the parent chain once (`GetParent()`,
`Series`/`Season`/`MusicArtist` links) and returns per level the Logo/Art tags, plus the
Characterart image list — the client never fetches parent items itself (the script needed
2–3 API calls per page for that). The first stage whose image preloads wins; no live
switching between sources (only Characterart's own rotation).

### B2a Tab head and group intros (house style: one line per category = what, where, whence)
- Tab head: `Logo and clearart from Jellyfin, fanart.tv or our own Characterart in the logo slot of detail pages.` /
  `Person logos from a file in the person folder, or the name rendered in a bundled signature or title font.`
- Movies: `Logo slot on movie pages: keep, hide, or replace with Clearart or Characterart.`
- TV shows: `Logo slot on series, season and episode pages, each with its own source.`
- Sets, Videos, Music, Books: same pattern; Persons: `A logo for person pages, where Jellyfin shows none: file or rendered name.`

### B3 One container, always ours
Vanilla's `.detailLogo` stays in the DOM and is hidden from the first paint whenever LogoArt
acts on the group; our own element shows the winning source — also when "Vanilla logo" wins
(same image, same geometry + Size/Offset). One code path, no fight with vanilla's lazy
loader, Characterart's DOM anchor untouched. **Zero-intervention rule:** a group whose chain
is Vanilla logo / Size 100 / Offset 0 / nothing hidden is not touched at all — vanilla works
alone.

Prehiding, sharpened (2026-09-21): a FileTransformation style cannot know the item type,
so the style hides `.detailLogo` **globally** as soon as at least one type deviates from
Vanilla logo / 100 / 0 / 0 (all types at that default → no style, nothing at all). The
client asks `/LogoArt/{itemId}`, which also returns the type; for a zero-intervention type
it adds ONE class that releases `.detailLogo` again and touches nothing else (no container,
no image, no geometry). Source facts: `itemDetails/index.html:4` — `.detailLogo` is empty
in the template; the image arrives only in `renderLogo()` (`index.js:678-687`) after the
item fetch through the lazy loader, so the release class never races with a painted logo.

### B4 Geometry (hard-coded per source; Size/Offset shared by the whole chain)
| | Vanilla logo | Clearart | Characterart | Text (Persons) |
|---|---|---|---|---|
| Images | 1 | 1 | 1…n (Characterart MultiImage block reused) | 1 (rendered) |
| Box width | 25vw | 25vw | 25vw | 25vw |
| Aspect ratio | none (25vw × 16vh, vanilla) | **16:9** (fixed) | **1:1** (fixed) | like logo |
| Vertical anchor | top edge 10vh | **bottom edge = ribbon line** | **bottom edge = ribbon line** | top edge 10vh |
| Image in box | contain, centre | contain, **bottom** | contain, **bottom** | text fitted, centre |
| Horizontal | centre 62.5vw | same centre | same centre | same centre |
| Upper limit | — | box shrinks until it fits below 10vh | same | — |
| Hidden < 68.75em / mobile / TV | vanilla parity | same | same | same |

Size & reposition (one set per group, valid for every stage so a fallback never jumps):
| Field | Default | Range | Effect |
|---|---|---|---|
| Size | 100 % | 25–300 | scales box width and height; the anchor stays |
| Offset | 0 vw | −30…+30 | shifts the box horizontally (+ = right) |
| Vertical offset | 0 vh | −30…+30 | shifts the box vertically (+ = down) |

Clearart and Characterart "need a floor" (user): their bottom edge sits on the same ribbon
line Characterart Top already uses; the logo may float. Because width and centre are
identical for every stage, a fallback only changes whether the image hangs centred at the
top or stands on the ribbon line — nothing on the page moves (absolute positioning).

---

## Part C — Behaviour rules
- Vanilla parity for hiding: below 68.75em and in the mobile/TV layouts our container is
  hidden exactly like `.detailLogo` (the user only uses the desktop web layout).
- Preload before show; a failed image = next stage (B2).
- Characterart in the slot is **independent of the Characterart tab's behaviour** (user
  decision 2026-09-21): its Enable and Show-on flags have no effect on the slot, and the
  slot has its own rotation rows (Image mode/Order/Playback/Random start/Stay static/
  Display duration/Transition duration per type, visible only when a stage is
  Characterart). Only the FILE LOOKUP is shared: the Characterart tab's Naming mode, Type
  name, Folder name and Allowed formats define what a characterart file is called on disk,
  so the same files feed both places (no second naming block, rule 28). Server side: the
  file-list part of `CharacterartController.ResolveItem` becomes a shared helper; the
  Show-on gate stays in the Characterart endpoint only.
- Double image with the Characterart tab (same picture in the slot AND at Characterart Top)
  is the user's business — no automatic precedence (decision 2026-09-20). The description
  says so in one line.
- Logging through `Core.makeLogger('LogoArt')`: resolved chain, winning stage, geometry.

---

## Part D — Persons (the deliberate "add" exception)
Vanilla never shows a logo on a person page (provider excludes Person, no provider delivers
one, the parent chain finds none) — the `.detailLogo` element exists in the template but
stays `hide`. Persons already carry Red Carpet and People Backdrops; the logo is the last
piece. Chain for Persons: **Folder logo → Text → None**.

### D1 Folder mode
- One field: **Base name** (pattern: People Backdrops Folder `basename`), file
  `<basename>.png|webp|jpg` in the person's metadata folder (`InternalMetadataPath`, like
  Red Carpet), fixed extension order png → webp → jpg named in the description, served by
  our own endpoint (`/LogoArt/person/{id}/image`). Jellyfin itself never reads it.
- Geometry: the logo row of B4 (the file is a clearlogo, 800 × 310 from the bulk creator).

### D1a Rows of the Persons block (house style)
| Label | Values | Description |
|---|---|---|
| `Source` | Folder logo · Text · Hide | Folder logo: file in the person folder. Text: the name in a bundled font. Hide: empty slot. |
| `Fallback` | None (Skip) · Folder logo · Text | Used when the source has no image. None: the slot stays empty. |
| `Base name` | `clearlogo` | name.ext in the person's folder; png, webp or jpg, first found wins. |
| `Font pool` | Signature · Title · Both | Signature: 60 handwriting fonts. Title: 60 headline fonts. Both: all 120. |
| `Fonts` (multi-select dropdown, `Check all` / `Uncheck all` in the panel) | | Opens a list to tick fonts; hover one for a preview. One: for everyone. Several: one per person by name. |
| `Preview names` | `Scarlett Johansson, Keanu Reeves` | Comma-separated names shown in the hover preview. |
| `Text stroke` | 0 | Thickens the white letters, in percent of the text size. 0 = font as drawn. |
| `Outline` | 1 | Black rim around the letters, in percent of the text size. 0 = none, 1 = a fine line. |
| `Uppercase` | checkbox, off | Title fonts only: render the name in capitals. Signature fonts keep their case. |
| `Size` / `Offset` / `Vertical offset` | as B2 | |
| `Create logos` button + `Mode` Update · Replace + result line | | Writes "Base name".png (800 x 310) with the ticked fonts. Update: missing only. Replace: all. |

### D2 Text mode (rendered live in the browser)
- **Font pool** dropdown: Signature / Title / Both.
- **One checklist** of the pool's fonts (checked = in use), `Check all` / `Uncheck all`
  buttons. **1 checked = the same font everywhere; ≥ 2 = random.** (Replaces the earlier
  ideas "fixed vs random mode" and "inclusion vs exclusion list" — the same list, one view.)
- Random is **stable per person**: font index = hash(person name) mod (checked count) — the
  same person always gets the same font on every device, no storage; changes only when the
  list changes. The bulk creator (D3) uses the same hash → identical result.
- **Hover preview** in the checklist: two sample names (text field, default
  "Scarlett Johansson / Keanu Reeves") rendered as live text in the hovered font (white,
  outline via CSS) — no pre-rendering; the font's WOFF2 (30–100 KB) loads on first hover via
  `@font-face` from our endpoint; the pool may be preloaded when the tab opens.
- **Text stroke** (white, thickens the glyphs) default **0**, and **Outline** (black rim)
  default **1** — both 0…3, step 0.1, relative to the font size (em fractions) so they look
  the same at every window size; shown as plain numbers. Colours fixed white/black for now.
- **Uppercase (Title fonts)** checkbox — never applied to Signature fonts.
- Glyph rule at runtime: a font missing an accented letter renders the NFD-normalised name
  (Á → A, ł → l, ß → ss, ø → o, æ → ae); punctuation is complete in every pool font
  (filtered); if nothing fits → Noto Sans (Jellyfin's own font).
- Text is fitted into the box like the user's script (binary search on the font size).

### D3 Bulk clearlogo creator (server, admin button)
- Button block like People Backdrops' `Wipe cache` / `Test API key` (POST + result line):
  `Create logos` with **Update (missing only) / Replace (all)** — the user's script 1:1:
  800 × 310 PNG, transparent, white text, 1 px black outline, fitted, centred, written as
  `<basename>.png` into every person folder.
- Same checklist and same hash as D2: 1 font → identical everywhere; more → per-person
  random, identical to what the live text mode would show.
- Rendering with **SkiaSharp** (Jellyfin 10.10 ships it for its own image pipeline) using
  the bundled fonts.

### D4 Font pools (built 2026-09-20/21, `Fonts/` in the project)
- **Signature: 60** families from the user's collection (151 files → −30 "Personal use only"
  licences, −20 missing punctuation, −8 duplicates, −33 by eye). Licence: the user's legal
  advice, "no licence stated" may ship under the project's MIT (recorded as a user decision;
  30 explicit personal-use fonts excluded). Files stay in
  `Project Files\LogoArt Fonts\_excluded\<reason>` for reference.
- **Title: 60** families from Google Fonts (`github.com/google/fonts`, SIL OFL / Apache),
  chosen from the Display category by popularity plus classic title sans/serifs, −6 without
  Latin accents, −57 by my pre-sort (rounded/childlike, hairline/text faces, scripts,
  effects), −13 by the user's eye (+2 restored). Arial/Times are Monotype — not shippable;
  the OFL equivalents Arimo/Tinos can be added if wanted.
- Delivery format **WOFF2** (lossless, 30–50 % smaller, one extension for the repo);
  variable fonts instantiated at their heaviest upright weight. Total **4.7 MB**.
  `Fonts/fonts.json` = manifest (family, file, source, licence, glyph coverage flags).
  Both pools ship in the repo/next to the DLL like `CaseTextures/` — **single track**, no
  user folder; adding fonts means a new build.
- Coverage check basis: the library's 79 907 person names (2.48 % contain non-ASCII; core
  accents = 34 characters occurring in ≥ 5 names).

---

## Part E — Where a parallel structure is allowed (and why)
| Piece | Existing pattern | New part | Reason |
|---|---|---|---|
| Font dropdown (multi-select) + hover preview overlay | checkbox rows, `epSelectCompact` look | closed = select-like button with the summary, open = floating panel with one checkbox per font, hovering an entry floats a live-text preview next to it (user's idea 2026-09-21) | no other feature chooses among 120 visual options |
| Font endpoint `/LogoArt/font/{file}` | `/CaseMod/Texture/{type}/{key}` (no auth, ETag) | — | same pattern |
| Bulk creator | People Backdrops POST buttons | SkiaSharp text rendering | server-side rendering exists nowhere else yet |

Everything else (groups, chain selects, Size/Offset, MultiImage block, prehiding, container
lifecycle, logging, tests) is existing vocabulary.

---

## Part F — Out of scope (decided)
- The **logo view** of `list.html` (image type "Logo" per list) and therefore folder logos
  as card images; the dead card-footer logo; the dashboard.
- TV / mobile layouts (the user runs Jellyfin Web desktop only; vanilla hides the logo there
  and so do we).
- Live TV items, Playlists, PhotoAlbums.
- Own logo files as a further source for Movies/TV/… (the user's "own logo options" turned
  out to be Clearart/Characterart/Persons; a file source would need a format list again).
- Colour pickers for text/outline; per-font stroke weights.

---

## Part G — Open before implementation
1. ~~Fibel Part C row~~ — done 2026-09-21 (in the Fibel, Part C).
2. ~~Labels and descriptions~~ — done: the user delegated the wording ("ich vertraue dir");
   the texts in B2, B2a and D1a are final.
3. Exact `EP_TREE` nodes: group blocks as sibling collapses under the tab root
   (`epCollapseNested` per depth), chain selects + Size/Offset inside `LogoArt<Group>
   DependentFields`, Hide main switch greying the Hide row, Persons block with the
   Folder/Text sub-collapses, MultiImage rows gated by `AnyValueIn(chain, Characterart)`.
4. Endpoints: `/LogoArt/{itemId}` (resolved chain + geometry + Characterart image list),
   `/LogoArt/person/{personId}/image`, `/LogoArt/font/{file}`, `POST /LogoArt/create-logos`.
5. Tests: `test_configpage.py` block (gates, chain sync, hide switch), render test for the
   container per source (geometry classes, hidden below 68.75em), font manifest test (every
   listed file exists, punctuation complete), description length.
6. Deploy: full (C#, configPage, Core prehiding style) + fonts next to the DLL (csproj
   `Content Include="Fonts\**\*.woff2"` like CaseTextures).

### Draft Fibel Part C row
| **LogoArt** (Session 133) | no format list (sources are DB images / own endpoints) | no in-tab Enable; General switch only (Case-Mod pattern) | yes: eleven item-type blocks under six group collapses + Persons (Folder/Text/Creator) | chain selects + Source mode + Size/Offsets inside `LogoArt<Type>DependentFields` (one per type); Persons' checklist inside `LogoArtPersonsTextFields` | yes, per type | Chain selects follow `epSyncSetFallback` (later stages disable chosen values, None ends); Characterart option only in Movies/TV/Sets; MultiImage rows gated by `AnyValueIn(chain, Characterart)`; the font checklist's hover preview is the tab's one new UI form (Part E) |


---

## Part H — Implementation (Session 134, 2026-09-21)

Everything of Parts A–G is implemented, tested and deployed (deploys #54/#55). Deviations
from the design, each with its reason:

- **Fonts ship as `.otf`, not WOFF2.** SkiaSharp (the bulk creator) cannot open WOFF2;
  `.otf` is the one extension valid for both TrueType and CFF outlines (34 of the 120 pool
  fonts are CFF). 11.6 MB total; a font loads only when hovered or shown. Anton's licence
  corrected to OFL (it came from the user's collection, not the download report).
- **Stroke / Outline in percent of the font size** (not em): 1 = 0.01em, a fine rim like
  the user's 1 px script line; em would have been 100 x too thick (seen in the preview).
- **Glyph rule on the server**: `LogoTextRenderer.GlyphSafeText` opens the real font with
  SkiaSharp and returns the normalised name when a glyph is missing; the client renders
  `stage.Text` as delivered - live text and PNG cannot disagree.
- **Font pick on the server** (`PickFont`, FNV-1a of the NFC name mod ticked count) for the
  same reason.
- **Fonts UI = dropdown** (user decision during the build): a select-like button with the
  summary ("60 of 60 Signature fonts - one per person"), a floating panel with the
  checkboxes and Check all / Uncheck all, a hover overlay with the preview names in the
  hovered font (two stacked layers exactly like the live text).
- **Characterart stage** uses `CharacterartController.ResolveSlotImages` (shared file
  lookup, no Show-on gate, the LogoArt type's own rotation fields) and its own image
  endpoint `/LogoArt/{id}/characterart/{file}`; the Characterart controller only gained
  methods (`git diff`: 0 removed lines).
- **Prehiding** as sharpened in B3: `FileTransformationRegistrar.LogoArtIntervenes` decides
  per index.html load; the release class is `artworkplus-logoart-vanilla`.
- **`POST /LogoArt/create-logos` takes an optional `Names`** (comma-separated, API only) to
  run for a few persons - the library has 79 907 persons.
- **EP_TREE**: group nodes manage the six group collapses, terminal type nodes the nested
  collapses / `DependentFields`; the rotation rows sit in `LogoArt<Type>RotationFields` so
  every child target is inside its parent's (a row targeted by parent AND child is cleared
  by the containment skip - found by the first test run). The rotation / Text / Base name
  gates also require a non-Hide source (Hide ends the chain, greyed fallbacks do not count).

Tests: `test_configpage.py` S134 block (386 total), `test_logoart_render.py` (24 DOM
checks: zero intervention, slot/floor geometry, Size/Offset, chain skip, Hide, rotation,
real font fitted + re-fitted), `test_logoart_fonts.py` (14), description length 552 at 1920
px, all diagnostics; `run_checks.py --all` 18/18. Live (2026-09-21): Star Trek: Nemesis
Clearart standing on the ribbon line (box bottom = `.detailRibbon` top to the pixel),
episode inheriting the series logo with Source mode Series, Season Hide, Keanu Reeves as
live Biancha text and, after `Create logos` with `Names`, as the written 800 x 310 PNG in
the same font; admin dropdown + overlay on the real endpoint. The user's config was
restored byte-identical afterwards.
