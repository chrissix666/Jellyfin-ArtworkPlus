/*!
 * ArtworkPlus - RenderArt (CharacterArt + RedCarpet, merged; LogoArt since Session 134)
 * ------------------------------------------------------
 * FILE-LEVEL CONSOLIDATION ONLY - explicit user requirement: nothing about
 * either feature's own behavior, its own admin-UI section, or its own
 * settings changes because of this merge. CharacterArt and RedCarpet were
 * never coordinating with each other in the first place (they target
 * entirely different page types - CharacterArt: movie/show detail pages;
 * RedCarpet: person detail pages + filmography lists - and never touch
 * the same element). Kept as TWO SEPARATE, independently-scoped IIFEs
 * below (the same pattern as ExtraPoster's detail/library split and People
 * Backdrops inside Backdrops-v1.js) so neither section's own local
 * variables can collide or shadow one another.
 *
 * SESSION 119 - THE CLEARLOGO REPLICA (user decision): both features now
 * position and size themselves EXACTLY like Jellyfin's own .detailLogo,
 * which is pure CSS (librarybrowser.scss: position:absolute; top:10vh;
 * right:25vw; width:25vw; height:16vh; background-size:contain). The
 * previous implementation measured the logo/poster/ribbon rectangles in
 * pixels and re-applied them after a resize debounce - that is why it
 * visibly "jumped" while the window was resized, and its poster anchor
 * (.detailImageContainer .card has max-height:80vh, so the poster grows
 * in fullscreen and its edge moves) is why the horizontal position
 * shifted in fullscreen and a "Fullscreen offset" had to compensate.
 * Now every positional value is CSS (vw/vh/em, Jellyfin's own units) in
 * ONE injected stylesheet (Core.ensureRenderArtStyles()) plus a few CSS
 * custom properties per box (Core.applyArtBoxSizing()). What stays in
 * JavaScript: fetching the endpoint, creating the elements, and the image
 * rotation (cycle/fade/delay/order/single pass) - plus one class toggle on
 * <body> for the Fullscreen offset (CSS :fullscreen cannot see F11).
 *
 * Anchors (unchanged in spirit, now CSS):
 *   - CharacterArt Top: the box's bottom edge sits on the ribbon line
 *     (.itemBackdrop bottom minus .detailRibbon's 7.2em), it grows upwards;
 *     TopLeft ends at the clearlogo's left edge (50vw), TopRight starts at
 *     its right edge (75vw); Offset (+ Fullscreen offset) shifts it.
 *   - CharacterArt Bottom and Red Carpet: position:fixed at the bottom of
 *     the viewport, 0.8vw from the side edge, shifted by Offset.
 *   - Hidden below 68.75em width exactly like the native clearlogo (top
 *     positions only - the bottom ones never mirrored the logo).
 *
 * Requires Jellyfin-ArtworkPlus-Core-v1.js to be loaded first (hard
 * dependency, unchanged for both sections).
 */

/*!
 * Characterart - positioning script
 * ------------------------------------------------------
 * Own endpoint (/Characterart/...), own placement on the page instead of
 * the poster slot (curriculum section E). Sizing is the admin's "window"
 * (ScaleMode Height/Width with the matching Max value) - the image fits
 * inside it with object-fit:contain, aligned by HorizontalAlign, exactly
 * as the clearlogo's background-size:contain fits its 25vw x 16vh box.
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
    // "This page should currently be showing a container" - set only at the
    // exact point start() commits to rendering; the presence heartbeat
    // below recovers a container that vanished (e.g. a view re-render).
    var shouldHaveContainer = false;

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

    function removeContainers() {
        document.querySelectorAll('.characterart-container, .characterart-anchor').forEach(function (el) { el.remove(); });
    }

    /// Builds the box (and, for the top positions, its zero-height anchor
    /// on the ribbon line). The top anchor is inserted directly BEFORE
    /// Jellyfin's own .detailLogo inside the detail page - the same
    /// containing block as the clearlogo (the page is position:absolute),
    /// so it scrolls away with the page exactly like the logo, and it
    /// stays BEHIND the logo in the stacking order (DOM order, z-index 0 -
    /// the source-confirmed three-layer stacking investigation of the
    /// old implementation still applies). The bottom positions go to
    /// <body> as position:fixed, like .skinHeader.
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
        log('Starting for item', itemId);

        var result;
        try {
            result = await fetch('/Characterart/' + encodeURIComponent(itemId), { cache: 'no-store' }).then(function (r) { return r.json(); });
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
                + '?v=' + encodeURIComponent(entry.Version);
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
        // overlapping images after the tab was backgrounded otherwise.
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

            if (!sizingApplied) {
                // Once per rotation, like the old applyLayout(): the first
                // image's aspect ratio only matters when a Max value is 0.
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
                });
            });
            visibleIndex = nextLayerIndex;
            slideIndex++;

            var isSingleImageThatShouldStillEnd = imageUrls.length === 1 && result.SinglePass && !result.StaySingleImageStatic;
            if ((result.MultiImage && imageUrls.length > 1) || isSingleImageThatShouldStillEnd) {
                track(setTimeout(showNext, result.CycleTimeMs));
            }
        }

        var delayMs = result.DelayEnabled ? result.DelayMs : 0;
        await new Promise(function (resolve) { track(setTimeout(resolve, delayMs)); });
        if (myToken !== runToken) { return; }
        log('Showing Characterart, position:', result.Position, '| MultiImage:', result.MultiImage, '|', imageUrls.length, 'image(s)');
        shouldHaveContainer = true;
        showNext();
    }

    function schedule() {
        clearTimers();
        navTracker.clearTimers();
        runToken++;
        removeContainers();
        contentReady = false;
        shouldHaveContainer = false;
        Core.scheduleNavigationBurst(function () {
            if (contentReady || !isDetailsPage()) { return; }
            start();
        }, navTracker.track);
    }

    document.addEventListener('viewshow', function () { schedule(); });
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
 * (duration hardcoded, curriculum H). Since Session 119 the box is pure
 * CSS (see the file header) - no resize/fullscreen listeners any more.
 *
 * Two recognized page types (curriculum H):
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
    var currentPersonId = null;

    function preloadImage(url) {
        return Core.preloadImage(url, { resolveWith: 'image', timeoutMs: PRELOAD_TIMEOUT_MS });
    }

    function detectPersonAndScope() {
        var hash = location.hash || '';
        var qIndex = hash.indexOf('?');
        var path = hash.split('?')[0].replace(/^#\/?/, '');
        var params = qIndex === -1 ? new URLSearchParams() : new URLSearchParams(hash.slice(qIndex + 1));

        if (path === 'details') {
            var id = params.get('id');
            return id ? { personId: id, scope: 'info' } : null;
        }

        if (path === 'list.html') {
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

    document.addEventListener('viewshow', schedule);
    Core.watchForNavigation(schedule);
    track(setTimeout(function () {
        if (contentReady) { return; }
        start();
    }, 1200));
})();

/*!
 * LogoArt - the logo slot of detail pages (Session 134)
 * ------------------------------------------------------
 * Concept: docs/artworkplus-logoart-concept.md. The server
 * (/LogoArt/{itemId}) resolves everything - item type, inheritance levels,
 * Source mode, the stage chain, Characterart files, the person's font -
 * and this section only preloads and shows: the first stage whose image
 * loads wins, there is no live switching between sources (only the
 * Characterart stage's own rotation).
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
 * Persons (concept Part D): the same chain shape with FolderLogo (a file
 * in the person folder, served by /LogoArt/person/{id}/image) and Text
 * (the name rendered live in a bundled font from /LogoArt/font/..., fitted
 * into the box by a binary search on the font size, re-fitted on resize).
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
    var shouldHaveContainer = false;
    var resizeHandler = null;

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

    function removeContainers() {
        document.querySelectorAll('.' + CONTAINER_CLASS).forEach(function (el) { el.remove(); });
        if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
    }

    /// One box per page, right after .detailLogo (same containing block as
    /// the clearlogo). Geometry class per stage kind: the vanilla slot for
    /// VanillaLogo / FolderLogo / Text, the floor (ribbon line) for
    /// Clearart / Characterart. Size/Offset/Vertical offset are custom
    /// properties for the stylesheet - shared by every stage, so a
    /// fallback never moves anything.
    function createContainer(logo, result, kind) {
        removeContainers();
        var box = document.createElement('div');
        box.className = CONTAINER_CLASS + ' ' + (FLOOR_KINDS[kind] ? 'logoart-floor ' + FLOOR_KINDS[kind] : 'logoart-slot') + ' logoart-kind-' + kind.toLowerCase();
        box.style.setProperty('--la-size', String((result.SizePercent > 0 ? result.SizePercent : 100) / 100));
        box.style.setProperty('--la-offset', (result.OffsetVw || 0) + 'vw');
        box.style.setProperty('--la-voffset', (result.VerticalOffsetVh || 0) + 'vh');
        logo.parentNode.insertBefore(box, logo.nextSibling);
        return box;
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
    /// Characterart tab, user decision 2026-09-21).
    function runRotation(container, imageUrls, result, myToken) {
        var layers = [createImageLayer(container, result.FadeTimeMs), createImageLayer(container, result.FadeTimeMs)];
        var visibleIndex = -1;
        var slideIndex = 0;
        var consecutiveFailures = 0;
        var fadeInGeneration = 0;

        async function showNext() {
            if (myToken !== runToken || !document.body.contains(container)) { return; }
            if (result.SinglePass && slideIndex >= imageUrls.length) {
                var visibleLayer = visibleIndex === -1 ? null : layers[visibleIndex];
                if (visibleLayer) { visibleLayer.style.opacity = '0'; }
                log('Characterart stage: single pass complete');
                return;
            }
            var url = imageUrls[slideIndex % imageUrls.length];
            try {
                await preloadImage(url);
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
            var nextLayerIndex = visibleIndex === 0 ? 1 : 0;
            var nextLayer = layers[nextLayerIndex];
            var prevLayer = visibleIndex === -1 ? null : layers[visibleIndex];
            var myGeneration = ++fadeInGeneration;
            nextLayer.src = url;
            nextLayer.style.zIndex = '2';
            nextLayer.style.opacity = '0';
            void nextLayer.offsetWidth;
            if (prevLayer) { prevLayer.style.zIndex = '1'; prevLayer.style.opacity = '0'; }
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    if (myToken !== runToken || myGeneration !== fadeInGeneration) { return; }
                    nextLayer.style.opacity = '1';
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

        var result;
        try {
            result = await fetch('/LogoArt/' + encodeURIComponent(itemId), { cache: 'no-store' }).then(function (r) { return r.json(); });
        } catch (e) {
            log('Error fetching', e);
            return;
        }
        if (myToken !== runToken) { return; }
        if (!result.IsApplicable) { log('Not applicable for', itemId); return; }

        var logo = await waitFor(findLogo);
        if (myToken !== runToken) { return; }
        if (!logo) { log('No .detailLogo element on this page'); return; }

        if (result.ZeroIntervention) {
            logo.classList.add(RELEASE_CLASS);
            log('Zero intervention for', result.ItemType, '- vanilla logo released');
            return;
        }
        logo.classList.remove(RELEASE_CLASS);

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
                    return '/LogoArt/' + encodeURIComponent(itemId) + '/characterart/' + encodeURIComponent(entry.FileName) + '?v=' + encodeURIComponent(entry.Version);
                });
                var caBox = createContainer(logo, result, 'Characterart');
                shouldHaveContainer = true;
                log('Showing Characterart in the slot,', urls.length, 'image(s) | MultiImage:', result.MultiImage, '| order:', result.OrderMode);
                runRotation(caBox, urls, result, myToken);
                return;
            }
            if (stage.Kind === 'Text') {
                if (!stage.FontFile || !stage.Text) { continue; }
                var textBox = createContainer(logo, result, 'Text');
                if (await showText(textBox, stage, result, myToken)) {
                    shouldHaveContainer = true;
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
            var img = document.createElement('img');
            img.src = stage.Url;
            box.appendChild(img);
            shouldHaveContainer = true;
            log('Showing', stage.Kind, 'from level', stage.Level, '| size:', result.SizePercent + '%', '| offset:', result.OffsetVw, '/', result.VerticalOffsetVh);
            return;
        }
        log('No stage delivered an image - the slot stays empty');
    }

    function schedule() {
        clearTimers();
        navTracker.clearTimers();
        runToken++;
        removeContainers();
        contentReady = false;
        shouldHaveContainer = false;
        Core.scheduleNavigationBurst(function () {
            if (contentReady || !isDetailsPage()) { return; }
            start();
        }, navTracker.track);
    }

    document.addEventListener('viewshow', function () { schedule(); });
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
