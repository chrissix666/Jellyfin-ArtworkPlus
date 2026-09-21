# ArtworkPlus audit 2026-09 (read-only, after milestone `milestone-logoart-20260921`)

Findings only - nothing was changed. Severity: blocker / bug / risk / smell /
design / doc. **design** = a deliberate, correctly implemented decision that
the audit verified and that is NOT a fix candidate (changing it would trade
one behaviour for another, user's call only); a "smell" is unintended and
safe to tidy. "know" = proven on two independent ways, "believe" = one way
only.
Areas: 1 server, 2 client, 3 admin page, 4 delivery, 5 docs vs code.

## Area 1 - Server (Session 137, 2026-09-21)

### Coverage

Read in full: every endpoint that takes a file name, index or path from the
request (Extraposter `{itemId}/image/{fileName}` + `child-image`,
Characterart `{itemId}/image/{fileName}` + `ResolveSlotImageFile`, LogoArt
`characterart/{fileName}`, `person/{id}/image`, `font/{group}/{file}`,
CaseMod `Texture/{caseType}/{key}`, Backdrops `custom-image`,
`episode-image`, RedCarpet `{personId}/image`), the Backdrops `settings`
resolver, the LogoArt `create-logos` job, the PeopleBackdrops stream head and
download loop, `Plugin.cs`, the registrar's registration payload and
transform skeleton. Grep-driven over the rest (14 000 lines): item-path
derivation (`ContainingFolderPath`, `Path.Combine`), auth attributes of all
48 routes, cache calls and expiries, static state and locks, sync-over-async
(`.Result`/`.Wait()` - none), Information-level log calls. Dynamic: 47
anonymous probes against the running server (traversal, random/invalid
GUIDs, malformed indices, empty/huge batches, protected routes) and the
server log of 2026-09-21 counted by message kind.

### Check classes

| class | result |
|---|---|
| unhandled exceptions | 0 x HTTP 500 in 47 probes; every file endpoint but four is wrapped in try/catch (S1-04) |
| path traversal | none: every file endpoint serves only a name from its own scan (candidate list / manifest / whitelist / bounded index); 8 traversal probes -> 400/404 |
| AllowAnonymous disclosure | list/batch endpoints return artwork file names and person names - the same class of data Jellyfin's own anonymous `/Items/{id}/Images` exposes; no filesystem paths in any DTO (grep `Path|Folder|Directory` properties: none); admin routes 401 anonymously (probe) |
| cache keys | Extraposter LibResult 30 s absolute + config identity stamp; pools 30 s; file lookups 6 h sliding keyed by folder mtime; entries bounded by library size (S1-09 collision note) |
| concurrency | PopulateLocks `ConcurrentDictionary<Guid, Lazy<Task>>`, LogoArt `JobLock` + static job, Extraposter `Parallel.ForEach` with a local lock - no shared mutable state without a lock found; S1-02 is a state, not a race |
| log volume at Information | the dominant finding, S1-03 |
| config migration | XmlSerializer semantics (missing element = constructor default); legacy `RandomStart*` traversal words accepted server-side (`Helpers/RandomStart.cs:29`, `BackdropsController.cs:1421`, `PeopleBackdropsController.cs:587`) and normalised on load in the page (`epNormalizeLegacyTraversal`) - verified |

### Findings

| ID | file:line | class | sev | finding | evidence | know/believe | recommendation | a fix could break |
|---|---|---|---|---|---|---|---|---|
| S1-01 | `Controllers/PeopleBackdropsController.cs:285-330, 1340-1400` | amplification | risk / design | The anonymous `GET /PeopleBackdrops/{personId}` triggers, for a person without cache file, a Wallpapers.com search plus a full-size `GetByteArrayAsync` download, decode and text detection per candidate image and a cache-file write - no response size cap, no per-client limit. Bounded by: valid person GUIDs needed, `PopulateLocks` dedupes concurrent calls per person, the 7-day empty-cache retry, `MaxImages` <= 10. **Design note:** anonymous by design (the person page fetches the stream like an image); the missing download cap is the only part that is not a decision. Changing the auth touches the client - park until area 2. | code read; probe with a random GUID -> 200 "not found" stream, no fetch | know (static + probe) | leave as is on a LAN server; if the server is exposed: `[Authorize]` on the endpoint (the page is logged in anyway) and a `MaxResponseContentBufferSize` on the HttpClient | client fetches the stream with the page's ApiClient? - verify in area 2 before adding auth |
| S1-02 | `Controllers/LogoArtController.cs:758-796` | state | bug (low probability) | If anything throws OUTSIDE the per-person try (the `LogoTextRenderer` constructor, the Fonts folder unreadable), the `Task.Run` faults, `_job.Running` stays true, `CreateLogos` answers "running" forever and `cancel` cannot reset it - only a server restart. | code read: the only catch is inside the loop | believe (not reproduced - would need a fault injection) | wrap the whole task body in try/finally that sets `Running=false` + `Message` | nothing |
| S1-03 | `AnimatedPosterController.cs:535`, `CustomPosterController.cs:~575`, `CharacterartController.cs:266,272`, `BackdropsController.cs:316`, `FileTransformationRegistrar.cs:489-642` | log volume / perf | risk / design | Information-level lines per item and per image: on 2026-09-21 the plugin wrote 10 425 of the server's 13 016 log lines (80 %): `FindAnimatedFile` 3 511, `FindCustomPosterFile` 1 970 (one line per item per batch on a cache miss), `TransformIndexHtml` 823 (5-8 lines per index.html load), Characterart 786 + 475 + 384 + 183 (per page and per image incl. 304s), `GetSettings` 354. Lesson B25 measured ~1 ms per line on the synchronous console sink - a 500-card library batch with cold cache = ~1 s of logging. Also a `SafeGetLastWriteTimeUtc` stat per item per batch (cache-key design, external drives). **Design note:** the Information level was chosen in the sandbox to diagnose without switching Debug on; what was never decided is the per-item volume - the user re-decides the level, the audit only reports the cost. | log counted by message kind; code read | know | move the per-item / per-image lines to Debug (the batch START/END lines already carry counts), keep one Information line per request; consider `LogDebug` for the transform's per-tag lines | nothing functional; tests grep no log text |
| S1-04 | `BackdropsController.cs:402-410, 1303-1311, 1456-1487`, `PeopleBackdropsController.cs:761-855` | error handling | smell | The four local-file endpoints without try/catch (`episode-image`, `custom-image`, `studio-image`, `folder-image`) answer 500 instead of 404 when the file disappears between the directory scan and `PhysicalFile` (every other file endpoint catches and logs). | code read | believe (needs a file deletion to reproduce - not done, read-only) | same try/catch pattern as `GetPosterImage` | nothing |
| S1-05 | `CaseModController.cs:187` (no attribute), `PeopleBackdropsController.cs:184-196, 761` | auth clarity | smell | Jellyfin 10.10.7 registers no fallback authorization policy (`Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs:64-68` - only `DefaultPolicy`, applied where `[Authorize]` stands), so a controller/endpoint without any attribute is anonymous: CaseMod (both routes) and PeopleBackdrops `folder-image` are anonymous while the PeopleBackdrops class comment describes a deliberate per-endpoint `[AllowAnonymous]` and does not mark `folder-image`. Functionally correct (`<img>` requests carry no token), the comment is misleading. | source read + probe: `folder-image` -> 404 anonymously, not 401 | know | mark the two explicitly `[AllowAnonymous]` and fix the comment, or leave and document | nothing **Resolved 2026-09-21 (comments only, no attribute change):** origin traced - the PeopleBackdrops comment was written before Session 101 added `folder-image` ("the two endpoints" = the sandbox-era pair); the new endpoint copied Studio's `GetStudioImage`, which then sat in a class-level `[AllowAnonymous]` controller (Backdrops was class-level until Session 116), so the pattern it copied never carried an attribute. CaseMod (Session ~11) was written with the knowledge that attribute-less Jellyfin routes are anonymous (its own doc comment cites `ImageController.GetItemImage`, "no [Authorize] on that route") - by convention, not by oversight. Both comments now state the mechanism. |
| S1-06 | `ExtraposterController.cs:1063-1077` | exposure | design | `child-image` serves a movie's postercase / keyart / animated file with no feature switch at all (by design for the Set image types, comment in the feature map) - also with Extraposter, Custom and Animated all off. Same data class as Jellyfin's own anonymous images. **Design note:** Session 125/126 decided the Set image types must work independently of the Custom / Animated switches; a gate on `ExtraposterTabEnabled` would only add what the feature needs anyway - leave unless the user wants the gate. | code read; probe random id -> 404 | know | gate on `ExtraposterTabEnabled` at least | Set image types when Extraposter is the only enabled feature - none, the gate would be the tab switch |
| S1-07 | `LogoArtController.cs:538-549, 773`, naming-mode folder names, `RedCarpetController.cs:261`, `BackdropsController.cs:355` | input hygiene | smell | Admin-typed config strings go into `Path.Combine` unsanitised (`LogoArtPersonsBaseName`, the "Folder" naming-mode folder names, `RedCarpetFolderName`, `BackdropsEpisodeBaseName`): `..\..\x` escapes the item folder; `create-logos` would then WRITE `x.png` there. Admin-only setting - admins own the server anyway. | code read | know | reject path separators / `..` in these fields on save (page) or `Path.GetFileName` on the server | nothing |
| S1-08 | `FileTransformationRegistrar.cs:504-506` | noise | smell | The transform is registered for the pattern `index.html` and is also called with other HTML (three "no </body>" warnings on 2026-09-20/21 with content lengths 1 134 / 5 062 / 11 361 against the normal 11 108) - harmless, one warning each. | log counted (178 normal calls vs 3 odd ones) | know | log at Debug when the content is not the real index (no `</body>`) | nothing |
| S1-09 | `ExtraposterController.cs:~876`, `BackdropsController.cs:~325` | cache | design | Cache keys carry `RuntimeHelpers.GetHashCode(config)` as the config stamp; the hash is not unique, a collision after a save could serve a stale answer for up to 30 s. Practically never. **Design note:** Session 123 chose the config object identity as the stamp on purpose (a save is seen at once); the collision is theoretical - leave. | code read | believe | a save counter / `Guid` stamp set in the plugin's `UpdateConfiguration` override | nothing |
| S1-10 | `docs/artworkplus-feature-map.md` | doc | withdrawn | WITHDRAWN 2026-09-21: my inversion read only the Detail View row; the seven Backdrops category rows list every pool route and the delivery table lists `script.js`. Own audit error (the inversion must cover all rows of a feature family), no doc gap. | re-read of rows 57-63 and 14-17 | know | - | - |
| S1-11 | `Extraposter/batch` (GET), client chunk 200 | limit | design | A GET batch with 500 ids answers 414 (Kestrel request line 8 KB); the client's chunk of 200 ids plus `page=` is ~6.8 KB - 1.2 KB of margin, no server-side guard message. **Design note:** the 200-id chunk was chosen for the server cap; the 414 only appears beyond ~240 ids - leave. | probe | know | note only; a POST batch would remove the limit | client change |
| S1-12 | all detail-page scripts | cost | design | "Installed but off": with every switch off the scripts still make 9 endpoint requests per detail page (stress test, vanilla run: 1 317 requests). Known since Session 135. **Design note:** the scripts ask the server because client and server config are separate by design; the 9 requests are tiny - leave, a flag injection would touch the start-up of every script. | stress data | know | one `/ArtworkPlusCore/flags` answer injected into index.html like the tile flags | area 2 topic |

### Counter-audit (area 1)

(a) Second proof: S1-03, S1-05, S1-08, S1-11 static + dynamic -> know.
S1-01, S1-06, S1-07, S1-10 static + a probe that shows the anonymous path
exists -> know. S1-02, S1-04, S1-09 static only (a reproduction would need a
fault injection or a file deletion on the live server - not done) -> believe.
(b) Inversion: every route of the 11 controllers is in the feature map except
the Backdrops pools (S1-10); every documented endpoint exists. (c) Adversarial:
47 anonymous probes - 8 traversal forms (`..%2F`, `%2E%2E%5C`, nested
groups), random and invalid GUIDs on every GET, negative / non-numeric index,
empty and 500-id batches, `<script>` as page class, SQL-looking tag, protected
routes -> 0 x 500, 0 x traversal, admin routes 401. (d) No contradiction
between the two lists; the counter-audit added S1-11 (the 414) which the
static pass had not seen.

### Summary area 1

blocker 0 · bug 1 (S1-02, not intentional) · risk 2 (S1-01, S1-03 - each
with a design share, decision by the user) · smell 4 (S1-04, S1-05 resolved,
S1-07, S1-08 - unintended, safe to tidy) · design 4 (S1-06, S1-09, S1-11,
S1-12 - verified deliberate, not fix candidates) · doc 0 (S1-10 withdrawn). Top by risk: S1-03 (log volume, measurable cost every day), S1-01
(anonymous amplification, only if the server is exposed), S1-02 (stuck job).
Not verified in this pass: the full PeopleBackdrops parsing path (1 634
lines, read in part) and the CharacterartController body beyond the file
endpoint.

## Area 2 - Client (Session 137b, 2026-09-21)

### Coverage

Read in full: Core's presence heartbeat, navigation watcher and dispatcher
(`Core-v1.js:600-626, 860-880, 1583-1612`), the rotation engine's tick /
stop path, RenderArt's LogoArt `start()`/`schedule()` and the Characterart /
RedCarpet fetch sites, the Backdrops People stream reader, the CaseMod
listener lifecycle, the tile scanner (`scan()`, `stateFor`). Grep-driven
over all 8 485 lines: every `setInterval` / `clearInterval`, `setTimeout`,
`requestAnimationFrame`, `MutationObserver` / `disconnect`,
`addEventListener` / `removeEventListener`, `fetch` / `.ok` / `.json()` /
`.catch`, every DOM selector string, function definitions referenced only
once. Dynamic (tab HIDDEN the whole time - the adversarial "covered tab"
case, so image timing was not measured): hard reload of a movie detail page
with all plugin requests grouped, request timeline of the RenderArt
endpoints, tile-scan cost on the 580-card Movies library via a
`querySelectorAll` wrapper, a LiveTV Program page for the LogoArt release
class, the 7-owner boot dispatch. Selectors: all 31 Jellyfin selector tokens
the scripts use exist in jellyfin-web 10.10.7 (`src/**`).

### Check classes

| class | result |
|---|---|
| cleanup on navigation | RenderArt: `schedule()` clears timers, containers, the resize listener; Backdrops: per-visit `AbortController`, owners release through the bus, engine ticks are tracked timeouts; Posters: generation counters, `seenCards` WeakSet; one self-removing pattern with a delay (S2-06) |
| double initialisation | every module guards with a run token / visit id / generation; measured: 7 boot dispatches, `settings` fetched once (S2-04); RenderArt fetches twice per page (S2-02) |
| 404 / 500 / JSON errors | every fetch sits in try/catch; a non-JSON body is caught at `.json()`; the feature stays off for that page and logs - except the LogoArt prehiding (S2-01) |
| races between owners / participants | bus with claims, handover cap, quiet frames (Session 131, transitions matrix 23 cases); tile arbiter priorities + safety net (29 scenarios); the stress test's "37 of 79 fast steps settled" is the designed async tail, not a race |
| hidden tab | all dynamic checks ran hidden: scripts initialise, fetch once, no runaway timers; rAF-bound rendering pauses by browser design |
| dead code | S2-07 |
| selectors vs jellyfin-web 10.10.7 | 31 / 31 found |

### Findings

| ID | file:line | class | sev | finding | evidence | know/believe | recommendation | a fix could break |
|---|---|---|---|---|---|---|---|---|
| S2-01 | `RenderArt-v1.js:720-731` with `FileTransformationRegistrar.cs:373-374` | prehiding not released | bug (narrow) | While LogoArt intervenes for at least one type, index.html carries `.detailLogo:not(.artworkplus-logoart-vanilla){visibility:hidden}`. `start()` adds the release class only on `ZeroIntervention`; the paths `fetch` error (server restarting, 500) and `!result.IsApplicable` (item types without a LogoArt block: Trailer, Playlist, Photo, LiveTV Program/Channel, Audio) `return` WITHOUT releasing - the vanilla logo of such a page stays invisible until the next navigation. Not reproducible in the user's library today: no Trailer/Playlist with a logo, the Program page renders no logo, and the current config injects no prehiding (`prehideStyle=false` measured). | code read (two return paths before the release); live check on a Program page: no logo rendered, no prehiding active | believe | release the class on every early return after `findLogo` (error, not applicable), same as `ZeroIntervention` | nothing - `Hide` keeps its own path |
| S2-02 | `RenderArt-v1.js:281, 443, 802` + `Core.watchForNavigation` / heartbeat | duplicate work | smell | Characterart, RedCarpet and LogoArt each fetch their endpoint twice on every detail-page load (measured 1 781 ms and 1 958 ms after reload, 7-12 ms each): `viewshow` schedules once, the initial poll / heartbeat schedules again; the run token makes the first result dead. Harmless, 2x server resolve per page. | request timeline | know | debounce `schedule()` by hash (skip when the hash and item are unchanged and a run is in flight) | the recovery path of the heartbeat if the guard is too strict - keep the recover call unconditional |
| S2-03 | Backdrops People owner, RedCarpet | client has no item type | design | On every detail page - also movies - the person-only features ask `/PeopleBackdrops/{id}?scope=info` and `/RedCarpet/{id}` because the client cannot tell a person page from a movie page without a request (part of S1-12's nine requests). Deliberate: no extra item fetch in the client. | request list on a movie page | know | none (a shared item-kind answer would trade one request for three) | - |
| S2-04 | `Backdrops-v1.js:235, 565, 677, 795, 889, 999, 1129` | boot burst | smell | Seven owner IIFEs each schedule `Core.dispatchNavigationNow` at 1 200 ms; each dispatch calls all 7 listeners (`source==='viewshow'` bypasses the hash dedupe) = 49 listener runs at boot. The owners dedupe by visit id - `settings` was fetched once (measured). Cost negligible; duplicated boiler-plate of the copy-per-owner pattern. | code + measured single settings fetch | know | one boot dispatch in Core after the last owner registers | nothing (idempotent today) |
| S2-05 | `Core-v1.js:871, 1608`, `Posters-v1.js:4617`, `RenderArt-v1.js:444`, heartbeats `RenderArt-v1.js:283, 804`, tile scanner `Posters-v1.js:1181` | standing observers | smell / design | Permanently: three 1 s hash polls (Core dispatcher, Posters `watchForNavigation`, RenderArt `watchForNavigation`), two 750 ms heartbeats with two body-wide debounced MutationObservers, one body-wide UNdebounced tile scanner (`querySelectorAll` of three card selectors per mutation batch). Measured hidden on the 580-card library: 8 scans, 6.8 ms total (0.85 ms each), 12 mutation records; visible-tab lazy loading adds mutations (blurhash canvases) - not measured. Historic: `watchForNavigation` predates `Core.onNavigation` (Session 120), both kept. | code + measurement | know (hidden), believe (visible) | route Posters/RenderArt through `Core.onNavigation` (one poll), debounce the scanner by a frame | navigation timing of the detail modules (the 1 s poll is their backup); the scanner's pre-paint pending mark must stay synchronous for the first insertion |
| S2-06 | `Posters-v1.js:3926-3940` | delayed listener release | smell | The CaseMod `resize` listener and `ResizeObserver` of a page visit remove themselves only when the NEXT resize / observe callback sees a stale generation; until a resize happens the closures keep the old page's card subtree alive. Heap over the 27-minute stress run: 35 -> 38 MB, peak 56, no trend - negligible in practice. | code; heap trend | believe | remove both in the generation-change path instead of lazily | nothing |
| S2-07 | `Posters-v1.js:2500-2513, 2677-2718`, `Core-v1.js:1895` | dead code | smell | `mat4ColMulVec`, `rowVecMulMat4`, `computeKodiMatrix3dStringWithOffset` (~45 lines, CaseMod matrix experiments) are never called; Core exports `ensureBodyIsPositioned` which nothing uses. | reference count = definition only | know | delete (the CaseMod suite's 123 tests guard the live matrix path) | nothing |
| S2-08 | `Backdrops-v1.js:488` | contract note for S1-01 | design | The People stream is fetched with a plain `fetch` (no token, `AbortController` per visit). Any `[Authorize]` on `/PeopleBackdrops/{id}` (S1-01) must first switch this call to a token header - the Session 116 pattern (`ApiClient.getJSON`) does not stream; a `fetch` with an `Authorization: MediaBrowser Token=...` header built from `ApiClient.accessToken()` would. | code | know | part of the S1-01 dossier, not a finding of its own | People Backdrops entirely, if the auth lands before the client |

### Counter-audit (area 2)

(a) S2-02, S2-04, S2-05 (hidden) code + measurement -> know; S2-03, S2-07,
S2-08 code + request list / reference count -> know; S2-01 and S2-06 static
only -> believe (S2-01 needs a Trailer with a logo or a server restart
mid-session; S2-06 a heap snapshot after N visits without resize). (b)
Inversion: every feature of the feature map has its client section (Posters:
CaseMod, Custom, Animated, Extra detail + the tile arbiter with three
participants; RenderArt: Characterart, RedCarpet, LogoArt; Backdrops: 7
`Core.onNavigation` owners = 7 categories) - no gap. (c) Adversarial: the
covered-tab case was the whole dynamic pass (hidden = true throughout):
initialisation, single fetches, no runaway; 580-card list scanned in 6.8 ms;
malformed / non-2xx bodies covered statically (every `.json()` inside
try/catch). (d) No contradiction; the counter-audit turned the "double init"
hypothesis into the measured S2-02 and cleared the 7-dispatch burst (S2-04)
as cost-free.

### Summary area 2

blocker 0 - bug 1 (S2-01, narrow, believe) - risk 0 - smell 5 (S2-02, S2-04,
S2-05, S2-06, S2-07) - design 2 (S2-03, S2-08). Top by relevance: S2-01
(the only user-visible failure mode: a logo that never appears), S2-05
(the only standing cost), S2-02 (2x server work per detail page). Pending:
the visible-tab scan measurement (S2-05) when the Chrome window is visible.

## Area 3 - Admin page (Session 137c, 2026-09-21)

### Coverage

The gate system itself is covered mechanically by the suite that ran green
today (`run_checks.py --all` 20/20: 413 page tests incl. every Show-on /
Enable / greying chain, self-containment 0 violations, single grey level 0,
duplicate ids 0, JS <-> C# default sync, nested-collapse classes,
description length wraps=0 / over-105=0, cross-node 3 known, nesting 3 known,
header 60 keys, gegenaudit 1 known). This pass audited what the suite does
not: the load / save / restore / import / export paths (read in full),
`epGetFieldValue` / `epSetFieldValue`, the active case-tune mapping, the
create-logos poll, the untick-pair list against rule 0, and three
cross-checks by script: EP_FIELDS (729) vs C# properties (763) vs DOM inputs,
type match per field, functions defined but never referenced. Server-side
counterpart of every page value checked for floors where the page allows 0.

### Check classes

| class | result |
|---|---|
| Fibel rules 0-27 per node | suite green (see coverage); rule 0 verified by hand: none of the 8 tab-root switches is a target of the Show-on -> Enable untick list |
| JS <-> C# default sync | diagnostic green for the 729 EP_FIELDS; the 34 C# properties outside EP_FIELDS (6 format csv + 28 per-case-type tune values) compared by hand: all equal |
| description length | green (wraps 0, over-105 0) |
| fields without DOM / DOM without field | 0 EP_FIELDS without element; 69 inputs outside EP_FIELDS, all wired: 34 format checkboxes -> csv, 20 `*Select` twins of checkbox pairs, 7 `ActiveCaseTune*` -> per-type map, `LogoArtPersonsCreateMode` -> request body, `epCodeBox` |
| load / save | save re-reads the server config and overwrites only the page's fields + csv + the ACTIVE case type's tune values - server-only and other-type values survive (verified in code) |
| Restore | Restore-all covers EP_FIELDS + angle sign + active tune + all six csv; per-tab restore covers the tab's csv |
| Import / Export | S3-03, S3-04 |
| dead JS | none (`epInsertTabSeparators` is an IIFE) |

### Findings

| ID | file:line | class | sev | finding | evidence | know/believe | recommendation | a fix could break |
|---|---|---|---|---|---|---|---|---|
| S3-01 | `configPage.html:8312-8314` (`parseFloat(...) \|\| 0`), inputs `min="0"`; `RenderArt-v1.js:256, 641`, `Posters-v1.js:1703`; no server floor | numeric floor | bug (believe) | A cleared or 0 "Display duration" saves as 0 (empty -> `parseFloat` -> 0, and `min="0"` accepts 0). Characterart, LogoArt (Characterart stage) and the Extraposter detail slideshow then run `setTimeout(showNext, 0)` - an image switch every timer tick (~4 ms) on that page, CPU-bound, until navigation. Backdrops (`Core-v1.js:1815`, floor 1.5 x fade) and the Extra tiles (`Posters-v1.js:2074`, floor 250 ms) have floors; the server clamps only `OpenAngleDegrees`. Never observed - the user never saved 0. | code read at three sites | believe (a probe would need a saved 0) | a floor on the server where the DTO is built (`Math.Max(..., 250)`) or `min="100"`-style validation in `epGetFieldValue`; keep both engines untouched | nothing if the floor sits in the server DTO; a page-side floor changes what a saved 0 means |
| S3-02 | `configPage.html:8289-8316`, save path 11589-11611 | input validation | smell | Numeric fields are read with `parseFloat` and no range check - the HTML `min` / `max` / `step` attributes only guard the spinner, typed values (negative, huge, decimals where an int is expected) reach the server and are cast by the JSON binder (a decimal into an `int` field is rejected by the server as a 400 without a page message). | code read | know | one `clamp(min, max)` in `epGetFieldValue` from the element's attributes | any field whose attributes are stricter than the server actually needs - check the 211 `min` attributes first |
| S3-03 | `configPage.html:11356-11369` (export), `11406-11463` (import) | transfer gap | bug (low) | The Export / Import code carries EP_FIELDS + the six format csv but NOT the 28 per-case-type tune values (`*CaseTune*`, `CaseMod3DTune*`) - the 3D case geometry a user tuned is silently left at the target server's defaults after an import. The status text "Saved N + 4 settings" also counts 4 where 6 csv are written. | code read (export builds from EP_FIELDS + 6 csv only) | know | include the 28 tune properties from `epLastLoadedConfig` + the active fields in the export, apply them in the import | nothing (additive) |
| S3-04 | `configPage.html:11358` | secret in export | risk (low) | `PeopleBackdropsApiKey` is an EP_FIELDS text field and therefore part of the Export code (base64 of JSON, not encrypted) - a code pasted into a forum or repo ships the Wallpapers.com key. Never considered, not a decision. | code read | know | exclude the key from the export (and say so in the status line), or mask it | anyone relying on the export to move the key |
| S3-05 | `configPage.html:10957-10964` | poll teardown | smell | The create-logos status poll (1 req/s) starts when a job runs and stops only when the job ends or the request fails; leaving the plugin page keeps it running until then (the config page has no `viewhide` teardown). Cost: one small admin GET per second during a job. | code read | know | clear the interval on `viewhide` / `pagehide` and re-arm on `pageshow` | nothing |
| S3-06 | `configPage.html:11527-11530`, `8752-8792` | active-type editing model | design | The seven visible case-tune fields belong to the selected case type: switching the type reloads them from the last LOADED server state, so unsaved edits of the previous type are dropped without notice, and a save writes only the active type (Session 49 decision: "one visible field writes only the current type's storage"). Deliberate. | code read | know | none; a hint line when switching with unsaved edits would be an enhancement | - |

### Counter-audit (area 3)

(a) S3-02 through S3-06 are code-proven on two sites each (page path + the
consuming side: server binder, export/import pair, poll start/stop, type
switch + save) -> know; S3-01 static only (three code sites but no saved 0
observed) -> believe. (b) Inversion per feature: every feature's settings
block in the page maps to EP_FIELDS -> C# (0 EP_FIELDS without C#, 0 without
DOM), every server-only property is either composed (csv) or mapped (tune)
on save - no field is lost on Save; Export/Import is the one path with a gap
(S3-03). (c) Adversarial: a hostile import code (`btoa` of arbitrary JSON)
is applied field by field with `EP_FIELDS[id]` as the whitelist and
`!!value` / `el.value` casts - no code execution path, unknown keys ignored,
`JSON.parse` failures caught; an empty numeric field -> 0 (S3-01); a
decimal in an int field -> server 400 without a page message (S3-02). (d)
No contradiction with the suite: the suite tests states the page can reach
by clicks; S3-01/S3-02 are typed values the suite never enters.

### Summary area 3

blocker 0 - bug 2 (S3-01 believe, S3-03 low) - risk 1 (S3-04, privacy) -
smell 2 (S3-02, S3-05) - design 1 (S3-06). The gate system: no finding
beyond the suite's known diagnostics.

## Area 4 - Delivery (Session 137d, 2026-09-21)

### Coverage

Read in full: `ArtworkPlus.csproj`, `meta.json`, `tools/deploy.py` (copy set,
verification, stale reporting). Compared: the build output
(`bin/Release/net8.0`) against the deployed plugin folder
(`plugins/ArtworkPlus_1.0.0.0`) file by file (CaseTextures, Fonts), the
`deps.json` for native references, the Jellyfin host folder for the
packages the plugin relies on (SkiaSharp ships with the host, ImageSharp
does not). Build: 0 errors, 2 warnings (both NU1902, the ImageSharp
advisory).

### Check classes

| class | result |
|---|---|
| build warnings | only NU1902 (S4-01) |
| dependencies with advisories | SixLabors.ImageSharp 3.1.7 - S4-01; SkiaSharp 2.88.9 = the host's own version, nothing shipped; Jellyfin.Controller/Model 10.10.6 compile-only (10.10.7 has no NuGet package, targetAbi stays 10.10.7.0) |
| files in the plugin folder no build produces | one: `CaseTextures/movieposter_mask_reflect.png` (S4-02) |
| build output vs deploy set | `runtimes/` (39 MB native SkiaSharp libraries for win/osx) is in the build output but NOT deployed by deploy.py (S4-03) |
| scripts in the data folder | served bytes verified identical by deploy.py on every deploy |
| catalog metadata | S4-04 |

### Findings

| ID | file:line | class | sev | finding | evidence | know/believe | recommendation | a fix could break |
|---|---|---|---|---|---|---|---|---|
| S4-01 | `ArtworkPlus.csproj` (SixLabors.ImageSharp 3.1.7) | dependency advisory | risk | NU1902: 3.1.7 carries a known moderate advisory (GHSA-rxmq-m78w-7wmc). It matters here more than in most plugins: ImageSharp decodes images DOWNLOADED from the web (People Backdrops aspect check + text detector, `PeopleBackdropsController.cs:1379-1394`), i.e. untrusted input, reachable through the anonymous endpoint (S1-01). The 3.1.x line stays under the free split licence without a key (the pin at 3.1.7 was for the 4.0 licence-key rule, not for 3.1.7 itself). | build warning; csproj comment; download path | know | bump to the latest 3.1.x patch (no licence key, same API), rebuild, run the People smoke | nothing expected - patch line; verify `PassesAspectRatioCheck` and the text detector on the live People fixture |
| S4-02 | plugin folder `CaseTextures/movieposter_mask_reflect.png` | stale file | design | Present in the deployed folder, absent from the build output and unreferenced in code (grep in scripts and controllers: 0) - a leftover of an earlier texture set. deploy.py reports it as stale on every deploy and never deletes (by design: no deletions). Harmless. **User 2026-09-21:** the texture is kept on purpose - reserved for a possible future 3D view; leave it in the plugin folder. | file diff; grep | know | none - keep | nothing |
| S4-03 | `ArtworkPlus.csproj` SkiaSharp reference; `bin/Release/net8.0/runtimes` | packaging trap | smell | `ExcludeAssets="runtime"` on SkiaSharp keeps SkiaSharp.dll out of the output, but the transitive `SkiaSharp.NativeAssets.Win32/macOS` still drop 39 MB of native `libSkiaSharp.*` into `runtimes/`, and `deps.json` lists them. deploy.py does not copy `runtimes/`, so the live server is clean; anyone zipping `bin/Release/net8.0` for a release would ship 39 MB of natives next to a host that already has them - the "native DLL loaded as managed -> Malfunctioned" class the csproj comment describes for ONNX. | build output listing; deps.json grep (4 hits) | know | `PrivateAssets="all"` / `ExcludeAssets="runtime;native"` on SkiaSharp, or exclude `runtimes/**` from the release zip step | only the LogoArt creator if the host's SkiaSharp were ever missing - it is not (host folder lists SkiaSharp.dll + libSkiaSharp.dll) |
| S4-04 | `meta.json` | catalog metadata | doc | `version` 1.0.0.0 since the first deploy (69 deploys), `changelog` "Initial release", `timestamp` 0001-01-01, `owner` empty, `description`/`overview` "Five independent features" (no CaseMod, Library View Backdrops, Persons, LogoArt...). Fine for a self-deployed folder, wrong for the public repo / a release. No release process exists yet (design: never scoped). | file read | know | a release checklist: version bump + changelog + timestamp + overview at the milestone tag | nothing at runtime; a version change renames the plugin folder (`ArtworkPlus_x.y.z.w`), deploy.py's target path is hard-coded to 1.0.0.0 |

### Counter-audit (area 4)

(a) All four are file facts with two witnesses each (csproj/warning + host
folder; file diff + grep; output listing + deps.json; meta.json + deploy
count) -> know. (b) Inversion: every artefact the feature map's delivery
table lists (DLL, configPage embedded, Core embedded, three scripts in the
data folder, CaseTextures, Fonts, logo, meta.json) is produced by the build
and copied by deploy.py - no gap; the reverse (S4-02, S4-03) are the
findings. (c) Adversarial: a release built by zipping the output folder
(S4-03); a plugin folder that accumulates files across deploys (S4-02 shows
deploy.py never deletes - a renamed texture would leave its old file behind
forever). (d) No contradiction.

### Summary area 4

blocker 0 - bug 0 - risk 1 (S4-01) - smell 1 (S4-03) - design 1 (S4-02,
kept on purpose) - doc 1 (S4-04).

## Area 5 - Docs vs code (Session 137e, 2026-09-21)

### Coverage

Feature map read whole and every countable claim recomputed from the code
(field counts per config prefix, total settings, endpoint lists, test
counts, the logging.json claim, the Import-button gap); `CLAUDE.md` state
list and verification routine checked against today's suite output and the
Fibel; the LogoArt concept's source-line claims (A5 `artLimit = 0`) and the
Backdrops concept spot-checked against the controllers; README.md looked at.
Lessons and the Fibel bug log are narrative history and were not re-verified
line by line.

### Findings

| ID | file:line | class | sev | finding | evidence | know/believe | recommendation | a fix could break |
|---|---|---|---|---|---|---|---|---|
| S5-01 | `docs/artworkplus-feature-map.md` (delivery table, config-prefix column, cross-cutting) | drift | doc | Counts drifted since the map was generated in Session 114: "PluginConfiguration.cs (369 settings)" vs 763 today; prefix counts off for 10 of 19 prefixes (Extraposter "7 + 4x7 + 2 sync" vs 101 incl. the 48 Also-on fields, Extrakeyart 87, Backdrops 130, PeopleBackdrops 19 vs 24, BackdropsFavorites 39 vs 60, BackdropsFavoritesPeople 3 vs 10, CaseMod 27 vs 28, Characterart 95 vs 97, Genre/Studio/Tag +1 each = Random start, BackdropsLibrary 16 vs 15); "Fibel rules 0-26" (27 exists, 27b/28 too); "Server side: `config\logging.json` overrides ... to Debug" - it has been Information since Session 127e (lesson B25, verified in the live file). The Import-button `.raised` gap is still true. | counts recomputed from C#; live logging.json read | know | regenerate the counts by script (the map says "generated from the code" - make that a tool, `tools/feature_map_counts.py`, and run it in run_checks as informational) | nothing |
| S5-02 | `CLAUDE.md:20, 103, 142-143` | drift | doc | "rules (0-26)", "`test_configpage.py` 406 tests", "run_checks.py --all 19/19 (406 config tests, 27 tile scenarios" - today: 413 tests, 20/20, 29 scenarios, rules 0-28. The state list is otherwise current (Sessions 135/136 appended). | suite output of this session | know | update the three lines with the next state edit | nothing |
| S5-03 | `README.md` | empty | doc | The public repository's README is empty (0 lines) - the repo has no user-facing description, install note or feature list; `meta.json` (S4-04) is the only description and it is stale. | file size | know | a README from the feature map's feature list + install (data-folder scripts, File Transformation dependency) | nothing |
| S5-04 | `docs/artworkplus-logoart-concept.md`, `docs/artworkplus-backdrops-concept.md` | spot check | doc (no finding) | The concept claims sampled (A5 `artLimit = 0` in `DtoService.AddInheritedImages`; the seven owners on the transition bus; Part S library pool pages) match the 10.10.7 source and the code. Not read line by line. | source lines | know (sampled) | - | - |

### Counter-audit (area 5)

(a) Every count was recomputed by script and the logging claim read from
the live file -> know. (b) Inversion (code -> docs): every controller,
script section, tab and test file of today's code has a row or line in the
map / CLAUDE.md; the Session 135 stress tooling and the audit skills are in
CLAUDE.md; nothing undocumented found. (c) Adversarial: a reader following
the map's logging line would switch the plugin to Debug and reintroduce the
Session 127e slowdown (lesson B25) - the one doc error with a cost. (d) No
contradiction.

### Summary area 5

blocker 0 - bug 0 - risk 0 - smell 0 - doc 3 (S5-01, S5-02, S5-03).

## Overall summary (areas 1-5, 2026-09-21)

| severity | count | IDs |
|---|---|---|
| blocker | 0 | - |
| bug | 4 | S1-02 (stuck create-logos job, believe), S2-01 (LogoArt prehiding not released, narrow, believe), S3-01 (Display duration 0 spins the rotation, believe), S3-03 (Export/Import loses the 28 case-tune values) |
| risk | 5 | S1-01 (anonymous People amplification - design share), S1-03 (log volume 80 %, design share), S3-04 (API key in the export code), S4-01 (ImageSharp advisory on downloaded images) |
| smell | 13 | S1-04, S1-07, S1-08, S2-02, S2-04, S2-05, S2-06, S2-07, S3-02, S3-05, S4-03 (+ S1-05 resolved by comments) |
| design | 8 | S1-06, S1-09, S1-11, S1-12, S2-03, S2-08, S3-06, S4-02 - verified deliberate, not fix candidates |
| doc | 4 | S4-04, S5-01, S5-02, S5-03 (S1-10 withdrawn) |

Top 10 by risk to the user: S4-01, S3-04, S3-01, S1-03, S2-01, S1-02,
S3-03, S1-01, S2-05, S2-02.

Fix order proposal (leaf-first, per `/fix` rulebook, after the dependency
map): S1-02 -> S1-04 -> S1-08 -> S3-05 -> S2-07 -> S3-03 -> S3-04 -> S2-01
-> S3-01 (server floor) -> S1-03 -> S4-01 (rebuild + People smoke) -> S2-02
-> S2-04 -> S2-06 -> S3-02 -> S4-03 -> S2-05 -> S1-07 -> docs S5-01..03,
S4-04 -> S1-01 last (client + server contract).

