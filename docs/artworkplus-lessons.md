# ArtworkPlus — lessons learned

The map of past mistakes, extracted in Session 114 from the curriculum (Sessions
1–114), the Fibel and the working notes. Nothing here was deleted from the
curriculum's session entries; this file is the index so the lessons are read
without reading 7,700 lines. Each lesson: the pattern, what actually happened,
the rule. Session numbers point into `artworkplus-kurrikulum.md`.

Read before: any live debugging (A, B), any change to the gate system (D), any
new case type or enumerated category (E), any deploy (C), any UI text (F).

## A. Working with the user

- **A1 — Plan first, wait for an explicit GO.** The most frequent complaint over 100+
  sessions ("frage mich zuerst bevor du änderst", "das ist dir jetzt schon so oft
  passiert"). A question followed by starting does not count. Show labels, dropdown
  values and description texts before building UI. Fibel header rule, Session 81.
- **A2 — Truth mode.** "Glaubst du oder weißt du?" Never present a theory as a fact;
  verify in the Jellyfin 10.10.7 source (now unpacked under `Project Files\Source
  Codes\`) or the project code. Session 15 (contain:paint "finding" retracted),
  Session 21 (two wrong flicker explanations, settled only by the real source).
- **A3 — Say plainly what is done and what is not.** "Ist jetzt alles fertig?" gets an
  honest split. A decision "we do X" is complete only when file AND code path are
  verified — the "set" texture category was decided in Session 40 and silently not
  implemented for eight sessions (Pattern 6, Sessions 40–48).
- **A4 — When the user says "spar deine Energie, machen wir später", stop at once** and
  record the point as genuinely open — do not quietly rule anything in or out first.
- **A5 — When the user calls two concepts identical, take it seriously** instead of
  defending the own earlier distinction (logo.png/thumb.png, Session 70).
- **A6 — Restate a reported problem in own words before fixing;** correct > complete >
  verbose; nothing on own initiative (no unrequested refactors or comments).
- **A7 — Sandbox designs are copied, not re-derived.** When re-implementing something
  designed in the sandbox replica, copy that implementation; and check the replica
  itself, never only the curriculum summary, to know whether X was really built
  (Session 104: nine "already done" gaps were sandbox-only).

## B. Diagnosing

- **B1 — Get the real artifact before shipping a fix for a plausible theory.** HAR,
  console log, server log, screenshot — then the fix. Repeated pattern: a well-reasoned
  theory from re-reading source was shipped and then disproven by real data.
- **B2 — Check the shape of the symptom against the theory.** A mechanism that can only
  cause a DELAY cannot explain a PERMANENT absence. Session 21.
- **B3 — Check reachability before code.** "Images do not load" on Keanu Reeves was a PC
  without DNS (Session 113); "script change has no effect" was an outdated paste in
  JavaScript Injector, after hours of DevTools theorising (pre-Session 22). First check:
  is the current code actually running, is the host reachable.
- **B4 — A disproof covers only the observed cases.** Ruling out a mechanism in N cases
  disproves it for those N conditions; say so instead of generalising.
- **B5 — Do not manufacture one narrative across two bugs of the same session** — verify
  the mechanisms are really related before presenting them as one story.
- **B6 — DOM checks miss inherited CSS.** Opacity inherits: `classList`/`.disabled` checks
  passed while the element was visibly grey. For anything involving greying take a
  screenshot (Fibel rule 24; caught several times).
- **B7 — Stacking context, not just z-index.** Verify whether the parent establishes a
  stacking context; a low z-index means "behind", not "invisible" — a transparent
  texture centre still shows what is behind it (Pattern 4, Sessions 40–48).
  `visibility:hidden`, not `display:none` (which zeroes `getBoundingClientRect()`).
- **B8 — Measure, do not mirror.** Hinge point, rotation sign and camera strength of the
  3D case were first estimated by analogy to the other case types — every estimate was
  wrong; pixel measurement against the Kodi screenshot settled it (Pattern 2, Session 42;
  transform-origin calc, Session 51).
- **B9 — A test that embeds a script inline snapshots it.** Editing the source file
  afterwards changes nothing in that test page until it is rebuilt (Session 33 debug
  hook that never fired). Same family: Windows Chromium served images from the
  per-document memory cache without hitting `page.route()` — reload a fresh document
  between such tests (`fresh_document()`, Session 111).
- **B10 — Read the file header, not the file name.** Which of two candidate PNGs is meant:
  read width/height from the PNG itself (Session 70).
- **B11 — Cite Fibel and curriculum before guessing.** One of the guessed explanations in
  Session 96 was wrong; the rule that answered it (rule 3/6) was already written down.
- **B12 — The compiler is a verifier the sandbox never had.** All three first-build errors
  were API-shape errors (missing interface, wrong namespace, extension method without
  `using`) that "verified against source" comments did not catch (Session 110). Every
  C# change: `dotnet build -c Release` before it counts as done.
- **B13 — The code's own comments are the condensed requirement history.** To reconstruct
  why the gate logic is as it is, grep the "explicit user request/correction" and "Real
  bug found" comments in `configPage.html` rather than re-reading transcripts (Session 22).

## C. Delivering

- **C1 — State the deployment step after every change,** unprompted: full deploy (C#,
  configPage.html, Core) / `tools/deploy.py scripts` (feature scripts) / nothing.
  Forgotten twice in one session (2026-09-15) — hence the standing rule.
- **C2 — configPage.html IS embedded.** It needs a rebuild; the opposite was documented
  and acted on for at least one delivered change before the user questioned it
  (confirmed in `DashboardController.cs`, 2026-09-15).
- **C3 — Is the current version running?** Since Session 112 the answer is the byte
  compare in `tools/deploy.py`; before that it was "grep the pasted text in JavaScript
  Injector" — the check that would have saved hours in the pre-Session-22 hunt.
- **C4 — Build comprehensive logging in from the start,** strip it once everything works
  (user rule from Session 1, violated repeatedly with reactive one-line diagnostics that
  cost extra test rounds). Since Session 114 the client logging is complete but gated by
  `localStorage.ArtworkPlusDebug`; the server side logs Debug for our namespace.
- **C5 — Stale description text is its own error class.** Logic audits do not catch a
  leftover "not yet implemented" or an outdated option description (Session 69's visible
  "-5 to 0 degrees"); check descriptions deliberately after every option change.
- **C6 — Large changes end with a file-by-file completeness inventory,** not memory —
  memory skips files that were not on the mental list.
- **C7 — Local paths, e-mail and server name stay out of anything pushed;** no AI-named
  files in the public repo (`.git/info/exclude`), no attribution trailers (Session 112).

## D. The gate system (configPage.html)

The binding rules are Fibel 0–26; these are the lessons behind them.

- **D1 — Sync vs. Gate are different directions.** Sync changes VALUES, only on
  interaction, never on page load (a saved `Enable=false, ShowOn=true` is legitimate);
  Gate changes only CSS/disabled state and is always active (Session 22).
- **D2 — Never cascade from a sub-Enable up to a General master.** Tried once, created an
  unescapable dead end with whole-tab locking, permanently removed.
- **D3 — One grey level at a time (rule 14).** Two greying layers on the same element
  looked "double dimmed"; `test_single_grey_level.py` found real, otherwise invisible
  bugs several times.
- **D4 — Format-emptying must cascade like Enable** (Session 27 bug); an emptied format
  list greys everything that needs formats — except sources that do not read files
  (Wallpapers.com exemption, Session 82, corrected from a too-coarse "People is never
  format-dependent").
- **D5 — Additive-only exception functions are wrong across recompute cycles** (rule 26,
  Session 109): an exception must be able to take back its own additions (marker
  attribute) or stay idle where the normal logic owns the element. The Favorites-People
  format exception took four attempts (Sessions 102/106/107/108/109).
- **D6 — Select nodes are always `structural: true` (rule 13);** the violation only became
  visible once all four case types had tuning nodes (Pattern 5). After every EP_TREE
  change with a select run `test_configpage.py` including the "tab does nothing" tests.
- **D7 — Check the full ancestor chain** (rule 24), not just the toggled node; and
  `epRestoreAllBtn` → open tab → toggle → check state AND chain is the live pattern.
- **D8 — After every gate bug: sweep the codebase for the same pattern, then add a
  diagnostic** — this is how `diagnostic_duplicate_id_check.py`,
  `diagnostic_nested_collapse_check.py`, `test_tree_self_containment.py` came to exist.

## E. Adding a type or category (the Viva Elite 3D Case series, Sessions 40–48)

- **E1 — Enumeration lists get forgotten.** `HINGE_ORIGIN_X_PERCENT`,
  `ALL_POSTER_ORIGIN_CLASSES`, `ALL_CARD_PERSPECTIVE_CLASSES`, `ValidTextureKeys` — each
  missed the new type at least once; "case types visibly mix" was the biggest user-visible
  bug of the series. Before closing: `grep -rn "<existing type>" *.js *.cs *.html` and
  walk every hit.
- **E2 — New DOM elements and inline styles need their cleanup in the same step**
  (`discPreviewBox` without `BOX_CLASS`, `.cardScalable` opacity never reset — three bugs
  of one kind in Sessions 44/46). Ask "is this removed in `removeExistingOverlay()`?"
  when creating it, not later.
- **E3 — Reuse of a closure needs its own audit:** `applyTilt()` reused for `backBox`
  introduced a second bug while fixing the first (Session 50).
- **E4 — A sketch settles an architectural misunderstanding faster than rounds of text**
  (three texture slots of the 3D case).

## F. Admin UI conventions (user decisions)

- Descriptions: one line, English, few hyphens, options explained in the order they
  appear (Main first, then All).
- Button sizes identical; flex rows `justify-content:space-between`; no section headings
  unless asked; tuning fields are hidden, never removed; one proxy field per value, not
  one row per case type (Session 49).
- Naming modes: Movies Standalone/Prefixed/Folder; TV Standalone/Folder (series main
  folder); Sets always Standalone.

## G. Test discipline

- Tests are the truth, not my reading of the code: every live-test finding becomes a
  test case; a flaky timing test is repeated before it counts as a failure.
- Fixtures come from the user's own library via API (2,600 movies / 360 series) — never
  place test files (user rule, Session 113).
- Verification order after a change: `dotnet build` → `tests/run_checks.py --all` →
  feature suites (`test_casemod.py`, `test_rotation_engine.py`, `test_debug_switch.py`)
  → live check in the user's Chrome (foreground for screenshots) → curriculum entry.
