/*!
 * ArtworkPlus - Core
 * ------------------------------------------------------
 * The shared "engine" all three feature scripts (PostersPlus, RenderArt,
 * BackdropsPlus) depend on - connection and bundling functions,
 * not a feature of its own. Embedded directly in the plugin DLL (unlike
 * the three feature scripts, which stay loose files in DataFolderPath) -
 * this file is wiring, not something meant to be hand-edited after
 * install, so there's no reason to make the user copy it manually every
 * time.
 *
 * HARD DEPENDENCY, NOT OPTIONAL: every one of the three feature scripts
 * calls functions that live ONLY here. Running even just one single
 * feature still requires this file to be loaded first - without it, a
 * feature script fails immediately with a ReferenceError on its very
 * first use of window.ArtworkPlusCore. FileTransformationRegistrar.cs
 * injects this script's tag before any of the three feature tags for
 * exactly this reason.
 *
 * ARCHITECTURE NOTE: this file used to also contain the entire poster
 * arbiter/controller subsystem (participants model, decision logic,
 * render path, native-overwrite/fade-animation protection,
 * waitForPosterElement) shared by three separate poster scripts
 * (CustomPoster-v1.js/AnimatedPoster-v1.js/ExtraPoster-v1.js). That
 * subsystem has moved IN FULL to Jellyfin-ArtworkPlus-Posters-v1.js,
 * which replaced those three scripts with one unified poster system -
 * see Posters-v1.js's own header comment for the full reasoning. What
 * remains here is genuinely general, cross-feature infrastructure only -
 * verified by checking actual usage across Backdrops-v1.js/
 * CharacterArt-v1.js/RedCarpet-v1.js before anything was moved, not
 * assumed.
 *
 * WHAT'S HERE AND WHY: extracted from the six original per-feature files
 * only after actually diffing their function bodies against each other -
 * several same-named functions turned out to have real, non-cosmetic
 * differences (see below) that had to be preserved, not silently
 * discarded during the merge. Anything that looked similar on the
 * surface but genuinely differed in behavior between callers (e.g. the
 * overlay-layer-creation helpers, which target different DOM attachment
 * points on the detail page vs. a library tile vs. a freshly created
 * fixed-position container) was deliberately kept OUT of Core and left
 * as feature-specific code instead - forcing a shared abstraction there
 * risked being a worse fit for every caller than any of the originals.
 */
(function () {
    'use strict';

    // Duplicate-load guard: if window.ArtworkPlusCore already exists,
    // this is a second execution of this same script (e.g. an
    // accidental duplicate paste in JavaScript Injector) - stop
    // immediately, before anything below runs. Function definitions
    // being re-created would be harmless in isolation, but this file's
    // own final `window.ArtworkPlusCore = {...}` assignment further down
    // would NOT be - it would silently replace the live object every
    // already-loaded feature script has already captured its own
    // `Core`/`window.ArtworkPlusCore` reference to (PostersPlus/RenderArt/
    // BackdropsPlus each read `window.ArtworkPlusCore` once, at their own
    // load time, into a local `Core` variable - a later swap of the
    // global would leave their own reference pointing at the FIRST,
    // now-orphaned object forever, while any brand-new code reading
    // `window.ArtworkPlusCore` fresh would get the second one - two
    // different objects silently coexisting). Returning here instead
    // guarantees exactly one `window.ArtworkPlusCore` ever exists for
    // the lifetime of the page, regardless of how many times this
    // specific file is executed.
    if (window.ArtworkPlusCore) { return; }

    /**
     * Diagnostic logging that writes to BOTH the real console.log() AND a
     * plain in-memory array (window.ArtworkPlusDebugLog) - added
     * specifically because opening the browser DevTools console itself
     * measurably changes JS execution timing (formatting/rendering cost
     * per call only applies while the console panel is actually visible),
     * which is exactly the kind of observer effect that made a
     * user-reported, intermittent flicker impossible to capture live: the
     * problem reliably stopped occurring whenever the console was open to
     * watch for it. A plain array push has none of that per-visibility
     * cost - the array can be read out AFTER the fact
     * (window.ArtworkPlusDebugLog, or copy(window.ArtworkPlusDebugLog) in
     * the console) without the console ever needing to be open while the
     * issue is being reproduced. Capped at a fixed size to avoid unbounded
     * memory growth over a long browsing session.
     */
    var ArtworkPlusDebugLog = (window.ArtworkPlusDebugLog = window.ArtworkPlusDebugLog || []);
    var DEBUG_LOG_MAX_ENTRIES = 500;
    function debugLog() {
        var args = Array.prototype.slice.call(arguments);
        console.log.apply(console, args);
        ArtworkPlusDebugLog.push({
            t: performance.now().toFixed(1),
            // Added after a direct user request: without this, matching a
            // spoken/written description ("es passierte bei Film X") back
            // to the right lines in a long, multi-navigation log required
            // manual correlation by hand. getItemIdFromHash() is declared
            // further down in this same file, but function declarations
            // are fully hoisted in JS, so calling it here (textually
            // before its own definition) works correctly regardless of
            // where in the file this function itself sits.
            itemId: getItemIdFromHash(),
            // document.title is synchronous, already-available DOM state
            // (no extra API call) - on Jellyfin's own detail pages this
            // typically already contains the movie/show's own title,
            // giving a human-readable anchor point without adding any
            // new network request or async dependency to this purely
            // diagnostic logging path.
            pageTitle: document.title,
            msg: args.map(function (a) {
                if (a === null || a === undefined) { return String(a); }
                if (typeof a === 'object') {
                    try { return JSON.stringify(a); } catch (e) { return String(a); }
                }
                return String(a);
            }).join(' ')
        });
        if (ArtworkPlusDebugLog.length > DEBUG_LOG_MAX_ENTRIES) {
            ArtworkPlusDebugLog.splice(0, ArtworkPlusDebugLog.length - DEBUG_LOG_MAX_ENTRIES);
        }
    }

    // ---------------------------------------------------------------
    // Passive network + main-thread diagnostics - added specifically to
    // resolve a real, user-identified catch-22: recording the Network
    // tab requires DevTools open, but opening DevTools itself changes
    // the JS execution timing closely enough that the very intermittent
    // glitch under investigation stops reproducing. Both APIs below run
    // completely independently of whether DevTools is open at all -
    // they are always-on browser instrumentation, not DevTools features
    // - so this closes that gap entirely for this specific
    // investigation.
    //
    // Resource Timing API: passively records the exact start/end time of
    // every network resource (images, XHRs, etc.) the page loads,
    // usable after the fact via window.performance.getEntriesByType() -
    // but consumed here via PerformanceObserver so it's captured live
    // into the same exportable array as everything else, filtered to
    // image loads specifically (Extraposter/Backdrop/Primary images) to
    // avoid the capped array being flooded with irrelevant JS-bundle/API
    // request entries that aren't relevant to this investigation.
    if (window.PerformanceObserver) {
        try {
            var resourceObserver = new PerformanceObserver(function (list) {
                list.getEntries().forEach(function (entry) {
                    if (/Extraposter\/|Images\/(Primary|Backdrop)/.test(entry.name)) {
                        debugLog('[Core] RESOURCE-TIMING:', entry.name.replace(/^https?:\/\/[^/]+/, ''),
                            '| startTime=', entry.startTime.toFixed(1),
                            '| responseEnd=', entry.responseEnd.toFixed(1),
                            '| duration=', entry.duration.toFixed(1),
                            '| transferSize=', entry.transferSize);
                    }
                });
            });
            resourceObserver.observe({ type: 'resource', buffered: true });
        } catch (e) { /* PerformanceObserver / resource type unsupported - degrade silently, rest of the plugin is unaffected */ }
    }

    // Long Task API: passively reports whenever the browser's main
    // thread is blocked for 50ms or longer, regardless of the cause
    // (image decoding, layout, GC, any script) - directly answers
    // whether the main thread was busy with something else during the
    // exact window this project's own posterEl is hidden, which would
    // independently explain a delayed reveal without needing to guess
    // at a specific cause beforehand.
    if (window.PerformanceObserver) {
        try {
            var longTaskObserver = new PerformanceObserver(function (list) {
                list.getEntries().forEach(function (entry) {
                    debugLog('[Core] LONGTASK:', 'startTime=', entry.startTime.toFixed(1), '| duration=', entry.duration.toFixed(1));
                });
            });
            longTaskObserver.observe({ type: 'longtask', buffered: true });
        } catch (e) { /* longtask entry type unsupported in this browser - degrade silently */ }
    }

    /**
     * Extracts the itemId from the current URL hash, e.g.
     * "#/details?id=abc123" -> "abc123". Byte-identical across all four
     * scripts that used it before this extraction (ExtraPoster,
     * CharacterArt, AnimatedPoster, BackdropsPlus) - no behavioral
     * differences to preserve here.
     */
    function getItemIdFromHash() {
        var hash = location.hash || '';
        var qIndex = hash.indexOf('?');
        if (qIndex === -1) { return null; }
        return new URLSearchParams(hash.slice(qIndex + 1)).get('id');
    }

    /**
     * True when the current SPA route is a details page (movie/series/
     * person). Byte-identical across all four scripts that used it
     * before this extraction.
     */
    function isDetailsPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'details';
    }

    /**
     * Fires attemptFn() at several staggered delays after a detected
     * navigation, instead of just once - a lean "retry burst" pattern,
     * found necessary after a user report that ExtraPoster/CharacterArt/
     * AnimatedPoster/RedCarpet needed a manual page refresh to reliably
     * show up on genuine SPA navigation (library -> a movie's detail
     * page), while BackdropsPlus (the one feature NOT exhibiting this)
     * turned out to have no isDetailsPage() guard in its own navigation
     * callback at all - suggesting the real problem is a single-shot
     * attempt bailing out on a PREMATURE, still-stale read of
     * location.hash (e.g. 'viewshow' can fire slightly before
     * location.hash has actually been updated to the new page's URL),
     * with no second chance once that single check failed.
     *
     * Deliberately NOT a continuous poll-forever/self-healing watchdog
     * (a real third-party userscript shown as a reference for this exact
     * "doesn't auto-load on navigation" symptom used exactly that -
     * MutationObserver + setInterval running forever, comparing the live
     * DOM against an expected state on every tick) - that is real,
     * ongoing per-tick cost for the lifetime of the page, which isn't
     * warranted here: this specific race is only ever live for a very
     * short window right at navigation time, not indefinitely. A FIXED,
     * SMALL number of staggered attempts (default 4, at 0/300/800/1500ms)
     * covers that window without any lasting resource cost - once the
     * last attempt has fired, nothing further runs until the next
     * detected navigation.
     *
     * The leading 0ms attempt was added after a live-server HAR capture
     * showed EVERY single navigation's own quickcheck/AnimatedPoster
     * fetch consistently starting ~300ms after Main's own image request -
     * an exact match for the OLD default array's first delay (300ms),
     * confirmed by grep, not just correlation. Without a 0ms attempt,
     * every navigation unconditionally lost ~300ms doing nothing at all,
     * directly contributing to the reported "flicker even when Main ends
     * up being correct" symptom - hiding Main defensively, then not even
     * starting the fetch that would let us decide whether to un-hide it,
     * for a third of a second, on every single navigation, regardless of
     * the eventual answer. The later attempts (300/800/1500ms) are kept
     * exactly as before as the existing safety net, for the rare case
     * this 0ms attempt's own isDetailsPage()/getItemIdFromHash() reads
     * genuinely run before Jellyfin's own hash/URL state has settled.
     *
     * Deliberately carries NO built-in page-type guard (e.g. no
     * isDetailsPage() check baked in here) - RedCarpet is a real caller
     * that must NOT be limited to "details" URLs (it also runs on
     * list.html filmography pages), so a fixed isDetailsPage() check
     * here would incorrectly block it there. Every caller does its own
     * page-relevance check INSIDE attemptFn instead, re-evaluated fresh
     * at each attempt's own execution time (not just once up front) -
     * this is what actually fixes the race: a later attempt gets a
     * fresh, by-then-correct read of the current URL/hash instead of
     * trusting a possibly-premature earlier one. Callers are also
     * expected to do their own "did an earlier attempt already succeed
     * for this navigation" dedup check inside attemptFn (feature-
     * specific - what counts as "succeeded" differs per feature), so a
     * later attempt that turns out to be redundant can cheaply no-op
     * instead of redoing a fetch/DOM rebuild.
     *
     * track: the caller's own timer-tracker (from createTimerTracker()),
     * so a new navigation's clearTimers() call correctly cancels any
     * still-pending attempts from the previous one.
     */
    function scheduleNavigationBurst(attemptFn, track, delaysMs) {
        (delaysMs || [0, 300, 800, 1500]).forEach(function (delay) {
            track(setTimeout(attemptFn, delay));
        });
    }

    /**
     * Converts a viewport-width percentage to actual pixels at the
     * current window size - used for the vw-based size/offset settings
     * (CharacterArt, RedCarpet). Byte-identical in both scripts that
     * used it before this extraction.
     */
    function vwToPx(vw) {
        return window.innerWidth * (vw / 100);
    }

    /**
     * Converts a viewport-HEIGHT percentage to actual pixels - added
     * alongside vwToPx() for the new ScaleMode-based sizing system
     * (Height/Width, each with an optional Max* on the other axis) in
     * CharacterArt/RedCarpet, after a real construction flaw was found in
     * the previous pure-vw sizing: a pure vw (viewport WIDTH) size
     * doesn't correctly scale against the real constraint on the "top"
     * positions, which is VERTICAL space - width and that real
     * constraint scale along genuinely independent axes depending on the
     * window's own aspect ratio.
     */
    function vhToPx(vh) {
        return window.innerHeight * (vh / 100);
    }

    /**
     * Computes the actual box width/height in px from the ScaleMode-based
     * sizing system shared by CharacterArt and RedCarpet (Height/Width,
     * each with an optional Max* on the other axis) - moved here to
     * avoid duplicating the same logic in both scripts. Deliberately NO
     * additional, hidden page-derived constraint on top of this (e.g. a
     * ribbon-line growth limit) - an earlier version of this function had
     * exactly that as a "safety net" third parameter, which the user
     * explicitly asked to discard entirely.
     *
     * ScaleMode picks the PRIMARY dimension (always exactly HeightVh/
     * WidthVw, straight from the admin's settings, regardless of any
     * image). The OTHER dimension:
     *   - if its own Max*Vw/Max*Vh is 0 ("auto"): follows naturalAspectRatio
     *     - the box hugs whichever image naturalAspectRatio was computed
     *     from (the caller decides which - see below).
     *   - if non-zero: becomes that EXACT value, a genuine fixed
     *     container size, period - NOT a cap that gets undone by
     *     recalculating back to the image's own aspect ratio afterward.
     *     This is the whole point: a fixed-size box is what actually
     *     gives HorizontalAlign something to align WITHIN - same model
     *     as a Kodi skin texture control with two fixed dimensions and
     *     aspectratio="keep": the container size comes purely from the
     *     skin's own settings, and each image is fit + aligned inside it
     *     independently (handled here by <img> already having
     *     object-fit:contain + object-position set, per image, in both
     *     CharacterArt and RedCarpet - computeBoxSize() only has to get
     *     the CONTAINER right, the per-image fitting is plain CSS and
     *     needs no extra code here).
     *
     * An earlier version of this function capped-then-reverted: even
     * with Max* set, it silently recalculated the OTHER dimension back
     * to match naturalAspectRatio exactly afterward, so the box always
     * ended up exactly image-shaped regardless of what Max* said -
     * which is why HorizontalAlign never had any visible effect. Fixed
     * after the user pointed out the wrong mental model.
     *
     * naturalAspectRatio: which image's aspect ratio "auto" follows is
     * the CALLER's decision, not this function's - RedCarpet (a single,
     * non-rotating image) passes that one image's own ratio, recomputed
     * fresh every time a new person's image loads. CharacterArt (a
     * rotation of several images) passes the FIRST loaded image's ratio
     * and calls this only once per slideshow (layoutAppliedOnce) - so
     * "auto" stays anchored to that one reference image on purpose, not
     * recalculated per rotation frame, which is what prevents the
     * original PNG-stacking "jump" bug this whole box-based approach was
     * built to fix in the first place. Whenever Max* IS set, this
     * distinction stops mattering anyway, since the box is then fully
     * fixed regardless of which image "defined" it.
     */
    function computeBoxSize(result, naturalAspectRatio) {
        var width, height;
        if (result.ScaleMode === 'Width') {
            width = vwToPx(result.WidthVw);
            height = result.MaxHeightVh > 0 ? vhToPx(result.MaxHeightVh) : (width / naturalAspectRatio);
        } else {
            // 'Height' - also the fallback for any unrecognized value.
            height = vhToPx(result.HeightVh);
            width = result.MaxWidthVw > 0 ? vwToPx(result.MaxWidthVw) : (height * naturalAspectRatio);
        }
        return { width: width, height: height };
    }

    /**
     * Maps HorizontalAlign ('Left'/'Right'/anything else = Center) to the
     * horizontal half of a CSS object-position value - the vertical half
     * is always 'bottom': both CharacterArt's "top" and "bottom" position
     * modes (and RedCarpet's own "bottom" positions) anchor the BOX's
     * bottom edge to a fixed line/the screen edge, so every image's own
     * bottom edge needs to stay flush with that regardless of its
     * individual aspect ratio - only the horizontal half is genuinely
     * configurable.
     */
    function horizontalAlignToObjectPosition(horizontalAlign) {
        if (horizontalAlign === 'Left') { return 'left bottom'; }
        if (horizontalAlign === 'Right') { return 'right bottom'; }
        return 'center bottom';
    }

    /**
     * The actual current vertical/horizontal scroll offset - NOT simply
     * window.scrollY/document.documentElement.scrollTop, which measure
     * <html>'s own scroll state. Jellyfin's real body element carries a
     * "force-scroll" class (confirmed directly in a real browser's status
     * bar during debugging, then confirmed in the real jellyfin-web
     * source, site.scss: ".force-scroll { overflow-y: scroll; }") - i.e.
     * <body> ITSELF is the actual scrolling element, not <html>. Since
     * <html> itself never scrolls in that setup, window.scrollY/
     * document.documentElement.scrollTop stay permanently at 0 regardless
     * of how far the user has actually scrolled document.body's own
     * content - using them here previously made position:absolute
     * elements appended to document.body compute their position as if
     * the page were always scrolled to the very top, correct only at
     * scroll position 0 (matches a real user report: an element appeared
     * "stuck"/only correctly positioned when scrolled to the top).
     * document.body.scrollTop/scrollLeft is checked FIRST for exactly
     * this reason - the documentElement fallback stays only for
     * robustness on any other page type that might genuinely scroll via
     * <html> instead.
     */
    function getScrollOffset() {
        return {
            y: document.body.scrollTop || document.documentElement.scrollTop || window.scrollY || 0,
            x: document.body.scrollLeft || document.documentElement.scrollLeft || window.scrollX || 0
        };
    }

    /**
     * Preloads an image and resolves once it's actually loaded (or
     * rejects on error/timeout) - present in all six original files,
     * but genuinely NOT identical between them, so this version takes
     * an options object to cover every real variation found instead of
     * silently picking just one:
     *
     *   - resolveWith: 'url' (default) resolves with the URL string
     *     (script.js/library.js/animatedposter.js only ever needed the
     *     URL back); 'image' resolves with the loaded Image object
     *     itself (characterart.js/redcarpet.js need
     *     img.naturalWidth/naturalHeight for their aspect-ratio math -
     *     the URL string alone isn't enough for those two).
     *   - timeoutMs: rejects with a timeout error after this many
     *     milliseconds if the image hasn't loaded yet. Omit/pass null
     *     for no timeout at all (backdrops.js deliberately never had
     *     one, relying purely on the browser's own image-loading
     *     behavior).
     *   - track: an optional function (e.g. from createTimerTracker()
     *     below) to route the internal setTimeout handle through, so
     *     the CALLER's own race-condition cancellation logic can still
     *     clear it - three of the five original scripts (ExtraPoster,
     *     CharacterArt, RedCarpet) relied on this, two others
     *     (AnimatedPoster's own preloadImage, and library.js's) called
     *     plain setTimeout without tracking. Omit for the untracked
     *     behavior.
     */
    /**
     * Real, confirmed bug this fixes (not a defensive guess): a URL
     * embedded directly into a CSS url('...') value the way this
     * project's own code did everywhere ("url('" + url + "')") breaks
     * the moment the URL itself contains a literal apostrophe -
     * confirmed via a real Network-tab trace showing the image loading
     * successfully (200, served from disk cache) while never actually
     * appearing on screen. Root cause: encodeURIComponent() does NOT
     * encode an apostrophe (it's one of its "unreserved" characters per
     * spec, confirmed directly against real output), so a poster's own
     * FileName - which is built server-side from the media folder's own
     * name (ExtraposterController.cs/AnimatedPosterController.cs/
     * BackdropsController.cs: Path.GetFileName(folderPath) + "..."),
     * NOT sanitized in any way there - passes an apostrophe straight
     * through into the URL untouched whenever the movie/show's own
     * title/folder name contains one (e.g. "Marvel's The Avengers
     * (2012)", "Shoot 'Em Up (2007)"). That literal apostrophe then
     * closes the CSS string one character early, leaving the rest as
     * invalid CSS the browser silently discards - the whole
     * background-image declaration is dropped, not just truncated, so
     * the element stays fully transparent even though the underlying
     * <img> preload (a completely different, CSS-unrelated code path)
     * succeeded moments earlier. CharacterArt/RedCarpet never hit this
     * because they assign to a real <img>.src property instead - a
     * plain property assignment, not a CSS string that needs its own
     * quoting - so an apostrophe there is just an ordinary URL
     * character with no special meaning to escape.
     *
     * Percent-encoding the apostrophe here (to %27, otherwise
     * byte-for-byte identical - the server decodes %27 and a literal
     * apostrophe identically, so this changes nothing about which file
     * gets requested) sidesteps the CSS quoting collision entirely,
     * without needing to reason about every other character CSS
     * url('...') might also treat specially.
     */
    /**
     * Real, confirmed root cause of a "manchmal erscheint es nicht, erst
     * nach Reload" bug (found via a real console trace on CharacterArt:
     * on a navigation where every other log line looked completely
     * successful, the position-recalculation log simply never appeared
     * - meaning the position math silently failed). A plain
     * document.querySelector() for something that lives on the item
     * detail page (the clearlogo, the poster card, the ribbon, etc.)
     * searches the ENTIRE document, but Jellyfin keeps up to THREE
     * complete itemDetailPage DOM trees alive simultaneously (source-
     * confirmed, viewContainer.js: pageContainerCount = 3) - only the
     * currently active one lacks the "hide" class; up to two older,
     * fully-rendered-but-hidden pages from PREVIOUS navigations stay in
     * the DOM right alongside it. A document-wide query returns
     * whichever matching element comes FIRST in DOM order, regardless
     * of which page is actually visible - if that happens to be a
     * stale, hidden page's own element, it's invisible/collapsed
     * (hidden element), which any caller's own zero-size/missing-anchor
     * guard would then treat as "not found" and give up - explaining
     * both the "sometimes works, sometimes doesn't" (depends on which
     * page happens to be first in DOM order) and "always works after a
     * reload" (a fresh load only ever has the one, current page in the
     * DOM) symptoms exactly.
     *
     * Fixed by first finding the specific page element that is
     * actually visible (the one WITHOUT "hide"), then having the
     * caller search only inside that one - never a stale page
     * alongside it. Callers should use this instead of a bare
     * `document.querySelector(...)` for anything that lives inside the
     * item detail page itself (NOT for things Jellyfin renders once,
     * globally, outside the page cache - e.g. .backdropContainer/
     * .backgroundContainer, source-confirmed as a single React-rendered
     * element outside the mainAnimatedPages tree, unaffected by this).
     *
     * Returns null if no visible detail page is found at all (shouldn't
     * normally happen while a feature script calling this is even
     * running) - callers should fall back to `document` in that case,
     * matching this project's own established "imperfect but non-zero"
     * fallback pattern rather than returning nothing.
     */
    function findVisibleDetailPage() {
        var pages = document.querySelectorAll('.mainAnimatedPage.itemDetailPage');
        for (var i = 0; i < pages.length; i++) {
            if (!pages[i].classList.contains('hide')) { return pages[i]; }
        }
        return null;
    }

    function cssUrl(url) {
        return "url('" + String(url).replace(/'/g, '%27') + "')";
    }

    /**
     * Centralizes a pattern that used to be independently copy-pasted,
     * byte-for-byte identical except for the tag string, in every single
     * feature module across the whole plugin (nine separate occurrences
     * found during a pluginwide consistency pass: PostersPlus itself plus
     * its three source modules, CharacterArt, RedCarpet, Backdrops, and
     * People Backdrops). Pure infrastructure - "prefix console.log with a
     * bracketed tag, or do nothing if DEBUG is off" is genuinely the same
     * task everywhere it appeared, not a superficial resemblance.
     */
    /**
     * Duplicate-load guard for feature scripts (PostersPlus/RenderArt/
     * BackdropsPlus). One call per genuinely independent top-level IIFE
     * (RenderArt and BackdropsPlus each have TWO - CharacterArt+RedCarpet,
     * Backdrops+PeopleBackdrops - which have never shared any state with
     * each other and are guarded separately here for exactly that reason,
     * not merged into one marker per file).
     *
     * Returns true the FIRST time a given name is claimed on this page
     * (the caller should proceed with its own normal initialization),
     * false every time after (the caller should return immediately,
     * before registering any observer/listener/timer/DOM layer of its
     * own - see each feature file's own call site for the exact cutoff
     * point). Deliberately lives on `window.ArtworkPlusCore` itself
     * (already the shared, page-wide namespace every feature script
     * already depends on) rather than introducing a second global - a
     * feature script re-executing after Core has ALREADY been guarded
     * against its own duplicate load (see the top of this file) will
     * always find the SAME registry object here, not a fresh one.
     */
    var claimedSingletons = {};
    function claimSingleton(name) {
        if (claimedSingletons[name]) { return false; }
        claimedSingletons[name] = true;
        return true;
    }

    /**
     * Runtime debug switch (Session 114). The feature modules' own DEBUG
     * constants used to be the only gate and were mostly `true`, so every
     * page view spammed the console with dozens of [RedCarpet]/[Characterart]
     * lines. Now a module's logger is live only when its DEBUG constant is
     * true AND `localStorage.ArtworkPlusDebug` enables its tag:
     *   (unset / '')            silent - the default for users
     *   'all' | '*' | '1'       every module
     *   'CaseMod,Backdrops'     comma list, case-insensitive substring of the tag
     * Set it from the console: ArtworkPlusCore.setDebug('all'), then reload.
     * Errors/warnings still use console.error/warn directly and are never
     * gated. The value is read once per makeLogger() call, i.e. per page load.
     */
    function readDebugSetting() {
        try { return (window.localStorage.getItem('ArtworkPlusDebug') || '').trim(); }
        catch (e) { return ''; }
    }
    function isDebugTagEnabled(tag) {
        var v = readDebugSetting();
        if (!v) { return false; }
        if (v === 'all' || v === '*' || v === '1') { return true; }
        var t = String(tag).toLowerCase();
        var parts = v.toLowerCase().split(',');
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i].trim();
            if (part && t.indexOf(part) !== -1) { return true; }
        }
        return false;
    }
    function setDebug(value) {
        try {
            if (value) { window.localStorage.setItem('ArtworkPlusDebug', String(value)); }
            else { window.localStorage.removeItem('ArtworkPlusDebug'); }
        } catch (e) { /* storage unavailable - nothing to do */ }
        return 'ArtworkPlusDebug=' + (readDebugSetting() || '(off)') + ' - reload the page to apply';
    }

    function makeLogger(tag, debugEnabled) {
        return (debugEnabled && isDebugTagEnabled(tag))
            ? function () { console.log.apply(console, [tag].concat([].slice.call(arguments))); }
            : function () {};
    }

    /**
     * General-purpose presence watchdog - NOT poster-specific (used by
     * RenderArt-v1.js's own CharacterArt section). Several features' own navigation-burst
     * mechanisms only fire around an actual navigation (a hash change) -
     * they fire a few staggered attempts, then go silent until the NEXT
     * navigation. That leaves a real gap: if Jellyfin's own client-side
     * rendering rebuilds/replaces the container a feature's own element
     * was inserted into or near, at any point AFTER its own burst
     * attempts have already finished, that element is silently gone and
     * nothing ever notices or reinserts it.
     *
     * isPresent: a cheap function the caller provides, returning true if
     * its own element is CURRENTLY correctly present. Called frequently,
     * so it needs to be cheap - no network requests, no heavy DOM
     * queries.
     *
     * recover: called whenever isPresent() returns false - normally just
     * the SAME start()/schedule() function the caller already uses for
     * ordinary navigation handling.
     *
     * Runs BOTH on a plain interval (a true heartbeat) AND on a
     * debounced MutationObserver (catches most real cases much faster
     * than waiting for the next interval tick).
     */
    function startPresenceHeartbeat(isPresent, recover, intervalMs) {
        function check() {
            if (!isPresent()) { recover(); }
        }
        setInterval(check, intervalMs || 750);
        var mutationDebounceHandle = null;
        new MutationObserver(function () {
            if (mutationDebounceHandle) { clearTimeout(mutationDebounceHandle); }
            mutationDebounceHandle = setTimeout(check, 200);
        }).observe(document.body, { childList: true, subtree: true });
    }


    function preloadImage(url, options) {
        var opts = options || {};
        var resolveWith = opts.resolveWith || 'url';
        var timeoutMs = opts.timeoutMs;
        var track = opts.track || function (handle) { return handle; };

        return new Promise(function (resolve, reject) {
            var img = new Image();
            // Real, confirmed root cause of an intermittent user-reported
            // "brief empty poster" glitch (4/4 reproduced cases, live-server
            // Resource Timing data): this image can lose the browser's
            // limited concurrent-connections-per-origin race against other,
            // simultaneously-starting same-origin image requests (the
            // Similar-carousel thumbnails, the item's own large Primary
            // image) - in the worst observed case this alone accounted for
            // ~593ms of a ~659ms total delay. fetchPriority is the standard,
            // purpose-built browser API for exactly this: telling the
            // browser this specific image matters more than others
            // currently competing for the same limited connections. Does
            // not eliminate the underlying race (a browser can still be
            // saturated by other high-priority work), but directly targets
            // the confirmed mechanism. Unsupported in older browsers -
            // setting an unknown property on an Image element is a no-op,
            // never an error, so this degrades safely everywhere.
            //
            // REAL, MEASURED PERFORMANCE BUG FOUND AND FIXED (via a
            // dedicated red-team hardening pass, against a real local HTTP
            // server with genuine browser connection-limit behavior, not
            // just a mock): every caller used to get 'high' unconditionally
            // - including the newer silentlyPreload() background-warming
            // calls (see BackdropsPeople-v1.js/Backdrops-v1.js), which
            // never existed when 'high' was originally chosen and tuned for
            // exactly ONE concurrent, genuinely-important image race. With
            // many images (e.g. an item with 200 BackdropImageTags), ALL of
            // them silently preloading at once with 'high' priority put the
            // one ACTUALLY important, currently-visible image in the same
            // priority bucket as up to 199 background ones it doesn't need
            // to compete with at all - measured directly: the visible image
            // took 11504ms to appear with 200 concurrent 'high'-priority
            // preloads, vs. 1617ms (matching the ~1-image baseline almost
            // exactly) once background preloads were dropped to 'low'.
            // Fixed with a new optional `priority` option here, defaulting
            // to 'high' (so every EXISTING call site - the one that matters
            // most, the actually-displayed image - is completely
            // unaffected) - only silentlyPreload()'s own background calls
            // opt into 'low' explicitly.
            img.fetchPriority = opts.priority || 'high';
            var timeout = null;
            if (timeoutMs) {
                timeout = track(setTimeout(function () {
                    reject(new Error('Timeout while loading: ' + url));
                }, timeoutMs));
            }
            img.onload = function () {
                if (timeout) { clearTimeout(timeout); }
                // REAL BUG FOUND AND FIXED (user report: the very first
                // image of a People Backdrops slideshow appears "hard"
                // instead of fading in; later images fade fine).
                // onload only means the bytes arrived - the image is NOT
                // decoded yet. Decoding a large backdrop (real logs show
                // Wallpapers.com files up to 5792x3258) takes hundreds
                // of ms, and the browser only decodes a CSS
                // background-image when it first has to raster it - i.e.
                // exactly when the caller starts its opacity transition.
                // Measured directly (real 5792x3258 PNG, real Jellyfin
                // CSS, per-frame screenshots): the first painted frame
                // after appending the element came ~560ms late, so the
                // 800ms fade effectively started at ~500ms; in a real
                // GPU-rastering browser the compositor keeps animating
                // opacity during that async decode and the image then
                // pops in mid-fade. Small images (fast decode) faded
                // perfectly in the same test - which is also why only
                // the FIRST image was ever affected: it is the only one
                // rendered immediately after being fetched; every later
                // one had been silently preloaded seconds earlier. Fix:
                // wait for the browser's own decode() (the purpose-built
                // API for exactly this) before resolving, so by the time
                // the caller appends the element and starts the fade,
                // the decoded bitmap is already in the image cache and
                // rastering is immediate. decode() rejecting (e.g. an
                // unsupported/corrupt encoding the <img> nonetheless
                // 'load'ed) is treated as "still usable, just not
                // pre-decoded" - the old behavior - never as a failure.
                // The timeout is cleared BEFORE decoding on purpose: the
                // network part succeeded, a slow decode must not be
                // reported as a load timeout.
                var done = function () { resolve(resolveWith === 'image' ? img : url); };
                if (typeof img.decode === 'function') {
                    img.decode().then(done, done);
                } else {
                    done();
                }
            };
            img.onerror = function () {
                if (timeout) { clearTimeout(timeout); }
                reject(new Error('Error while loading: ' + url));
            };
            img.src = url;
        });
    }

    /**
     * Returns a fresh, independent {track, clearTimers} pair - the
     * race-condition-guard pattern used by ExtraPoster/CharacterArt/
     * RedCarpet to cancel all of a run's pending timers/intervals when
     * a new run starts (e.g. fast SPA navigation between two detail
     * pages before the first one finished loading). track()/clearTimers()
     * themselves were byte-identical across the three scripts that used
     * them - what genuinely differed was that EACH script closed over
     * its OWN module-level `timers` array. A single shared pair of
     * plain functions here would make every caller share ONE array,
     * breaking independent cancellation between features entirely
     * (e.g. CharacterArt's page-navigation cleanup would also cancel
     * ExtraPoster's still-valid timers) - hence a factory, not two
     * plain exports, so each caller gets its own private closure.
     */
    function createTimerTracker() {
        var timers = [];
        return {
            track: function (handle) {
                timers.push(handle);
                return handle;
            },
            clearTimers: function () {
                timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
                timers = [];
            }
        };
    }

    /**
     * Ensures document.body is a genuine CSS "containing block" for
     * position:absolute children - fixes a real, deep-seated bug found
     * only after the user pointed out that .skinHeader (real
     * position:fixed) and .backdropContainer correctly stay put on
     * scroll, while CharacterArt's "top" positions' position:absolute
     * elements did NOT correctly scroll away with the page - they
     * behaved as if they were position:fixed too, despite being set to
     * position:absolute and despite the scroll-offset math itself
     * (getScrollOffset()) being correct.
     *
     * ONLY relevant to position:absolute elements - as of the later
     * "glue to the window" redesign, RedCarpet and CharacterArt's
     * "bottom" positions no longer use position:absolute at all (they're
     * genuine position:fixed now, per the user's explicit, sketch-
     * confirmed request), so this function no longer matters for them;
     * CharacterArt's "top" positions are the only remaining caller.
     *
     * Root cause, confirmed directly against the real jellyfin-web
     * source (site.scss): <body> has NO explicit "position" property set
     * at all (only overflow-x/height/etc. via the "fullpage" mixin) -
     * per the CSS spec, position:absolute without SOME positioned
     * ancestor is positioned relative to the "initial containing block"
     * (effectively the viewport), NOT relative to <body>'s own scrolled
     * content, even though <body> itself is genuinely the page's real
     * scrolling element (see getScrollOffset()'s own doc comment). That
     * mismatch is exactly why elements appended straight to
     * document.body with position:absolute effectively behaved like
     * position:fixed - completely independent of which scroll value was
     * used to compute their "top", since the coordinate system itself
     * was wrong, not the number plugged into it.
     *
     * Fix: give <body> itself position:relative, making it a genuine
     * containing block for position:absolute descendants without
     * otherwise changing its own rendering (position:relative with no
     * top/left/etc. has no visible effect on the element itself, it only
     * changes what counts as the containing block for absolutely-
     * positioned descendants). Checked first via getComputedStyle rather
     * than blindly overwriting - if <body> already has some OTHER
     * explicit position (e.g. set by a different plugin), that's left
     * alone rather than silently overridden. Idempotent and safe to call
     * from any feature script that still needs it - only the first call
     * actually changes anything.
     */
    function ensureBodyIsPositioned() {
        try {
            var current = window.getComputedStyle(document.body).position;
            if (current === 'static') {
                document.body.style.position = 'relative';
            }
        } catch (e) { /* getComputedStyle/style access failing here would be unusual - just skip the fix rather than throw */ }
    }

    /**
     * Watches for SPA navigation changes and calls onChange() whenever the
     * relevant part of location.hash actually changes - as a continuous,
     * timer-based BACKUP alongside (not instead of) each feature script's
     * existing 'viewshow' listener.
     *
     * WHY THIS EXISTS: every one of the (then five, now four after the
     * PostersPlus consolidation) feature scripts previously
     * relied solely on Jellyfin's own 'viewshow' event plus a one-shot
     * initial timeout for detecting navigation - no continuous polling at
     * all. In practice this needed a manual page refresh to pick up some
     * navigations (confirmed by comparing against two versions of a
     * third-party userscript the user had already solved this exact
     * problem for - the working version polls via a plain setInterval
     * checking for not-yet-processed elements, every 1000ms, in addition
     * to whatever event-based detection exists; the version that still
     * needed manual refreshes did not). 'viewshow' is presumably not fired
     * reliably for every kind of navigation (e.g. browser back/forward) -
     * a continuous poll is not tied to any particular Jellyfin internal
     * event firing correctly, so it catches those cases too.
     *
     * Deliberately watches location.hash directly (not a MutationObserver
     * on the DOM) - cheap to poll every second, and the hash is already
     * the single source of truth getItemIdFromHash()/isDetailsPage() both
     * read from, so there's nothing more specific to observe.
     */
    /**
     * See its own extensive doc comment further up for the general
     * "why a continuous poll at all" reasoning. This ALSO listens for
     * 'viewshow' itself, purely to keep its own internal lastHash
     * synchronized - NOT to call onChange() a second time from there.
     *
     * Root cause, confirmed directly against the real jellyfin-web
     * source (components/viewManager/viewManager.js): 'viewshow' is
     * dispatched exactly ONCE per genuine navigation (onViewChange(),
     * called from loadView()/tryRestoreView()) - it does NOT fire
     * multiple times per navigation, ruling out an earlier, unverified
     * theory about that. The REAL double-trigger this function's own
     * poll caused: every one of the three feature scripts ALSO has its
     * own direct 'viewshow' listener (calling schedule() immediately,
     * synchronously, the moment the real navigation happens) - but this
     * function's OWN lastHash was previously only ever updated from
     * inside its own setInterval tick, never told about that immediate,
     * already-handled change. So even after 'viewshow' had already
     * triggered a full schedule()/render cycle for a given navigation,
     * this poll's next tick (up to pollMs later) would independently
     * notice the very same location.hash change and call onChange()
     * AGAIN for the exact same navigation - a real, confirmed second,
     * delayed schedule() call landing mid-render on top of the first,
     * already-succeeding one. Exactly matches a user-reported "pops up,
     * disappears, pops up again" symptom. Listening for 'viewshow' here
     * too and syncing lastHash from it (without calling onChange) closes
     * that gap: by the time this poll's own next tick runs, lastHash is
     * already caught up, so it correctly sees no further change and
     * stays silent for that navigation.
     */
    function watchForNavigation(onChange, pollMs) {
        var lastHash = location.hash;
        document.addEventListener('viewshow', function () { lastHash = location.hash; });
        setInterval(function () {
            if (location.hash !== lastHash) {
                lastHash = location.hash;
                onChange();
            }
        }, pollMs || 1000);
    }

    // Standard Fisher-Yates - genuinely unbiased, unlike naively sorting
    // by Math.random() (which most JS engines implement with a
    // non-uniform sort algorithm, skewing the result). Extracted here
    // (originally lived only in Backdrops-v1.js) so both that file
    // and BackdropsPeople-v1.js can share the exact same, already-
    // verified implementation - see createBackdropRotationEngine()'s own
    // doc comment below for the full "why" behind this specific
    // extraction.
    function fisherYatesShuffle(arr) {
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
        return arr;
    }

    // Real, user-identified refactor: Backdrops-v1.js's own rotation-
    // TIMING/ORDERING logic (which image is next, in Sequential/Shuffle/
    // Random order, on what interval) is genuinely almost identical to
    // what People Backdrops needs - the only real difference between the
    // two features is WHERE the images actually get drawn (BackdropsPlus
    // covers Jellyfin's own native .backdropContainer on movie/show
    // detail pages; People Backdrops has no equivalent native element to
    // work with on Person pages at all, and must build its own container
    // from scratch, closer to how RedCarpet already does it) - see the
    // curriculum's own "People Backdrops" milestone for the full
    // reasoning behind extracting exactly this part, and not the
    // container-acquisition logic, which stays feature-specific in each
    // of the two .js files.
    //
    // Deliberately a FACTORY, not a single shared piece of state -
    // Backdrops-v1.js and BackdropsPeople-v1.js each call this once
    // to get their own, fully independent engine instance (own images
    // list, own current index, own shuffle-bag, own interval handle) -
    // running both features on the same page at once (e.g. a person's
    // own filmography page, which is BOTH a People Backdrops scope AND
    // shows a movie/show with its own native-covering BackdropsPlus
    // rotation) must never have one feature's rotation state bleed into
    // the other's.
    //
    // renderImage(url, index) is supplied by the CALLER (each of the two
    // .js files' own setBackdropImage()-equivalent) - this engine only
    // ever decides WHICH url is next and WHEN, never how it's actually
    // drawn into the page.
    function createBackdropRotationEngine() {
        var state = {
            images: [],
            index: -1,
            intervalHandle: null,
            paused: false,
            _orderMode: 'Sequential',
            _randomBag: [],
            _cycleMs: null,
            // Real bug found via a full audit, not a reported symptom:
            // the interval used to be started the moment a SECOND image
            // streamed in (addImages below) or immediately at start()
            // for a multi-image list - counting cycleMs from THAT
            // moment, not from when the currently-showing image
            // actually finished loading and became visible (rendering
            // is always async - preloadImage()/decode time). Measured
            // directly: with a realistic streamed second image arriving
            // ~1s after the first became visible and an 8000ms cycle,
            // the first image ended up showing for ~9s, not 8s - and
            // the exact overshoot varied every time depending on
            // network/streaming timing, never a clean, predictable
            // cycle length. Fixed by no longer using a single blind
            // setInterval at all - see scheduleNextTick() below, which
            // this timestamp feeds.
            _currentImageShownAt: null
        };

        function tick(renderImage) {
            if (state.paused || state.images.length === 0) { return; }

            var nextIndex;
            if (state._orderMode === 'Shuffle') {
                if (state._randomBag.length === 0) {
                    var bag = [];
                    for (var i = 0; i < state.images.length; i++) { bag.push(i); }
                    fisherYatesShuffle(bag);
                    // Avoids the one remaining edge case a plain
                    // shuffle-bag still allows: the last pick of the
                    // previous round and the first pick of the freshly-
                    // refilled one landing on the same image back-to-
                    // back, purely by chance. Only relevant with 2+
                    // images (with exactly 1, showing it "again" is the
                    // only possible outcome anyway).
                    if (bag.length > 1 && bag[0] === state.index) {
                        var swapWith = 1 + Math.floor(Math.random() * (bag.length - 1));
                        bag[0] = bag[swapWith];
                        bag[swapWith] = state.index;
                    }
                    state._randomBag = bag;
                }
                nextIndex = state._randomBag.shift();
            } else if (state._orderMode === 'Random') {
                // Deliberately the simplest possible random pick - a
                // plain, independent draw on every tick, no bag, no
                // "never twice in a row" guard. The same image CAN
                // repeat, or sit unseen for a long stretch, genuine,
                // textbook random, as explicitly requested (distinct
                // from "Shuffle" above, which guarantees no repeats
                // within a round).
                nextIndex = Math.floor(Math.random() * state.images.length);
            } else {
                nextIndex = state.index + 1;
                if (nextIndex >= state.images.length) { nextIndex = 0; }
            }

            state.index = nextIndex;
            // REAL BUG FOUND AND FIXED (scoped fade audit): mark the render
            // as in flight. Until imageShown() re-anchors the timer, any
            // scheduleNextTick() call (addImages() from a same-person
            // subpage fetch is the real-world trigger) would otherwise
            // measure "elapsed" against the PREVIOUS image's shownAt,
            // find a full cycle already elapsed, and fire a second
            // render immediately - reproduced as two appends 144ms apart.
            // The window was tiny (just the preload) before the first
            // image's fade began waiting for a quiet page; the race
            // itself predates that. With shownAt null, scheduleNextTick()
            // does nothing until the in-flight image is actually shown.
            state._currentImageShownAt = null;
            renderImage(state.images[nextIndex], nextIndex);
        }

        // Real bug found via a full audit: the old code used a single
        // setInterval(fn, cycleMs) fired once, either immediately at
        // start() (multi-image case) or once a second image streamed
        // in (addImages case) - counting the FULL cycle time from
        // whichever of those moments happened to trigger it, not from
        // when the image actually being displayed right now became
        // visible. Replaced with a self-rescheduling chain of
        // setTimeout calls instead: every time the caller confirms (via
        // imageShown() below) that an image actually finished loading
        // and is now on screen, this recalculates exactly how much of
        // the configured cycle time is left and schedules just that
        // remainder - not a fresh full cycle, and not counting from an
        // unrelated earlier event. This naturally self-corrects every
        // single cycle (each new imageShown() call re-anchors the next
        // one), rather than accumulating drift.
        function scheduleNextTick() {
            if (state.intervalHandle) {
                clearTimeout(state.intervalHandle);
                state.intervalHandle = null;
            }
            if (state.images.length <= 1 || state._currentImageShownAt === null) {
                // Nothing to rotate to yet, or no confirmed on-screen
                // image to measure the remaining time from - imageShown()
                // will call this again once both are true.
                return;
            }
            var elapsed = Date.now() - state._currentImageShownAt;
            var remaining = Math.max(0, state._cycleMs - elapsed);
            state.intervalHandle = setTimeout(function () {
                tick(state._lastRenderImage);
            }, remaining);
        }

        function start(images, orderMode, cycleMs, renderImage) {
            // REAL BUG FOUND AND FIXED: this used to skip restarting
            // whenever the incoming image list happened to already
            // match state.images exactly - intended to avoid an
            // unnecessary restart of an ALREADY-RUNNING rotation. But
            // state.images can also already be non-empty and equal to
            // the incoming list WITHOUT the rotation ever having
            // actually rendered anything yet: addImages() (used by the
            // seamless same-person subpage-continuation path) only
            // pushes URLs into state.images and never renders on its
            // own - if a same-person subpage fetch (which calls
            // addImages()) happened to finish BEFORE the person's own
            // still-in-flight fresh-visit fetch (which calls start()
            // with that same first URL), state.images already held
            // that exact URL by the time start() ran, sameList matched,
            // start() returned immediately, and NO image was EVER
            // rendered - confirmed directly: a fresh visit's first
            // image staying invisible indefinitely (0 DOM elements),
            // not just a delayed or skipped fade-in. state._currentImage-
            // ShownAt !== null is the one genuine signal that an image
            // has actually been confirmed on screen (set exclusively by
            // imageShown() below) - only that, not merely a non-empty,
            // coincidentally-matching state.images, justifies skipping
            // this restart.
            var sameList = state._currentImageShownAt !== null
                && images.length === state.images.length
                && images.every(function (url, i) { return url === state.images[i]; });
            if (sameList) { return; }

            clear();
            state.images = images;
            state._orderMode = orderMode;
            state._cycleMs = cycleMs;
            state.index = -1;
            // Stashed so advance() below can trigger an out-of-schedule
            // tick using the exact same callback, without the caller
            // having to pass it again.
            state._lastRenderImage = renderImage;

            // No setInterval set up here anymore (see scheduleNextTick's
            // own doc comment above for why) - the very first tick below
            // shows the first image; once the CALLER confirms via
            // imageShown() that it actually finished loading and is on
            // screen, THAT triggers the first real scheduling.
            tick(renderImage);
        }

        function clear() {
            if (state.intervalHandle) { clearTimeout(state.intervalHandle); }
            state.intervalHandle = null;
            state.images = [];
            state.index = -1;
            // A stale bag full of indices into the OLD image list would
            // be meaningless (and could throw/misbehave) against a new
            // one - always cleared alongside images/index.
            state._randomBag = [];
            state._currentImageShownAt = null;
            // Also cleared so a late-arriving async advance() call (e.g.
            // a stale image-load-failure callback from before this
            // clear()) becomes a safe no-op afterwards, rather than
            // re-invoking a callback for content that's no longer
            // current. tick()'s own images.length===0 guard already
            // covers the moment right after this clear() specifically;
            // this additionally covers the case where clear() ran but no
            // new start() has happened yet.
            state._lastRenderImage = null;
        }

        return {
            start: start,
            clear: clear,
            setPaused: function (paused) { state.paused = paused; },
            // Real, user-requested resilience mechanism (People
            // Backdrops-specific need, not used by Backdrops-v1.js):
            // triggers one immediate, out-of-schedule tick using
            // whatever renderImage callback the last start() call
            // supplied - lets a caller advance past a just-detected dead
            // image right away, instead of waiting for the regular
            // interval to eventually do it. Safe to call at any time -
            // tick() itself already no-ops if there's no images/state to
            // advance through, and calling this doesn't reset or
            // interfere with the regularly-scheduled next tick (see
            // scheduleNextTick's own doc comment - that gets re-anchored
            // by the CALLER's own next imageShown() call regardless of
            // whether this advance() or the regular schedule triggered
            // the render).
            // Known, accepted minor edge case: if a stale async image-
            // load-failure callback from a PREVIOUS person's rotation
            // resolves AFTER a brand new start() has already begun for a
            // DIFFERENT person (a fast-navigation race), this could
            // trigger one extra, slightly-early tick for the NEW
            // person's rotation rather than being safely discarded.
            // Harmless in practice - at worst one image switches a
            // little sooner than its normal interval would have, never
            // a wrong image, crash, or state corruption - so not worth
            // the added complexity of a full generation/token system in
            // the engine itself just to close this specific, narrow
            // window.
            advance: function () {
                if (state._lastRenderImage) { tick(state._lastRenderImage); }
            },
            // Session 116: which URL the NEXT tick will render, without
            // advancing anything - lets a caller warm exactly that one
            // image instead of bulk-preloading the whole pool. Shuffle:
            // the head of the current bag (or, with an empty bag, unknown
            // until the next refill - returns null then, which the caller
            // treats as "nothing to warm"). Random: unknowable, null.
            // Sequential: the next index.
            peekNext: function () {
                if (state.images.length === 0) { return null; }
                if (state._orderMode === 'Shuffle') {
                    return state._randomBag.length ? state.images[state._randomBag[0]] : null;
                }
                if (state._orderMode === 'Random') { return null; }
                var i = state.index + 1;
                if (i >= state.images.length) { i = 0; }
                return state.images[i];
            },
            // REAL, CRITICAL BUG FOUND AND FIXED via a full audit (not a
            // reported symptom - found by deliberately testing "what if
            // every image in the rotation fails to load"): the old
            // advance()-on-failure mechanism just called tick() again,
            // which picks the NEXT image by index/shuffle/random but
            // never removes the failed one from state.images. If every
            // image in the list fails (a real, plausible scenario for
            // People Backdrops specifically, given images are hotlinked
            // from an external site rather than loaded from Jellyfin's
            // own local, reliable storage - e.g. the source site
            // temporarily blocking hotlinking, or a candidate that
            // passed the server's OWN download check during population
            // but no longer resolves later when the browser tries it),
            // this produced a genuine, unbounded, fully SYNCHRONOUS
            // failure loop - confirmed directly: 519 log lines / over
            // 170 failed attempts in just 3 seconds of wall-clock time
            // in one real test, with no image ever shown and no natural
            // end. Fixed the simplest way that's ALSO naturally
            // guaranteed to terminate, no attempt-counter or backoff
            // needed: permanently remove a failed URL from state.images
            // (not just skip past it) - every single failure then
            // shrinks the list by one, so the loop is mathematically
            // bounded by the list's own original length and always
            // terminates, either at a working image or at an empty
            // list (handled gracefully below, not as another failure).
            removeFailedImage: function (url) {
                var idx = state.images.indexOf(url);
                if (idx === -1) { return; }
                state.images.splice(idx, 1);
                // Keep state.index pointing at the same LOGICAL image
                // it did before the removal, not silently drifting onto
                // whatever now occupies the removed slot - only matters
                // for Sequential order (Shuffle/Random don't rely on
                // index continuity the same way, and re-deriving their
                // next pick from a shrunk list is already safe as-is).
                if (idx < state.index) { state.index -= 1; }
                else if (idx === state.index) { state.index -= 1; }
                // REAL BUG FOUND AND FIXED (Session 113, seen live during a
                // DNS outage that made every hotlink fail): the Shuffle
                // bag still held indices into the OLD, longer list. After
                // the splice an index >= the new length picked
                // state.images[i] === undefined and handed "undefined" to
                // the loader (4 such attempts logged for 8 dead images).
                // Same repair clear() already does, but keeping the
                // current round intact: drop the removed index and shift
                // every higher one down by one.
                var bag = [];
                for (var b = 0; b < state._randomBag.length; b++) {
                    var v = state._randomBag[b];
                    if (v === idx) { continue; }
                    bag.push(v > idx ? v - 1 : v);
                }
                state._randomBag = bag;
                if (state.images.length === 0) {
                    // Nothing left at all - stop cleanly rather than
                    // letting a caller's own advance()/tick() call find
                    // an empty list over and over. clear() also resets
                    // _currentImageShownAt/index/etc, which is correct
                    // here: there is no "current image" left to speak
                    // of anymore.
                    clear();
                }
            },
            // Called by the CALLER once an image it was just told to
            // render has actually finished loading and is confirmed on
            // screen - see scheduleNextTick's own doc comment above for
            // why this, rather than a blind setInterval, is what now
            // drives the rotation's timing. Safe to call even if this
            // engine instance isn't the one currently owning the
            // caller's UI (e.g. a late-arriving confirmation after
            // clear() already ran) - scheduleNextTick() itself no-ops
            // once state.images is empty.
            imageShown: function () {
                state._currentImageShownAt = Date.now();
                scheduleNextTick();
            },
            // Added specifically for People Backdrops' own streaming
            // population (not used by Backdrops-v1.js, which already
            // has its full image list upfront from local Jellyfin data -
            // no reason to ever call this there). Lets a caller add
            // newly-arrived images to an ALREADY-RUNNING rotation
            // without resetting it - the currently-displayed image
            // keeps showing, the cycle timer keeps its own existing
            // schedule untouched (this no longer starts a fresh timer
            // here at all - see scheduleNextTick's own doc comment;
            // whatever's already scheduled, anchored to when the
            // current image was actually confirmed shown, keeps
            // running exactly as it was), and the new image(s) simply
            // become available to be picked on some FUTURE tick
            // (immediately for Random/Sequential; for Shuffle, once the
            // current shuffle-bag empties and a fresh one is drawn -
            // not instantly forced into the current bag, which would
            // need reshuffling already-issued picks and could double-
            // show something).
            addImages: function (newImages) {
                if (!newImages || newImages.length === 0) { return; }

                for (var i = 0; i < newImages.length; i++) {
                    // Guards against a duplicate arriving twice (e.g. a
                    // retried/duplicated stream chunk) - a plain
                    // indexOf is fine here, this list stays small
                    // (bounded by the admin's own "max images per
                    // person" setting, never more than a handful).
                    if (state.images.indexOf(newImages[i]) === -1) {
                        state.images.push(newImages[i]);
                    }
                }
                // If this is what just took the list from 1 to 2+
                // images, and an image is already confirmed on screen
                // (imageShown() already called), a timer needs to
                // start now covering the remainder of the CURRENT
                // image's own cycle - scheduleNextTick() itself
                // correctly no-ops if there isn't yet a confirmed
                // on-screen image to anchor to (imageShown() will
                // schedule it once there is).
                scheduleNextTick();
            }
        };
    }


    // -----------------------------------------------------------------
    // Session 119: CSS art boxes (Characterart + Red Carpet), the
    // clearlogo replica. Jellyfin's own .detailLogo is pure CSS
    // (librarybrowser.scss: position:absolute; top:10vh; right:25vw;
    // width:25vw; height:16vh; background-size:contain) - it never
    // measures anything, so it follows every window resize smoothly
    // and never shifts in fullscreen. The old RenderArt code measured
    // logo/poster/ribbon rectangles in pixels and re-applied them after
    // a debounce, which is exactly the "zappeln" the user saw, and its
    // poster anchor (max-height:80vh) is why fullscreen shifted the
    // horizontal position. Everything positional now lives in ONE
    // injected stylesheet plus a few CSS custom properties per box;
    // JavaScript only creates the elements and runs the rotation.
    // -----------------------------------------------------------------

    var RENDERART_STYLE_ID = 'artworkplus-renderart-style';
    var RENDERART_CSS = [
        // The box: the admin's "window" (Height/Max width or Width/Max
        // height, all vw/vh) - the image fits inside it like the
        // clearlogo's background-size:contain, aligned by object-position.
        '.artworkplus-art-box{pointer-events:none;--ap-fs:0vw;}',
        '.artworkplus-art-box>img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;}',
        // Characterart "top": a zero-height anchor on Jellyfin\'s ribbon line
        // (.itemBackdrop height 40vh, .detailRibbon margin-top -7.2em - both
        // Jellyfin\'s own values, incl. its <=31.25em height exception). The
        // box hangs from that line with bottom:0 and grows upwards. Its
        // horizontal edge is the clearlogo\'s edge: left edge 50vw (TopLeft
        // = box right edge there), right edge 75vw (TopRight = box left edge
        // there) - shifted by Offset (+ Fullscreen offset while fullscreen).
        '.artworkplus-art-anchor{position:absolute;height:0;top:calc(40vh - 7.2em);pointer-events:none;z-index:0;}',
        '.artworkplus-art-anchor.artworkplus-top-left{left:0;right:50vw;}',
        '.artworkplus-art-anchor.artworkplus-top-right{left:75vw;right:0;}',
        '.artworkplus-art-anchor>.artworkplus-art-box{position:absolute;bottom:0;}',
        '.artworkplus-art-anchor.artworkplus-top-left>.artworkplus-art-box{right:calc(0px - var(--ap-offset) - var(--ap-fs));}',
        '.artworkplus-art-anchor.artworkplus-top-right>.artworkplus-art-box{left:calc(var(--ap-offset) + var(--ap-fs));}',
        '@media all and (max-height:31.25em){.artworkplus-art-anchor{top:calc(52vh - 7.2em);}}',
        // Same breakpoints that hide the native clearlogo (librarybrowser.scss).
        '@media all and (max-width:68.75em){.artworkplus-art-anchor{display:none;}}',
        '.layout-mobile .artworkplus-art-anchor,.layout-tv .artworkplus-art-anchor{display:none;}',
        // "Bottom" boxes (Characterart BottomLeft/BottomRight, Red Carpet):
        // glued to the viewport like .skinHeader, 0.8vw from the side edge.
        '.artworkplus-art-box.artworkplus-bottom-left,.artworkplus-art-box.artworkplus-bottom-right{position:fixed;bottom:0;}',
        '.artworkplus-art-box.artworkplus-bottom-left{left:calc(0.8vw + var(--ap-offset) + var(--ap-fs));}',
        '.artworkplus-art-box.artworkplus-bottom-right{right:calc(0.8vw - var(--ap-offset) - var(--ap-fs));}',
        // Fullscreen offset: only while the <body> carries the class set by
        // installFullscreenClass() - the sole remaining piece of JS in the
        // positioning, because CSS :fullscreen cannot see the browser\'s F11.
        'body.artworkplus-fullscreen .artworkplus-art-box{--ap-fs:var(--ap-fs-offset);}'
    ].join('\n');

    function ensureRenderArtStyles() {
        if (document.getElementById(RENDERART_STYLE_ID)) { return; }
        var style = document.createElement('style');
        style.id = RENDERART_STYLE_ID;
        style.textContent = RENDERART_CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    /**
     * Fullscreen detection, kept ONLY for the "Fullscreen offset" fields:
     * the Fullscreen API never reflects the browser's own F11 toggle, so
     * (as the user's VideoOSD ClearLogoArt userscript does) a window that
     * fills the entire screen height counts as fullscreen too. The result
     * is one class on <body>; the stylesheet does the rest. No measuring,
     * no debounce - a class toggle cannot make anything jump.
     */
    function isEffectivelyFullscreen() {
        var api = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
        var fillsScreen = !!window.screen && window.innerHeight >= window.screen.height; // the original heuristic of both RenderArt sections (height only - a maximized window still loses height to the browser chrome)
        return api || fillsScreen;
    }

    var fullscreenClassInstalled = false;
    function installFullscreenClass() {
        if (fullscreenClassInstalled) { return; }
        fullscreenClassInstalled = true;
        var apply = function () {
            try { document.body.classList.toggle('artworkplus-fullscreen', isEffectivelyFullscreen()); } catch (e) { /* no body yet */ }
        };
        window.addEventListener('resize', apply);
        document.addEventListener('fullscreenchange', apply);
        apply();
    }

    /**
     * Writes the admin's sizing onto a box as pure CSS: ScaleMode Height =
     * height:Hvh + width:MaxWvw; ScaleMode Width = width:Wvw +
     * height:MaxHvh. A Max of 0 means "follow the image" - then the box
     * takes the first image's aspect ratio (aspect-ratio CSS, a one-off
     * natural value, no viewport dependency) instead of a fixed second
     * side. Offsets become custom properties for the stylesheet above.
     */
    function applyArtBoxSizing(box, result, naturalAspectRatio) {
        var ratio = naturalAspectRatio > 0 ? naturalAspectRatio : 1;
        box.style.aspectRatio = '';
        if (result.ScaleMode === 'Width') {
            box.style.width = result.WidthVw + 'vw';
            if (result.MaxHeightVh > 0) { box.style.height = result.MaxHeightVh + 'vh'; } else { box.style.height = 'auto'; box.style.aspectRatio = String(ratio); }
        } else {
            box.style.height = result.HeightVh + 'vh';
            if (result.MaxWidthVw > 0) { box.style.width = result.MaxWidthVw + 'vw'; } else { box.style.width = 'auto'; box.style.aspectRatio = String(ratio); }
        }
        box.style.setProperty('--ap-offset', (result.HorizontalOffsetVw || 0) + 'vw');
        box.style.setProperty('--ap-fs-offset', (result.FullscreenHorizontalOffsetVw || 0) + 'vw');
    }

    /** Position class for a box or its anchor: TopLeft/TopRight/BottomLeft/BottomRight -> artworkplus-top-left etc. */
    function positionClass(position) {
        return 'artworkplus-' + String(position || 'BottomRight').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    }


    // =================================================================
    // Session 120: the backdrop transition system (concept Part R).
    // ONE bus + ONE owner factory for all six backdrop implementations
    // (Detail View, People, Genre, Studio, Tag, Favorites). Before this,
    // every IIFE carried its own copy of container/Ken Burns/render/
    // clear and guessed with a 1.2 s timeout whether a successor would
    // come ("Tag -> Film: alte Slideshow läuft weiter, harter Abbruch,
    // Pause, dann erst das Filmbild"). Now the responsible owner CLAIMS
    // the page synchronously on the hash change, reports READY (first
    // decoded image) or EMPTY, and the outgoing owner's RELEASE is
    // decided by the bus from that claim.
    // =================================================================

    var BACKDROP_FADE_MS = 800;        // Jellyfin's backdrop-fadein keyframe
    var HANDOVER_MS = 1200;            // max wait for a claimed successor (normal sources)
    var HANDOVER_SLOW_MS = 600;        // max wait when the successor streams Wallpapers.com
    var NO_CLAIM_GRACE_MS = 50;        // release and claim of one navigation may arrive in either order
    var OVERRIDE_BODY_CLASS = 'artworkplus-backdrops-override';

    var bus = {
        claims: {},           // owner -> source; several owners may claim one page (details: Detail View AND People, the server decides)
        showing: null,        // owner name whose image is currently on screen
        waiters: [],          // outgoing releases waiting for ready/empty
        claimSeq: 0
    };

    function claimCount() { return Object.keys(bus.claims).length; }
    function claimHasWallpapers() {
        for (var k in bus.claims) { if (bus.claims[k] === 'wallpapers') { return true; } }
        return false;
    }

    function busApplyClasses() {
        // Hide Jellyfin's container (and dim the page like Jellyfin does
        // with .withBackdrop) exactly while one of ours is showing or a
        // successor of ours is claimed - never on pages nobody of ours
        // handles (Home, library home: Jellyfin behaves as the user set it).
        var on = !!(bus.showing || claimCount());
        try { document.body.classList.toggle(OVERRIDE_BODY_CLASS, on); } catch (e) { /* no body yet */ }
        var bg = document.querySelector('.backgroundContainer');
        if (bg) { bg.classList.toggle('withBackdrop', on); }
    }

    function busResolveWaiters(reason) {
        var w = bus.waiters;
        bus.waiters = [];
        w.forEach(function (waiter) { waiter.fire(reason); });
    }

    /** A responsible owner announces itself for the current page. source: 'normal' | 'wallpapers'. */
    function busClaim(owner, source) {
        bus.claims[owner] = source === 'wallpapers' ? 'wallpapers' : 'normal';
        bus.claimSeq++;
        busApplyClasses();
        // A release that came just before this claim (same navigation)
        // must now wait for us instead of fading immediately.
        bus.waiters.forEach(function (waiter) { waiter.rearm(); });
        return bus.claimSeq;
    }

    /** First image of a claimant is decoded and fading in: crossfade point. */
    function busReady(owner) {
        delete bus.claims[owner];
        bus.showing = owner;
        busApplyClasses();
        busResolveWaiters('ready');
    }

    /** A claimant has nothing to show (disabled deeper down, no images, not its item type, error). */
    function busEmpty(owner) {
        delete bus.claims[owner];
        if (bus.showing === owner) { bus.showing = null; }
        busApplyClasses();
        if (!bus.showing && claimCount() === 0) {
            // Nobody of ours will paint this page: the page's verdict is "empty".
            busResolveWaiters('empty');
        }
    }

    /** The owner currently on screen is leaving; fadeFn(reason) starts its fade-out. */
    function busRelease(owner, fadeFn) {
        // An owner that leaves is no claimant any more (its pending render,
        // if any, is discarded by its generation guard and would never
        // report ready/empty - the claim must not linger).
        delete bus.claims[owner];
        if (bus.showing === owner) { bus.showing = null; }
        var fired = false;
        var timer = null;
        var waiter = {
            fire: function (reason) {
                if (fired) { return; }
                fired = true;
                if (timer) { clearTimeout(timer); timer = null; }
                var i = bus.waiters.indexOf(waiter);
                if (i !== -1) { bus.waiters.splice(i, 1); }
                busApplyClasses();
                try { fadeFn(reason); } catch (e) { /* the outgoing side must never break the bus */ }
            },
            rearm: function () {
                if (fired) { return; }
                if (timer) { clearTimeout(timer); }
                var ms = claimCount() === 0 ? NO_CLAIM_GRACE_MS : (claimHasWallpapers() ? HANDOVER_SLOW_MS : HANDOVER_MS);
                timer = setTimeout(function () { waiter.fire(claimCount() ? 'timeout' : 'noclaim'); }, ms);
            }
        };
        bus.waiters.push(waiter);
        waiter.rearm();
        busApplyClasses();
        return waiter;
    }

    function busState() {
        return { claims: Object.assign({}, bus.claims), showing: bus.showing, waiting: bus.waiters.length };
    }

    // --- navigation: hashchange (immediate) + viewshow + poll (backup) ---
    var navigationListeners = [];
    var navigationInstalled = false;
    var lastDispatchedHash = null;
    function dispatchNavigation(source) {
        var hash = location.hash;
        if (hash === lastDispatchedHash && source !== 'viewshow') { return; }
        lastDispatchedHash = hash;
        navigationListeners.forEach(function (fn) {
            try { fn(hash, source); } catch (e) { /* one listener must not stop the others */ }
        });
    }
    /**
     * Registers fn(hash, source) for every navigation. Fires synchronously on
     * the browser's own 'hashchange' (no polling, no cost) - this is where an
     * owner claims or releases - and again on Jellyfin's 'viewshow' (the
     * page DOM is ready then) and from a 1 s poll as the last backup.
     */
    function dispatchNavigationNow() { dispatchNavigation('viewshow'); }
    function onNavigation(fn) {
        navigationListeners.push(fn);
        if (navigationInstalled) { return; }
        navigationInstalled = true;
        window.addEventListener('hashchange', function () { dispatchNavigation('hashchange'); });
        document.addEventListener('viewshow', function () { dispatchNavigation('viewshow'); });
        setInterval(function () { dispatchNavigation('poll'); }, 1000);
    }

    /**
     * One backdrop owner = one implementation's container, Ken Burns frame,
     * layer rendering (vanilla style: the new layer fades in ON TOP of the
     * opaque old one, the old one is removed when the fade ends), rotation
     * engine and release-through-the-bus. The implementation keeps only:
     * page detection, endpoint fetch, URL building, and the claim.
     *
     * options: { name, containerClass, kenBurns: { zoomStart, zoomEnd, panPx, easing },
     *            quietFrames: bool (People: wait for a calm page before the first fade-in),
     *            log: fn }
     */
    function createBackdropOwner(options) {
        var name = options.name;
        var containerClass = options.containerClass;
        var kb = options.kenBurns || { zoomStart: 1.10, zoomEnd: 1.30, panPx: 15, easing: 'cubic-bezier(0.645, 0.045, 0.355, 1)' };
        var log = options.log || function () {};
        var quietFrames = !!options.quietFrames;
        // 'all' (small own lists: Detail View) preloads every image at start
        // at low priority; 'next' (100-image pools) only the engine's next
        // pick, on idle - measured in Session 116: bulk preloading a pool
        // starved the visible image (11.5 s instead of 1.6 s).
        var preload = options.preload || 'next';
        var scheduleIdle = window.requestIdleCallback ? function (fn) { window.requestIdleCallback(fn); } : function (fn) { setTimeout(fn, 1500); };
        function preloadNext() {
            var next = engine.peekNext();
            if (next) { preloadImage(next, { priority: 'low' }).catch(function () { /* background only */ }); }
        }

        var containerEl = null;
        var frameEl = null;
        var generation = 0;
        var engine = createBackdropRotationEngine();
        var visitShown = false;   // first image of this visit reached the screen -> bus.ready sent
        var pendingCancel = null; // cancels a pending quiet-frames wait

        function getContainer() {
            if (containerEl && document.body.contains(containerEl)) { return containerEl; }
            containerEl = document.querySelector('.' + containerClass);
            if (!containerEl) {
                containerEl = document.createElement('div');
                containerEl.className = containerClass + ' artworkplus-backdrop-owner';
                // Jellyfin's .backdropContainer rules copied (librarybrowser.scss +
                // backdrop.scss) WITHOUT its class: Jellyfin caches
                // document.querySelector('.backdropContainer') on first use and
                // would otherwise empty OUR container in clearBackdrop().
                containerEl.style.position = 'fixed';
                containerEl.style.top = '0';
                containerEl.style.left = '0';
                containerEl.style.right = '0';
                containerEl.style.bottom = '0';
                containerEl.style.zIndex = '-1';
                containerEl.style.contain = 'layout style size';
                document.body.insertBefore(containerEl, document.body.firstChild);
            }
            return containerEl;
        }

        function getFrame(kenBurnsEnabled, zoomMs, panMs) {
            var container = getContainer();
            if (!kenBurnsEnabled) { return container; }
            if (frameEl && container.contains(frameEl)) { return frameEl; }
            var zoomEl = document.createElement('div');
            zoomEl.className = 'artworkplus-kenburns-zoom';
            zoomEl.style.position = 'absolute';
            zoomEl.style.inset = '0';
            zoomEl.style.overflow = 'hidden';
            var panEl = document.createElement('div');
            panEl.className = 'artworkplus-kenburns-pan';
            panEl.style.position = 'absolute';
            panEl.style.inset = '0';
            zoomEl.appendChild(panEl);
            container.appendChild(zoomEl);
            if (zoomEl.animate) {
                var zoomAnimation = zoomEl.animate(
                    [{ transform: 'scale(' + kb.zoomStart + ')' }, { transform: 'scale(' + kb.zoomEnd + ')' }],
                    { duration: zoomMs, easing: kb.easing, iterations: Infinity, direction: 'alternate' });
                zoomAnimation.currentTime = Math.random() * zoomMs;
                var panAnimation = panEl.animate(
                    [{ transform: 'translate(-' + kb.panPx + 'px, -' + kb.panPx + 'px)' }, { transform: 'translate(' + kb.panPx + 'px, ' + kb.panPx + 'px)' }],
                    { duration: panMs, easing: kb.easing, iterations: Infinity, direction: 'alternate' });
                panAnimation.currentTime = Math.random() * panMs;
            }
            frameEl = panEl;
            return panEl;
        }

        function emptyContainer() {
            frameEl = null;
            if (!containerEl) { return; }
            while (containerEl.firstChild) { containerEl.removeChild(containerEl.firstChild); }
            containerEl.style.opacity = '';
            containerEl.style.transition = '';
        }

        function hasContent() {
            return !!(containerEl && containerEl.firstChild && containerEl.style.opacity !== '0');
        }

        /** Renders one URL as a new layer (vanilla style). Resolves the bus on the visit's first image. */
        function render(url, settings, onShown, onFailure) {
            var myGeneration = generation;
            var frame = getFrame(settings.KenBurnsEnabled, settings.KenBurnsZoomMs, settings.KenBurnsPanMs);
            var existing = frame.querySelector('.displayingBackdropImage');
            if (existing && existing.getAttribute('data-url') === url) {
                // Same image again (Random order, or a fast return to a page
                // whose old layer is still there): nothing to append, but the
                // container may be mid-fade-out from the release - revive it,
                // and this counts as the visit's first image for the bus.
                var same = getContainer();
                if (same.style.opacity === '0') { same.style.transition = ''; same.style.opacity = ''; }
                if (!visitShown) { visitShown = true; busReady(name); }
                engine.imageShown();
                if (onShown) { onShown(); }
                return;
            }
            preloadImage(url).then(function () {
                if (myGeneration !== generation) { log('Discarding a stale image render for a no-longer-current rotation. URL:', url); return; }
                var div = document.createElement('div');
                div.className = 'backdropImage displayingBackdropImage';
                div.style.position = 'absolute';
                div.style.inset = '0';
                div.style.backgroundSize = 'cover';
                div.style.backgroundPosition = 'center center';
                div.style.backgroundRepeat = 'no-repeat';
                div.style.transition = 'opacity ' + BACKDROP_FADE_MS + 'ms ease';
                div.style.opacity = '0';
                div.setAttribute('data-url', url);
                div.style.backgroundImage = cssUrl(url);
                if (existing) { existing.classList.remove('displayingBackdropImage'); }
                frame.appendChild(div);
                // A container that was mid-fade-out (fast return to the same page) comes back.
                var c = getContainer();
                if (c.style.opacity === '0') { c.style.transition = ''; c.style.opacity = ''; }

                var begin = function () {
                    if (myGeneration !== generation) { return; }
                    if (!visitShown) { visitShown = true; busReady(name); }
                    void div.offsetWidth;
                    div.style.opacity = '1';
                    engine.imageShown();
                    if (onShown) { onShown(); }
                    if (preload === 'next') { scheduleIdle(preloadNext); }
                    if (existing) {
                        var cleaned = false;
                        var cleanup = function (event) {
                            if (event && event.propertyName && event.propertyName !== 'opacity') { return; }
                            if (cleaned) { return; }
                            cleaned = true;
                            div.removeEventListener('transitionend', cleanup);
                            if (existing.parentNode) { existing.parentNode.removeChild(existing); }
                        };
                        div.addEventListener('transitionend', cleanup);
                        setTimeout(cleanup, BACKDROP_FADE_MS + 1000);
                    }
                };

                if (quietFrames && !visitShown) {
                    // People: the person page lays out heavily after viewshow (poster
                    // decode, long tasks); starting the fade during that jank makes
                    // it stutter. Wait for calm frames (cap 3.5 s), then fade.
                    var QUIET_FRAMES_NEEDED = 45, QUIET_WAIT_CAP_MS = 3500;
                    var t0 = performance.now(), prev = null, run = 0, raf = null, cancelled = false;
                    var step = function (ts) {
                        if (cancelled) { return; }
                        if (prev !== null && (ts - prev) <= 34) { run++; } else { run = 0; }
                        prev = ts;
                        if (run >= QUIET_FRAMES_NEEDED || (performance.now() - t0) >= QUIET_WAIT_CAP_MS) { pendingCancel = null; begin(); return; }
                        raf = requestAnimationFrame(step);
                    };
                    pendingCancel = function () { cancelled = true; if (raf) { cancelAnimationFrame(raf); } };
                    raf = requestAnimationFrame(step);
                } else {
                    requestAnimationFrame(function () { requestAnimationFrame(begin); });
                }
            }).catch(function (e) {
                if (myGeneration !== generation) { return; }
                log('The image could not be loaded, skipping', e);
                if (onFailure) { onFailure(url); }
            });
        }

        /** Starts (or restarts) the rotation for a fresh list. The bus must have been claimed already. */
        function start(images, settings) {
            generation++;
            if (pendingCancel) { pendingCancel(); pendingCancel = null; }
            var cycleMs = Math.max(settings.CycleTimeMs || 0, Math.ceil(BACKDROP_FADE_MS * 1.5));
            var orderMode = (settings.OrderMode === 'Shuffle' || settings.OrderMode === 'Random') ? settings.OrderMode : 'Sequential';
            if (preload === 'all') {
                for (var i = 1; i < images.length; i++) { preloadImage(images[i], { priority: 'low' }).catch(function () { /* background only */ }); }
            }
            engine.start(images, orderMode, cycleMs, function (url) {
                render(url, settings, null, function (failedUrl) {
                    engine.removeFailedImage(failedUrl);
                    if (engine.peekNext() !== null || images.length > 1) { engine.advance(); } else { busEmpty(name); }
                });
            });
        }

        /** Starts a new visit: the first image of the next start()/render() reports ready to the bus. */
        function beginVisit() {
            visitShown = false;
        }

        /** Leaves the page: rotation stops, the container fades out when the bus says so. */
        function release() {
            generation++;
            engine.clear();
            if (pendingCancel) { pendingCancel(); pendingCancel = null; }
            visitShown = false;
            if (!hasContent()) {
                emptyContainer();
                delete bus.claims[name];
                if (bus.showing === name) { bus.showing = null; }
                busApplyClasses();
                // No resolve here: a waiter's own grace timer decides (the
                // successor's claim may still arrive in this same navigation).
                return;
            }
            var myGeneration = generation;
            var el = containerEl;
            busRelease(name, function (reason) {
                if (myGeneration !== generation) { return; } // a new rotation of ours started meanwhile - it owns the container now
                log('Fading out (' + reason + ')');
                el.style.transition = 'opacity ' + BACKDROP_FADE_MS + 'ms ease';
                el.style.opacity = '0';
                setTimeout(function () {
                    if (myGeneration !== generation) { return; }
                    emptyContainer();
                }, BACKDROP_FADE_MS);
            });
        }

        return {
            name: name,
            claim: function (source) { return busClaim(name, source); },
            empty: function () { busEmpty(name); },
            beginVisit: beginVisit,
            start: start,
            render: render,
            addImages: function (urls) { engine.addImages(urls); },
            release: release,
            setPaused: function (p) { engine.setPaused(p); },
            hasContent: hasContent,
            peekNext: function () { return engine.peekNext(); },
            getContainer: getContainer
        };
    }

    window.ArtworkPlusCore = {
        getItemIdFromHash: getItemIdFromHash,
        isDetailsPage: isDetailsPage,
        scheduleNavigationBurst: scheduleNavigationBurst,
        vwToPx: vwToPx,
        vhToPx: vhToPx,
        computeBoxSize: computeBoxSize,
        horizontalAlignToObjectPosition: horizontalAlignToObjectPosition,
        getScrollOffset: getScrollOffset,
        ensureBodyIsPositioned: ensureBodyIsPositioned,
        ensureRenderArtStyles: ensureRenderArtStyles,
        installFullscreenClass: installFullscreenClass,
        isEffectivelyFullscreen: isEffectivelyFullscreen,
        applyArtBoxSizing: applyArtBoxSizing,
        positionClass: positionClass,
        preloadImage: preloadImage,
        cssUrl: cssUrl,
        makeLogger: makeLogger,
        claimSingleton: claimSingleton,
        startPresenceHeartbeat: startPresenceHeartbeat,
        findVisibleDetailPage: findVisibleDetailPage,
        createTimerTracker: createTimerTracker,
        watchForNavigation: watchForNavigation,
        fisherYatesShuffle: fisherYatesShuffle,
        createBackdropRotationEngine: createBackdropRotationEngine,
        createBackdropOwner: createBackdropOwner,
        onNavigation: onNavigation,
        dispatchNavigationNow: dispatchNavigationNow,
        backdropBus: { claim: busClaim, ready: busReady, empty: busEmpty, release: busRelease, state: busState },
        BACKDROP_FADE_MS: BACKDROP_FADE_MS,
        setDebug: setDebug,
        isDebugTagEnabled: isDebugTagEnabled
    };
})();
