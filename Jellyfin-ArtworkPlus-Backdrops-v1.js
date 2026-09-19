/*!
 * Backdrops - override of Jellyfin's native multi-backdrop rotation
 * ------------------------------------------------------
 * A fundamentally different kind of feature than the other five feature
 * blocks (curriculum section G) - no file matching, but an intervention in
 * existing native behavior.
 *
 * IMPORTANT, HONESTLY DOCUMENTED SCOPE NOTE: this first version only
 * covers movie/series detail pages (where we reliably know, via the
 * itemId in the URL, which item is currently being viewed, and can fetch
 * its BackdropImageTags directly via the API). Person detail pages are
 * NOT a separate scope concern here - CORRECTED after this comment
 * previously, wrongly, listed "person" as covered: directly confirmed
 * against backdrop.js's own getItemImageUrls() that it only ever reads
 * BackdropImageTags/ParentBackdropImageTags, with no fallback to a
 * Person's own Primary image - Person items have neither, so Jellyfin's
 * own native renderBackdrop() never displays anything there either,
 * regardless of the Details Banner setting. This project's own
 * loadBackdropsForCurrentItem() already handles this correctly and
 * automatically (an item with no BackdropImageTags/ParentBackdropImageTags
 * simply clears this project's own rotation, showing nothing - the exact
 * same real-world outcome as native, with no special-casing needed). The
 * home screen and library
 * grids draw their backdrops from changing, randomly selected items across
 * many different, separate controller pieces of logic (not a single
 * central spot) - fully replicating that would mean rebuilding each of
 * these pieces of logic individually. That is NOT part of this first
 * version, but a deliberate limit recorded in the curriculum for later.
 *
 * NATIVE MECHANISM, verified against components/backdrop/backdrop.js AND
 * src/controllers/itemDetails/index.js:
 *   - On detail pages specifically (the only scope this feature ever
 *     covers), native backdrop display is gated by detailsBanner(), NOT
 *     enableBackdrops() - itemDetails/index.js passes isBannerEnabled
 *     (driven by detailsBanner()) as setBackdrops()'s isEnabled argument,
 *     which short-circuits the enableBackdrops-driven check entirely.
 *     enableBackdrops() only matters for backdrops OUTSIDE detail pages
 *     (library-browsing views), a scope this feature deliberately
 *     doesn't touch (see the scope note above).
 *   - .backdropContainer/.backdropImage CSS is already loaded in the same
 *     bundle (backdrop.scss) - we use the same classes, so our version
 *     looks visually 1:1 identical to native
 *   - playbackManager is NOT globally reachable (unlike
 *     window.ApiClient) - the "pause during video playback" requirement is
 *     instead covered via the same viewbeforeshow/viewbeforehide events of
 *     the video player page that are also natively used for the
 *     transparency requirement (see curriculum G, point 6) - pragmatically
 *     close enough to the actual goal, without relying on an unreachable
 *     internal API.
 *
 * ARCHITECTURE, REWRITTEN after a direct user request to stop
 * manipulating Jellyfin's own "Details Banner" setting entirely (full
 * reasoning + source citations in resolveOverrideState()'s own doc
 * comment below): this project no longer writes detailsBanner at all,
 * under any circumstance. Session 130: it no longer READS it either, and
 * the Firefox exclusion is gone - see the note inside the IIFE. Jellyfin's own native backdrop rotation keeps
 * running normally, in its own, unmodified `.backdropContainer` element -
 * this project's own version renders into a SEPARATE container (tagged
 * `.artworkplus-own-backdrop`) and covers Jellyfin's own one via a static
 * CSS rule (FileTransformationRegistrar.cs's own BackdropsPrehidingStyleTag)
 * keyed off a `body` class this project toggles based on its own settings/
 * browser/detailsBanner checks - the same "static CSS rule, present before
 * any script runs" principle already used for posterEl's own FOOC-
 * prehiding, chosen specifically because this project's own JavaScript is
 * structurally guaranteed (a DOM event dispatch-order fact, not a timing
 * race) to always run too late to intervene before Jellyfin's own native
 * rotation decision for a given navigation.
 */

// Shared between this file's two otherwise-independent IIFEs (BackdropsPlus
// below, People Backdrops further down) - explicit user request: make a
// person-page-to-media-page transition crossfade smoothly instead of
// "fade to black, then fade in" (the natural consequence of two unrelated
// scripts each running their own, uncoordinated timing). Only meaningful
// on the OUTGOING (People's own fade-out) side - the incoming side always
// needs its own load first regardless, so there's nothing to signal any
// earlier than "the image actually finished loading and is about to
// start its own fade-in", which is exactly what this notifies. A single
// shared pub/sub: BackdropsPlus calls notifyIncomingReady() at the exact
// moment its own new image begins fading in; People Backdrops subscribes
// via onNextIncomingReady() right when it starts waiting to fade its own
// old image out, so both fades begin on (approximately) the same tick.
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

    // Session 120 (concept Part R): this IIFE keeps only page detection,
    // the settings fetch and the claim; container, Ken Burns frame, layer
    // rendering, rotation engine and the release-through-the-bus live in
    // Core.createBackdropOwner(). The Ken Burns constants below are the
    // ones this feature always had (replicated from Aeon MQ7's HomeBG).
    var owner = Core.createBackdropOwner({
        name: 'detail',
        containerClass: 'artworkplus-own-backdrop',
        kenBurns: { zoomStart: 1.10, zoomEnd: 1.30, panPx: 15, easing: 'cubic-bezier(0.645, 0.045, 0.355, 1)' },
        preload: 'all',
        log: log
    });

    var getItemIdFromHash = Core.getItemIdFromHash;
    var isDetailsPage = Core.isDetailsPage;

    // -----------------------------------------------------------------
    // Session 130: no vanilla-setting gate any more. Detail View used to
    // require Jellyfin's own "Details Banner" setting to be on and to stay
    // off on Firefox (vanilla's enableRotation() skips Firefox with a
    // 2016-era "causes high cpu usage" comment that nobody re-measured).
    // Both are gone: the user decides in the admin page, vanilla's own
    // settings are neither read nor written here. Vanilla's container is
    // hidden by the static prehiding CSS rule
    // (FileTransformationRegistrar.cs) keyed off the body class the bus
    // toggles while ours shows; the admin page shows an amber hint while
    // the vanilla setting is still on (its backdrops load unseen).
    // -----------------------------------------------------------------

    function isVideoPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'video';
    }

    // Responsibility (Part R2): every details page. Whether the item is a
    // person is only known once the server answered - so Detail View AND
    // People both claim a details page; the bus keeps the later claim and
    // ignores an "empty" from the owner that does not hold it (the server
    // answers "no images" to exactly one of the two).
    function isResponsibleFor() {
        if (!isDetailsPage()) { return false; }
        return !!getItemIdFromHash();
    }

    var activeItemId = null;
    var fetchToken = 0;

    async function loadForCurrentItem() {
        var itemId = getItemIdFromHash();
        var myToken = ++fetchToken;
        var settings;
        try {
            settings = await fetch('/Backdrops/settings?itemId=' + encodeURIComponent(itemId), { cache: 'no-store' }).then(function (r) { return r.json(); });
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

    // --- navigation (Part R3): claim/release synchronously on hashchange ---
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
                owner.release();
            }
            return;
        }
        var itemId = getItemIdFromHash();
        if (itemId === activeItemId) { return; } // same item (return from video, viewshow repeat)
        activeItemId = itemId;
        // Same owner, different item: crossfade inside our own container
        // (rule R3-5) - no release, just a new visit and a new claim.
        owner.claim('normal');
        owner.beginVisit();
        loadForCurrentItem();
    });

    // First load: the hash is already there, nothing will "change".
    setTimeout(Core.dispatchNavigationNow, 1200);
})();


/* ═══════════════════════════════════════════════════════════════════════
 * People Backdrops - merged into this file per explicit user request
 * ("People Backdrops soll in dieselbe Datei wie BackdropsPlus wandern").
 *
 * DELIBERATELY NOT UNIFIED WITH THE CODE ABOVE - explicit user warning
 * heeded: "die Architektur ist sehr unterschiedlich. musst sie schon noch
 * etwas getrennt halten im code." Confirmed before merging: the two files
 * share dozens of identically-named top-level declarations (DEBUG,
 * FADE_MS, log, getBackdropContainer, rotationEngine, clearOwnRotation,
 * startOwnRotation, and more) - a real, structural difference between
 * their own lifecycles (BackdropsPlus: a simple per-item single fetch via
 * window.ApiClient.getItem, no caching/population concept at all. People
 * Backdrops: the full visitId/AbortController-Set/NDJSON-streaming-from-a-
 * server-populated-cache lifecycle, extensively documented in this
 * project's own curriculum). Merging their VARIABLES/FUNCTIONS into one
 * shared scope would silently overwrite one feature's own state with the
 * other's on every load - completely unrelated to whether the underlying
 * ROTATION mechanics happen to be shared (they already are, via Core.js's
 * own createBackdropRotationEngine() factory - see that function's own
 * doc comment for why one instance per feature, not shared globally, is
 * itself already the correct pattern this project follows).
 *
 * The fix: this file's own top IIFE (BackdropsPlus, unchanged, not a
 * single line touched) and this second IIFE (People Backdrops, unchanged,
 * not a single line touched) are two COMPLETELY SEPARATE, self-contained
 * closures - exactly as before, when they were two separate files. Only
 * the FILE they live in changed, not the code, not the scoping, not the
 * runtime behavior. Each keeps 100% of its own architecture, own
 * variable names, own event listeners (registering two independent
 * 'viewshow' listeners on `document` is completely normal - unrelated to
 * variable scoping, and was already true even when these were two
 * separate <script> tags/files).
 *
 * PRACTICAL BENEFIT of the merge, not just organizational tidiness:
 * BackdropsPlus already has its own automatic <script src="/Backdrops/
 * script.js"> tag (FileTransformationRegistrar.cs) - People Backdrops
 * never had an equivalent automatic tag of its own and had to be pasted
 * into the JavaScript Injector manually. After this merge, loading
 * People Backdrops automatically comes for free as part of BackdropsPlus's
 * own existing script tag - one fewer manual step for the user, without
 * any code change to accomplish it.
 * ═══════════════════════════════════════════════════════════════════════ */

/*!
 * People Backdrops - script
 * ------------------------------------------------------
 * The sixth, fully independent feature. Shows wallpapers from
 * Wallpapers.com on Person detail pages and their filmography list pages.
 *
 * ===================================================================
 * LIFECYCLE ARCHITECTURE (rewritten from scratch against the real
 * Jellyfin 10.10.7 source - jellyfin-web's viewManager.js/
 * viewContainer.js/ViewManagerPage.tsx/itemDetails/index.js/list.js/
 * backdrop.js - not assumptions. Replaces an earlier version built
 * from several separate, incrementally-added guards (runToken,
 * renderGeneration, inFlightPersonKeys, retryIfStillRelevant) that
 * kept needing new patches for new edge cases. This version has
 * exactly ONE rule instead:
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
 * A single incrementing `visitId` is the one and only source of
 * truth for "is this callback still relevant" - it replaces the
 * previous separate runToken (stream staleness) and renderGeneration
 * (render staleness) counters, since both were really asking the
 * exact same question. Every async callback (fetch/stream line/image
 * load/fade) captures visitId at the moment it starts and compares it
 * against the live value before doing anything visible - a mismatch
 * means "a real visit change happened since I started" and the
 * callback quietly does nothing, logging STALE_VISIT_IGNORED.
 *
 * Real facts verified directly against the uploaded Jellyfin source
 * before writing this (not assumed):
 *   - #/details (person's own page) and #/list.html (filmography) are
 *     two ENTIRELY DIFFERENT views/controllers in Jellyfin's own
 *     router (LEGACY_USER_ROUTES: 'details'->itemDetails/index,
 *     'list.html'->list) - Jellyfin itself tears down/rebuilds its
 *     own .mainAnimatedPage between them. This feature's own
 *     container is deliberately NOT inside that page - it's appended
 *     directly to document.body (see getBackdropContainer() below) -
 *     so it is completely unaffected by Jellyfin's own view churn
 *     between subpages. This is WHY the "same person, frozen
 *     slideshow" model can work at all: our own DOM lives outside the
 *     part of the page Jellyfin itself replaces.
 *   - viewContainer.js keeps only a 3-slot view cache (pageContainerCount
 *     = 3) - normal (non-back-button) navigation ALWAYS calls
 *     loadView(), never tryRestoreView() (ViewManagerPage.tsx: `if
 *     (navigationType !== Action.Pop) { ...loadView... }`) - so a
 *     fresh 'viewshow' reliably fires on every real navigation,
 *     including a pure query-parameter change (personId A -> B on the
 *     same #/details path), since the underlying React useEffect
 *     depends on location.search too.
 *   - CRITICAL, directly explains the previously-reported "old image
 *     briefly flashes" symptom: on the person's OWN page specifically
 *     (never on #/list.html, which has no backdrop handling of its
 *     own at all), Jellyfin's itemDetails/index.js calls its own
 *     renderBackdrop() -> clearBackdrop() for every Person item (Person
 *     items have no BackdropImageTags, confirmed via backdrop.js's own
 *     getItemImageUrls()) - and on ordinary forward navigation this
 *     runs from reload()'s own Promise.all([getPromise(...),
 *     apiClient.getCurrentUser()]).then(...), i.e. ASYNCHRONOUSLY,
 *     after Jellyfin's own network round-trip - not synchronously
 *     during 'viewshow'. clearBackdrop() sets Jellyfin's own internal
 *     hasInternalBackdrop=false, which (backdrop.js's own
 *     setBackgroundContainerBackgroundEnabled()) REMOVES the
 *     '.withBackdrop' class from .backgroundContainer whenever its own
 *     hasExternalBackdrop is also false - which it always is here,
 *     since this feature sets the class directly rather than through
 *     Jellyfin's own (non-exported, inaccessible from an external
 *     script) externalBackdrop() API. Net effect: a real race - if
 *     THIS feature's own (often near-instant, since same-person
 *     subpage changes need no new fetch at all) image render finishes
 *     BEFORE Jellyfin's own delayed clearBackdrop() call, Jellyfin's
 *     own call runs SECOND and silently un-sets '.withBackdrop' out
 *     from under an already-correctly-showing image - not a bug in
 *     this feature's own state at all, an external actor overwriting
 *     a CSS class we don't exclusively own. Defended against below via
 *     a small MutationObserver that re-asserts '.withBackdrop'
 *     whenever it's removed while this feature still has a valid
 *     image on screen - see defendWithBackdropClass()'s own doc
 *     comment further down for the full mechanism.
 * ===================================================================
 */
(function () {
    'use strict';

    // Duplicate-load guard: see Core.claimSingleton()'s own doc comment.
    if (!window.ArtworkPlusCore.claimSingleton('PeopleBackdrops')) { return; }

    var Core = window.ArtworkPlusCore;
    var DEBUG = true;
    var log = Core.makeLogger('[PeopleBackdrops]', DEBUG);

    // Session 120 (concept Part R): this IIFE keeps page detection, the
    // NDJSON stream (Header / Image... / Done, images are added to the
    // rotation as they arrive) and the claim. Container, Ken Burns frame,
    // layer rendering, rotation engine and release-through-the-bus are
    // Core.createBackdropOwner(). quietFrames: the person page lays out
    // heavily right after viewshow (poster decode, long tasks) - the first
    // fade-in waits for calm frames so it does not stutter.
    var owner = Core.createBackdropOwner({
        name: 'people',
        containerClass: 'artworkplus-people-backdrop',
        kenBurns: { zoomStart: 1.10, zoomEnd: 1.30, panPx: 15, easing: 'cubic-bezier(0.645, 0.045, 0.355, 1)' },
        preload: 'next',
        quietFrames: true,
        log: log
    });

    // -----------------------------------------------------------------
    // Page detection - verified against list.js's own personId/type usage.
    //   #/details?id=<personId>                       -> scope "info"
    //   #/list.html?type=Movie|Series|Episode&personId -> scope movie|series|episode
    // Every details page is claimed (a movie id is only rejected by the
    // server: "not applicable"); the bus tolerates the double claim with
    // Detail View - see Part R3.
    // -----------------------------------------------------------------
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
                    owner.claim('wallpapers'); // Part R3: shorter handover window for the external stream
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
        // a previous person crossfades inside our own container (R3-5) -
        // no release, the next start() replaces it.
        endVisit();
        activePersonId = detected.personId;
        activeScope = detected.scope;
        owner.claim('normal');
        owner.beginVisit();
        fetchAndApplyForVisit(detected, visitId, true);
    });
    setTimeout(Core.dispatchNavigationNow, 1200);
})();

// =======================================================================
// GENRE BACKDROPS - third, independent IIFE in this file. Same reasoning
// as People Backdrops' own merge (see this file's header comment and the
// curriculum's "People Backdrops merged into BackdropsPlus.js" milestone):
// a fully self-contained IIFE gets its own scope automatically, no risk
// of colliding with the two IIFEs above despite reusing several of the
// same names (DEBUG, log, FADE_MS, getBackdropContainer, etc.).
//
// Scope: library-view pages only (Genre-filtered item lists), never
// detail pages - the exact opposite of the two IIFEs above. Reuses
// Core.js's own createBackdropRotationEngine() (the shared Sequential/
// Shuffle/Random timing logic) rather than reinventing it - see this
// project's own backdrops concept file, "Core.js vs. Backdrops-v1.js".
//
// HONEST SCOPE NOTE, first pass: this deliberately does NOT yet replicate
// People Backdrops' full production hardening (per-visit AbortControllers,
// the MutationObserver '.withBackdrop' defense, seamless subpage
// continuation). Those were all found and fixed via real testing over
// multiple sessions, not designed upfront - this first version covers the
// core feature correctly (container, Ken Burns, rotation, generation
// guard against stale renders) and is meant to be hardened the same way,
// once real testing surfaces what actually breaks.
// =======================================================================
(function () {
    'use strict';
    var Core = window.ArtworkPlusCore;
    var DEBUG = true;
    var log = Core.makeLogger('[ArtworkPlus GenreBackdrops]', DEBUG);

    // Session 120 (concept Part R): only page detection, the pool fetch and
    // the claim live here; container, Ken Burns, rendering, rotation and the
    // release-through-the-bus are Core.createBackdropOwner().
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
        if (qIndex === -1 || hash.slice(0, qIndex).indexOf('list.html') === -1) { return null; }
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
            if (activeKey !== null) { activeKey = null; owner.release(); }
            return;
        }
        if (detected.key === activeKey) { return; }
        activeKey = detected.key;
        owner.claim('normal');
        owner.beginVisit();
        load(detected, ++loadToken);
    });
    setTimeout(Core.dispatchNavigationNow, 1200);
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

    // Session 120 (concept Part R): only page detection, the pool fetch and
    // the claim live here; container, Ken Burns, rendering, rotation and the
    // release-through-the-bus are Core.createBackdropOwner().
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
        if (qIndex === -1 || hash.slice(0, qIndex).indexOf('list.html') === -1) { return null; }
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

        if (settings.SourceMode === 'Appearances') {
            // Backdrops of the studio's own titles - a pool like Genre/Tag.
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
            if (!urls.length) { log('Studio Backdrops: no appearances with backdrops'); owner.empty(); return; }
            owner.start(urls, poolSettings(pool));
            log('Studio Backdrops shown (Appearances) | studioId:', detected.studioId, '| images:', urls.length, '| sort:', pool.SortMode);
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
            if (activeKey !== null) { activeKey = null; owner.release(); }
            return;
        }
        if (detected.key === activeKey) { return; }
        activeKey = detected.key;
        owner.claim('normal');
        owner.beginVisit();
        load(detected, ++loadToken);
    });
    setTimeout(Core.dispatchNavigationNow, 1200);
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

    // Session 120 (concept Part R): only page detection, the pool fetch and
    // the claim live here; container, Ken Burns, rendering, rotation and the
    // release-through-the-bus are Core.createBackdropOwner().
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
        if (qIndex === -1 || hash.slice(0, qIndex).indexOf('list.html') === -1) { return null; }
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
            if (activeKey !== null) { activeKey = null; owner.release(); }
            return;
        }
        if (detected.key === activeKey) { return; }
        activeKey = detected.key;
        owner.claim('normal');
        owner.beginVisit();
        load(detected, ++loadToken);
    });
    setTimeout(Core.dispatchNavigationNow, 1200);
})();

// =======================================================================
// FAVORITES BACKDROPS (generic) - sixth, independent IIFE. Covers ten of
// the eleven sections (everything except People, which has its own
// dedicated endpoint/logic reusing People Backdrops' own cache - see the
// project's own backdrops concept file). Same rotation-engine reuse and
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

    // Session 120 (concept Part R): only page detection, the pool fetch and
    // the claim live here; container, Ken Burns, rendering, rotation and the
    // release-through-the-bus are Core.createBackdropOwner().
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
        if (qIndex === -1 || hash.slice(0, qIndex).indexOf('list.html') === -1) { return null; }
        var params = new URLSearchParams(hash.slice(qIndex + 1));
        if (params.get('IsFavorite') !== 'true') { return null; }
        var type = params.get('type');
        if (!type || (KNOWN_TYPES.indexOf(type) === -1 && type !== 'Person')) { return null; }
        return { key: type, type: type };
    }

    async function load(detected, myToken) {
        var isPerson = detected.type === 'Person';
        var url = isPerson
            ? window.ApiClient.getUrl('Backdrops/favorites-people-pool')
            : window.ApiClient.getUrl('Backdrops/favorites-pool', { type: detected.type });
        var settings;
        try {
            settings = await window.ApiClient.getJSON(url);
        } catch (e) {
            log('Could not load favorites pool', e);
            if (myToken === loadToken) { owner.empty(); }
            return;
        }
        if (myToken !== loadToken) { return; }
        var urls;
        if (isPerson && (settings.SourceMode === 'WallpapersCom' || settings.SourceMode === 'Folder')) {
            urls = settings.WallpaperUrls || [];
            if (settings.SourceMode === 'WallpapersCom') { owner.claim('wallpapers'); } // shorter handover window (Part R3)
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
            if (activeKey !== null) { activeKey = null; owner.release(); }
            return;
        }
        if (detected.key === activeKey) { return; }
        activeKey = detected.key;
        owner.claim('normal');
        owner.beginVisit();
        load(detected, ++loadToken);
    });
    setTimeout(Core.dispatchNavigationNow, 1200);
})();

// =======================================================================
// LIBRARY VIEW BACKDROPS - seventh, independent IIFE (Session 130). The
// replica of Jellyfin's own random library backdrops (scripts/
// autoBackdrops.js: pages with the `backdropPage` class - Home incl. its
// Favourites tab, movies.html, tv.html, music.html - get 20 random items
// with a backdrop, rotated every 24 s while the user's "Backdrops" display
// setting is on). This category paints the same pages with its own pool
// (server: /Backdrops/library-pool, same query as vanilla), its own cycle
// time, order and Ken Burns, and additionally the pages vanilla never
// paints: a Collections library (set backdrops), search.html and the user
// settings pages (both the Home set). The pool is fetched per visit (vanilla
// caches its 20 until a reload - ours re-rolls; a visit is one page kind +
// library, tab switches inside Home/Movies/... are the same visit).
//
// Interplay (concept Part R): claim/beginVisit on the hash change like the
// other six, so the bus decides every handover the same way (OURS(x) ->
// OURS(library) crossfades, library -> a vanilla detail page fades out at
// once). Vanilla keeps rotating in its own hidden container while ours
// shows (nothing of vanilla's is touched); with vanilla's setting off,
// autoBackdrops calls clearBackdrop() on these pages, which removes
// .withBackdrop - the bus defends it (R8 addendum). The Genre/Studio/Tag/
// Favorites/People list pages are NOT this category's: list.html?parentId=
// is claimed only without any of their parameters, and the server answers
// Enabled=false unless that parent is a boxsets library.
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
    var USER_SETTINGS_PAGES = ['mypreferencesmenu.html', 'mypreferencesdisplay.html', 'mypreferenceshome.html', 'mypreferencesplayback.html', 'mypreferencessubtitles.html', 'mypreferencescontrols.html', 'userprofile.html'];
    var LIST_PARAMS_OF_OTHER_OWNERS = ['genreId', 'studioId', 'tag', 'personId', 'IsFavorite', 'type'];

    function detect() {
        var hash = window.location.hash || '';
        var qIndex = hash.indexOf('?');
        var path = (qIndex === -1 ? hash : hash.slice(0, qIndex)).replace(/^#\/?/, '');
        var params = new URLSearchParams(qIndex === -1 ? '' : hash.slice(qIndex + 1));
        if (path === '' || path === 'home.html') { return { key: 'home', page: 'home', parentId: null }; }
        if (path === 'search.html') { return { key: 'search', page: 'search', parentId: null }; }
        if (USER_SETTINGS_PAGES.indexOf(path) !== -1) { return { key: 'usersettings', page: 'usersettings', parentId: null }; }
        var topParentId = params.get('topParentId') || null;
        if (path === 'movies.html') { return { key: 'movies|' + (topParentId || ''), page: 'movies', parentId: topParentId }; }
        if (path === 'tv.html') { return { key: 'tv|' + (topParentId || ''), page: 'tv', parentId: topParentId }; }
        if (path === 'music.html') { return { key: 'music|' + (topParentId || ''), page: 'music', parentId: topParentId }; }
        if (path === 'list.html') {
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
            if (activeKey !== null) { activeKey = null; owner.release(); }
            return;
        }
        if (detected.key === activeKey) { return; }
        activeKey = detected.key;
        owner.claim('normal');
        owner.beginVisit();
        load(detected, ++loadToken);
    });
    setTimeout(Core.dispatchNavigationNow, 1200);
})();
