# ArtworkPlus audit 2026-09 (read-only, after milestone `milestone-logoart-20260921`)

Findings only - nothing was changed. Severity: blocker / bug / risk / smell /
doc. "know" = proven on two independent ways, "believe" = one way only.
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
| S1-01 | `Controllers/PeopleBackdropsController.cs:285-330, 1340-1400` | amplification | risk | The anonymous `GET /PeopleBackdrops/{personId}` triggers, for a person without cache file, a Wallpapers.com search plus a full-size `GetByteArrayAsync` download, decode and text detection per candidate image and a cache-file write - no response size cap, no per-client limit. Bounded by: valid person GUIDs needed, `PopulateLocks` dedupes concurrent calls per person, the 7-day empty-cache retry, `MaxImages` <= 10. | code read; probe with a random GUID -> 200 "not found" stream, no fetch | know (static + probe) | leave as is on a LAN server; if the server is exposed: `[Authorize]` on the endpoint (the page is logged in anyway) and a `MaxResponseContentBufferSize` on the HttpClient | client fetches the stream with the page's ApiClient? - verify in area 2 before adding auth |
| S1-02 | `Controllers/LogoArtController.cs:758-796` | state | bug (low probability) | If anything throws OUTSIDE the per-person try (the `LogoTextRenderer` constructor, the Fonts folder unreadable), the `Task.Run` faults, `_job.Running` stays true, `CreateLogos` answers "running" forever and `cancel` cannot reset it - only a server restart. | code read: the only catch is inside the loop | believe (not reproduced - would need a fault injection) | wrap the whole task body in try/finally that sets `Running=false` + `Message` | nothing |
| S1-03 | `AnimatedPosterController.cs:535`, `CustomPosterController.cs:~575`, `CharacterartController.cs:266,272`, `BackdropsController.cs:316`, `FileTransformationRegistrar.cs:489-642` | log volume / perf | risk | Information-level lines per item and per image: on 2026-09-21 the plugin wrote 10 425 of the server's 13 016 log lines (80 %): `FindAnimatedFile` 3 511, `FindCustomPosterFile` 1 970 (one line per item per batch on a cache miss), `TransformIndexHtml` 823 (5-8 lines per index.html load), Characterart 786 + 475 + 384 + 183 (per page and per image incl. 304s), `GetSettings` 354. Lesson B25 measured ~1 ms per line on the synchronous console sink - a 500-card library batch with cold cache = ~1 s of logging. Also a `SafeGetLastWriteTimeUtc` stat per item per batch (cache-key design, external drives). | log counted by message kind; code read | know | move the per-item / per-image lines to Debug (the batch START/END lines already carry counts), keep one Information line per request; consider `LogDebug` for the transform's per-tag lines | nothing functional; tests grep no log text |
| S1-04 | `BackdropsController.cs:402-410, 1303-1311, 1456-1487`, `PeopleBackdropsController.cs:761-855` | error handling | smell | The four local-file endpoints without try/catch (`episode-image`, `custom-image`, `studio-image`, `folder-image`) answer 500 instead of 404 when the file disappears between the directory scan and `PhysicalFile` (every other file endpoint catches and logs). | code read | believe (needs a file deletion to reproduce - not done, read-only) | same try/catch pattern as `GetPosterImage` | nothing |
| S1-05 | `CaseModController.cs:187` (no attribute), `PeopleBackdropsController.cs:184-196, 761` | auth clarity | smell | Jellyfin 10.10.7 registers no fallback authorization policy (`Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs:64-68` - only `DefaultPolicy`, applied where `[Authorize]` stands), so a controller/endpoint without any attribute is anonymous: CaseMod (both routes) and PeopleBackdrops `folder-image` are anonymous while the PeopleBackdrops class comment describes a deliberate per-endpoint `[AllowAnonymous]` and does not mark `folder-image`. Functionally correct (`<img>` requests carry no token), the comment is misleading. | source read + probe: `folder-image` -> 404 anonymously, not 401 | know | mark the two explicitly `[AllowAnonymous]` and fix the comment, or leave and document | nothing **Resolved 2026-09-21 (comments only, no attribute change):** origin traced - the PeopleBackdrops comment was written before Session 101 added `folder-image` ("the two endpoints" = the sandbox-era pair); the new endpoint copied Studio's `GetStudioImage`, which then sat in a class-level `[AllowAnonymous]` controller (Backdrops was class-level until Session 116), so the pattern it copied never carried an attribute. CaseMod (Session ~11) was written with the knowledge that attribute-less Jellyfin routes are anonymous (its own doc comment cites `ImageController.GetItemImage`, "no [Authorize] on that route") - by convention, not by oversight. Both comments now state the mechanism. |
| S1-06 | `ExtraposterController.cs:1063-1077` | exposure | smell | `child-image` serves a movie's postercase / keyart / animated file with no feature switch at all (by design for the Set image types, comment in the feature map) - also with Extraposter, Custom and Animated all off. Same data class as Jellyfin's own anonymous images. | code read; probe random id -> 404 | know | gate on `ExtraposterTabEnabled` at least | Set image types when Extraposter is the only enabled feature - none, the gate would be the tab switch |
| S1-07 | `LogoArtController.cs:538-549, 773`, naming-mode folder names, `RedCarpetController.cs:261`, `BackdropsController.cs:355` | input hygiene | smell | Admin-typed config strings go into `Path.Combine` unsanitised (`LogoArtPersonsBaseName`, the "Folder" naming-mode folder names, `RedCarpetFolderName`, `BackdropsEpisodeBaseName`): `..\..\x` escapes the item folder; `create-logos` would then WRITE `x.png` there. Admin-only setting - admins own the server anyway. | code read | know | reject path separators / `..` in these fields on save (page) or `Path.GetFileName` on the server | nothing |
| S1-08 | `FileTransformationRegistrar.cs:504-506` | noise | smell | The transform is registered for the pattern `index.html` and is also called with other HTML (three "no </body>" warnings on 2026-09-20/21 with content lengths 1 134 / 5 062 / 11 361 against the normal 11 108) - harmless, one warning each. | log counted (178 normal calls vs 3 odd ones) | know | log at Debug when the content is not the real index (no `</body>`) | nothing |
| S1-09 | `ExtraposterController.cs:~876`, `BackdropsController.cs:~325` | cache | smell | Cache keys carry `RuntimeHelpers.GetHashCode(config)` as the config stamp; the hash is not unique, a collision after a save could serve a stale answer for up to 30 s. Practically never. | code read | believe | a save counter / `Guid` stamp set in the plugin's `UpdateConfiguration` override | nothing |
| S1-10 | `docs/artworkplus-feature-map.md` | doc | withdrawn | WITHDRAWN 2026-09-21: my inversion read only the Detail View row; the seven Backdrops category rows list every pool route and the delivery table lists `script.js`. Own audit error (the inversion must cover all rows of a feature family), no doc gap. | re-read of rows 57-63 and 14-17 | know | - | - |
| S1-11 | `Extraposter/batch` (GET), client chunk 200 | limit | smell | A GET batch with 500 ids answers 414 (Kestrel request line 8 KB); the client's chunk of 200 ids plus `page=` is ~6.8 KB - 1.2 KB of margin, no server-side guard message. | probe | know | note only; a POST batch would remove the limit | client change |
| S1-12 | all detail-page scripts | cost | smell | "Installed but off": with every switch off the scripts still make 9 endpoint requests per detail page (stress test, vanilla run: 1 317 requests). Known since Session 135. | stress data | know | one `/ArtworkPlusCore/flags` answer injected into index.html like the tile flags | area 2 topic |

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

blocker 0 · bug 1 (S1-02, low probability) · risk 2 (S1-01, S1-03) · smell 8
· doc 0 (S1-10 withdrawn - own error). Top by risk: S1-03 (log volume, measurable cost every day), S1-01
(anonymous amplification, only if the server is exposed), S1-02 (stuck job).
Not verified in this pass: the full PeopleBackdrops parsing path (1 634
lines, read in part) and the CharacterartController body beyond the file
endpoint.
