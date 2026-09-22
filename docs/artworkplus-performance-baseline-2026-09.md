# ArtworkPlus - performance baseline (2026-09-22, after the audit fix round)

The numbers to compare against before/after any future change. Raw runs live
in `tools/stress/results/` (git-ignored, local fixtures); this file keeps the
essentials. Tooling: `tools/stress/` (185-step playbook, seed 20260921, in-page
runner, `analyze.py`). Rules for a valid run: the Chrome tab VISIBLE the whole
time (`document.hidden` false - a covered tab freezes rAF and lazy images),
>= 1000 px wide, results extracted through a `<pre>` + page text (the
javascript tool truncates), and the config left as the user set it.

## 1. The three runs

| run | date | config | conditions |
|---|---|---|---|
| vanilla | 2026-09-21 (S135) | every feature off | tab partly covered (rAF anomaly documented in S135), cold cache |
| plugin | 2026-09-21 (S135) | S135 max profile | same session as vanilla |
| **after** | 2026-09-22 (S138s) | user's own max profile: 73 `*Enabled`, Extraposter/Extrakeyart library delay 5000, custom main poster, backdrops on | tab visible throughout, partly warm cache, after fixes S1-S5 |

The after run beats even the vanilla run on main-thread and frame metrics,
which a plugin change alone cannot do - the S135 runs were recorded under
different conditions. Only condition-independent signals count as fix proof
(leftovers, requests per page, longest task, steps without long tasks).

## 2. Totals (185 steps, ~26 min each)

| | vanilla | plugin | after |
|---|---|---|---|
| long-task ms | 201 019 | 275 380 | 61 884 |
| frame-gap ms | 514 427 | 408 501 | 69 291 |
| scroll-gap ms | 76 234 | 111 136 | 16 469 |
| requests | 8 244 | 11 875 | 8 836 |
| KB transferred | 178 660 | 3 597 995 | 1 596 289 |
| plugin endpoint requests | 1 317 | 5 397 | 3 144 |
| longest single task ms | 2 751 | 5 836 | 1 478 |
| steps without a long task | 23 | 25 | 112 |
| settled steps in the fast phases (of 79) | 73 | 37 | 57 |
| leftovers at the end / max | 0 | 143 / 335 | 8 / 59 |
| peak / end JS heap MB | 42.7 / 29.4 | 56.2 / 37.8 | 52.0 / 34.1 |
| console errors | 1 | 1 | 1 (the same vanilla favorites error) |

## 3. JS-only score per page kind (long-task ms per minute of dwell)

| kind | n | vanilla | plugin | after |
|---|---|---|---|---|
| genre | 2 | 31 772 | 50 319 | 4 417 |
| lib-tv | 6 | 39 891 | 49 705 | 9 189 |
| tag | 1 | 24 816 | 44 296 | 12 385 |
| lib-movies | 12 | 28 465 | 41 601 | 12 185 |
| lib-collections | 4 | 30 611 | 34 615 | 6 078 |
| studio | 1 | 6 134 | 26 926 | 1 431 |
| favorites | 1 | 5 781 | 8 795 | 1 019 |
| movie | 44 | 4 391 | 5 735 | 1 434 |
| series | 30 | 3 776 | 3 602 | 1 538 |
| set | 2 | 1 544 | 1 894 | 396 |
| season | 15 | 1 804 | 1 825 | 700 |
| home | 11 | 3 476 | 1 753 | 719 |
| episode | 22 | 1 578 | 1 554 | 0 |
| person-list | 6 | 549 | 559 | 0 |
| person | 28 | 394 | 401 | 109 |

Star bands used in the reports (combined score = long-task + frame-gap ms per
minute): < 500 = 5, < 1 500 = 4, < 3 000 = 3, < 6 000 = 2, else 1.

## 4. Detail pages, after run (median per visit)

| kind | plugin req | KB | settle ms | tImg ms | tBd ms |
|---|---|---|---|---|---|
| movie | 14.3 | 10 209 | 2 371 | 681 | 89 |
| series | 12.0 | 5 556 | 2 090 | 317 | 66 |
| season | 10.9 | 1 310 | 1 116 | 215 | 62 |
| episode | 16.8 | 1 701 | 1 216 | 163 | 63 |
| person | 16.7 | 6 031 | 1 916 | 358 | 61 |
| set | 16.5 | 4 727 | 2 214 | 390 | 170 |

## 5. Per-feature attribution (targeted walk, resource timings per plugin endpoint)

Requests / MB payload per page visit (16-38 s, scrolled on list pages, tab
visible, warm cache - the byte ratios are cache-independent).

| page | CustomPoster/{id} | Extraposter/{id} | AnimatedPoster/{id} | Backdrops pools | detail endpoints | long tasks ms (max) | vanilla req / MB |
|---|---|---|---|---|---|---|---|
| lib-movies | 105 / 125 | 38 / 56 | 0 | 1 / 1 KB | - | 763 (541) | 43 / 4.4 |
| lib-tv | 0 | 41 / 44 | 0 | 1 / 1 KB | - | 774 (774) | 40 / 2.8 |
| genre | 45 / 50 | 0 | 7 / 21 | 1 / 4 KB | - | 1 615 (1 141) | 25 / 3.4 |
| tag | 39 / 37 | 0 | 23 / 68 | 1 / 4 KB | - | 800 (604) | 27 / 4.1 |
| studio | 8 / 4.8 | 0 | 2 / 2.7 | 2 / 116 KB | - | 0 | 17 / 1.6 |
| lib-collections | 0 | 0 | 0 | 1 / 1 KB | - | 549 (257) | 53 / 5.1 |
| movie | 2 / 1.5 | 1 / 0 | 2 / 2.0 | 1 / 1 KB | Characterart 2 / 1.1, CaseMod texture 2 / 0.4, others <= 1 KB | 56 | 445 / 7.4 |
| series | 1 / 0 | 1 / 0 | 1 / 0 | 1 / 1 KB | Characterart 6 / 0.8, others <= 1 KB | 0 | 35 / 5.2 |
| person | 4 / 0.7 | 1 / 0 | 2 / 6.1 | 1 / 1 KB | RedCarpet 2 / 0.6, LogoArt 17 KB | 0 | 32 / 0.6 |
| home | - | - | - | 1 / 1 KB | - | 0 | 14 / 1.2 |

Per card: Animated tiles ~3.0 MB (one long GIF - the fattest files),
Extraposter ~1.4 MB, the user's custom main poster ~1.2 MB (animated files).
In total the custom main poster costs most because it sits on every Movies
card and wins the tile slot over Animated (arbiter); Animated therefore shows
0 in the Movies/TV libraries and appears on genre/tag lists.

## 6. Conclusions

- > 99 % of the plugin's bytes are the three library-scope tile image
  endpoints on list pages; every other endpoint is <= 4 KB per page,
  Characterart ~1 MB. Main-thread time follows the image volume (GIF decode);
  Collections with zero plugin images still shows ~550 ms = Jellyfin's own
  list render. Detail pages cost 0-56 ms.
- The lever for list pages is GIF file size and which tile feature runs
  library-wide (feature switch, Also-on rows default off, delay) - not the
  scripts.
- Release verdict 2026-09-22: 0 blockers, all bugs/risks fixed, no error, no
  leak, no regression over 185 steps; two documented design facts remain
  (anonymous `/PeopleBackdrops/{id}` + case textures - LAN design; list-page
  cost above). Nobody is functionally disadvantaged by either.
- Open measurement: a fresh vanilla run under today's conditions for a true
  A/B; single-feature runs to split the list-page main-thread share (bytes
  are split above, main thread is not).
- Tooling gap: the runner records plugin requests as one count per step;
  per-endpoint attribution needed the ad-hoc collector of the targeted walk
  (`performance.getEntriesByType('resource')` grouped by feature/route,
  PerformanceObserver longtask). Worth folding into `runner.js` before the
  next full run.
