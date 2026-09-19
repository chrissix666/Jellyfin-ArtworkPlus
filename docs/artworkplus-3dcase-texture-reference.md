# 3D Case — texture reference (Sessions 40–48)

Complete, verified list of all textures for the fourth case type
"Viva Elite 3D Case" (folder `CaseTextures/vivaelite3dcases`, dropdown
label "Viva Elite 3D Case", `CaseModType` value `vivaelite3dcases`).
Source: the Aeon MQ Kodi skin, file `Includes_ViewShelf_595.xml`
(includes `Sh3D_view`, `Sh3D_item`, `Sh3D_focused`) together with
`variables.xml` (variable `GlobalCaseVarTajoBox`). Every line of the
source file was checked individually (Session 40, "100% check") — all
required files confirmed present. The original skin files live under
`tajo/shelf/` or `tajo/` in the Kodi skin — with us they sit flat in the
case folder, like our other three case types.

Session 48 (user inventory review) found that only 19 of the files had
actually been copied; the missing 21 (`set.png`, all `back_*` and
`reflect_back_*` counterparts) were added, giving the 40 files present
today. The runtime texture-key list lives in `CaseModController.cs`
(`ValidTextureKeys`): `480p, 540p, 576p, 720p, 1080p, 4k, 3d, p, tvseries,
set` plus their `back_` counterparts.

**Most important difference to Viva Elite/Clear/Vortex Case:** instead of
a plain inside view this case type has a **real back side** — while
turning, the user sees the back of the case including optional extra
artwork (banner/logo/backdrop/spine), not just an empty inner surface.

---

## Part A — The categories × 3 (front / back / reflect-back)

Each category has exactly three files: the front, the back, and a
reflection helper texture ONLY for the back (see Part C for why only the
back needs a reflection and why the front reflection — `r[type].png` in
the original — is NOT adopted).

| Jellyfin condition | Skin name (front) | Skin name (back) | Skin name (reflect-back) | Our names |
|---|---|---|---|---|
| `Height >= 2160` (4K/8K) | `4k.png` | `b4k.png` | `rb4k.png` | `4k.png`, `back_4k.png`, `reflect_back_4k.png` |
| `Height 1080–2159` | `1080p.png` | `b1080p.png` | `rb1080p.png` | `1080p.png`, `back_1080p.png`, `reflect_back_1080p.png` |
| `Height 720–1079` | `720p.png` | `b720p.png` | `rb720p.png` | `720p.png`, … |
| `Height 576–719` | (540p/576p reuse the 480p art in the skin) | | | `576p.png`, … |
| `Height 540–575` | | | | `540p.png`, … |
| `Height < 540` | `480p.png` | `b480p.png` | `rb480p.png` | `480p.png`, … |
| `Video3DFormat != null` | `3d.png` | `b3d.png` | `rb3d.png` | `3d.png`, … |
| `Type == "Series"` | `tvshow.png` | `btvshow.png` | `rbtvshow.png` | `tvseries.png`, `back_tvseries.png`, `reflect_back_tvseries.png` (always, regardless of any video file) |
| `Type == "BoxSet"` | `set.png` | `bset.png` | `rbset.png` | `set.png`, `back_set.png`, `reflect_back_set.png` |
| Fallback (no resolution determinable) + ISO | `p.png` | `bp.png` | `rbp.png` | `p.png`, `back_p.png`, `reflect_back_p.png` |

**Dropped, no Jellyfin equivalent or not needed (Session 40, explicit user decision):**
- `hddvd.png` / `bhddvd.png` / `rbhddvd.png` — obsolete format, no equivalent for us.
- `season.png` / `bseason.png` / `rbseason.png` — not needed.
- `r480p.png` … `rset.png` (the FRONT reflections) — deliberately not adopted. See Part C (the front is not shown mirrored separately with us, only the back).

---

## Part B — Renaming pattern of the category-specific files

| Skin name (pattern) | Our name (pattern) | Purpose |
|---|---|---|
| `[type].png` | `[type].png` (unchanged) | Front of the case for this category |
| `b[type].png` | `back_[type].png` | Back of the case for this category |
| `rb[type].png` | `reflect_back_[type].png` | Mirrored, faded copy of the back — for the glossy-floor reflection effect below the case |

---

## Part C — The shared helper textures (once each, not per category)

| Skin name | Our name | What it is | What it is used for |
|---|---|---|---|
| `back.png` | `back_blank.png` | Empty, plain back plate without text/info | Fallback base back when none of the info variants (below) applies |
| `back_black.png` | `back_info.png` | Full back-side info template: legal text, language/audio specs, barcode | Together with `back_info_mirrored.png` as a composed back panel |
| `back_black2.png` | `back_info_mirrored.png` | The same info template, mirrored (barcode on the other side) | Second layer of the same composed panel — Session 40 finding: both are used directly one after the other in the code |
| `back_blackf.png` | `back_info_reflect.png` | The same info template as its own variant only in the **focused** state of the item, combined with the light mask `shading_mask.png` | Back-panel rendering when the item is selected/focused (separate code path from the unfocused rendering) |
| `backset.png` | `back_set_texture.png` | Dark, structured carbon/grid background texture with a soft lighting gradient (brighter in the middle) | Own background only for the Set variant of the back (instead of the generic info template) |
| `diffuse_box.png` | `shading_mask.png` | Almost completely white mask (average 253.8/255), only minimally darker in a few places | Extremely subtle shadow/depth accent applied as a `diffuse=` mask over the poster or `back_blackf.png` — for the 3D effect, practically invisible |
| `reflect_box_overlay.png` | `reflect_vignette.png` | Vignette mask: centre bright (255), corners/edges completely black (0) | Laid as a `diffuse=` mask over the case AND poster reflections — lets the reflection fade naturally at the edges instead of cutting off hard |
| `thumbfall.png` | `fallback_backdrop.png` | Generic placeholder image | Fallback for `ListItem.Art(fanart2)` (additional backdrop) when the item has none |
| `fallban.png` | `fallback_banner.png` | Generic placeholder image | Fallback for `ListItem.Art(banner)` when no banner artwork exists |
| `falllog.png` | `fallback_logo.png` | Generic placeholder image | Fallback for `ListItem.Art(clearlogo)` when no logo artwork exists |

Not adopted as separate files: `textset.png` (pure barcode used with `flipy="true"` together with `back.png` — part of the same mirrored back composition as `back_blank.png`, never isolated) and `mask_cover3.png` (round-corner mask, 504×504px, alpha only — in the original skin applied to EVERY inserted user artwork so square artwork fits the rounded case corners; **with us CSS `border-radius` does exactly this**, so the file is not needed).

---

## Part D — Real Jellyfin metadata (NOT a file, comes from the item itself)

These six "art" types from the Kodi skin have NO image of their own with
us — they come 1:1 from the respective Jellyfin item when present. If one
is empty, the matching fallback from Part C applies.

| Kodi `ListItem.Art(...)` | Jellyfin equivalent | Fallback from Part C if empty |
|---|---|---|
| `back` | no standard field — practically always empty, the fallback almost always applies | `back_blank.png` / `back_info.png` / `back_set_texture.png` (per category) |
| `spine` | no standard field — practically always empty | *(no dedicated fallback identified, simply left empty)* |
| `discart` | Disc artwork (exists in Jellyfin) | *(no fallback in the original code — simply not shown when empty)* |
| `banner` | Banner artwork | `fallback_banner.png` |
| `clearlogo` | Logo artwork (already used by Custom Poster/Keyart) | `fallback_logo.png` |
| `fanart2` | additional backdrop (e.g. `Backdrop/1`) | `fallback_backdrop.png` |

---

## Part E — Explicitly NOT adopted files (from the original skin, irrelevant for us)

For clarity, so nothing gets confused — these files appeared in the
investigation but do NOT belong to the 3D case list:

- `reflect_poster.png`, `reflect_poster2.png`, `reflect_box_overlay2.png` — appear NOWHERE in `Includes_ViewShelf_595.xml` (the 3D case file). Belong to other views (e.g. `View_598_Shelfm.xml`, partly in the CD/music context).
- `caja_cd.png`, `caja_cdr.png`, `caja_cd_b.png`, `caja_cd_br.png`, `corner.png` — CD/music-specific or not in our zip at all, irrelevant for movies.
- `spiner.png` — completely unused, orphaned file in the whole skin (the hit "spiner" refers to a FONT of the same name, not this image file).
- `hddvd.png`/`bhddvd.png`/`rbhddvd.png`, `season.png`/`bseason.png`/`rbseason.png` — see Part A, dropped.
- `r480p.png` … `rset.png` (front reflections) — see Parts A and C, deliberately not adopted.
- `movieposter_mask_reflect.png` — had been copied to `CaseTextures/` at some point but was never referenced by code or docs; removed in Session 111.

---

## Part F — Important technical insights from the analysis (Session 40)

1. **The `r` prefix (front reflection) is NOT pre-mirrored in the file itself.** Pixel comparison confirmed: unflipped, the file matches the real front almost perfectly (deviation 18), flipped not at all (deviation 159). The actual mirroring happens at render time via the `flipy="true"` attribute in the skin code — not in the PNG. The same principle applies to `rb` (back reflection). **CSS equivalent: `transform: scaleY(-1)`.**
2. **Why the upper area in the reflection files is transparent (alpha=0), not just faded:** after mirroring, what is at the top of the file ends up at the bottom of the reflection — right at the seam to the real case above it. The logo/info bar would otherwise visibly appear doubled there. Making exactly this area transparent beforehand lets it vanish inconspicuously at the seam. **This is a workaround for a real CSS/Kodi limitation:** a single transformation (`flipy`/`scaleY(-1)`) always mirrors the WHOLE element; you cannot mirror only a part. In CSS there would be a more elegant alternative without a second file: `mask-image` with a gradient, computed at runtime.
3. **The whole 3D case rendering (front, back, both reflections) hangs on a single visibility condition:** `Skin.HasSetting(Sh3D)` — a skin setting the user can toggle. When off, the whole block is not rendered at all (presumably a simpler, flat poster rendering applies). For us this means: the "3D Case" type is conceptually a replacement rendering mode, not an additional overlay on the other three case types.
4. **`View_595` and `View_598` are two different Kodi views with different case systems.** `View_598_Shelfm.xml` (the view with the turn animation + flying-out disc) uses NO format-specific badge textures at all — it shows the real poster directly (`$VAR[poster]`) with `shading_mask.png` and a generic `back_blank.png` back. The complete 3D case texture logic documented here (all categories) lives exclusively in `Includes_ViewShelf_595.xml`, referenced via the variable `GlobalCaseVarTajoBox` from `variables.xml`.
5. **Completeness verification, without gaps:** every single `<texture>`/`<imagepath>` line in `Includes_ViewShelf_595.xml` (lines 25 to 910, all three includes `Sh3D_view`/`Sh3D_item`/`Sh3D_focused`) was walked through individually and classified into Parts A–E. No line remained unclassified.

---

## Part G — Folder and dropdown convention

- **Folder name:** `vivaelite3dcases` (matching `vivaelitecases`/`clearcases`/`vortexcases` — lowercase, no spaces, `cases` suffix; the originally planned `3dcases` was renamed when the type became "Viva Elite 3D Case")
- **Dropdown label:** "Viva Elite 3D Case"
- **`CaseModType` value:** `vivaelite3dcases`
- The `.csproj` copies `CaseTextures\**\*.png` next to the DLL on every build (`plugins/ArtworkPlus_x.x.x.x/CaseTextures/...`), so the textures ship with the code, not with the data folder.

## Coordinate frame of the tilt matrix (Session 129)

The Kodi matrix (`computeKodiMatrix3dString`) projects with a camera fixed at the screen
centre (`buildCameraMatrices`, screen = viewport size). Object position and hinge are taken in
the **design frame**: the element's layout position at scroll 0 (`measureDesignRect` =
viewport rect + scroll offsets of inner scrollers + window). This is the plugin's equivalent
of the skin position in Kodi, which never scrolls. Consequences: scrolling never changes the
tilt; a re-tilt happens only at settle points, on resize and when the card changes size; the
open-case geometry is measured in the same frame, so opening while scrolled does not jump.
No element carries CSS `perspective` - the camera lives in the matrix alone
(`tests/diagnostic_casemod_design_frame.py` guards both facts).
