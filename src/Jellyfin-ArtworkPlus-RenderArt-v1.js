/*!
 * ArtworkPlus - RenderArt (CharacterArt, Red Carpet and LogoArt)
 * ------------------------------------------------------
 * Three independent features in one file. They target different page types
 * (CharacterArt: movie/show detail pages; Red Carpet: person detail pages and
 * filmography lists; LogoArt: the logo slot of detail pages) and never touch
 * the same element, so each lives in its own IIFE and keeps its own
 * behaviour, admin section and settings.
 *
 * Placement replicates Jellyfin's own .detailLogo, which is pure CSS
 * (librarybrowser.scss: position:absolute; top:10vh; right:25vw; width:25vw;
 * height:16vh; background-size:contain). Every positional value is CSS
 * (vw/vh/em, Jellyfin's own units) in ONE injected stylesheet
 * (Core.ensureRenderArtStyles()) plus a few CSS custom properties per box
 * (Core.applyArtBoxSizing()), so nothing jumps while the window is resized.
 * JavaScript only fetches the endpoint, creates the elements and runs the
 * image rotation (cycle/fade/delay/order/single pass), plus one class toggle
 * on <body> for the Fullscreen offset (CSS :fullscreen cannot see F11).
 *
 * Anchors:
 *   - CharacterArt Top: the box's bottom edge sits on the ribbon line
 *     (.itemBackdrop bottom minus .detailRibbon's 7.2em), it grows upwards;
 *     TopLeft ends at the clearlogo's left edge (50vw), TopRight starts at
 *     its right edge (75vw); Offset (+ Fullscreen offset) shifts it.
 *   - CharacterArt Bottom and Red Carpet: position:fixed at the bottom of
 *     the viewport, 0.8vw from the side edge, shifted by Offset.
 *   - Hidden below 68.75em width exactly like the native clearlogo (top
 *     positions only - the bottom ones do not mirror the logo).
 *
 * Requires Jellyfin-ArtworkPlus-Core-v1.js to be loaded first.
 */

/*!
 * Characterart - positioning script
 * ------------------------------------------------------
 * Own endpoint (/Characterart/...), own placement on the page instead of
 * the poster slot. Sizing is the admin's "window" (ScaleMode Height/Width
 * with the matching Max value) - the image fits inside it with
 * object-fit:contain, aligned by HorizontalAlign, exactly as the
 * clearlogo's background-size:contain fits its 25vw x 16vh box.
 */
(function () {
    'use strict';

    // Duplicate-load guard: see Core.claimSingleton()'s own doc comment.
    if (!window.ArtworkPlusCore.claimSingleton('Characterart')) { return; }

    var DEBUG = true;
    var PRELOAD_TIMEOUT_MS = 8000;
    // Same reasoning as Posters-v1.js's ExtraModule's own
    // MAX_CONSECUTIVE_FAILURES: never retry a broken list forever.
    var MAX_CONSECUTIVE_FAILURES = 6;

    var Core = window.ArtworkPlusCore;
    var log = Core.makeLogger('[Characterart]', DEBUG);
    var getItemIdFromHash = Core.getItemIdFromHash;
    var isDetailsPage = Core.isDetailsPage;
    var horizontalAlignToObjectPosition = Core.horizontalAlignToObjectPosition;

    Core.ensureRenderArtStyles();
    Core.installFullscreenClass();

    var runToken = 0;
    var tracker = Core.createTimerTracker();
    var clearTimers = tracker.clearTimers;
    var track = tracker.track;
    var navTracker = Core.createTimerTracker();
    var contentReady = false;
    var startedFor = null; // { hash, at } of the run in flight (boot-race guard)
    // "This page should currently be showing a container" - set only at the
    // exact point start() commits to rendering; the presence heartbeat
    // below recovers a container that vanished (e.g. a view re-render).
    var shouldHaveContainer = false;
    // The answer the running box was built from, for Playnite Bridge's in-place version switch.
    var runningSig = null;

    // Order-free: Shuffle/Random hand out a new order on every call for the same files.
    function signatureOf(result) {
        var copy = Object.assign({}, result);
        copy.Images = (result.Images || []).map(function (e) { return e.FileName + '|' + e.Version; }).sort();
        return JSON.stringify(copy);
    }

    // Playnite Bridge versions: the first-opened version goes along as ?first=.
    function firstQuery(itemId, sep) {
        var first = Core.playniteFirstVersion(itemId);
        return first ? sep + 'first=' + encodeURIComponent(first) : '';
    }

    function fetchResult(itemId) {
        return fetch('/Characterart/' + encodeURIComponent(itemId) + firstQuery(itemId, '?'), { cache: 'no-store' }).then(function (r) { return r.json(); });
    }

    function waitFor(fn, timeoutMs) {
        return new Promise(function (resolve) {
            var t0 = Date.now();
            (function poll() {
                var el = fn();
                if (el) { return resolve(el); }
                if (Date.now() - t0 > (timeoutMs || 8000)) { return resolve(null); }
                track(setTimeout(poll, 150));
            })();
        });
    }

    function preloadImage(url) {
        return Core.preloadImage(url, { resolveWith: 'image', timeoutMs: PRELOAD_TIMEOUT_MS, track: track });
    }

    function findLogo() {
        var root = Core.findVisibleDetailPage() || document;
        return root.querySelector('.detailLogo');
    }

    // all = also the boxes of a Playnite Bridge version switch that are still fading out.
    function removeContainers(all) {
        var selector = all ? '.characterart-container, .characterart-anchor' : '.characterart-container:not(.artworkplus-outgoing), .characterart-anchor:not(.artworkplus-outgoing)';
        document.querySelectorAll(selector).forEach(function (el) { el.remove(); });
    }

    // Playnite Bridge's in-place version switch: on a different answer the drawn box stays as
    // "outgoing" while the new one is built beside it, and fades out when the new picture fades in
    // (after the Bridge's release signal). Nothing new to show = it fades out at the release.
    var outgoing = [];
    var outgoingFadeMs = 0;
    function keepAsOutgoing() {
        var batch = Array.from(document.querySelectorAll('.characterart-container, .characterart-anchor'));
        batch.forEach(function (el) { el.classList.add('artworkplus-outgoing'); });
        outgoing = batch;
        // Last resort: a new box whose images never load must not leave the old one standing.
        setTimeout(function () { if (outgoing === batch) { retireOutgoing(outgoingFadeMs); } }, 10000);
    }
    function retireOutgoing(fadeMs) {
        var batch = outgoing;
        outgoing = [];
        Core.retireArtBoxes(batch, fadeMs);
    }
    function retireOutgoingAtRelease(batch) {
        if (!batch.length || outgoing !== batch) { return; }
        (Core.playniteSwitchRelease() || Promise.resolve()).then(function () {
            if (outgoing === batch) { retireOutgoing(outgoingFadeMs); }
        });
    }

    /// Builds the box (and, for the top positions, its zero-height anchor
    /// on the ribbon line). The top anchor is inserted directly BEFORE
    /// Jellyfin's own .detailLogo inside the detail page - the same
    /// containing block as the clearlogo (the page is position:absolute),
    /// so it scrolls away with the page exactly like the logo, and it
    /// stays BEHIND the logo in the stacking order (DOM order, z-index 0).
    /// The bottom positions go to <body> as position:fixed, like .skinHeader.
    function createContainer(position, logo) {
        removeContainers();
        var box = document.createElement('div');
        box.className = 'characterart-container artworkplus-art-box ' + Core.positionClass(position);
        box.style.zIndex = '5';
        if (position === 'TopLeft' || position === 'TopRight') {
            var anchor = document.createElement('div');
            anchor.className = 'characterart-anchor artworkplus-art-anchor ' + Core.positionClass(position);
            anchor.appendChild(box);
            box.style.zIndex = '';
            logo.parentNode.insertBefore(anchor, logo);
        } else {
            document.body.appendChild(box);
        }
        return box;
    }

    function createImageLayer(container, fadeMs, horizontalAlign) {
        var img = document.createElement('img');
        img.className = 'characterart-layer';
        img.style.objectPosition = horizontalAlignToObjectPosition(horizontalAlign);
        img.style.opacity = '0';
        img.style.transition = 'opacity ' + fadeMs + 'ms ease';
        container.appendChild(img);
        return img;
    }

    async function start() {
        clearTimers();
        var myToken = ++runToken;

        var itemId = getItemIdFromHash();
        if (!itemId) { return; }
        contentReady = true;
        startedFor = { hash: location.hash, at: performance.now() };
        log('Starting for item', itemId);

        var result;
        try {
            result = await fetchResult(itemId);
        } catch (e) {
            log('Error fetching', e);
            return;
        }
        if (myToken !== runToken) { return; }
        if (!result.IsApplicable || !Array.isArray(result.Images) || result.Images.length === 0) {
            log('Not applicable or no images found');
            return;
        }

        var imageUrls = result.Images.map(function (entry) {
            return '/Characterart/' + encodeURIComponent(itemId) + '/image/' + encodeURIComponent(entry.FileName)
                + '?v=' + encodeURIComponent(entry.Version) + firstQuery(itemId, '&');
        });

        var isTop = result.Position === 'TopLeft' || result.Position === 'TopRight';
        var logo = null;
        if (isTop) {
            // The anchor needs the logo ELEMENT (for its DOM position) -
            // not its size: hidden (display:none below 68.75em) is fine,
            // the stylesheet hides the anchor at the same breakpoint.
            logo = await waitFor(findLogo);
            if (myToken !== runToken) { return; }
            if (!logo) { log('No .detailLogo element on this page - cannot anchor a top position'); return; }
        }

        var container = createContainer(result.Position, logo);
        var layers = [createImageLayer(container, result.FadeTimeMs, result.HorizontalAlign), createImageLayer(container, result.FadeTimeMs, result.HorizontalAlign)];
        var visibleIndex = -1;
        var slideIndex = 0;
        var consecutiveFailures = 0;
        var sizingApplied = false;
        // Bumped on every showNext(), checked inside the fade-in rAF -
        // otherwise images overlap after the tab was backgrounded.
        var fadeInGeneration = 0;

        async function showNext() {
            if (myToken !== runToken || !document.body.contains(container)) { return; }
            if (result.SinglePass && slideIndex >= imageUrls.length) {
                var visibleLayer = visibleIndex === -1 ? null : layers[visibleIndex];
                if (visibleLayer) { visibleLayer.style.opacity = '0'; }
                log('Single-pass complete');
                return;
            }
            var url = imageUrls[slideIndex % imageUrls.length];
            var loadedImg;
            try {
                loadedImg = await preloadImage(url);
            } catch (e) {
                log('Image skipped (load error)', e);
                slideIndex++;
                consecutiveFailures++;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    var failedVisibleLayer = visibleIndex === -1 ? null : layers[visibleIndex];
                    if (failedVisibleLayer) { failedVisibleLayer.style.opacity = '0'; }
                    log('Giving up after', consecutiveFailures, 'consecutive failures');
                    return;
                }
                track(setTimeout(showNext, 50));
                return;
            }
            if (myToken !== runToken) { return; }
            consecutiveFailures = 0;

            // Version switch: the first picture of the new box fades in once the Bridge released its snapshot,
            // also when the version before had no box (nothing outgoing).
            var switchRelease = visibleIndex === -1 ? Core.playniteSwitchRelease() : null;
            var switching = visibleIndex === -1 && (outgoing.length > 0 || !!switchRelease);
            if (switching) {
                if (switchRelease) { await switchRelease; }
                if (myToken !== runToken) { return; }
            }
            var instant = switching && Core.prefersReducedMotion();

            if (!sizingApplied) {
                // Once per rotation: the first image's aspect ratio only matters
                // when a Max value is 0.
                Core.applyArtBoxSizing(container, result, loadedImg.naturalWidth / loadedImg.naturalHeight);
                sizingApplied = true;
                log('Box applied as CSS | position:', result.Position, '| scale:', result.ScaleMode, '| height:', container.style.height, '| width:', container.style.width, '| offset:', container.style.getPropertyValue('--ap-offset'));
            }

            var nextLayerIndex = visibleIndex === 0 ? 1 : 0;
            var nextLayer = layers[nextLayerIndex];
            var prevLayer = visibleIndex === -1 ? null : layers[visibleIndex];
            var myGeneration = ++fadeInGeneration;
            nextLayer.src = url;
            nextLayer.style.zIndex = '2';
            nextLayer.style.opacity = '0';
            if (instant) { nextLayer.style.transition = 'none'; }
            void nextLayer.offsetWidth; // forces a synchronous reflow so the transition really runs
            if (prevLayer) {
                prevLayer.style.zIndex = '1';
                prevLayer.style.opacity = '0';
            }
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    if (myToken !== runToken) { return; }
                    if (myGeneration !== fadeInGeneration) { return; }
                    nextLayer.style.opacity = '1';
                    if (switching) { retireOutgoing(result.FadeTimeMs); }
                    if (instant) {
                        void nextLayer.offsetWidth;
                        nextLayer.style.transition = 'opacity ' + result.FadeTimeMs + 'ms ease';
                    }
                });
            });
            visibleIndex = nextLayerIndex;
            slideIndex++;

            var isSingleImageThatShouldStillEnd = imageUrls.length === 1 && result.SinglePass && !result.StaySingleImageStatic;
            if ((result.MultiImage && imageUrls.length > 1) || isSingleImageThatShouldStillEnd) {
                track(setTimeout(showNext, result.CycleTimeMs));
            }
        }

        // A version switch is no new page visit: the new box replaces the old one without the page's Delay.
        var delayMs = result.DelayEnabled && !outgoing.length ? result.DelayMs : 0;
        await new Promise(function (resolve) { track(setTimeout(resolve, delayMs)); });
        if (myToken !== runToken) { return; }
        log('Showing Characterart, position:', result.Position, '| MultiImage:', result.MultiImage, '|', imageUrls.length, 'image(s)');
        shouldHaveContainer = true;
        runningSig = signatureOf(result);
        outgoingFadeMs = result.FadeTimeMs;
        showNext();
    }

    // switching = Playnite Bridge's in-place version switch with a different answer: the drawn box
    // fades out instead of vanishing; every other call removes everything at once.
    function schedule(switching) {
        clearTimers();
        navTracker.clearTimers();
        runToken++;
        if (switching) {
            keepAsOutgoing();
        } else {
            outgoing = [];
            removeContainers(true);
        }
        contentReady = false;
        shouldHaveContainer = false;
        runningSig = null;
        Core.scheduleNavigationBurst(function () {
            if (contentReady || !isDetailsPage()) { return; }
            var batch = outgoing;
            start().then(function () { if (!shouldHaveContainer) { retireOutgoingAtRelease(batch); } });
        }, navTracker.track);
    }

    // Playnite Bridge's version switch stays on the same view and sends a viewshow with detail.pbInPlace. The versions of a
    // game share one game folder, so the box keeps running when the new id gets the same answer; anything else rebuilds it.
    async function recheckInPlace() {
        var myToken = runToken;
        var itemId = getItemIdFromHash();
        var result = null;
        try {
            result = itemId ? await fetchResult(itemId) : null;
        } catch (e) {
            log('Error fetching', e);
        }
        if (myToken !== runToken) { return; }
        if (result && result.IsApplicable && runningSig === signatureOf(result)) {
            startedFor = { hash: location.hash, at: performance.now() };
            log('In-place version switch: same Characterart, box kept for', itemId);
            return;
        }
        schedule(true);
    }

    // On a hard reload the 1 200 ms cold-start timer below fires BEFORE
    // Jellyfin's first 'viewshow' (~200 ms later); a viewshow restarting the run
    // would mean two fetches per page load. A viewshow within the boot window
    // for the page a run already started on is the same navigation, not a new
    // one; hash changes, the poll and the heartbeat keep their unconditional
    // schedule().
    document.addEventListener('viewshow', function (e) {
        if (Core.isBootRaceRepeat(startedFor)) { return; }
        if (e.detail && e.detail.pbInPlace && runningSig) { recheckInPlace(); return; }
        schedule();
    });
    Core.watchForNavigation(function () { schedule(); });
    Core.startPresenceHeartbeat(
        function () { return !shouldHaveContainer || !!document.querySelector('.characterart-container'); },
        function () { log('Presence heartbeat: container missing, recovering'); schedule(); }
    );
    track(setTimeout(function () {
        if (contentReady || !isDetailsPage()) { return; }
        start();
    }, 1200));
})();

/*!
 * Red Carpet - script
 * ------------------------------------------------------
 * Shows up ONCE PER PAGE at a viewport-anchored position (bottom left/
 * right, position:fixed - glued to the window like .skinHeader). Always
 * exactly one static image per person, a single fade-in on appearance
 * (fixed duration). The box is pure CSS (see the file header) - no
 * resize/fullscreen listeners.
 *
 * Two recognized page types:
 *   - Person detail page: #/details?id=<personId> -> scope=info
 *   - Filmography list:   #/list.html?type=Movie|Series|Episode&personId=<personId>
 *     -> scope=movie|series|episode
 * The server checks for itself whether the id belongs to a person.
 */
(function () {
    'use strict';

    if (!window.ArtworkPlusCore.claimSingleton('RedCarpet')) { return; }

    var DEBUG = true;
    var PRELOAD_TIMEOUT_MS = 8000;
    var FADE_MS = 500; // hardcoded, see the header

    var Core = window.ArtworkPlusCore;
    var log = Core.makeLogger('[RedCarpet]', DEBUG);
    var horizontalAlignToObjectPosition = Core.horizontalAlignToObjectPosition;

    Core.ensureRenderArtStyles();
    Core.installFullscreenClass();

    var runToken = 0;
    var tracker = Core.createTimerTracker();
    var track = tracker.track;
    var clearTimers = tracker.clearTimers;
    var navTracker = Core.createTimerTracker();
    var contentReady = false;
    var startedFor = null; // { hash, at } of the run in flight (boot-race guard)
    var currentPersonId = null;

    function preloadImage(url) {
        return Core.preloadImage(url, { resolveWith: 'image', timeoutMs: PRELOAD_TIMEOUT_MS });
    }

    function detectPersonAndScope() {
        var hash = location.hash || '';
        var qIndex = hash.indexOf('?');
        // Jellyfin 12.1 routes carry no '.html' - compare without it.
        var path = hash.split('?')[0].replace(/^#\/?/, '').replace(/\.html$/, '');
        var params = qIndex === -1 ? new URLSearchParams() : new URLSearchParams(hash.slice(qIndex + 1));

        if (path === 'details') {
            var id = params.get('id');
            return id ? { personId: id, scope: 'info' } : null;
        }

        if (path === 'list') {
            var personId = params.get('personId');
            var type = (params.get('type') || '').toLowerCase();
            if (!personId || (type !== 'movie' && type !== 'series' && type !== 'episode')) { return null; }
            return { personId: personId, scope: type };
        }

        return null;
    }

    function createContainer(position) {
        var div = document.createElement('div');
        div.className = 'redcarpet-container artworkplus-art-box ' + Core.positionClass(position);
        div.style.zIndex = '5';
        div.style.opacity = '0';
        div.style.transition = 'opacity ' + FADE_MS + 'ms ease';
        document.body.appendChild(div);
        return div;
    }

    function fadeOutAndRemoveContainer() {
        currentPersonId = null;
        var containers = document.querySelectorAll('.redcarpet-container');
        containers.forEach(function (el) { el.style.opacity = '0'; });
        setTimeout(function () {
            containers.forEach(function (el) { el.remove(); });
        }, FADE_MS);
    }

    async function start() {
        clearTimers();
        var myToken = ++runToken;

        var detected = detectPersonAndScope();
        log('start() called, hash:', location.hash, '| detected:', JSON.stringify(detected), '| currentPersonId:', currentPersonId);
        if (!detected) {
            fadeOutAndRemoveContainer();
            return;
        }
        if (detected.personId === currentPersonId) {
            contentReady = true;
            return;
        }
        fadeOutAndRemoveContainer();
        contentReady = true;
        startedFor = { hash: location.hash, at: performance.now() };

        var result;
        try {
            result = await fetch('/RedCarpet/' + encodeURIComponent(detected.personId) + '?scope=' + detected.scope, { cache: 'no-store' })
                .then(function (r) { return r.json(); });
        } catch (e) {
            log('Error fetching', e);
            return;
        }
        if (myToken !== runToken) { return; }
        if (!result.IsApplicable) { return; }

        var url = '/RedCarpet/' + encodeURIComponent(detected.personId) + '/image'
            + '?v=' + encodeURIComponent(result.Version);
        var loadedImg;
        try {
            loadedImg = await preloadImage(url);
        } catch (e) {
            log('The image could not be loaded', e);
            return;
        }
        if (myToken !== runToken) { return; }

        var container = createContainer(result.Position);
        Core.applyArtBoxSizing(container, result, loadedImg.naturalWidth / loadedImg.naturalHeight);
        var img = document.createElement('img');
        img.src = url;
        img.style.objectPosition = horizontalAlignToObjectPosition(result.HorizontalAlign);
        container.appendChild(img);

        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                if (myToken !== runToken) { return; }
                container.style.opacity = '1';
            });
        });
        currentPersonId = detected.personId;
        log('Red Carpet shown for person', detected.personId, '| Scope:', detected.scope, '| Position:', result.Position, '| box:', container.style.width, 'x', container.style.height);
    }

    function schedule() {
        clearTimers();
        navTracker.clearTimers();
        runToken++;
        contentReady = false;
        Core.scheduleNavigationBurst(function () {
            if (contentReady) { return; }
            start();
        }, navTracker.track);
    }

    // See the Characterart note on the boot race.
    document.addEventListener('viewshow', function () { if (Core.isBootRaceRepeat(startedFor)) { return; } schedule(); });
    Core.watchForNavigation(schedule);
    track(setTimeout(function () {
        if (contentReady) { return; }
        start();
    }, 1200));
})();

/*!
 * LogoArt - the logo slot of detail pages
 * ------------------------------------------------------
 * The server (/LogoArt/{itemId}) resolves everything - item type,
 * inheritance levels, Source mode, the stage chain, Characterart files,
 * the person's font - and this section only preloads and shows: the first
 * stage whose image loads wins, there is no live switching between sources
 * (only the Characterart stage's own rotation).
 *
 * The slot: vanilla's .detailLogo stays in the DOM (Characterart's top
 * anchor is inserted before it) and is hidden from the first paint by the
 * FileTransformation style whenever any item type deviates from its
 * vanilla default; our own .logoart-container is inserted right AFTER it,
 * in the same containing block, so every position is the same CSS the
 * clearlogo uses (Core.ensureRenderArtStyles: 25vw wide, centre 62.5vw,
 * top 10vh - or bottom on the ribbon line for Clearart/Characterart).
 * Zero intervention: a type at VanillaLogo / 100 / 0 / 0 gets ONE class
 * on .detailLogo that releases the prehiding - nothing else is touched.
 *
 * Persons: the same chain shape with FolderLogo (a file in the person
 * folder, served by /LogoArt/person/{id}/image) and Text (the name
 * rendered live in a bundled font from /LogoArt/font/..., fitted into the
 * box by a binary search on the font size, re-fitted on resize).
 */
(function () {
    'use strict';

    if (!window.ArtworkPlusCore.claimSingleton('LogoArt')) { return; }

    var DEBUG = true;
    var PRELOAD_TIMEOUT_MS = 8000;
    var MAX_CONSECUTIVE_FAILURES = 6;
    var CONTAINER_CLASS = 'logoart-container';
    var RELEASE_CLASS = 'artworkplus-logoart-vanilla';
    var FLOOR_KINDS = { Clearart: 'logoart-clearart', Characterart: 'logoart-characterart' };
    var loadedFonts = {};

    var Core = window.ArtworkPlusCore;
    var log = Core.makeLogger('[LogoArt]', DEBUG);
    var getItemIdFromHash = Core.getItemIdFromHash;
    var isDetailsPage = Core.isDetailsPage;

    Core.ensureRenderArtStyles();

    var runToken = 0;
    var tracker = Core.createTimerTracker();
    var clearTimers = tracker.clearTimers;
    var track = tracker.track;
    var navTracker = Core.createTimerTracker();
    var contentReady = false;
    var startedFor = null; // { hash, at } of the run in flight (boot-race guard)
    var shouldHaveContainer = false;
    var resizeHandler = null;
    // The answer the drawn box was built from, for Playnite Bridge's in-place version switch.
    var runningSig = null;
    var resultSig = null;

    // Order-free: Shuffle/Random hand out a new order of the slot's Characterart files on every call.
    function signatureOf(result) {
        var copy = Object.assign({}, result);
        copy.Stages = (result.Stages || []).map(function (st) {
            return Object.assign({}, st, { Images: (st.Images || []).map(function (e) { return e.FileName + '|' + e.Version; }).sort() });
        });
        return JSON.stringify(copy);
    }

    function fetchResult(itemId) {
        var first = Core.playniteFirstVersion(itemId);
        return fetch('/LogoArt/' + encodeURIComponent(itemId) + (first ? '?first=' + encodeURIComponent(first) : ''), { cache: 'no-store' }).then(function (r) { return r.json(); });
    }

    function waitFor(fn, timeoutMs) {
        return new Promise(function (resolve) {
            var t0 = Date.now();
            (function poll() {
                var el = fn();
                if (el) { return resolve(el); }
                if (Date.now() - t0 > (timeoutMs || 8000)) { return resolve(null); }
                track(setTimeout(poll, 150));
            })();
        });
    }

    function preloadImage(url) {
        return Core.preloadImage(url, { resolveWith: 'image', timeoutMs: PRELOAD_TIMEOUT_MS, track: track });
    }

    function findLogo() {
        var root = Core.findVisibleDetailPage() || document;
        return root.querySelector('.detailLogo');
    }

    // all = also the boxes of a Playnite Bridge version switch that are still fading out.
    function removeContainers(all) {
        document.querySelectorAll('.' + CONTAINER_CLASS + (all ? '' : ':not(.artworkplus-outgoing)')).forEach(function (el) { el.remove(); });
        if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
    }

    // Playnite Bridge's in-place version switch: on a different answer the drawn box stays as
    // "outgoing" while the new one is built beside it, and fades out when the new one fades in
    // (after the Bridge's release signal). Nothing new to show = it fades out at the release.
    var outgoing = [];
    var outgoingFadeMs = 0;
    function keepAsOutgoing() {
        var batch = Array.from(document.querySelectorAll('.' + CONTAINER_CLASS));
        batch.forEach(function (el) { el.classList.add('artworkplus-outgoing'); });
        outgoing = batch;
        // Last resort: a new box whose images never load must not leave the old one standing.
        setTimeout(function () { if (outgoing === batch) { retireOutgoing(outgoingFadeMs); } }, 10000);
    }
    function retireOutgoing(fadeMs) {
        var batch = outgoing;
        outgoing = [];
        Core.retireArtBoxes(batch, fadeMs);
    }
    function retireOutgoingAtRelease(batch) {
        if (!batch.length || outgoing !== batch) { return; }
        (Core.playniteSwitchRelease() || Promise.resolve()).then(function () {
            if (outgoing === batch) { retireOutgoing(outgoingFadeMs); }
        });
    }

    // Version switch: a static box (logo picture, name as text) was built at opacity 0 and fades in over the old one
    // once the Bridge released its snapshot; reduced motion shows it at once.
    async function revealSwitchedBox(box, fadeMs, myToken) {
        var switchRelease = Core.playniteSwitchRelease();
        if (switchRelease) { await switchRelease; }
        if (myToken !== runToken) { return; }
        var instant = Core.prefersReducedMotion();
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                if (myToken !== runToken) { return; }
                if (!instant) { box.style.transition = 'opacity ' + fadeMs + 'ms ease'; }
                box.style.opacity = '';
                retireOutgoing(fadeMs);
            });
        });
    }

    /// One box per page, right after .detailLogo (same containing block as
    /// the clearlogo). Geometry per stage kind, each with its own sizes and no cap:
    ///   - VanillaLogo / FolderLogo / Text: the vanilla slot, Size / Offset /
    ///     Vertical offset as custom properties;
    ///   - Clearart: the 16:9 box standing on the ribbon line, its own
    ///     Size / Offset / Vertical offset, no upper cap;
    ///   - Characterart: the Characterart tab's sizing block through
    ///     Core.applyArtBoxSizing (Scale by, Height/max width, Width/max
    ///     height, Align, Offset) on the ribbon line; Height 0 = the full
    ///     height from the ribbon line up to the page top (a class, so the
    ///     31.25em exception of the ribbon line is honoured too).
    function createContainer(logo, result, kind) {
        removeContainers();
        var box = document.createElement('div');
        box.className = CONTAINER_CLASS + ' ' + (FLOOR_KINDS[kind] ? 'logoart-floor ' + FLOOR_KINDS[kind] : 'logoart-slot') + ' logoart-kind-' + kind.toLowerCase();
        if (kind === 'Clearart') {
            box.style.setProperty('--la-size', String((result.ClearartSizePercent > 0 ? result.ClearartSizePercent : 100) / 100));
            box.style.setProperty('--la-offset', (result.ClearartOffsetVw || 0) + 'vw');
            box.style.setProperty('--la-voffset', (result.ClearartVerticalOffsetVh || 0) + 'vh');
        } else if (kind === 'Characterart') {
            box.style.setProperty('--la-offset', (result.HorizontalOffsetVw || 0) + 'vw');
            box.style.setProperty('--la-voffset', '0vh');
        } else {
            box.style.setProperty('--la-size', String((result.SizePercent > 0 ? result.SizePercent : 100) / 100));
            box.style.setProperty('--la-offset', (result.OffsetVw || 0) + 'vw');
            box.style.setProperty('--la-voffset', (result.VerticalOffsetVh || 0) + 'vh');
        }
        logo.parentNode.insertBefore(box, logo.nextSibling);
        return box;
    }

    /// Characterart stage sizing = the real Characterart's (Core.applyArtBoxSizing),
    /// applied once with the first image's aspect ratio (only matters when a Max is 0).
    function applyCharacterartSizing(box, result, naturalRatio) {
        var full = result.ScaleMode !== 'Width' && !(result.HeightVh > 0);
        var sizing = { ScaleMode: result.ScaleMode, HeightVh: full ? 1 : result.HeightVh, MaxWidthVw: result.MaxWidthVw, WidthVw: result.WidthVw, MaxHeightVh: result.MaxHeightVh, HorizontalOffsetVw: 0, FullscreenHorizontalOffsetVw: 0 };
        Core.applyArtBoxSizing(box, sizing, naturalRatio);
        box.classList.toggle('logoart-full-height', full);
        if (full) { box.style.height = ''; }
        box.querySelectorAll('img').forEach(function (img) { img.style.objectPosition = Core.horizontalAlignToObjectPosition(result.HorizontalAlign); });
    }

    function createImageLayer(container, fadeMs) {
        var img = document.createElement('img');
        img.className = 'logoart-layer';
        img.style.opacity = '0';
        img.style.transition = 'opacity ' + fadeMs + 'ms ease';
        container.appendChild(img);
        return img;
    }

    /// The Characterart stage's rotation - the same cycle / fade / order /
    /// single-pass / stay-static behaviour as the Characterart section
    /// above, driven by the LogoArt type's OWN fields (independent of the
    /// Characterart tab).
    function runRotation(container, imageUrls, result, myToken) {
        var layers = [createImageLayer(container, result.FadeTimeMs), createImageLayer(container, result.FadeTimeMs)];
        var visibleIndex = -1;
        var slideIndex = 0;
        var consecutiveFailures = 0;
        var fadeInGeneration = 0;
        var sizingApplied = false;

        async function showNext() {
            if (myToken !== runToken || !document.body.contains(container)) { return; }
            if (result.SinglePass && slideIndex >= imageUrls.length) {
                var visibleLayer = visibleIndex === -1 ? null : layers[visibleIndex];
                if (visibleLayer) { visibleLayer.style.opacity = '0'; }
                log('Characterart stage: single pass complete');
                return;
            }
            var url = imageUrls[slideIndex % imageUrls.length];
            var loadedImg;
            try {
                loadedImg = await preloadImage(url);
            } catch (e) {
                log('Characterart stage: image skipped (load error)', e);
                slideIndex++;
                consecutiveFailures++;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { log('Giving up after', consecutiveFailures, 'consecutive failures'); return; }
                track(setTimeout(showNext, 50));
                return;
            }
            if (myToken !== runToken) { return; }
            consecutiveFailures = 0;
            // Version switch: the first picture of the new box fades in once the Bridge released its snapshot.
            var switching = visibleIndex === -1 && outgoing.length > 0;
            if (switching) {
                var switchRelease = Core.playniteSwitchRelease();
                if (switchRelease) { await switchRelease; }
                if (myToken !== runToken) { return; }
            }
            var instant = switching && Core.prefersReducedMotion();
            if (!sizingApplied) {
                applyCharacterartSizing(container, result, loadedImg.naturalWidth / loadedImg.naturalHeight);
                sizingApplied = true;
                log('Characterart box | scale:', result.ScaleMode, '| height:', container.style.height || 'full', '| width:', container.style.width, '| align:', result.HorizontalAlign);
            }
            var nextLayerIndex = visibleIndex === 0 ? 1 : 0;
            var nextLayer = layers[nextLayerIndex];
            var prevLayer = visibleIndex === -1 ? null : layers[visibleIndex];
            var myGeneration = ++fadeInGeneration;
            nextLayer.src = url;
            nextLayer.style.zIndex = '2';
            nextLayer.style.opacity = '0';
            if (instant) { nextLayer.style.transition = 'none'; }
            void nextLayer.offsetWidth;
            if (prevLayer) { prevLayer.style.zIndex = '1'; prevLayer.style.opacity = '0'; }
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    if (myToken !== runToken || myGeneration !== fadeInGeneration) { return; }
                    nextLayer.style.opacity = '1';
                    if (switching) { retireOutgoing(result.FadeTimeMs); }
                    if (instant) {
                        void nextLayer.offsetWidth;
                        nextLayer.style.transition = 'opacity ' + result.FadeTimeMs + 'ms ease';
                    }
                });
            });
            visibleIndex = nextLayerIndex;
            slideIndex++;
            var isSingleImageThatShouldStillEnd = imageUrls.length === 1 && result.SinglePass && !result.StaySingleImageStatic;
            if ((result.MultiImage && imageUrls.length > 1) || isSingleImageThatShouldStillEnd) {
                track(setTimeout(showNext, result.CycleTimeMs));
            }
        }

        showNext();
    }

    /// Text stage: loads the font once (@font-face from our endpoint),
    /// then fits the name into the box (binary search on the font size,
    /// like the bulk creator) and keeps it fitted on resize. Two stacked
    /// layers: black rim under the white body (stylesheet). The glyph
    /// rule (a font without an accented letter gets the normalised name)
    /// is applied by the server with the real font file - stage.Text
    /// arrives ready to render, identical to what the bulk creator writes.
    async function ensureFont(family, file) {
        if (loadedFonts[file]) { return loadedFonts[file]; }
        var url = '/LogoArt/font/' + file.split('/').map(encodeURIComponent).join('/');
        var face = new FontFace(family, 'url(' + url + ')');
        var p = face.load().then(function (loaded) { document.fonts.add(loaded); return family; });
        loadedFonts[file] = p;
        return p;
    }

    function fitText(container, layers, measure) {
        var maxW = container.clientWidth;
        var maxH = container.clientHeight;
        if (!maxW || !maxH) { return; }
        var lo = 6, hi = 400, best = 6;
        while (hi - lo > 0.5) {
            var mid = (lo + hi) / 2;
            measure.style.fontSize = mid + 'px';
            var r = measure.getBoundingClientRect();
            if (r.width <= maxW && r.height <= maxH) { best = mid; lo = mid; } else { hi = mid; }
        }
        layers.forEach(function (l) { l.style.fontSize = best + 'px'; });
    }

    async function showText(container, stage, result, myToken) {
        var family;
        try {
            family = await ensureFont(stage.FontFamily, stage.FontFile);
        } catch (e) {
            log('Text stage: font failed to load', stage.FontFile, e);
            return false;
        }
        if (myToken !== runToken) { return false; }
        var text = stage.Uppercase ? stage.Text.toUpperCase() : stage.Text;
        container.style.setProperty('--la-stroke', String(result.TextStroke || 0));
        container.style.setProperty('--la-outline', String(result.Outline === undefined ? 1 : result.Outline));
        var quoted = "'" + family.replace(/'/g, "\\'") + "', 'Noto Sans', sans-serif";
        var measure = document.createElement('span');
        measure.className = 'logoart-text logoart-text-measure';
        measure.style.fontFamily = quoted;
        measure.textContent = text;
        container.appendChild(measure);
        var layers = ['logoart-text logoart-text-rim', 'logoart-text'].map(function (cls) {
            var span = document.createElement('span');
            span.className = cls;
            span.style.fontFamily = quoted;
            span.textContent = text;
            container.appendChild(span);
            return span;
        });
        fitText(container, layers, measure);
        resizeHandler = function () { if (document.body.contains(container)) { fitText(container, layers, measure); } };
        window.addEventListener('resize', resizeHandler);
        return true;
    }

    async function start() {
        clearTimers();
        var myToken = ++runToken;

        var itemId = getItemIdFromHash();
        if (!itemId) { return; }
        contentReady = true;
        startedFor = { hash: location.hash, at: performance.now() };

        var result = null;
        try {
            result = await fetchResult(itemId);
        } catch (e) {
            log('Error fetching', e);
        }
        if (myToken !== runToken) { return; }
        resultSig = result ? signatureOf(result) : null;

        var logo = await waitFor(findLogo);
        if (myToken !== runToken) { return; }
        if (!logo) { log('No .detailLogo element on this page'); return; }

        // While the prehiding style is injected, EVERY path that does not draw its
        // own logo must release the vanilla slot - a failed fetch (server
        // restarting, 500) or a type without a LogoArt block (Trailer, Playlist,
        // Photo, LiveTV) would otherwise leave it hidden.
        if (!result || !result.IsApplicable) {
            logo.classList.add(RELEASE_CLASS);
            log(result ? 'Not applicable for ' + itemId : 'No answer for ' + itemId, '- vanilla logo released');
            return;
        }

        if (result.ZeroIntervention) {
            logo.classList.add(RELEASE_CLASS);
            log('Zero intervention for', result.ItemType, '- vanilla logo released');
            return;
        }
        logo.classList.remove(RELEASE_CLASS);
        outgoingFadeMs = result.FadeTimeMs;

        var stages = Array.isArray(result.Stages) ? result.Stages : [];
        log('Chain for', result.ItemType, ':', stages.map(function (s) { return s.Kind + (s.Level ? '@' + s.Level : ''); }).join(' > '));
        for (var i = 0; i < stages.length; i++) {
            var stage = stages[i];
            if (myToken !== runToken) { return; }
            if (stage.Kind === 'Hide') {
                log('Hide: the slot stays empty');
                return;
            }
            if (stage.Kind === 'Characterart') {
                if (!Array.isArray(stage.Images) || stage.Images.length === 0) { continue; }
                var urls = stage.Images.map(function (entry) {
                    var first = Core.playniteFirstVersion(itemId);
                    return '/LogoArt/' + encodeURIComponent(itemId) + '/characterart/' + encodeURIComponent(entry.FileName) + '?v=' + encodeURIComponent(entry.Version) + (first ? '&first=' + encodeURIComponent(first) : '');
                });
                var caBox = createContainer(logo, result, 'Characterart');
                shouldHaveContainer = true;
                runningSig = resultSig;
                log('Showing Characterart in the slot,', urls.length, 'image(s) | MultiImage:', result.MultiImage, '| order:', result.OrderMode);
                runRotation(caBox, urls, result, myToken);
                return;
            }
            if (stage.Kind === 'Text') {
                if (!stage.FontFile || !stage.Text) { continue; }
                var textBox = createContainer(logo, result, 'Text');
                var textSwitching = outgoing.length > 0;
                if (textSwitching) { textBox.style.opacity = '0'; }
                if (await showText(textBox, stage, result, myToken)) {
                    shouldHaveContainer = true;
                    runningSig = resultSig;
                    if (textSwitching) { revealSwitchedBox(textBox, result.FadeTimeMs, myToken); }
                    log('Showing the name as text | font:', stage.FontFamily, '| size:', textBox.style.width || '25vw');
                    return;
                }
                removeContainers();
                continue;
            }
            if (!stage.Url) { continue; }
            try {
                await preloadImage(stage.Url);
            } catch (e) {
                log('Stage', stage.Kind, 'skipped - image failed to load');
                continue;
            }
            if (myToken !== runToken) { return; }
            var box = createContainer(logo, result, stage.Kind);
            var switching = outgoing.length > 0;
            if (switching) { box.style.opacity = '0'; }
            var img = document.createElement('img');
            img.src = stage.Url;
            box.appendChild(img);
            shouldHaveContainer = true;
            runningSig = resultSig;
            if (switching) { revealSwitchedBox(box, result.FadeTimeMs, myToken); }
            log('Showing', stage.Kind, 'from level', stage.Level, '| size:', (stage.Kind === 'Clearart' ? result.ClearartSizePercent : result.SizePercent) + '%');
            return;
        }
        log('No stage delivered an image - the slot stays empty');
    }

    // switching = Playnite Bridge's in-place version switch with a different answer: the drawn box
    // fades out instead of vanishing; every other call removes everything at once.
    function schedule(switching) {
        clearTimers();
        navTracker.clearTimers();
        runToken++;
        if (switching) {
            keepAsOutgoing();
            if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
        } else {
            outgoing = [];
            removeContainers(true);
        }
        contentReady = false;
        shouldHaveContainer = false;
        runningSig = null;
        Core.scheduleNavigationBurst(function () {
            if (contentReady || !isDetailsPage()) { return; }
            var batch = outgoing;
            start().then(function () { if (!shouldHaveContainer) { retireOutgoingAtRelease(batch); } });
        }, navTracker.track);
    }

    // Playnite Bridge's version switch stays on the same view (viewshow with detail.pbInPlace): the drawn box stays when
    // the new id gets the same answer (same files and URLs, e.g. Logo kept from the first version); anything else rebuilds.
    async function recheckInPlace() {
        var myToken = runToken;
        var itemId = getItemIdFromHash();
        var result = null;
        try {
            result = itemId ? await fetchResult(itemId) : null;
        } catch (e) {
            log('Error fetching', e);
        }
        if (myToken !== runToken) { return; }
        if (result && result.IsApplicable && runningSig === signatureOf(result)) {
            startedFor = { hash: location.hash, at: performance.now() };
            log('In-place version switch: same answer, box kept for', itemId);
            return;
        }
        schedule(true);
    }

    // On a hard reload the 1 200 ms cold-start timer below fires BEFORE
    // Jellyfin's first 'viewshow' (~200 ms later); a viewshow restarting the run
    // would mean two fetches per page load. A viewshow within the boot window
    // for the page a run already started on is the same navigation, not a new
    // one; hash changes, the poll and the heartbeat keep their unconditional
    // schedule().
    document.addEventListener('viewshow', function (e) {
        if (Core.isBootRaceRepeat(startedFor)) { return; }
        if (e.detail && e.detail.pbInPlace && runningSig) { recheckInPlace(); return; }
        schedule();
    });
    Core.watchForNavigation(function () { schedule(); });
    Core.startPresenceHeartbeat(
        function () { return !shouldHaveContainer || !!document.querySelector('.' + CONTAINER_CLASS); },
        function () { log('Presence heartbeat: container missing, recovering'); schedule(); }
    );
    track(setTimeout(function () {
        if (contentReady || !isDetailsPage()) { return; }
        start();
    }, 1200));
})();
