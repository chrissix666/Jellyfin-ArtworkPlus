/*!
 * ArtworkPlus - Core
 * ------------------------------------------------------
 * The shared engine the three feature scripts (PostersPlus, RenderArt,
 * BackdropsPlus) depend on - connection and bundling functions, not a
 * feature of its own. Embedded in the plugin DLL: it is wiring, not
 * something meant to be edited after install.
 *
 * HARD DEPENDENCY: every feature script calls functions that live ONLY
 * here and fails with a ReferenceError on its first use of
 * window.ArtworkPlusCore without it. FileTransformationRegistrar.cs
 * injects this script's tag before the feature tags for that reason.
 *
 * Only genuinely cross-feature infrastructure lives here; the poster
 * arbiter/controller subsystem is in Jellyfin-ArtworkPlus-Posters-v1.js.
 * Same-named helpers with real behavioural differences between callers
 * keep those differences as options. Helpers that only look similar but
 * target different DOM attachment points (detail page vs. library tile
 * vs. a fixed-position container), such as the overlay-layer creation,
 * stay feature-specific code - a forced shared abstraction would fit
 * every caller worse.
 */
(function () {
    'use strict';

    // Duplicate-load guard: if window.ArtworkPlusCore already exists,
    // this is a second execution of this same script (e.g. a duplicate
    // paste in JavaScript Injector) - stop before anything below runs.
    // The final `window.ArtworkPlusCore = {...}` assignment would otherwise
    // replace the live object: every feature script reads
    // `window.ArtworkPlusCore` once at load time into a local `Core`, so a
    // later swap would leave two different objects coexisting. Returning
    // here guarantees exactly one `window.ArtworkPlusCore` for the lifetime
    // of the page.
    if (window.ArtworkPlusCore) { return; }

    /**
     * Diagnostic logging that writes to BOTH console.log() AND a plain
     * in-memory array (window.ArtworkPlusDebugLog). An open DevTools console
     * measurably changes JS execution timing (formatting/rendering cost per
     * call only applies while the panel is visible), which can hide
     * intermittent timing glitches; a plain array push has no such cost and
     * can be read out afterwards (window.ArtworkPlusDebugLog, or
     * copy(window.ArtworkPlusDebugLog) in the console). Capped at a fixed size
     * to avoid unbounded memory growth over a long browsing session.
     */
    var ArtworkPlusDebugLog = (window.ArtworkPlusDebugLog = window.ArtworkPlusDebugLog || []);
    var DEBUG_LOG_MAX_ENTRIES = 500;
    function debugLog() {
        var args = Array.prototype.slice.call(arguments);
        console.log.apply(console, args);
        ArtworkPlusDebugLog.push({
            t: performance.now().toFixed(1),
            // The item id ties a log line to the item it belongs to.
            // getItemIdFromHash() is declared further down; function
            // declarations are hoisted, so calling it here works.
            itemId: getItemIdFromHash(),
            // document.title is synchronous, already-available DOM state - on
            // Jellyfin's detail pages it usually holds the movie/show title, a
            // human-readable anchor without any extra network request.
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
    // Passive network + main-thread diagnostics. Recording the Network
    // tab requires DevTools open, which itself changes JS timing enough
    // to hide intermittent glitches; both APIs below are always-on browser
    // instrumentation that works with DevTools closed.
    //
    // Resource Timing API: passively records the start/end time of every
    // network resource the page loads; consumed here via PerformanceObserver
    // so it lands live in the same exportable array as everything else,
    // filtered to image loads (Extraposter/Backdrop/Primary images) so the
    // capped array is not flooded with JS-bundle/API entries.
    // Only with the debug switch on: otherwise these two observers would
    // write a line plus title / itemId for EVERY poster image and long task
    // on every page of every user. localStorage.ArtworkPlusDebug is read once
    // here - the debug switch says "reload the page to apply".
    var diagnosticsOn = isDebugTagEnabled('[Core]');
    if (diagnosticsOn && window.PerformanceObserver) {
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
    // (image decoding, layout, GC, any script) - shows whether the main
    // thread was busy while posterEl is hidden, which would explain a
    // delayed reveal on its own.
    if (diagnosticsOn && window.PerformanceObserver) {
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
     * "#/details?id=abc123" -> "abc123".
     */
    function getItemIdFromHash() {
        var hash = location.hash || '';
        var qIndex = hash.indexOf('?');
        if (qIndex === -1) { return null; }
        return new URLSearchParams(hash.slice(qIndex + 1)).get('id');
    }

    // Playnite Bridge: the game version opened first on this history entry, for its "Artwork on Version
    // Change" table; history.state.pbFor names the id it belongs to. Null for any other page or entry.
    function playniteFirstVersion(itemId) {
        try {
            var s = window.history.state;
            var norm = function (id) { return String(id || '').replace(/-/g, '').toLowerCase(); };
            return s && s.pbFirst && itemId && norm(s.pbFor) === norm(itemId) ? String(s.pbFirst) : null;
        } catch (e) {
            return null;
        }
    }

    // Playnite Bridge's in-place version switch: the Bridge holds a snapshot of the page and sends
    // pb:switchrelease { id, first, generation } on document when it lets go. A fade started for the switch waits
    // for that signal (an earlier one runs unseen behind the snapshot), at most PB_RELEASE_WAIT_MS. Only a viewshow with
    // detail.pbInPlace arms it, and the Bridge sends that only inside a game's detail group with more than one version -
    // every other page is unaffected. Captured on document so it is armed before any feature's viewshow listener.
    var PB_RELEASE_WAIT_MS = 2000;
    var pbSwitch = null; // { id, generation, released, waiters, timer } of the switch on screen; null = no switch
    var pbLastGeneration = -1;
    function pbNorm(id) { return String(id || '').replace(/-/g, '').toLowerCase(); }
    function pbReleaseSwitch(s) {
        if (s.released) { return; }
        s.released = true;
        clearTimeout(s.timer);
        s.waiters.splice(0).forEach(function (fn) { fn(); });
    }
    function pbEndSwitch() {
        if (pbSwitch) { pbReleaseSwitch(pbSwitch); pbSwitch = null; }
    }
    document.addEventListener('viewshow', function (e) {
        pbEndSwitch();
        if (!(e.detail && e.detail.pbInPlace)) { return; }
        // detail.pbGeneration: the pick's number, the same count as the release's generation.
        var generation = typeof e.detail.pbGeneration === 'number' ? e.detail.pbGeneration : null;
        var s = { id: pbNorm(getItemIdFromHash()), generation: generation, released: false, waiters: [], timer: null };
        s.timer = setTimeout(function () { pbReleaseSwitch(s); }, PB_RELEASE_WAIT_MS);
        pbSwitch = s;
    }, true);
    window.addEventListener('hashchange', pbEndSwitch);
    document.addEventListener('pb:switchrelease', function (e) {
        var d = e.detail || {};
        if (typeof d.generation === 'number') {
            if (d.generation < pbLastGeneration) { return; } // overtaken by a later pick
            pbLastGeneration = d.generation;
        }
        if (!pbSwitch) { return; }
        // With the pick's generation the release must carry exactly it; an older Bridge without it is matched by id.
        var matches = pbSwitch.generation !== null ? d.generation === pbSwitch.generation : pbNorm(d.id) === pbSwitch.id;
        if (matches) { pbReleaseSwitch(pbSwitch); }
    });

    /** Null when no in-place version switch is on screen; else a Promise that resolves once the Bridge released it (or the wait ran out). */
    function playniteSwitchRelease() {
        var s = pbSwitch;
        if (!s) { return null; }
        return new Promise(function (resolve) {
            if (s.released) { resolve(); } else { s.waiters.push(resolve); }
        });
    }

    /** prefers-reduced-motion: the switch swaps without a fade. */
    function prefersReducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /**
     * Playnite Bridge's in-place switch: fades the outgoing RenderArt boxes out over fadeMs and removes
     * them; reduced motion removes them at once. An element nested in another outgoing one (the box inside its
     * top anchor) fades with its parent.
     */
    function retireArtBoxes(elements, fadeMs) {
        var instant = prefersReducedMotion() || !(fadeMs > 0);
        elements.forEach(function (el) {
            if (!el.parentNode || (el.parentNode.classList && el.parentNode.classList.contains('artworkplus-outgoing'))) { return; }
            if (instant) { el.remove(); return; }
            el.style.transition = 'opacity ' + fadeMs + 'ms ease';
            el.style.opacity = '0';
            setTimeout(function () { el.remove(); }, fadeMs + 100);
        });
    }

    /**
     * True when the current SPA route is a details page (movie/series/person).
     */
    function isDetailsPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'details';
    }

    /**
     * Fires attemptFn() at several staggered delays after a detected
     * navigation instead of once. A single-shot attempt can bail out on a
     * premature, still-stale read of location.hash ('viewshow' can fire
     * slightly before location.hash points at the new page) and never get
     * a second chance; a feature then only shows after a manual refresh.
     *
     * Deliberately NOT a continuous poll-forever watchdog (MutationObserver
     * + setInterval for the lifetime of the page): the race is only live
     * for a short window at navigation time. A FIXED, SMALL number of
     * staggered attempts (default 4, at 0/300/800/1500ms) covers that
     * window; after the last one nothing runs until the next navigation.
     * The leading 0ms attempt matters: without it every navigation would
     * wait ~300ms before even starting the fetch that decides whether a
     * defensively hidden poster may be shown again.
     *
     * Deliberately carries NO built-in page-type guard - RedCarpet must
     * also run on list.html filmography pages. Every caller does its own
     * page-relevance check INSIDE attemptFn, re-evaluated at each attempt,
     * so a later attempt gets a fresh, by-then-correct read of the URL.
     * Callers also do their own "did an earlier attempt already succeed for
     * this navigation" check inside attemptFn (what counts as success is
     * feature-specific), so a redundant later attempt cheaply no-ops.
     *
     * track: the caller's own timer-tracker (from createTimerTracker()),
     * so a new navigation's clearTimers() call cancels any still-pending
     * attempts from the previous one.
     */
    function scheduleNavigationBurst(attemptFn, track, delaysMs) {
        (delaysMs || [0, 300, 800, 1500]).forEach(function (delay) {
            track(setTimeout(attemptFn, delay));
        });
    }

    /**
     * Converts a viewport-width percentage to actual pixels at the
     * current window size - used for the vw-based size/offset settings
     * (CharacterArt, RedCarpet).
     */
    function vwToPx(vw) {
        return window.innerWidth * (vw / 100);
    }

    /**
     * Converts a viewport-HEIGHT percentage to actual pixels, for the
     * ScaleMode-based sizing (Height/Width, each with an optional Max* on
     * the other axis) in CharacterArt/RedCarpet: the real constraint on
     * the "top" positions is VERTICAL space, and a vw size does not scale
     * with it - width and height scale independently with the window's
     * aspect ratio.
     */
    function vhToPx(vh) {
        return window.innerHeight * (vh / 100);
    }

    /**
     * Computes the box width/height in px from the ScaleMode-based sizing
     * system shared by CharacterArt and RedCarpet (Height/Width, each with
     * an optional Max* on the other axis). Deliberately NO additional,
     * hidden page-derived constraint on top of this (e.g. a ribbon-line
     * growth limit).
     *
     * ScaleMode picks the PRIMARY dimension (always exactly HeightVh/
     * WidthVw, straight from the admin's settings, regardless of any
     * image). The OTHER dimension:
     *   - if its own Max*Vw/Max*Vh is 0 ("auto"): follows naturalAspectRatio
     *     - the box hugs whichever image naturalAspectRatio was computed
     *     from (the caller decides which - see below).
     *   - if non-zero: becomes that EXACT value, a fixed container size -
     *     NOT a cap that is undone by recalculating back to the image's
     *     aspect ratio. A fixed-size box is what gives HorizontalAlign
     *     something to align WITHIN - the same model as a Kodi skin image
     *     control with two fixed dimensions and aspectratio="keep". Each
     *     image is fit and aligned inside it by plain CSS (object-fit:contain
     *     + object-position on the <img>), so this function only has to get
     *     the CONTAINER right.
     *
     * naturalAspectRatio: which image's aspect ratio "auto" follows is
     * the CALLER's decision - RedCarpet (a single, non-rotating image)
     * passes that image's own ratio, recomputed every time a new person's
     * image loads. CharacterArt (a rotation of several images) passes the
     * FIRST loaded image's ratio and calls this only once per slideshow
     * (layoutAppliedOnce) - so "auto" stays anchored to that one reference
     * image on purpose, which keeps the box from jumping between rotation
     * frames. Whenever Max* IS set this distinction does not matter, since
     * the box is then fully fixed.
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
     * individual aspect ratio - only the horizontal half is configurable.
     */
    function horizontalAlignToObjectPosition(horizontalAlign) {
        if (horizontalAlign === 'Left') { return 'left bottom'; }
        if (horizontalAlign === 'Right') { return 'right bottom'; }
        return 'center bottom';
    }

    /**
     * The actual current vertical/horizontal scroll offset - NOT simply
     * window.scrollY/document.documentElement.scrollTop, which measure
     * <html>'s own scroll state. Jellyfin's body element carries a
     * "force-scroll" class (jellyfin-web site.scss: ".force-scroll {
     * overflow-y: scroll; }") - i.e. <body> ITSELF is the scrolling element,
     * and window.scrollY/document.documentElement.scrollTop stay at 0 however
     * far the content is scrolled. position:absolute elements appended to
     * document.body would then only be placed correctly at scroll position 0.
     * document.body.scrollTop/scrollLeft is checked FIRST for that reason;
     * the documentElement fallback covers pages that scroll via <html>.
     */
    function getScrollOffset() {
        return {
            y: document.body.scrollTop || document.documentElement.scrollTop || window.scrollY || 0,
            x: document.body.scrollLeft || document.documentElement.scrollLeft || window.scrollX || 0
        };
    }

    /**
     * Preloads an image and resolves once it's actually loaded (or
     * rejects on error/timeout). The callers differ, so an options object
     * covers each variation:
     *
     *   - resolveWith: 'url' (default) resolves with the URL string;
     *     'image' resolves with the loaded Image object itself (CharacterArt
     *     and RedCarpet need img.naturalWidth/naturalHeight for their
     *     aspect-ratio math).
     *   - timeoutMs: rejects with a timeout error after this many
     *     milliseconds if the image hasn't loaded yet. Omit/pass null
     *     for no timeout at all (relying on the browser's own image-loading
     *     behaviour).
     *   - track: an optional function (e.g. from createTimerTracker()
     *     below) to route the internal setTimeout handle through, so
     *     the CALLER's own race-condition cancellation logic can still
     *     clear it. Omit for the untracked behaviour.
     */
    /**
     * A URL embedded in a CSS url('...') value ("url('" + url + "')")
     * breaks as soon as it contains a literal apostrophe:
     * encodeURIComponent() does NOT encode an apostrophe (an "unreserved"
     * character), and poster FileNames are built server-side from the
     * media folder's name (Path.GetFileName(folderPath) + "..." in
     * ExtraposterController.cs/AnimatedPosterController.cs/
     * BackdropsController.cs), e.g. "Marvel's The Avengers (2012)". The
     * apostrophe closes the CSS string early, the browser discards the
     * whole background-image declaration, and the element stays
     * transparent although the <img> preload succeeded. Assigning to
     * <img>.src has no such problem - it is a property, not a CSS string.
     *
     * Percent-encoding the apostrophe (to %27, otherwise byte-for-byte
     * identical - the server decodes %27 and a literal apostrophe the same
     * way, so the requested file does not change) sidesteps the CSS quoting
     * collision without reasoning about every other character CSS
     * url('...') might treat specially.
     */
    /**
     * A plain document.querySelector() for something on the item detail
     * page (the clearlogo, the poster card, the ribbon, etc.) searches the
     * ENTIRE document, but Jellyfin keeps up to THREE complete
     * itemDetailPage DOM trees alive at once (viewContainer.js:
     * pageContainerCount = 3) - only the active one lacks the "hide" class.
     * A document-wide query returns the first match in DOM order, which may
     * be a stale, hidden page's element with zero size - a caller's
     * missing-anchor guard then gives up. That is the "sometimes missing,
     * always fine after a reload" pattern (a fresh load has only one page).
     *
     * So this finds the page element that is actually visible (the one
     * WITHOUT "hide") for the caller to search inside. Use it instead of a
     * bare `document.querySelector(...)` for anything inside the item
     * detail page itself (NOT for things Jellyfin renders once, globally,
     * outside the page cache - e.g. .backdropContainer/.backgroundContainer,
     * a single React-rendered element outside the mainAnimatedPages tree).
     *
     * Returns null if no visible detail page is found at all (should not
     * normally happen while a feature script calling this is running) -
     * callers fall back to `document` in that case.
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
     * Returns a logger that prefixes console.log with a bracketed tag, or
     * does nothing when the module's logging is off - shared by every
     * feature module.
     */
    /**
     * Duplicate-load guard for feature scripts (PostersPlus/RenderArt/
     * BackdropsPlus). One call per independent top-level IIFE (RenderArt
     * and BackdropsPlus each have several, which share no state and are
     * guarded separately).
     *
     * Returns true the FIRST time a given name is claimed on this page
     * (the caller proceeds with its normal initialization), false every
     * time after (the caller returns immediately, before registering any
     * observer/listener/timer/DOM layer of its own). Lives on
     * `window.ArtworkPlusCore` itself (the page-wide namespace every feature
     * script already depends on) rather than a second global - Core is
     * itself guarded against a duplicate load (see the top of this file), so
     * a re-executing feature script always finds the SAME registry here.
     */
    var claimedSingletons = {};
    function claimSingleton(name) {
        if (claimedSingletons[name]) { return false; }
        claimedSingletons[name] = true;
        return true;
    }

    /**
     * Runtime debug switch. A module's logger is live only when its DEBUG
     * constant is true AND `localStorage.ArtworkPlusDebug` enables its tag:
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
     * RenderArt-v1.js's CharacterArt section). Navigation-burst mechanisms
     * only fire a few staggered attempts around a hash change and then go
     * silent. If Jellyfin's client-side rendering rebuilds the container a
     * feature's element was inserted into AFTER those attempts finished,
     * the element is gone and nothing would reinsert it.
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
            // fetchPriority: this image can lose the browser's limited
            // connections-per-origin race against other same-origin image requests
            // starting at the same moment (Similar-carousel thumbnails, the item's
            // large Primary image) - measured at up to ~593ms of a ~659ms delay.
            // fetchPriority is the standard browser API for telling the browser
            // this image matters more. It does not remove the race, but targets
            // its mechanism. Unsupported browsers ignore the unknown property, so
            // it degrades safely everywhere.
            //
            // The `priority` option defaults to 'high' (the image actually shown);
            // silentlyPreload()'s background calls pass 'low'. With many images
            // (e.g. 200 BackdropImageTags) all preloading at 'high', the visible
            // image shares its priority bucket with up to 199 background ones -
            // measured: 11504ms until it appears, vs. 1617ms (about the one-image
            // baseline) with background preloads at 'low'.
            img.fetchPriority = opts.priority || 'high';
            var timeout = null;
            if (timeoutMs) {
                timeout = track(setTimeout(function () {
                    reject(new Error('Timeout while loading: ' + url));
                }, timeoutMs));
            }
            img.onload = function () {
                if (timeout) { clearTimeout(timeout); }
                // onload only means the bytes arrived - the image is NOT decoded yet.
                // Decoding a large backdrop (Wallpapers.com files reach 5792x3258)
                // takes hundreds of ms, and the browser decodes a CSS background-image
                // only when it first rasters it - i.e. exactly when the caller starts
                // its opacity transition. The compositor keeps animating opacity during
                // that async decode, so the image pops in mid-fade (measured: the first
                // painted frame came ~560ms late, an 800ms fade effectively started at
                // ~500ms). Only an image rendered right after its fetch is affected;
                // silently preloaded ones are decoded long before. So wait for the
                // browser's decode() before resolving: when the caller appends the
                // element and starts the fade, the decoded bitmap is already cached.
                // decode() rejecting (e.g. an unsupported/corrupt encoding the <img>
                // nonetheless loaded) means "usable, just not pre-decoded" - never a
                // failure. The timeout is cleared BEFORE decoding on purpose: the
                // network part succeeded, a slow decode must not be reported as a load
                // timeout.
                var settled = false;
                var done = function () {
                    if (settled) { return; }
                    settled = true;
                    resolve(resolveWith === 'image' ? img : url);
                };
                // decode() is a NICE-TO-HAVE, never a gate. On a DETACHED image -
                // and every image here is detached, this IS the preloader - it
                // can simply never settle: the decode is tied to the rendering
                // pipeline, and an element that will never be painted gives it
                // no reason to run (measured: onload after 3 ms, decode() still
                // pending after 15 seconds). A caller that hid a poster while waiting
                // for this would leave the slot empty indefinitely.
                //
                // The image is usable the moment onload fires; decoding early
                // only avoids a hitch at first paint. So: a short grace period,
                // then carry on without it.
                if (typeof img.decode === 'function') {
                    img.decode().then(done, done);
                    setTimeout(done, 300);
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
     * race-condition guard used to cancel all of a run's pending
     * timers/intervals when a new run starts (e.g. fast SPA navigation
     * between two detail pages before the first one finished loading).
     * A factory rather than two plain exports: each caller needs its OWN
     * `timers` array - one shared array would let one feature's navigation
     * cleanup cancel another feature's still-valid timers.
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
     * position:absolute children. Without it, CharacterArt's "top"
     * positions (position:absolute, appended to <body>) stay put on scroll
     * as if they were position:fixed, although the scroll-offset math
     * (getScrollOffset()) is correct.
     *
     * ONLY relevant to position:absolute elements - RedCarpet and
     * CharacterArt's "bottom" positions are position:fixed, so
     * CharacterArt's "top" positions are the only caller.
     *
     * Root cause, in jellyfin-web site.scss: <body> has NO explicit
     * "position" property (only overflow-x/height/etc. via the "fullpage"
     * mixin). Per the CSS spec, position:absolute without a positioned
     * ancestor is positioned relative to the initial containing block
     * (effectively the viewport), NOT to <body>'s scrolled content - even
     * though <body> is the page's scrolling element (see
     * getScrollOffset()). The coordinate system is wrong, not the number
     * plugged into it.
     *
     * Fix: give <body> position:relative, making it a containing block for
     * position:absolute descendants without changing its own rendering
     * (position:relative with no top/left/etc. has no visible effect on the
     * element itself). Checked via getComputedStyle first - if <body>
     * already has some OTHER explicit position (e.g. set by a different
     * plugin), that is left alone. Idempotent; only the first call changes
     * anything.
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
     * 'viewshow' listener.
     *
     * 'viewshow' plus a one-shot initial timeout alone misses some
     * navigations (e.g. browser back/forward), which then need a manual
     * page refresh. A continuous poll is not tied to any particular
     * Jellyfin internal event firing, so it catches those cases too.
     *
     * Deliberately watches location.hash directly (not a MutationObserver
     * on the DOM) - cheap to poll every second, and the hash is already
     * the single source of truth getItemIdFromHash()/isDetailsPage() both
     * read from, so there's nothing more specific to observe.
     */
    /**
     * See the doc comment above for why a continuous poll exists. This ALSO
     * listens for 'viewshow', only to keep its own lastHash in sync - NOT to
     * call onChange() a second time from there.
     *
     * jellyfin-web components/viewManager/viewManager.js dispatches
     * 'viewshow' exactly ONCE per navigation (onViewChange(), called from
     * loadView()/tryRestoreView()). Every feature script has its own direct
     * 'viewshow' listener that calls schedule() immediately. If lastHash
     * were updated only inside the poll tick, the next tick (up to pollMs
     * later) would notice the same hash change and call onChange() AGAIN -
     * a delayed second schedule() landing mid-render on top of the first
     * ("pops up, disappears, pops up again"). Syncing lastHash from
     * 'viewshow' (without calling onChange) keeps the poll silent for a
     * navigation that was already handled.
     */
    /**
     * True when a 'viewshow' arrives within the boot window (3 s) for the
     * page a module's run already started on - the cold-start timer /
     * viewshow race of a hard reload, not a navigation.
     */
    var BOOT_RACE_WINDOW_MS = 3000;
    function isBootRaceRepeat(startedFor) {
        return !!(startedFor && startedFor.hash === location.hash && performance.now() - startedFor.at < BOOT_RACE_WINDOW_MS);
    }

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
    // non-uniform sort algorithm, skewing the result).
    function fisherYatesShuffle(arr) {
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
        return arr;
    }

    // The rotation TIMING/ORDERING logic (which image is next, in
    // Sequential/Shuffle/Random order, on what interval), shared by the
    // backdrop features. Where the images get drawn differs per feature
    // and stays outside this engine.
    //
    // Deliberately a FACTORY, not a single shared piece of state - each
    // caller gets its own, fully independent engine instance (own images
    // list, own current index, own shuffle-bag, own timer). Two features
    // running on the same page at once must never have one feature's
    // rotation state bleed into the other's.
    //
    // renderImage(url, index) is supplied by the CALLER - this engine only
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
            // Timestamp of when the current image actually became visible.
            // Counting cycleMs from when a second image streamed in, or from
            // start(), would let the first image overshoot by however long its
            // load took (measured: ~9s instead of 8s with an 8000ms cycle and a
            // streamed second image ~1s in), varying with network timing. See
            // scheduleNextTick() below, which this timestamp feeds.
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
                // repeat, or sit unseen for a long stretch - genuine
                // random, as distinct from "Shuffle" above, which
                // guarantees no repeats within a round.
                nextIndex = Math.floor(Math.random() * state.images.length);
            } else {
                nextIndex = state.index + 1;
                if (nextIndex >= state.images.length) { nextIndex = 0; }
            }

            state.index = nextIndex;
            // Mark the render as in flight. Until imageShown() re-anchors the
            // timer, any scheduleNextTick() call (addImages() from a same-person
            // subpage fetch is the real-world trigger) would otherwise measure
            // "elapsed" against the PREVIOUS image's shownAt, find a full cycle
            // already elapsed, and fire a second render immediately (two appends
            // 144ms apart). With shownAt null, scheduleNextTick() does nothing
            // until the in-flight image is actually shown.
            state._currentImageShownAt = null;
            renderImage(state.images[nextIndex], nextIndex);
        }

        // A self-rescheduling chain of setTimeout calls instead of one
        // setInterval: every time the caller confirms (via imageShown() below)
        // that an image finished loading and is on screen, this recalculates
        // how much of the configured cycle time is left and schedules just that
        // remainder - not a fresh full cycle, and not counting from an
        // unrelated earlier event. Each imageShown() call re-anchors the next
        // one, so no drift accumulates.
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
            // Skipping the restart only because the incoming list equals
            // state.images is not enough: addImages() (the same-person
            // subpage-continuation path) only pushes URLs and never renders, so
            // if a subpage fetch finishes BEFORE the fresh-visit fetch that calls
            // start() with the same first URL, the lists already match and NO
            // image would ever be rendered. state._currentImageShownAt !== null
            // is the one genuine signal that an image has been confirmed on
            // screen (set exclusively by imageShown() below) - only that,
            // together with a matching list, justifies skipping this restart.
            // Playnite Bridge's version switch: Sequential + Random start rotates the
            // list on every server call, so a cyclic rotation of the running list counts as the same list - the running
            // list keeps its order and index.
            var sameList = state._currentImageShownAt !== null
                && images.length === state.images.length
                && images.length > 0
                && (function () {
                    var shift = state.images.indexOf(images[0]);
                    if (shift === -1) { return false; }
                    return images.every(function (url, i) { return url === state.images[(i + shift) % images.length]; });
                })();
            if (sameList) {
                // The same list keeps running (series -> season showing the series'
                // images), but the NEW settings take over: the render callback is
                // swapped (the pending timer reads _lastRenderImage when it fires, so
                // the next image already renders with the new Ken Burns), and
                // order/cycle apply from the next change on - the current image
                // finishes on its old timer, nothing jumps.
                if (state._orderMode !== orderMode) { state._randomBag = []; }
                state._orderMode = orderMode;
                state._cycleMs = cycleMs;
                state._lastRenderImage = renderImage;
                return true;
            }

            clear();
            state.images = images;
            state._orderMode = orderMode;
            state._cycleMs = cycleMs;
            state.index = -1;
            // Stashed so advance() below can trigger an out-of-schedule
            // tick using the exact same callback, without the caller
            // having to pass it again.
            state._lastRenderImage = renderImage;

            // No setInterval here (see scheduleNextTick's doc comment above for
            // why) - the very first tick below shows the first image; once the
            // CALLER confirms via imageShown() that it actually finished loading
            // and is on screen, THAT triggers the first real scheduling.
            tick(renderImage);
            return false;
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
            // Triggers one immediate, out-of-schedule tick using whatever
            // renderImage callback the last start() call supplied - lets a caller
            // advance past a just-detected dead image right away instead of
            // waiting for the regular schedule. Safe to call at any time - tick()
            // no-ops without images/state, and the regular schedule is re-anchored
            // by the caller's next imageShown() call either way.
            // Accepted edge case: a stale image-load-failure callback from a
            // PREVIOUS rotation that resolves after a new start() can trigger one
            // slightly early tick for the new rotation - at worst one image
            // switches a little sooner, never a wrong image or corrupted state,
            // so the engine carries no generation/token system for it.
            advance: function () {
                if (state._lastRenderImage) { tick(state._lastRenderImage); }
            },
            // Which URL the NEXT tick will render, without advancing anything -
            // lets a caller warm exactly that one image instead of bulk-preloading
            // the whole pool. Shuffle: the head of the current bag (or, with an
            // empty bag, unknown until the next refill - returns null then, which
            // the caller treats as "nothing to warm"). Random: unknowable, null.
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
            // A failed URL is permanently removed from state.images, not just
            // skipped: if every image in the list fails (plausible for hotlinked
            // Wallpapers.com images - the site may block hotlinking, or a
            // candidate that passed the server's download check no longer
            // resolves), skipping alone would be an unbounded, fully SYNCHRONOUS
            // failure loop. Every failure shrinks the list by one, so the loop is
            // bounded by the list's original length and always ends, either at a
            // working image or at an empty list (handled below, not as another
            // failure).
            removeFailedImage: function (url) {
                var idx = state.images.indexOf(url);
                if (idx === -1) { return; }
                state.images.splice(idx, 1);
                // Keep state.index pointing at the same LOGICAL image
                // it did before the removal, not drifting onto whatever
                // now occupies the removed slot - only matters for
                // Sequential order (Shuffle/Random do not rely on index
                // continuity, and re-deriving their next pick from a
                // shrunk list is already safe as-is).
                if (idx < state.index) { state.index -= 1; }
                else if (idx === state.index) { state.index -= 1; }
                // The Shuffle bag still holds indices into the longer list; after
                // the splice an index >= the new length would pick
                // state.images[i] === undefined and hand "undefined" to the
                // loader. Same repair clear() does, but keeping the current
                // round intact: drop the removed index and shift every
                // higher one down by one.
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
                    // here: there is no "current image" left.
                    clear();
                }
            },
            // Called by the CALLER once an image it was just told to
            // render has actually finished loading and is confirmed on
            // screen - see scheduleNextTick's doc comment above for why
            // this, rather than a blind setInterval, drives the rotation's
            // timing. Safe to call even if this engine instance isn't the
            // one currently owning the caller's UI (e.g. a late-arriving
            // confirmation after clear() already ran) - scheduleNextTick()
            // itself no-ops once state.images is empty.
            imageShown: function () {
                state._currentImageShownAt = Date.now();
                scheduleNextTick();
            },
            // For streaming population (People Backdrops), where images arrive
            // one by one. Adds newly-arrived images to an ALREADY-RUNNING
            // rotation without resetting it - the currently-displayed image
            // keeps showing, the cycle timer keeps its existing schedule (see
            // scheduleNextTick's doc comment; it stays anchored to when the
            // current image was confirmed shown), and the new image(s) become
            // available on some FUTURE tick (immediately for Random/Sequential;
            // for Shuffle, once the current bag empties and a fresh one is drawn
            // - forcing them into the current bag would mean reshuffling
            // already-issued picks and could double-show something).
            addImages: function (newImages) {
                if (!newImages || newImages.length === 0) { return; }

                for (var i = 0; i < newImages.length; i++) {
                    // Guards against a duplicate arriving twice (e.g. a
                    // retried/duplicated stream chunk) - a plain indexOf
                    // is fine here, this list stays small (bounded by the
                    // admin's "max images per person" setting).
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
    // CSS art boxes (Characterart + Red Carpet), the clearlogo replica.
    // Jellyfin's own .detailLogo is pure CSS (librarybrowser.scss:
    // position:absolute; top:10vh; right:25vw; width:25vw; height:16vh;
    // background-size:contain) - it never measures anything, so it
    // follows every window resize smoothly and never shifts in
    // fullscreen. Measuring rectangles in pixels and re-applying them
    // after a debounce makes boxes jump during a resize, and anchoring to
    // the poster (max-height:80vh) shifts them in fullscreen. Everything
    // positional therefore lives in ONE injected stylesheet plus a few
    // CSS custom properties per box; JavaScript only creates the elements
    // and runs the rotation.
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
        // --ap-page-left: 10.10.7's experimental shell shifts the page by its
        // permanent drawer (AppOverrides.scss 15-19: .mainAnimatedPage{left:240px} from 900 px);
        // vanilla's logo is right-anchored and moves with it, left-anchored boxes would not.
        // The variable is the visible page's left offset (trackPageLeft) - 0 in every other shell,
        // where these rules give the plain positions.
        '.artworkplus-art-anchor.artworkplus-top-right{left:calc(75vw - var(--ap-page-left, 0px));right:0;}',
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
        '.artworkplus-art-box.artworkplus-bottom-left{left:calc(0.8vw + var(--ap-page-left, 0px) + var(--ap-offset) + var(--ap-fs));}',
        '.artworkplus-art-box.artworkplus-bottom-right{right:calc(0.8vw - var(--ap-offset) - var(--ap-fs));}',
        // Fullscreen offset: only while the <body> carries the class set by
        // installFullscreenClass() - the sole remaining piece of JS in the
        // positioning, because CSS :fullscreen cannot see the browser\'s F11.
        'body.artworkplus-fullscreen .artworkplus-art-box{--ap-fs:var(--ap-fs-offset);}',
        // LogoArt: our own box in vanilla's logo slot. Shared by every stage:
        // width 25vw x Size, centre 62.5vw (+ Offset), Vertical offset,
        // hidden at the clearlogo's own breakpoints. Logo / Folder logo /
        // Text = the vanilla box (16vh high, top 10vh, image centred).
        // Clearart (16:9) and Characterart (1:1) stand with their bottom edge
        // on the ribbon line (40vh - 7.2em, the Characterart top anchor's
        // line); the image sits at the bottom.
        '.logoart-container{position:absolute;pointer-events:none;z-index:1;--la-size:1;--la-offset:0vw;--la-voffset:0vh;left:calc(62.5vw - var(--ap-page-left, 0px) + var(--la-offset));}',
        '.logoart-container>img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center center;}',
        '.logoart-container.logoart-slot{top:calc(10vh + var(--la-voffset));width:calc(25vw * var(--la-size));height:calc(16vh * var(--la-size));transform:translateX(-50%);}',
        '.logoart-container.logoart-floor{top:calc(40vh - 7.2em + var(--la-voffset));width:auto;transform:translate(-50%,-100%);}',
        '.logoart-container.logoart-floor>img{object-position:center bottom;}',
        // No upper cap - Clearart is the 16:9 box at its own Size;
        // Characterart gets its inline size from Core.applyArtBoxSizing (the
        // Characterart tab's block), Height 0 = the full height from the
        // ribbon line up to the page top.
        '.logoart-container.logoart-clearart{aspect-ratio:16/9;height:calc(25vw * var(--la-size) * 9 / 16);}',
        '.logoart-container.logoart-characterart{--la-voffset:0vh;}',
        '.logoart-container.logoart-characterart.logoart-full-height{height:calc(40vh - 7.2em)!important;}',
        '@media all and (max-height:31.25em){.logoart-container.logoart-floor{top:calc(52vh - 7.2em + var(--la-voffset));}.logoart-container.logoart-characterart.logoart-full-height{height:calc(52vh - 7.2em)!important;}}',
        '@media all and (max-width:68.75em){.logoart-container{display:none;}}',
        '.layout-mobile .logoart-container,.layout-tv .logoart-container{display:none;}',
        // Text stage (Persons): two stacked layers like the bulk creator's
        // PNG - a black rim (outline + stroke wide) under a white body
        // thickened by the stroke; both in percent of the font size (1 = 0.01em,
        // stroke width doubled because half of a CSS stroke lies inside the glyph).
        '.logoart-container>.logoart-text{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);white-space:nowrap;line-height:1.1;color:#fff;font-weight:normal;-webkit-text-stroke-color:#fff;-webkit-text-stroke-width:calc(var(--la-stroke, 0) * 0.02em);paint-order:stroke fill;}',
        '.logoart-container>.logoart-text.logoart-text-rim{color:#000;-webkit-text-stroke-color:#000;-webkit-text-stroke-width:calc((var(--la-outline, 1) + var(--la-stroke, 0)) * 0.02em);}',
        '.logoart-container>.logoart-text.logoart-text-measure{visibility:hidden;left:0;top:0;transform:none;}'
    ].join('\n');

    function ensureRenderArtStyles() {
        if (document.getElementById(RENDERART_STYLE_ID)) { return; }
        var style = document.createElement('style');
        style.id = RENDERART_STYLE_ID;
        style.textContent = RENDERART_CSS;
        (document.head || document.documentElement).appendChild(style);
        trackPageLeft();
    }

    // The visible page's left edge as --ap-page-left on <html> (see RENDERART_CSS). Updated on
    // navigation and resize (the experimental drawer turns permanent at 900 px); written only when
    // it changes, so the normal shells (always 0) never see a style change.
    var pageLeftTracked = false, pageLeftValue = -1;
    function trackPageLeft() {
        function update() {
            var page = document.querySelector('.mainAnimatedPage:not(.hide)');
            var left = page ? Math.max(0, Math.round(page.getBoundingClientRect().left)) : 0;
            if (left === pageLeftValue) { return; }
            pageLeftValue = left;
            document.documentElement.style.setProperty('--ap-page-left', left + 'px');
            // Posters' case boxes shift in this unit (see mobileBoxRules' neighbours there):
            // 1% of the page is 1vw only while the page is as wide as the window.
            if (left > 0) { document.documentElement.style.setProperty('--ap-hunit', '1vw'); }
            else { document.documentElement.style.removeProperty('--ap-hunit'); }
        }
        update();
        if (pageLeftTracked) { return; }
        pageLeftTracked = true;
        window.addEventListener('resize', update);
        // again after Jellyfin's page transition (a mid-animation transform must not stick)
        document.addEventListener('viewshow', function () { update(); requestAnimationFrame(update); setTimeout(update, 450); }, true);
    }

    /**
     * Fullscreen detection, used ONLY for the "Fullscreen offset" fields:
     * the Fullscreen API never reflects the browser's own F11 toggle, so a
     * window that fills the entire screen height counts as fullscreen too.
     * The result is one class on <body>; the stylesheet does the rest. No
     * measuring, no debounce - a class toggle cannot make anything jump.
     */
    function isEffectivelyFullscreen() {
        var api = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
        var fillsScreen = !!window.screen && window.innerHeight >= window.screen.height; // height only - a maximized window still loses height to the browser chrome
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
    // The backdrop transition system: ONE bus + ONE owner factory for all
    // backdrop implementations (Detail View, People, Genre, Studio, Tag,
    // Favorites, Library View). The responsible owner CLAIMS the page
    // synchronously on the hash change and reports READY (first decoded
    // image) or EMPTY; the bus decides the outgoing owner's RELEASE from
    // that claim, instead of each implementation guessing with a timeout
    // whether a successor will come.
    // =================================================================

    var BACKDROP_FADE_MS = 800;        // Jellyfin's backdrop-fadein keyframe
    var HANDOVER_MS = 1200;            // wait for a claimed successor (normal sources) ...
    var HANDOVER_MAX_MS = 6000;        // ... extended up to this while the successor's claim is still pending (3000 left a ~1 s gap on heavy list pages, measured 5.6-6.2 s to the first image)
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

    var withBackdropObserver = null;
    /** Jellyfin's playback transparency (setBackdropTransparency Full/Backdrop): the page must stay see-through. */
    function busPlaybackTransparent(bg) {
        return bg.classList.contains('backgroundContainer-transparent');
    }
    /** True while Jellyfin's own container holds a backdrop; clearBackdrop() empties it on every page without one. */
    function busJellyfinBackdrop() {
        return !!document.querySelector('.backdropContainer .backdropImage');
    }
    var jellyfinBackdropObserver = null;
    /** Jellyfin's image can land after our release (it loads first, then appends): the curtain follows it. */
    function busWatchJellyfinBackdrop(bg) {
        var container = document.querySelector('.backdropContainer');
        if (jellyfinBackdropObserver || !container) { return; }
        jellyfinBackdropObserver = new MutationObserver(function () {
            if (!busPlaybackTransparent(bg) && busJellyfinBackdrop()) { bg.classList.add('withBackdrop'); }
        });
        jellyfinBackdropObserver.observe(container, { childList: true });
    }
    function busApplyClasses() {
        // Hide Jellyfin's container (and dim the page like Jellyfin does
        // with .withBackdrop) exactly while one of ours is showing or a
        // successor of ours is claimed - never on pages nobody of ours
        // handles (Home, library home: Jellyfin behaves as the user set it).
        var on = !!(bus.showing || claimCount());
        try { document.body.classList.toggle(OVERRIDE_BODY_CLASS, on); } catch (e) { /* no body yet */ }
        var bg = document.querySelector('.backgroundContainer');
        if (!bg) { return; }
        // During playback Jellyfin's setBackdropTransparency() adds .backgroundContainer-transparent
        // and decides ITSELF whether .withBackdrop stays: level Full (video OSD) clears it so the page is
        // see-through (`.backgroundContainer-transparent:not(.withBackdrop)`), level Backdrop (windowed
        // player) keeps it on purpose. Re-adding the class at level Full would put the theme's
        // rgba(0,0,0,.86) curtain over the player, so while the container is transparent the class is
        // touched neither way; once playback ends Jellyfin drops the transparency class and the
        // defence applies again.
        // A page handed back to Jellyfin keeps its curtain while Jellyfin's own backdrop is there:
        // setBackgroundContainerBackgroundEnabled() sets the class once and does not set it again, so
        // taking it away would leave the page opaque.
        if (!busPlaybackTransparent(bg)) { bg.classList.toggle('withBackdrop', on || busJellyfinBackdrop()); }
        busWatchJellyfinBackdrop(bg);
        if (!withBackdropObserver) {
            // Without .withBackdrop the theme paints .backgroundContainer OPAQUE
            // (dark theme: #101010) - everything of ours behind it vanishes.
            // Jellyfin removes the class itself in clearBackdrop() (every
            // list page, every person page: internalBackdrop(false)), which can
            // land between our claim and our first image and briefly show the
            // old backdrop again. Re-assert it the moment Jellyfin drops it
            // while one of ours is showing or claimed.
            withBackdropObserver = new MutationObserver(function () {
                if (busPlaybackTransparent(bg)) { return; } // Jellyfin's playback contract, see above
                var wanted = !!(bus.showing || claimCount());
                if (wanted && !bg.classList.contains('withBackdrop')) { bg.classList.add('withBackdrop'); }
            });
            withBackdropObserver.observe(bg, { attributes: true, attributeFilter: ['class'] });
        }
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
        var releasedAt = performance.now();
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
                timer = setTimeout(function () {
                    // Heavy pages block the main thread while the successor's pool
                    // request and first image take 2-4 s; a fixed 1200 ms window leaves a
                    // black gap of ~1 s. So while a normal-source claim is still pending -
                    // its request or first image still on the way - the old image stays
                    // as the bridge, up to HANDOVER_MAX_MS after the release. Wallpapers
                    // streams keep their short window (blank accepted by design), a
                    // resolved claim ends the wait through ready/empty.
                    var elapsed = performance.now() - releasedAt;
                    if (claimCount() && !claimHasWallpapers() && elapsed < HANDOVER_MAX_MS) {
                        timer = setTimeout(function () { waiter.fire(claimCount() ? 'timeout' : 'noclaim'); }, HANDOVER_MAX_MS - elapsed);
                        return;
                    }
                    waiter.fire(claimCount() ? 'timeout' : 'noclaim');
                }, ms);
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
        // The first load - the hash is already there, nothing will "change".
        // ONE boot dispatch for every listener, armed by the first
        // registration (every owner registers in the same script parse),
        // instead of one timer per owner.
        setTimeout(dispatchNavigationNow, 1200);
    }

    /**
     * One backdrop owner = one implementation's container, Ken Burns frame,
     * layer rendering (vanilla style: the new layer fades in ON TOP of the
     * opaque old one, the old one is removed when the fade ends), rotation
     * engine and release-through-the-bus. The implementation keeps only:
     * page detection, endpoint fetch, URL building, and the claim.
     *
     * options: { name, containerClass, kenBurns: { zoomStart, zoomEnd, panPx, easing },
     *            quietFrames: bool (default true: wait for a calm page before the first fade-in of a visit; false disables),
     *            log: fn }
     */
    function createBackdropOwner(options) {
        var name = options.name;
        var containerClass = options.containerClass;
        var kb = options.kenBurns || { zoomStart: 1.10, zoomEnd: 1.30, panPx: 15, easing: 'cubic-bezier(0.645, 0.045, 0.355, 1)' };
        var log = options.log || function () {};
        var quietFrames = options.quietFrames !== false;
        // 'all' (small own lists: Detail View) preloads every image at start
        // at low priority; 'next' (100-image pools) only the engine's next
        // pick, on idle - bulk preloading a pool starves the visible image
        // (measured 11.5 s instead of 1.6 s).
        var preload = options.preload || 'next';
        var scheduleIdle = window.requestIdleCallback ? function (fn) { window.requestIdleCallback(fn); } : function (fn) { setTimeout(fn, 1500); };
        function preloadNext() {
            var next = engine.peekNext();
            if (next) { preloadImage(next, { priority: 'low' }).catch(function () { /* background only */ }); }
        }

        var containerEl = null;
        var frameEl = null;
        var frameKey = null;      // the Ken Burns settings the current frame was built with
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
            if (!kenBurnsEnabled) {
                // No current frame any more - an old one leaves with its last layer (removeLayer).
                frameEl = null;
                frameKey = null;
                return container;
            }
            // The frame belongs to its Ken Burns settings. Detail View never
            // releases between items, and with per-type settings a movie ->
            // series step can change the zoom/pan durations - a new key builds a
            // new frame on top; the old one goes with its last layer
            // (removeLayer).
            var key = zoomMs + '|' + panMs;
            if (frameEl && frameKey === key && container.contains(frameEl)) { return frameEl; }
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
            frameKey = key;
            return panEl;
        }

        /**
         * Removes an outgoing layer and, when it leaves an old Ken Burns frame empty, that frame too.
         */
        function removeLayer(layer) {
            var parent = layer.parentNode;
            if (!parent) { return; }
            parent.removeChild(layer);
            if (parent !== frameEl && parent.classList && parent.classList.contains('artworkplus-kenburns-pan') && !parent.firstChild) {
                var zoom = parent.parentNode;
                if (zoom && zoom.parentNode) { zoom.parentNode.removeChild(zoom); }
            }
        }

        /** Puts this container after every other owner container in <body>, so a crossfade paints the incoming ON TOP of the outgoing. */
        function raiseToTop(c) {
            var owners = document.body.querySelectorAll(':scope > .artworkplus-backdrop-owner');
            var last = owners[owners.length - 1];
            if (last && last !== c) { document.body.insertBefore(c, last.nextSibling); }
        }

        function emptyContainer() {
            frameEl = null;
            frameKey = null;
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
            // The showing layer may sit in an older frame (Ken Burns settings
            // changed) or directly in the container (Ken Burns was off).
            var existing = getContainer().querySelector('.displayingBackdropImage');
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
                var c = getContainer();
                if (!visitShown) { raiseToTop(c); }
                // A container that was mid-fade-out (fast return to the same page) comes back.
                if (c.style.opacity === '0') { c.style.transition = ''; c.style.opacity = ''; }

                var begin = function () {
                    if (myGeneration !== generation) { return; }
                    if (!visitShown) { visitShown = true; busReady(name); }
                    void div.offsetWidth;
                    div.style.opacity = '1';
                    engine.imageShown();
                    if (onShown) { onShown(); }
                    if (preload === 'next' || settings.PreloadNextOnly) { scheduleIdle(preloadNext); }
                    if (existing) {
                        var cleaned = false;
                        var cleanup = function (event) {
                            if (event && event.propertyName && event.propertyName !== 'opacity') { return; }
                            if (cleaned) { return; }
                            cleaned = true;
                            div.removeEventListener('transitionend', cleanup);
                            removeLayer(existing);
                        };
                        div.addEventListener('transitionend', cleanup);
                        setTimeout(cleanup, BACKDROP_FADE_MS + 1000);
                    }
                };

                var switchRelease = playniteSwitchRelease();
                if (switchRelease) {
                    // Playnite Bridge's in-place version switch: the page is quiet once the Bridge lets go of its
                    // snapshot, so the fade starts then, together with the other fades of the switch, instead of
                    // after the calm frames below.
                    var waiting = true;
                    pendingCancel = function () { waiting = false; };
                    switchRelease.then(function () {
                        if (!waiting) { return; }
                        pendingCancel = null;
                        requestAnimationFrame(function () { requestAnimationFrame(begin); });
                    });
                } else if (quietFrames && !visitShown) {
                    // Every page lays out heavily right after a navigation (poster
                    // decode, card building, long tasks); a fade that starts inside
                    // that jank stutters. Measured on live transitions: the page's own
                    // jank ends within ~0.1-0.5 s (persons) to ~2 s (big lists), and
                    // fades started earlier ran into 4-6 jank frames of 50-300 ms. So
                    // every owner waits for 20 calm frames (~0.33 s at 60 Hz, cap 1.5 s)
                    // - the counter restarts on every jank frame, so the fade can never
                    // begin inside a burst.
                    var QUIET_FRAMES_NEEDED = 20, QUIET_WAIT_CAP_MS = 1500;
                    // The image is decoded - the outgoing owner's handover window
                    // restarts now, so the calm-frames wait does not eat it.
                    busClaim(name, bus.claims[name] || 'normal');
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
            // A Set override list can hold up to 100 images - only the next one
            // is warmed then (bulk preloading a pool starves the visible image).
            if (preload === 'all' && !settings.PreloadNextOnly) {
                for (var i = 1; i < images.length; i++) { preloadImage(images[i], { priority: 'low' }).catch(function () { /* background only */ }); }
            }
            var continued = engine.start(images, orderMode, cycleMs, function (url) {
                render(url, settings, null, function (failedUrl) {
                    engine.removeFailedImage(failedUrl);
                    if (engine.peekNext() !== null || images.length > 1) { engine.advance(); } else { busEmpty(name); }
                });
            });
            // The same list kept running - the image is already on screen, so
            // this visit is ready now (otherwise the claim would stay open for
            // up to one cycle, until the next tick).
            if (continued && !visitShown) { visitShown = true; busReady(name); }
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
            empty: function () {
                // The owner claimed this page but has nothing for it. If its
                // container still shows the PREVIOUS page (movie -> person:
                // Detail View claimed, the server said "no images"), that
                // content is outgoing now - it fades through the bus like a
                // release (crossfade if another owner is ready in time).
                if (hasContent()) { release(); }
                busEmpty(name);
            },
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
        playniteFirstVersion: playniteFirstVersion,
        playniteSwitchRelease: playniteSwitchRelease,
        prefersReducedMotion: prefersReducedMotion,
        retireArtBoxes: retireArtBoxes,
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
        isBootRaceRepeat: isBootRaceRepeat,
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
