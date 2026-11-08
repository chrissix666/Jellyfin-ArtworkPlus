/*!
 * Backdrops - override of Jellyfin's native multi-backdrop rotation
 * ------------------------------------------------------
 * Unlike the file-matching features this one intervenes in existing native
 * behaviour. Seven independent IIFEs: Detail View, People, Genre, Studio,
 * Tag, Favorites and Library View.
 *
 * NATIVE MECHANISM, verified against components/backdrop/backdrop.js AND
 * src/controllers/itemDetails/index.js:
 *   - On detail pages native backdrop display is gated by detailsBanner(),
 *     NOT enableBackdrops() - itemDetails/index.js passes isBannerEnabled
 *     (driven by detailsBanner()) as setBackdrops()'s isEnabled argument,
 *     which short-circuits the enableBackdrops-driven check entirely.
 *     enableBackdrops() only matters for backdrops outside detail pages.
 *   - backdrop.js getItemImageUrls() only reads BackdropImageTags/
 *     ParentBackdropImageTags, with no fallback to a Person's Primary
 *     image - Person items have neither, so native shows nothing on a
 *     person page; an item without either simply clears our rotation too.
 *   - .backdropContainer/.backdropImage CSS is already loaded in the same
 *     bundle (backdrop.scss) - we use the same classes, so our version
 *     looks identical to native.
 *   - playbackManager is NOT globally reachable (unlike window.ApiClient) -
 *     pausing during video playback uses the video player page's
 *     viewbeforeshow/viewbeforehide events instead, the same events
 *     Jellyfin uses for its transparency handling.
 *
 * ARCHITECTURE: Jellyfin's own "Details Banner" setting is neither read nor
 * written. Jellyfin's native rotation keeps running in its own, unmodified
 * `.backdropContainer`; ours renders into a SEPARATE container (tagged
 * `.artworkplus-own-backdrop`) and covers the native one via a static CSS
 * rule (FileTransformationRegistrar.cs's BackdropsPrehidingStyleTag) keyed
 * off a `body` class. A static rule, present before any script runs, is
 * required because an external script is structurally guaranteed (DOM
 * event dispatch order, not a timing race) to run too late to intervene
 * before Jellyfin's own rotation decision for a navigation.
 */

// Shared by the IIFEs below: a person page -> media page transition
// crossfades instead of fading to black and in again. BackdropsPlus calls
// notifyIncomingReady() the moment its new image begins fading in; People
// Backdrops subscribes via onNextIncomingReady() when it starts waiting to
// fade its old image out, so both fades begin on about the same tick. Only
// the outgoing side needs the signal - the incoming side must load first anyway.
// Jellyfin version detection, shared by every IIFE below.
// isJellyfin12: the server version from ApiClient (the web client ships with the server); before ApiClient
// knows it, <html data-theme> is a 12.x-only hint (12.1 scripts/themeManager.js; 10.10.7 never sets it).
// isListRoute: the path part of a hash - '#/list.html' (10.10.7) and '#/list' (12.1, no '.html' routes).
var ArtworkPlusJfCompat = {
    isJellyfin12: function () {
        try {
            var v = window.ApiClient && typeof window.ApiClient.serverVersion === 'function' && window.ApiClient.serverVersion();
            if (v) { var n = String(v).split('.').map(Number); return n[0] > 10 || (n[0] === 10 && (n[1] || 0) >= 11); }
        } catch (e) { /* fall through */ }
        return document.documentElement.hasAttribute('data-theme');
    },
    isListRoute: function (pathPart) {
        return /^#\/?list(\.html)?$/.test(pathPart);
    }
};

var ArtworkPlusBackdropTransition = {
    _pending: [],
    notifyIncomingReady: function () {
        var pending = this._pending;
        this._pending = [];
        pending.forEach(function (fn) {
            try { fn(); } catch (e) { /* a listener's own error must never break the notifying side */ }
        });
    },
    onNextIncomingReady: function (fn) {
        this._pending.push(fn);
    }
};

(function () {
    'use strict';

    // Duplicate-load guard: see Core.claimSingleton()'s own doc comment.
    if (!window.ArtworkPlusCore.claimSingleton('Backdrops')) { return; }

    var Core = window.ArtworkPlusCore;
    var DEBUG = true;
    var log = Core.makeLogger('[Backdrops]', DEBUG);

    // This IIFE keeps only page detection, the settings fetch and the claim;
    // container, Ken Burns frame, layer rendering, rotation engine and the
    // release through the bus live in Core.createBackdropOwner(). The Ken
    // Burns constants are replicated from Aeon MQ7's HomeBG.
    var owner = Core.createBackdropOwner({
        name: 'detail',
        containerClass: 'artworkplus-own-backdrop',
        kenBurns: { zoomStart: 1.10, zoomEnd: 1.30, panPx: 15, easing: 'cubic-bezier(0.645, 0.045, 0.355, 1)' },
        preload: 'all',
        log: log
    });

    var getItemIdFromHash = Core.getItemIdFromHash;
    var isDetailsPage = Core.isDetailsPage;

    // No vanilla-setting gate: Jellyfin's own settings are neither read nor
    // written here, and Firefox is not excluded (vanilla's enableRotation()
    // skips Firefox on an old "causes high cpu usage" note). Vanilla's
    // container is hidden by the static prehiding CSS rule
    // (FileTransformationRegistrar.cs) keyed off the body class the bus
    // toggles while ours shows; the admin page shows a hint while the
    // vanilla setting is still on (its backdrops load unseen).

    function isVideoPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'video';
    }

    // Responsibility: every details page. Whether the item is a person is
    // only known once the server answered - so Detail View AND People both
    // claim a details page; the bus keeps the later claim and ignores an
    // "empty" from the owner that does not hold it (the server answers
    // "no images" to exactly one of the two).
    // Vanilla parity for the detail page - itemDetails/index.js
    // renderBackdrop() paints only when `!layoutManager.mobile &&
    // dom.getWindowSize().innerWidth >= 1000`, evaluated once when the item is
    // shown (no resize handler). layoutManager.mobile = the Display setting
    // "Layout" (appSettings key `layout`: 'mobile' | 'tv' | 'desktop' |
    // 'experimental' | '' = auto) or, on auto, browser.mobile from the user
    // agent (browser.js isMobile: mobi/ipad/iphone/ipod/silk/gt-p1000/
    // nexus 7/kindle fire/opera mini). Same check here, same moment (the
    // navigation), same absence of a resize reaction.
    // Jellyfin 12.1 (layoutManager.js setLayout) knows 'desktop', 'desktop-legacy',
    // 'mobile', 'mobile-legacy', 'tv', 'modern' and 'auto'; the base mode is the part before '-', 'modern'
    // and 'auto' fall to the user agent, and a stored 10.10.7 'experimental' is invalid there (= auto).
    var MOBILE_UA_TERMS = ['mobi', 'ipad', 'iphone', 'ipod', 'silk', 'gt-p1000', 'nexus 7', 'kindle fire', 'opera mini'];
    function vanillaWouldSkipDetailBackdrop() {
        var layout = '';
        try { layout = localStorage.getItem('layout') || ''; } catch (e) { /* storage blocked: treat as auto */ }
        var base = ArtworkPlusJfCompat.isJellyfin12() ? layout.split('-')[0] : layout;
        var mobile;
        if (base === 'mobile') { mobile = true; }
        // 'experimental' falls through to the user-agent test like auto: 10.10.7 layoutManager.js 35-38
        // sets mobile = browser.mobile for it; on 12.1 the value is invalid and Jellyfin uses auto,
        // i.e. the same test.
        else if (base === 'tv' || base === 'desktop') { mobile = false; }
        else {
            var ua = (navigator.userAgent || '').toLowerCase();
            mobile = MOBILE_UA_TERMS.some(function (term) { return ua.indexOf(term) !== -1; });
        }
        return mobile || window.innerWidth < 1000;
    }

    function isResponsibleFor() {
        if (!isDetailsPage()) { return false; }
        if (vanillaWouldSkipDetailBackdrop()) { return false; }
        return !!getItemIdFromHash();
    }

    var activeItemId = null;
    var fetchToken = 0;

    async function loadForCurrentItem() {
        var itemId = getItemIdFromHash();
        var myToken = ++fetchToken;
        var settings;
        try {
            // Through ApiClient like the pools, so the server knows the user - a set's
            // members are filtered by that user's parental control (a plain fetch is anonymous).
            var query = { itemId: itemId };
            var first = window.ArtworkPlusCore.playniteFirstVersion(itemId); // Playnite Bridge: the first-opened version goes along as ?first=
            if (first) { query.first = first; }
            settings = await window.ApiClient.getJSON(window.ApiClient.getUrl('Backdrops/settings', query));
        } catch (e) {
            log('The settings could not be loaded', e);
            if (myToken === fetchToken) { owner.empty(); }
            return;
        }
        if (myToken !== fetchToken) { return; }
        if (!settings || !settings.Enabled || !Array.isArray(settings.Images) || !settings.Images.length) {
            // Not enabled for this type, or nothing to show (incl. a person
            // page: the server answers with no images) - vanilla alternative.
            log('Nothing to show for this item (Enabled=' + (settings && settings.Enabled) + ', images=' + (settings && settings.Images ? settings.Images.length : 0) + ') - Jellyfin\'s own display stays untouched');
            owner.empty();
            return;
        }
        var resolvedUrls = settings.Images.map(function (u) { return u.charAt(0) === '/' ? (window.ApiClient && window.ApiClient.serverAddress ? window.ApiClient.serverAddress() : '') + u : u; });
        var effective = settings;
        if (settings.ImageSource === 'Episode' && settings.EpisodeOrderMode) {
            effective = Object.assign({}, settings, { OrderMode: settings.EpisodeOrderMode });
        }
        log('Detail View images from server | source:', settings.ImageSource, '| count:', resolvedUrls.length, '| order:', effective.OrderMode);
        owner.start(resolvedUrls, effective);
    }

    // --- navigation: claim/release synchronously on hashchange ---
    Core.onNavigation(function (hash, source) {
        if (isVideoPage()) {
            // Jellyfin hides every backdrop during playback; we pause and
            // keep our container for the return (Jellyfin re-renders the
            // detail page on its next viewshow, we do the same).
            owner.setPaused(true);
            return;
        }
        owner.setPaused(false);

        if (!isResponsibleFor()) {
            if (activeItemId !== null) {
                activeItemId = null;
                // A settings answer still on its way belongs to the page just left
                ++fetchToken;
                owner.release();
            }
            return;
        }
        var itemId = getItemIdFromHash();
        if (itemId === activeItemId) { return; } // same item (return from video, viewshow repeat)
        activeItemId = itemId;
        // Same owner, different item: crossfade inside our own container -
        // no release, just a new visit and a new claim.
        owner.claim('normal');
        owner.beginVisit();
        loadForCurrentItem();
    });

    // First load: Core.onNavigation arms the one boot dispatch for all owners.
})();


/*
 * ═══════════════════════════════════════════════════════════════════════
 * People Backdrops - a second, separate IIFE, deliberately NOT unified with
 * the code above. Both share dozens of identically named declarations
 * (DEBUG, FADE_MS, log, getBackdropContainer, ...) over very different
 * lifecycles (Detail View: one fetch per item via ApiClient.getItem;
 * People: visitId, per-visit AbortControllers and NDJSON streaming from a
 * server-populated cache). Separate closures keep either from overwriting
 * the other's state; the rendering and rotation mechanics are shared
 * through Core.createBackdropOwner(). Living in this file, People
 * Backdrops loads with the same automatic <script> tag
 * (FileTransformationRegistrar.cs).
 * ═══════════════════════════════════════════════════════════════════════
 */

/*!
 * People Backdrops - script
 * ------------------------------------------------------
 * Shows wallpapers from Wallpapers.com on Person detail pages and their
 * filmography list pages.
 *
 * ===================================================================
 * LIFECYCLE, verified against the Jellyfin 10.10.7 source (jellyfin-web's
 * viewManager.js/viewContainer.js/ViewManagerPage.tsx/itemDetails/index.js/
 * list.js/backdrop.js). One rule:
 *
 *   same person, different subpage  -> the slideshow is FROZEN solid
 *                                       (no restart, no new fetch, no
 *                                       new first image, no container
 *                                       rebuild - literally untouched)
 *   anything else (leave the person,
 *   a different person, re-entering
 *   the SAME person after a leave)  -> EVERYTHING is torn down and a
 *                                       fresh visit starts from zero
 *
 * A single incrementing `visitId` is the only source of truth for "is
 * this callback still relevant". Every async callback (fetch/stream
 * line/image load/fade) captures visitId when it starts and compares it
 * against the live value before doing anything visible - a mismatch
 * means a visit change happened since, and the callback does nothing.
 *
 * Facts from the Jellyfin source:
 *   - #/details (person's own page) and #/list.html (filmography) are
 *     two ENTIRELY DIFFERENT views/controllers in Jellyfin's router
 *     (LEGACY_USER_ROUTES: 'details'->itemDetails/index,
 *     'list.html'->list) - Jellyfin tears down/rebuilds its own
 *     .mainAnimatedPage between them. Our container is NOT inside that
 *     page - it is appended directly to document.body - so it is
 *     unaffected by Jellyfin's view churn between subpages. This is WHY
 *     the "same person, frozen slideshow" model works at all.
 *   - viewContainer.js keeps only a 3-slot view cache (pageContainerCount
 *     = 3) - normal (non-back-button) navigation ALWAYS calls
 *     loadView(), never tryRestoreView() (ViewManagerPage.tsx: `if
 *     (navigationType !== Action.Pop) { ...loadView... }`) - so a
 *     fresh 'viewshow' reliably fires on every real navigation,
 *     including a pure query-parameter change (personId A -> B on the
 *     same #/details path), since the underlying React useEffect
 *     depends on location.search too.
 *   - On the person's OWN page (never on #/list.html, which has no
 *     backdrop handling at all), itemDetails/index.js calls
 *     renderBackdrop() -> clearBackdrop() for every Person item - on
 *     forward navigation from reload()'s Promise.all([getPromise(...),
 *     apiClient.getCurrentUser()]).then(...), i.e. ASYNCHRONOUSLY, after
 *     Jellyfin's own network round-trip. clearBackdrop() sets
 *     hasInternalBackdrop=false, which (backdrop.js
 *     setBackgroundContainerBackgroundEnabled()) REMOVES '.withBackdrop'
 *     from .backgroundContainer whenever hasExternalBackdrop is also
 *     false - which it always is here, since Jellyfin's externalBackdrop()
 *     is not exported. If our image is already showing, that late call
 *     strips the class from under it; the backdrop bus in Core re-asserts
 *     '.withBackdrop' with a MutationObserver while one of ours shows.
 * ===================================================================
 */
(function () {
    'use strict';

    // Duplicate-load guard: see Core.claimSingleton()'s own doc comment.
    if (!window.ArtworkPlusCore.claimSingleton('PeopleBackdrops')) { return; }

    var Core = window.ArtworkPlusCore;
    var DEBUG = true;
    var log = Core.makeLogger('[PeopleBackdrops]', DEBUG);

    // This IIFE keeps page detection, the NDJSON stream (Header / Image... /
    // Done, images are added to the rotation as they arrive) and the claim.
    // Container, Ken Burns frame, layer rendering, rotation engine and
    // release-through-the-bus are Core.createBackdropOwner(). quietFrames:
    // the person page lays out heavily right after viewshow (poster decode,
    // long tasks) - the first fade-in waits for calm frames so it does not stutter.
    var owner = Core.createBackdropOwner({
        name: 'people',
        containerClass: 'artworkplus-people-backdrop',
        kenBurns: { zoomStart: 1.10, zoomEnd: 1.30, panPx: 15, easing: 'cubic-bezier(0.645, 0.045, 0.355, 1)' },
        preload: 'next',
        quietFrames: true, // Core default; kept explicit because this page needs it most
        log: log
    });

    // -----------------------------------------------------------------
    // Page detection - verified against list.js's own personId/type usage.
    //   #/details?id=<personId>                       -> scope "info"
    //   #/list.html?type=Movie|Series|Episode&personId -> scope movie|series|episode
    // Every details page is claimed (a movie id is only rejected by the
    // server: "not applicable"); the bus tolerates the double claim with
    // Detail View.
    // -----------------------------------------------------------------
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

    function isVideoPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'video';
    }

    // One "visit" = one person, across its info page and filmography lists
    // (same person, other scope = seamless continuation: the rotation keeps
    // running, the new scope's images are added). A different person or a
    // foreign page ends the visit.
    var visitId = 0;
    var activePersonId = null;
    var activeScope = null;
    var rotationStarted = false;
    var visitAbortControllers = new Set();
    var fetchInProgressKeys = new Set();
    var fetchedScopesThisVisit = new Set();

    function endVisit() {
        visitId++;
        visitAbortControllers.forEach(function (c) { try { c.abort(); } catch (e) { /* already done */ } });
        visitAbortControllers.clear();
        fetchInProgressKeys.clear();
        fetchedScopesThisVisit.clear();
        rotationStarted = false;
        activePersonId = null;
        activeScope = null;
    }

    async function fetchAndApplyForVisit(detected, myVisitId, isFreshVisit) {
        var key = detected.personId + '|' + detected.scope;
        if (fetchInProgressKeys.has(key)) { return; }
        fetchInProgressKeys.add(key);
        var controller = new AbortController();
        visitAbortControllers.add(controller);
        log('Detected', detected.personId, '| Scope:', detected.scope, '- fetching', isFreshVisit ? '(fresh visit)' : '(same-person subpage - seamless continuation)');

        var settings = null;
        var receivedAnyImage = false;

        function handleParsedLine(parsed) {
            if (parsed.Type === 'Header') {
                settings = parsed;
                if (isFreshVisit && parsed.IsApplicable && parsed.SourceMode === 'WallpapersCom') {
                    owner.claim('wallpapers'); // shorter handover window for the external stream
                }
                return;
            }
            if (parsed.Type !== 'Image' || !parsed.Url) { return; }
            if (!settings) { log('Protocol violation: Image line before the Header line, skipping', parsed.Url); return; }
            if (!receivedAnyImage) {
                receivedAnyImage = true;
                if (isFreshVisit || !rotationStarted) {
                    rotationStarted = true;
                    owner.start([parsed.Url], {
                        OrderMode: settings.OrderMode,
                        CycleTimeMs: settings.CycleTimeMs,
                        KenBurnsEnabled: settings.KenBurnsEnabled,
                        KenBurnsZoomMs: settings.KenBurnsZoomMs,
                        KenBurnsPanMs: settings.KenBurnsPanMs
                    });
                    return;
                }
            }
            owner.addImages([parsed.Url]);
        }

        try {
            var response = await fetch('/PeopleBackdrops/' + encodeURIComponent(detected.personId) + '?scope=' + detected.scope, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) {
                log('Server responded with HTTP', response.status, response.statusText, '- check the Jellyfin server log');
            }
            if (response.body && typeof response.body.getReader === 'function') {
                var reader = response.body.getReader();
                var decoder = new TextDecoder('utf-8');
                var buffer = '';
                while (true) {
                    var readResult = await reader.read();
                    if (readResult.done) { break; }
                    if (myVisitId !== visitId) { reader.cancel().catch(function () {}); return; }
                    buffer += decoder.decode(readResult.value, { stream: true });
                    var lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (!line) { continue; }
                        try { handleParsedLine(JSON.parse(line)); } catch (parseErr) { log('Bad NDJSON line, skipped:', line, parseErr); }
                    }
                }
                var finalLine = buffer.trim();
                if (finalLine) { try { handleParsedLine(JSON.parse(finalLine)); } catch (parseErr) { log('Bad final NDJSON line, skipped:', finalLine, parseErr); } }
            } else {
                var fullText = await response.text();
                fullText.split('\n').forEach(function (l) {
                    var t = l.trim();
                    if (!t) { return; }
                    try { handleParsedLine(JSON.parse(t)); } catch (parseErr) { log('Bad NDJSON line (fallback), skipped:', t, parseErr); }
                });
            }
        } catch (e) {
            if (myVisitId === visitId) { fetchInProgressKeys.delete(key); visitAbortControllers.delete(controller); }
            if (e && e.name === 'AbortError') { return; }
            log('Fetch or streaming failed for', key, e);
            if (myVisitId === visitId && isFreshVisit && !rotationStarted) { owner.empty(); }
            return;
        }
        if (myVisitId === visitId) { fetchInProgressKeys.delete(key); visitAbortControllers.delete(controller); }
        if (myVisitId !== visitId) { return; }

        fetchedScopesThisVisit.add(detected.scope);
        if (!settings || !settings.IsApplicable || !receivedAnyImage) {
            log('Not applicable for', key, '- reason:', (settings && settings.Reason) || '(none given)');
            if (isFreshVisit && !rotationStarted) { owner.empty(); }
            return;
        }
        log('People Backdrops shown for person', detected.personId, '| Scope:', detected.scope, '| Order:', settings.OrderMode, '| Cycle:', settings.CycleTimeMs + 'ms');
    }

    Core.onNavigation(function () {
        if (isVideoPage()) { owner.setPaused(true); return; }
        owner.setPaused(false);

        var detected = detectPersonAndScope();
        if (!detected) {
            if (activePersonId !== null) { endVisit(); owner.release(); }
            return;
        }
        if (activePersonId !== null && detected.personId === activePersonId) {
            // Same person, other scope (info <-> filmography): seamless continuation.
            if (detected.scope === activeScope) { return; }
            activeScope = detected.scope;
            if (fetchedScopesThisVisit.has(detected.scope)) { return; }
            fetchAndApplyForVisit(detected, visitId, false);
            return;
        }
        // Another person (or first person): new visit. A running rotation of
        // a previous person crossfades inside our own container -
        // no release, the next start() replaces it.
        endVisit();
        activePersonId = detected.personId;
        activeScope = detected.scope;
        owner.claim('normal');
        owner.beginVisit();
        fetchAndApplyForVisit(detected, visitId, true);
    });
    // First load: Core.onNavigation arms the one boot dispatch.
})();

// =======================================================================
// GENRE BACKDROPS - third, independent IIFE in this file. A self-contained
// IIFE has its own scope, so reusing names of the two IIFEs above (DEBUG,
// log, FADE_MS, getBackdropContainer, etc.) cannot collide.
//
// Scope: library-view pages only (Genre-filtered item lists), never
// detail pages - the exact opposite of the two IIFEs above. The shared
// Sequential/Shuffle/Random timing comes from Core
// (createBackdropRotationEngine() inside Core.createBackdropOwner()).
//
// Unlike People Backdrops there are no per-visit AbortControllers and no
// seamless subpage continuation; a fetch token discards stale answers.
// =======================================================================
(function () {
    'use strict';
    var Core = window.ArtworkPlusCore;
    var DEBUG = true;
    var log = Core.makeLogger('[ArtworkPlus GenreBackdrops]', DEBUG);

    // Only page detection, the pool fetch and the claim live here;
    // container, Ken Burns, rendering, rotation and the release through
    // the bus are Core.createBackdropOwner().
    var owner = Core.createBackdropOwner({
        name: 'genre',
        containerClass: 'artworkplus-genre-backdrop',
        kenBurns: { zoomStart: 1, zoomEnd: 1.12, panPx: 30, easing: 'ease-in-out' },
        preload: 'next',
        log: log
    });

    function poolUrls(entries) {
        return (entries || []).map(function (entry) {
            if (entry.Url) { return entry.Url; }
            return window.ApiClient.getScaledImageUrl(entry.SourceId, { type: 'Backdrop', tag: entry.Tag, maxWidth: window.innerWidth, index: entry.Index });
        });
    }

    function poolSettings(settings) {
        return {
            OrderMode: (settings.SortMode === 'Shuffle' || settings.SortMode === 'Random') ? settings.SortMode : 'Sequential',
            CycleTimeMs: settings.CycleTimeMs,
            KenBurnsEnabled: settings.KenBurnsEnabled,
            KenBurnsZoomMs: settings.KenBurnsZoomMs,
            KenBurnsPanMs: settings.KenBurnsPanMs
        };
    }

    function isVideoPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'video';
    }

    // #/list.html?genreId=X[&parentId=Y] - confirmed against list.js/tvgenres.js.
    function detect() {
        var hash = window.location.hash || '';
        var qIndex = hash.indexOf('?');
        if (qIndex === -1 || !ArtworkPlusJfCompat.isListRoute(hash.slice(0, qIndex))) { return null; }
        var params = new URLSearchParams(hash.slice(qIndex + 1));
        var genreId = params.get('genreId');
        if (!genreId) { return null; }
        var parentId = params.get('parentId') || null;
        return { key: genreId + '|' + (parentId || ''), genreId: genreId, parentId: parentId };
    }

    async function load(detected, myToken) {
        var poolParams = { genreId: detected.genreId };
        if (detected.parentId) { poolParams.parentId = detected.parentId; }
        var settings;
        try {
            settings = await window.ApiClient.getJSON(window.ApiClient.getUrl('Backdrops/genre-pool', poolParams));
        } catch (e) {
            log('Could not load genre pool', e);
            if (myToken === loadToken) { owner.empty(); }
            return;
        }
        if (myToken !== loadToken) { return; }
        var urls = settings.Enabled ? poolUrls(settings.Images) : [];
        if (!urls.length) { log('Genre Backdrops: not enabled or no images for this genre'); owner.empty(); return; }
        owner.start(urls, poolSettings(settings));
        log('Genre Backdrops shown | genreId:', detected.genreId, '| parentId:', detected.parentId, '| images:', urls.length, '| sort:', settings.SortMode);
    }

    var activeKey = null;
    var loadToken = 0;

    Core.onNavigation(function () {
        if (isVideoPage()) { owner.setPaused(true); return; }
        owner.setPaused(false);
        var detected = detect();
        if (!detected) {
            // Advance the token, so an answer still on its way for the page just left is discarded
            if (activeKey !== null) { activeKey = null; ++loadToken; owner.release(); }
            return;
        }
        if (detected.key === activeKey) { return; }
        activeKey = detected.key;
        owner.claim('normal');
        owner.beginVisit();
        load(detected, ++loadToken);
    });
    // First load: Core.onNavigation arms the one boot dispatch.
})();

// =======================================================================
// STUDIO BACKDROPS - fourth, independent IIFE. Much simpler than Genre:
// exactly one image per studio (metadata\Studio\<name>\landscape.jpg,
// confirmed against a real library), so no rotation engine at all - just
// Ken Burns zoom/pan on the single image, or a plain static show.
// =======================================================================
(function () {
    'use strict';
    var Core = window.ArtworkPlusCore;
    var DEBUG = true;
    var log = Core.makeLogger('[ArtworkPlus StudioBackdrops]', DEBUG);

    // Only page detection, the pool fetch and the claim live here;
    // container, Ken Burns, rendering, rotation and the release through
    // the bus are Core.createBackdropOwner().
    var owner = Core.createBackdropOwner({
        name: 'studio',
        containerClass: 'artworkplus-studio-backdrop',
        kenBurns: { zoomStart: 1, zoomEnd: 1.12, panPx: 30, easing: 'ease-in-out' },
        preload: 'next',
        log: log
    });

    function poolUrls(entries) {
        return (entries || []).map(function (entry) {
            if (entry.Url) { return entry.Url; }
            return window.ApiClient.getScaledImageUrl(entry.SourceId, { type: 'Backdrop', tag: entry.Tag, maxWidth: window.innerWidth, index: entry.Index });
        });
    }

    function poolSettings(settings) {
        return {
            OrderMode: (settings.SortMode === 'Shuffle' || settings.SortMode === 'Random') ? settings.SortMode : 'Sequential',
            CycleTimeMs: settings.CycleTimeMs,
            KenBurnsEnabled: settings.KenBurnsEnabled,
            KenBurnsZoomMs: settings.KenBurnsZoomMs,
            KenBurnsPanMs: settings.KenBurnsPanMs
        };
    }

    function isVideoPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'video';
    }

    // #/list.html?studioId=X[&parentId=Y] - confirmed against list.js.
    function detect() {
        var hash = window.location.hash || '';
        var qIndex = hash.indexOf('?');
        if (qIndex === -1 || !ArtworkPlusJfCompat.isListRoute(hash.slice(0, qIndex))) { return null; }
        var params = new URLSearchParams(hash.slice(qIndex + 1));
        var studioId = params.get('studioId');
        if (!studioId) { return null; }
        var parentId = params.get('parentId') || null;
        return { key: studioId + '|' + (parentId || ''), studioId: studioId, parentId: parentId };
    }

    async function load(detected, myToken) {
        var url = '/Backdrops/studio-settings?studioId=' + encodeURIComponent(detected.studioId);
        if (detected.parentId) { url += '&parentId=' + encodeURIComponent(detected.parentId); }
        var settings;
        try {
            settings = await fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); });
        } catch (e) {
            log('Could not load studio settings', e);
            if (myToken === loadToken) { owner.empty(); }
            return;
        }
        if (myToken !== loadToken) { return; }
        if (!settings.Enabled) { owner.empty(); return; }

        if (settings.SourceMode === 'Appearances' || settings.SourceMode === 'ResourceFolder') {
            // Backdrops of the studio's own titles - a pool like Genre/Tag -
            // or the images of the studio's resource folder.
            var poolParams = { studioId: detected.studioId };
            if (detected.parentId) { poolParams.parentId = detected.parentId; }
            var pool;
            try {
                pool = await window.ApiClient.getJSON(window.ApiClient.getUrl('Backdrops/studio-pool', poolParams));
            } catch (e) {
                log('Could not load studio pool', e);
                if (myToken === loadToken) { owner.empty(); }
                return;
            }
            if (myToken !== loadToken) { return; }
            var urls = pool.Enabled ? poolUrls(pool.Images) : [];
            if (!urls.length) { log('Studio Backdrops: no images (' + settings.SourceMode + ')'); owner.empty(); return; }
            owner.start(urls, poolSettings(pool));
            log('Studio Backdrops shown (' + settings.SourceMode + ') | studioId:', detected.studioId, '| images:', urls.length, '| sort:', pool.SortMode);
            return;
        }

        // Studio image: metadata\Studio\<name>\landscape.jpg - one static picture.
        if (!settings.HasImage) { log('Studio Backdrops: no Studio image for this studio'); owner.empty(); return; }
        var imageUrl = '/Backdrops/studio-image?studioId=' + encodeURIComponent(detected.studioId);
        owner.start([imageUrl], { OrderMode: 'Sequential', CycleTimeMs: 0, KenBurnsEnabled: settings.KenBurnsEnabled, KenBurnsZoomMs: settings.KenBurnsZoomMs, KenBurnsPanMs: settings.KenBurnsPanMs });
        log('Studio Backdrops shown | studioId:', detected.studioId);
    }

    var activeKey = null;
    var loadToken = 0;

    Core.onNavigation(function () {
        if (isVideoPage()) { owner.setPaused(true); return; }
        owner.setPaused(false);
        var detected = detect();
        if (!detected) {
            // Advance the token, so an answer still on its way for the page just left is discarded
            if (activeKey !== null) { activeKey = null; ++loadToken; owner.release(); }
            return;
        }
        if (detected.key === activeKey) { return; }
        activeKey = detected.key;
        owner.claim('normal');
        owner.beginVisit();
        load(detected, ++loadToken);
    });
    // First load: Core.onNavigation arms the one boot dispatch.
})();

// =======================================================================
// TAG BACKDROPS - fifth, independent IIFE. Structurally almost identical
// to Genre Backdrops (same rotation-engine reuse, same container/Ken
// Burns pattern), but only ONE variant exists - no parentId/CollectionType
// resolution, no subs. URL param is "tag" (the raw tag NAME, a string),
// confirmed against list.js's own resolution - not a Guid, unlike
// genreId/studioId.
// =======================================================================
(function () {
    'use strict';
    var Core = window.ArtworkPlusCore;
    var DEBUG = true;
    var log = Core.makeLogger('[ArtworkPlus TagBackdrops]', DEBUG);

    // Only page detection, the pool fetch and the claim live here;
    // container, Ken Burns, rendering, rotation and the release through
    // the bus are Core.createBackdropOwner().
    var owner = Core.createBackdropOwner({
        name: 'tag',
        containerClass: 'artworkplus-tag-backdrop',
        kenBurns: { zoomStart: 1, zoomEnd: 1.12, panPx: 30, easing: 'ease-in-out' },
        preload: 'next',
        log: log
    });

    function poolUrls(entries) {
        return (entries || []).map(function (entry) {
            if (entry.Url) { return entry.Url; }
            return window.ApiClient.getScaledImageUrl(entry.SourceId, { type: 'Backdrop', tag: entry.Tag, maxWidth: window.innerWidth, index: entry.Index });
        });
    }

    function poolSettings(settings) {
        return {
            OrderMode: (settings.SortMode === 'Shuffle' || settings.SortMode === 'Random') ? settings.SortMode : 'Sequential',
            CycleTimeMs: settings.CycleTimeMs,
            KenBurnsEnabled: settings.KenBurnsEnabled,
            KenBurnsZoomMs: settings.KenBurnsZoomMs,
            KenBurnsPanMs: settings.KenBurnsPanMs
        };
    }

    function isVideoPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'video';
    }

    // #/list.html?tag=<name> - the raw tag NAME (not a Guid), confirmed against list.js.
    function detect() {
        var hash = window.location.hash || '';
        var qIndex = hash.indexOf('?');
        if (qIndex === -1 || !ArtworkPlusJfCompat.isListRoute(hash.slice(0, qIndex))) { return null; }
        var params = new URLSearchParams(hash.slice(qIndex + 1));
        var tag = params.get('tag');
        if (!tag) { return null; }
        return { key: tag, tag: tag };
    }

    async function load(detected, myToken) {
        var settings;
        try {
            settings = await window.ApiClient.getJSON(window.ApiClient.getUrl('Backdrops/tag-pool', { tag: detected.tag }));
        } catch (e) {
            log('Could not load tag pool', e);
            if (myToken === loadToken) { owner.empty(); }
            return;
        }
        if (myToken !== loadToken) { return; }
        var urls = settings.Enabled ? poolUrls(settings.Images) : [];
        if (!urls.length) { log('Tag Backdrops: not enabled or no images for this tag'); owner.empty(); return; }
        owner.start(urls, poolSettings(settings));
        log('Tag Backdrops shown | tag:', detected.tag, '| images:', urls.length, '| sort:', settings.SortMode);
    }

    var activeKey = null;
    var loadToken = 0;

    Core.onNavigation(function () {
        if (isVideoPage()) { owner.setPaused(true); return; }
        owner.setPaused(false);
        var detected = detect();
        if (!detected) {
            // Advance the token, so an answer still on its way for the page just left is discarded
            if (activeKey !== null) { activeKey = null; ++loadToken; owner.release(); }
            return;
        }
        if (detected.key === activeKey) { return; }
        activeKey = detected.key;
        owner.claim('normal');
        owner.beginVisit();
        load(detected, ++loadToken);
    });
    // First load: Core.onNavigation arms the one boot dispatch.
})();

// =======================================================================
// FAVORITES BACKDROPS (generic) - sixth, independent IIFE. Covers ten of
// the eleven sections (everything except People, which has its own
// dedicated endpoint/logic reusing People Backdrops' cache). Same
// container/Ken Burns pattern as Genre/Tag. URL scheme confirmed against
// list.js's own query construction: list.html with IsFavorite=true and a
// type param (Movie/Series/Episode/Video/BoxSet/Playlist/MusicArtist/
// MusicAlbum/Audio/Book) - reached via each Favorites section's own "See
// All" link, not the scrollable rows on the Favorites home tab itself.
// =======================================================================
(function () {
    'use strict';
    var Core = window.ArtworkPlusCore;
    var DEBUG = true;
    var log = Core.makeLogger('[ArtworkPlus FavoritesBackdrops]', DEBUG);

    // Only page detection, the pool fetch and the claim live here;
    // container, Ken Burns, rendering, rotation and the release through
    // the bus are Core.createBackdropOwner().
    var owner = Core.createBackdropOwner({
        name: 'favorites',
        containerClass: 'artworkplus-favorites-backdrop',
        kenBurns: { zoomStart: 1, zoomEnd: 1.12, panPx: 30, easing: 'ease-in-out' },
        preload: 'next',
        log: log
    });

    function poolUrls(entries) {
        return (entries || []).map(function (entry) {
            if (entry.Url) { return entry.Url; }
            return window.ApiClient.getScaledImageUrl(entry.SourceId, { type: 'Backdrop', tag: entry.Tag, maxWidth: window.innerWidth, index: entry.Index });
        });
    }

    function poolSettings(settings) {
        return {
            OrderMode: (settings.SortMode === 'Shuffle' || settings.SortMode === 'Random') ? settings.SortMode : 'Sequential',
            CycleTimeMs: settings.CycleTimeMs,
            KenBurnsEnabled: settings.KenBurnsEnabled,
            KenBurnsZoomMs: settings.KenBurnsZoomMs,
            KenBurnsPanMs: settings.KenBurnsPanMs
        };
    }

    function isVideoPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'video';
    }

    // #/list.html?type=<T>&IsFavorite=true - the eleven "See All" lists of the
    // Favorites tab, confirmed against list.js's own query construction.
    var KNOWN_TYPES = ['Movie', 'Series', 'Episode', 'Video', 'BoxSet', 'Playlist', 'MusicArtist', 'MusicAlbum', 'Audio', 'Book'];
    function detect() {
        var hash = window.location.hash || '';
        var qIndex = hash.indexOf('?');
        if (qIndex === -1 || !ArtworkPlusJfCompat.isListRoute(hash.slice(0, qIndex))) { return null; }
        var params = new URLSearchParams(hash.slice(qIndex + 1));
        if (params.get('IsFavorite') !== 'true') { return null; }
        var type = params.get('type');
        if (!type || (KNOWN_TYPES.indexOf(type) === -1 && type !== 'Person')) { return null; }
        return { key: type, type: type };
    }

    // The section title Jellyfin shows in the header (LibraryMenu.setTitle ->
    // .pageTitle, already in the user's UI language). list.js sets it only
    // after its item fetch, so wait until the header changed from what it
    // showed at navigation - capped, a header that never changes (same word
    // as the previous page) is taken as is.
    var titleAtNavigation = '';
    function readPageTitle() {
        var el = document.querySelector('.skinHeader .pageTitle') || document.querySelector('.pageTitle');
        var t = el ? (el.textContent || '').trim() : '';
        // In 12.1's modern layout the legacy header sits in a hidden wrapper;
        // setTitle (scripts/libraryMenu.js) writes the same text to document.title as well.
        if (!t && ArtworkPlusJfCompat.isJellyfin12()) {
            var d = (document.title || '').trim();
            // 12.1 libraryMenu.js 727-775: the default document.title is the SERVER name.
            var server = '';
            try { server = (window.ApiClient && typeof window.ApiClient.serverName === 'function' && window.ApiClient.serverName()) || ''; } catch (e) { /* none */ }
            if (d && d !== 'Jellyfin' && d !== server) { t = d; }
        }
        return t;
    }
    async function waitForPageTitle(myToken) {
        var t0 = Date.now();
        while (Date.now() - t0 < 1500) {
            if (myToken !== loadToken) { return null; }
            var t = readPageTitle();
            if (t && t !== titleAtNavigation) { return t; }
            await new Promise(function (r) { setTimeout(r, 50); });
        }
        return readPageTitle();
    }

    async function load(detected, myToken) {
        var isPerson = detected.type === 'Person';
        var url = isPerson
            ? window.ApiClient.getUrl('Backdrops/favorites-people-pool')
            : window.ApiClient.getUrl('Backdrops/favorites-pool', { type: detected.type });
        var settings;
        try {
            settings = await window.ApiClient.getJSON(url);
            if (!isPerson && settings && settings.NeedsTitle) {
                var title = await waitForPageTitle(myToken);
                if (myToken !== loadToken) { return; }
                settings = await window.ApiClient.getJSON(window.ApiClient.getUrl('Backdrops/favorites-pool', { type: detected.type, title: title || '' }));
            }
        } catch (e) {
            log('Could not load favorites pool', e);
            if (myToken === loadToken) { owner.empty(); }
            return;
        }
        if (myToken !== loadToken) { return; }
        var urls;
        if (isPerson && (settings.SourceMode === 'WallpapersCom' || settings.SourceMode === 'Folder')) {
            urls = settings.WallpaperUrls || [];
            if (settings.SourceMode === 'WallpapersCom') { owner.claim('wallpapers'); } // shorter handover window for the external stream
        } else {
            urls = poolUrls(settings.Images);
        }
        if (!settings.Enabled || !urls.length) { log('Favorites Backdrops: not enabled or no images for', detected.type); owner.empty(); return; }
        owner.start(urls, poolSettings(settings));
        log('Favorites Backdrops shown | type:', detected.type, '| images:', urls.length, '| sort:', settings.SortMode);
    }

    var activeKey = null;
    var loadToken = 0;

    Core.onNavigation(function () {
        if (isVideoPage()) { owner.setPaused(true); return; }
        owner.setPaused(false);
        var detected = detect();
        if (!detected) {
            // Advance the token, so an answer still on its way for the page just left is discarded
            if (activeKey !== null) { activeKey = null; ++loadToken; owner.release(); }
            return;
        }
        if (detected.key === activeKey) { return; }
        activeKey = detected.key;
        titleAtNavigation = readPageTitle();
        owner.claim('normal');
        owner.beginVisit();
        load(detected, ++loadToken);
    });
    // First load: Core.onNavigation arms the one boot dispatch.
})();

// =======================================================================
// LIBRARY VIEW BACKDROPS - seventh, independent IIFE. The replica of
// Jellyfin's own random library backdrops (scripts/autoBackdrops.js:
// pages with the `backdropPage` class - Home incl. its Favourites tab,
// movies.html, tv.html, music.html - get 20 random items with a backdrop,
// rotated every 24 s while the user's "Backdrops" display setting is on).
// This category paints the same pages with its own pool (server:
// /Backdrops/library-pool, same query as vanilla), its own cycle time,
// order and Ken Burns, and additionally the pages vanilla never paints: a
// Collections library (set backdrops), search.html and the user settings
// pages (both the Home set). The pool is fetched per visit (vanilla
// caches its 20 until a reload - ours re-rolls; a visit is one page kind +
// library, tab switches inside Home/Movies/... are the same visit).
//
// Interplay: claim/beginVisit on the hash change like the other six, so
// the bus decides every handover the same way (OURS(x) -> OURS(library)
// crossfades, library -> a vanilla detail page fades out at once).
// Vanilla keeps rotating in its own hidden container while ours shows
// (nothing of vanilla's is touched); with vanilla's setting off,
// autoBackdrops calls clearBackdrop() on these pages, which removes
// .withBackdrop - the bus defends it. The Genre/Studio/Tag/Favorites/People
// list pages are NOT this category's: list.html?parentId= is claimed only
// without any of their parameters, and the server answers Enabled=false
// unless that parent is a boxsets library.
// =======================================================================
(function () {
    'use strict';
    var Core = window.ArtworkPlusCore;
    var DEBUG = true;
    var log = Core.makeLogger('[ArtworkPlus LibraryBackdrops]', DEBUG);

    var owner = Core.createBackdropOwner({
        name: 'library',
        containerClass: 'artworkplus-library-backdrop',
        kenBurns: { zoomStart: 1, zoomEnd: 1.12, panPx: 30, easing: 'ease-in-out' },
        preload: 'next',
        log: log
    });

    function poolUrls(entries) {
        return (entries || []).map(function (entry) {
            if (entry.Url) { return entry.Url; }
            return window.ApiClient.getScaledImageUrl(entry.SourceId, { type: 'Backdrop', tag: entry.Tag, maxWidth: window.innerWidth, index: entry.Index });
        });
    }

    function poolSettings(settings) {
        return {
            OrderMode: (settings.SortMode === 'Shuffle' || settings.SortMode === 'Random') ? settings.SortMode : 'Sequential',
            CycleTimeMs: settings.CycleTimeMs,
            KenBurnsEnabled: settings.KenBurnsEnabled,
            KenBurnsZoomMs: settings.KenBurnsZoomMs,
            KenBurnsPanMs: settings.KenBurnsPanMs
        };
    }

    function isVideoPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'video';
    }

    // Page kinds and their hashes, confirmed against jellyfin-web 10.10.7
    // apps/stable/routes (legacyRoutes/user.ts, asyncRoutes/user.ts) and
    // components/router/appRouter.js (a library folder routes to
    // movies.html/tv.html/music.html?topParentId=, every other folder to
    // list.html?parentId=; the search page is search.html).
    // Jellyfin 12.1 drops '.html' from every route, so names are kept without
    // it and the path is compared without it; its modern layout routes the folders that 10.10.7 sent to
    // list.html?parentId= to their own pages (?topParentId=) - those stay the collections page.
    var USER_SETTINGS_PAGES = ['mypreferencesmenu', 'mypreferencesdisplay', 'mypreferenceshome', 'mypreferencesplayback', 'mypreferencessubtitles', 'mypreferencescontrols', 'userprofile'];
    var FOLDER_PAGES_12 = ['boxsets', 'playlists', 'books', 'homevideos', 'musicvideos', 'mixed'];
    var LIST_PARAMS_OF_OTHER_OWNERS = ['genreId', 'studioId', 'tag', 'personId', 'IsFavorite', 'type'];

    function detect() {
        var hash = window.location.hash || '';
        var qIndex = hash.indexOf('?');
        var rawPath = (qIndex === -1 ? hash : hash.slice(0, qIndex)).replace(/^#\/?/, '');
        var path = rawPath.replace(/\.html$/, '');
        var params = new URLSearchParams(qIndex === -1 ? '' : hash.slice(qIndex + 1));
        if (path === '' || path === 'home') { return { key: 'home', page: 'home', parentId: null }; }
        if (path === 'search') { return { key: 'search', page: 'search', parentId: null }; }
        if (USER_SETTINGS_PAGES.indexOf(path) !== -1) { return { key: 'usersettings', page: 'usersettings', parentId: null }; }
        var topParentId = params.get('topParentId') || null;
        if (path === 'movies') { return { key: 'movies|' + (topParentId || ''), page: 'movies', parentId: topParentId }; }
        if (path === 'tv') { return { key: 'tv|' + (topParentId || ''), page: 'tv', parentId: topParentId }; }
        if (path === 'music') { return { key: 'music|' + (topParentId || ''), page: 'music', parentId: topParentId }; }
        // Only 12.1's suffix-less routes - 10.10.7's experimental layout has
        // #/homevideos.html (appRouter.js 437-438), which this category never claims there.
        if (FOLDER_PAGES_12.indexOf(path) !== -1 && topParentId && rawPath === path) {
            return { key: 'collections|' + topParentId, page: 'collections', parentId: topParentId };
        }
        if (path === 'list') {
            for (var i = 0; i < LIST_PARAMS_OF_OTHER_OWNERS.length; i++) {
                if (params.has(LIST_PARAMS_OF_OTHER_OWNERS[i])) { return null; }
            }
            var parentId = params.get('parentId');
            if (!parentId) { return null; }
            return { key: 'collections|' + parentId, page: 'collections', parentId: parentId };
        }
        return null;
    }

    async function load(detected, myToken) {
        var poolParams = { page: detected.page };
        if (detected.parentId) { poolParams.parentId = detected.parentId; }
        var settings;
        try {
            settings = await window.ApiClient.getJSON(window.ApiClient.getUrl('Backdrops/library-pool', poolParams));
        } catch (e) {
            log('Could not load library pool', e);
            if (myToken === loadToken) { owner.empty(); }
            return;
        }
        if (myToken !== loadToken) { return; }
        var urls = settings.Enabled ? poolUrls(settings.Images) : [];
        if (!urls.length) { log('Library View Backdrops: not enabled or no images for page', detected.page); owner.empty(); return; }
        owner.start(urls, poolSettings(settings));
        log('Library View Backdrops shown | page:', detected.page, '| parentId:', detected.parentId, '| images:', urls.length, '| order:', settings.SortMode);
    }

    var activeKey = null;
    var loadToken = 0;

    Core.onNavigation(function () {
        if (isVideoPage()) { owner.setPaused(true); return; }
        owner.setPaused(false);
        var detected = detect();
        if (!detected) {
            // Advance the token, so an answer still on its way for the page just left is discarded
            if (activeKey !== null) { activeKey = null; ++loadToken; owner.release(); }
            return;
        }
        if (detected.key === activeKey) { return; }
        activeKey = detected.key;
        owner.claim('normal');
        owner.beginVisit();
        load(detected, ++loadToken);
    });
    // First load: Core.onNavigation arms the one boot dispatch.
})();
