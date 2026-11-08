/*!
 * ArtworkPlus - PostersPlus (unified poster system)
 * ------------------------------------------------------
 * Architecture: Custom Poster, Animated Poster and Extra Poster are three
 * internal SOURCE MODULES. Each owns its network fetch, preload and
 * Delay/rotation/crossfade timing, and all of them feed ONE shared
 * per-navigation state object and ONE central render function - the only
 * code allowed to write `posterEl.style.backgroundImage`/`opacity`/
 * `visibility`/pending classes for a static (non-rotating) result. Extra's
 * rotation animates its own overlay layers, gated by the same shared
 * generation/state object.
 *
 * The Extra backdrop fallback paints onto the same DOM element
 * (`.cardImageContainer`) as the poster winner - there is no separate
 * backdrop layer. That is why "logical winner" and "actually rendered
 * source" are modeled as two distinct states (see PostersState below): a
 * lower-priority poster may legitimately show while Extra's Delay runs.
 *
 * Requires Jellyfin-ArtworkPlus-Core-v1.js to be loaded first. All
 * poster-arbiter/poster-protection code lives here, not in Core.
 *
 * DOM facts (from the jellyfin-web 10.10.7 source):
 *   - Detail-page poster element: .detailImageContainer .cardImageContainer
 *     (a DIV, not an <img>) -> cardImage.ts:64-69
 *   - The parent node already has position:relative -> card.scss:53-56
 *   - The image is set via background-image -> imageLoader.js:122
 *   - The 'viewshow' event bubbles up to document (bubbles:true) -> viewManager.js:60,121
 *   - URL schema: #/details?id=<itemId>&serverId=... -> appRouter.js:447
 *   - window.ApiClient exists -> ServerConnections.js:88
 *   - Library tiles carry data-type="Movie"/"Series" and data-id="<itemId>"
 *     -> cardBuilder.js:1130
 *
 * IMPORTANT - PascalCase: Jellyfin's global JSON serialization is
 * PascalCaseOptions. Server responses here must therefore ALWAYS be read
 * with a capital first letter (result.IsMovie, not .isMovie).
 */
(function () {
    'use strict';

    var DEBUG = true;
    var Core = window.ArtworkPlusCore;
    // Duplicate-load guard: a second execution of this file on the same page
    // must not register a second set of listeners, hooks, polls or module
    // instances - the first instance owns the arbiter state. See
    // Core.claimSingleton().
    if (!Core.claimSingleton('PostersPlus')) { return; }
    var log = Core.makeLogger('[PostersPlus]', DEBUG);
    // Diagnostics for DevTools and local test pages: exposed as
    // window.ArtworkPlusPostersDiagnostics only while debugging is on for
    // this script (ArtworkPlusCore.setDebug('PostersPlus'), then reload).
    var diagnostics = Core.isDebugTagEnabled('[PostersPlus]')
        ? (window.ArtworkPlusPostersDiagnostics = window.ArtworkPlusPostersDiagnostics || {})
        : null;

    var getItemIdFromHash = Core.getItemIdFromHash;
    var isDetailsPage = Core.isDetailsPage;
    var cssUrl = Core.cssUrl;

    // =====================================================================
    // Poster-element discovery
    // =====================================================================

    var pendingPosterElementResolvers = [];
    var posterElementObserver = null;

    // Jellyfin 12.1 renders the poster twice - one
    // `.detailImageContainer.hide-mobile` (desktop/TV) and one
    // `.hide-desktop.hide-tv` inside `.detailRibbon` (mobile). Take the one
    // the current layout shows; 10.10.7 has a single container, so this is
    // the plain first match there.
    function findPosterElement(root) {
        var all = root.querySelectorAll('.detailImageContainer .cardImageContainer');
        if (all.length < 2) { return all[0] || null; }
        var mobile = document.documentElement.classList.contains('layout-mobile');
        for (var i = 0; i < all.length; i++) {
            var c = all[i].closest('.detailImageContainer');
            if (mobile ? !c.classList.contains('hide-mobile') : !c.classList.contains('hide-desktop')) { return all[i]; }
        }
        return all[0];
    }

    // 12.1 moved the poster out of the ribbon and
    // made the card `position: relative; float: left` with desktop
    // `top: -12.96em` and TV `top: 0` (librarybrowser.scss 826-886), where
    // 10.10.7 had it absolute (`top: -80%` / TV `top: 50%` + translateY).
    // Every case box and Poster size rule is written as an offset from the
    // card's own top (`calc(-80% + Xvw)`, TV `top: 50%` + translateY). On
    // 12.1 the desktop/TV container becomes that reference instead: a
    // positioned box of height 0 (the float does not count) that sits where
    // the card's top (desktop) or centre (TV) is, with the card moved to
    // its top / centred on it - the card lands exactly where 12.1 draws it,
    // and every `%` of the container is 0 vertically and the full width
    // horizontally, as on 10.10.7. `.hide-mobile` exists only on 12.1, so
    // none of this can match 10.10.7.
    function ensureJf12GeometryStyles() {
        if (document.getElementById('artworkplus-jf12-geometry')) { return; }
        var c = '.detailImageContainer.hide-mobile';
        var st = document.createElement('style');
        st.id = 'artworkplus-jf12-geometry';
        st.textContent = [
            // z-index 3 = 12.1's own card level: the case boxes live beside the card in this container
            // and must stay above the ribbon (12.1 draws the ribbon after the poster, 10.10.7 inside it).
            '.layout-desktop ' + c + ', .layout-tv ' + c + ' { position: relative; z-index: 3; }',
            '.layout-desktop ' + c + ' { top: -12.96em; }',
            '.layout-desktop ' + c + ' > .card { top: 0; }',
            '.layout-tv ' + c + ' { top: 18.75vw; }',
            '.layout-tv ' + c + ':has(> .card.backdropCard) { top: 7.03125vw; }',
            '.layout-tv ' + c + ':has(> .card.squareCard) { top: 12.5vw; }',
            '.layout-tv ' + c + ' > .card { top: 0; transform: translateY(-50%); }',
            '@media all and (max-width: 62.5em) { .layout-desktop ' + c + ' { top: 0; } }'
        ].join(' ');
        document.head.appendChild(st);
    }

    function checkPendingPosterElementResolvers() {
        if (pendingPosterElementResolvers.length === 0) { return; }
        var root = Core.findVisibleDetailPage() || document;
        var el = findPosterElement(root);
        if (!el) { return; }
        var resolvers = pendingPosterElementResolvers;
        pendingPosterElementResolvers = [];
        resolvers.forEach(function (r) { r(el); });
    }

    function ensurePosterElementObserver() {
        if (posterElementObserver) { return; }
        posterElementObserver = new MutationObserver(checkPendingPosterElementResolvers);
        posterElementObserver.observe(document.body, { childList: true, subtree: true });
    }

    // Resolves with the current poster element as soon as one exists -
    // immediately if present, otherwise via one shared MutationObserver.
    // Page-wide rather than per-navigation: it holds no navigation state,
    // it only reports that a matching element is now visible.
    function waitForPosterElement(timeoutMs) {
        return new Promise(function (resolve) {
            ensureJf12GeometryStyles();
            var root = Core.findVisibleDetailPage() || document;
            var existing = findPosterElement(root);
            if (existing) { return resolve(existing); }
            ensurePosterElementObserver();
            pendingPosterElementResolvers.push(resolve);
            setTimeout(function () {
                var idx = pendingPosterElementResolvers.indexOf(resolve);
                if (idx !== -1) {
                    pendingPosterElementResolvers.splice(idx, 1);
                    resolve(null);
                }
            }, timeoutMs || 8000);
        });
    }

    // =====================================================================
    // Native-overwrite / native-fade-animation protection (poster only;
    // Backdrops has its own)
    // =====================================================================

    /**
     * Jellyfin's lazy loader (imageLoader.js fillImageElement()) sets
     * `elem.style.backgroundImage` to the Main image once its own preload
     * finishes. If that happens after our reveal it overwrites our image,
     * so this observer restores it.
     */
    function protectBackgroundImageFromNativeOverwrite(posterEl, expectedUrl) {
        var observer = new MutationObserver(function () {
            var current = posterEl.style.backgroundImage;
            if (current !== expectedUrl && current.indexOf(expectedUrl.replace(/^url\(['"]?/, '').replace(/['"]?\)$/, '')) === -1) {
                log('[PostersPlus] DIAGNOSTIC: Jellyfin\'s own native lazy-load overwrote our backgroundImage - correcting | was=', current, '| restoring=', expectedUrl);
                posterEl.style.backgroundImage = expectedUrl;
                posterEl.classList.remove('lazy-hidden');
            }
        });
        observer.observe(posterEl, { attributes: true, attributeFilter: ['style'] });
        return observer;
    }

    /**
     * Same cause, different mechanism: fillImageElement() adds
     * `lazy-image-fadein`/`lazy-image-fadein-fast` once its preload
     * finishes. A running CSS animation beats inline styles in the cascade,
     * so for its ~0.1-0.5 s it overrides our `posterEl.style.opacity`.
     * Removing the class as soon as it appears cancels the animation.
     */
    function protectOpacityFromNativeFadeAnimation(posterEl, nativeClassNames) {
        var classNames = nativeClassNames || ['lazy-image-fadein', 'lazy-image-fadein-fast'];
        function checkAndFix() {
            for (var i = 0; i < classNames.length; i++) {
                if (posterEl.classList.contains(classNames[i])) {
                    posterEl.classList.remove.apply(posterEl.classList, classNames);
                    return true;
                }
            }
            return false;
        }
        if (checkAndFix()) { return null; }
        var observer = new MutationObserver(function () { checkAndFix(); });
        observer.observe(posterEl, { attributes: true, attributeFilter: ['class'] });
        return observer;
    }

    // =====================================================================
    // PostersState - the single shared per-navigation state object.
    // Everything Custom/Animated/Extra report goes in here; nothing about
    // "who wins" or "what's actually painted" lives anywhere else.
    //
    // Priorities: Main=0, CustomPoster=1, AnimatedPoster=2,
    // ExtraPoster/ExtraKeyArt=3.
    //
    // participants[priority] = {
    //   registered: bool   - this source's own check has started
    //   resolved:   bool   - this source's own fast applicability check
    //                        has produced a definitive answer
    //   available:  bool   - only meaningful once resolved===true
    //   url:        string|null - this source's own resolved image URL
    //   hasDelay:   bool   - ExtraPoster-specific (priority 3 only)
    // }
    //
    // decision = {
    //   logicalWinner:  null|0|1|2|3   - purely computed from participants,
    //                                    by recomputeDecision() below and
    //                                    NOWHERE ELSE. null = still pending.
    //   renderedSource: -1|0|1|2|3     - what is ACTUALLY painted onto
    //                                    posterEl right now. Deliberately
    //                                    separate from logicalWinner - see
    //                                    renderReason below for why they
    //                                    can legitimately differ.
    //   renderReason:   string|null    - 'Pending' | 'Winner' |
    //                                    'ExtraDelayFallback' | 'NoneAvailable'
    //                                    Explains WHY renderedSource is
    //                                    what it is, so "Custom is visible"
    //                                    distinguishes "Custom won" from
    //                                    "Custom is Extra's fallback during
    //                                    its Delay" - both paint the same
    //                                    property on the same element.
    // }
    // =====================================================================

    var posterCoordinatorState = null;

    function ensureParticipant(coord, priority) {
        if (!coord.participants[priority]) {
            coord.participants[priority] = { registered: false, resolved: false, available: false, url: null };
        }
        return coord.participants[priority];
    }

    /// READ-ONLY view of the arbiter for a poster element.
    ///
    /// posterArbiterGet() CREATES state when the element differs, which is
    /// right for the modules that take part and wrong for an onlooker: the
    /// Three.js case only wants to know who won and what the others offered.
    function posterArbiterPeek(posterEl) {
        return (posterCoordinatorState && posterCoordinatorState.posterEl === posterEl)
            ? posterCoordinatorState : null;
    }

    function posterArbiterGet(posterEl) {
        if (!posterCoordinatorState || posterCoordinatorState.posterEl !== posterEl) {
            posterArbiterCleanupCoord(posterCoordinatorState);
            // Playnite Bridge's in-place version switch: the cover stays visible (see installPosterPendingByDefault).
            if (!Core.playniteSwitchRelease()) {
                posterEl.classList.add('artworkplus-pending');
                posterEl.style.visibility = 'hidden';
            }
            posterCoordinatorState = {
                posterEl: posterEl,
                participants: {
                    1: { registered: false, resolved: false, available: false, url: null },
                    2: { registered: false, resolved: false, available: false, url: null, hasDelay: false },
                    3: { registered: false, resolved: false, available: false, url: null, hasDelay: false }
                },
                decision: { logicalWinner: null, renderedSource: -1, renderReason: null },
                arbiterProtectionObservers: [],
                // Which priority's logo overlay (if any) is shown now - see
                // posterArbiterSyncLogo(). Follows `renderedSource` (what is
                // painted, including the Extra Delay fallback), not
                // `logicalWinner`; the two can differ for a while.
                activeLogoPriority: null,
                // Extra-specific runtime handles for generation safety -
                // set/cleared by the Extra module, read by
                // posterArbiterCleanupCoord().
                extraRuntime: null
            };
            // Lets CaseMod wait until the decision stops being pending
            // (resolved in posterArbiterRecomputeDecision). A Promise rather
            // than the polling waitFor(), whose interval and timeout belong
            // to another call site. Lives on coord, so it is replaced with
            // coord on every navigation.
            var decisionResolve;
            posterCoordinatorState.decisionPromise = new Promise(function (resolve) { decisionResolve = resolve; });
            posterCoordinatorState._resolveDecision = decisionResolve;
        }
        return posterCoordinatorState;
    }

    // THE single place that decides the logical winner. Called at the end
    // of every function below that changes any participant's state.
    function posterArbiterRecomputeDecision(coord) {
        var winner = 0;
        for (var p = 3; p >= 1; p--) {
            var participant = coord.participants[p];
            if (participant && participant.registered && !participant.resolved) {
                coord.decision.logicalWinner = null; // still pending
                posterArbiterRender(coord);
                return;
            }
            if (participant && participant.resolved && participant.available) {
                winner = p;
                break;
            }
        }
        coord.decision.logicalWinner = winner;
        // Resolves when the decision stops being pending; a second
        // resolve() on a settled Promise is a no-op, so no guard is needed.
        if (coord._resolveDecision) { coord._resolveDecision(); }
        posterArbiterRender(coord);
    }

    function posterArbiterRegister(coord, priority) {
        ensureParticipant(coord, priority).registered = true;
        posterArbiterRecomputeDecision(coord);
    }

    function posterArbiterDeclineNotApplicable(coord, priority) {
        var participant = ensureParticipant(coord, priority);
        participant.resolved = true;
        participant.available = false;
        posterArbiterRecomputeDecision(coord);
    }

    function posterArbiterReserve(coord, priority, hasDelay) {
        var participant = ensureParticipant(coord, priority);
        participant.resolved = true;
        participant.available = true;
        if (hasDelay !== undefined) { participant.hasDelay = !!hasDelay; }
        posterArbiterRecomputeDecision(coord);
    }

    // Flips only this priority's `available` flag; the other priorities'
    // records stay untouched. `resolved` stays true - the answer changed
    // from "available" to "not available".
    function posterArbiterWithdrawReservation(coord, priority) {
        var participant = coord.participants[priority];
        if (participant) { participant.available = false; }
        posterArbiterRecomputeDecision(coord);
    }

    function posterArbiterSetFallbackUrl(coord, priority, url) {
        var participant = ensureParticipant(coord, priority);
        participant.url = url;
        posterArbiterRecomputeDecision(coord);
    }

    function posterArbiterIsWinner(coord, priority) {
        return coord.decision.logicalWinner === priority;
    }

    function posterArbiterIsDecisionPending(coord) {
        return coord.decision.logicalWinner === null;
    }

    // Shared by every place the central render path paints on a source
    // module's behalf - disconnects whatever protection observers were
    // created for a PREVIOUS url before creating a new pair, so two live
    // observers never end up each insisting on a different "correct" url.
    function posterArbiterApplyProtections(coord, cssUrlValue) {
        coord.arbiterProtectionObservers.forEach(function (o) { if (o) { o.disconnect(); } });
        coord.arbiterProtectionObservers = [
            protectBackgroundImageFromNativeOverwrite(coord.posterEl, cssUrlValue),
            protectOpacityFromNativeFadeAnimation(coord.posterEl)
        ];
    }

    function posterArbiterTrackObserver(coord, observer) {
        if (observer) { coord.arbiterProtectionObservers.push(observer); }
    }

    // With the Viva Elite 3D Case the tilt of the whole .cardScalable
    // arrives with the /CaseMod answer. Until then Jellyfin's blurhash
    // placeholder (<canvas>, a sibling of the image container) and the
    // padder icon are visible and flat, and would jump into the rotation
    // when the tilt lands (jellyfin-web 10.10.7: imageLoader.js drawBlurhash,
    // itemDetails renderDetailImage). So, only when the 3D case with a
    // non-zero angle is expected (remembered from the last /CaseMod answer,
    // so the hold can start at viewshow), .cardScalable stays hidden until
    // the tilt is applied. Safety net 3 s; the flat cases are unaffected.
    var TILT_HOLD_CLASS = 'artworkplus-case-tilt-pending';
    var TILT_HOLD_STORAGE_KEY = 'ArtworkPlusCase3DTilt';
    var caseTiltHold = { view: null, timer: null, styleInjected: false };
    // Case mix: each detail page draws its case anew, so the last page says
    // nothing about the next one. While the mix is on, the poster is held
    // until the answers are in (no flicker, at the cost of a longer load).
    // The flag comes with the page (FileTransformationRegistrar), like
    // window.ArtworkPlusThreejs.
    function caseMixOn() {
        var flags = window.ArtworkPlusCaseMix;
        return !!(flags && flags.enabled);
    }
    // The draw must know whether this browser can show the Three.js case - a
    // browser without it never gets one, and the poster chain has to agree
    // with the case the page will really show. Nothing is added while the mix
    // is off, so every request stays exactly as it was.
    function webglQuery(sep) {
        if (!caseMixOn()) { return ''; }
        // true/false, not 1/0: the controllers bind it as bool?, and ASP.NET
        // answers "0" with HTTP 400.
        return sep + 'webgl=' + (ThreejsCaseModule.canDraw() ? 'true' : 'false');
    }
    // Extraposter requests carry the user's token - a set's members are
    // filtered for the requesting user (library access, parental rating),
    // exactly as Jellyfin lists them. Without a client the request stays
    // anonymous and the server shows no members.
    // Uses the standard Authorization header - Jellyfin 12.1 ignores
    // X-Emby-Token unless legacy authorization is on; 10.10.7 reads both.
    function extraAuth(init) {
        var api = window.ApiClient;
        var token = api && typeof api.accessToken === 'function' ? api.accessToken() : null;
        if (token) { init.headers = { 'Authorization': 'MediaBrowser Token="' + token + '"' }; }
        return init;
    }
    function caseTiltExpected() {
        if (caseMixOn()) { return true; }
        try { return localStorage.getItem(TILT_HOLD_STORAGE_KEY) === '1'; } catch (e) { return false; }
    }
    function caseTiltRemember(is3DWithAngle) {
        try { localStorage.setItem(TILT_HOLD_STORAGE_KEY, is3DWithAngle ? '1' : '0'); } catch (e) { /* private mode */ }
    }
    function caseTiltHoldView(view) {
        if (!view) { return; }
        if (!caseTiltHold.styleInjected) {
            caseTiltHold.styleInjected = true;
            var st = document.createElement('style');
            st.id = 'artworkplus-case-tilt-pending';
            st.textContent = '.itemDetailPage.' + TILT_HOLD_CLASS + ' .detailImageContainer .cardScalable{visibility:hidden!important}';
            document.head.appendChild(st);
        }
        caseTiltRelease();
        caseTiltHold.view = view;
        view.classList.add(TILT_HOLD_CLASS);
        caseTiltHold.timer = setTimeout(caseTiltRelease, 3000);
    }
    function caseTiltRelease() {
        if (caseTiltHold.timer) { clearTimeout(caseTiltHold.timer); caseTiltHold.timer = null; }
        var view = caseTiltHold.view;
        caseTiltHold.view = null;
        if (view) { view.classList.remove(TILT_HOLD_CLASS); }
    }
    // Compatibility names used by CaseModModule.check() and the tests.
    function caseModHoldPoster(view) { caseTiltHoldView(view); }
    function caseModReleasePoster() { caseTiltRelease(); }

    // Centralizes the visibility restore - guarantees it happens exactly
    // once, regardless of which source ends up winning.
    function posterArbiterMarkVisible(coord, renderedSource, reason) {
        coord.decision.renderedSource = renderedSource;
        coord.decision.renderReason = reason;
        coord.posterEl.classList.remove('artworkplus-pending');
        coord.posterEl.style.visibility = '';
        // Jellyfin's lazy loader adds `lazy-hidden` when its
        // IntersectionObserver first sees the element and removes it only
        // when its own preload of the Main image finishes - which may never
        // happen once we have replaced the image.
        coord.posterEl.classList.remove('lazy-hidden');
        var view = coord.posterEl.closest ? coord.posterEl.closest('.itemDetailPage') : null;
        if (view) { view.classList.remove('artworkplus-poster-pending'); }
        var hidePlaceholder = function () {
            var parent = coord.posterEl.parentNode;
            var canvas = coord.posterEl.previousSibling;
            if (canvas && canvas.tagName === 'CANVAS' && canvas.classList) { canvas.classList.add('lazy-hidden'); }
            var padder = parent && parent.querySelector ? parent.querySelector('.cardPadder') : null;
            if (padder) { padder.classList.add('lazy-hidden-children'); }
        };
        if (renderedSource !== 0) {
            hidePlaceholder();
        } else if (coord.posterEl.style.backgroundImage) {
            var done = function () { coord.posterEl.removeEventListener('animationend', done); hidePlaceholder(); };
            coord.posterEl.addEventListener('animationend', done);
            setTimeout(done, 600);
        }
        // ExtraModule's showNext() calls this function directly, bypassing
        // posterArbiterRender(), so the logo sync must happen here too.
        // Calling it twice for one transition is harmless:
        // posterArbiterSyncLogo() returns at once if nothing changed.
        posterArbiterSyncLogo(coord);
    }

    /**
     * THE central render path. Reacts to a (re)computed logical winner by
     * deciding renderedSource + renderReason explicitly, separate from
     * logicalWinner: `renderedSource===1` (Custom) can mean "Custom won"
     * (renderReason='Winner') or "Custom is Extra's fallback while its
     * Delay counts down" (renderReason='ExtraDelayFallback'). Both paint
     * the same property on the same element, so the reason is tracked
     * rather than re-derived from what is on screen.
     */
    /**
     * Shows or removes the Keyart/Extrakeyart logo overlays. Logo
     * visibility follows `renderedSource` (what is painted right now), not
     * the final decision: Custom's image can be on screen as Extra's Delay
     * fallback while `logicalWinner` is already 3, and its logo must show
     * then and disappear when Extra takes over. Runs after every render
     * pass, since `renderedSource` changes in several places
     * (posterArbiterMarkVisible, posterArbiterMaintainExtraBackdrop).
     */
    function posterArbiterSyncLogo(coord) {
        var renderedSource = coord.decision.renderedSource;
        var desired = null;
        // 1 = Custom Keyart, 2 = Animated Keyart, 3 = Extrakeyart / Set Keyart slides
        if (renderedSource === 1 || renderedSource === 2 || renderedSource === 3) {
            var participant = coord.participants[renderedSource];
            if (participant && participant.logo) { desired = renderedSource; }
        }
        if (coord.activeLogoPriority === desired) { return; } // no change
        if (coord.activeLogoPriority !== null) {
            var oldParticipant = coord.participants[coord.activeLogoPriority];
            if (oldParticipant && oldParticipant.logo) {
                var oldParent = coord.posterEl.parentElement || coord.posterEl;
                var oldEl = oldParent.querySelector('.' + oldParticipant.logo.className);
                if (oldEl) { oldEl.remove(); }
            }
        }
        coord.activeLogoPriority = desired;
        if (desired !== null) {
            var newParticipant = coord.participants[desired];
            var newParent = coord.posterEl.parentElement || coord.posterEl;
            applySharedLogoOverlay(
                coord, desired, newParent, coord.posterEl,
                newParticipant.logo.itemId, newParticipant.logo.className,
                newParticipant.logo.verticalPercent, newParticipant.logo.sizePercent);
        }
    }

    /**
     * Shared Keyart/Extrakeyart logo overlay: draws Jellyfin's Logo image
     * centered, positioned in CSS percentages of the poster box; class and
     * config values come from the caller. Appended to `parent` (where the
     * visible background/layers live), not to `posterEl`, which Extra's
     * rendering can leave at opacity:0.
     */
    async function applySharedLogoOverlay(coord, priority, parent, posterEl, itemId, className, verticalPercent, sizePercent) {
        try {
            var apiClient = window.ApiClient;
            if (!apiClient) { return; }
            var userId = apiClient.getCurrentUserId ? apiClient.getCurrentUserId() : null;
            var item = await apiClient.getItem(userId, itemId);
            // Re-validated after the async gap: the coord may have been torn
            // down, or this priority may no longer be the logo source.
            if (posterCoordinatorState !== coord) { return; }
            if (coord.activeLogoPriority !== priority) { return; }
            if (!document.body.contains(posterEl)) { return; }
            if (!item || !item.ImageTags || !item.ImageTags.Logo) { return; }

            var logoUrl = apiClient.getScaledImageUrl(itemId, { type: 'Logo', tag: item.ImageTags.Logo, maxWidth: 800 });

            var existing = parent.querySelector('.' + className);
            if (existing) { existing.remove(); }

            if (getComputedStyle(parent).position === 'static') { parent.style.position = 'relative'; }

            var logoEl = document.createElement('div');
            logoEl.className = className;
            logoEl.style.position = 'absolute';
            logoEl.style.left = '50%';
            logoEl.style.top = verticalPercent + '%';
            logoEl.style.width = sizePercent + '%';
            logoEl.style.zIndex = '3';
            logoEl.style.transform = 'translate(-50%, -50%)';
            var img = document.createElement('img');
            img.src = logoUrl;
            img.style.width = '100%';
            img.style.height = 'auto';
            img.style.display = 'block';
            logoEl.appendChild(img);

            parent.appendChild(logoEl);
        } catch (e) {
            // Deliberately silent - a failed logo overlay must not look like
            // a failed poster render; nothing depends on it.
        }
    }

    function posterArbiterRender(coord) {
        posterArbiterRenderImpl(coord);
        posterArbiterSyncLogo(coord);
    }

    function posterArbiterRenderImpl(coord) {
        var winner = coord.decision.logicalWinner;
        if (winner === null) { return; } // pending - never touch the DOM

        if (coord.decision.renderedSource === winner && coord.decision.renderReason === 'Winner') {
            // The winner has taken over. Extra's backdrop bookkeeping stays
            // live in case a lower source's url arrives later (harmless
            // under Extra's opaque layer).
            if (winner === 3) { posterArbiterMaintainExtraBackdrop(coord); }
            return;
        }

        if (winner === 0) {
            if (coord.decision.renderedSource === -1) {
                posterArbiterMarkVisible(coord, 0, 'Winner');
            }
            return;
        }

        if (winner === 3) {
            posterArbiterMaintainExtraBackdrop(coord);
            return;
        }

        // winner is 1 or 2 - safety net for a source whose module had
        // already finished when it became the winner (e.g. Extra withdraws
        // after Custom/Animated decided "not the winner" and exited).
        var participant = coord.participants[winner];
        if (participant && participant.url) {
            var cssUrlValue = cssUrl(participant.url);
            coord.posterEl.style.backgroundImage = cssUrlValue;
            posterArbiterMarkVisible(coord, winner, 'Winner');
            posterArbiterApplyProtections(coord, cssUrlValue);
        }
        // else: this priority is the winner but still preloading - its
        // module paints and reveals once ready (see posterArbiterIsWinner()).
    }

    /**
     * Extra is the logical winner but may not have taken over yet (its
     * Delay is counting down, or its crossfade has not reached its first
     * frame). Shows the best known lower-priority url as a labeled fallback
     * (renderReason='ExtraDelayFallback', never 'Winner'). If nothing lower
     * is available and Extra reported a Delay, Main is the placeholder
     * (renderReason='NoneAvailable'). With no Delay, posterEl stays hidden,
     * so Main never flashes.
     */
    function posterArbiterMaintainExtraBackdrop(coord) {
        // `hasDelay` means Extra reported an admin-configured wait during
        // which showing something else is intended - not "Extra has not
        // rendered yet". Without a Delay nothing here may touch posterEl:
        // it stays hidden through Extra's normal preparation (list fetch,
        // first preload) until Extra's own reveal, just as Custom/Animated
        // stay hidden during their preload when they win.
        var extra = coord.participants[3];
        if (!extra || extra.hasDelay !== true) { return; }

        var bestUrl = null;
        var bestPriority = 0;
        for (var p = 2; p >= 1; p--) {
            var participant = coord.participants[p];
            if (participant && participant.available && participant.url) {
                bestUrl = participant.url;
                bestPriority = p;
                break;
            }
        }
        if (bestUrl) {
            var cssUrlValue = cssUrl(bestUrl);
            var isNewUrl = coord.posterEl.style.backgroundImage !== cssUrlValue;
            if (isNewUrl) { coord.posterEl.style.backgroundImage = cssUrlValue; }
            if (coord.decision.renderedSource === -1) {
                posterArbiterMarkVisible(coord, bestPriority, 'ExtraDelayFallback');
            } else if (coord.decision.renderedSource !== bestPriority || coord.decision.renderReason !== 'ExtraDelayFallback') {
                coord.decision.renderedSource = bestPriority;
                coord.decision.renderReason = 'ExtraDelayFallback';
            }
            if (isNewUrl) { posterArbiterApplyProtections(coord, cssUrlValue); }
            return;
        }
        // Nothing lower available and a Delay is active - Main is the
        // placeholder.
        if (coord.decision.renderedSource === -1) {
            posterArbiterMarkVisible(coord, 0, 'NoneAvailable');
        }
    }

    // Every 'viewshow' must disconnect the outgoing coord's observers (and
    // stop its Extra Delay timer/rotation) before the reference is dropped,
    // or a stale observer/timer from navigation A acts on navigation B once
    // Jellyfin's view cache reuses the same posterEl. Pure cleanup - no
    // winner/priority/fallback decision belongs here.
    function posterArbiterCleanupCoord(coord) {
        if (!coord) { return; }
        coord.arbiterProtectionObservers.forEach(function (o) { if (o) { o.disconnect(); } });
        coord.arbiterProtectionObservers = [];
        if (coord.extraRuntime && typeof coord.extraRuntime.cleanup === 'function') {
            coord.extraRuntime.cleanup();
        }
        coord.extraRuntime = null;
    }

    // =====================================================================
    // Shared navigation generation - one counter for the whole poster
    // system. Every async continuation (fetch, preload, Delay timer,
    // rotation timer, crossfade rAF) checks its captured generation against
    // it before touching the DOM or `coord`, so a continuation from
    // navigation A cannot affect navigation B: B's scheduleDetail()
    // increments the counter before B's async work starts.
    // =====================================================================

    var navGeneration = 0;
    // Listeners / observers a detail module attaches for one generation
    // register a disposer here; scheduleDetail() runs them before it bumps
    // the generation, so the old page's card subtree does not stay reachable
    // until the next resize notices it is stale.
    var generationDisposers = [];
    function onGenerationEnd(fn) { generationDisposers.push(fn); }
    function runGenerationDisposers() {
        var list = generationDisposers;
        generationDisposers = [];
        list.forEach(function (fn) { try { fn(); } catch (e) { /* a stale disposer must not stop the others */ } });
    }
    var navTimers = Core.createTimerTracker();
    var contentReady = false;

    function currentGeneration() { return navGeneration; }

    // Polls fn() every 150 ms until it returns a value or the timeout ends.
    function waitFor(fn, timeoutMs) {
        return new Promise(function (resolve) {
            var t0 = Date.now(), done = false;
            function settle(v) { if (!done) { done = true; resolve(v); } }
            // The deadline is its own timer and deliberately not tracked: the
            // poll is tracked, so a navigation cancels it, and without a
            // separate deadline a cancelled poll would leave this promise
            // pending for ever - Extraposter awaits it after hiding the
            // card's poster, which would leave the poster slot empty.
            setTimeout(function () { settle(null); }, timeoutMs || 8000);
            (function poll() {
                if (done) { return; }
                var el = fn();
                if (el) { return settle(el); }
                if (Date.now() - t0 > (timeoutMs || 8000)) { return settle(null); }
                navTimers.track(setTimeout(poll, 150));
            })();
        });
    }


    /**
     * One 'viewshow' handler for the whole poster system: pre-hides the
     * detail poster, cleans up the outgoing coord and resets whatever an
     * abandoned previous run left in the DOM (inline styles, Extra layers,
     * logo overlays), in one place.
     */
    function installPosterPendingByDefault() {
        document.addEventListener('viewshow', function (e) {
            var view = e && e.target;
            if (!view || !view.classList || !view.classList.contains('itemDetailPage')) { return; }
            // Playnite Bridge's in-place version switch: the detail page's cover belongs to the Bridge then (its
            // ghost fades the old cover over the new one, which must already be visible at the release) - no
            // pre-hiding. The Bridge rebuilds the card, so a hold here would only end at the 1.5 s fallback.
            if (!(e.detail && e.detail.pbInPlace)) {
                view.classList.add('artworkplus-poster-pending');
                if (caseTiltExpected()) { caseTiltHoldView(view); } // whole card hidden until the 3D tilt is on
                // Same idea for the Three.js case, which needs far longer to
                // appear - engine, mesh and textures load first.
                if (ThreejsCaseModule.expected()) { ThreejsCaseModule.hold(view); }
            }
            // Cleanup must happen before the reference is dropped.
            posterArbiterCleanupCoord(posterCoordinatorState);
            posterCoordinatorState = null;
            // Safety net for an abandoned previous run, after cleanup: cleanup
            // stops old timers/observers; this repairs inline styles a stale
            // run may have left on the DOM.
            document.querySelectorAll('.detailImageContainer .cardImageContainer').forEach(function (el) {
                el.style.visibility = '';
                el.style.opacity = '';
            });
            // ExtraModule's createOverlayLayers() removes a previous run's
            // `.extraposter-layer` elements only when Extra runs again. On a
            // later navigation where Extra is not applicable, the old opaque
            // layer (absolute, inset 0) would cover the new winner's poster
            // (e.g. A=Custom -> B=Extra -> C=Animated on a reused posterEl).
            document.querySelectorAll('.detailImageContainer .extraposter-layer').forEach(function (el) {
                el.remove();
            });
            // Same for the logo overlays: each module removes its stale logo
            // element only when its own check() gets that far again, which
            // never happens when the next item is not applicable for it - the
            // old logo would then cover the new navigation's poster.
            document.querySelectorAll('.detailImageContainer .artworkplus-keyart-logo, .detailImageContainer .artworkplus-animatedkeyart-logo, .detailImageContainer .artworkplus-extrakeyart-logo, .detailImageContainer .artworkplus-casemod-overlay').forEach(function (el) {
                el.remove();
            });
            // Restored view (Back button): Jellyfin's placeholder (blurhash
            // canvas / .cardPadder) may already be hidden by an earlier
            // visit's fade-in - bring it back the way imageLoader
            // emptyImageElement() does, so there is no empty box until our
            // next decision.
            var hiddenCanvases = view.querySelectorAll('.detailImageContainer .blurhash-canvas.lazy-hidden');
            for (var ci = 0; ci < hiddenCanvases.length; ci++) { hiddenCanvases[ci].classList.remove('lazy-hidden'); }
            var hiddenPadders = view.querySelectorAll('.detailImageContainer .cardPadder.lazy-hidden-children');
            for (var pi = 0; pi < hiddenPadders.length; pi++) { hiddenPadders[pi].classList.remove('lazy-hidden-children'); }
            setTimeout(function () {
                if (!view.classList.contains('artworkplus-poster-pending')) { return; }
                var st = posterCoordinatorState;
                if (!st || !view.contains(st.posterEl)) {
                    view.classList.remove('artworkplus-poster-pending');
                }
            }, 1500);

            // Safety release. The check above only lets go when there is no
            // coordinator for this view; with one, the poster stays hidden for
            // as long as the winning mod needs, which is unbounded (a slow
            // first Extraposter image can take many seconds to preload).
            // Jellyfin's poster is better than an empty box, and the mod still
            // crossfades over it when ready. `renderedSource` records what
            // actually reached the screen, not what was decided.
            setTimeout(function () {
                if (!view.classList.contains('artworkplus-poster-pending')) { return; }
                var st = posterCoordinatorState;
                if (st && st.decision && st.decision.renderedSource >= 0) { return; }
                view.classList.remove('artworkplus-poster-pending');
                log('nothing painted after 4 s - showing the vanilla poster rather '
                    + 'than an empty box; a slower mod may still fade in over it');
            }, 4000);
        });
    }
    installPosterPendingByDefault();

    // =====================================================================
    // LIBRARY TILE ARBITER - the library-view
    // counterpart of the detail-page poster arbiter above. Same
    // participants, same order: Extra 3 > Animated 2 > Custom 1 > Main 0.
    //
    // Jellyfin's tiles (cardBuilder.js + imageLoader.js): all 500 cards of
    // a page are built at once with the poster URL in data-src; the lazy
    // loader fills a tile at 50% viewport margin (preload, then
    // background-image + a fade-in), hides the blurhash canvas after that
    // fade (`lazy-hidden`), and on scroll-out copies the current
    // background-image back into data-src and empties the tile.
    //
    // Flash prevention (no Main poster may flash before ours): the
    // MutationObserver that sees the cards being inserted
    // runs as a microtask, BEFORE the first paint - every poster tile is
    // marked `artworkplus-tile-pending` right there (image hidden, the
    // blurhash canvas kept visible by the CSS the server injects). A tile
    // is released when every enabled participant has answered for it
    // and the winner's image is in place; a 3 s safety net releases it
    // no matter what.
    //
    // Winner 1/2 (one image): the URL goes into data-src, so Jellyfin
    // loads it itself at its own margin with its own fade-in (blurhash ->
    // ours). A tile Jellyfin already filled or is filling (first screen)
    // is overridden after our preload, in the same frame as the release;
    // a per-tile guard re-applies our URL if Jellyfin's in-flight poster
    // lands afterwards (microtask, before paint - no visible frame).
    // Winner 3 (Extra overlay): the next-lower available image (or
    // Jellyfin's poster) is set as the base underneath - with a Delay it
    // is meant to show and the tile is released at once; without a Delay
    // the tile stays pending until Extra's first image is decoded, which
    // then appears in the same frame (the detail page's own rule).
    // Load error: the participant withdraws, the decision is recomputed,
    // the next one wins, Jellyfin's poster is the floor.
    //
    // Which participants are expected comes from
    // window.ArtworkPlusLibraryTiles (FileTransformationRegistrar.cs:
    // tab + feature + a Library switch), written into index.html together
    // with the scripts.
    // =====================================================================

    var LibraryTiles = (function () {
        var PENDING_CLASS = 'artworkplus-tile-pending';
        var FADEIN_CLASS = 'artworkplus-tile-fadein';
        // Jellyfin 12.1's modern library pages build
        // React cards (components/cardbuilder/Card/CardImageContainer.tsx +
        // common/Image.tsx): the poster is an <img> (LazyLoadImage, absolute,
        // inset 0, inline opacity) inside the .cardImageContainer, with no
        // data-src, no background-image and no `lazy` class - Jellyfin never
        // loads a URL we hand it there. Our image goes onto the container's
        // own background instead and this class hides the React <img> above
        // it; taking the class off brings Jellyfin's poster straight back.
        // 10.10.7 builds the same React cards only in its opt-in 'experimental'
        // layout (apps/experimental/components/library/ItemsView.tsx); its
        // default layout is cardBuilder and never reaches this path.
        var REACT_OWN_CLASS = 'artworkplus-tile-own';
        var SAFETY_MS = 3000; // 2 s is too short for a cold Extraposter batch on external drives
        var SAFETY_HARD_MAX_MS = 12000; // ... and while a batch is still in flight the net waits, up to this
        var PRELOAD_TIMEOUT_MS = 8000;
        var NAMES = { 1: 'custom', 2: 'animated', 3: 'extra' };
        var log = Core.makeLogger('[PostersPlus/LibraryTiles]', DEBUG);

        var flags = window.ArtworkPlusLibraryTiles || {};
        var expected = [1, 2, 3].filter(function (p) { return !!flags[NAMES[p]]; });
        // The tile is held blank before the first paint only when a
        // participant that wants that can still win it - Custom/Animated always
        // do (one image), Extra only where "Seamless loading" is on.
        var wantsPending = !!flags.custom || !!flags.animated || !!flags.extraSeamless;

        function ensureStyles() {
            // Own block: the server injects 'artworkplus-library-tiles' into
            // index.html (FileTransformationRegistrar.cs), so a rule appended
            // to that one here would never be written.
            if (!document.getElementById('artworkplus-library-tiles-react')) {
                var reactStyle = document.createElement('style');
                reactStyle.id = 'artworkplus-library-tiles-react';
                // ... and its blurhash canvas, which stands at the same place until the <img> has
                // loaded (12.1 / 10.10.7 common/Image.tsx) - it would cover our image meanwhile.
                reactStyle.textContent = '.cardImageContainer.' + REACT_OWN_CLASS + '>div>img,'
                    + '.cardImageContainer.' + REACT_OWN_CLASS + '>div>canvas{opacity:0!important}';
                document.head.appendChild(reactStyle);
            }
            if (document.getElementById('artworkplus-library-tiles')) { return; }
            var style = document.createElement('style');
            style.id = 'artworkplus-library-tiles';
            style.textContent = '.cardImageContainer.artworkplus-tile-pending{opacity:0!important}'
                + '.cardScalable:has(>.artworkplus-tile-pending)>.blurhash-canvas{opacity:1!important}'
                + '.cardImageContainer.artworkplus-tile-fadein{animation:artworkplus-tile-fadein .5s!important}'
                + '@keyframes artworkplus-tile-fadein{from{opacity:0}to{opacity:1}}';
            document.head.appendChild(style);
        }
        ensureStyles();

        var participants = {}; // priority -> { collect(card, itemId), apply(state), revoke(state) }
        var states = new WeakMap(); // cardEl -> state
        var seenCards = new WeakSet();

        function register(priority, handlers) { participants[priority] = handlers; }
        function isEnabled(priority) { return expected.indexOf(priority) !== -1; }

        function findContainer(cardEl) {
            return cardEl.querySelector('.cardImageContainer') || cardEl.querySelector('.cardContent');
        }

        function stateFor(cardEl) {
            var st = states.get(cardEl);
            if (st) { return st; }
            var container = findContainer(cardEl);
            var itemId = cardEl.dataset.id;
            if (!container || !itemId) { return null; }
            var bg0 = container.style.backgroundImage;
            // A detail page's chapter
            // cards are `.card.chapterCard` with the MOVIE's data-id/data-type (chaptercardbuilder),
            // so they looked like poster tiles of that movie. A tile is only ours when its own
            // image is the item's Primary poster - the chapter card shows /Images/Chapter/n.
            if (cardEl.classList.contains('chapterCard')) { return null; }
            // Told apart by STRUCTURE, never by load state (a 10.10.7 tile
            // between lazy-loader steps can briefly have neither data-src nor
            // a background): cardBuilder's container IS the .cardContent
            // (10.10.7 components/cardbuilder/cardImage.ts), the React one sits
            // INSIDE a .cardContent box (12.1 Card/CardContent.tsx).
            var react = !container.classList.contains('cardContent')
                && !!container.parentElement && container.parentElement.classList.contains('cardContent');
            var reactImg = react ? container.querySelector(':scope > div > img') : null;
            // No <img> yet (LazyLoadImage renders it late) = no URL to check for /Images/Primary;
            // then the card's own shape decides - a Thumb/Banner view is not a poster tile.
            if (react && !reactImg && !cardEl.classList.contains('portraitCard')) { return null; }
            var vanilla = container.getAttribute('data-src') || ((bg0 && bg0 !== 'none') ? bg0 : '') || (reactImg ? reactImg.getAttribute('src') : '');
            if (vanilla && vanilla.indexOf('/Images/Primary') === -1) { return null; }
            st = {
                card: cardEl, container: container, itemId: itemId, type: cardEl.dataset.type, react: react,
                // Jellyfin's own poster URL - the floor when every participant withdraws
                vanillaSrc: container.getAttribute('data-src') || ((bg0 && bg0 !== 'none') ? bg0.slice(4, -1).replace(/"/g, '') : null) || (reactImg ? reactImg.getAttribute('src') : null),
                answers: {}, decided: false, winner: 0, baseUrl: null,
                pending: false, safetyTimer: null, guard: null, pendingSince: 0, inFlight: 0,
                holdForOverlay: false, overlayNear: false, extra: null
            };
            states.set(cardEl, st);
            return st;
        }

        function setPending(st) {
            if (!expected.length || !wantsPending) { return; }
            st.container.classList.add(PENDING_CLASS);
            st.pending = true;
            if (!st.pendingSince) { st.pendingSince = performance.now(); }
            armSafety(st);
        }

        function armSafety(st, ms) {
            if (st.safetyTimer) { clearTimeout(st.safetyTimer); }
            st.safetyTimer = setTimeout(function () {
                st.safetyTimer = null;
                if (!st.pending) { return; }
                // An Extra tile without Delay outside the 50% window keeps
                // its blurhash until it comes near - re-armed on activation.
                if (st.holdForOverlay && !st.overlayNear) { return; }
                // A batch that is still on its way is not a hang: a cold
                // Extraposter batch on external drives takes 1-3 s. Wait for
                // it (re-check every second) up to the hard maximum.
                if (st.inFlight > 0 && performance.now() - st.pendingSince < SAFETY_HARD_MAX_MS) { armSafety(st, 1000); return; }
                log('safety net released tile', st.itemId, '| answers:', JSON.stringify(Object.keys(st.answers)), '| winner:', st.winner);
                release(st);
            }, ms || SAFETY_MS);
        }

        // Jellyfin's Logo image over a Keyart /
        // Extrakeyart tile - the same overlay the detail page draws
        // (applySharedLogoOverlay), sized in percent of the tile. Lives
        // inside .cardImageContainer after the Extra layers (paints above
        // them by DOM order) and below Jellyfin's indicators (z-index 1);
        // hidden with the container while Jellyfin has it emptied.
        // logo = { vertical, size, hasLogo } or null (remove).
        function syncTileLogo(st, logo) {
            var c = st.container;
            var el = c.querySelector('.artworkplus-tile-logo');
            if (!logo || !logo.hasLogo) { if (el) { el.remove(); } return; }
            if (!el) {
                el = document.createElement('div');
                el.className = 'artworkplus-tile-logo';
                el.style.cssText = 'position:absolute;left:50%;transform:translate(-50%,-50%);pointer-events:none;';
                var img = document.createElement('img');
                img.alt = '';
                img.style.cssText = 'width:100%;height:auto;display:block;';
                el.appendChild(img);
                c.appendChild(el);
            }
            el.style.top = logo.vertical + '%';
            el.style.width = logo.size + '%';
            var url = '/Items/' + encodeURIComponent(logo.itemId || st.itemId) + '/Images/Logo?maxWidth=400';
            if (el.firstChild.getAttribute('src') !== url) { el.firstChild.src = url; }
        }

        function release(st) {
            if (st.safetyTimer) { clearTimeout(st.safetyTimer); st.safetyTimer = null; }
            if (!st.pending) { return; }
            st.pending = false;
            st.container.classList.remove(PENDING_CLASS);
        }

        function allAnswered(st) {
            return expected.every(function (p) { return p in st.answers; });
        }

        // answer: null/false = not applicable; { url } for 1/2; Extra's
        // own object ({ urls, delayMs, ... }) for 3.
        function report(cardEl, priority, answer) {
            if (!isEnabled(priority)) { return; }
            var st = stateFor(cardEl);
            if (!st) { return; }
            st.answers[priority] = answer || false;
            if (allAnswered(st)) { decide(st); }
        }

        // Reporters mark a tile while their batch request is in flight.
        function markInFlight(cardEl, delta) {
            var st = states.get(cardEl);
            if (st) { st.inFlight = Math.max(0, st.inFlight + delta); }
        }

        function withdraw(cardEl, priority) {
            var st = states.get(cardEl);
            if (!st || !st.answers[priority]) { return; }
            log('participant', priority, 'withdrew for tile', st.itemId);
            st.answers[priority] = false;
            if (st.decided) { decide(st); }
        }

        function decide(st) {
            var winner = 0;
            for (var p = 3; p >= 1; p--) {
                if (isEnabled(p) && st.answers[p]) { winner = p; break; }
            }
            var previous = st.decided ? st.winner : 0;
            st.decided = true;
            st.winner = winner;
            if (previous && previous !== winner && participants[previous] && participants[previous].revoke) {
                participants[previous].revoke(st);
            }
            if (winner === 0) {
                st.holdForOverlay = false;
                syncTileLogo(st, null);
                if (previous && st.baseUrl && st.vanillaSrc) {
                    // A base we had put into the tile failed (withdrawn): Jellyfin's
                    // loader never resolves a failing URL, so put its own poster back
                    // and load it the way it would have.
                    applyBase(st, st.vanillaSrc, true);
                    return;
                }
                if (st.react) { reactShowOwn(st, null); }
                st.baseUrl = null;
                release(st);
                return;
            }
            if (winner === 3) {
                var base = null;
                for (var q = 2; q >= 1; q--) { if (isEnabled(q) && st.answers[q]) { base = st.answers[q].url; break; } }
                var hasDelay = st.answers[3].delayMs > 0;
                var seamless = st.answers[3].seamless !== false;
                // Hold the tile blank until Extra's first image only when
                // Seamless loading is on and no Delay asks for the base to
                // show anyway.
                st.holdForOverlay = !hasDelay && seamless;
                if (base) {
                    applyBase(st, base, hasDelay || !seamless);
                } else if (st.react) {
                    // React card: the overlay layers are the container's first
                    // children, and the React <img> (absolute, z-index 0, later in
                    // the DOM) would paint over them. Jellyfin's poster moves onto
                    // the container background like on 10.10.7, the <img> is hidden
                    // - background, then our layers, then the indicators.
                    st.baseUrl = reactVanillaSrc(st);
                    reactShowOwn(st, st.baseUrl);
                    if (hasDelay || !seamless) { release(st); }
                } else if (hasDelay || !seamless) {
                    release(st); // Jellyfin's own poster shows first (Delay, or Seamless loading off)
                }
                syncTileLogo(st, null); // Extra draws its own (Extrakeyart) logo once its first image is up
                if (participants[3] && participants[3].apply) { participants[3].apply(st); }
                return;
            }
            st.holdForOverlay = false;
            applyBase(st, st.answers[winner].url, true);
            syncTileLogo(st, st.answers[winner].logo || null);
        }

        function ownerOfUrl(st, url) {
            for (var p = 2; p >= 1; p--) { if (st.answers[p] && st.answers[p].url === url) { return p; } }
            return 0;
        }

        // The one-image path shared by winners 1/2 and Extra's base.
        function applyBase(st, url, releaseWhenShown) {
            st.baseUrl = url;
            var c = st.container;
            if (st.react) { applyBaseReact(st, url, releaseWhenShown); return; }
            var bg = c.style.backgroundImage;
            var filled = !!bg && bg !== 'none';
            // imageLoader.fillImageElement(): `lazy-hidden` goes on at the
            // start of ITS preload, background-image stays '' until the
            // load lands. An emptied tile has background-image 'none'.
            var inFlight = !filled && bg === '' && c.classList.contains('lazy-hidden') && c.hasAttribute('data-src');
            if (c.hasAttribute('data-src') && c.getAttribute('data-src') !== url) { c.setAttribute('data-src', url); }
            installGuard(st);
            if (bg.indexOf(url) !== -1) { if (releaseWhenShown) { release(st); } return; }
            if (!filled && !inFlight) {
                // Fresh or emptied tile: Jellyfin loads our URL itself at
                // its own margin, blurhash -> ours with its own fade-in.
                if (releaseWhenShown) { release(st); }
                return;
            }
            Core.preloadImage(url, { timeoutMs: PRELOAD_TIMEOUT_MS }).then(function () {
                if (st.baseUrl !== url || !document.body.contains(c)) { return; }
                c.style.backgroundImage = cssUrl(url);
                // The same end state Jellyfin's own fill leaves behind (imageLoader.js
                // fillImageElement): no data-src, not lazy-hidden - so a tile whose
                // in-flight Jellyfin load never lands (a failed URL) still shows.
                c.removeAttribute('data-src');
                c.classList.remove('lazy-hidden');
                c.classList.add(FADEIN_CLASS);
                if (releaseWhenShown) { release(st); }
                log('base image set on tile', st.itemId, filled ? '(over Jellyfin\'s poster)' : '(Jellyfin\'s load was in flight)');
            }).catch(function (e) {
                log('base image failed for tile', st.itemId, e);
                var owner = ownerOfUrl(st, url);
                if (owner) { withdraw(st.card, owner); }
            });
        }

        // React card (12.1 modern layout): Jellyfin's own poster is the <img>;
        // ours goes on the container background with the <img> hidden. Back to
        // Jellyfin's poster = just show its <img> again (it never went away).
        //
        // Jellyfin's own poster URL of a React card. LazyLoadImage renders the
        // <img> only once the card comes near the viewport, so at intake it is
        // often not there yet - read it when it is needed, and where it still
        // is not, ask for the item's Primary image the way the card would.
        function reactVanillaSrc(st) {
            var img = st.container.querySelector(':scope > div > img');
            var src = img ? img.getAttribute('src') : null;
            if (src) { st.vanillaSrc = src; }
            return st.vanillaSrc || ('/Items/' + encodeURIComponent(st.itemId) + '/Images/Primary?fillHeight=480&quality=96');
        }

        // url = null: Jellyfin's <img> shows again; a url: it goes on the
        // container background and the <img> is hidden.
        function reactShowOwn(st, url) {
            var c = st.container;
            if (!url) {
                c.classList.remove(REACT_OWN_CLASS);
                c.style.backgroundImage = '';
                return;
            }
            c.style.backgroundImage = cssUrl(url);
            c.classList.add(REACT_OWN_CLASS);
        }

        function applyBaseReact(st, url, releaseWhenShown) {
            var c = st.container;
            // Back to Jellyfin's poster - unless an overlay still lies on the
            // tile, which needs the poster under it as a background (see decide).
            if (url === reactVanillaSrc(st) && st.winner !== 3) {
                reactShowOwn(st, null);
                if (releaseWhenShown) { release(st); }
                return;
            }
            Core.preloadImage(url, { timeoutMs: PRELOAD_TIMEOUT_MS }).then(function () {
                if (st.baseUrl !== url || !document.body.contains(c)) { return; }
                reactShowOwn(st, url);
                c.classList.add(FADEIN_CLASS);
                if (releaseWhenShown) { release(st); }
                log('base image set on React tile', st.itemId);
            }).catch(function (e) {
                log('base image failed for React tile', st.itemId, e);
                var owner = ownerOfUrl(st, url);
                if (owner) { withdraw(st.card, owner); }
            });
        }

        // Re-asserts the base URL if Jellyfin paints something else onto
        // the tile (its in-flight vanilla poster landing after ours);
        // MutationObserver callbacks are microtasks - the wrong image
        // never reaches a frame.
        function installGuard(st) {
            if (st.guard) { return; }
            var c = st.container;
            st.guard = new MutationObserver(function () {
                var url = st.baseUrl;
                if (!url) { return; }
                var bg = c.style.backgroundImage;
                if (bg === 'none' && c.hasAttribute('data-src') && c.getAttribute('data-src') !== url) {
                    c.setAttribute('data-src', url); // emptied with a foreign URL stored - keep ours for the refill
                    return;
                }
                if (!bg || bg === 'none' || bg.indexOf(url) !== -1) { return; }
                c.style.backgroundImage = cssUrl(url);
                log('re-applied base image on tile', st.itemId, 'after Jellyfin\'s own poster landed');
            });
            st.guard.observe(c, { attributes: true, attributeFilter: ['style', 'data-src'] });
        }

        // Card intake - the pending mark happens here, before the first paint.
        var CARD_SELECTOR = '.card[data-type="Movie"], .card[data-type="Series"], .card[data-type="BoxSet"]';
        // Only the added subtrees of each mutation batch are searched - a
        // document-wide query per batch is expensive on large libraries with
        // lazy loading (blurhash canvases come and go per card). Intake stays
        // synchronous: MutationObserver callbacks run before the frame is
        // painted, which the pending mark relies on. The viewshow / boot scans
        // walk the whole document.
        function intake(card) {
            if (seenCards.has(card)) { return; }
            seenCards.add(card);
            var st = stateFor(card);
            if (!st) { return; }
            if (st.react || st.container.hasAttribute('data-src') || st.container.style.backgroundImage) { setPending(st); }
            Object.keys(participants).forEach(function (p) {
                if (isEnabled(+p) && participants[p].collect) { participants[p].collect(card, st.itemId); }
            });
        }
        function scanAdded(records) {
            for (var i = 0; i < records.length; i++) {
                var added = records[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var node = added[j];
                    if (node.nodeType !== 1) { continue; }
                    if (node.matches && node.matches(CARD_SELECTOR)) { intake(node); }
                    if (node.querySelectorAll) { node.querySelectorAll(CARD_SELECTOR).forEach(intake); }
                }
            }
        }
        function scan() {
            document.querySelectorAll(CARD_SELECTOR).forEach(function (card) {
                if (seenCards.has(card)) { return; }
                seenCards.add(card);
                var st = stateFor(card);
                if (!st) { return; }
                // React cards too, as in intake()
                if (st.react || st.container.hasAttribute('data-src') || st.container.style.backgroundImage) { setPending(st); }
                Object.keys(participants).forEach(function (p) {
                    if (isEnabled(+p) && participants[p].collect) { participants[p].collect(card, st.itemId); }
                });
            });
        }

        var mutationObserver = new MutationObserver(function (records) { scanAdded(records); });
        mutationObserver.observe(document.body, { childList: true, subtree: true });
        document.addEventListener('viewshow', function () { setTimeout(scan, 300); });
        setTimeout(scan, 1200);

        log('library tile arbiter ready | expected participants:', JSON.stringify(expected));

        return { register: register, report: report, withdraw: withdraw, stateFor: stateFor, setPending: setPending, armSafety: armSafety, release: release, isEnabled: isEnabled, syncTileLogo: syncTileLogo, markInFlight: markInFlight };
    })();

    // The page class of a card (all three tile participants), as the server's "Also on"
    // filter names them. Route first (location.hash), then the card's
    // container where one route hosts several areas: the Home page
    // keeps both tabs in the DOM and the hash does not change on a tab
    // click (tabbedview.js), so Favorites is `.favoriteSections`
    // (favoriteitems.js); the Continue Watching row is the items
    // container with data-monitor="videoplayback,..." (resume.ts; the
    // Latest rows have no data-monitor) - NOT the card's own
    // data-positionticks, which a half-watched movie carries in the
    // Latest row too; on detail pages More like
    // this is `#similarCollapsible`, a collection's members are
    // `.collectionItems`, a person's rows are `#childrenContent`
    // (itemsByName.js). Unknown = 'other' (the server refuses it).
    function pageClassOf(card) {
        var h = location.hash || '';
        // 12.1 routes have no '.html' ((\.html)? = both versions); its modern layout
        // gives the folders 10.10.7 listed under list.html?parentId= their own pages - same class as before.
        if (/^#\/(movies|tv)(\.html)?([?]|$)/.test(h)) { return 'library'; }
        if (/^#\/dashboard/.test(h)) { return 'dashboard'; }
        if (/^#\/search(\.html)?([?]|$)/.test(h)) { return 'search'; }
        // (\.html)? - 10.10.7's experimental shell routes home videos as #/homevideos.html.
        if (/^#\/(boxsets|playlists|books|homevideos|musicvideos|mixed)(\.html)?([?]|$)/.test(h)) { return 'list-other'; }
        if (/^#\/list(\.html)?([?]|$)/.test(h)) {
            if (/[?&]genreId=/.test(h)) { return 'list-genre'; }
            if (/[?&]studioId=/.test(h)) { return 'list-studio'; }
            if (/[?&]type=tag(&|$)/.test(h) || /[?&]tag=/.test(h)) { return 'list-tag'; }
            return 'list-other';
        }
        if (/^#\/details/.test(h)) {
            if (card.closest('#similarCollapsible')) { return 'detail-similar'; }
            if (card.closest('.collectionItems')) { return 'detail-collection'; }
            if (card.closest('#childrenContent')) { return 'detail-person'; }
            return 'other';
        }
        if (/^#\/home(\.html)?([?]|$)/.test(h) || h === '' || h === '#' || h === '#/') {
            // The home Favorites TAB is #favoritesTab (10.10.7 controllers/home.html:6,
            // experimental home.tsx:175; 12.1 legacy home.html:6, modern home.tsx:180) - .favoriteSections
            // only exists on the music library page (music.html:56).
            if (card.closest('#favoritesTab') || card.closest('.favoriteSections')) { return 'favorites'; }
            if (card.closest('.itemsContainer[data-monitor*="videoplayback"]')) { return 'home-resume'; }
            return 'home-recent';
        }
        return 'other';
    }
    // Diagnostics / tests: the classifier itself.
    if (diagnostics) { diagnostics.pageClassOf = pageClassOf; }

    // One-image participants (Custom 1, Animated 2): page-wide batch,
    // one answer per tile into the arbiter - the arbiter does the rest.
    function createLibraryReporter(options) {
        var FETCH_DEBOUNCE_MS = 20; // the 500 cards of a page arrive in one DOM insertion
        var BATCH_CHUNK = 200;     // the servers cap one batch at 200 ids
        var priority = options.priority;
        var log = options.log;
        var resultCache = {};      // 'page|itemId' -> result (the answer depends on the page class)
        var pendingByPage = {};    // page class -> [itemId]
        var pendingCards = {};     // 'page|itemId' -> [card]
        var fetchTimer = null;

        function answerFor(key) {
            var result = resultCache[key];
            if (!result || !result.IsApplicable) { return null; }
            var itemId = key.slice(key.indexOf('|') + 1);
            return {
                url: options.imageUrl(itemId, result),
                resolvedType: result.ResolvedType,
                // Keyart's per-view logo: the server already says whether the item has one
                logo: result.LogoEnabled ? { vertical: result.LogoVerticalPositionPercent, size: result.LogoSizePercent, hasLogo: !!result.HasLogo } : null
            };
        }

        function collect(card, itemId) {
            var page = pageClassOf(card);
            var key = page + '|' + itemId;
            if (key in resultCache) { LibraryTiles.report(card, priority, answerFor(key)); return; }
            (pendingCards[key] = pendingCards[key] || []).push(card);
            LibraryTiles.markInFlight(card, +1);
            var ids = pendingByPage[page] = pendingByPage[page] || [];
            if (ids.indexOf(itemId) === -1) { ids.push(itemId); }
            if (!fetchTimer) { fetchTimer = setTimeout(function () { fetchTimer = null; flush(); }, FETCH_DEBOUNCE_MS); }
        }

        function reportAll(page, ids) {
            ids.forEach(function (id) {
                var key = page + '|' + id;
                var cards = pendingCards[key] || [];
                delete pendingCards[key];
                var answer = answerFor(key);
                cards.forEach(function (card) { LibraryTiles.markInFlight(card, -1); LibraryTiles.report(card, priority, answer); });
                if (answer) { log('applicable for tile', id, '| page:', page, '(resolved:', answer.resolvedType + ')'); }
            });
        }

        function flush() {
            var byPage = pendingByPage;
            pendingByPage = {};
            Object.keys(byPage).forEach(function (page) { flushPage(page, byPage[page]); });
        }

        // One batch per page class: the server's "Also on" filter needs the
        // class, and a Home page can hold Latest, Continue Watching and
        // Favorites cards at once.
        function flushPage(page, ids) {
            if (!ids.length) { return; }
            var chunks = [];
            for (var i = 0; i < ids.length; i += BATCH_CHUNK) { chunks.push(ids.slice(i, i + BATCH_CHUNK)); }
            Promise.all(chunks.map(function (chunk) {
                return fetch(options.batchUrl(chunk) + '&page=' + encodeURIComponent(page))
                    .then(function (r) { return r.json(); })
                    .then(function (batchResponse) {
                        var items = batchResponse.Items || {};
                        // Keys are the tile's data-id form (32 hex, no dashes) - the batch endpoints key by Guid "N".
                        Object.keys(items).forEach(function (id) { resultCache[page + '|' + id] = items[id]; });
                        chunk.forEach(function (id) { if (!((page + '|' + id) in resultCache)) { resultCache[page + '|' + id] = null; } });
                    })
                    .catch(function (e) {
                        log('Error during the library batch request', e);
                        chunk.forEach(function (id) { if (!((page + '|' + id) in resultCache)) { resultCache[page + '|' + id] = null; } });
                    });
            })).then(function () { reportAll(page, ids); });
        }

        LibraryTiles.register(priority, { collect: collect });
        return {};
    }

    // =====================================================================
    // CUSTOM MODULE (Postercase/Keyart) - priority 1
    // Own fetch, own preload, own optional Keyart logo overlay. Reports
    // only into the shared controller (register/reserve/decline/
    // setFallbackUrl); the central render path (posterArbiterRender)
    // decides whether it paints.
    // =====================================================================

    var CustomModule = (function () {
        var PRELOAD_TIMEOUT_MS = 8000;
        var log = Core.makeLogger('[PostersPlus/Custom]', DEBUG);

        function preloadImage(url) {
            return Core.preloadImage(url, { timeoutMs: PRELOAD_TIMEOUT_MS });
        }

        // Called once per navigation, in parallel with Animated/Extra -
        // see startDetail() in the shared wiring section below.
        async function check(coord, itemId, posterEl, myGeneration) {
            var resultPromise = fetch('/CustomPoster/' + encodeURIComponent(itemId) + '?scope=detail' + webglQuery('&'), { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .catch(function (e) { return { __fetchError: e }; });

            posterArbiterRegister(coord, 1);

            var result = await resultPromise;
            if (myGeneration !== currentGeneration()) { return; }
            if (result.__fetchError) {
                log('Error fetching (detail page)', result.__fetchError);
                posterArbiterDeclineNotApplicable(coord, 1);
                return;
            }
            if (!result.IsApplicable) {
                posterArbiterDeclineNotApplicable(coord, 1);
                return;
            }

            posterArbiterReserve(coord, 1, false);
            // Set as soon as it is known; posterArbiterSyncLogo() decides
            // when it is shown, based on `renderedSource`.
            coord.participants[1].logo = (result.ResolvedType === 'keyart' && result.LogoEnabled)
                ? {
                    itemId: itemId,
                    className: 'artworkplus-keyart-logo',
                    verticalPercent: result.LogoVerticalPositionPercent,
                    sizePercent: result.LogoSizePercent
                }
                : null;
            posterArbiterSyncLogo(coord);

            var url = '/CustomPoster/' + encodeURIComponent(itemId) + '/image?type=' + encodeURIComponent(result.ResolvedType) + '&scope=detail'
                + '&v=' + encodeURIComponent(result.Version);
            try {
                await preloadImage(url);
            } catch (e) {
                log('The Custom Poster image could not be loaded', e);
                // Without this, if Custom is the only registered participant,
                // Main would never be revealed - the record would stay at
                // available=true.
                posterArbiterWithdrawReservation(coord, 1);
                return;
            }
            if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }

            // Reported whether or not this source wins: if a higher priority
            // withdraws later, or Extra needs a backdrop during its Delay,
            // this url is needed.
            posterArbiterSetFallbackUrl(coord, 1, url);
        }

        // Library view: reporter into the tile arbiter, priority 1 (the
        // lowest - Animated and Extra outrank it, as on the detail page).
        // Postercase vs. Keyart is the server's own "auto" resolution
        // (CustomPosterPriority).
        createLibraryReporter({
            priority: 1,
            log: Core.makeLogger('[PostersPlus/Custom/Library]', DEBUG),
            batchUrl: function (ids) { return '/CustomPoster/batch?ids=' + ids.map(encodeURIComponent).join(',') + '&scope=library'; },
            imageUrl: function (itemId, result) {
                return '/CustomPoster/' + encodeURIComponent(itemId) + '/image?type=' + encodeURIComponent(result.ResolvedType) + '&scope=library' + '&v=' + encodeURIComponent(result.Version);
            }
        });

        return { check: check, priority: 1 };
    })();

    // =====================================================================
    // ANIMATED MODULE - priority 2
    // Detail-page check() reports into the shared controller, same shape
    // as CustomModule. The library view reports into the tile arbiter
    // above - independent of the detail-page arbiter.
    // =====================================================================

    var AnimatedModule = (function () {
        var PRELOAD_TIMEOUT_MS = 8000;
        var log = Core.makeLogger('[PostersPlus/Animated]', DEBUG);

        function preloadImage(url) {
            return Core.preloadImage(url, { timeoutMs: PRELOAD_TIMEOUT_MS });
        }

        // No explicit "type" in the initial fetch - the server's "auto"
        // default picks AnimatedPoster vs. Animated Keyart
        // (AnimatedPosterPriority), as in CustomModule; the image URL then
        // uses result.ResolvedType.
        async function check(coord, itemId, posterEl, myGeneration) {
            var resultPromise = fetch('/AnimatedPoster/' + encodeURIComponent(itemId) + '?scope=detail' + webglQuery('&'), { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .catch(function (e) { return { __fetchError: e }; });

            posterArbiterRegister(coord, 2);

            var result = await resultPromise;
            if (myGeneration !== currentGeneration()) { return; }
            if (result.__fetchError) {
                log('Error fetching (detail page)', result.__fetchError);
                posterArbiterDeclineNotApplicable(coord, 2);
                return;
            }
            if (!result.IsApplicable) {
                posterArbiterDeclineNotApplicable(coord, 2);
                return;
            }

            posterArbiterReserve(coord, 2, false);
            // Animated Keyart's logo overlay - the same participant
            // logo mechanism as Custom Keyart (posterArbiterSyncLogo decides when).
            coord.participants[2].logo = (result.ResolvedType === 'animatedkeyart' && result.LogoEnabled)
                ? {
                    itemId: itemId,
                    className: 'artworkplus-animatedkeyart-logo',
                    verticalPercent: result.LogoVerticalPositionPercent,
                    sizePercent: result.LogoSizePercent
                }
                : null;
            posterArbiterSyncLogo(coord);

            var url = '/AnimatedPoster/' + encodeURIComponent(itemId) + '/image?type=' + encodeURIComponent(result.ResolvedType) + '&scope=detail'
                + '&v=' + encodeURIComponent(result.Version);
            try {
                await preloadImage(url);
            } catch (e) {
                log('The animated poster could not be loaded', e);
                posterArbiterWithdrawReservation(coord, 2);
                return;
            }
            if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }

            posterArbiterSetFallbackUrl(coord, 2, url);
            log('Animated poster/keyart reported for', itemId, '(resolved:', result.ResolvedType + ')');
        }

        // Library view: reporter into the tile arbiter, priority 2.
        createLibraryReporter({
            priority: 2,
            log: Core.makeLogger('[PostersPlus/Animated/Library]', DEBUG),
            batchUrl: function (ids) { return '/AnimatedPoster/batch?ids=' + ids.map(encodeURIComponent).join(',') + '&scope=library'; },
            imageUrl: function (itemId, result) {
                return '/AnimatedPoster/' + encodeURIComponent(itemId) + '/image?type=' + encodeURIComponent(result.ResolvedType) + '&scope=library' + '&v=' + encodeURIComponent(result.Version);
            }
        });

        return { check: check, priority: 2 };
    })();

    // =====================================================================
    // EXTRA MODULE (ExtraPoster/ExtraKeyArt) - priority 3
    // Owns its Delay wait, rotation and crossfade, which animate its own
    // overlay layers directly (never posterEl's background-image).
    // Generation safety uses the shared navGeneration counter, and the
    // end-of-rotation/withdrawal calls go through the same
    // posterArbiterWithdrawReservation() as the other two modules.
    // =====================================================================

    var ExtraModule = (function () {
        var PRELOAD_TIMEOUT_MS = 8000;
        var MAX_CONSECUTIVE_FAILURES = 6;
        var log = Core.makeLogger('[PostersPlus/Extra]', DEBUG);

        function preloadImage(url) {
            return Core.preloadImage(url, { timeoutMs: PRELOAD_TIMEOUT_MS, track: navTimers.track });
        }

        function createOverlayLayers(parent, fadeMs) {
            parent.querySelectorAll('.extraposter-layer').forEach(function (el) { el.remove(); });
            // A reused cached view can still carry a previous navigation's
            // Extrakeyart logo; this runs once per navigation before the
            // rotation starts, so it removes that too. `parent` is posterEl's
            // parent, and querySelector searches its whole subtree.
            var staleLogoFromPreviousNav = parent.querySelector('.artworkplus-extrakeyart-logo');
            if (staleLogoFromPreviousNav) { staleLogoFromPreviousNav.remove(); }
            var computedPosition = getComputedStyle(parent).position;
            if (computedPosition === 'static') { parent.style.position = 'relative'; }

            function makeLayer() {
                var div = document.createElement('div');
                div.className = 'extraposter-layer';
                div.style.position = 'absolute';
                div.style.inset = '0';
                div.style.backgroundSize = 'cover';
                div.style.backgroundPosition = 'center';
                div.style.opacity = '0';
                div.style.zIndex = '1';
                div.style.transition = 'opacity ' + fadeMs + 'ms ease';
                div.style.pointerEvents = 'none';
                parent.appendChild(div);
                return div;
            }
            return [makeLayer(), makeLayer()];
        }

        // Called once per navigation, in parallel with Custom/Animated -
        // see startDetail() in the shared wiring section below.
        async function check(coord, itemId, posterEl, myGeneration) {
            var quickCheckPromise = fetch('/Extraposter/' + encodeURIComponent(itemId) + '/quickcheck' + webglQuery('?'), extraAuth({ cache: 'no-store' }))
                .then(function (r) { return r.json(); })
                .catch(function (e) { return { __fetchError: e }; });

            posterArbiterRegister(coord, 3);

            var quickCheck = await quickCheckPromise;
            if (myGeneration !== currentGeneration()) { return; }
            if (quickCheck.__fetchError) {
                log('Error fetching the quick check', quickCheck.__fetchError);
                posterArbiterDeclineNotApplicable(coord, 3);
                return;
            }
            if (!quickCheck.IsApplicable) {
                log('Not applicable per quick check (wrong type, disabled, or no posters found)');
                posterArbiterDeclineNotApplicable(coord, 3);
                return;
            }

            var hasDelay = !!quickCheck.DelayEnabled && quickCheck.DelayMs > 0;
            posterArbiterReserve(coord, 3, hasDelay);
            // No explicit reveal is needed for the Delay period:
            // posterArbiterRender() (via posterArbiterMaintainExtraBackdrop())
            // reads `hasDelay` from the participant record on every
            // recompute and shows a fallback; without a Delay it shows
            // nothing, so Main never flashes.

            var listResponse;
            try {
                listResponse = await fetch('/Extraposter/' + encodeURIComponent(itemId) + '?type=' + encodeURIComponent(quickCheck.ResolvedType), extraAuth({ cache: 'no-store' })).then(function (r) { return r.json(); });
            } catch (e) {
                log('Error fetching the poster list', e);
                posterArbiterWithdrawReservation(coord, 3);
                return;
            }
            if (myGeneration !== currentGeneration()) { return; }

            if (!listResponse.IsMovie) {
                log('Not a movie or ExtraPoster disabled, skipping');
                posterArbiterWithdrawReservation(coord, 3);
                return;
            }
            if (!Array.isArray(listResponse.Posters) || listResponse.Posters.length < 1) {
                log('No posters found after all, backing out', listResponse.Posters);
                posterArbiterWithdrawReservation(coord, 3);
                return;
            }

            // Set as soon as it is known; posterArbiterSyncLogo() decides
            // when it is shown, based on `renderedSource`.
            coord.participants[3].logo = (listResponse.ResolvedType === 'extrakeyart' && listResponse.LogoEnabled)
                ? {
                    itemId: itemId,
                    className: 'artworkplus-extrakeyart-logo',
                    verticalPercent: listResponse.LogoVerticalPositionPercent,
                    sizePercent: listResponse.LogoSizePercent
                }
                : null;
            posterArbiterSyncLogo(coord);

            var imageUrls = listResponse.Posters.map(function (entry) {
                if (entry.Url) { return entry.Url; } // a child poster (Set movie / season) - Jellyfin's own image
                return '/Extraposter/' + encodeURIComponent(itemId) + '/image/' + encodeURIComponent(entry.FileName)
                    + '?type=' + encodeURIComponent(listResponse.ResolvedType) + '&v=' + encodeURIComponent(entry.Version);
            });
            // A Set slide shown as Keyart may carry the movie's own
            // logo (PosterEntry.LogoItemId) - swapped per slide through the
            // shared logo overlay (participant 3's logo re-synced with the
            // slide's item; the logo of a slide without one is removed).
            var slideLogoItems = listResponse.Posters.map(function (entry) { return entry.LogoItemId || null; });
            var hasSlideLogos = slideLogoItems.some(function (x) { return !!x; });
            function syncSlideLogo(index) {
                if (!hasSlideLogos) { return; }
                var logoItem = slideLogoItems[index % slideLogoItems.length];
                var current = coord.participants[3].logo;
                if ((current && current.itemId) === logoItem) { return; }
                var parent0 = posterEl.parentElement;
                var old = parent0 && parent0.querySelector('.artworkplus-extrakeyart-logo');
                if (old) { old.remove(); }
                if (coord.activeLogoPriority === 3) { coord.activeLogoPriority = null; }
                coord.participants[3].logo = logoItem ? {
                    itemId: logoItem,
                    className: 'artworkplus-extrakeyart-logo',
                    verticalPercent: listResponse.SetLogoVerticalPositionPercent,
                    sizePercent: listResponse.SetLogoSizePercent
                } : null;
                posterArbiterSyncLogo(coord);
            }

            var parent = posterEl.parentElement;
            if (!parent) { posterArbiterWithdrawReservation(coord, 3); return; }

            posterEl.style.transition = 'opacity ' + listResponse.FadeTimeMs + 'ms ease';

            var delayMs = listResponse.DelayEnabled ? listResponse.DelayMs : 0;
            if (delayMs > 0) { log('Waiting', delayMs, 'ms delay before the first image is shown'); }
            preloadImage(imageUrls[0]).catch(function () {});
            await new Promise(function (resolve) { navTimers.track(setTimeout(resolve, delayMs)); });
            if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }

            var layers = createOverlayLayers(parent, listResponse.FadeTimeMs);
            var visibleIndex = -1;
            var slideIndex = 0;
            var consecutiveFailures = 0;
            var fadeInGeneration = 0;
            var arbiterNotified = false;
            var stopped = false;

            // Registered on coord so a generation change stops this
            // rotation's recurring timer, in addition to the myGeneration
            // checks guarding every continuation below.
            coord.extraRuntime = { cleanup: function () { stopped = true; } };

            async function showNext() {
                if (stopped || myGeneration !== currentGeneration() || !document.body.contains(posterEl)) {
                    // Logged: leaving here before the first image is painted
                    // leaves the poster slot empty (the card's own image is
                    // already hidden by this point).
                    log('showNext aborted:',
                        'stopped=', stopped,
                        'gen=', myGeneration, '/', currentGeneration(),
                        'posterElInDocument=', document.body.contains(posterEl),
                        'posterElClass=', posterEl && posterEl.className);
                    return;
                }

                if (listResponse.SinglePass && slideIndex >= imageUrls.length) {
                    var visibleLayer = visibleIndex === -1 ? null : layers[visibleIndex];
                    if (visibleLayer) { visibleLayer.style.opacity = '0'; }
                    posterArbiterWithdrawReservation(coord, 3);
                    arbiterNotified = true;
                    posterEl.style.opacity = '1';
                    log('Single-pass complete, handed back to the controller (next-highest-priority fallback, or Main)');
                    return;
                }

                var url = imageUrls[slideIndex % imageUrls.length];
                var slideNo = slideIndex;
                // Logged around the preload: if its promise never settled,
                // the rotation would stop here with the card's own poster
                // already hidden.
                log('preload start: slide', slideNo, String(url).slice(-42));
                try {
                    await preloadImage(url);
                    log('preload done: slide', slideNo);
                } catch (e) {
                    log('Poster skipped (load error)', e);
                    slideIndex++;
                    consecutiveFailures++;
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        var failedVisibleLayer = visibleIndex === -1 ? null : layers[visibleIndex];
                        if (failedVisibleLayer) { failedVisibleLayer.style.opacity = '0'; }
                        posterArbiterWithdrawReservation(coord, 3);
                        arbiterNotified = true;
                        posterEl.style.opacity = '1';
                        log('Giving up after', consecutiveFailures, 'consecutive failures - handed back to the controller');
                        return;
                    }
                    navTimers.track(setTimeout(showNext, 50));
                    return;
                }
                if (stopped || myGeneration !== currentGeneration()) {
                    // The last exit before the layer is painted; the log says
                    // which of the two reasons applied.
                    log('rotation stopped before painting:',
                        'stopped=', stopped,
                        'myGeneration=', myGeneration,
                        'currentGeneration=', currentGeneration(),
                        'slide=', slideNo, 'url=', String(url).slice(-48));
                    return;
                }
                consecutiveFailures = 0;

                var nextLayerIndex = visibleIndex === 0 ? 1 : 0;
                var nextLayer = layers[nextLayerIndex];
                var prevLayer = visibleIndex === -1 ? null : layers[visibleIndex];
                var myFadeGeneration = ++fadeInGeneration;
                var isFirstImageOfRotation = !arbiterNotified;

                nextLayer.style.backgroundImage = cssUrl(url);
                nextLayer.style.zIndex = '2';
                nextLayer.style.opacity = '0';
                void nextLayer.offsetWidth;
                syncSlideLogo(slideNo);
                if (prevLayer) {
                    prevLayer.style.zIndex = '1';
                    prevLayer.style.opacity = '0';
                }

                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        if (stopped || myGeneration !== currentGeneration()) { return; }
                        if (myFadeGeneration !== fadeInGeneration) { return; }
                        if (isFirstImageOfRotation) {
                            // Applies the pending-class removal (opacity
                            // 0->1) without a transition, so posterEl is at
                            // opacity:1 before the intended fade-to-0 below
                            // starts - otherwise Jellyfin's native image
                            // shows through for the transition's duration.
                            posterEl.style.transition = 'none';
                            posterArbiterMarkVisible(coord, 3, 'Winner');
                            void posterEl.offsetHeight;
                            posterEl.style.transition = 'opacity ' + listResponse.FadeTimeMs + 'ms ease';
                            arbiterNotified = true;
                        }
                        nextLayer.style.opacity = '1';
                        if (prevLayer === null) {
                            // Fade the original out in the same frame the
                            // first layer fades in.
                            posterEl.style.opacity = '0';
                            posterArbiterTrackObserver(coord, protectOpacityFromNativeFadeAnimation(posterEl));
                        }
                    });
                });

                visibleIndex = nextLayerIndex;
                slideIndex++;
                navTimers.track(setTimeout(showNext, listResponse.CycleTimeMs));
            }

            log('Starting rotation with', imageUrls.length, 'posters, order:', listResponse.OrderMode,
                '| Cycle:', listResponse.CycleTimeMs, 'ms, Fade:', listResponse.FadeTimeMs, 'ms',
                '| SinglePass:', listResponse.SinglePass);
            // Waiting until the decision is no longer pending means every
            // applicable lower priority has reported its url, and
            // posterArbiterRender() has put it into the backdrop, so
            // posterEl's background-image is correct before the crossfade's
            // first frame.
            var settled = await waitFor(function () { return posterArbiterIsDecisionPending(coord) ? null : true; }, 5000);
            // Logged: the card's own poster is already hidden, so leaving
            // here leaves the poster slot empty.
            if (stopped || myGeneration !== currentGeneration() || !document.body.contains(posterEl)) {
                log('rotation never started:',
                    'waitForSettled=', settled,
                    'decisionPending=', posterArbiterIsDecisionPending(coord),
                    'winner=', coord.decision && coord.decision.logicalWinner,
                    'stopped=', stopped,
                    'gen=', myGeneration, '/', currentGeneration(),
                    'posterElInDocument=', document.body.contains(posterEl),
                    'posterElClass=', posterEl && posterEl.className);
                return;
            }
            showNext();
        }

        // -----------------------------------------------------------------
        // Library view - participant 3 of the tile arbiter (LibraryTiles
        // above). The overlay slideshow works as on the detail page (two
        // layers, crossfade, Delay, Single Pass, one synchronized clock per
        // tile type); what the arbiter decides:
        // whether this tile is Extra's at all, what lies underneath (the
        // next-lower participant's image or Jellyfin's poster) and when
        // the tile is revealed (Delay: at once; no Delay: with the first
        // overlay image, in the same frame).
        //
        // Layers live INSIDE .cardImageContainer as its first children,
        // without z-index (card.scss/cardBuilder.js, verified): Jellyfin's
        // indicators and progress bar (z-index 1, later children) and the
        // hover menu (.cardOverlayContainer, a later sibling) keep painting
        // above them, the blurhash canvas (an earlier sibling) below.
        // Activation window = Jellyfin's own lazy-load window (50%).
        // -----------------------------------------------------------------

        var libLog = Core.makeLogger('[PostersPlus/Extra/Library]', DEBUG);
        var LIB_PRIORITY = 3;
        var LIB_FETCH_DEBOUNCE_MS = 20;
        var LIB_BATCH_CHUNK = 200;

        function libPreloadImage(url) {
            return Core.preloadImage(url, { timeoutMs: PRELOAD_TIMEOUT_MS });
        }

        // "Also on": answers are per page class - the same
        // item may be allowed on the Home row and refused on a genre list.
        // Keys are page + '|' + itemId; batches go out per page class.
        var resultCache = {};
        var pendingByPage = {};
        var pendingCards = {};
        var pendingFetchTimer = null;
        var activeTiles = new Map();
        if (diagnostics) { diagnostics.tiles = activeTiles; }


        function libAnswerFor(key) {
            var result = resultCache[key];
            var itemId = key.slice(key.indexOf('|') + 1);
            if (!result || !result.IsMovie || !Array.isArray(result.Posters) || result.Posters.length < 1) { return null; }
            var resolvedType = result.ResolvedType || 'extraposter';
            return {
                urls: result.Posters.map(function (entry) {
                    if (entry.Url) { return entry.Url; } // child poster
                    return '/Extraposter/' + encodeURIComponent(itemId) + '/image/' + encodeURIComponent(entry.FileName)
                        + '?type=' + encodeURIComponent(resolvedType) + '&v=' + encodeURIComponent(entry.Version);
                }),
                // Per-slide logos of a Set's Keyart slides (movie's own logo), null for the others
                slideLogos: result.Posters.map(function (entry) {
                    return entry.LogoItemId ? { vertical: result.SetLogoVerticalPositionPercent, size: result.SetLogoSizePercent, hasLogo: true, itemId: entry.LogoItemId } : null;
                }),
                delayMs: result.DelayEnabled ? result.DelayMs : 0,
                cycleMs: result.CycleTimeMs,
                fadeMs: result.FadeTimeMs,
                singlePass: !!result.SinglePass,
                sync: !!result.SyncEnabled,
                seamless: !!result.SeamlessEnabled,
                logo: result.LogoEnabled ? { vertical: result.LogoVerticalPositionPercent, size: result.LogoSizePercent, hasLogo: !!result.HasLogo } : null,
                resolvedType: resolvedType
            };
        }

        function libCollect(card, itemId) {
            var page = pageClassOf(card);
            var key = page + '|' + itemId;
            if (key in resultCache) { LibraryTiles.report(card, LIB_PRIORITY, libAnswerFor(key)); return; }
            (pendingCards[key] = pendingCards[key] || []).push(card);
            LibraryTiles.markInFlight(card, +1);
            var ids = pendingByPage[page] = pendingByPage[page] || [];
            if (ids.indexOf(itemId) === -1) { ids.push(itemId); }
            if (!pendingFetchTimer) { pendingFetchTimer = setTimeout(function () { pendingFetchTimer = null; libFlush(); }, LIB_FETCH_DEBOUNCE_MS); }
        }

        function libReportAll(page, ids) {
            ids.forEach(function (id) {
                var key = page + '|' + id;
                var cards = pendingCards[key] || [];
                delete pendingCards[key];
                var answer = libAnswerFor(key);
                cards.forEach(function (card) { LibraryTiles.markInFlight(card, -1); LibraryTiles.report(card, LIB_PRIORITY, answer); });
                if (answer) { libLog('applicable for tile', id, '| page:', page, '| images:', answer.urls.length, '| delay:', answer.delayMs); }
            });
        }

        function libFlush() {
            var byPage = pendingByPage;
            pendingByPage = {};
            Object.keys(byPage).forEach(function (page) { libFlushPage(page, byPage[page]); });
        }

        // One batch per page class - the server's "Also on"
        // filter needs the class, and a Home page can hold Latest,
        // Continue Watching and Favorites cards at once.
        function libFlushPage(page, ids) {
            if (!ids.length) { return; }
            var chunks = [];
            for (var i = 0; i < ids.length; i += LIB_BATCH_CHUNK) { chunks.push(ids.slice(i, i + LIB_BATCH_CHUNK)); }
            Promise.all(chunks.map(function (chunk) {
                return fetch('/Extraposter/batch?ids=' + chunk.map(encodeURIComponent).join(',') + '&scope=library&page=' + encodeURIComponent(page), extraAuth({}))
                    .then(function (r) { return r.json(); })
                    .then(function (batchResponse) {
                        var items = batchResponse.Items || {};
                        // Keys are the tile's data-id form already (Guid "N").
                        Object.keys(items).forEach(function (id) { resultCache[page + '|' + id] = items[id]; });
                        chunk.forEach(function (id) { if (!((page + '|' + id) in resultCache)) { resultCache[page + '|' + id] = null; } });
                    })
                    .catch(function (e) {
                        libLog('Error during the batch request', e);
                        chunk.forEach(function (id) { if (!((page + '|' + id) in resultCache)) { resultCache[page + '|' + id] = null; } });
                    });
            })).then(function () { libReportAll(page, ids); });
        }

        function libCreateOverlayLayers(imageContainer, fadeMs) {
            imageContainer.querySelectorAll('.extraposter-lib-layer').forEach(function (el) { el.remove(); });
            function makeLayer() {
                var div = document.createElement('div');
                div.className = 'extraposter-lib-layer';
                div.style.position = 'absolute';
                div.style.inset = '0';
                div.style.backgroundSize = 'cover';
                div.style.backgroundPosition = 'center';
                div.style.opacity = '0';
                div.style.transition = 'opacity ' + fadeMs + 'ms ease';
                div.style.pointerEvents = 'none';
                imageContainer.insertBefore(div, imageContainer.firstChild);
                return div;
            }
            var a = makeLayer();
            var b = makeLayer();
            return [a, b];
        }

        // instant=true: the first image of a held (no-Delay) tile appears in
        // the same frame the arbiter reveals the tile - no crossfade over a
        // base that was never meant to be seen.
        function showLayer(tile, url, instant) {
            return libPreloadImage(url).then(function () {
                if (!tile.active) { return; }
                var nextLayerIndex = tile.visibleIndex === 0 ? 1 : 0;
                var nextLayer = tile.layers[nextLayerIndex];
                var prevLayer = tile.visibleIndex === -1 ? null : tile.layers[tile.visibleIndex];
                var myGeneration = ++tile.fadeInGeneration;
                nextLayer.style.backgroundImage = cssUrl(url);
                // The incoming layer must paint above the outgoing one:
                // both are position:absolute without z-index, so DOM order
                // decides - move the incoming layer after the outgoing one.
                if (prevLayer && prevLayer.nextSibling !== nextLayer) { prevLayer.parentNode.insertBefore(nextLayer, prevLayer.nextSibling); }
                if (instant) {
                    nextLayer.style.transition = 'none';
                    nextLayer.style.opacity = '1';
                    void nextLayer.offsetWidth;
                    nextLayer.style.transition = 'opacity ' + tile.fadeMs + 'ms ease';
                    if (prevLayer) { prevLayer.style.opacity = '0'; }
                    tile.visibleIndex = nextLayerIndex;
                    return;
                }
                nextLayer.style.opacity = '0';
                void nextLayer.offsetWidth;
                // Fade-out and fade-in start in the SAME frame: with equal
                // easing their opacities always sum to ~1, so the base image
                // underneath never shows through a crossfade.
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        if (!tile.active) { return; }
                        if (myGeneration !== tile.fadeInGeneration) { return; }
                        if (prevLayer) { prevLayer.style.opacity = '0'; }
                        nextLayer.style.opacity = '1';
                    });
                });
                tile.visibleIndex = nextLayerIndex;
            });
        }

        // -----------------------------------------------------------------
        // Two clock modes. In both, the first image appears as soon as its
        // Delay is over and it is decoded, and a change needs (a) the tile to
        // have stood a full Display duration and (b) its next image decoded -
        // rather too late than too early, and never alone:
        //   sync off: every tile checks its own rules on its own interval.
        //   sync on:  ONE free-running page clock per (feature type, tile
        //             type), period = Display duration, started by the first
        //             joined tile. At a tick every due tile changes in the
        //             SAME frame; a tile that is not due stays and tries at
        //             the next tick - so a late tile stands 6-9 s instead of
        //             fading 1-2 s after it appeared, or fading alone later.
        // -----------------------------------------------------------------

        var clocks = {}; // key -> { periodMs, epoch, timer, n }
        if (diagnostics) { diagnostics.clocks = clocks; }

        // One beat per (tile type, Display duration) - Extraposter and
        // Extrakeyart tiles with the same duration share a clock and change
        // together; different durations run their own clocks.
        function clockKey(tile) { return tile.type + '|' + tile.cycleMs; }

        // The next image is fetched right after every change and its
        // arrival is recorded as a flag - a change only ever happens with a
        // decoded image at hand (never a late lone fade).
        function prefetchNext(tile) {
            tile.nextReady = false;
            tile.nextUrl = null;
            if (tile.urls.length < 2) { return; }
            if (tile.singlePass && tile.slideIndex >= tile.urls.length) { return; }
            var url = tile.urls[tile.slideIndex % tile.urls.length];
            tile.nextUrl = url;
            tile.prefetchStartedAt = performance.now();
            Core.preloadImage(url, { timeoutMs: PRELOAD_TIMEOUT_MS })
                .then(function () { if (tile.active && tile.nextUrl === url) { tile.nextReady = true; tile.nextReadyAt = performance.now(); } })
                .catch(function (e) {
                    // Skip the broken file, try the one after it at the next chance.
                    libLog('Image skipped (load error)', tile.id, e);
                    if (tile.active && tile.nextUrl === url) { tile.slideIndex++; prefetchNext(tile); }
                });
        }

        // Prepares the incoming layer of a tile (image already decoded) -
        // no opacity change yet, that happens for all tiles of a tick in
        // ONE frame (commitSwitches).
        function prepareSwitch(tile) {
            var nextLayerIndex = tile.visibleIndex === 0 ? 1 : 0;
            var nextLayer = tile.layers[nextLayerIndex];
            var prevLayer = tile.visibleIndex === -1 ? null : tile.layers[tile.visibleIndex];
            nextLayer.style.backgroundImage = cssUrl(tile.nextUrl);
            if (prevLayer && prevLayer.nextSibling !== nextLayer) { prevLayer.parentNode.insertBefore(nextLayer, prevLayer.nextSibling); }
            nextLayer.style.opacity = '0';
            void nextLayer.offsetWidth;
            tile.visibleIndex = nextLayerIndex;
            tile.slideIndex++;
            return { next: nextLayer, prev: prevLayer };
        }

        function commitSwitches(switches, tiles) {
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    switches.forEach(function (sw, i) {
                        var tile = tiles[i];
                        if (!tile.active) { return; }
                        if (sw.prev) { sw.prev.style.opacity = '0'; }
                        sw.next.style.opacity = '1';
                        if (sw.logo !== undefined) { LibraryTiles.syncTileLogo(tile.st, sw.logo); }
                    });
                });
            });
        }

        // Play once: after the last image the overlay fades away for good.
        function finishTile(tile) {
            var visibleLayer = tile.visibleIndex === -1 ? null : tile.layers[tile.visibleIndex];
            if (visibleLayer) { visibleLayer.style.opacity = '0'; }
            tile.finished = true;
            if (tile.timer) { clearInterval(tile.timer); tile.timer = null; }
        }

        // A tile may change when it has stood at least one Display duration
        // (rather 6-9 s than 1-2 s) and its next image is decoded. Play once
        // ends the same way.
        function switchDue(tile, now) {
            if (!tile.active || !tile.joined || tile.finished || tile.urls.length < 2) { return false; }
            // shownAt is the LOGICAL time of the last change (the tick, not the
            // frame it was painted in - a heavy frame can lag 100-200 ms and
            // would otherwise make every tile miss every second tick).
            if (now - tile.shownAt < tile.cycleMs - Math.min(250, tile.cycleMs * 0.05)) { return false; }
            if (tile.singlePass && tile.slideIndex >= tile.urls.length) { return true; }
            return tile.nextReady;
        }

        // The logo of a slide: the Set movie's own (Keyart slide) if the
        // server marked one, else the tile's feature logo (Extrakeyart).
        function tileLogoFor(tile, slideNo) {
            var perSlide = tile.slideLogos[slideNo % tile.urls.length];
            return perSlide || (tile.slideLogos.some(function (x) { return !!x; }) ? null : tile.logo);
        }

        function stepTile(tile, now) {
            if (tile.singlePass && tile.slideIndex >= tile.urls.length) { finishTile(tile); return null; }
            var shownNo = tile.slideIndex % tile.urls.length;
            var sw = prepareSwitch(tile);
            sw.logo = tileLogoFor(tile, shownNo); // applied in the same frame as the switch (commitSwitches)
            tile.shownAt = now;
            prefetchNext(tile);
            return sw;
        }

        // Independent mode: the tile's own interval, same rules per tile.
        function ownTick(tile) {
            if (!document.body.contains(tile.el)) { deactivateTile(tile.el); return; }
            var now = performance.now();
            if (!switchDue(tile, now)) { return; }
            var sw = stepTile(tile, now);
            if (sw) { commitSwitches([sw], [tile]); }
        }

        // The first appearance: as soon as the Delay is over and the first
        // image is decoded - in both modes (waiting for a tick here looks
        // like a loading hitch). instant = the tile was held.
        function firstShow(tile) {
            var st = tile.st;
            var hold = st.holdForOverlay;
            tile.slideIndex = 1;
            return showLayer(tile, tile.urls[0], hold).then(function () {
                if (!tile.active) { return; }
                tile.joined = true;
                tile.shownAt = performance.now();
                if (hold) { LibraryTiles.release(st); }
                LibraryTiles.syncTileLogo(st, tileLogoFor(tile, 0));
                prefetchNext(tile);
                if (tile.sync) { ensureClock(clockKey(tile), tile.cycleMs); }
                else if (tile.urls.length > 1) { tile.timer = setInterval(function () { ownTick(tile); }, Math.max(250, Math.min(1000, tile.cycleMs / 5))); }
            });
        }

        // Sync mode: one free-running page clock per (feature type, tile
        // type), ticking every Display duration from the first joined tile.
        // At a tick every tile that is due (stood a full Display duration,
        // next image decoded) changes - all in the same frame; the others
        // stay and try at the next tick. Nothing ever changes alone or late.
        function ensureClock(key, periodMs) {
            if (clocks[key]) { return clocks[key]; }
            var clock = { periodMs: periodMs, epoch: performance.now(), n: 0, timer: null };
            clocks[key] = clock;
            libLog('Page clock', key, 'started, period:', periodMs, 'ms');
            scheduleTick(key);
            return clock;
        }

        function scheduleTick(key) {
            var clock = clocks[key];
            if (!clock) { return; }
            clock.n++;
            var due = clock.epoch + clock.n * clock.periodMs - performance.now();
            clock.timer = setTimeout(function () { tick(key); }, Math.max(0, due));
        }

        function tick(key) {
            var clock = clocks[key];
            if (!clock) { return; }
            var now = performance.now();
            var alive = 0;
            var switches = [], tiles = [];
            activeTiles.forEach(function (tile) {
                if (!tile.sync || clockKey(tile) !== key) { return; }
                if (!document.body.contains(tile.el)) { deactivateTile(tile.el); return; }
                alive++;
                if (!switchDue(tile, now)) {
                    if (tile.joined && !tile.finished && tile.urls.length > 1) {
                        libLog('tick', key, 'tile', tile.id.slice(0, 6), 'stays: stood', Math.round(now - tile.shownAt), 'ms of', tile.cycleMs, '| next ready:', tile.nextReady);
                    }
                    return;
                }
                var sw = stepTile(tile, now);
                if (sw) { switches.push(sw); tiles.push(tile); }
            });
            if (switches.length) { commitSwitches(switches, tiles); }
            if (!alive) { delete clocks[key]; libLog('Page clock', key, 'stopped (no tiles)'); return; }
            scheduleTick(key);
        }

        function activateTile(st) {
            var cardEl = st.card;
            if (activeTiles.has(cardEl)) { return; }
            var answer = st.answers[LIB_PRIORITY];
            if (!answer) { return; }
            var layers = libCreateOverlayLayers(st.container, answer.fadeMs);
            var tile = {
                id: st.itemId, el: cardEl, st: st, type: st.type, resolvedType: answer.resolvedType, layers: layers, urls: answer.urls,
                fadeMs: answer.fadeMs, cycleMs: answer.cycleMs, sync: answer.sync, logo: answer.logo, slideLogos: answer.slideLogos || [],
                slideIndex: 0, visibleIndex: -1, singlePass: answer.singlePass,
                finished: false, joined: false, active: true, fadeInGeneration: 0,
                timer: null, shownAt: 0, nextUrl: null, nextReady: false
            };
            activeTiles.set(cardEl, tile);
            if (st.holdForOverlay) {
                // No Delay: nothing underneath is meant to show - keep (or
                // put back) the blurhash until the first image is decoded.
                LibraryTiles.setPending(st);
                LibraryTiles.armSafety(st);
            }
            function firstFailed(e) {
                libLog('First image failed for tile', tile.id, '- withdrawing', e);
                deactivateTile(cardEl);
                LibraryTiles.withdraw(cardEl, LIB_PRIORITY);
            }
            setTimeout(function () {
                if (!tile.active) { return; }
                firstShow(tile).catch(firstFailed);
            }, answer.delayMs);
        }

        function deactivateTile(cardEl) {
            var tile = activeTiles.get(cardEl);
            if (!tile) { return; }
            tile.active = false;
            if (tile.timer) { clearInterval(tile.timer); tile.timer = null; }
            tile.layers.forEach(function (l) { l.remove(); });
            LibraryTiles.syncTileLogo(tile.st, null);
            activeTiles.delete(cardEl);
        }

        var libObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                var st = LibraryTiles.stateFor(entry.target);
                if (!st) { return; }
                st.overlayNear = entry.isIntersecting;
                if (entry.isIntersecting) {
                    if (st.decided && st.winner === LIB_PRIORITY) { activateTile(st); }
                } else {
                    deactivateTile(entry.target);
                }
            });
        }, { root: null, rootMargin: '50%', threshold: 0 });

        LibraryTiles.register(LIB_PRIORITY, {
            collect: function (card, itemId) { libObserver.observe(card); libCollect(card, itemId); },
            apply: function (st) { if (st.overlayNear) { activateTile(st); } },
            revoke: function (st) { deactivateTile(st.card); }
        });

        // No viewshow reset: a view Jellyfin restores from its cache keeps
        // its tiles (and their overlays); tiles of a discarded view are
        // dropped by the document.body checks in ownTick()/tick(),
        // and a page clock with no tiles left stops itself.

        return { check: check, priority: 3 };
    })();

    // =====================================================================
    // Case (Case Mod tab). Independent of the poster arbiter: the case
    // overlay applies on top of whatever is in the poster slot, whichever
    // source won it - no reservation, no priority, no waiting for a
    // decision, just "is this item applicable, and where does the texture
    // go".
    //
    // Positioning: percentage-of-parent CSS only (left/top/width/height in
    // %, tied to the same .cardImageContainer the poster lives in), so the
    // case stays fixed to the poster: a CSS percentage follows its parent's
    // box on every resize/zoom without a JS resize listener - the same
    // technique as the Keyart/Extrakeyart logo overlays.
    // ==================================================================
    // THREE.JS CASE - the decision, not the renderer.
    // ==================================================================
    // Lives in this file because it is a case type competing for the same
    // poster slot as CaseMod / Custom / Animated / Extra, and the arbiter is
    // here.
    //
    // Not here: the ported upstream renderer (kept verbatim to diff against
    // upstream) and three.js itself (603 KB). Both load on demand from
    // /ThreejsCase/lib/... once this module has decided "yes", so a page
    // without a Three.js case pays nothing for them.
    //
    // The order of the decision matters: nothing may be hidden or held
    // back before we know a case is coming. Everything
    // that can say "no" is asked first, and all of it is synchronous except
    // the last step:
    //   1. feature on?      window.ArtworkPlusThreejs.enabled - a server flag
    //                       in <head>, so this costs no request
    //   2. real browser?    embedded clients out; the desktop Media Player
    //                       stays in, because step 3 is the honest test
    //   3. WebGL?           a probe canvas - measured, not guessed from the
    //                       user agent
    //   4. what to build?   GET /ThreejsCase/{id}, only once 1-3 passed, and
    //                       in parallel with CaseMod's own request so the
    //                       flat case is not delayed by us
    // If anything says no, this module never touches the page and the flat
    // case type renders as usual. That is the fallback, and it is the
    // normal path, not an error path.
    //
    // WHY THE CLIENT DECIDES AND NOT THE SERVER: the server cannot know
    // whether this browser has WebGL. If it simply answered "no flat case for
    // movies" while the feature is on, a viewer without WebGL would end up
    // with nothing instead of the flat case.
    /// THE ONE OPEN / SPIN / CLOSE TIMELINE, SHARED BY BOTH CASE KINDS.
    ///
    /// It has no 2D or ThreeJs in its name on purpose: both kinds run this
    /// single timeline, so their timings match. Everything that is
    /// kind-specific says so - CASE2D_* inside CaseModModule, THREEJS_* inside
    /// ThreejsCaseModule.
    ///
    /// The numbers are the flat case type's own, read out of its source rather
    /// than chosen: it opens over 1000 ms, the disc turns from 1500 to 3650
    /// (2150 ms, one revolution), the lid closes at 4850 and the whole thing is
    /// over at 5850. The 2D side declares the same numbers as CSS keyframe
    /// percentages, derived from these below - one place to change a timing.
    var CASE_CYCLE = {
        MS: 5850,
        OPEN_MS: 1000,
        DISC_AT: 1500,
        DISC_MS: 2150,
        CLOSE_AT: 4850,
        CLOSE_MS: 1000,
        TURNS: 1
    };

    var ThreejsCaseModule = (function () {
        // makeLogger(tag, debugEnabled) - the second argument is the switch;
        // without it the logger is a no-op.
        var log = Core.makeLogger('[PostersPlus/ThreejsCase]', DEBUG);
        var webglAnswer = null;

        function featureOn() {
            var flags = window.ArtworkPlusThreejs;
            return !!(flags && flags.enabled);
        }

        function isWebBrowser() {
            try {
                if (window.NativeShell && window.NativeShell.AppHost) {
                    var name = '';
                    try { name = String(window.NativeShell.AppHost.appName() || ''); } catch (e) { name = ''; }
                    // Jellyfin Media Player stays in (Chromium/QtWebEngine);
                    // TV shells are out - they load the web client but have
                    // neither the GPU nor a pointer for the gestures.
                    if (name && !/media\s*player/i.test(name)) {
                        log('off - embedded client "' + name + '"');
                        return false;
                    }
                }
                return true;
            } catch (e) {
                return true;
            }
        }

        // Measured, not guessed. The probe canvas is never attached, and its
        // context is released immediately - a probe must not hold one of the
        // browser's limited WebGL contexts for the rest of the page.
        function hasWebGL() {
            if (webglAnswer !== null) { return webglAnswer; }
            webglAnswer = false;
            try {
                var c = document.createElement('canvas');
                var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
                webglAnswer = !!(gl && typeof gl.getParameter === 'function');
                if (gl && gl.getExtension) {
                    var lose = gl.getExtension('WEBGL_lose_context');
                    if (lose) { lose.loseContext(); }
                }
            } catch (e) {
                webglAnswer = false;
            }
            return webglAnswer;
        }

        /// Returns a promise for the item's Three.js answer, or null when one
        /// of the synchronous gates already said no. Called by CaseMod.check()
        /// BEFORE its own fetch, so both requests are in flight together.
        function claimFor(itemId) {
            // Every synchronous no releases the hold AND forgets the
            // expectation: a browser without WebGL must not hide its poster on
            // every page it opens from here on.
            if (!featureOn()) { pendingRemember(false); pendingRelease(); return null; }
            if (!isWebBrowser()) { pendingRemember(false); pendingRelease(); return null; }
            if (!hasWebGL()) {
                log('off - no WebGL in this browser, the flat case type stays');
                pendingRemember(false);
                pendingRelease();
                return null;
            }
            return fetch('/ThreejsCase/' + encodeURIComponent(itemId) + webglQuery('?'), { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .then(function (r) {
                    if (!r || !r.Enabled) {
                        log('no case for ' + itemId + ' (' + ((r && r.Reason) || 'unknown') + ') - the flat case type stays');
                        // The feature is on, this ITEM just has no case (a
                        // series, a set). The expectation stays, the hold goes.
                        pendingRelease();
                        return null;
                    }
                    pendingRemember(true);
                    return r;
                })
                .catch(function (e) {
                    log('endpoint failed for ' + itemId + ' - the flat case type stays', e);
                    pendingRelease();
                    return null;
                });
        }

        // ---- the coordinate frame -------------------------------------
        // Measured through one function, as for the flat 3D case: the DESIGN
        // FRAME is the layout at scroll 0. getBoundingClientRect() alone is
        // viewport-relative, so anything built from it would move with the
        // scroll position.
        function measureDesignRect(el) {
            var r = el.getBoundingClientRect();
            var dx = window.scrollX || window.pageXOffset || 0;
            var dy = window.scrollY || window.pageYOffset || 0;
            var viewportScroller = document.scrollingElement || document.documentElement;
            for (var n = el.parentElement; n; n = n.parentElement) {
                if (n === viewportScroller || n === document.documentElement || n === document.body) { continue; }
                if (n.scrollTop) { dy += n.scrollTop; }
                if (n.scrollLeft) { dx += n.scrollLeft; }
            }
            return { left: r.left + dx, top: r.top + dy, width: r.width, height: r.height };
        }

        // ---- the case in millimetres ----------------------------------
        // A real Blu-ray keep case; the DVD shell is taller. Everything the
        // scene does is expressed in these units, so "size" stays a property
        // of the OBJECT and never of the camera distance or the window.
        var CASE_MM = {
            bluray: { w: 135, h: 171.5, d: 14, color: 0x003986 },
            dvdgen: { w: 135, h: 190, d: 14, color: 0x1c1c1e }
        };
        var CASE_BLACK = 0x1c1c1e;

        // Where front and back sit on the cover wrap, in UV space. Measured in
        // the model by upstream and copied unchanged - these are properties of
        // the mesh, not numbers anyone may round.
        var WRAP = {
            bluray: { front: { u0: 0.5332, u1: 0.9510, v0: 0.0299, v1: 0.4936 },
                      back:  { u0: 0.0469, u1: 0.4648, v0: 0.0299, v1: 0.4936 } },
            dvd:    { front: { u0: 0.5445, u1: 0.9583, v0: 0.0544, v1: 0.6531 },
                      back:  { u0: 0.0419, u1: 0.4557, v0: 0.0544, v1: 0.6531 } }
        };
        // Wrap texture width, chosen per mount. Upstream paints at 4096; 2048
        // saves memory and is enough where the poster is small on screen.
        // The height is the binding edge: the poster's v range is
        // 0.0299..0.4936, so 2048 gives it 950 px - for a 1440 px target that
        // is a visible 1.52x upscale. Only where the poster is rendered larger
        // than the texture does it go to 4096.
        var WRAP_W = 2048;
        var WRAP_W_MAX = 4096;
        function wrapWidthFor(rects, posterDevicePx) {
            if (!rects || !rects.front || !posterDevicePx) { return WRAP_W; }
            var vSpan = rects.front.v1 - rects.front.v0;
            var uSpan = rects.front.u1 - rects.front.u0;
            if (!(vSpan > 0) || !(uSpan > 0)) { return WRAP_W; }
            var need = Math.max(posterDevicePx.h / vSpan, posterDevicePx.w / uSpan);
            return need > WRAP_W ? WRAP_W_MAX : WRAP_W;
        }

        // No fixed canvas factor: the canvas has to hold a SPHERE about the
        // pivot, and applyAspect reshapes the case to the poster (3.71 for a
        // 2:3 poster, 3.96 for a 1:2 one). See measureRadius().

        var HOLD_CLASS = 'artworkplus-threejs-hold';
        var CANVAS_CLASS = 'artworkplus-threejs-canvas';
        // The largest backing store a case may allocate, per edge.
        //
        // At Case size 100 the canvas is about 2250 CSS px; at a device pixel
        // ratio of 2 that is 4500. 4608 covers 2304 CSS px at ratio 2 without
        // lowering the ratio (which renders the case softer than Jellyfin's
        // poster beside it). It matters most with zoom: `side` already carries
        // the zoom headroom (k = tanHalf / (1 + zoomCap)), so a zoomed-in case
        // reads its sharpness straight off this buffer. The cap still stops
        // Poster size 200 % from asking for a 9000 px edge.
        //
        // The canvas is this large only to hold the case in its OPEN pose
        // (measureRadius(): 56.1 at 120 degrees against 44.3 closed).
        var THREEJS_BUFFER_CAP_PX = 4608;

        // Where the cover window sits inside the poster box. Same ten values
        // and the same meaning as the flat case's anchor, so that switching
        // between the two case kinds changes nothing but the case. 'Default'
        // is the centre here - not the flat case's Jellyfin anchor, because a
        // 3D case has no Jellyfin anchor to inherit.
        var CASE_ANCHORS = {
            TopLeft: [0, 0], TopCenter: [0.5, 0], TopRight: [1, 0],
            CenterLeft: [0, 0.5], Center: [0.5, 0.5], CenterRight: [1, 0.5],
            BottomLeft: [0, 1], BottomCenter: [0.5, 1], BottomRight: [1, 1]
        };
        var HIT_CLASS = 'artworkplus-threejs-hit';
        var BEHIND_CLASS = 'artworkplus-threejs-behind';
        // The flat poster must never be seen, not even for a frame. Deciding
        // that at mount is far too late: three.js (603 KB), the mesh (0.97 MB),
        // the textures and the poster all load first, and the vanilla card
        // stands there the whole time. So the hold starts at `viewshow` -
        // before the card even exists - out of a remembered answer, the same
        // way the flat 3D case's tilt hold does it. What is
        // remembered is only "a case was expected here last time", never an
        // item: the real decision arrives moments later and releases the hold
        // if it says no.
        var PENDING_CLASS = 'artworkplus-threejs-pending';
        var PENDING_STORAGE_KEY = 'ArtworkPlusThreejsCase';
        // Long enough for a cold load over a slow link (engine + mesh are 1.5 MB
        // together), short enough that a genuine hang does not leave a page
        // without its poster. It is a net, not a schedule - every normal path
        // releases the hold itself.
        var PENDING_NET_MS = 8000;
        var pending = { view: null, timer: null, styleInjected: false };
        // The hook for a tint we moved onto its own layer. An attribute, not a
        // list of selectors: which containers carry the page's tint is a
        // question for the live page, not for a hard-coded guess about a theme.
        var TINT_ATTR = 'data-artworkplus-threejs-tint';
        // A press that never moves more than this is a click, not a drag. Five
        // pixels is the width of an unintended tremor, not of an intention.
        var CLICK_SLOP = 5;
        // How far the wheel may take the case from the size the settings ask
        // for, as a fraction, the same either way. The canvas is built for the
        // upper end from the start - a zoom that outgrows its canvas is a case
        // with its corners cut off, and the canvas cannot be resized mid-turn
        // without moving everything it is measured against.
        // A range of 0 is a legal setting and means the wheel does nothing - a
        // way to switch the zoom off while the Zoom switch stays ticked.
        // Turns per minute, by name, into radians per second. Named rather
        // than numeric in the config because that is how every other choice on
        // this tab reads - and because "2" alone says nothing about the unit.
        var ROTATE_RPM = { VerySlow: 0.5, Slow: 1, Medium: 2, Fast: 3, VeryFast: 4 };

        function rotateRadPerSecond(answer) {
            // An unknown word falls back to Medium (the setting's default).
            var rpm = ROTATE_RPM[answer && answer.RotateSpeed] || ROTATE_RPM.Medium;
            return rpm * 2 * Math.PI / 60;
        }

        function zoomCapOf(answer) {
            var z = answer && answer.Zoom;
            if (!z || !z.Enabled) { return 0; }
            var r = Number(z.Range);
            if (!isFinite(r) || r <= 0) { return 0; }
            return Math.min(100, r) / 100;
        }
        var stylesInjected = false;
        var threePromise = null;
        var mounted = null;

        function pendingExpected() {
            if (caseMixOn()) { return featureOn(); } // no guessing under the mix
            try { return localStorage.getItem(PENDING_STORAGE_KEY) === '1'; } catch (e) { return false; }
        }

        function pendingRemember(yes) {
            try { localStorage.setItem(PENDING_STORAGE_KEY, yes ? '1' : '0'); } catch (e) { /* private mode */ }
        }

        function pendingHold(view) {
            if (!view) { return; }
            if (!pending.styleInjected) {
                pending.styleInjected = true;
                var st = document.createElement('style');
                st.id = 'artworkplus-threejs-pending';
                st.textContent = '.itemDetailPage.' + PENDING_CLASS
                    + ' .detailImageContainer .cardScalable{visibility:hidden!important}';
                document.head.appendChild(st);
            }
            pendingRelease();
            pending.view = view;
            view.classList.add(PENDING_CLASS);
            pending.timer = setTimeout(function () {
                log('the case did not arrive in time - the vanilla poster is released');
                pendingRelease();
            }, PENDING_NET_MS);
        }

        function pendingRelease() {
            if (pending.timer) { clearTimeout(pending.timer); pending.timer = null; }
            var view = pending.view;
            pending.view = null;
            if (view) { view.classList.remove(PENDING_CLASS); }
            // Any other page that still carries it (a navigation that raced us).
            document.querySelectorAll('.itemDetailPage.' + PENDING_CLASS).forEach(function (el) {
                el.classList.remove(PENDING_CLASS);
            });
        }

        function ensureStyles() {
            if (stylesInjected) { return; }
            stylesInjected = true;
            var st = document.createElement('style');
            st.id = 'artworkplus-threejs-styles';
            st.textContent =
                // The vanilla poster is hidden, never removed: visibility keeps
                // its box, so the page layout does not shift by a single pixel
                // when the case takes over (and display:none would zero every
                // rect we measure).
                '.itemDetailPage.' + HOLD_CLASS + ' .detailImageContainer .cardScalable{visibility:hidden!important}' +
                // The vanilla card is hidden but still ANSWERS the pointer, and
                // Jellyfin gives it z-index 3 of its own (librarybrowser.scss:854,
                // `.detailImageContainer .card`), so our hit box could never win
                // against it. Disabling it is safe: renderDetailImage() in
                // controllers/itemDetails/index.js only sets innerHTML and starts
                // the lazy loader, the card carries no handler and no action. An
                // element nobody can see must not take clicks either.
                '.itemDetailPage.' + HOLD_CLASS + ' .detailImageContainer .card{pointer-events:none!important}' +

                // ---- Case layer: In front ---------------------------------
                // Nothing of the page is touched. 5 clears the z-index 2 that
                // .detailPagePrimaryContainer carries by itself and stays well
                // below the skin header (10) and the drawer (1099), so the case
                // never covers Jellyfin's own chrome.
                // pointer-events:none is not cosmetic: the canvas is far wider
                // than the poster, and its transparent margins would otherwise
                // swallow clicks meant for the page underneath.
                '.' + CANVAS_CLASS + '{position:absolute;pointer-events:none;z-index:5;opacity:0;' +
                'transition:opacity .25s ease-out}' +
                '.' + CANVAS_CLASS + '.is-in{opacity:1}' +
                // The gestures hang on their own box, sized to the free poster
                // box - the one part of the page that carries no text of its
                // own. touch-action:none so a drag turns the case instead of
                // scrolling the page on a phone.
                '.' + HIT_CLASS + '{position:absolute;z-index:6;cursor:grab;touch-action:none}' +
                '.' + HIT_CLASS + '.is-drag{cursor:grabbing}' +

                // ---- Case layer: Behind the text --------------------------
                // The page must end up in three layers: its dark tint, then the
                // case, then its text. No z-index can do that as the page comes,
                // because the tint is the BACKGROUND of the very containers that
                // carry the text, and a background paints at step 1 of its own
                // element while its content paints at step 3 - nothing from
                // outside can slip in between. So the tint is given a layer of
                // its own first, as a pseudo-element with inset:0, which carries
                // its container's geometry automatically and therefore cannot
                // drift when the window changes or a row loads late.
                //
                // One stacking context on the page holds the three apart:
                //   -2  the tint      (::before)
                //   -1  the case      (canvas)
                //    0+ everything else, text included - normal flow always
                //       paints above a negative z-index.
                // The context itself sits at z-index 1, above Jellyfin's scrim
                // (fixed, z-index auto, before the page in the DOM). Nothing
                // inside Jellyfin's .itemDetailPage carries a
                // z-index of 5 or more and nothing there is position:fixed, so
                // the context traps none of Jellyfin's own layers.
                '.itemDetailPage.' + BEHIND_CLASS + '{position:relative;z-index:1;isolation:isolate}' +
                '.itemDetailPage.' + BEHIND_CLASS + ' .' + CANVAS_CLASS + '{z-index:-1}' +
                // Above the text, not below: the box covers the free poster box
                // only, where the page has nothing of its own to click.
                '.itemDetailPage.' + BEHIND_CLASS + ' .' + HIT_CLASS + '{z-index:3}' +
                // !important beats the animation origin, which is where the page
                // holds these tints - a plain declaration, inline ones included,
                // is silently ignored there.
                '.itemDetailPage.' + BEHIND_CLASS + ' [' + TINT_ATTR + ']' +
                '{background-color:transparent!important;position:relative;z-index:auto!important}' +
                '.itemDetailPage.' + BEHIND_CLASS + ' [' + TINT_ATTR + ']::before' +
                '{content:"";position:absolute;inset:0;z-index:-2;pointer-events:none;' +
                'background:var(--artworkplus-threejs-tint)}';
            document.head.appendChild(st);
        }

        // three.js is 603 KB - loaded once, on demand, and only after the
        // decision said yes. A page without a Three.js case never sees it.
        // Color Thief, beside three.js. It is only needed for the colour modes,
        // but it is 6.4 KB and asking for it conditionally would mean the first
        // case after a settings change had no palette.
        var colorThiefPromise = null;
        function loadColorThief() {
            if (window.ColorThief) { return Promise.resolve(true); }
            if (colorThiefPromise) { return colorThiefPromise; }
            colorThiefPromise = new Promise(function (resolve) {
                var sc = document.createElement('script');
                sc.src = '/ThreejsCase/lib/colorthief.js';
                sc.onload = function () { resolve(!!window.ColorThief); };
                sc.onerror = function () {
                    // Not fatal: analysePoster checks for it and leaves the
                    // palette empty, which means the shell colour.
                    log('Color Thief did not load - the case keeps its shell colour');
                    resolve(false);
                };
                document.head.appendChild(sc);
            });
            return colorThiefPromise;
        }

        function loadThree() {
            if (window.THREE) { return Promise.resolve(window.THREE); }
            if (threePromise) { return threePromise; }
            threePromise = new Promise(function (resolve, reject) {
                var sc = document.createElement('script');
                sc.src = '/ThreejsCase/lib/three.js';
                sc.onload = function () { window.THREE ? resolve(window.THREE) : reject(new Error('three.js loaded but THREE is undefined')); };
                sc.onerror = function () { reject(new Error('three.js failed to load')); };
                document.head.appendChild(sc);
            });
            return threePromise;
        }

        // The ported upstream renderer, loaded after three.js because module
        // level constants in it evaluate THREE.Color at load time.
        var rendererPromise = null;
        function loadRenderer() {
            if (window.ArtworkPlusThreejsRenderer) { return Promise.resolve(window.ArtworkPlusThreejsRenderer); }
            if (rendererPromise) { return rendererPromise; }
            rendererPromise = loadThree().then(function () {
                return new Promise(function (resolve, reject) {
                    var sc = document.createElement('script');
                    sc.src = '/ThreejsCase/lib/renderer.js';
                    sc.onload = function () {
                        window.ArtworkPlusThreejsRenderer ? resolve(window.ArtworkPlusThreejsRenderer)
                                                          : reject(new Error('renderer loaded but its API is missing'));
                    };
                    sc.onerror = function () { reject(new Error('renderer failed to load')); };
                    document.head.appendChild(sc);
                });
            });
            return rendererPromise;
        }

        // The case geometry, ~1 MB, generated from the model package by
        // tools/threejscase_mesh.py and served next to three.js. Loaded once
        // per page and only after the decision said yes, exactly like the
        // engine - a page without a Three.js case fetches neither.
        var meshPromise = null;
        var meshData = null;
        function loadMesh() {
            if (meshData) { return Promise.resolve(meshData); }
            if (meshPromise) { return meshPromise; }
            meshPromise = fetch('/ThreejsCase/lib/mesh.json')
                .then(function (r) { if (!r.ok) { throw new Error('mesh HTTP ' + r.status); } return r.json(); })
                .then(function (j) { meshData = j; return j; });
            return meshPromise;
        }

        // One OBJ group -> one BufferGeometry. The arrays are already flat and
        // triangle-ordered (three floats per vertex, no index buffer), which is
        // why nothing here has to interpret the model format.
        function groupToGeometry(THREE, g) {
            var geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(g.p, 3));
            if (g.n && g.n.length === g.p.length) {
                geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.n, 3));
            } else {
                geo.computeVertexNormals();
            }
            if (g.t && g.t.length / 2 === g.p.length / 3) {
                geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.t, 2));
            }
            return geo;
        }

        // The film's own poster, straight from Jellyfin. Same origin, so the
        // canvas stays untainted and can become a texture.
        // How long the cover waits for the poster pipeline to decide. The
        // arbiter runs Custom Poster, Animated and Extra against each other and
        // paints the winner onto the card; until it has, the card carries
        // nothing. The pending hold covers this wait, so nothing flashes - but
        // it cannot be unbounded, or a page whose poster never arrives would
        // never show a case either.
        // Longer than the five seconds Extraposter can take to paint its first
        // image (its rotation start waits up to 5 s for the decision), so the
        // case does not give up just before the right picture arrives.
        var POSTER_WAIT_MS = 8000;

        // The image the PAGE decided on, read off the card itself. Like the
        // flat cases, which lie over the real card, the 3D case inherits
        // whatever the arbiter put there, so every Postercase, Keyart,
        // Animated and Extraposter setting reaches it.
        /// The url out of a computed background-image.
        ///
        /// Not with [^")]+ - that excludes the closing parenthesis, and a
        /// filename may contain one (Extraposter serves e.g.
        /// "47 Ronin (2013)-poster1.jpg"); a truncated url would load nothing.
        ///
        /// Chrome serialises this property as url("...") with double quotes,
        /// which is matched first; the unquoted form is handled by taking
        /// everything up to the LAST parenthesis.
        function bgUrlOf(el) {
            if (!el) { return null; }
            var v = window.getComputedStyle(el).backgroundImage || '';
            var quoted = /url\("([^"]*)"\)/.exec(v) || /url\('([^']*)'\)/.exec(v);
            if (quoted) { return quoted[1] || null; }
            var at = v.indexOf('url(');
            if (at < 0) { return null; }
            var rest = v.slice(at + 4);
            var end = rest.lastIndexOf(')');
            return end > 0 ? (rest.slice(0, end).trim() || null) : null;
        }

        /// WHICH picture the page decided on - the poster mods do not all put
        /// it in the same place (see cardImageUrl below).
        ///
        /// Main and Custom Poster paint the card's own background. Extraposter
        /// builds two layers of its own inside .cardScalable and crossfades
        /// between them, and Animated Poster works the same way; with the
        /// Three.js case hiding the whole 2D card, those layers rotate unseen.
        ///
        /// The layers are searched first, so the mod's choice beats the card
        /// it is layered over.
        /// THE PAGE'S OWN FADE LENGTH, read rather than configured.
        ///
        /// The flat poster fades with
        ///     style.transition = 'opacity ' + listResponse.FadeTimeMs + 'ms ease'
        /// where FadeTimeMs is the Extraposter setting (default 500). Reading
        /// the duration off the element that is fading gives the same number
        /// without a second copy of the value, and works unchanged for
        /// Characterart and anything else that fades its layers this way.
        function pageFadeMs(posterEl, fallbackMs) {
            if (!posterEl || !window.getComputedStyle) { return fallbackMs; }
            var scope = (posterEl.closest && posterEl.closest('.cardScalable'))
                     || posterEl.parentElement || posterEl;
            var candidates = [];
            var layers = scope.querySelectorAll(
                '.extraposter-layer, [class*="artworkplus"][class*="layer"]');
            for (var i = 0; i < layers.length; i++) { candidates.push(layers[i]); }
            candidates.push(posterEl);
            for (var j = 0; j < candidates.length; j++) {
                var cs = window.getComputedStyle(candidates[j]);
                // transition-duration is a comma-separated list, one entry per
                // transitioned property; the longest decides how long the
                // change actually takes.
                var parts = (cs.transitionDuration || '').split(',');
                var best = 0;
                for (var k = 0; k < parts.length; k++) {
                    var t = parts[k].trim();
                    var v = parseFloat(t);
                    if (isNaN(v)) { continue; }
                    if (t.indexOf('ms') === -1) { v *= 1000; }   // 's' or a bare number
                    if (v > best) { best = v; }
                }
                if (best > 0) { return Math.round(best); }
            }
            return fallbackMs;
        }

        function cardImageUrl(posterEl) {
            if (!posterEl || !posterEl.querySelectorAll) { return null; }
            // The layers are SIBLINGS of the card's image container, not its
            // children - Extraposter appends them to `.cardScalable`, the
            // poster element's own parent - so the search starts there.
            var scope = (posterEl.closest && posterEl.closest('.cardScalable'))
                     || posterEl.parentElement || posterEl;
            var layers = scope.querySelectorAll(
                '.extraposter-layer, [class*="artworkplus"][class*="layer"]');
            // The VISIBLE layer first. These come in pairs and crossfade, so
            // document order says nothing about which picture is on screen -
            // taking the first one with a background can hand back the one that
            // just faded out.
            var fallbackLayer = null;
            for (var i = 0; i < layers.length; i++) {
                var fromLayer = bgUrlOf(layers[i]);
                if (!fromLayer) { continue; }
                if (window.getComputedStyle(layers[i]).opacity !== '0') { return fromLayer; }
                if (!fallbackLayer) { fallbackLayer = fromLayer; }
            }
            if (fallbackLayer) { return fallbackLayer; }
            return bgUrlOf(posterEl.querySelector('.cardImageContainer') || posterEl);
        }

        function loadPoster(itemId, posterEl) {
            var api = window.ApiClient;
            var fallback = api
                ? api.getUrl('Items/' + itemId + '/Images/Primary', { maxWidth: 1200, quality: 92 })
                : null;

            // WAIT FOR THE ARBITER'S DECISION FIRST.
            //
            // The poster mods (Custom Poster 1, Animated 2, Extra 3) do not
            // paint the card immediately - they register with the arbiter,
            // resolve, and only then does the winner reach the card. Reading
            // the card straight away would race them and often return the
            // original poster. The coordinator's `decisionPromise` is the
            // signal to wait for, as in the flat case type.
            //
            // The card stays the source afterwards, deliberately: it is what
            // the page shows, so the case and the page never disagree. (The
            // participants' `url` field is not the source - only the fallback
            // path fills it, so a winner that took the normal route has none.)
            var coord = posterArbiterGet(posterEl);
            var decided = (coord && coord.decisionPromise)
                ? Promise.race([
                    coord.decisionPromise,
                    // The same 8 s the rest of this file gives one piece of
                    // loading work. A decision that never arrives must not cost
                    // the case - it costs the mod's poster, and the raw image
                    // stands in.
                    new Promise(function (resolve) { setTimeout(resolve, 8000); })
                  ])
                : Promise.resolve();

            return decided.then(function () {
                // WHICH source has to be waited for. A mod that won the arbiter
                // paints its own layer, and the card's background still carries
                // the untouched original until it does - so accepting "any url"
                // would take the original whenever the mod is a moment slower.
                // Waiting for the winner's own picture makes the case agree
                // with the page.
                var winner = coord && coord.decision ? coord.decision.logicalWinner : 0;
                var needsModLayer = winner >= 1;
                if (coord && coord.decision) {
                    log('poster arbiter settled, winner ' + winner
                        + ' (rendered ' + coord.decision.renderedSource + ')'
                        + (needsModLayer ? ' - waiting for its own layer' : ''));
                }
                return new Promise(function (resolve) {
                    var t0 = performance.now();
                    (function wait() {
                        var url = cardImageUrl(posterEl);
                        // A mod won, but so far only the card's own original is
                        // there: keep waiting rather than take the wrong one.
                        if (url && needsModLayer && /Images\/Primary/i.test(url)) { url = null; }
                        if (url) { log('cover from the poster the page itself resolved'); resolve(url); return; }
                        if (performance.now() - t0 > POSTER_WAIT_MS) {
                            log('the page did not resolve a poster in time - falling back to the raw image');
                            resolve(fallback);
                            return;
                        }
                        setTimeout(wait, 60);
                    })();
                });
            }).then(loadImage);
        }

        // The pieces the spine is printed with. The server named them; this
        // only fetches them. A piece that is switched off is not fetched at
        // all, and a piece the item does not have comes back null - which the
        // renderer takes as "no badge" and closes the gap where it stood.
        /// Everything the case is BUILT from - thirteen back-cover plates, the
        /// text face, the spine pieces, the disc, the backdrops - loads at LOW
        /// priority on purpose.
        ///
        /// A browser allows about six connections per origin, and this batch
        /// of twenty-odd files fills all of them (see Core.preloadImage). At
        /// normal priority it can delay Extraposter's first image by many
        /// seconds, and Extraposter hides the card's own image the moment it
        /// wins, so the poster slot would stand empty meanwhile.
        ///
        /// The case can afford to wait: it is not visible until its textures
        /// are complete anyway. The poster cannot. fetchPriority is a no-op on
        /// browsers that do not know it, never an error.
        function loadImage(url, priority) {
            return new Promise(function (resolve) {
                if (!url) { resolve(null); return; }
                var img = new Image();
                img.fetchPriority = priority || 'low';
                img.onload = function () { resolve(img); };
                img.onerror = function () { resolve(null); };   // missing is a state, not an error
                img.src = url;
            });
        }

        // The back cover's fixed plates - the printed block, the marks, the
        // stand-ins for a film without artwork - plus the text face the plot is
        // set in. They never change, so they are fetched once per page and kept.
        var backAssetsPromise = null;
        var BACK_PLATES = {
            blank: 'back-cover/back.png',
            info: 'back-cover/back_black.png',
            thumbfall: 'back-cover/thumbfall.png',
            fallban: 'back-cover/fallban.png',
            falllog: 'back-cover/falllog.png',
            fanart: 'back-cover/generic_fanart.jpg',
            mask: 'back-cover/mask_cover3.png',
            flagdef: 'media-flags/flag_default.png',
            sdh: 'back-print/print_sdh.png',
            nocopy: 'back-print/print_nocopy.png',
            block: 'back-print/print_block.png',
            recycleWb: 'back-print/recycle_wb.png',
            recycleGen: 'back-print/recycle_generic.png'
        };

        function assetUrl(rel) {
            return '/ThreejsCase/asset/' + rel.split('/').map(encodeURIComponent).join('/');
        }

        function loadBackAssets() {
            if (backAssetsPromise) { return backAssetsPromise; }
            var keys = Object.keys(BACK_PLATES);
            var jobs = keys.map(function (k) { return loadImage(assetUrl(BACK_PLATES[k])); });
            // The text face matters more than it looks: the typesetter MEASURES
            // with it before it draws, so a fallback font would break every line
            // in a different place than the one finally painted.
            jobs.push(loadTextFace());
            backAssetsPromise = Promise.all(jobs).then(function (res) {
                var out = {};
                keys.forEach(function (k, i) { out[k] = res[i]; });
                out.font = res[keys.length];
                // Permanent, not a debugging aid. drawCover and drawMasked both
                // start with `if (!img || !img.width) return;` - a missing plate
                // draws nothing and says nothing, so it is reported here.
                var absent = keys.filter(function (k) { return !out[k]; });
                if (absent.length) {
                    console.warn('[ArtworkPlus] Three.js case: back-cover plates missing, '
                        + 'those areas will be blank: ' + absent.join(', '));
                }
                if (!out.font) {
                    console.warn('[ArtworkPlus] Three.js case: the back-cover text face did not '
                        + 'load - the plot is measured in one font and drawn in another');
                }
                return out;
            });
            return backAssetsPromise;
        }

        function loadTextFace() {
            if (!window.FontFace || !document.fonts) { return Promise.resolve(null); }
            try {
                var face = new FontFace('Backplot', 'url(' + assetUrl('fonts/Text.ttf') + ')');
                return face.load().then(function (f) { document.fonts.add(f); return f; },
                                        function () { return null; });
            } catch (e) { return Promise.resolve(null); }
        }

        // The film's own images for the back, in the shape upstream's painter
        // expects. Jellyfin's backdrops stand in for their fanart set.
        function loadBackData(answer, itemId) {
            var back = answer.Back;
            if (!back) { return Promise.resolve(null); }
            var api = window.ApiClient;
            // The server hands over WHICH backdrops are distinct pictures, not
            // just how many: Jellyfin's database very often carries the same
            // image twice, and asking for Backdrop/1 then repeats Backdrop/0 in
            // the still box. `n`th here means the nth DIFFERENT one.
            var picks = back.BackdropIndices || [];
            var bd = function (n) {
                if (n >= picks.length || !api) { return null; }
                return api.getUrl('Items/' + itemId + '/Images/Backdrop/' + picks[n],
                                  { maxWidth: 1280, quality: 90 });
            };
            var flags = back.Flags || {};
            var flagUrl = function (rel) { return rel ? assetUrl(rel) : null; };
            return Promise.all([
                loadImage(bd(0)), loadImage(bd(1)), loadImage(bd(2)),
                loadImage(api ? api.getUrl('Items/' + itemId + '/Images/Banner', { quality: 90 }) : null),
                loadImage(api ? api.getUrl('Items/' + itemId + '/Images/Logo', { quality: 92 }) : null),
                loadImage(flagUrl(flags.Aspect)), loadImage(flagUrl(flags.Resolution)),
                loadImage(flagUrl(flags.Mpaa)), loadImage(flagUrl(flags.Codec))
            ]).then(function (r) {
                return {
                    // Upstream's sidecar field names and their SHAPES: director and
                    // genre are arrays the painter slices, runtime is already
                    // formatted, and media.audio[0].lang is what the barcode's
                    // country table is keyed on. Five of their eighteen fields
                    // (outline, mpaa, credits, actors, imdb) are read by nothing
                    // in this layout and are deliberately not filled - passing
                    // something for them would be inventing data.
                    side: {
                        stem: back.Stem || '',
                        title: back.Title || '',
                        year: back.Year || '',
                        plot: back.Plot || '',
                        tagline: back.Tagline || '',
                        studio: back.Studio || '',
                        genre: back.Genre || [],
                        director: back.Director || [],
                        runtime: back.Runtime || '',
                        tmdb: back.Tmdb || null,
                        media: { audio: back.AudioLanguage ? [{ lang: back.AudioLanguage }] : [] }
                    },
                    img: { fanart: r[0], fanart1: r[1], fanart2: r[2], banner: r[3], clearart: r[4] },
                    // Order is the painter's: aspect, resolution, rating, codec.
                    flags: [r[5], r[6], r[7], r[8]]
                };
            });
        }

        function loadPrint(answer, itemId) {
            var spine = answer.Spine || {};
            var api = window.ApiClient;
            var studioUrl = (spine.StudioLogo && spine.StudioAsset)
                ? '/ThreejsCase/asset/' + spine.StudioAsset.split('/').map(encodeURIComponent).join('/')
                : null;
            // The clearlogo comes from Jellyfin itself, like every other image
            // the plugin shows. HasMovieLogo is asked on the server because a
            // 404 here would be indistinguishable from a slow network.
            var logoUrl = (spine.MovieLogo && spine.HasMovieLogo && api)
                ? api.getUrl('Items/' + itemId + '/Images/Logo', { maxHeight: 400, quality: 92 })
                : null;
            // The disc art comes from Jellyfin's own Disc image. HasDisc is the
            // same answer that decides whether the case may open at all, so a
            // case that opens always has something to show inside it.
            var discUrl = (answer.HasDisc && api)
                ? api.getUrl('Items/' + itemId + '/Images/Disc', { maxWidth: 900, quality: 92 })
                : null;
            return Promise.all([loadImage(studioUrl), loadImage(logoUrl), loadImage(discUrl)])
                .then(function (r) {
                    return {
                        studio: r[0],
                        logo: r[1],
                        disc: r[2],
                        tmdb: (spine.Code && spine.TmdbId) ? String(spine.TmdbId) : null
                    };
                });
        }

        // One canvas carries the whole wrap - back, spine and front - exactly
        // as the mesh's UVs expect it. Upstream's paintCover() in short: fill
        // everything in the case colour, then draw the poster into the front
        // rectangle. Their printed template underneath is skipped - the PSD
        // is not shipped, and a plain colour stands in for it.
        function paintWrap(THREE, shellName, img, colorHex, Renderer, backCover, posterDevicePx) {
            // The model's OWN uv rectangles, asked of it rather than copied:
            // applyAspect reshapes the case to the poster, and a hard-coded
            // table describes the UNFITTED shape. The table stays as the
            // fallback for the moment before the model exists.
            var frontRect = null;
            var live = Renderer && Renderer.uvRects ? Renderer.uvRects() : null;
            var rects = (live && live.front)
                ? { front: live.front, back: live.back }
                : (WRAP[shellName === 'dvdgen' ? 'dvd' : shellName] || WRAP.bluray);
            var W = wrapWidthFor(rects, posterDevicePx);
            var cv = document.createElement('canvas');
            cv.width = W; cv.height = W;
            var ctx = cv.getContext('2d');
            ctx.fillStyle = '#' + ('000000' + colorHex.toString(16)).slice(-6);
            ctx.fillRect(0, 0, W, W);

            if (img && img.width) {
                var f = rects.front;
                // v runs bottom-up in UV space, top-down on a canvas.
                var x = f.u0 * W, y = (1 - f.v1) * W, w = (f.u1 - f.u0) * W, h = (f.v1 - f.v0) * W;
                // The WHOLE poster, no crop - and that needs the rectangle
                // filled exactly, not cover-fitted. applyAspect reshapes the
                // GEOMETRY to the poster but leaves the cover's UVs alone
                // (v range 0.0299..0.4936), so this rectangle keeps the
                // unfitted proportions, 0.901, while the face it lands on has
                // the poster's, 0.701. Cover-fitting would crop about 22 % of a
                // 2:3 poster's height.
                //
                // Filling it exactly writes the poster into the texture
                // horizontally stretched, and the face then squeezes it by the
                // very same factor (0.701/0.901) on the way to the screen. The
                // two cancel: full image, true proportions, nothing cut.
                ctx.drawImage(img, 0, 0, img.width, img.height, x, y, w, h);
                // Where the front was drawn, kept with the texture. An
                // animated cover redraws ONLY this rectangle per frame -
                // the back sheet (typeset plot, flag row, barcode) is
                // composed once and never again.
                frontRect = { cv: cv, ctx: ctx, x: x, y: y, w: w, h: h };
            }

            // The back cover, painted by upstream's own sheet composer and
            // dropped into the back rectangle. Everything about its layout -
            // the typeset plot, the flag row that closes its gaps, the
            // procedural barcode, the legal footer - is theirs; only the data
            // behind it comes from Jellyfin instead of from their sidecar.
            if (backCover && backCover.data && backCover.assets && rects.back && Renderer.paintBack) {
                var b = rects.back;
                var bx = b.u0 * W, bw = (b.u1 - b.u0) * W;
                var bh = (b.v1 - b.v0) * W, by = (1 - b.v1) * W;
                // Their function, our canvas. It recomposes the sheet to this
                // rectangle instead of fitting a finished one into it - which
                // is the difference between a bottom edge that lands within a
                // hundredth of a pixel and one that is cut or short.
                Renderer.paintBack(ctx, bx, by, bw, bh, backCover.assets);
            }

            var tex = new THREE.CanvasTexture(cv);
            if (THREE.sRGBEncoding !== undefined) { tex.encoding = THREE.sRGBEncoding; }
            tex.__apFront = frontRect;
            return tex;
        }

        // ------------------------------------------------------------------
        // The page's tint, moved onto a layer of its own.
        // ------------------------------------------------------------------
        // Three of Jellyfin's own containers carry rgba(0,0,0,0.4) as a flat
        // background -
        // .detailPagePrimaryContainer, .detailPageSecondaryContainer and
        // .detailPageContent. They are found here rather than named, because
        // the colour and the set of them belong to whatever theme is running.
        //
        // Nothing is copied: the tint keeps its own element and its own box,
        // it only moves from that element's background onto that element's
        // ::before. Cutting a hole into the tints and painting the missing
        // piece back on separate divs would duplicate the geometry, which
        // drifts as soon as a late row loads.
        var TINT_MAX_ALPHA = 0.99;

        function markTints(view, canvasRect) {
            var marked = [];
            var viewWidth = view.getBoundingClientRect().width || window.innerWidth;
            var nodes = view.querySelectorAll('*');
            for (var i = 0; i < nodes.length; i++) {
                var el = nodes[i];
                var cs = getComputedStyle(el);
                // Only flat translucent backgrounds. An element with a picture
                // of its own is not a tint, and an opaque one is not either -
                // that is the poster card, which is hidden by other means.
                if (cs.backgroundImage !== 'none') { continue; }
                var m = /^rgba?\(([^)]+)\)$/.exec(cs.backgroundColor);
                if (!m) { continue; }
                var parts = m[1].split(',');
                var alpha = parts.length > 3 ? parseFloat(parts[3]) : 1;
                // With the user's Backdrops display
                // setting off, Jellyfin paints the lower page OPAQUE - 10.10.7 in
                // its themes on `.detailPageSecondaryContainer` (themes/dark/
                // theme.css 228: #101010), 12.1 once in the base theme on the
                // outer `.detailPageWrapperContainer` (themes/_base/_theme.scss
                // 355). Both hid the case below the ribbon; it stays dark, but one
                // layer below the case like every other shading. Themes that paint
                // it with a background IMAGE (blueradiance, purplehaze, wmc) are
                // skipped by the image rule above.
                var opaquePageGround = alpha === 1 && el.matches(
                    '.noBackdropTransparency .detailPageSecondaryContainer, .noBackdropTransparency .detailPageWrapperContainer');
                if (!(alpha > 0) || (alpha > TINT_MAX_ALPHA && !opaquePageGround)) { continue; }

                // Only the ones the case actually stands in front of. A tint
                // further down the page covers nothing and is left alone.
                var er = el.getBoundingClientRect();
                if (er.right <= canvasRect.left || er.left >= canvasRect.right ||
                    er.bottom <= canvasRect.top || er.top >= canvasRect.bottom) { continue; }

                // And only the page's own shading, which spans the page - not
                // e.g. the PG badge (rgba(170,170,190,.2)) or a card footer strip
                // (rgba(0,0,0,.7)), whose text would end up on bare artwork.
                // Erring narrow is the right way round: a skipped tint only
                // leaves the case slightly darker, a wrongly moved one breaks a
                // piece of Jellyfin's UI.
                if (er.width < viewWidth * 0.9) { continue; }

                el.style.setProperty('--artworkplus-threejs-tint', cs.backgroundColor);
                el.setAttribute(TINT_ATTR, '');
                marked.push(el);
            }
            log('tints moved to their own layer: ' + marked.length);
            return marked;
        }

        function unmarkTints(marked) {
            (marked || []).forEach(function (el) {
                el.removeAttribute(TINT_ATTR);
                el.style.removeProperty('--artworkplus-threejs-tint');
            });
        }

        function teardown() {
            if (mounted && mounted.stopCoverWatch) { mounted.stopCoverWatch(); }
            // The size watch goes with it. Two listeners on
            // `window` and `document` that outlive their canvas would keep a
            // dead renderer alive and re-layout a canvas nobody can see.
            if (mounted && mounted.stopLayoutWatch) { mounted.stopLayoutWatch(); }
            stopCoverGif();
            // Not pendingRelease() here. reset() is called at the start of the
            // flat case's check(), i.e. on every navigation - and by then
            // `viewshow` has already put the hold on the NEW page. Releasing
            // it here would flash the vanilla poster before the new case's
            // hold went back on.
            // The hold is released where a DECISION is made instead: by
            // claimFor when there is no case, by mount when the case has taken
            // over the card itself, by the failure path in render, and by the
            // safety net.
            if (!mounted) { return; }
            try {
                if (mounted.raf) { cancelAnimationFrame(mounted.raf); }
                if (mounted.aa) { mounted.aa.dispose(); mounted.aa = null; }
                if (mounted.openTimer) { clearTimeout(mounted.openTimer); }
                if (mounted.hit && mounted.hit.parentNode) { mounted.hit.parentNode.removeChild(mounted.hit); }
                if (mounted.renderer) { mounted.renderer.dispose(); }
                // The model belongs to the renderer and is cached there per
                // shell, so its geometries are NOT disposed here - only what
                // this mount created on top of it.
                if (mounted.model && mounted.model.group && mounted.model.group.parent) {
                    mounted.model.group.parent.remove(mounted.model.group);
                }
                (mounted.geometries || []).forEach(function (g) { g.dispose(); });
                (mounted.materials || []).forEach(function (m) { m.dispose(); });
                // Every case builds its own wrap canvas; not disposing these
                // runs the GPU out of memory.
                if (mounted.coverTexture) { mounted.coverTexture.dispose(); }
                // A NAVIGATION IN THE MIDDLE OF A FADE. The incoming wrap is
                // held by the fade and by the mix uniform, and neither is the
                // material's map yet - so without this it would survive the
                // mount that made it (renderer.dispose() bounds it, but a 2048
                // canvas is a lot of GPU memory).
                if (mounted.coverFade && mounted.coverFade.tex
                        && mounted.coverFade.tex !== mounted.coverTexture
                        && mounted.coverFade.tex.dispose) {
                    mounted.coverFade.tex.dispose();
                }
                mounted.coverFade = null;
                if (mounted.coverMix && mounted.coverMix.uCoverNext) {
                    mounted.coverMix.uCoverNext.value = null;
                    mounted.coverMix.uCoverMix.value = 0;
                }
                if (mounted.canvas && mounted.canvas.parentNode) { mounted.canvas.parentNode.removeChild(mounted.canvas); }
            } catch (e) { /* teardown must never throw - it runs on the way out */ }
            if (mounted.cancelPendingClick) { mounted.cancelPendingClick(); }
            // Outside the try: a throw in the teardown above must
            // not leave the three document listeners of "In front" behind.
            if (mounted.unpickFront) { mounted.unpickFront(); }
            if (mounted.unwatchWheel) { mounted.unwatchWheel(); }
            if (mounted.unwatchTextures) { mounted.unwatchTextures(); }
            unmarkTints(mounted.tints);
            document.querySelectorAll('.itemDetailPage.' + HOLD_CLASS).forEach(function (el) {
                el.classList.remove(HOLD_CLASS);
            });
            document.querySelectorAll('.itemDetailPage.' + BEHIND_CLASS).forEach(function (el) {
                el.classList.remove(BEHIND_CLASS);
            });
            mounted = null;
        }

        /// Builds the case and shows it. Nothing on the page is touched before
        /// the first frame stands: the poster keeps rendering until the very
        /// last two statements, so a failure anywhere above leaves the page
        /// exactly as it was.
        function mount(answer, itemId, posterEl, THREE, poster, Renderer, print, backCover, colourImg) {
            // ONE SLOT, ONE CASE. `mounted` is a single module variable, so a
            // second mount would silently orphan the first - its renderer, its
            // WebGL context, its canvas in the DOM and its animation frame all
            // live on with nothing holding them. Two routes lead here twice: a
            // load that finishes after the page has already moved on (the
            // generation check in render() catches that one), and a page that
            // carries two poster cards. This is the structural guard that makes
            // the second mount harmless whichever route it took.
            if (mounted) {
                log('a case was still up when a new one mounted - taking the old one down first');
                teardown();
            }
            var container = posterEl.closest ? posterEl.closest('.detailImageContainer') : null;
            var view = posterEl.closest ? posterEl.closest('.itemDetailPage') : null;
            if (!container || !view) { log('no poster container - the flat case type stays'); return false; }

            var onCoverWatchStop = null, fadeNextPaint = false, coverMix = null;
            var posterRect = measureDesignRect(posterEl);
            if (!posterRect.width || !posterRect.height) { log('poster not laid out yet'); return false; }

            // How large the poster will actually be drawn, in DEVICE pixels -
            // the only number that decides whether the wrap texture is sharp
            // enough. The renderer's own pixel ratio is capped at 2, so this
            // uses the same cap and never asks for a texture the canvas could
            // not show anyway.
            var wrapTargetPx = {
                w: posterRect.width * (answer.Size || 60) / 100 * Math.min(window.devicePixelRatio || 1, 2),
                h: posterRect.height * (answer.Size || 60) / 100 * Math.min(window.devicePixelRatio || 1, 2)
            };

            var renderer;
            try {
                // logarithmicDepthBuffer is upstream's, and it is not optional at
                // their near plane: 0.5 against 1500 is a 3000:1 span, which an
                // ordinary 24-bit depth buffer spends almost entirely on the
                // first few units - and the coplanar surfaces of this model
                // (wrap against shell, decals against paper, the seams between
                // the inward-facing shell faces) then fight for the same depth,
                // which shows as white slots at certain angles.
                // It can only be passed HERE - three reads it when the context
                // is created and ignores it afterwards.
                renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true,
                                                     logarithmicDepthBuffer: true });
            } catch (e) {
                log('WebGL context creation failed - the flat case type stays', e);
                return false;
            }

            var scene = new THREE.Scene();
            // PERSPECTIVE, not orthographic - upstream's own default
            // (`let camera = perspCam`; ortho is only for their axis views).
            // Orthographic projection has no foreshortening: both sides of a
            // turned case come out the same size, and without that depth cue
            // the eye reads the shape the wrong way round.
            //
            // fov 35 / near 0.5 / far 1500 are theirs verbatim. The aspect is
            // 1 because this canvas is square by construction (side x side);
            // upstream reads innerWidth/innerHeight only because its canvas is
            // the window.
            var FOV = 35;
            var camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 1500);

            var shellName = answer.Shell === 'dvdgen' ? 'dvdgen' : 'bluray';
            var M;
            try {
                Renderer.init(THREE, meshData, { renderer: renderer, scene: scene, camera: camera });
                // The case is reshaped to the POSTER, so nothing is cropped:
                // applyAspect moves vertices per split instead of scaling, so
                // the cover ends up with the poster's own aspect and the spine
                // keeps its width.
                var aspect = (poster && poster.width && poster.height) ? (poster.width / poster.height) : (2 / 3);

                // Comparison switch, off unless diagnostics are on and
                // `ArtworkPlusPostersDiagnostics.matchJellyfin = true` is set. It gives the 3D case exactly the
                // poster Jellyfin shows the flat case - the box's aspect, the
                // image centre-cropped the way background-size: cover does - so
                // the two cover windows can be compared. In normal use the 3D
                // case keeps the image's own aspect.
                if (diagnostics && diagnostics.matchJellyfin && posterRect.width && posterRect.height) {
                    var boxAspect = posterRect.width / posterRect.height;
                    if (poster && poster.width && poster.height) {
                        var iw = poster.width, ih = poster.height, sw, sh;
                        if (iw / ih > boxAspect) { sh = ih; sw = ih * boxAspect; }
                        else { sw = iw; sh = iw / boxAspect; }
                        var cc = document.createElement('canvas');
                        cc.width = Math.round(sw); cc.height = Math.round(sh);
                        cc.getContext('2d').drawImage(poster, (iw - sw) / 2, (ih - sh) / 2,
                            sw, sh, 0, 0, cc.width, cc.height);
                        poster = cc;
                    }
                    aspect = boxAspect;
                    log('Diagnostics: poster matched to Jellyfin (aspect ' + boxAspect.toFixed(4) + ', centre-cropped)');
                }
                Renderer.build(shellName, {
                    posterAspect: aspect,
                    aspectMode: 'fitb',
                    openAngle: 0,
                    blackCase: !!answer.Black,
                    logoMode: answer.BandLogo === 'uhd' ? 'uhd' : (answer.BandLogo === 'none' ? 'none' : '3d'),
                    discOn: true,
                    furnOn: true,
                    studioOn: !!(answer.Spine && answer.Spine.StudioLogo),
                    formatOn: !!(answer.Spine && answer.Spine.FormatMark),
                    tmdbOn: !!(answer.Spine && answer.Spine.Code)
                });
                M = Renderer.fit({});
                // Upstream's ground names: the setting carries the long
                // form for the admin page, the painter knows 'bw' and 'blur'.
                var groundOf = { Black: 'black', BwFanart: 'bw', BlurredFanart: 'blur' };
                var bookletMode = answer.Booklet || 'Off';
                Renderer.setPrint(Object.assign({}, print || {}, {
                    back: backCover && backCover.data ? backCover.data : undefined,
                    booklet: bookletMode !== 'Off',
                    bookletGround: groundOf[bookletMode] || 'black',
                    stem: itemId
                }));
            } catch (e) {
                log('the renderer could not build this case - the flat case type stays', e);
                try { renderer.dispose(); } catch (e2) { /* nothing left to save */ }
                return false;
            }

            // The printed wrap. The renderer hands us the case colour whenever
            // it changes, so back and spine always carry the same colour as
            // the plastic.
            var coverTexture = null;

            /// ONE OWNER FOR THE COVER TEXTURE.
            ///
            /// `coverTexture` and `mounted.coverTexture` are kept equal here,
            /// so teardown never disposes a texture twice or misses the live
            /// one.
            ///
            /// Only textures made here are disposed. The material's map on
            /// the first paint is the shell's shared template texture
            /// (`templateTex[name]` in the renderer), handed to every model of
            /// that shell; disposing it would give the next build of the same
            /// shell a dead texture. `coverTexture` starts null, so the
            /// template is never a candidate.
            function ownCoverTexture(tex) {
                if (coverTexture === tex) { return; }
                var previous = coverTexture;
                coverTexture = tex;
                if (mounted) { mounted.coverTexture = tex; }
                if (previous && previous.dispose) { previous.dispose(); }
            }
            /// ONE material, TWO maps, one mix value - the way three.js does a
            /// crossfade on a textured surface.
            ///
            /// This is the same mechanism the flat poster uses, translated: two
            /// pictures present at once, one number moving from 0 to 1. There a
            /// "layer" is a div and the number is CSS opacity; here the cover IS
            /// a texture on geometry, so the second picture is a second sampler
            /// and the number is a uniform.
            ///
            /// A second cover mesh faded over the first would need a polygon
            /// offset (coplanar faces), join the transparent sorted pass, and
            /// have to be created and destroyed around every fade - each leaked
            /// copy holding a 52 MB texture. Here nothing is created or
            /// destroyed per fade; per frame it is one float.
            function installCoverMix() {
                var mat = M.matCover;
                if (!mat || coverMix) { return; }
                // r128's map_fragment, verbatim from the vendored build - if
                // three is ever raised this text changes, and the guard below
                // turns the crossfade off rather than producing a broken shader.
                // The INCLUDE, not the expanded chunk. onBeforeCompile runs
                // BEFORE three resolves its #include directives, so at this
                // point the fragment shader still reads
                // "#include <map_fragment>" - searching for the expanded
                // text would find nothing.
                // MIXED below is r128's own map_fragment with the second
                // sampler mixed in; if three is ever raised, compare it
                // against the new chunk before trusting this.
                var CHUNK = '#include <map_fragment>';
                var MIXED = '#ifdef USE_MAP\n'
                          + '\tvec4 texelColor = texture2D( map, vUv );\n'
                          + '\ttexelColor = mapTexelToLinear( texelColor );\n'
                          + '\tif ( uCoverMix > 0.0 ) {\n'
                          + '\t\tvec4 nextColor = texture2D( uCoverNext, vUv );\n'
                          + '\t\tnextColor = mapTexelToLinear( nextColor );\n'
                          + '\t\ttexelColor = mix( texelColor, nextColor, uCoverMix );\n'
                          + '\t}\n'
                          + '\tdiffuseColor *= texelColor;\n#endif';
                // THE UNIFORM OBJECTS BELONG TO THE MATERIAL, NOT TO THE SHADER.
                //
                // The hook can run more than once - any recompile calls it
                // again. Uniform objects created inside the hook would silently
                // replace the ones a running fade writes to, and the fade would
                // write to an orphan with no error. Made on the material once
                // and shared into each compile, every program points at the
                // same two objects.
                if (!mat.userData.coverMix) {
                    mat.userData.coverMix = { uCoverNext: { value: null }, uCoverMix: { value: 0 } };
                }
                coverMix = mat.userData.coverMix;
                mat.onBeforeCompile = function (shader) {
                    if (shader.fragmentShader.indexOf(CHUNK) === -1) {
                        log('the map chunk is not r128 shape - the cover will cut, not fade');
                        return;
                    }
                    shader.uniforms.uCoverNext = mat.userData.coverMix.uCoverNext;
                    shader.uniforms.uCoverMix = mat.userData.coverMix.uCoverMix;
                    shader.fragmentShader = 'uniform sampler2D uCoverNext;\nuniform float uCoverMix;\n'
                                          + shader.fragmentShader.replace(CHUNK, MIXED);
                    mat.userData.coverMixHooked = true;
                    log('cover crossfade compiled into the material');
                };
                // NO customProgramCacheKey HERE, DELIBERATELY. r128's own
                // default is `return this.onBeforeCompile.toString()` - the
                // hook's source text IS the key, so assigning the hook already
                // changes it and forces the recompile that runs it (see the
                // vendored build). A constant override would be wrong as soon
                // as a second differently-hooked material exists, because the
                // two would then share one compiled program.
                                mat.needsUpdate = true;   // force the recompile that runs the hook
            }

            function paint(hex) {
                var tex = paintWrap(THREE, shellName, poster, hex, Renderer, backCover, wrapTargetPx);
                // A repaint the cover watcher asked for fades in over the one on
                // screen; every other repaint (the first build, a colour change)
                // swaps straight away, because there is nothing to fade FROM.
                //
                // The second condition is not redundant. applyPoster repaints
                // several times in one pass - the case colour is derived from
                // the cover, so a new cover means a new colour, a new spine and
                // a new booklet ground, and each step paints. Only the first
                // carries fadeNextPaint; the later ones would otherwise fall
                // through to the hard swap and replace the map the fade is still
                // blending FROM. A repaint inside a running fade therefore
                // replaces the INCOMING picture and leaves the fade running.
                // `coverMixHooked`, not merely `coverMix`: the uniform objects
                // exist from the moment installCoverMix runs, before the shader
                // that reads them is compiled. A fade started then would animate
                // a uniform no program samples and end in a delayed hard cut.
                // The first paint therefore always swaps; fades begin from the
                // second, by which time the material has been through a render.
                var mixLive = coverMix && M.matCover && M.matCover.userData.coverMixHooked;
                if (mixLive && (fadeNextPaint || (mounted && mounted.coverFade))) {
                    fadeNextPaint = false;
                    var stale = coverMix.uCoverNext.value;
                    coverMix.uCoverNext.value = tex;
                    if (mounted && mounted.coverFade) {
                        mounted.coverFade.tex = tex;        // same fade, newer picture
                    } else if (mounted) {
                        coverMix.uCoverMix.value = 0;
                        mounted.coverFade = { tex: tex, t0: performance.now(),
                                              ms: pageFadeMs(posterEl, COVER_FADE_MS), frames: 0 };
                    }
                    kick();
                    // Only ever an intermediate incoming texture: the map is
                    // swapped at the end of the fade and uCoverNext nulled
                    // there, so this can never be the picture on screen.
                    if (stale && stale !== tex && stale.dispose) { stale.dispose(); }
                    syncCoverGif();
                    return;
                }
                fadeNextPaint = false;
                if (M.matCover) {
                    M.matCover.map = tex;
                    M.matCover.needsUpdate = true;
                }
                ownCoverTexture(tex);
                syncCoverGif();
            }

            /// Whether the cover that was just painted moves. Asked after
            /// every paint rather than once at mount, because the cover
            /// follows the page: Extraposter can cycle a still picture in
            /// over a moving one and back again.
            function syncCoverGif() {
                var url = poster && poster.src;
                if (coverIsAnimated(url)) { startCoverGif(url); } else { stopCoverGif(); }
            }

            // THE COVER FOLLOWS THE PAGE.
            //
            // Extraposter crossfades between its pictures every few seconds and
            // Animated Poster runs a GIF, so the case must follow the page
            // rather than keep the picture it was built with.
            //
            // The mods paint their own layers, so watching those layers is the
            // whole mechanism - no second source of truth, no polling of the
            // server, and it works for every mod that paints that way,
            // including ones added later.
            //
            // The change crossfades: paint() hands the new wrap to the mix
            // uniform instead of swapping the map, and the frame loop moves one
            // float. Nothing is repainted per frame - a second sampler means
            // the two pictures need not both be painted every frame.
            function watchCoverSource() {
                var host = posterEl.closest ? posterEl.closest('.cardScalable') : null;
                if (!host || typeof MutationObserver !== 'function') { return; }
                var current = cardImageUrl(posterEl);
                // Not `busy`: the frame loop has its own `busy`, meaning
                // something is still animating, and two unrelated flags of
                // that name in nested scopes is one reader's mistake away
                // from a real one. This one only says a load is in flight.
                var loading = false;
                var observer = new MutationObserver(function () {
                    if (loading || !mounted || mounted.itemId !== itemId) { return; }
                    var next = cardImageUrl(posterEl);
                    if (!next || next === current) { return; }
                    current = next;
                    loading = true;
                    loadImage(next, 'high').then(function (img) {
                        loading = false;
                        // Everything can have moved on while that loaded - a
                        // navigation, a teardown, or the next picture already.
                        if (!img || !mounted || mounted.itemId !== itemId) { return; }
                        poster = img;
                        fadeNextPaint = true;
                        if (Renderer.applyPoster) {
                            // Upstream's chain again, in its own order: the
                            // case colour is DERIVED from the cover, so a new
                            // cover means a new colour, a new spine and a new
                            // booklet ground. Repainting only the artwork would
                            // leave the case the colour of the previous poster.
                            try {
                                Renderer.applyPoster(img, {
                                    caseColMode: colourMode,
                                    onlyBack: answer.ColorMode === 'BackSpine',
                                    // Extraposter: the artwork changes, the
                                    // colour stays where the build put it.
                                    keepColour: !!mounted.pinColour
                                });
                            } catch (e) { paint(M.caseHex !== undefined ? M.caseHex : 0x003986); }
                        } else {
                            paint(M.caseHex !== undefined ? M.caseHex : 0x003986);
                        }
                        // The chain is finished: later repaints (a colour
                        // change, a re-fit) swap straight away again.
                        fadeNextPaint = false;
                        draw();
                        log('cover followed the page to a new picture');
                    });
                });
                observer.observe(host, { attributes: true, attributeFilter: ['style'],
                                         subtree: true, childList: true });
                onCoverWatchStop = function () { observer.disconnect(); };
            }

            installCoverMix();
            Renderer.onCaseColor(paint);
            // Upstream's paintCover stands in for ours: applyCaseColour calls it with
            // the hex it just derived, because the back sheet and the spine
            // strip carry the case colour and live in this very texture.
            if (Renderer.onWrap) { Renderer.onWrap(function (img, hex) { paint(hex); }); }

            // The poster, through upstream's chain and in its order:
            //   analysePoster -> setSpineLogo -> applyCaseColour -> applyAspect -> paintBooklet
            // Three of those five steps depend on the one before; another order
            // distorts the spine logo.
            //
            // The two axes are read straight out of upstream's applyCaseColour:
            // 'model' means no derived colour at all, and onlyBack means the
            // plastic keeps the model colour while the paper takes the derived
            // one - which is exactly what "Back Spine color" describes.
            var BLEND_MODE = {
                DominantDark: 'dominant_dark', DominantColorful: 'dominant', Deep: 'deep',
                MaterialYou: 'material', Accent: 'accent', TopRegion: 'top', Vibrant: 'vibrant'
            };
            // The server says Original; the renderer's own word for it is 'model'.
            var colourMode = answer.ColorMode === 'Original'
                ? 'model'
                : (BLEND_MODE[answer.Blend] || 'dominant_dark');
            // colourImg is set only when Extraposter won: it is the picture
            // that would have won without it, and the case colour comes from
            // THAT, once. The artwork then follows with keepColour, so the
            // cycling pictures never touch the colour again. Both happen while
            // the case is still being built - none of it is visible. Done
            // afterwards, the case would appear in the cycling picture's colour
            // and change a moment later, in full view.
            var pinColour = !!colourImg;
            if (Renderer.applyPoster) {
                if (pinColour) {
                    Renderer.applyPoster(colourImg, {
                        caseColMode: colourMode,
                        onlyBack: answer.ColorMode === 'BackSpine'
                    });
                    Renderer.applyPoster(poster, { keepColour: true });
                    log('case colour fixed at hex '
                        + (M.caseHex !== undefined ? M.caseHex.toString(16) : '?')
                        + ' - the cycling pictures will not change it');
                } else {
                    Renderer.applyPoster(poster, {
                        caseColMode: colourMode,
                        onlyBack: answer.ColorMode === 'BackSpine'
                    });
                }
            }
            // A last paint for the case where the chain painted nothing (no
            // poster at all): without it the wrap would stay empty.
            if (!coverTexture) {
                paint(M.caseHex !== undefined ? M.caseHex : (answer.Black ? CASE_BLACK : 0x003986));
            }

            // 100 % = the front cover, straight on, as TALL as the poster box.
            //
            // The scale is driven by HEIGHT, not width. Both case kinds are
            // built around Jellyfin's poster box, and the flat one's cover
            // window lands on the box within 3 px. applyAspect reshapes the 3D
            // cover to the POSTER IMAGE's aspect while Jellyfin CROPS that image
            // into the box, so a width-driven scale leaves the heights apart by
            // the aspect difference (5 % on a 1000 x 1426 poster).
            //
            // Height is not an arbitrary pick: JELLYFIN ITSELF FITS BY HEIGHT.
            // The box is `coveredImage` (background-size: cover), so an image
            // wider than the box is scaled to its height and cropped at the
            // sides. Driving the 3D case by height makes it agree with the flat
            // case AND with Jellyfin, instead of with neither.
            //
            // The cover's HEIGHT has to be derived, not read: M.D.FC is the
            // static table (Posters/ThreejsRenderer's own D map) and
            // applyAspect does NOT write back into it. The fit leaves the width
            // alone and changes only the height, to FW / posterAspect - so the
            // same formula is used here.
            var coverUnits = (M.D.FC.x1 - M.D.FC.x0) / aspect;

            // How big must the canvas be so that NO pose is ever clipped? The
            // answer is a radius about the PIVOT, not half the width: the
            // pivot is the body centre of the CLOSED case and stays there, so
            // an opened case is asymmetric about it. Measured at the widest
            // angle this case can reach, over the real vertices (at 120 degrees
            // it spans -56.1..+24.7 and needs a radius of 56.1).
            var maxAngle = Math.max(answer.Open && answer.Open.AngleDegrees || 0, 0);
            var radius = measureRadius(M, maxAngle);
            // Room for the largest zoom, not for the resting size. half follows
            // side through the same unitsPerPx, so the picture scale does not
            // change - the canvas simply carries more empty margin, and the
            // case still appears at exactly the size the settings ask for.
            var zoomCap = zoomCapOf(answer);

            // Under perspective the fit is a DISTANCE, not a frustum, and the
            // condition is a SPHERE rather than a plane: the measured radius is
            // a sphere about the pivot, so the case is safe at every pose
            // exactly when that sphere's angular radius fits inside the
            // frustum's half-angle. On a plane fit the far corners survive and
            // the near ones do not, because the near face is closer than the
            // pivot - the one consequence upstream warned about.
            //
            // The binding case is the LARGEST zoom, where the frustum is at its
            // narrowest: three's `zoom` divides tan(fov/2), so
            //     k = tan(fov/2) / zoomMax          the narrowed tangent
            //     sin(theta_k) = k / sqrt(1 + k*k)  the same angle as a sine
            //     dist >= radius / sin(theta_k)     the sphere fits
            // At fov 35 and a 33 % zoom cap that is 4.335 * radius, where a
            // plane fit would have given 4.218 and clipped the corners at full
            // zoom by just under 3 %.
            var tanHalf = Math.tan(FOV / 2 * Math.PI / 180);
            var k = tanHalf / (1 + zoomCap);
            var dist = radius / (k / Math.sqrt(1 + k * k));
            // What the camera frames at the PIVOT plane - the canvas is sized
            // from this, so the case keeps the on-screen size the settings ask
            // for and the extra margin stays margin.
            var half = dist * tanHalf;

            camera.aspect = 1;                       // the canvas is square by construction
            camera.position.set(0, 0, dist);
            camera.lookAt(0, 0, 0);
            camera.zoom = 1;
            camera.updateProjectionMatrix();
            // Upstream's near/far bracket this generously (dist lands around
            // 240 model units against a 0.5..1500 range); checked anyway,
            // because a case that left the frustum would simply vanish.
            if (dist - radius < 0.5 || dist + radius > 1500) {
                log('the case does not fit the near/far range - dist ' + dist.toFixed(1)
                    + ', radius ' + radius.toFixed(1));
            }

            // The backing store is capped. `side` follows the
            // poster, and Poster size may scale the poster up to 200 % -
            // at which point a 2357 px canvas becomes 4714, and at device
            // pixel ratio 2 that is a 9428 x 9428 buffer: 89 megapixels, some
            // 355 MB. On a weaker machine the context is simply lost, and a
            // lost context is a blank case, not a slow one.
            //
            // Capped by lowering the PIXEL RATIO, never `side`: the CSS size
            // has to stay exactly what the geometry asked for, or the case
            // would no longer sit on its poster. Below the cap nothing
            // changes.
            // The model group is already centred on the body centre of the
            // CLOSED case by the renderer - that is the pivot, and it must not
            // move when the case opens. The pose group only turns and tilts it.
            var pose = new THREE.Group();
            pose.add(M.group);
            pose.rotation.y = (answer.Turn || 0) * Math.PI / 180;
            pose.rotation.x = -(answer.Tilt || 0) * Math.PI / 180;
            scene.add(pose);

            // Lights and colour handling (including the sRGB output encoding)
            // come from the renderer's setupScene(), copied from upstream.

            var canvas = renderer.domElement;
            canvas.className = CANVAS_CLASS;

            // Size, render and placement are ONE function, and it runs again
            // on every resize: Jellyfin's poster box is defined in vw, so it
            // moves and resizes with the window - fullscreen included.
            //
            // The camera is NOT part of this: dist, half and the frustum come
            // from the case's own radius and the fov, none of which the window
            // touches. Only the scale (units per pixel), the canvas size that
            // follows from it, and the placement change - which is why a
            // re-layout is a resize and a re-render, not a rebuild.
            var side = 0, unitsPerPx = 0, coverPx = 0;
            function layoutCase() {
                // World matrices first: three.js updates them only while rendering, so the first
                // layout would otherwise project the cover with the model not yet turned into its
                // resting pose and size the canvas wrongly until the next resize.
                scene.updateMatrixWorld(true);
                var pr = measureDesignRect(posterEl);
                var ar = measureDesignRect(anchor);
                if (!pr.width || !pr.height) { return; }

                coverPx = pr.height * (answer.Size || 60) / 100;
                unitsPerPx = coverUnits / coverPx;
                var sideExact = 2 * half / unitsPerPx;
                side = Math.ceil(sideExact);

                // ... and then corrected to the POSTER'S OWN PLANE.
                //
                // `half` is what the camera frames at the PIVOT plane, and the
                // pivot is the middle of the case. The poster is not there: it
                // is painted on the cover's FRONT face, which stands half the
                // case thickness closer to the camera - measured from the
                // model, z +2.452 against a camera at 364.536. Under a
                // perspective camera that is a magnification of
                // 364.536 / (364.536 - 2.452) = 1.00677, about 5 px on a 720 px
                // poster against the flat case's.
                //
                // The correction is PROJECTED, not computed from that number:
                // the face's distance changes with turn and tilt, and a fixed
                // factor would be wrong at every pose but one. Two points on
                // the face, one projection each, and the scale follows - the
                // projection is linear in `side`, so a single pass is exact.
                var face = M.meshes && M.meshes.cover;
                if (face) {
                    face.updateMatrixWorld(true);
                    if (!face.geometry.boundingBox) { face.geometry.computeBoundingBox(); }
                    var fbb = face.geometry.boundingBox.clone().applyMatrix4(face.matrixWorld);
                    var xMid = (M.D.FC.x0 + M.D.FC.x1) / 2;
                    var pTop = new THREE.Vector3(xMid, M.D.FC.y0 + coverUnits, fbb.max.z).project(camera);
                    var pBot = new THREE.Vector3(xMid, M.D.FC.y0, fbb.max.z).project(camera);
                    var gotPx = Math.abs(pTop.y - pBot.y) * 0.5 * side;
                    if (gotPx > 1) { sideExact = side * coverPx / gotPx; }
                }
                // The drawing buffer has to be a whole number of pixels; the
                // CSS size does not. The buffer rounds UP, the element is given
                // the exact size, and the browser scales the finished canvas by
                // a fraction of a per cent.
                side = Math.ceil(sideExact);

                var pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
                if (side * pixelRatio > THREEJS_BUFFER_CAP_PX) {
                    var capped = Math.max(THREEJS_BUFFER_CAP_PX / side, 0.5);
                    log('canvas ' + side + ' px: pixel ratio ' + pixelRatio.toFixed(2)
                        + ' -> ' + capped.toFixed(2) + ' to stay under the '
                        + THREEJS_BUFFER_CAP_PX + ' px buffer cap');
                    pixelRatio = capped;
                }
                renderer.setPixelRatio(pixelRatio);
                renderer.setSize(side, side, false);
                canvas.style.width = sideExact + 'px';
                canvas.style.height = sideExact + 'px';
                renderer.render(scene, camera);

                var coverCentre = new THREE.Vector3(
                    (M.D.FC.x0 + M.D.FC.x1) / 2, M.D.FC.y0 + coverUnits / 2, 0);
                pose.updateMatrixWorld(true);
                coverCentre.applyMatrix4(M.group.matrixWorld);
                coverCentre.project(camera);
                var coverCx = (coverCentre.x * 0.5 + 0.5) * sideExact;
                var coverCy = (0.5 - coverCentre.y * 0.5) * sideExact;

                var coverWpx = (M.D.FC.x1 - M.D.FC.x0) / (coverUnits / coverPx);
                var ca = CASE_ANCHORS[answer.Anchor] || [0.5, 0.5];
                var wantCx = (pr.width - coverWpx) * ca[0] + coverWpx / 2;
                var wantCy = (pr.height - coverPx) * ca[1] + coverPx / 2;
                canvas.style.left = Math.round(pr.left - ar.left + wantCx - coverCx) + 'px';
                canvas.style.top = Math.round(pr.top - ar.top + wantCy - coverCy) + 'px';
                // The hit box follows the poster too, on every relayout (attachGestures places it
                // only once).
                if (mounted && mounted.hit) {
                    mounted.hit.style.left = Math.round(pr.left - ar.left) + 'px';
                    mounted.hit.style.top = Math.round(pr.top - ar.top) + 'px';
                    mounted.hit.style.width = Math.round(pr.width) + 'px';
                    mounted.hit.style.height = Math.round(pr.height) + 'px';
                }
            }
            // layoutCase() is NOT called here. It measures `anchor`, which is
            // `canvas.offsetParent` and therefore only exists once the canvas
            // is in the document - that happens further down, and so does the
            // first call. Called here, the measurement would throw and the
            // mount would fail.

            var stopLayoutWatch = function () {
                window.removeEventListener('resize', queueLayout);
                document.removeEventListener('fullscreenchange', queueLayout);
                if (posterBoxWatch) { posterBoxWatch.disconnect(); posterBoxWatch = null; }
                if (layoutQueued !== null) { cancelAnimationFrame(layoutQueued); layoutQueued = null; }
            };

            mounted = { renderer: renderer, canvas: canvas, itemId: itemId, scene: scene, camera: camera,
                        model: M, Renderer: Renderer, coverTexture: coverTexture, geometries: [], materials: [],
                        stopCoverWatch: function () { if (onCoverWatchStop) { onCoverWatchStop(); onCoverWatchStop = null; } },
                        stopLayoutWatch: stopLayoutWatch,
                        coverFade: null, frameQueued: false, lastTick: 0, frames: 0, gif: null, cycle: null, autoPending: false, pinColour: pinColour,
                        get coverMix() { return coverMix; },
                        ownCoverTexture: ownCoverTexture };
            watchCoverSource();
            // THE COVER IS PAINTED BEFORE `mounted` EXISTS. The whole poster
            // chain runs while the case is still being built, so the paint
            // that puts the first picture on the wrap happens with `mounted`
            // still null - and a decoder started there would have nowhere to
            // live. So the moving cover is asked for once more HERE, the
            // first moment there is something to attach it to. Without it the
            // animated poster can stay a still on a normal page change.
            syncCoverGif();

            // The canvas hangs on the PAGE, not on .detailImageContainer.
            // .detailPagePrimaryContainer has position:relative and z-index 2
            // of its own, so it forms a stacking context - and everything
            // inside it, our canvas included, paints above the sibling
            // .detailPageSecondaryContainer that holds the audio and subtitle
            // selects. A negative z-index only reorders WITHIN that context.
            // One level up, at .itemDetailPage, z-index -1 does what it says:
            // the canvas paints before all normal flow and before every
            // positioned element of the page. Every ancestor there is
            // transparent, so nothing hides it.
            view.appendChild(canvas);

            var anchor = canvas.offsetParent || container;
            var anchorRect = measureDesignRect(anchor);

            // Size, render and place - now that `anchor` exists.
            layoutCase();

            // And again on every size change, the way the flat case behaves.
            // Jellyfin's poster box is in vw, so this covers a window resize, a
            // devtools pane, a zoom step and fullscreen alike. Entering
            // fullscreen resizes the window and fires `resize` anyway;
            // `fullscreenchange` is listened for as well because the two do not
            // always arrive in the same frame, and the later one simply re-runs
            // a cheap layout.
            //
            // Coalesced to one animation frame: a window drag emits resize
            // events by the dozen and each layout re-renders the scene.
            var layoutQueued = null;
            function queueLayout() {
                if (layoutQueued !== null) { return; }
                layoutQueued = requestAnimationFrame(function () {
                    layoutQueued = null;
                    if (!document.body.contains(canvas)) { return; }
                    layoutCase();
                });
            }
            window.addEventListener('resize', queueLayout);
            document.addEventListener('fullscreenchange', queueLayout);
            // The poster can also move WITHOUT a window resize: on phones it hangs from the bottom of the
            // ribbon (librarybrowser.scss, both versions), which grows while title, ratings and buttons
            // arrive after the mount. Watching the box the poster hangs in, and the poster itself,
            // catches that.
            // Not the page: its height changes with every lazy row below and would relayout for nothing.
            var posterBoxWatch = null;
            if (typeof ResizeObserver === 'function') {
                posterBoxWatch = new ResizeObserver(queueLayout);
                var hangsIn = posterEl.closest('.detailRibbon') || posterEl.closest('.detailPagePrimaryContainer');
                if (hangsIn) { posterBoxWatch.observe(hangsIn); }
                posterBoxWatch.observe(posterEl);
            }

            // With diagnostics on, the mount is reachable as
            // ArtworkPlusPostersDiagnostics.caseMount (e.g. to hide the shell
            // meshes and compare the 3D poster with the flat case's).
            if (diagnostics) { diagnostics.caseMount = mountedLayout(); }
            function mountedLayout() {
                return { canvas: canvas, model: M, renderer: renderer, scene: scene,
                         camera: camera, layout: layoutCase };
            }

            void canvas.offsetWidth;
            canvas.classList.add('is-in');
            view.classList.add(HOLD_CLASS);

            // "Behind the text" is the only mode that touches the page at all.
            // In front, not one rule of the block below ever matches.
            mounted.unwatchTextures = watchTextures(THREE);
            // The still-frame smoothing - one per mount, gone with it.
            mounted.aa = createStillAA(THREE, renderer, scene, camera, canvas);
            requestStillFrame();

            if ((answer.Layer || 'BehindText') === 'BehindText') {
                view.classList.add(BEHIND_CLASS);
                mounted.tints = markTints(view, canvas.getBoundingClientRect());
            }

            // The hit box goes into the SAME frame as the canvas: its left/top
            // are computed against the canvas's offset parent, so it must be
            // appended there too. One measured frame, both overlays.
            attachGestures(anchor, anchorRect, posterRect, coverPx, answer, THREE, Renderer);
            return true;
        }

        // ------------------------------------------------------------------
        // Gestures and the opening.
        // ------------------------------------------------------------------
        // One render loop, and it only runs while something actually moves -
        // an opening, the disc, or auto rotate. Idle costs nothing; a
        // permanently spinning rAF would make every detail page pay.
        // The largest distance from the pivot to any vertex, at the angle this
        // case can actually reach. Opens the model, measures, closes it again -
        // a few dozen thousand vertices, once per mount, and it removes a whole
        // class of "why is it cut off" for good.
        function measureRadius(M, maxAngle) {
            var Renderer = window.ArtworkPlusThreejsRenderer;
            var r = 0;
            var angles = maxAngle > 0 ? [0, maxAngle] : [0];
            for (var a = 0; a < angles.length; a++) {
                Renderer.open(angles[a]);
                for (var k in M.meshes) {
                    if (!M.meshes.hasOwnProperty(k) || !M.meshes[k].visible) { continue; }
                    var g = M.meshes[k].geometry;
                    if (!g || !g.attributes || !g.attributes.position) { continue; }
                    var p = g.attributes.position.array;
                    for (var i = 0; i < p.length; i += 3) {
                        // The 3D distance, not the per-axis extent: the case is
                        // TURNED and TILTED, so a vertex at x 50 / z 40 reaches
                        // x 63.5 after a 31.5 degree turn. Only a radius about
                        // the pivot is invariant under any pose.
                        var x = p[i] + M.group.position.x;
                        var y = p[i + 1] + M.group.position.y;
                        var z = p[i + 2] + M.group.position.z;
                        var d = Math.sqrt(x * x + y * y + z * z);
                        if (d > r) { r = d; }
                    }
                }
            }
            Renderer.open(0);
            // A little air so an antialiased edge never touches the border.
            return r * 1.04;
        }

        /// A MOVING COVER.
        ///
        /// The flat case type gets this for free: it leaves the page's own
        /// .cardImageContainer where it is and builds the case AROUND it, so
        /// the browser animates a real DOM element and nothing is copied. A
        /// mesh has no such element - the cover is a texture, and a texture
        /// only changes when something writes to it.
        ///
        /// So the frames are decoded here, not read out of an <img>: a
        /// browser does not reliably advance a GIF that is not displayed, and
        /// drawing such an <img> keeps returning one frame.
        ///
        /// WebCodecs' ImageDecoder gives the frames outright. For a 500 x 713,
        /// 60-frame poster that is about 1.3 ms to decode and 0.9 ms to
        /// upload, against the 80 ms the GIF allows per frame.
        ///
        /// Only the front rectangle of the wrap is redrawn. The back sheet is
        /// composed once - re-running it per frame would mean the typeset
        /// plot, the flag row and the procedural barcode sixty times over.
        function coverIsAnimated(url) {
            // Only our own endpoint serves animated covers, and asking it is
            // free because the bytes are already in the HTTP cache - the
            // Animated module preloaded them before the arbiter settled.
            return !!url && /\/AnimatedPoster\//i.test(url);
        }

        function stopCoverGif() {
            if (!mounted || !mounted.gif) { return; }
            try { if (mounted.gif.decoder) { mounted.gif.decoder.close(); } } catch (e) { /* already closed */ }
            mounted.gif = null;
        }

        function startCoverGif(url) {
            if (!mounted) { return; }
            if (typeof window.ImageDecoder !== 'function') {
                log('no ImageDecoder in this browser - the cover stays on one frame');
                return;
            }
            if (mounted.gif && mounted.gif.url === url) { return; }
            stopCoverGif();
            var itemAtStart = mounted.itemId;
            var state = { url: url, decoder: null, index: 0, count: 0,
                          nextAt: 0, busyDecoding: false };
            mounted.gif = state;
            fetch(url, { cache: 'force-cache' })
                .then(function (r) { return r.arrayBuffer(); })
                .then(function (buf) {
                    // The file is the authority on whether it moves - the URL
                    // is not. A single-frame GIF served by the same endpoint
                    // must not start a loop that repaints for nothing.
                    var dec = new window.ImageDecoder({ data: buf, type: 'image/gif' });
                    return dec.tracks.ready.then(function () { return dec; });
                })
                .then(function (dec) {
                    if (!mounted || mounted.itemId !== itemAtStart || mounted.gif !== state) { dec.close(); return; }
                    var track = dec.tracks.selectedTrack;
                    if (!track || !track.animated || track.frameCount < 2) {
                        log('the cover is a single-frame image - nothing to animate');
                        dec.close(); mounted.gif = null; return;
                    }
                    state.decoder = dec;
                    state.count = track.frameCount;
                    state.nextAt = performance.now();
                    log('animated cover: ' + track.frameCount + ' frames');
                    kick();
                })
                .catch(function (e) {
                    log('the cover could not be decoded - it stays on one frame', e);
                    if (mounted && mounted.gif === state) { mounted.gif = null; }
                });
        }

        /// One step of the moving cover, called from the frame loop. Returns
        /// true while it wants more frames - the loop's `busy` is DERIVED from
        /// the state, never a second flag that something has to remember to
        /// clear. A moving cover has no end, so there is no event at which a
        /// flag could be cleared; a derived condition cannot drift.
        function stepCoverGif(now) {
            var g = mounted && mounted.gif;
            if (!g || !g.decoder) { return !!g; }
            if (g.busyDecoding || now < g.nextAt) { return true; }
            g.busyDecoding = true;
            var wanted = g.index;
            g.decoder.decode({ frameIndex: wanted }).then(function (res) {
                var live = mounted && mounted.gif === g;
                if (!live) { res.image.close(); return; }
                // The LIVE map, looked up per frame. Holding a reference
                // would paint into the texture that a crossfade has already
                // retired - the frames would land on a picture nobody sees.
                var M = mounted.model, live = M && M.matCover && M.matCover.map;
                var f = live && live.__apFront;
                if (!f) { res.image.close(); g.busyDecoding = false; return; }
                f.ctx.drawImage(res.image, 0, 0, res.image.displayWidth, res.image.displayHeight,
                                f.x, f.y, f.w, f.h);
                // THE COST SCALES WITH THE CANVAS, NOT WITH THE PICTURE.
                // Only the front rectangle is redrawn, but the upload that
                // follows carries the WHOLE wrap - the back sheet with it.
                // At 2048 and 80 ms frames that is 0.9 ms against a 80 ms
                // budget. At 4096 the upload is four times as much, and a 30 ms
                // GIF triples the rate - twelve times the work together.
                // Splitting the front onto its own material would remove the
                // dependency.
                live.needsUpdate = true;
                // The GIF's own timing, not the screen's. duration is in
                // microseconds; a frame without one falls back to 100 ms,
                // which is what browsers do with a zero delay.
                var ms = res.image.duration ? res.image.duration / 1000 : 100;
                res.image.close();
                g.index = (wanted + 1) % g.count;
                g.nextAt = now + ms;
                g.busyDecoding = false;
                kick();
            }).catch(function (e) {
                log('a cover frame could not be decoded - the cover stops moving', e);
                if (mounted && mounted.gif === g) { mounted.gif = null; }
            });
            return true;
        }

        // Every ordinary frame goes through here, and every ordinary frame
        // starts the still-frame smoothing over: whatever changed, the frames
        // collected so far belong to a picture that is no longer on screen.
        function draw() {
            if (!mounted) { return; }
            mounted.renderer.render(mounted.scene, mounted.camera);
            if (mounted.aa) { mounted.aa.restart(); requestStillFrame(); }
        }

        // ------------------------------------------------------------------
        // STILL-FRAME SMOOTHING.
        //
        // The white line along the case's lower edge is a lit surface seen
        // edge-on, thinner than a pixel: the canvas' own multisampling (4
        // samples) only smooths polygon EDGES, so the line breaks into stairs.
        // Averaging many frames, each shifted by a fraction of a pixel (Halton
        // 2,3 via setViewOffset), removes it.
        //
        // Only while the case stands still: in motion every frame is the
        // normal frame, unchanged. Once nothing has drawn for 150 ms, 32 shifted
        // frames of the case's screen box are rendered (2 per frame of the
        // host's own loop - no second chain), each at 1 sample, into an RGBA8
        // target with the canvas' own output encoding and 24-bit depth +
        // stencil (a 16-bit depth buffer lets the coplanar shell faces fight),
        // and summed at 1/N into one RGBA16F accumulator. Averaging the ENCODED
        // values is what the canvas' multisample resolve does as well, so the
        // colours stay the same; averaging linear values puts halos on the
        // edges. From the 8th frame on the canvas shows the normal full frame
        // with the case box replaced by the average.
        //
        // Every failure falls back to the normal picture: no WebGL2, no float
        // render targets, an incomplete framebuffer, a first frame that came
        // out empty, a GL error, a lost context. Off by
        // localStorage.setItem('ArtworkPlusStillAA', 'off').
        var STILL_AA = { N: 32, SHOW_FROM: 8, PER_FRAME: 2, QUIET_MS: 150, MARGIN_PX: 3 };

        function createStillAA(THREE, renderer, scene, camera, canvas) {
            try { if (localStorage.getItem('ArtworkPlusStillAA') === 'off') { return null; } } catch (e) { /* no storage */ }
            var gl = renderer.getContext();
            if (!renderer.capabilities.isWebGL2 || !renderer.extensions.has('EXT_color_buffer_float')
                    || !THREE.ShaderMaterial || !THREE.WebGLRenderTarget) {
                log('still-frame smoothing unavailable (needs WebGL2 + float render targets) - today\'s picture stays');
                return null;
            }
            var st = { k: 0, t0: performance.now(), dead: false, verified: false, region: null,
                       frame: null, acc: null, ms: 0, bursts: 0 };
            var vs = 'uniform vec4 uRect; varying vec2 vUv;'
                   + ' void main(){ vUv = uv; gl_Position = vec4(mix(uRect.xy, uRect.zw, uv), 0.0, 1.0); }';
            var addMat = new THREE.ShaderMaterial({
                uniforms: { tSrc: { value: null }, uW: { value: 1 / STILL_AA.N }, uRect: { value: new THREE.Vector4(-1, -1, 1, 1) } },
                vertexShader: vs,
                fragmentShader: 'uniform sampler2D tSrc; uniform float uW; varying vec2 vUv;'
                              + ' void main(){ gl_FragColor = texture2D(tSrc, vUv) * uW; }',
                blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
                blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, depthTest: false, depthWrite: false
            });
            var showMat = new THREE.ShaderMaterial({
                uniforms: { tSrc: { value: null }, uW: { value: 1 }, uRect: { value: new THREE.Vector4(-1, -1, 1, 1) } },
                vertexShader: vs,
                fragmentShader: 'uniform sampler2D tSrc; uniform float uW; varying vec2 vUv;'
                              + ' void main(){ gl_FragColor = texture2D(tSrc, vUv) * uW; }',
                blending: THREE.NoBlending, depthTest: false, depthWrite: false
            });
            var quadGeo = new THREE.PlaneGeometry(2, 2);
            var quad = new THREE.Mesh(quadGeo, addMat);
            quad.frustumCulled = false;
            var qScene = new THREE.Scene();
            qScene.add(quad);
            var qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            var buf = new THREE.Vector2();
            var box = new THREE.Box3(), corner = new THREE.Vector3();

            function fail(why, e) {
                if (st.dead) { return; }
                st.dead = true;
                log('still-frame smoothing off for this case: ' + why + ' - today\'s picture stays', e || '');
                // the canvas may hold half a smoothed frame; a normal frame replaces it
                try { renderer.setRenderTarget(null); renderer.render(scene, camera); } catch (e2) { /* the next frame will */ }
            }
            function onLost(ev) { st.dead = true; }
            canvas.addEventListener('webglcontextlost', onLost, false);

            function halton(i, b) { var f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

            // The case's box on the drawing buffer, from what is visible, plus
            // a margin for the half-pixel shifts. Fixed for the whole burst.
            function measureRegion(W, H) {
                var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
                scene.updateMatrixWorld(true);
                camera.updateMatrixWorld(true);
                scene.traverseVisible(function (o) {
                    if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) { return; }
                    // recomputed: applyAspect moves vertices after any earlier box was taken
                    o.geometry.computeBoundingBox();
                    box.copy(o.geometry.boundingBox);
                    if (box.isEmpty()) { return; }
                    for (var c = 0; c < 8; c++) {
                        corner.set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z)
                              .applyMatrix4(o.matrixWorld).project(camera);
                        if (corner.z > 1 || corner.z < -1) { behind = true; }
                        var px = (corner.x * 0.5 + 0.5) * W, py = (0.5 - corner.y * 0.5) * H;
                        if (px < x0) { x0 = px; } if (px > x1) { x1 = px; }
                        if (py < y0) { y0 = py; } if (py > y1) { y1 = py; }
                    }
                });
                if (behind || !isFinite(x0)) { x0 = 0; y0 = 0; x1 = W; y1 = H; }
                x0 = Math.max(0, Math.floor(x0) - STILL_AA.MARGIN_PX); y0 = Math.max(0, Math.floor(y0) - STILL_AA.MARGIN_PX);
                x1 = Math.min(W, Math.ceil(x1) + STILL_AA.MARGIN_PX); y1 = Math.min(H, Math.ceil(y1) + STILL_AA.MARGIN_PX);
                if (x1 - x0 < 2 || y1 - y0 < 2) { return null; }
                return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, W: W, H: H };
            }

            function complete(rt) {
                renderer.setRenderTarget(rt);
                return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
            }

            function targets(r) {
                if (st.frame && st.frame.width === r.w && st.frame.height === r.h) { return true; }
                if (st.frame) { st.frame.dispose(); st.acc.dispose(); }
                var o = { format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false };
                st.frame = new THREE.WebGLRenderTarget(r.w, r.h, Object.assign({}, o, {
                    type: THREE.UnsignedByteType, encoding: renderer.outputEncoding, depthBuffer: true, stencilBuffer: true }));
                st.acc = new THREE.WebGLRenderTarget(r.w, r.h, Object.assign({}, o, {
                    type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false }));
                var ok = complete(st.frame) && complete(st.acc);
                renderer.setRenderTarget(null);
                return ok;
            }

            function rectOf(r) {
                return new THREE.Vector4(2 * r.x / r.W - 1, 1 - 2 * (r.y + r.h) / r.H,
                                         2 * (r.x + r.w) / r.W - 1, 1 - 2 * r.y / r.H);
            }

            // One shifted frame of the box into the frame target, added to the sum.
            function oneFrame() {
                var r = st.region, i = st.k + 1, autoClear = renderer.autoClear;
                try {
                    camera.setViewOffset(r.W, r.H, r.x + halton(i, 2) - 0.5, r.y + halton(i, 3) - 0.5, r.w, r.h);
                    renderer.setRenderTarget(st.frame);
                    renderer.render(scene, camera);
                } finally {
                    camera.clearViewOffset();
                }
                if (!st.verified) {
                    // A frame target that renders nothing would show an empty
                    // case; one look at the middle of the box says whether
                    // anything arrived. Once per mount - it waits for the GPU.
                    var n = 16, px = new Uint8Array(n * n * 4), any = false;
                    renderer.readRenderTargetPixels(st.frame, Math.max(0, (r.w >> 1) - 8), Math.max(0, (r.h >> 1) - 8),
                                                    Math.min(n, r.w), Math.min(n, r.h), px);
                    for (var a = 3; a < px.length; a += 4) { if (px[a] > 0) { any = true; break; } }
                    var err = gl.getError();
                    if (!any) { fail('the first shifted frame came out empty'); return; }
                    if (err !== gl.NO_ERROR) { fail('GL error ' + err); return; }
                    st.verified = true;
                }
                try {
                    renderer.setRenderTarget(st.acc);
                    if (st.k === 0) {
                        var cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
                        renderer.setClearColor(0x000000, 0);
                        renderer.clear(true, false, false);
                        renderer.setClearColor(cc, ca);
                    }
                    renderer.autoClear = false;
                    addMat.uniforms.tSrc.value = st.frame.texture;
                    quad.material = addMat;
                    renderer.render(qScene, qCam);
                } finally {
                    renderer.autoClear = autoClear;
                    renderer.setRenderTarget(null);
                }
                st.k++;
            }

            // The normal full frame, then the box replaced by the average so far.
            function show() {
                var autoClear = renderer.autoClear;
                renderer.setRenderTarget(null);
                renderer.render(scene, camera);
                try {
                    renderer.autoClear = false;
                    showMat.uniforms.tSrc.value = st.acc.texture;
                    showMat.uniforms.uW.value = STILL_AA.N / st.k;
                    showMat.uniforms.uRect.value = rectOf(st.region);
                    quad.material = showMat;
                    renderer.render(qScene, qCam);
                } finally {
                    renderer.autoClear = autoClear;
                }
            }

            return {
                /// Something drew an ordinary frame: begin again after the quiet time.
                restart: function () { st.k = 0; st.region = null; st.t0 = performance.now(); },
                /// True while the burst still has frames to do.
                wants: function () { return !st.dead && st.k < STILL_AA.N; },
                /// One step of the burst; the host's loop calls it on a frame of its own.
                step: function () {
                    if (st.dead || st.k >= STILL_AA.N) { return; }
                    var now = performance.now();
                    if (now - st.t0 < STILL_AA.QUIET_MS) { return; }
                    try {
                        if (gl.isContextLost()) { st.dead = true; return; }
                        if (st.k === 0) {
                            renderer.getDrawingBufferSize(buf);
                            st.region = measureRegion(buf.x, buf.y);
                            if (!st.region) { st.k = STILL_AA.N; return; }
                            if (!targets(st.region)) { fail('incomplete framebuffer'); return; }
                            st.ms = 0;
                        }
                        for (var n = 0; n < STILL_AA.PER_FRAME && st.k < STILL_AA.N && !st.dead; n++) { oneFrame(); }
                        if (!st.dead && st.k >= STILL_AA.SHOW_FROM) { show(); }
                        st.ms += performance.now() - now;
                        if (st.k >= STILL_AA.N) { st.bursts++; }
                        canvas.__apStillAA = { k: st.k, region: st.region, ms: Math.round(st.ms), bursts: st.bursts, dead: st.dead };
                    } catch (e) {
                        try { camera.clearViewOffset(); } catch (e2) { /* it was never set */ }
                        fail('an exception', e);
                    }
                },
                dispose: function () {
                    st.dead = true;
                    canvas.removeEventListener('webglcontextlost', onLost, false);
                    if (st.frame) { st.frame.dispose(); st.acc.dispose(); }
                    st.frame = st.acc = null;
                    addMat.dispose(); showMat.dispose(); quadGeo.dispose();
                }
            };
        }

        // A frame asked for BY the smoothing: it must not count as a change, or
        // the burst would restart itself for ever. Any other caller of
        // requestFrame() in the meantime turns it back into an ordinary frame.
        function requestStillFrame() { requestFrame(true); }

        // TextureLoader hands back a texture that is still empty and fills it
        // later. This module draws on demand, not in a permanent loop, so
        // without a signal the frame that shows the finished texture never
        // comes and the interior faces stay black until something draws again.
        // DefaultLoadingManager is three.js's own signal for exactly this - it
        // is what every TextureLoader without a manager of its own reports to.
        // Any handler already there is kept: we are guests on a global object.
        function watchTextures(THREE) {
            var mgr = THREE.DefaultLoadingManager;
            if (!mgr) { return null; }
            var prev = { onLoad: mgr.onLoad, onProgress: mgr.onProgress };
            mgr.onLoad = function () {
                if (prev.onLoad) { try { prev.onLoad.apply(this, arguments); } catch (e) { /* theirs */ } }
                log('texture batch finished - drawing');
                draw();
            };
            mgr.onProgress = function () {
                if (prev.onProgress) { try { prev.onProgress.apply(this, arguments); } catch (e) { /* theirs */ } }
                draw();
            };
            return function () { mgr.onLoad = prev.onLoad; mgr.onProgress = prev.onProgress; };
        }

        /// THE ONLY PLACE A FRAME IS ASKED FOR.
        ///
        /// A "frame pending" flag maintained at the bottom of the frame, inside
        /// a branch, goes stale when a frame never arrives. This is three.js's
        /// own documented shape instead (manual, Rendering on
        /// Demand): the flag is raised immediately before requestAnimationFrame
        /// and lowered as the first statement INSIDE the frame, so it is true
        /// only for the gap between asking and arriving. Exactly one frame can
        /// ever be pending, every caller may ask as often as it likes, and
        /// there is no state left to go stale.
        ///
        /// Under a throttled window (a covered window is throttled to a few
        /// rendering opportunities a second or none at all) the flag stays
        /// raised and this asks for nothing further - which is right: the frame
        /// already queued will run at the next opportunity, and queueing more
        /// would not create one.
        function requestFrame(still) {
            if (!mounted) { return; }
            if (still !== true) { mounted.stillOnly = false; }
            if (mounted.frameQueued) { return; }
            if (still === true) {
                if (!mounted.aa || !mounted.aa.wants()) { return; }
                mounted.stillOnly = true;
            }
            mounted.frameQueued = true;
            mounted.raf = requestAnimationFrame(loop);
        }

        function loop() {
            if (!mounted) { return; }
            mounted.frameQueued = false;
            var stillOnly = mounted.stillOnly;
            mounted.stillOnly = false;
            var now = performance.now();
            mounted.lastTick = now;
            mounted.frames = (mounted.frames || 0) + 1;
            // Everything that moves on its own is measured in TIME, not in
            // frames, so the speed does not depend on the monitor's refresh
            // rate or on load.
            // The cap matters here in particular: requestAnimationFrame stops
            // while the window is covered, so the first frame afterwards would
            // otherwise report the whole pause and jump the case through a
            // visible arc. Capped, it simply carries on where it was.
            var dt = mounted.lastFrame ? Math.min(0.1, (now - mounted.lastFrame) / 1000) : 1 / 60;
            mounted.lastFrame = now;
            var busy = false;

            // THE CYCLE: open, turn the disc, close - one timeline, the flat
            // case type's own. It drives the lid and the disc DIRECTLY instead
            // of starting the two separate animations, because in the flat case
            // they are not separate: the disc is already turning while the lid
            // still swings, and the close begins on the clock, not on an event.
            if (mounted.cycle) {
                var ct = now - mounted.cycle.t0;
                var openTo = mounted.cycle.angle;
                if (ct < CASE_CYCLE.OPEN_MS) {
                    mounted.Renderer.open(openTo * openEase(ct / CASE_CYCLE.OPEN_MS));
                } else if (ct >= CASE_CYCLE.CLOSE_AT) {
                    var cu = Math.min(1, (ct - CASE_CYCLE.CLOSE_AT) / CASE_CYCLE.CLOSE_MS);
                    mounted.Renderer.open(openTo * (1 - openEase(cu)));
                } else {
                    mounted.Renderer.open(openTo);
                }
                if (mounted.cycle.spin && mounted.model.disc) {
                    var full = mounted.spinDir * CASE_CYCLE.TURNS * 2 * Math.PI;
                    var du = (ct - CASE_CYCLE.DISC_AT) / CASE_CYCLE.DISC_MS;
                    // Before its cue the disc stands turned and winds back to its
                    // resting angle - the flat case's keyframe shape.
                    var dp = du <= 0 ? 0 : (du >= 1 ? 1 : easeInOut(du));
                    // MINUS, and the sign matters. CSS and three.js disagree
                    // about what a positive rotation IS: CSS rotate(+deg) turns
                    // clockwise on screen, three.js rotation.z turns
                    // COUNTER-clockwise (right-handed, and this camera sits at
                    // +z looking back at the origin - see camera.position.set).
                    // The flat case defines "Left" as its keyframes 360deg ->
                    // 0deg, i.e. a DECREASING CSS angle, which on screen is
                    // counter-clockwise. This cycle and the disc's own click
                    // (spinAnim, from + spinDir * 2pi) must agree with each
                    // other and with the CSS.
                    mounted.model.disc.rotation.z = mounted.cycle.discFrom - full * (1 - dp);
                }
                if (ct >= CASE_CYCLE.MS) {
                    mounted.openAngle = 0;
                    mounted.cycle = null;
                    mounted.autoPending = false;   // the case is the viewer's again
                    log('open/spin/close cycle finished');
                } else {
                    busy = true;
                }
            }

            if (mounted.anim) {
                var a = mounted.anim;
                var u = Math.min(1, (now - a.t0) / a.ms);
                // easeInOutCubic, the same curve upstream animates with
                var e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
                mounted.Renderer.open(a.from + (a.to - a.from) * e);
                if (u >= 1) { mounted.anim = null; mounted.openAngle = a.to; } else { busy = true; }
            }

            // The way home. Three values travel together - the two pose angles
            // and the camera zoom - over real elapsed time, on the same curve
            // the opening uses. `busy` stays true for the whole trip, so the
            // loop never lapses and gets kicked again mid-flight, which is
            // where a glide stutters.
            if (mounted.reset) {
                var rs = mounted.reset;
                var ru = Math.min(1, (now - rs.t0) / rs.ms);
                var re = ru < 0.5 ? 4 * ru * ru * ru : 1 - Math.pow(-2 * ru + 2, 3) / 2;
                // THE SHORT WAY ROUND. A plain difference between two angles
                // takes whatever path the numbers describe, and rotation.y
                // grows without bound while the automatic turn runs - after a
                // while it is 20 radians, not 0.3 - and the case would travel
                // all the way back through every turn it had made, up to 359
                // degrees where 1 would do.
                //
                // atan2(sin d, cos d) folds any difference into (-pi, pi], so
                // the glide always takes the shorter of the two arcs. Applied
                // to the tilt too: it cannot wrap in normal use, and if it ever
                // does, the same answer is the right one.
                mounted.pose.rotation.x = rs.fromX + shortWay(mounted.baseTilt - rs.fromX) * re;
                mounted.pose.rotation.y = rs.fromY + shortWay(mounted.baseTurn - rs.fromY) * re;
                mounted.pose.rotation.z = rs.fromZ * (1 - re);
                var z = rs.fromZoom + (1 - rs.fromZoom) * re;
                mounted.zoom = z;
                mounted.camera.zoom = z;
                mounted.camera.updateProjectionMatrix();
                if (ru >= 1) {
                    mounted.reset = null;
                    // Only now: the automatic turn would otherwise fight the
                    // glide over rotation.y in the same frames.
                    mounted.autoRotate = rs.autoRotateAfter;
                    // The rest, and then the ramp from a standstill - the same
                    // start-up the case gets on a page visit, so the way back
                    // and the arrival look alike.
                    mounted.resumeAt = now + RESET_REST_MS;
                    mounted.rampT0 = mounted.resumeAt;
                }
                busy = true;
            }

            // ONE revolution per click, not a permanently spinning disc. It is
            // an animation with an end, like the opening. The speed is
            // upstream's 1.2 rad/s, and the stop eases out instead of cutting
            // off.
            // The crossfade: one uniform, on the curve CSS `ease` draws, so
            // it feels like the flat poster's own fade.
            // A moving cover keeps the loop awake by BEING there - the
            // condition is the state itself, not a flag set elsewhere.
            if (stepCoverGif(now)) { busy = true; }

            if (mounted.coverFade && mounted.coverMix) {
                var cf = mounted.coverFade;
                var cu = Math.min(1, (now - cf.t0) / cf.ms);
                cf.frames = (cf.frames || 0) + 1;
                mounted.coverMix.uCoverMix.value = cssEase(cu);
                if (cu >= 1) {
                    // The new picture becomes the real map and the mix goes
                    // back to nothing - so the next fade starts from what is
                    // actually on screen, and the shader takes its cheap path.
                    var M2 = mounted.model;
                    if (M2 && M2.matCover) {
                        M2.matCover.map = cf.tex;
                        M2.matCover.needsUpdate = true;
                    }
                    mounted.coverMix.uCoverMix.value = 0;
                    mounted.coverMix.uCoverNext.value = null;
                    // The owner disposes the one it is replacing - never the
                    // shell's shared template, which it does not hold.
                    if (mounted.ownCoverTexture) { mounted.ownCoverTexture(cf.tex); }
                    log('crossfade done after ' + cf.frames + ' frames');
                    mounted.coverFade = null;
                } else {
                    busy = true;
                }
            }

            if (mounted.spinAnim && mounted.model.disc) {
                var sp = mounted.spinAnim;
                var su = Math.min(1, (now - sp.t0) / sp.ms);
                var se = su < 0.5 ? 4 * su * su * su : 1 - Math.pow(-2 * su + 2, 3) / 2;
                mounted.model.disc.rotation.z = sp.from + (sp.to - sp.from) * se;
                if (su >= 1) { mounted.spinAnim = null; } else { busy = true; }
            }

            // The automatic turn ACCELERATES out of a standstill instead of
            // starting at full speed with a jolt. The eased
            // ramp leaves the standstill with zero acceleration AND reaches the
            // final speed with zero acceleration, so neither end has a kick -
            // a plain linear ramp would have traded the jerk at the start for
            // one at the moment it clamps.
            // `resumeAt` is the rest after the double click: the loop keeps
            // running through it (busy stays true) so the ramp starts the
            // instant the rest is over, rather than on the next stray frame.
            if (mounted.autoRotate && !mounted.reset) {
                if (now < mounted.resumeAt) {
                    mounted.rampT0 = now;
                    busy = true;
                } else {
                    var ru2 = Math.min(1, (now - mounted.rampT0) / ROTATE_RAMP_MS);
                    var re2 = ru2 < 0.5 ? 4 * ru2 * ru2 * ru2 : 1 - Math.pow(-2 * ru2 + 2, 3) / 2;
                    mounted.pose.rotation.y += mounted.rotateDir * mounted.rotateRad * re2 * dt;
                    busy = true;
                }
            }

            // A frame the smoothing asked for, and nothing moved in it: one
            // step of the burst instead of an ordinary frame.
            if (stillOnly && !busy && mounted.aa) { mounted.aa.step(); } else { draw(); }
            // Diagnostic values on the canvas, written at the END of the
            // frame: the fade completes above this point, so values written
            // at the head of the frame would stay stale after the last frame.
            if (mounted.canvas) {
                // A covered window and a shader that never compiled are both
                // silent in the log, but differ here: no frames at all, versus
                // frames with the mix stuck at zero.
                mounted.canvas.__apFrames = mounted.frames;
                mounted.canvas.__apMix = coverMixValue();
                // renderer.info is three's own live resource count - it counts
                // what the CONTEXT holds, so it shows whether a cycle leaks.
                mounted.canvas.__apInfo = mounted.renderer ? mounted.renderer.info.memory : null;
                mounted.canvas.__apFading = !!mounted.coverFade;
                mounted.canvas.__apFadeMs = mounted.coverFade ? mounted.coverFade.ms : null;
            }

            if (busy) { requestFrame(); } else { requestStillFrame(); }
        }

        // The loop is the only thing that moves the case, so ONE bad frame must
        // not be able to end it. Without this, an exception anywhere above
        // would leave the loop flags stale, and the case would never move
        // again with nothing on screen to say why.
        var loopInner = loop;
        loop = function (now) {
            try { loopInner(now); }
            catch (e) {
                if (mounted) { mounted.raf = 0; mounted.frameQueued = false; }
                log('the animation loop threw - the case stops here', e);
            }
        };

        // How long the automatic turn takes to reach its set speed from a
        // standstill - on a page visit as much as after a reset. Long enough to
        // read as starting up, short enough that the first revolution is not
        // noticeably slower than the ones after it.
        // The cover crossfade length when nothing on the page declares one;
        // normally the real length is read off the fading layer by
        // pageFadeMs().
        var COVER_FADE_MS = 1000;

        /// CSS `ease`, which is what the flat poster's layers fade with
        /// (`transition: opacity <ms> ease`). Solved rather than approximated,
        /// so the two case types agree about how a crossfade feels.
        /// cubic-bezier(0.25, 0.1, 0.25, 1.0), x solved by Newton, then y.
        function cssEase(t) {
            if (t <= 0) { return 0; }
            if (t >= 1) { return 1; }
            var x1 = 0.25, y1 = 0.1, x2 = 0.25, y2 = 1.0;
            var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
            var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
            var u = t;
            for (var i = 0; i < 6; i++) {
                var x = ((ax * u + bx) * u + cx) * u - t;
                var d = (3 * ax * u + 2 * bx) * u + cx;
                if (Math.abs(d) < 1e-6) { break; }
                u -= x / d;
            }
            return ((ay * u + by) * u + cy) * u;
        }

        var ROTATE_RAMP_MS = 900;
        // MODULE scope, not attachGestures' - loop() lives out here and reads
        // it on the LAST frame of every reset. Its sibling RESET_MS belongs in
        // attachGestures, because only the gesture code reads that one.
        var RESET_REST_MS = 1000;
        // One revolution, at the speed the FLAT case type spins its disc.
        // Read off that animation: it runs 8000 ms, but the disc only moves
        // between its 18.75 % and 72.5 % keyframes - 4300 ms - and covers 720
        // degrees in that window, 167 degrees a second (upstream's 1.2 rad/s
        // is 69).
        var THREEJS_SPIN_MS = Math.round(360 / (720 / 4300));   // 2150 ms for one turn

        /// Everything that starts a motion calls this; an alias of
        /// requestFrame().
        function kick() { requestFrame(); }

        /// The signed difference folded into (-pi, pi] - the shorter of the two
        /// ways round a circle.
        function shortWay(d) { return Math.atan2(Math.sin(d), Math.cos(d)); }

        /// The mix uniform's current value, or null when the shader never
        /// compiled the crossfade in. Read by the frame probe on the canvas;
        /// the difference between "0" and "null" is the difference between a
        /// fade that is not running and a fade that was never built.
        function coverMixValue() {
            if (!mounted || !mounted.coverMix || !mounted.coverMix.uCoverMix) { return null; }
            return mounted.coverMix.uCoverMix.value;
        }

        // 1000, to match the flat case, whose timeline opens over
        // CASE_CYCLE.OPEN_MS. The easing is the same curve - openEase() is
        // copied from the flat case - so the two lids swing identically.
        var THREEJS_OPEN_MS = 1000;

        /// The cycle both kinds run lives at module scope, as CASE_CYCLE
        /// (above the modules), where its numbers are documented.

        /// The curve the flat case opens and closes with - cubic-bezier
        /// (0.3333, 0.6667, 0.6667, 1.0), its bezierEaseY() solved by bisection.
        /// Copied rather than approximated: the two case types should not
        /// disagree about how a lid swings.
        function openEase(t) {
            if (t <= 0) { return 0; }
            if (t >= 1) { return 1; }
            var y1 = 0.6667, y2 = 1.0, x1 = 0.3333, x2 = 0.6667;
            var lo = 0, hi = 1, mid, mt, x;
            for (var i = 0; i < 30; i++) {
                mid = (lo + hi) / 2; mt = 1 - mid;
                x = 3*mt*mt*mid*x1 + 3*mt*mid*mid*x2 + mid*mid*mid;
                if (x < t) { lo = mid; } else { hi = mid; }
            }
            mt = 1 - mid;
            return 3*mt*mt*mid*y1 + 3*mt*mid*mid*y2 + mid*mid*mid;
        }

        /// CSS `ease-in-out` = cubic-bezier(0.42, 0, 0.58, 1), which is what the
        /// flat case's disc keyframe switches to at 18.75 %.
        function easeInOut(t) {
            if (t <= 0) { return 0; }
            if (t >= 1) { return 1; }
            var x1 = 0.42, y1 = 0.0, x2 = 0.58, y2 = 1.0;
            var cx = 3*x1, bx = 3*(x2-x1) - cx, ax = 1 - cx - bx;
            var cy = 3*y1, by = 3*(y2-y1) - cy, ay = 1 - cy - by;
            var u = t, d, f;
            for (var i = 0; i < 6; i++) {
                f = ((ax*u + bx)*u + cx)*u - t;
                d = (3*ax*u + 2*bx)*u + cx;
                if (Math.abs(d) < 1e-6) { break; }
                u -= f / d;
            }
            u = Math.max(0, Math.min(1, u));
            return ((ay*u + by)*u + cy)*u;
        }

        function animateOpen(to) {
            if (!mounted) { return; }
            var from = mounted.openAngle || 0;
            if (Math.round(from) === Math.round(to)) { return; }
            mounted.anim = { from: from, to: to, t0: performance.now(), ms: THREEJS_OPEN_MS };
            mounted.openAngle = to;
            kick();
        }

        function attachGestures(anchor, anchorRect, posterRect, coverPx, answer, THREE, Renderer) {
            // The hit box IS the free poster box: the case is
            // allowed to paint outside it, behind the page text, but only this
            // rectangle takes the pointer - it is the one part of the page that
            // carries no text of its own, so everywhere else the film's own
            // controls keep their clicks.
            var hit = document.createElement('div');
            hit.className = HIT_CLASS;
            hit.style.width = Math.round(posterRect.width) + 'px';
            hit.style.height = Math.round(posterRect.height) + 'px';
            hit.style.left = Math.round(posterRect.left - anchorRect.left) + 'px';
            hit.style.top = Math.round(posterRect.top - anchorRect.top) + 'px';
            anchor.appendChild(hit);

            mounted.hit = hit;
            mounted.pose = mounted.scene.children.filter(function (c) { return c.type === 'Group'; })[0];
            mounted.openAngle = 0;
            // A case with nothing in it does not open. This
            // gate sits in ONE place, in front of every way to open - the
            // automatic timer, the click, and the reset - instead of being
            // repeated at each of them, where the next way to open would
            // quietly miss it.
            mounted.canOpen = answer.HasDisc !== false;
            mounted.autoRotate = !!answer.AutoRotate;
            // Left is the default and turns the case the way a right-handed
            // browse does; Right is its mirror. Same two values and the same
            // sign convention as the spinning disc, so the two read alike.
            mounted.rotateDir = answer.AutoRotateDirection === 'Right' ? -1 : 1;
            mounted.rotateRad = rotateRadPerSecond(answer);
            mounted.spinDir = (answer.Spin && answer.Spin.Direction === 'Right') ? -1 : 1;
            mounted.spinAnim = null;
            // Both are read as NUMBERS in the loop every frame the turn runs.
            // Left undefined, `now - undefined` is NaN, and a NaN written into
            // rotation.y takes the case off the screen with nothing logged -
            // so they are initialised here rather than on first use.
            mounted.resumeAt = 0;
            mounted.rampT0 = performance.now();
            mounted.baseTurn = (answer.Turn || 0) * Math.PI / 180;
            mounted.baseTilt = -(answer.Tilt || 0) * Math.PI / 180;

            // ---- the one variable that separates a click from a drag -------
            // Pressing is identical for both gestures; only the release tells
            // them apart. Once the pointer has moved, no click can happen any
            // more - releasing after a drag must never open the case.
            var down = null, moved = false;

            // Two-finger pinch: the touch twin of the wheel
            // zoom below - same range (zoomCapOf), same camera zoom. While two
            // fingers rest the case does not turn, and lifting them is never a
            // click. Fingers are tracked by pointerId; setPointerCapture keeps
            // their moves on the hit box, also when "In front" started them.
            var touches = {}, pinch = null;
            function touchCount() { return Object.keys(touches).length; }
            function touchSpread() {
                var k = Object.keys(touches), a = touches[k[0]], b = touches[k[1]];
                return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
            }
            function setZoom(z, cap) {
                z = Math.min(1 + cap, Math.max(1 - cap, z));
                if (z === mounted.zoom) { return; }
                mounted.zoom = z;
                mounted.camera.zoom = z;
                mounted.camera.updateProjectionMatrix();
                draw();
            }

            function grab(e) {
                if (e.button !== 0) { return; }
                if (e.pointerType === 'touch') {
                    // A first finger starts a fresh gesture: whatever a lost
                    // pointerup left behind must not turn it into a "second" one.
                    if (e.isPrimary) { touches = {}; pinch = null; }
                    touches[e.pointerId] = { x: e.clientX, y: e.clientY };
                    if (touchCount() > 2) { return; }   // a third finger changes nothing
                    if (touchCount() === 2 && down) {
                        var cap = zoomCapOf(answer);
                        hit.setPointerCapture(e.pointerId);
                        moved = true;      // a pinch never ends in a click
                        if (cap > 0) { pinch = { d0: touchSpread() || 1, z0: mounted.zoom || 1, cap: cap }; }
                        return;
                    }
                }
                down = { x: e.clientX, y: e.clientY, t: performance.now() };
                moved = false;
                hit.setPointerCapture(e.pointerId);
                hit.classList.add('is-drag');
            }
            hit.addEventListener('pointerdown', grab);

            hit.addEventListener('pointermove', function (e) {
                if (touches[e.pointerId]) { touches[e.pointerId] = { x: e.clientX, y: e.clientY }; }
                if (touchCount() >= 2) {
                    if (pinch) { setZoom(pinch.z0 * touchSpread() / pinch.d0, pinch.cap); }
                    return;        // two fingers zoom, they do not turn the case
                }
                if (!down) { return; }
                var dx = e.clientX - down.x, dy = e.clientY - down.y;
                if (!moved && Math.abs(dx) + Math.abs(dy) < CLICK_SLOP) { return; }
                moved = true;
                mounted.dragging = true;
                // Taking hold mid-flight ends the flight. Without this the
                // glide would keep writing the pose underneath the drag and
                // the case would fight the hand that is holding it.
                mounted.reset = null;
                // Touching the case ends the automatic turn - not for the
                // duration of the grab, for good. Once someone has placed the
                // case by hand, nothing may move it again on its own; the
                // double click is the way back to the resting view.
                mounted.autoRotate = false;
                mounted.pose.rotation.y += (e.clientX - down.x) * 0.01;
                mounted.pose.rotation.x += (e.clientY - down.y) * 0.01;
                down.x = e.clientX; down.y = e.clientY;
                draw();
            });

            // A double click must not fire the single click first (the case
            // would open and then be reset). A click can only be told apart
            // from the FIRST half of a double click by waiting - so the single
            // click is held back for as long as a second one could still arrive.
            //
            // That wait is only paid where it buys something. With the reset
            // switched off there is no second gesture to confuse it with, and
            // the click opens the case the instant the button comes up.
            //
            // The double click is detected here rather than through the native
            // `dblclick` event on purpose: that event follows the operating
            // system's own threshold, which is not the one we just waited out,
            // and the two disagreeing produces clicks that do nothing at all.
            var THREEJS_DOUBLE_MS = 300;
            var clickTimer = null, lastClickAt = -1e9;

            function openToggle() {
                if (!mounted) { return; }
                if (!mounted.canOpen) { log('no disc in this case - it stays shut'); return; }
                // Three open modes. "On click" is the manual toggle,
                // "On click automatic" plays the sequence; they exclude each other
                // in the menu, and a click needs one of the two.
                var onClick = !!(answer.Open && answer.Open.OnClick);
                var onClickAuto = !!(answer.Open && answer.Open.OnClickAutomatic);
                if (!onClick && !onClickAuto) { log('click, but no click mode is on'); return; }
                // A click during a movement is ignored, not queued and not
                // allowed to reverse it mid-flight - a new arc from a half-open
                // lid looks glitchy. While ANY case animation is running -
                // opening, closing, or an automatic cycle - a further click
                // neither interrupts nor overrides it.
                // An armed TIMER is not a movement: a click beats it further
                // down, so with both modes on the manual mode still responds
                // during the delay.
                if (mounted.cycle) { log('a sequence is running - the click is ignored'); return; }
                if (mounted.anim) { log('still opening or closing - the click is ignored'); return; }
                // The DISC turning is not the case moving. It writes
                // disc.rotation.z and nothing else, so closing the case while it
                // spins interrupts no animation - the revolution runs out behind
                // the shut lid and ends where it began, because it is a whole
                // turn. Only the manual mode reaches this; with the disc on
                // automatic a click starts a `cycle`, which is caught above.
                // Opening the case is touching it, and touching it ends the
                // automatic turn for good, as the drag does. Only the double
                // click brings the turn back.
                mounted.autoRotate = false;
                // A case standing open simply closes.
                if (mounted.openAngle > 1) {
                    log('click -> closing');
                    animateOpen(0);
                    return;
                }
                // A CLICK BEATS A TIMER THAT HAS NOT FIRED. From here on the case
                // belongs to the viewer for this visit: the automatic does not come
                // back and close it under their hand.
                if (mounted.openTimer) {
                    log('click during the delay - the automatic stands down');
                    clearTimeout(mounted.openTimer);
                    mounted.openTimer = null;
                    mounted.autoPending = false;
                }
                var target = answer.Open.AngleDegrees != null ? answer.Open.AngleDegrees : 120;   // 0 is a legal angle (stays shut), not "unset"
                // "On click automatic: sequence on click" - a mode of its own,
                // independent of the disc's Automatic box. The disc decides only
                // whether IT turns inside this sequence.
                if (onClickAuto) {
                    // THE LOOP RUNS ON DEMAND. Setting a cycle is not starting
                    // it - without the kick() below nothing would advance the
                    // timeline. Every place that starts a movement kicks.
                    // Keep comments above the assignment: a source check reads
                    // the characters that follow a movement's assignment and
                    // expects the kick() there.
                    mounted.cycle = { t0: performance.now(), angle: target,
                                      spin: !!(answer.Spin && answer.Spin.OnClickAutomatic),
                                      discFrom: mounted.model.disc ? mounted.model.disc.rotation.z : 0 };
                    mounted.openAngle = target;
                    log('click -> sequence, ' + CASE_CYCLE.MS + ' ms');
                    kick();
                    return;
                }
                log('click -> open ' + target + ' (from ' + mounted.openAngle + ')');
                animateOpen(target);
            }

            // Did this click land on the DISC itself? Raycast, not a radius in
            // screen space: the case is turned and tilted, so the disc is an
            // ellipse on screen whose shape changes with every pose, and a
            // circle would be wrong at almost every angle.
            //
            // The test is deliberately "is the disc the FIRST thing the ray
            // meets", which answers both cases at once: while the case is shut
            // the lid is in the way, so a click
            // anywhere toggles the case; while it stands open the disc is the
            // nearest surface over its own circle, so a click there spins it
            // and a click beside it closes the case. No open-angle bookkeeping,
            // and no way for the two to disagree.
            var raycaster = new THREE.Raycaster();
            function hitsDisc(clientX, clientY) {
                if (!mounted || !mounted.model.disc || !mounted.pose) { return false; }
                var r = mounted.canvas.getBoundingClientRect();
                if (!r.width || !r.height) { return false; }
                raycaster.setFromCamera({
                    x: ((clientX - r.left) / r.width) * 2 - 1,
                    y: -((clientY - r.top) / r.height) * 2 + 1
                }, mounted.camera);
                var hits = raycaster.intersectObject(mounted.pose, true);
                for (var i = 0; i < hits.length; i++) {
                    var o = hits[i].object, onDisc = false, shown = true;
                    // r128's raycaster does NOT skip invisible objects - checked
                    // in the vendored build. Without this walk a hidden lid or a
                    // switched-off booklet would swallow the click.
                    for (var n = o; n; n = n.parent) {
                        if (n.visible === false) { shown = false; break; }
                        if (n === mounted.model.disc) { onDisc = true; }
                    }
                    if (!shown) { continue; }
                    return onDisc || inDiscHole(hits[i].point);  // the FIRST thing actually on screen decides
                }
                return false;
            }

            // The centre hole belongs to the disc. Through the hole the ray meets the tray's hub boss
            // (BOSS.overMM above the seated disc) or the floor - so the first hit counts
            // as the disc when it lies inside the hole's radius and no higher than a few
            // disc thicknesses above the disc. A shut lid lies far above (case depth),
            // so it still takes the click and opens the case.
            var discLocal = new THREE.Vector3();
            function inDiscHole(point) {
                var disc = mounted.model.disc;
                var top = disc && disc.visible && disc.getObjectByName('top');
                var p = top && top.geometry && top.geometry.parameters;
                if (!p || !p.innerRadius) { return false; }
                disc.worldToLocal(discLocal.copy(point));
                var t = top.position.z;  // the disc's thickness in its own frame (layoutDisc)
                return Math.sqrt(discLocal.x * discLocal.x + discLocal.y * discLocal.y) <= p.innerRadius * 1.02
                    && discLocal.z >= -t / 4 && discLocal.z <= 3 * t;   // floor at -lift (0.05) - the tray's back face (seen from behind) stays out
            }

            function spinDiscOnce() {
                if (!mounted || !mounted.model.disc) { return; }
                if (!(answer.Spin && answer.Spin.OnClick)) { log('disc clicked, but "On click" is off'); return; }
                // Same ground rule: nothing interrupts a running movement.
                // Same rule as the lid: one revolution finishes before the
                // next one can be asked for - a second click does not restart
                // it and does not queue one.
                // A cycle that spins the disc writes disc.rotation.z itself, so
                // a disc click then would be a second writer for the same field.
                // Refused only while SOMETHING ELSE writes this rotation: a
                // sequence that does not spin the disc leaves the gesture free,
                // so the disc stays clickable inside an automatic opening. The
                // raycast has already established that the lid is not in the way.
                if (mounted.anim || mounted.spinAnim) {
                    log('a movement has the case - the disc click is ignored'); return;
                }
                if (mounted.cycle && mounted.cycle.spin) {
                    log('the sequence is turning the disc - the click is ignored'); return;
                }
                var from = mounted.model.disc.rotation.z;
                mounted.spinAnim = { from: from, to: from + mounted.spinDir * 2 * Math.PI,
                                     t0: performance.now(), ms: THREEJS_SPIN_MS };
                log('disc clicked -> one revolution');
                kick();
            }

            // The disc takes the click only where it IS the disc; everything
            // else is the case.
            function singleClick(x, y) {
                if (hitsDisc(x, y)) { spinDiscOnce(); } else { openToggle(); }
            }

            // Long enough to read as a movement, short enough not to feel like
            // waiting.
            var RESET_MS = 900;
            // (RESET_REST_MS lives at module scope beside ROTATE_RAMP_MS -
            // loop() needs it and cannot see in here.)

            function resetToResting() {
                if (!mounted) { return; }
                log('double click -> gliding back to the resting view');
                // The resting view includes being SHUT: closing and turning back
                // run together, so they read as one movement.
                // An AUTOMATIC cycle is allowed to finish - the double click
                // waits for it. In manual mode the way home always works, even
                // mid-movement, because there the viewer is the one steering.
                // The same rule as the single click: a MOVEMENT is waited for,
                // an armed TIMER is beaten.
                if (mounted.cycle) { log('a sequence is running - the double click waits'); return; }
                if (mounted.openTimer) {
                    log('double click during the delay - the automatic stands down');
                    clearTimeout(mounted.openTimer);
                    mounted.openTimer = null;
                    mounted.autoPending = false;
                }
                if (mounted.openAngle > 1) { animateOpen(0); }
                // The automatic turn is switched off for the trip and restored
                // at the end: this is "everything as the settings describe it",
                // and the turn is one of those settings. It is also the only way
                // back to it, since touching the case ends the turn for good.
                mounted.autoRotate = false;
                mounted.reset = {
                    fromX: mounted.pose.rotation.x,
                    fromY: mounted.pose.rotation.y,
                    fromZ: mounted.pose.rotation.z,
                    fromZoom: mounted.zoom || 1,
                    autoRotateAfter: !!answer.AutoRotate,
                    t0: performance.now(),
                    ms: RESET_MS
                };
                kick();
            }

            function release(e) {
                if (touches[e.pointerId]) {
                    delete touches[e.pointerId];
                    var left = touchCount();
                    if (pinch || left > 0) {
                        // The pinch is over. A finger still down goes on from
                        // where it rests now - no jump - and the gesture ends
                        // with the last finger, never as a click (moved).
                        pinch = null;
                        var rest = touches[Object.keys(touches)[0]];
                        if (down && rest) { down.x = rest.x; down.y = rest.y; }
                        if (left > 0) { return; }
                    }
                }
                if (!down) { return; }
                hit.classList.remove('is-drag');
                var wasClick = !moved;
                down = null;
                mounted.dragging = false;
                if (!wasClick) { log('drag, not a click - nothing opens'); return; }

                var resetOn = !!answer.ResetOnDoubleClick;
                // Kept from the release event: by the time the held-back click
                // runs, the pointer may be somewhere else entirely, and the
                // disc test has to use the place that was CLICKED.
                var cx = e.clientX, cy = e.clientY;
                if (!resetOn) { singleClick(cx, cy); return; }

                var now = performance.now();
                if (now - lastClickAt < THREEJS_DOUBLE_MS) {
                    // The second half of a double click: the first one is still
                    // waiting and is dropped, not run late.
                    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                    lastClickAt = -1e9;
                    resetToResting();
                    return;
                }
                lastClickAt = now;
                if (clickTimer) { clearTimeout(clickTimer); }
                clickTimer = setTimeout(function () { clickTimer = null; singleClick(cx, cy); }, THREEJS_DOUBLE_MS);
            }
            hit.addEventListener('pointerup', release);
            hit.addEventListener('pointercancel', release);
            // Capture lost without an up (the box re-laid or hidden mid-press):
            // end the gesture the same way, so no stale finger stays counted.
            hit.addEventListener('lostpointercapture', function (e) { if (touches[e.pointerId] || (e.pointerType !== 'touch' && down)) { release(e); } });

            // ---- "In front": the whole visible case takes the pointer --------
            // In front the case covers the text it stands
            // over, so wherever it is DRAWN it must also be operable - not only
            // in the free poster box. Behind the text keeps the poster box
            // alone, since there the text is on top. The
            // test is the same ray as the disc's: the first visible surface
            // under the pointer belongs to the case, or the press goes on to
            // the page as before - a click beside the case on the text still
            // reaches the text. Read from the page's class at the moment of the
            // press, so the layer is whatever is in force right then.
            function inFront() {
                var v = anchor.closest ? anchor.closest('.itemDetailPage') : null;
                return !!v && !v.classList.contains(BEHIND_CLASS);
            }
            function hitsCase(clientX, clientY) {
                if (!mounted || !mounted.pose) { return false; }
                var r = mounted.canvas.getBoundingClientRect();
                if (!r.width || !r.height || clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) { return false; }
                raycaster.setFromCamera({
                    x: ((clientX - r.left) / r.width) * 2 - 1,
                    y: -((clientY - r.top) / r.height) * 2 + 1
                }, mounted.camera);
                var hits = raycaster.intersectObject(mounted.pose, true);
                for (var i = 0; i < hits.length; i++) {
                    var shown = true;
                    for (var n = hits[i].object; n; n = n.parent) { if (n.visible === false) { shown = false; break; } }
                    if (shown) { return true; }
                }
                return false;
            }
            // The press started on the page, the rest of the gesture runs on the
            // hit box (pointer capture) - the click the browser then fires on
            // the common ancestor is swallowed once, so nothing underneath acts.
            var swallowClickUntil = 0;
            function frontDown(e) {
                if (e.button !== 0 || e.target === hit || !inFront() || !hitsCase(e.clientX, e.clientY)) { return; }
                e.preventDefault();
                e.stopPropagation();
                swallowClickUntil = performance.now() + 1000;
                grab(e);
            }
            function frontClick(e) {
                if (performance.now() > swallowClickUntil) { return; }
                swallowClickUntil = 0;
                e.preventDefault();
                e.stopPropagation();
            }
            // The grab cursor over the drawn case, not only over the poster box.
            // One ray per 80 ms at most, and only while the pointer is over the
            // canvas - a page without the pointer near the case pays nothing.
            var hoverAt = 0, hoverOn = false;
            function frontHover(e) {
                if (down) { return; }
                var now = performance.now();
                if (now - hoverAt < 80) { return; }
                hoverAt = now;
                var on = inFront() && e.target !== hit && hitsCase(e.clientX, e.clientY);
                if (on !== hoverOn) { hoverOn = on; document.documentElement.style.cursor = on ? 'grab' : ''; }
            }
            document.addEventListener('pointerdown', frontDown, true);
            document.addEventListener('click', frontClick, true);
            document.addEventListener('pointermove', frontHover, { capture: true, passive: true });
            mounted.unpickFront = function () {
                document.removeEventListener('pointerdown', frontDown, true);
                document.removeEventListener('click', frontClick, true);
                document.removeEventListener('pointermove', frontHover, { capture: true, passive: true });
                if (hoverOn) { document.documentElement.style.cursor = ''; }
            };
            mounted.cancelPendingClick = function () {
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            };

            // The wheel belongs to the page. It is taken over ONLY over the hit
            // box, and only there is the page scroll stopped - passive:false is
            // what makes preventDefault possible at all, and without it the
            // browser scrolls the page while the case zooms.
            //
            // And it is taken over only by a gesture that STARTED there. A
            // wheel gesture is a stream of events, not one event: scrolling the
            // page past the case must not hand the rest of that stream to the
            // zoom the moment the pointer crosses the box.
            // The owner is therefore decided ONCE, on the first event of a
            // gesture, and holds until the stream stops. A capture listener on
            // the document sees that first event before the box does - which is
            // the only place where "where did this gesture begin" is still
            // answerable.
            mounted.zoom = 1;
            var cap = zoomCapOf(answer);
            if (cap > 0) {
            // Longer than the gap between two events of one gesture (a trackpad
            // sends them every ~16 ms, a wheel notch train every ~50-100 ms),
            // shorter than a deliberate pause between two gestures.
            var GESTURE_GAP_MS = 200;
            var lastWheel = -1e9, owner = null;
            var wheelWatch = function (e) {
                var now = e.timeStamp || performance.now();
                if (now - lastWheel > GESTURE_GAP_MS) {
                    owner = (e.target && hit.contains(e.target)) ? 'case' : 'page';
                }
                lastWheel = now;
            };
            // Capture, and passive: this one only watches. It must never be the
            // reason a page cannot scroll.
            document.addEventListener('wheel', wheelWatch, { capture: true, passive: true });
            mounted.unwatchWheel = function () {
                document.removeEventListener('wheel', wheelWatch, { capture: true });
            };
            hit.addEventListener('wheel', function (e) {
                if (owner !== 'case') { return; }   // a scroll that began elsewhere stays a scroll
                e.preventDefault();
                // Exponential, so a notch up and a notch down cancel out
                // exactly; linear steps drift away from where you started.
                setZoom(mounted.zoom * Math.exp(-e.deltaY * 0.0015), cap);
            }, { passive: false }); }


            if (answer.Open && answer.Open.Automatic && mounted.canOpen) {
                // The automatic is armed: autoPending marks the delay. A click
                // during the delay beats the timer (see openToggle).
                mounted.autoPending = true;
                mounted.openTimer = setTimeout(function () {
                    if (!mounted) { return; }
                    // AUTOMATIC MODE IS THE WHOLE MOVEMENT: open, wait, close -
                    // and with Spin automatic on, the disc turns in between.
                    //
                    // The timings are the flat case type's (CASE_CYCLE). Without
                    // Spin automatic the same timeline runs with the disc left
                    // alone, so the case stands open for the same while.
                    mounted.openTimer = null;
                    var target = answer.Open.AngleDegrees != null ? answer.Open.AngleDegrees : 120;   // 0 is a legal angle (stays shut), not "unset"
                    mounted.cycle = {
                        t0: performance.now(), angle: target,
                        spin: !!(answer.Spin && answer.Spin.Automatic),
                        discFrom: mounted.model.disc ? mounted.model.disc.rotation.z : 0
                    };
                    mounted.openAngle = target;
                    log('automatic: open/' + (mounted.cycle.spin ? 'spin/' : '') + 'close, '
                        + CASE_CYCLE.MS + ' ms');
                    kick();
                }, answer.Open.DelayMs != null ? answer.Open.DelayMs : 5000);   // 0 = open at once, not "unset"
            }

            if (mounted.autoRotate) { kick(); }
        }

        function render(answer, itemId, posterEl, myGeneration) {
            window.ArtworkPlusThreejsLast = answer;
            log('case for ' + itemId + ': ' + answer.Shell + ', band ' + answer.BandLogo
                + ', mark ' + answer.SpineFormatMark + ', black ' + answer.Black
                + ', color ' + answer.ColorMode + '/' + answer.Blend
                + ', size ' + answer.Size + '%, turn ' + answer.Turn + ' tilt ' + answer.Tilt);
            ensureStyles();
            // Hold it now too, for the case where this page was opened before
            // anything was remembered (the very first movie after enabling the
            // feature). From the second one on, viewshow got there first.
            pendingHold(posterEl.closest ? posterEl.closest('.itemDetailPage') : null);
            // Engine, geometry and poster in parallel - three independent
            // fetches, and the slowest of them decides, not their sum.
            // TWO WAVES, not one. The engine, the mesh and the poster start at
            // once; the case's own PICTURES - thirteen back-cover plates, the
            // text face, the spine pieces, the disc, the backdrops - wait until
            // the poster has resolved.
            //
            // A browser allows about six connections per origin. Firing all of
            // them together would make the poster queue behind the case's own
            // artwork, delaying Extraposter's first image by many seconds.
            // Since the case cannot paint its cover without the poster anyway,
            // waiting for it costs the case nothing.
            var posterReady = loadPoster(itemId, posterEl);
            // THE COLOUR IS KNOWN BEFORE THE CASE APPEARS.
            //
            // For a winning Extraposter the case colour comes from the poster
            // BELOW it in the chain, and that picture has to be loaded like any
            // other texture - in the same wait, not afterwards, or the case
            // would show up in the colour of the cycling picture and change a
            // moment later, in full view.
            var colourReady = posterReady.then(function () {
                var coord = posterArbiterPeek(posterEl);
                var winner = (coord && coord.decision) ? coord.decision.logicalWinner : 0;
                if (winner !== 3) { return null; }
                var p = coord.participants || {};
                var link = (p[2] && p[2].url) ? 2 : ((p[1] && p[1].url) ? 1 : 0);
                var url = link === 2 ? p[2].url : (link === 1 ? p[1].url
                        : (window.ApiClient ? window.ApiClient.getUrl(
                               'Items/' + itemId + '/Images/Primary', { maxWidth: 1200, quality: 92 }) : null));
                if (!url) { return null; }
                log('colour comes from the chain below Extraposter: '
                    + ['Main (0)', 'Custom (1)', 'Animated (2)'][link]);
                return loadImage(url, 'low');
            }).catch(function () { return null; });

            var secondWave = posterReady.then(function () {
                return Promise.all([
                    loadPrint(answer, itemId),
                    answer.BackCover ? loadBackAssets() : null,
                    answer.BackCover ? loadBackData(answer, itemId) : null
                ]);
            });
            Promise.all([loadThree(), loadMesh(), posterReady, loadRenderer(),
                         loadColorThief(), colourReady,
                         secondWave.then(function (w) { return w[0]; }),
                         secondWave.then(function (w) { return w[1]; }),
                         secondWave.then(function (w) { return w[2]; })]).then(function (res) {
                // NAVIGATED AWAY WHILE LOADING - two questions, not one.
                // The element test alone is not enough: Jellyfin's view manager
                // keeps a detail page's DOM around, so the old poster card can
                // still sit inside document.body while another item is on
                // screen - and this mount would then build the previous film's
                // case over the current one. The generation counter is the same
                // one check() consults before it calls us.
                if ((myGeneration !== undefined && myGeneration !== currentGeneration())
                        || !document.body.contains(posterEl)) {
                    log('navigated away while loading - no case for ' + itemId);
                    pendingRelease();
                    return;
                }
                if (!mount(answer, itemId, posterEl, res[0], res[2], res[3], res[6],
                           { assets: res[7], data: res[8] }, res[5])) {
                    teardown();
                    pendingRelease();   // the case could not be built - give the poster back
                }
                // Only here: mount() has put HOLD_CLASS on the page, which hides
                // the vanilla card for as long as the case is up. Releasing one
                // frame earlier would flash the vanilla poster.
                pendingRelease();
            }).catch(function (e) {
                log('engine or mesh unavailable - the flat case type stays', e);
                teardown();
                pendingRelease();   // a decision: there will be no case here
            });
        }

        // The same three gates claimFor() asks, for the Case mix's
        // webgl flag - a page that would not build the case must not draw it.
        function canDraw() { return featureOn() && isWebBrowser() && hasWebGL(); }

        return { claimFor: claimFor, render: render, reset: teardown, hasWebGL: hasWebGL, featureOn: featureOn, canDraw: canDraw,
                 expected: pendingExpected, hold: pendingHold, release: pendingRelease };
    }());

    var CaseModModule = (function () {
        var DEBUG = true; // gated at runtime by localStorage.ArtworkPlusDebug (Core.makeLogger)
        var log = Core.makeLogger('[PostersPlus/CaseMod]', DEBUG);
        var BOX_CLASS = 'artworkplus-casemod-box';
        // Own marker class, independent of BOX_CLASS and its CSS rules, for
        // the two temporary 3D-case preview elements (inner case + disc
        // preview), so removeExistingOverlay() reliably removes them when the
        // case type changes.
        var TUNE_PREVIEW_CLASS = 'artworkplus-casemod-3dtune-preview';
        var OVERLAY_CLASS = 'artworkplus-casemod-overlay';
        // Front and Back fade in instead of popping in hard, Disc excluded -
        // see buildBox / fadeInBox.
        var CASE_FADE_IN_MS = 200;
        // Three layers: back case BEHIND the real poster card, poster, front
        // case in front. The real card's z-index is 3 (librarybrowser.scss,
        // .detailImageContainer .card) - back gets 2, front 4. All three are
        // SIBLINGS inside the same .detailImageContainer, i.e. the same
        // stacking context, so the values compare directly. The back box
        // reuses the front's per-case-type geometry class (a real case's
        // front and back share the same outer dimensions) and stays static -
        // it never rotates, even during the Open Case animation.
        var BOX_FRONT_CLASS = 'artworkplus-casemod-box-front';
        var BOX_BACK_CLASS = 'artworkplus-casemod-box-back';
        // The box gets its real width/left/top/aspect-ratio per case type
        // (no scale() transform on a poster-sized box) - see
        // ensureSizedStylesInjected. One class per case type, computed once
        // and cached.
        var SIZED_CLASS_PREFIX = 'artworkplus-casemod-sized-';
        var ROTATOR_CLASS = 'artworkplus-casemod-rotator';
        // Browser quirk: `perspective` set DIRECTLY on the rotated element's
        // parent breaks both the rotation's hinge point and its rendered
        // height, even with transform-style:preserve-3d. One plain,
        // untransformed wrapper level between perspective and the rotation
        // fixes both. ROTATOR_HOST_CLASS is that wrapper - no transform, no
        // styling beyond filling its parent.
        var ROTATOR_HOST_CLASS = 'artworkplus-casemod-rotator-host';
        var ROTATOR_OPEN_CLASS = 'artworkplus-casemod-rotator-open';
        /// The lid may STAND OPEN instead of always running the whole cycle,
        /// as in the 3D kind. ROTATOR_OPEN_CLASS means "the cycle is running"
        /// (it carries the 5850 ms animation whose animationend resets the
        /// state); this one means "open, and staying open until something
        /// closes it" and carries no animation at all, because in that state
        /// the lid is simply held at its last matrix.
        var ROTATOR_HOLD_CLASS = 'artworkplus-casemod-rotator-hold';
        /// THE 2D SIDE OF THE SHARED TIMELINE (CASE_CYCLE, above the modules).
        /// Every number below is derived, never written out a second time: the
        /// CSS keyframe percentages are what the cycle's own milliseconds are as
        /// a fraction of it, so moving a cue means editing CASE_CYCLE alone.
        /// The 3D kind's counterparts are THREEJS_OPEN_MS and THREEJS_SPIN_MS.
        var CASE2D_OPEN_MS = CASE_CYCLE.OPEN_MS;       // the lid's swing, opening
        var CASE2D_CLOSE_MS = CASE_CYCLE.CLOSE_MS;     // and closing again
        var CASE2D_SPIN_MS = CASE_CYCLE.DISC_MS;       // one revolution of the disc
        var CASE2D_SPIN_DEG = CASE_CYCLE.TURNS * 360;
        function case2dPct(ms) { return Math.round((ms / CASE_CYCLE.MS) * 100000) / 1000; }
        var CASE2D_DISC_AT_PCT = case2dPct(CASE_CYCLE.DISC_AT);            // 25.641
        var CASE2D_DISC_END_PCT = case2dPct(CASE_CYCLE.DISC_AT + CASE_CYCLE.DISC_MS);  // 62.393
        var OPEN_KEYFRAMES_NAME = 'artworkplusCaseModOpen';
        // The real poster (posterEl, i.e. .cardImageContainer - the ONE
        // element Main/Custom/Animated/Extra all paint their backgroundImage
        // into) swings open TOGETHER with the front cover as one rigid unit.
        // posterEl stays in its native DOM position (reparenting a native
        // Jellyfin element risks breaking CSS selectors or native JS that
        // assume its position in the tree).
        //
        // Its transform-origin cannot reuse the case box's %-based hinge: a
        // `transform-origin` percentage always resolves against the element
        // it is applied to. A one-time getBoundingClientRect() measurement
        // would go stale on resize, unlike everything else here, which is
        // pure vw/%/em CSS.
        //
        // The solution, from Jellyfin's source:
        // `.card`'s `position: absolute; left: 3.3%; top: -80%` (see
        // librarybrowser.scss) resolves against `.detailPagePrimaryContainer`
        // (the nearest actually-positioned ancestor - `.infoWrapper`
        // and `.detailImageContainer` in between are both unpositioned
        // and simply pass the containing-block role upward), and that
        // container has NO width constraint of its own on
        // `.layout-desktop` - its content width IS the viewport width.
        // That means any %-of-that-container value is numerically
        // IDENTICAL to the same number of vw - the case box's own
        // `leftPct%` and `widthVw` genuinely share one coordinate
        // space, no JS needed to bridge them. Full derivation and the
        // resulting formula live in ensurePosterOriginStylesInjected
        // below.
        var POSTER_ROTATE_CLASS = 'artworkplus-casemod-poster-rotate';
        // The rotation is applied to `.cardScalable`, not to posterEl:
        // posterEl and the logo overlays are repainted independently by
        // other code (the arbiter swaps posterEl's background-image, and
        // Jellyfin's lazy loader adds `lazy-image-fadein`, its own CSS
        // animation, whenever a new image lands), which would stomp an
        // animation on posterEl mid-flight. A wrapper DIV around posterEl
        // would break imageLoader.js, which finds the padder via
        // `elem.parentNode.querySelector('.cardPadder')`, and would miss
        // Extraposter's `.extraposter-layer` siblings.
        //
        // `.cardScalable` is the native, never-reparented common ancestor of
        // the poster, the padder, any Extraposter layers and the logo, so
        // rotating it carries all of them along - including layers inserted
        // after the rotation started. Jellyfin's one-shot `animationend`
        // listener sits on posterEl, and an animationend on its PARENT never
        // reaches it, since events only bubble upward.
        var POSTER_ORIGIN_CLASS_PREFIX = 'artworkplus-casemod-poster-origin-';
        // Per-type class on `.card` while the case is up (contain without
        // paint, default cursor) - see ensurePosterOriginStylesInjected.
        var CARD_PERSPECTIVE_CLASS_PREFIX = 'artworkplus-casemod-card-perspective-';
        // Background padder (see ensureStylesInjected): hidden only during
        // the open/held window, never otherwise.
        var PADDER_HIDE_CLASS = 'artworkplus-casemod-padder-hide';
        var PADDER_HIDE_KEYFRAMES_NAME = 'artworkplusCaseModPadderHide';
        // The same padder, hidden for as long as the lid stands open - no
        // animation, no end: the cycle's own keyframes cannot serve a state
        // that lasts until the viewer closes the case.
        var PADDER_HIDE_STATIC_CLASS = 'artworkplus-casemod-padder-hide-static';
        // Disc: a separate static layer (it never rotates with the hinge;
        // only the Spinning Disc effect turns it) behind the poster/front
        // assembly, revealed by their perspective foreshortening as they
        // swing open - visible early in the animation, not only after
        // 90°. Same per-case-type sized-class pattern
        // as the Case box, but with only ONE size value (no
        // width/height stretch - a disc is 1:1, stretching would
        // visibly oval it).
        var BOX_DISC_CLASS = 'artworkplus-casemod-box-disc';
        // The hub decal. Its own box because it has to sit
        // BETWEEN the tray and the disc - baked into the inside texture it
        // can only ever be behind both, and then the disc's hole shows the
        // tray where the peg should be.
        var BOX_HUB_CLASS = 'artworkplus-casemod-box-hub';

        // The preview switches. FOUR, and every one of them HIDES - listed
        // front to back, which is the order you peel them off in: front
        // cover, poster, disc, hub. Underneath is the inside, which needs no
        // switch because hiding it would leave nothing to look at.
        //
        // Hiding the layers in front shows the same picture as raising one
        // layer to the front, without scrambling the real order - so nothing
        // here touches z-index. They act on whatever box exists, so all four
        // case types behave the same.
        function tuneHide(box, on) {
            if (box && on) { box.style.visibility = 'hidden'; }
        }
        function tuneHidePoster(posterEl, on) {
            if (!on || !posterEl || !posterEl.closest) { return; }
            var card = posterEl.closest('.cardScalable');
            if (card) { card.style.opacity = '0'; }
        }
        var SIZED_DISC_CLASS_PREFIX = 'artworkplus-casemod-disc-sized-';
        var DISC_SPIN_CLASS = 'artworkplus-casemod-disc-spin';
        var DISC_SPIN_KEYFRAMES_NAME = 'artworkplusCaseModDiscSpin';
        // Spinning direction, Left/Right: the spin 720deg -> 0deg (the angle
        // DECREASING over time) is "Left". "Right" is a SEPARATE class + keyframes
        // with the mirrored sign (-720deg -> 0deg, angle INCREASING
        // toward zero from a negative start) - same easing/timing shape,
        // opposite rotational direction. Picked at runtime by
        // discSpinClassFor() below, never both at once.
        var DISC_SPIN_CLASS_RIGHT = 'artworkplus-casemod-disc-spin-right';
        var DISC_SPIN_KEYFRAMES_NAME_RIGHT = 'artworkplusCaseModDiscSpinRight';
        function discSpinClassFor(direction) {
            return direction === 'Right' ? DISC_SPIN_CLASS_RIGHT : DISC_SPIN_CLASS;
        }
        // The disc's own ONE revolution, for a click on the disc
        // itself ("Spinning Disc: On click"). The cycle's disc keyframes above
        // cannot serve for this - they are cued inside a 5850 ms timeline and
        // stand still for the first 1500 ms of it. Same distance, same easing,
        // same two directions, but on its own clock, so a click turns the disc
        // the moment it lands.
        var DISC_SPIN_ONCE_CLASS = 'artworkplus-casemod-disc-spin-once';
        var DISC_SPIN_ONCE_KEYFRAMES_NAME = 'artworkplusCaseModDiscSpinOnce';
        var DISC_SPIN_ONCE_CLASS_RIGHT = 'artworkplus-casemod-disc-spin-once-right';
        var DISC_SPIN_ONCE_KEYFRAMES_NAME_RIGHT = 'artworkplusCaseModDiscSpinOnceRight';
        function discSpinOnceClassFor(direction) {
            return direction === 'Right' ? DISC_SPIN_ONCE_CLASS_RIGHT : DISC_SPIN_ONCE_CLASS;
        }
        // THE CASE'S OWN CLICK SURFACE. Every Case box is
        // pointer-events: none (see the CSS), which is what lets a click reach
        // the poster through them. The INSIDE has to take clicks itself though:
        // the case is wider than the poster, and once the lid stands open the
        // part of it that the poster card does NOT cover is exactly where one
        // clicks to shut it again. The disc needs no
        // class of its own - which click belongs to it is decided by geometry,
        // see case2dHitsDisc.
        var CASE_CLICK_CLASS = 'artworkplus-casemod-case-click';
        // Per-case-type hinge position (transform-origin X, in % of the
        // box width): the true hinge sits slightly INSIDE the PNG's own left
        // edge, not at 0%. Measured once per case type from the texture
        // files themselves (alpha profile of the left edge, mean alpha
        // per column over the middle 60% of the height to exclude
        // corner rounding, edge = 50%-of-plateau crossing, subpixel-
        // interpolated): vivaelitecases x=76.30px, clearcases x=65.62px,
        // vortexcases x=76.09px, all of the shared 552px canvas width.
        // Within each type all 9 resolution textures (480p..tvseries) have
        // the pixel-identical left edge, so one value per type suffices. A
        // PERCENTAGE (not px/vw) is the right unit: the <img> fills the box
        // 100%, so a % of the box is a % of the rendered texture at every
        // box size and Width/Left setting. If the texture PNGs are ever
        // regenerated, re-measure these.
        var HINGE_ORIGIN_X_PERCENT = {
            vivaelitecases: 13.822,
            clearcases: 11.889,
            vortexcases: 13.784,
            // Measured on all 6 resolution textures (480p/720p/1080p/4k/3d/p,
            // all identical 93.128%) - the same alpha-profile method as for
            // the other three case types, searched from the LEFT (first
            // column with alpha>128 in the middle 60% of the height). Used
            // when CaseAngleDegrees is NEGATIVE (hinge on the right).
            'vivaelite3dcases': 93.128,
            // Mirrored value (100 - 93.128) for the case
            // that CaseAngleDegrees is POSITIVE (hinge on the left,
            // admin-selectable via the sign of Case Angle).
            'vivaelite3dcases_mirrored': 6.872
        };
        var stylesInjected = false;

        /**
         * Complete, numerically verified replica of Kodi's
         * own 3D projection chain (rotatey + camera + asymmetric
         * frustum), derived directly from the real XBMC/Kodi source
         * (TransformMatrix.h::SetYRotation,
         * RenderSystemGL.cpp::SetCameraPosition, MatrixGL.cpp::Frustum/
         * LookAt/Project). Two control points confirmed exact numeric
         * agreement (0.000000 deviation):
         * 1) Angle 0 degrees yields exactly the real, unrotated position.
         * 2) The hinge point stays exactly fixed under every rotation
         *    (mathematically necessary, it lies on the rotation axis).
         *
         * IMPORTANT CONVENTIONS (each verified individually against the
         * source, NOT assumed):
         * - Object rotation (SetYRotation): COLUMN-VECTOR convention,
         *   out = M * v (from TransformMatrix::TransformPosition).
         * - Camera/projection (Translate/LookAt/Frustum): ROW-VECTOR
         *   convention, out = v * M (from
         *   CMatrixGL::__gluMultMatrixVecf) - a DIFFERENT convention
         *   than the object rotation, deliberately kept instead of
         *   "unified", to hit Kodi's own behaviour exactly rather than
         *   a more convenient but wrong assumption.
         * - Screen Y: gluProject yields OpenGL window coordinates (Y
         *   grows from the BOTTOM up) - explicitly inverted
         *   (screenH - y) for our own Y-down convention (browser/CSS).
         *
         * NOT adopted: Kodi's own internal sign inversion of the angle
         * (`m_startAngle *= -1`) - that is a Kodi-internal compensation
         * for a DIFFERENT, Kodi-specific Y-axis handling at a place we
         * already correct explicitly and separately at our OWN Y-flip
         * point above. Our own angle (0 to +angleDeg) already gives the
         * intended rotation direction (opens towards the viewer) - an
         * additional Kodi-internal sign inversion would flip it back.
         */
        function setYRotationMatrix(angleRad, cx, cz) {
            var c = Math.cos(angleRad), s = Math.sin(angleRad);
            // Column-vector convention: M[row][col], applied as M * v
            return [
                [c, 0, -s, -cx * c + s * cz + cx],
                [0, 1, 0, 0],
                [s, 0, c, -cx * s - c * cz + cz],
                [0, 0, 0, 1]
            ];
        }
        function buildCameraMatrices(cameraX, cameraY, screenW, screenH) {
            var offsetX = cameraX - screenW * 0.5;
            var offsetY = cameraY - screenH * 0.5;
            var w = screenW * 0.5, h = screenH * 0.5;

            // ModelView: Translatef(-(w+offsetX), h+offsetY, 0) then LookAt(0,0,-2h -> 0,0,0, up=0,-1,0)
            // Own LookAt basis (Gram-Schmidt, as in CMatrixGL::LookAt)
            var eye = [0, 0, -2 * h], center = [0, 0, 0], up = [0, -1, 0];
            var fwd = [center[0]-eye[0], center[1]-eye[1], center[2]-eye[2]];
            var fl = Math.sqrt(fwd[0]*fwd[0]+fwd[1]*fwd[1]+fwd[2]*fwd[2]);
            fwd = [fwd[0]/fl, fwd[1]/fl, fwd[2]/fl];
            var side = [fwd[1]*up[2]-fwd[2]*up[1], fwd[2]*up[0]-fwd[0]*up[2], fwd[0]*up[1]-fwd[1]*up[0]];
            var sl = Math.sqrt(side[0]*side[0]+side[1]*side[1]+side[2]*side[2]);
            side = [side[0]/sl, side[1]/sl, side[2]/sl];
            var up2 = [side[1]*fwd[2]-side[2]*fwd[1], side[2]*fwd[0]-side[0]*fwd[2], side[0]*fwd[1]-side[1]*fwd[0]];

            // Row-vector-consistent combination: this_new = arg @ this_old (from MultMatrixf)
            function matMulRow(A, B) { // A, B as A[row][col], standard matrix multiplication
                var R = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
                for (var i=0;i<4;i++) for (var j=0;j<4;j++) {
                    var s2=0; for (var k=0;k<4;k++) s2 += A[i][k]*B[k][j];
                    R[i][j]=s2;
                }
                return R;
            }
            var I = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
            var Ttranslate = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[-(w+offsetX), h+offsetY, 0, 1]];
            var Arot = [[side[0],up2[0],-fwd[0],0],[side[1],up2[1],-fwd[1],0],[side[2],up2[2],-fwd[2],0],[0,0,0,1]];
            var Ttrans2 = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[eye[0]*-1,eye[1]*-1,eye[2]*-1,1]];
            var MV = matMulRow(Ttranslate, I);
            MV = matMulRow(Ttrans2, matMulRow(Arot, MV));

            var l = (-w-offsetX)*0.5, r = (w-offsetX)*0.5, b = (-h+offsetY)*0.5, t = (h+offsetY)*0.5;
            var near = h, far = 100*h;
            var u = (2*near)/(r-l), v = (2*near)/(t-b);
            var ww = (r+l)/(r-l), xx = (t+b)/(t-b);
            var yy = -(far+near)/(far-near), zz = -(2*far*near)/(far-near);
            var P = [[u,0,0,0],[0,v,0,0],[ww,xx,yy,-1],[0,0,zz,0]];
            return { MV: MV, P: P };
        }
        function mat4Transpose(M) {
            var T = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
            for (var i = 0; i < 4; i++) { for (var j = 0; j < 4; j++) { T[i][j] = M[j][i]; } }
            return T;
        }
        function mat4Mul(A, B) {
            // Standard matrix multiplication, A[row][col], A@B
            var R = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
            for (var i = 0; i < 4; i++) {
                for (var j = 0; j < 4; j++) {
                    var s = 0;
                    for (var k = 0; k < 4; k++) { s += A[i][k] * B[k][j]; }
                    R[i][j] = s;
                }
            }
            return R;
        }
        /**
         * Builds the complete matrix3d() for a given intermediate angle.
         * Checked numerically against the reference pipeline (angle-0
         * position exact, hinge fixed point exact, all four corners equal
         * over several angles up to floating-point noise). In short:
         *
         * CSS matrix3d() with transform-origin at the element's own
         * (0,0) (top left) works COLUMN-VECTOR based and divides
         * DIRECTLY IN PIXELS (not first normalized to -1..1 like OpenGL):
         *   [X,Y,Z,W] = M @ [lx,ly,0,1]
         *   final point = (ctrlLeft + X/W, ctrlTop + Y/W)
         *
         * K = P^T @ MV^T @ Robj @ Translate(ctrlLeft,ctrlTop,0)
         * (P,MV come from Kodi's own row-vector world - the
         * transposition makes them exactly equivalent for the
         * column-vector chain, no approximation).
         * The final conversion (OpenGL NDC -> CSS pixel division, incl.
         * Y flip) is folded into the matrix rows themselves:
         *   row 0 = 0.5*screenW*K[0] + (0.5*screenW - ctrlLeft)*K[3]
         *   row 1 = -0.5*screenH*K[1] + (0.5*screenH - ctrlTop)*K[3]
         *   row 2 = K[2] (depth, not decisive for the pure screen
         *   position, kept for completeness)
         *   row 3 = K[3] (the shared denominator/W part)
         */
        // The camera is fixed RELATIVE TO THE CASE in a design frame, like a
        // Kodi skin, which lives in a fixed design frame and is scaled as a
        // whole. A camera at the WINDOW centre (Kodi's distance 2h =
        // innerHeight) would make the projected trapezoid depend on the window
        // size, aspect ratio and the page's text height. Design frame:
        // 1920 x 1024 px (a maximised browser window at 1920 px, front box
        // top 133, camera 379 px below the front's top), scaled by
        // innerWidth / 1920 like every vw-based case size: screen centre
        // horizontally (the case's left is %-based, so that is invariant
        // anyway), DESIGN_CAMERA_DY below the case's top, camera distance from
        // the design height. Every window size gets the same shape. Every
        // matrix (rest tilt, retilt, Open Case for all four types) takes its
        // camera from here.
        var DESIGN_SCREEN_W = 1920;
        var DESIGN_SCREEN_H = 1024;
        var DESIGN_CAMERA_DY = 379;
        function designCamera(frontRect) {
            var scale = window.innerWidth / DESIGN_SCREEN_W;
            var screenW = window.innerWidth;
            var screenH = DESIGN_SCREEN_H * scale;
            return {
                screenW: screenW, screenH: screenH,
                cameraX: screenW * 0.5,
                cameraY: frontRect.top + DESIGN_CAMERA_DY * scale
            };
        }

        function computeKodiMatrix3dString(angleDeg, hingeXPx, ctrlLeft, ctrlTop,
                                            screenW, screenH, cameraX, cameraY) {
            var angleRad = angleDeg * Math.PI / 180;
            var Robj = setYRotationMatrix(angleRad, hingeXPx, 0);
            return finishKodiMatrix(Robj, ctrlLeft, ctrlTop, ctrlLeft, ctrlTop, 0, screenW, screenH, cameraX, cameraY);
        }

        // The Open Case hinge is FIXED TO THE CASE BODY: when the body is
        // rotated by the static tilt, the hinge point rotates along, as with
        // nested CSS transforms (parent rotation, then child rotation with
        // its own transform-origin). Treating the hinge as a fixed WORLD
        // coordinate makes it wander. So the left hinge is FIRST transformed
        // by the static rotation (its new X/Z position computed), then the
        // opening rotation is applied around exactly this point and the two
        // are composed (Robj_open * Robj_static, Robj_static acts first). At
        // openAngle=0 this reduces exactly to the static rotation.
        function computeNestedKodiMatrix3dString(staticAngleDeg, staticHingeXPx, openAngleDeg, openHingeXPxOriginal,
                                                   ctrlLeft, ctrlTop, screenW, screenH, cameraX, cameraY) {
            var staticRad = staticAngleDeg * Math.PI / 180;
            var RobjStatic = setYRotationMatrix(staticRad, staticHingeXPx, 0);
            // Send the original (Z=0) left hinge through the static
            // rotation to get its actual position after the tilt.
            var rotHingeX = RobjStatic[0][0]*openHingeXPxOriginal + RobjStatic[0][3];
            var rotHingeZ = RobjStatic[2][0]*openHingeXPxOriginal + RobjStatic[2][3];
            var openRad = openAngleDeg * Math.PI / 180;
            var RobjOpen = setYRotationMatrix(openRad, rotHingeX, rotHingeZ);
            var RobjTotal = mat4Mul(RobjOpen, RobjStatic);
            return finishKodiMatrix(RobjTotal, ctrlLeft, ctrlTop, ctrlLeft, ctrlTop, 0, screenW, screenH, cameraX, cameraY);
        }

        function finishKodiMatrix(Robj, origCtrlLeft, origCtrlTop, tcolLeft, tcolTop, tcolZ, screenW, screenH, cameraX, cameraY) {
            var Tcol = [[1,0,0,tcolLeft],[0,1,0,tcolTop],[0,0,1,tcolZ],[0,0,0,1]];
            var cam = buildCameraMatrices(cameraX, cameraY, screenW, screenH);
            var MVt = mat4Transpose(cam.MV);
            var Pt = mat4Transpose(cam.P);
            var K = mat4Mul(Pt, mat4Mul(MVt, mat4Mul(Robj, Tcol)));

            var sw = screenW, sh = screenH;
            var row0 = [
                0.5*sw*K[0][0] + (0.5*sw - origCtrlLeft)*K[3][0],
                0.5*sw*K[0][1] + (0.5*sw - origCtrlLeft)*K[3][1],
                0.5*sw*K[0][2] + (0.5*sw - origCtrlLeft)*K[3][2],
                0.5*sw*K[0][3] + (0.5*sw - origCtrlLeft)*K[3][3]
            ];
            var row1 = [
                -0.5*sh*K[1][0] + (0.5*sh - origCtrlTop)*K[3][0],
                -0.5*sh*K[1][1] + (0.5*sh - origCtrlTop)*K[3][1],
                -0.5*sh*K[1][2] + (0.5*sh - origCtrlTop)*K[3][2],
                -0.5*sh*K[1][3] + (0.5*sh - origCtrlTop)*K[3][3]
            ];
            var row2 = K[2];
            var row3 = K[3];
            // CSS matrix3d() expects the 16 values COLUMN-WISE:
            // matrix3d(a1,b1,c1,d1, a2,b2,c2,d2, ...) fills column by
            // column, where a,b,c,d are rows 0,1,2,3 - i.e. col-major
            // order of our row0..row3 matrix.
            var vals = [];
            for (var col = 0; col < 4; col++) {
                vals.push(row0[col], row1[col], row2[col], row3[col]);
            }
            return 'matrix3d(' + vals.map(function (v) { return v.toFixed(6); }).join(',') + ')';
        }



        /**
         * A physical disc case is a FRAME - LARGER than the poster artwork it
         * holds - unlike the Keyart/Extrakeyart logo overlays (which sit
         * entirely WITHIN the poster's own box). Jellyfin's own poster
         * card element (`.cardImageContainer`) has both `overflow:
         * hidden` AND `contain: strict` (card.scss) - anything appended as ITS
         * descendant, extending past its own edges, gets clipped there,
         * no matter how large the offset/size percentages say it should
         * be. `.cardScalable` and `.cardBox` (its own ancestors) don't
         * clip themselves, but `.cardImageContainer`'s own box IS
         * exactly what fills `.cardScalable`'s own space (via the
         * aspect-ratio-padder trick) - so a percentage-of-parent overlay
         * larger than 100% still ends up geometrically identical to one
         * larger than `.cardImageContainer` itself, and gets clipped
         * there regardless of which specific ancestor it's technically
         * appended to.
         *
         * So the case is not nested inside the card's subtree at all - it
         * is a separate SIBLING element, appended directly to
         * `.detailImageContainer` (the poster CARD's own parent - see
         * Jellyfin's itemDetails/index.html and cardBuilder.js:
         * `<div class="detailImageContainer">`
         * exists in the page from the start, empty, and the actual
         * `.card` element is inserted into it later as a plain child -
         * our own sibling box slots in right alongside it, at the same
         * level, entirely unaffected by the card's own containment).
         *
         * The sibling box tracks the real card with NO JS resize/fullscreen
         * listener, so it never shifts when the window changes. From
         * Jellyfin's librarybrowser.scss: the real
         * `.card` element is positioned with `position: absolute` using
         * ONLY viewport-relative units (vw/vh) and percentages -
         * NEVER pixels - varying by the current `.layout-desktop`/
         * `.layout-mobile`/`.layout-tv` class Jellyfin itself already
         * puts on a shared ancestor, plus one narrow-viewport media
         * query override. The card's computed style (getComputedStyle) is
         * deliberately not copied - it always returns absolute pixels, which
         * would defeat the responsive behaviour. Instead the same rules are
         * re-declared once for our own class name, and the browser's CSS
         * engine keeps both elements in sync under every resize/fullscreen/
         * layout-mode change, by the same mechanism.
         */
        function ensureStylesInjected(angleDeg) {
            if (stylesInjected) { return; }
            stylesInjected = true;
            // `angleDeg` is read from the admin-configured
            // CaseModOpenAngleDegrees (1-180, default 135) the FIRST
            // time this runs per page load and then baked into the
            // injected @keyframes below - same "changing it needs a
            // full browser reload" contract the per-case-type sized
            // classes already have (see PluginConfiguration's own
            // CaseModOpenAngleDegrees doc comment).
            var style = document.createElement('style');
            style.textContent = [
                '.detailImageContainer .' + BOX_CLASS + ' {',
                '    position: absolute !important;',
                '    pointer-events: none;',
                '}',
                '.detailImageContainer .' + BOX_FRONT_CLASS + ' { z-index: 4; }',
                // Back case sits UNDER the real poster card (card is
                // z-index 3 per Jellyfin's own librarybrowser.scss) -
                // sibling in the same stacking context, so 2 < 3 < 4
                // gives exactly the requested back/poster/front layers.
                '.detailImageContainer .' + BOX_BACK_CLASS + ' { z-index: 2; }',
                // Disc: same numeric z-index as Back, but
                // ALWAYS appended to the DOM right after it - elements
                // tied on z-index paint in DOM order, so Disc reliably
                // paints above Back while staying below the real card
                // (3) and the front assembly (4). Physically correct
                // too: the disc sits inside the case, in front of the
                // case's own back-interior surface, behind the printed
                // front cover.
                '.detailImageContainer .' + BOX_DISC_CLASS + ' { z-index: 2; }',
                // Hub: same z-index as the disc and inserted right BEFORE
                // it, so DOM order puts it under the disc and over the tray -
                // where a peg actually is, with only the disc's hole showing
                // it.
                '.detailImageContainer .' + BOX_HUB_CLASS + ' { z-index: 2; }',
                // No `perspective` on `.detailImageContainer`: it has no CSS
                // position of its own in Jellyfin's stylesheets, so `.card`'s
                // `position: absolute; top: -80%; left: 3.3%` resolves against
                // `.detailPagePrimaryContainer`. `perspective`/`transform`/
                // `filter` on any element makes it a new containing block,
                // which would shift the real poster and every case box.
                // No CSS `perspective` on `.card`/BOX_FRONT_CLASS either - the
                // matrix3d() (see computeKodiMatrix3dString) already contains
                // the complete projection; a CSS `perspective` on the parent
                // would project a SECOND time and distort the result.
                '.detailImageContainer .' + BOX_FRONT_CLASS + ' { transform-style: preserve-3d; }',
                '.' + ROTATOR_HOST_CLASS + ' {',
                '    position: absolute; left: 0; top: 0; width: 100%; height: 100%;',
                '}',
                '.' + ROTATOR_CLASS + ' {',
                '    position: absolute; left: 0; top: 0; width: 100%; height: 100%;',
                '    transform-style: preserve-3d;',
                // Deliberately no `backface-visibility: hidden`. Past 90°,
                // the default `visible` shows a horizontally-MIRRORED
                // duplicate of the front texture, which is preferable to
                // the door vanishing into blankness.
                //
                // 0% is only the FALLBACK hinge - the real, per-case-
                // type hinge (measured from each texture's own visible
                // left edge, see HINGE_ORIGIN_X_PERCENT above) is
                // injected as a higher-specificity override per sized
                // class in ensureSizedStylesInjected below.
                '    transform-origin: 0% 50%;',
                '}',
                // No baked-in CSS delay: the delay is admin-editable and a
                // click can also start the animation, at a moment only JS
                // knows. JS adds ROTATOR_OPEN_CLASS (see check() below:
                // after OpenDelayMs via setTimeout, or on a valid poster
                // click, whichever happens first); once started, the
                // animation runs CASE_CYCLE.MS.
                '.' + ROTATOR_CLASS + '.' + ROTATOR_OPEN_CLASS + ' {',
                '    animation: ' + OPEN_KEYFRAMES_NAME + ' ' + CASE_CYCLE.MS + 'ms linear 0ms 1 normal forwards;',
                '}',
                // The real poster, any Extraposter overlay layers, and the
                // Keyart/Extrakeyart logo overlay (if present) all share this
                // same @keyframes timeline via this class on `.cardScalable`
                // (their native common ancestor - see POSTER_ROTATE_CLASS's
                // declaration). They stay in lockstep, since ROTATOR_OPEN_CLASS is added to
                // both the case rotator AND `.cardScalable` in the SAME
                // JS tick (see case2dRunCycle() in check()
                // below). Its own transform-origin comes from a
                // SEPARATE, per-case-type class (ensurePosterOriginStylesInjected
                // below, pure CSS calc() - no runtime measurement), not
                // from here, since `.cardScalable`'s own box has
                // different dimensions than the case box. POSTER_ROTATE_CLASS
                // itself is PURELY STRUCTURAL (transform-style only)
                // - the actual animation only applies once
                // ROTATOR_OPEN_CLASS is ALSO present, mirroring the case
                // rotator's own structure/start separation above.
                '.' + POSTER_ROTATE_CLASS + ' {',
                '    transform-style: preserve-3d;',
                '}',
                '.' + POSTER_ROTATE_CLASS + '.' + ROTATOR_OPEN_CLASS + ' {',
                '    animation: ' + OPEN_KEYFRAMES_NAME + ' ' + CASE_CYCLE.MS + 'ms linear 0ms 1 normal forwards;',
                '}',
                '@keyframes ' + OPEN_KEYFRAMES_NAME + ' {',
                // Deliberately animates NO real property: the 3D rotation
                // comes per frame via JS through matrix3d() (see
                // computeKodiMatrix3dString and runRotationFrame in check()
                // below), which replicates Kodi's camera/projection maths.
                // The @keyframes rule still delivers the reliable
                // `animationend` signal that the rest of the cycle (state
                // reset, re-trigger permission) relies on.
                // `outline-offset` has no visible effect whatsoever
                // without a set outline-style.
                '    0% { outline-offset: 0px; }',
                '    100% { outline-offset: 0px; }',
                '}',
                // Background padder: `.cardPadder`
                // - the dark #242424 placeholder behind the poster
                // image, normally invisible once a real poster image is
                // loaded (background-size:cover fully covers it) - sits
                // BONDED inside `.card` (same element as the poster,
                // can't be reordered via z-index relative to our own
                // Back/Disc boxes without restructuring native
                // Jellyfin markup, which we deliberately avoid).
                // Hidden from the very START of the animation (0%) rather
                // than only once fully open - the door starts swinging at
                // 0%, and hiding the padder later would show a visible
                // "pop"; at 0% nothing of it is exposed yet. Reappears once
                // the door is fully closed again at 100%. No baked-in delay;
                // added by JS in the same tick as ROTATOR_OPEN_CLASS, so it
                // stays synced whichever trigger fired.
                '.' + PADDER_HIDE_CLASS + ' {',
                '    animation: ' + PADDER_HIDE_KEYFRAMES_NAME + ' ' + CASE_CYCLE.MS + 'ms linear 0ms 1 normal forwards;',
                '}',
                '@keyframes ' + PADDER_HIDE_KEYFRAMES_NAME + ' {',
                '    0%, 99.999% { visibility: hidden; }',
                '    100% { visibility: visible; }',
                '}',
                // The Spinning Disc effect, after the Kodi skin's
                // ViewsRightList.xml ("Thumb Box Discart"):
                // <effect type="rotate" start="720" center="auto"
                //  end="0" delay="5500" time="4300" tween="cubic"
                //  easing="inout"/>
                // - a SPIN-DOWN to rest, not an infinite spin. Its cue
                // points come from CASE_CYCLE (CASE2D_DISC_AT_PCT /
                // CASE2D_DISC_END_PCT), inside the window where the lid
                // stands open. "tween=cubic, easing=inout" -> CSS
                // `ease-in-out`, a standard approximation. Its own-axis
                // rotateZ is independent of the Open Case hinge motion.
                // No baked-in delay; added by JS in the same tick as
                // everything else above.
                '.' + DISC_SPIN_CLASS + ' {',
                '    animation: ' + DISC_SPIN_KEYFRAMES_NAME + ' ' + CASE_CYCLE.MS + 'ms linear 0ms 1 normal forwards;',
                '}',
                '@keyframes ' + DISC_SPIN_KEYFRAMES_NAME + ' {',
                '    0% { transform: rotate(' + CASE2D_SPIN_DEG + 'deg); }',
                '    ' + CASE2D_DISC_AT_PCT + '% { transform: rotate(' + CASE2D_SPIN_DEG + 'deg); animation-timing-function: ease-in-out; }',
                '    ' + CASE2D_DISC_END_PCT + '% { transform: rotate(0deg); }',
                '    100% { transform: rotate(0deg); }',
                '}',
                // Mirrored ("Right") spin direction - exact
                // same timing/easing shape as the class above, opposite
                // sign throughout, so it visibly spins the other way.
                '.' + DISC_SPIN_CLASS_RIGHT + ' {',
                '    animation: ' + DISC_SPIN_KEYFRAMES_NAME_RIGHT + ' ' + CASE_CYCLE.MS + 'ms linear 0ms 1 normal forwards;',
                '}',
                '@keyframes ' + DISC_SPIN_KEYFRAMES_NAME_RIGHT + ' {',
                '    0% { transform: rotate(-' + CASE2D_SPIN_DEG + 'deg); }',
                '    ' + CASE2D_DISC_AT_PCT + '% { transform: rotate(-' + CASE2D_SPIN_DEG + 'deg); animation-timing-function: ease-in-out; }',
                '    ' + CASE2D_DISC_END_PCT + '% { transform: rotate(0deg); }',
                '    100% { transform: rotate(0deg); }',
                '}',
                // OPEN AND STAY OPEN, as in the 3D kind. No rule for the
                // rotator: the lid is held at the last matrix
                // runRotationFrame wrote, exactly as it is held through the
                // cycle's own middle section. Only the padder needs one, and
                // it needs the plain property rather than keyframes, because
                // this state has no end until a click gives it one.
                '.' + PADDER_HIDE_STATIC_CLASS + ' { visibility: hidden; }',
                // The disc turning ONCE, on its own click. Same distance and
                // same curve as the cue inside the cycle, but on its own
                // clock, so it starts the moment it is asked to.
                '.' + DISC_SPIN_ONCE_CLASS + ' {',
                '    animation: ' + DISC_SPIN_ONCE_KEYFRAMES_NAME + ' ' + CASE2D_SPIN_MS + 'ms ease-in-out 0ms 1 normal forwards;',
                '}',
                '@keyframes ' + DISC_SPIN_ONCE_KEYFRAMES_NAME + ' {',
                '    0% { transform: rotate(' + CASE2D_SPIN_DEG + 'deg); }',
                '    100% { transform: rotate(0deg); }',
                '}',
                '.' + DISC_SPIN_ONCE_CLASS_RIGHT + ' {',
                '    animation: ' + DISC_SPIN_ONCE_KEYFRAMES_NAME_RIGHT + ' ' + CASE2D_SPIN_MS + 'ms ease-in-out 0ms 1 normal forwards;',
                '}',
                '@keyframes ' + DISC_SPIN_ONCE_KEYFRAMES_NAME_RIGHT + ' {',
                '    0% { transform: rotate(-' + CASE2D_SPIN_DEG + 'deg); }',
                '    100% { transform: rotate(0deg); }',
                '}',
                // The inside as a click surface - the one Case box that may catch
                // a pointer, and only while "Open case: On click" is on.
                '.detailImageContainer .' + BOX_CLASS + '.' + CASE_CLICK_CLASS + ' { pointer-events: auto; }'
            ].join('\n');
            document.head.appendChild(style);
        }

        // The box gets literal, DIRECT Top/Left/Width/Height values rather
        // than relative multipliers: a uniform shift/scale of a box+image
        // pair can never change the ratio of visible content to transparent
        // padding inside the PNG, so the box geometry is tuned directly
        // against the visible case.
        //
        // Units match the shared desktop-layout base (width in vw, top/left
        // in %, base 25vw/-80%/3.3%), so width=25 means "the poster's own
        // size". Height is an independent vw value, so a non-2:3 shape is
        // possible.
        //
        // Mobile/tv equivalents are DERIVED, not separately configured - the
        // proportional scale/shift these desktop values represent relative
        // to the desktop base (25vw/37.5vw/-80%/3.3%), applied to the
        // mobile/tv bases.
        var sizedClassesInjected = {};
        var discSizedClassesInjected = {};
        var posterOriginClassesInjected = {};
        // One sized class per GEOMETRY, not per case type: the same case
        // type has two geometries (Sets 28.5 vw, everything else 27.35 vw),
        // and a class keyed by type alone would keep whichever width came
        // first. The key carries the values, so a geometry change switches
        // to its own class.
        function sizedClassName(caseType, topVwOffset, leftPct, widthVw, heightVw) {
            return SIZED_CLASS_PREFIX + caseType + '-' + [topVwOffset, leftPct, widthVw, heightVw].map(function (v) {
                return String(v).replace(/[^0-9a-z]/gi, '_');
            }).join('-');
        }

        // Mobile layout (both versions). Jellyfin anchors the poster at the BOTTOM on
        // phones: absolute, left 5%, bottom 1rem, width 30vw; below 32em left 0, bottom 0
        // (10.10.7 librarybrowser.scss 854-880, 12.1 826-853 - same values, in 12.1 inside
        // .detailRibbon). Every box keeps its desktop relation to the poster, measured
        // from the poster's BOTTOM edge (a 2:3 poster is 1.5 widths high) - the same idea
        // as Poster size's fromBottom.
        // The phone poster has NO fixed width: only max-width 30vw, the width itself is
        // the card's .portraitCard percentage of the ribbon (card.scss 10.10.7 518-633,
        // 12.1 523-638: 33.3 % / 25 % / 20 % ... by window width). So the boxes are sized
        // in the poster's MEASURED width, --artworkplus-mcw on the container
        // (trackMobileCardWidth, ResizeObserver); 30vw is only the fallback before the
        // first measurement.
        // Poster size (posterSizeScaleAnswer) has already scaled every value by f and moved the
        // tops by sy; on phones the boxes are measured against the REAL poster, so the rules take
        // the unscaled relation back out (otherwise the scale would apply twice). Set per answer,
        // 1 / 0 without Poster size.
        var posterSizeRule = { f: 1, sy: 0 };
        function mobileBoxRules(cls, topVwOffset, shiftLeftVw, widthVw, heightVw) {
            var f = posterSizeRule.f, sy = posterSizeRule.sy;
            var top = (topVwOffset - sy) / f, shift = shiftLeftVw / f, wid = widthVw / f, hei = heightVw / f;
            // a desktop vw value / 25 = the same value in poster widths (2:3 poster = 25 x 37.5)
            function w(v) { return 'calc(var(--artworkplus-mcw, 30vw) * ' + (v / 25) + ')'; }
            // Anchored at the poster's TOP like the desktop relation, the top being the measured bottom
            // plus the measured height: a poster cropped by max-height 80vh (wide windows) is shorter
            // than 2:3, and a fixed 37.5 would put the case too high there.
            var sel = '.layout-mobile .detailImageContainer .' + cls;
            // --artworkplus-mcl / -mcb: the poster's own left and bottom inside the containing block,
            // measured (trackMobileCardWidth) - covers Jellyfin's 5 % / 1rem, the 0 / 0 below 32em and
            // Poster size's margins alike; the literals are only the fallback before a measurement.
            return [
                sel + ' {',
                '    left: calc(var(--artworkplus-mcl, 5%) + ' + w(shift) + ');',
                '    top: auto;',
                '    bottom: calc(var(--artworkplus-mcb, 1rem) + var(--artworkplus-mch, calc(var(--artworkplus-mcw, 30vw) * 1.5)) - ' + w(top + hei) + ');',
                '    width: ' + w(wid) + ';',
                '    height: ' + w(hei) + ';',
                '}'
            ];
        }

        // The phone poster's real width on its container, kept current by a
        // ResizeObserver (window resizes, the .portraitCard breakpoints, a late image).
        // Harmless on desktop/TV: only the .layout-mobile rules read the variable.
        function trackMobileCardWidth(container, card) {
            if (!container || !card) { return; }
            function set() {
                var r = measureDesignRect(card);   // module rule: one measuring function
                if (r.width > 0) { container.style.setProperty('--artworkplus-mcw', r.width + 'px'); }
                if (r.height > 0) { container.style.setProperty('--artworkplus-mch', r.height + 'px'); }
                // left / bottom of the poster inside its containing block (= the boxes' one on phones)
                var cb = card.offsetParent;
                if (cb && r.width > 0) {
                    var c = measureDesignRect(cb);
                    container.style.setProperty('--artworkplus-mcl', (r.left - c.left - cb.clientLeft) + 'px');
                    container.style.setProperty('--artworkplus-mcb', (c.top + cb.clientTop + cb.clientHeight - (r.top + r.height)) + 'px');
                }
            }
            set();
            if (container.__artworkplusMcw && container.__artworkplusMcw.card === card) { return; }
            if (container.__artworkplusMcw) { container.__artworkplusMcw.ro.disconnect(); }
            if (typeof ResizeObserver === 'function') {
                var ro = new ResizeObserver(set);
                ro.observe(card);
                // the poster hangs from the ribbon's bottom on phones; the ribbon grows while its
                // content arrives, which moves the poster without resizing it
                var hangsIn = card.closest('.detailRibbon') || card.closest('.detailPagePrimaryContainer');
                if (hangsIn) { ro.observe(hangsIn); }
                container.__artworkplusMcw = { ro: ro, card: card };
            }
        }

        function ensureSizedStylesInjected(caseType, topVwOffset, leftPct, widthVw, heightVw) {
            var cls = sizedClassName(caseType, topVwOffset, leftPct, widthVw, heightVw);
            if (sizedClassesInjected[cls]) { return; }
            sizedClassesInjected[cls] = true;

            // `top` is a vw OFFSET added to the poster's own -80% base
            // (`calc(-80% + Xvw)`), not an absolute percentage: a
            // percentage resolves against the surrounding container's
            // height, which depends on unrelated page content (the
            // description's wrap length), so it would drift relative to
            // the poster on any viewport-width change. vw is independent
            // of that height. `left`/`width` are safe as %, because the
            // container's WIDTH scales predictably with the viewport.
            var shiftLeftPct = leftPct - 3.3;

            var css = [
                '.detailImageContainer .' + cls + ' {',
                '    width: ' + widthVw + 'vw;',
                '    height: ' + heightVw + 'vw;',
                '}',
            ].concat(mobileBoxRules(cls, topVwOffset, shiftLeftPct, widthVw, heightVw), [
                '.layout-desktop .detailImageContainer .' + cls + ' {',
                // --ap-hunit: the shift's unit. 1% of the container = leftPct% exactly; Core sets
                // 1vw while the page is narrower than the window (10.10.7
                // experimental drawer), where % of the page and the poster's 25vw part ways.
                '    left: calc(3.3% + ' + shiftLeftPct + ' * var(--ap-hunit, 1%));',
                '    top: calc(-80% + ' + topVwOffset + 'vw);',
                '    width: ' + widthVw + 'vw;',
                '}',
                '.layout-tv .detailImageContainer .' + cls + ' {',
                '    left: calc(5% + ' + shiftLeftPct + ' * var(--ap-hunit, 1%));',
                '    top: 50%;',
                '    width: ' + widthVw + 'vw;',
                // TV: the poster is centred (10.10.7 top 50% + translateY(-50%); 12.1 via
                // ensureJf12GeometryStyles), so its TOP is centre - 0.75 poster widths (2:3).
                // The box takes the desktop relation from that top, using the measured poster
                // HEIGHT: 12.1/10.10.7 TV cap the card at max-height 80vh, so on very wide
                // windows it is shorter than 2:3.
                '    transform: translateY(calc(var(--artworkplus-mch, 37.5vw) * -0.5 + ' + topVwOffset + 'vw));',
                '}',
                '@media all and (max-width: 62.5em) {',
                '    .layout-desktop .detailImageContainer .' + cls + ' {',
                '        top: calc(10% + ' + topVwOffset + 'vw);',
                '    }',
                // TV keeps its offset in the transform above - adding it to top as well
                // would count it twice below 62.5em (which in TV's larger root font is > 1400 px).
                '    .layout-tv .detailImageContainer .' + cls + ' {',
                '        top: 10%;',
                '    }',
                '}',
                '[dir="rtl"] .detailImageContainer .' + cls + ' { left: unset; }',
                '[dir="rtl"] .layout-mobile .detailImageContainer .' + cls + ',',
                '[dir="rtl"] .layout-tv .detailImageContainer .' + cls + ' { right: calc(5% + ' + shiftLeftPct + ' * var(--ap-hunit, 1%)); }',
                '[dir="rtl"] .layout-desktop .detailImageContainer .' + cls + ' { right: ' + leftPct + '%; }',
                // Overrides the generic 0% fallback via higher specificity
                // (.sized-class .rotator vs plain .rotator). transform-origin
                // is ALWAYS 0 0: matrix3d() starts from the element's own
                // origin, and the hinge point lives in the matrix itself (see
                // ensurePosterOriginStylesInjected).
                '.' + cls + ' .' + ROTATOR_CLASS + ' {',
                '    transform-origin: 0 0;',
                '}',
                // No perspective-origin rule for the front box: no element
                // carries `perspective`; the Kodi matrix projects with its own
                // camera (buildCameraMatrices).
            ]).join('\n');

            var styleEl = document.createElement('style');
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        }

        // Poster's own transform-origin (rotation axis - the real,
        // per-case-type hinge) - declared on
        // `.cardScalable` (the real, native, never-reparented common
        // ancestor of the poster, Extraposter's own overlay layers, and
        // the Keyart/Extrakeyart logo - see POSTER_ROTATE_CLASS). Pure
        // CSS, no JS measurement: the case box's own `leftPct`/
        // `widthVw` and the poster's own base `3.3%` left (desktop/tv)
        // or `5%` (mobile) all resolve against the SAME container
        // (`.detailPagePrimaryContainer`) whose content width equals
        // the viewport width on `.layout-desktop` - so a %-of-that-
        // container is numerically identical to the same number of vw.
        //
        // No `0.6em` correction: card.scss's generic `.cardBox { margin:
        // 0.6em }` is overridden on the detail page by librarybrowser.scss's
        // `.detailImageContainer .card { .cardBox { margin: 0; } }`, so
        // `.card`, `.cardBox`, `.cardScalable` and the poster share one box.
        //
        // Kodi's `rotatey` effect does NOT use a per-object camera: in
        // `xbmc/guilib/GUIControl.cpp` a control's own camera (`m_camera`)
        // is pushed only when the skin gives that control a `<camera>` tag
        // (`m_hasCamera`), which the case's skin XML does not. Kodi then
        // uses the camera on top of the stack, set in
        // `xbmc/windowing/GraphicContext.cpp`:
        // `m_cameras.emplace(0.5f * m_iScreenWidth, 0.5f * m_iScreenHeight)`
        // - the SCREEN CENTER of the skin's base resolution. With the case
        // well away from that centre (skin XML: left=-8, top=98, width=368,
        // height=525 on 1920x1080), the projection distorts both width and
        // height (top/bottom edges tilt relative to each other), which an
        // object-centred camera can never produce.
        //
        // So the matrix projects with a camera fixed in the screen frame
        // (designCamera), not at the object.
        function ensurePosterOriginStylesInjected(caseType, hingePct, leftPct, widthVw) {
            if (posterOriginClassesInjected[caseType]) { return; }
            posterOriginClassesInjected[caseType] = true;
            var cls = POSTER_ORIGIN_CLASS_PREFIX + caseType;
            var cardCls = CARD_PERSPECTIVE_CLASS_PREFIX + caseType;
            var shiftLeftVw = leftPct - 3.3;
            var desktopTvTotalVw = shiftLeftVw + (hingePct / 100) * widthVw;

            // Screen-centered camera - `.card`'s own fixed
            // base left position is 3.3% (desktop/tv) or 5% (mobile),
            // independent of case type; the viewport's own center is
            // 50vw, so the offset from `.card`'s own left edge to that
            // center is a single constant per layout, not per case type.
            var desktopTvCameraVw = 50 - 3.3;
            var mobileCameraVw = 50 - 5;

            var css = [
                // transform-origin is ALWAYS 0 0 (top left) - matrix3d()
                // (computeKodiMatrix3dString) starts from this origin. The
                // hinge comes entirely from the matrix itself (hingeXPx), not
                // from transform-origin - if a percentage hinge
                // value were still set here, the browser would anchor
                // the matrix at the WRONG point and shift the result.
                '.layout-desktop .detailImageContainer .cardScalable.' + cls + ',',
                '.layout-tv .detailImageContainer .cardScalable.' + cls + ' {',
                '    transform-origin: 0 0;',
                '}',
                '.layout-mobile .detailImageContainer .cardScalable.' + cls + ' {',
                '    transform-origin: 0 0;',
                '}',
                // Jellyfin's card.scss sets `.card:not(.show-animation) {
                // contain: layout style paint; }`. `contain: paint` clips
                // everything that extends beyond `.card`'s own (unrotated)
                // box, so the rotated `.cardScalable` would be cut off at
                // the vanilla poster's edges. So contain is forced WITHOUT
                // paint while our classes are active - our selector (4
                // classes) beats the native rule (.card:not(...), 2-class
                // equivalent), !important as a safeguard against later rules.
                // card.scss also sets `cursor: pointer;` on `.card` (line
                // 23) - meaningful on a library tile, where a click
                // navigates, but without function on the detail page.
                // Same override.
                '.layout-desktop .detailImageContainer .card.' + cardCls + ',',
                '.layout-tv .detailImageContainer .card.' + cardCls + ' {',
                '    contain: layout style !important;',
                '    cursor: default !important;',
                '}',
                '.layout-mobile .detailImageContainer .card.' + cardCls + ' {',
                '    contain: layout style !important;',
                '    cursor: default !important;',
                '}'
            ].join('\n');

            var styleEl = document.createElement('style');
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        }


        // Disc sized styles - same top-vw-offset-from-poster-base + left%
        // pattern as the Case box (ensureSizedStylesInjected above), but
        // width AND height get the SAME single `sizeVw` value - a disc is
        // 1:1, and independent values would render it as an oval.
        // Same geometry-keyed class as the case box - the disc geometry does
        // not differ per item type, but a per-type cache would fix the first
        // geometry seen.
        function discSizedClassName(caseType, topVwOffset, leftPct, sizeVw) {
            return SIZED_DISC_CLASS_PREFIX + caseType + '-' + [topVwOffset, leftPct, sizeVw].map(function (v) {
                return String(v).replace(/[^0-9a-z]/gi, '_');
            }).join('-');
        }

        function ensureDiscSizedStylesInjected(caseType, topVwOffset, leftPct, sizeVw) {
            var cls = discSizedClassName(caseType, topVwOffset, leftPct, sizeVw);
            if (discSizedClassesInjected[cls]) { return; }
            discSizedClassesInjected[cls] = true;
            var shiftLeftPct = leftPct - 3.3;

            var css = [
                '.detailImageContainer .' + cls + ' {',
                '    width: ' + sizeVw + 'vw;',
                '    height: ' + sizeVw + 'vw;',
                '}'
            ].concat(mobileBoxRules(cls, topVwOffset, shiftLeftPct, sizeVw, sizeVw), [
                '.layout-desktop .detailImageContainer .' + cls + ' {',
                // --ap-hunit: the shift's unit. 1% of the container = leftPct% exactly; Core sets
                // 1vw while the page is narrower than the window (10.10.7
                // experimental drawer), where % of the page and the poster's 25vw part ways.
                '    left: calc(3.3% + ' + shiftLeftPct + ' * var(--ap-hunit, 1%));',
                '    top: calc(-80% + ' + topVwOffset + 'vw);',
                '}',
                '.layout-tv .detailImageContainer .' + cls + ' {',
                '    left: calc(5% + ' + shiftLeftPct + ' * var(--ap-hunit, 1%));',
                '    top: 50%;',
                // TV: the poster is centred (10.10.7 top 50% + translateY(-50%); 12.1 via
                // ensureJf12GeometryStyles), so its TOP is centre - 0.75 poster widths (2:3).
                // The box takes the desktop relation from that top, using the measured poster
                // HEIGHT: 12.1/10.10.7 TV cap the card at max-height 80vh, so on very wide
                // windows it is shorter than 2:3.
                '    transform: translateY(calc(var(--artworkplus-mch, 37.5vw) * -0.5 + ' + topVwOffset + 'vw));',
                '}',
                '@media all and (max-width: 62.5em) {',
                '    .layout-desktop .detailImageContainer .' + cls + ' {',
                '        top: calc(10% + ' + topVwOffset + 'vw);',
                '    }',
                // TV keeps its offset in the transform above - adding it to top as well
                // would count it twice below 62.5em (which in TV's larger root font is > 1400 px).
                '    .layout-tv .detailImageContainer .' + cls + ' {',
                '        top: 10%;',
                '    }',
                '}',
                '[dir="rtl"] .detailImageContainer .' + cls + ' { left: unset; }',
                '[dir="rtl"] .layout-mobile .detailImageContainer .' + cls + ',',
                '[dir="rtl"] .layout-tv .detailImageContainer .' + cls + ' { right: calc(5% + ' + shiftLeftPct + ' * var(--ap-hunit, 1%)); }',
                '[dir="rtl"] .layout-desktop .detailImageContainer .' + cls + ' { right: ' + leftPct + '%; }'
            ]).join('\n');

            var styleEl = document.createElement('style');
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        }

        /**
         * Removes any stale overlay left behind by a PREVIOUS navigation
         * - called unconditionally at the start of every new navigation
         * attempt, BEFORE the new item's own applicability is even known.
         * A stale element that is only cleaned up when the same feature
         * gets that far again would survive any later item that is not
         * applicable; removing unconditionally avoids having to catch every
         * early-return path. Removes the whole BOX, since the box is our
         * own element, not a piece of Jellyfin's DOM.
         */

        // All POSTER_ORIGIN_CLASS_PREFIX+type classes, listed explicitly -
        // cheaper and clearer than deriving this list from
        // HINGE_ORIGIN_X_PERCENT's keys at cleanup time. Every case type
        // must be listed, or its class stays on .cardScalable across
        // following navigations.
        var ALL_POSTER_ORIGIN_CLASSES = [
            POSTER_ORIGIN_CLASS_PREFIX + 'vivaelitecases',
            POSTER_ORIGIN_CLASS_PREFIX + 'clearcases',
            POSTER_ORIGIN_CLASS_PREFIX + 'vortexcases',
            POSTER_ORIGIN_CLASS_PREFIX + 'vivaelite3dcases'
        ];
        // Same list, for .card's own perspective-origin class - see
        // ensurePosterOriginStylesInjected.
        var ALL_CARD_PERSPECTIVE_CLASSES = [
            CARD_PERSPECTIVE_CLASS_PREFIX + 'vivaelitecases',
            CARD_PERSPECTIVE_CLASS_PREFIX + 'clearcases',
            CARD_PERSPECTIVE_CLASS_PREFIX + 'vortexcases',
            CARD_PERSPECTIVE_CLASS_PREFIX + 'vivaelite3dcases'
        ];

        // Module-wide (not per-check closure-local) reference to the
        // currently running rotation - enables IMMEDIATE cancellation on
        // every new navigation instead of relying only on the generation
        // check in the next rAF tick. A stale rAF loop that stays
        // registered also disturbs the timing of parallel setTimeout calls
        // under a simulated test clock.
        // ═══════════════════════════════════════════════════════════
        var activeRotationRafId = null;
        var activeCloseTimeoutId = null;
        function cancelActiveRotation() {
            if (activeRotationRafId !== null) {
                cancelAnimationFrame(activeRotationRafId);
                activeRotationRafId = null;
            }
            if (activeCloseTimeoutId !== null) {
                clearTimeout(activeCloseTimeoutId);
                activeCloseTimeoutId = null;
            }
        }

        function removeExistingOverlay() {
            cancelActiveRotation();
            document.querySelectorAll('.detailImageContainer .' + BOX_CLASS).forEach(function (el) {
                el.remove();
            });
            // The preview boxes carry TUNE_PREVIEW_CLASS (discPreviewBox has
            // no BOX_CLASS) - own explicit cleanup.
            document.querySelectorAll('.detailImageContainer .' + TUNE_PREVIEW_CLASS).forEach(function (el) {
                el.remove();
            });
            // POSTER_ROTATE_CLASS and the per-type origin class go directly
            // on `.cardScalable` (see POSTER_ROTATE_CLASS). It is a reused
            // native element, never removed/recreated, so a PREVIOUS item's
            // Case must never leave its classes behind on an item that has no
            // Case at all.
            document.querySelectorAll('.detailImageContainer .cardScalable').forEach(function (el) {
                el.classList.remove(POSTER_ROTATE_CLASS);
                el.classList.remove(ROTATOR_OPEN_CLASS);
                el.classList.remove(ROTATOR_HOLD_CLASS);
                el.classList.remove.apply(el.classList, ALL_POSTER_ORIGIN_CLASSES);
                // TuneHidePoster sets opacity directly as an inline style on
                // this never re-created element - without a reset here the
                // poster would stay invisible for every following item.
                el.style.opacity = '';
                el.style.transform = '';
                el.style.transformOrigin = '';
            });
            // "Open Case on Click" attaches a click
            // listener directly to posterEl - same unconditional-
            // cleanup reasoning, a stale listener from a PREVIOUS item
            // must never survive a navigation to a new one (it would
            // fire using stale closure state, or simply double up if a
            // future navigation attaches a second one on top).
            document.querySelectorAll('.detailImageContainer .cardImageContainer').forEach(function (el) {
                if (el._artworkplusCaseModClickHandler) {
                    el.removeEventListener('click', el._artworkplusCaseModClickHandler);
                    delete el._artworkplusCaseModClickHandler;
                }
            });
            // Same unconditional cleanup for .card's own perspective-
            // origin class.
            document.querySelectorAll('.detailImageContainer .card').forEach(function (el) {
                el.classList.remove.apply(el.classList, ALL_CARD_PERSPECTIVE_CLASSES);
            });
            // Background padder - same
            // unconditional-cleanup reasoning: `.cardPadder` is a real,
            // reused native element too.
            document.querySelectorAll('.detailImageContainer .cardPadder').forEach(function (el) {
                el.classList.remove(PADDER_HIDE_CLASS);
                // And the static one: a lid left standing open on the previous
                // item would otherwise take the padder's visibility with it
                // into the next one.
                el.classList.remove(PADDER_HIDE_STATIC_CLASS);
            });
        }

        // `coord` is the SAME poster-arbiter coordinator
        // object Custom/Animated/Extra already use - CaseMod receives
        // it PURELY to read `coord.decisionPromise`/
        // posterArbiterIsDecisionPending(coord) further below (Back/
        // Disc's own start), never to register a participant, set a
        // fallback url, or otherwise write into it. The dependency
        // runs strictly one way: poster-arbiter state -> CaseMod, never
        // the reverse - CaseMod cannot influence which poster type
        // wins or when.
        // Module scope, shared with Poster size: this module measures
        // geometry ONLY through this function (the design frame, layout at
        // scroll 0), so no two coordinate frames ever get mixed.
           function measureDesignRect(el) {
            var r = el.getBoundingClientRect();
            var dx = window.scrollX || window.pageXOffset || 0;
            var dy = window.scrollY || window.pageYOffset || 0;
            // Inner scrollers only: the viewport scroller (html/body, whichever
            // document.scrollingElement is) is already covered by window.scrollX/Y.
            var viewportScroller = document.scrollingElement || document.documentElement;
            for (var n = el.parentElement; n; n = n.parentElement) {
                if (n === viewportScroller || n === document.documentElement || n === document.body) { continue; }
                if (n.scrollTop) { dy += n.scrollTop; }
                if (n.scrollLeft) { dx += n.scrollLeft; }
            }
            return { left: r.left + dx, top: r.top + dy, width: r.width, height: r.height,
                     right: r.right + dx, bottom: r.bottom + dy };
            }

        // =============================================================
        // POSTER SIZE
        //
        // Scales the detail-page poster and drags the flat case along.
        // Independent of the case: it runs before this module's own
        // "not applicable" exit, so it also works with no case at all and
        // reaches Seasons and Episodes, where a case never appears.
        //
        // WHY THE CASE HAS TO BE DRAGGED ALONG. The box is placed by a
        // generated rule in vw and % against .detailImageContainer, out of
        // fixed per-type tune values - it never measures the poster. Only
        // the 3D type's TILT re-measures, and that is the perspective, not
        // the size. Shrink the poster and an untouched case stays put and
        // no longer sits on it. How it is done: see "POSTER SIZE" below.
        // =============================================================

        // ═══ CASE COLOUR, 2D ═════════════════════════════════════════════
        // The flat case becomes tintable. Its texture ships as four layers -
        // shell and shell2 (the plastic, greyscale), print (lettering, never
        // tinted) and gloss (the sheen over the poster window) - and is
        // composed here, once per texture, on an offscreen canvas:
        //
        //     plastic = (shell + shell2) * colour / 255     alpha from shell
        //     then print over it, then gloss over that
        //
        // Two shells because the originals are not of one tone; with ONE
        // colour they collapse to a single greyscale shell, which is exactly
        // the sum above.
        //
        // "Original" composes nothing and changes no code path: the box gets
        // the same texture URL it always got. That is the default, and it is
        // what every installation sees until a case type is set to "Color".
        //
        // THE DERIVATION IS A COPY. The seven modes are the Three.js case's
        // own (pickColour in Jellyfin-ArtworkPlus-ThreejsRenderer-v1.js,
        // ~line 1495) and were taken from there line by line, because the two
        // features must answer the same way for the same poster - keep the
        // two in step. It is a copy and not a call because the original lives in a ported
        // file that may not be edited, and loading it means loading Three.js.
        var CASE2D_BLEND = {
            DominantDark: 'dominant_dark', DominantColorful: 'dominant', Deep: 'deep',
            MaterialYou: 'material', Accent: 'accent', TopRegion: 'top', Vibrant: 'vibrant'
        };

        function case2dRgb2hsl(c) {
            var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
            var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, sat = 0;
            if (mx !== mn) {
                var d = mx - mn;
                sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
                h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
                h /= 6;
            }
            return [h, sat, l];
        }
        function case2dHsl2rgb(h, s, l) {
            var f = function (n) {
                var k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
                return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
            };
            return [f(0), f(8), f(4)].map(function (v) { return Math.round(v * 255); });
        }
        function case2dSrgb2lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
        function case2dRgb2oklch(c) {
            var r = case2dSrgb2lin(c[0]), g = case2dSrgb2lin(c[1]), b = case2dSrgb2lin(c[2]);
            var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
                m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
                s2 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
            var A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s2,
                B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s2;
            return { C: Math.hypot(A, B), h: (Math.atan2(B, A) * 180 / Math.PI + 360) % 360 };
        }
        function case2dIsSkin(c) {
            var r = c[0], g = c[1], b = c[2];
            return r > 95 && g > 40 && b > 20 && r > g && r > b
                && (Math.max(r, g, b) - Math.min(r, g, b)) > 15
                && Math.abs(r - g) > 15 && (r - g) < 110 && b > 0.45 * g;
        }

        // The 48x48 sample and the per-swatch populations, as the renderer
        // builds them - same size, same nearest-palette assignment.
        function case2dAnalyse(img) {
            if (typeof window.ColorThief === 'undefined' || !img) { return null; }
            var pal;
            try { pal = new window.ColorThief().getPalette(img, 8, 5) || []; } catch (e) { return null; }
            if (!pal.length) { return null; }
            var S = 48, cv = document.createElement('canvas');
            cv.width = cv.height = S;
            var cx = cv.getContext('2d');
            cx.drawImage(img, 0, 0, S, S);
            var px = cx.getImageData(0, 0, S, S).data;
            var idx = new Uint8Array(S * S), cnt = new Array(pal.length);
            for (var z = 0; z < pal.length; z++) { cnt[z] = 0; }
            for (var i = 0, q = 0; i < px.length; i += 4, q++) {
                var best = 0, bd = 1e9;
                for (var k = 0; k < pal.length; k++) {
                    var d = Math.pow(px[i] - pal[k][0], 2) + Math.pow(px[i + 1] - pal[k][1], 2) + Math.pow(px[i + 2] - pal[k][2], 2);
                    if (d < bd) { bd = d; best = k; }
                }
                idx[q] = best; cnt[best]++;
            }
            var palette = pal.map(function (rgb, k) {
                var hsl = case2dRgb2hsl(rgb);
                return { rgb: rgb, pop: cnt[k] / (S * S), h: hsl[0], s: hsl[1], l: hsl[2], skin: case2dIsSkin(rgb) };
            });
            return { palette: palette, px: px, w: S, h: S, idx: idx };
        }

        function case2dRegionDominant(st, inRegion) {
            var cnt = new Array(st.palette.length), n = 0, z;
            for (z = 0; z < st.palette.length; z++) { cnt[z] = 0; }
            for (var y = 0; y < st.h; y++) {
                for (var x = 0; x < st.w; x++) {
                    if (inRegion(x / st.w, y / st.h)) { cnt[st.idx[y * st.w + x]]++; n++; }
                }
            }
            var cand = st.palette.map(function (c, k) {
                return { rgb: c.rgb, h: c.h, s: c.s, l: c.l, skin: c.skin, pop: cnt[k] / n };
            }).filter(function (c) { return c.s >= 0.15 || c.l < 0.10; });
            return (cand.length ? cand : st.palette).reduce(function (a, b) { return b.pop > a.pop ? b : a; });
        }

        function case2dPick(st, mode) {
            if (!st || !st.palette.length) { return null; }
            var palette = st.palette;
            var colourfulAll = palette.filter(function (c) { return c.s >= 0.15 && c.l >= 0.10 && c.l <= 0.90; });
            var colourful = colourfulAll.filter(function (c) { return !c.skin; });
            var pool = colourful.length ? colourful : (colourfulAll.length ? colourfulAll : palette);
            var withDark = palette.filter(function (c) { return c.s >= 0.15 || c.l < 0.10; });
            var fit = function (v, target, range) { return Math.max(0, 1 - Math.abs(v - target) / range); };
            var score = function (c, lT, sT, sR) { return 0.52 * fit(c.l, lT, 0.5) + 0.24 * fit(c.s, sT, sR) + 0.24 * c.pop; };
            var best = function (arr, f) { return arr.reduce(function (a, b) { return f(b) > f(a) ? b : a; }); };
            switch (mode) {
            case 'dominant_dark':
                return best(withDark.length ? withDark : palette, function (c) { return c.pop; });
            case 'dominant':
                return best(pool, function (c) { return c.pop; });
            case 'vibrant':
                return best(pool, function (c) { return score(c, 0.50, 1.0, 0.65); });
            case 'deep':
                // Adobe 'Deep' mood: the dominant colourful cluster, rendered dark (the cap is in case2dPlastic)
                return best(pool, function (c) { return c.pop; });
            case 'accent': {
                if (pool.length < 2) { return best(pool, function (c) { return c.pop; }); }
                var main = best(pool, function (c) { return c.pop; });
                var hd = function (c) { var d = Math.abs(c.h - main.h); return Math.min(d, 1 - d); };
                var rest = pool.filter(function (c) { return c !== main && hd(c) > 0.08 && c.pop >= 0.02; });
                return rest.length ? best(rest, function (c) { return c.pop; }) : main;
            }
            case 'material': {
                var hueProp = new Float32Array(360), tot = 0, i;
                for (i = 0; i < st.px.length; i += 4) {
                    var o = case2dRgb2oklch([st.px[i], st.px[i + 1], st.px[i + 2]]);
                    if (o.C * 400 < 15) { continue; }
                    hueProp[Math.round(o.h) % 360] += 1; tot++;
                }
                if (!tot) { return best(palette, function (c) { return c.pop; }); }
                var cand = palette.map(function (c) {
                    var oc = case2dRgb2oklch(c.rgb), ch = oc.C * 400, ex = 0;
                    for (var d = -14; d <= 14; d++) { ex += hueProp[(Math.round(oc.h) + d + 360) % 360]; }
                    ex /= tot;
                    return { c: c, ch: ch, ex: ex, score: 70 * ex + (ch - 48) * (ch < 48 ? 0.1 : 0.3) };
                }).filter(function (x) { return x.ch >= 15 && x.ex >= 0.01; });
                return cand.length
                    ? cand.reduce(function (a, b) { return b.score > a.score ? b : a; }).c
                    : best(palette, function (c) { return c.pop; });
            }
            case 'top':
                return case2dRegionDominant(st, function (u, v) { return v < 0.30; });
            }
            return null;
        }

        // The renderer's own plastic(): a case is never black and never
        // washed out, whatever the poster says.
        function case2dPlastic(c, lMax) {
            if (lMax === undefined) { lMax = 0.60; }   // the default is in the signature upstream
            var l = Math.max(0.25, Math.min(lMax, c.l));
            var sat = c.l < 0.25 ? Math.max(c.s, 0.25) : c.s;
            return case2dHsl2rgb(c.h, sat, l);
        }

        // The same vendor script the Three.js case loads, from the same
        // endpoint - its own loader sits inside ThreejsCaseModule, and this
        // module is kept free of that dependency (it is also run on its own
        // in tests). Both guard on window.ColorThief, so whichever runs first wins and
        // the script is fetched once.
        var case2dColorThiefPromise = null;
        function case2dLoadColorThief() {
            if (window.ColorThief) { return Promise.resolve(true); }
            if (case2dColorThiefPromise) { return case2dColorThiefPromise; }
            case2dColorThiefPromise = new Promise(function (resolve) {
                var sc = document.createElement('script');
                sc.src = '/ThreejsCase/lib/colorthief.js';
                sc.onload = function () { resolve(!!window.ColorThief); };
                sc.onerror = function () {
                    log('Color Thief did not load - the case keeps its original texture');
                    resolve(false);
                };
                document.head.appendChild(sc);
            });
            return case2dColorThiefPromise;
        }

        function case2dLoad(url) {
            return new Promise(function (resolve) {
                var img = new Image();
                img.onload = function () { resolve(img); };
                img.onerror = function () { resolve(null); };
                img.src = url;
            });
        }

        // One texture, four layers, one canvas. Returns null when the layers
        // are not there - the caller then keeps the plain texture, so a case
        // type whose split has not shipped yet simply stays untinted.
        /// `ver` is the version token, and it has to be passed SEPARATELY rather
        /// than sitting on baseUrl already. The four layers are addressed by
        /// APPENDING to the base, so a base carrying "?v=..." would produce
        /// ".../back_1080p?v=8df1b5f3be6e2fd_shell" - a query the server
        /// ignores, so all four layers would silently return the original
        /// texture and the tint would vanish under print and gloss. The token
        /// belongs at the END of each finished address, never in the middle.
        function case2dCompose(baseUrl, rgb, ver) {
            ver = ver || '';
            return Promise.all([
                case2dLoad(baseUrl + '_shell' + ver), case2dLoad(baseUrl + '_shell2' + ver),
                case2dLoad(baseUrl + '_print' + ver), case2dLoad(baseUrl + '_gloss' + ver)
            ]).then(function (imgs) {
                var shell = imgs[0];
                if (!shell || !shell.naturalWidth) { return null; }
                var w = shell.naturalWidth, h = shell.naturalHeight;
                var cv = document.createElement('canvas');
                cv.width = w; cv.height = h;
                var cx = cv.getContext('2d');
                cx.drawImage(shell, 0, 0);
                var base = cx.getImageData(0, 0, w, h), second = null;
                if (imgs[1] && imgs[1].naturalWidth === w && imgs[1].naturalHeight === h) {
                    cx.clearRect(0, 0, w, h);
                    cx.drawImage(imgs[1], 0, 0);
                    second = cx.getImageData(0, 0, w, h).data;
                }
                var d = base.data;
                for (var i = 0; i < d.length; i += 4) {
                    // The two shells are greyscale, so one channel carries the
                    // tone; their sum is <= 255 by construction, and the clamp
                    // is there because a hand-made layer might not be.
                    var g = d[i] + (second ? second[i] : 0);
                    if (g > 255) { g = 255; }
                    d[i] = g * rgb[0] / 255;
                    d[i + 1] = g * rgb[1] / 255;
                    d[i + 2] = g * rgb[2] / 255;
                }
                cx.putImageData(base, 0, 0);
                if (imgs[2]) { cx.drawImage(imgs[2], 0, 0); }
                if (imgs[3]) { cx.drawImage(imgs[3], 0, 0); }
                try { return cv.toDataURL('image/png'); } catch (e) { return null; }
            }).catch(function () { return null; });
        }

        // Which picture the colour comes from. Same chain as the Three.js
        // case: a winning Extraposter does NOT give the colour - the link
        // below it does,
        // because the cycling pictures must not keep changing the case.
        // KNOWN LIMITATION: this runs before the arbiter has settled on the
        // front-first path, so when no decision is in yet it falls back to
        // the Primary image. The Three.js case awaits the decision because
        // it has one to await at that point; here the front would have to
        // wait for it.
        function case2dColourImageUrl(coord, itemId) {
            var url = null;
            var decision = (coord && coord.decision) ? coord.decision : null;
            var p = (coord && coord.participants) || {};
            if (decision) {
                var winner = decision.logicalWinner || 0;
                if (winner === 3) { url = (p[2] && p[2].url) || (p[1] && p[1].url) || null; }
                else if (winner === 2) { url = (p[2] && p[2].url) || null; }
                else if (winner === 1) { url = (p[1] && p[1].url) || null; }
            }
            if (!url && window.ApiClient) {
                url = window.ApiClient.getUrl('Items/' + itemId + '/Images/Primary', { maxWidth: 1200, quality: 92 });
            }
            return url;
        }

        // Fills `into` with composed data URLs, keyed variant/key. Resolves
        // with nothing to do whenever the mode is Original, the blend is
        // unknown, Color Thief will not load, or the poster yields no colour.
        function case2dPrepare(response, coord, itemId, keys, into) {
            if (!response || response.ColorMode !== 'FullShell') { return Promise.resolve(false); }
            var mode = CASE2D_BLEND[response.ColorBlend];
            if (!mode) { return Promise.resolve(false); }
            return case2dLoadColorThief().then(function () {
                return case2dLoad(case2dColourImageUrl(coord, itemId));
            }).then(function (img) {
                var picked = case2dPick(case2dAnalyse(img), mode);
                if (!picked) { log('case colour: no colour from the cover - the case stays original'); return false; }
                var rgb = case2dPlastic(picked);
                log('case colour ' + response.ColorBlend + ' -> rgb(' + rgb.join(',') + ')');
                // The SAME build the page would draw, token and all: composing
                // from one delivery while the page draws another is what this
                // token prevents. The token goes to case2dCompose, not onto the
                // base - the base still has to grow four suffixes.
                var ver = response.TextureVersion ? ('?v=' + encodeURIComponent(response.TextureVersion)) : '';
                return Promise.all(keys.map(function (vk) {
                    var url = '/CaseMod/Texture/' + encodeURIComponent(vk[0]) + '/' + encodeURIComponent(vk[1]);
                    return case2dCompose(url, rgb, ver).then(function (data) {
                        if (data) { into[vk[0] + '/' + vk[1]] = data; }
                    });
                })).then(function () { return true; });
            }).catch(function (e) { log('case colour failed, staying original', e); return false; });
        }

        // POSTER SIZE.
        //
        // Nothing here is measured: measured pixels exist only AFTER a
        // layout, so every later layout (the card Jellyfin rebuilds after
        // viewshow, a resize, fullscreen) would have to be chased, and the
        // poster would jump while loading. Jellyfin's poster box stands in its own
        // stylesheet (librarybrowser.scss, .detailImageContainer .card):
        //
        //   desktop   left 3.3%   top -80%      width 25vw       max-height none
        //   tv        left 5%     top 50%       width 25vw       translateY(-50%)
        //   mobile    left 5%     bottom 1rem   max-width 30vw   top auto
        //   shape     .card 2:3   .backdropCard 16:9             .squareCard 1:1
        //
        // so a percentage and an anchor are one generated rule in the same
        // units the page itself uses. A rule in vw survives every resize
        // without being told, and it can be written before the card exists.
        //
        // It hangs on the VIEW, not on the card: renderDetailImage rebuilds
        // the card, which would take a class or an inline style on the card
        // with it. .itemDetailPage survives that.
        var posterSizePct = 100;
        var posterSizeAnchor = 'Default';
        var posterSizeView = null;
        var posterSizeClass = '';
        var posterSizeRulesInjected = {};

        // Where the shrunken card sits inside the footprint it had at 100 %.
        // Measured against that FOOTPRINT, never against Jellyfin's own
        // anchor: that anchor is top-left on desktop, vertically centred on
        // TV and bottom-left on mobile, so an offset added to it would mean
        // something different on each. 'Default' has no entry - the card is
        // then left exactly where Jellyfin puts it.
        var POSTER_SIZE_ANCHORS = {
            TopLeft: [0, 0], TopCenter: [0.5, 0], TopRight: [1, 0],
            CenterLeft: [0, 0.5], Center: [0.5, 0.5], CenterRight: [1, 0.5],
            BottomLeft: [0, 1], BottomCenter: [0.5, 1], BottomRight: [1, 1]
        };
        // The three layouts, with the width Jellyfin gives the box in each
        // and the edge it anchors from vertically.
        var POSTER_SIZE_LAYOUTS = [
            { sel: '.layout-desktop', w: 25 },
            { sel: '.layout-tv', w: 25 },
            { sel: '.layout-mobile', w: 30, fromBottom: true }
        ];
        // One rule per shape, so the card's aspect never has to be looked
        // up - the more specific selector wins wherever it applies.
        var POSTER_SIZE_SHAPES = [['', 1.5], ['.backdropCard', 0.5625], ['.squareCard', 1]];
        // The desktop portrait box, for the case boxes' own vertical shift.
        var POSTER_SIZE_BOX_H = 37.5;

        var POSTERSIZE_HOLD_STORAGE_KEY = 'artworkplus-postersize-pending';
        function posterSizeRemembered() {
            try {
                var raw = localStorage.getItem(POSTERSIZE_HOLD_STORAGE_KEY);
                if (!raw || raw === '0' || raw === '1') { return null; }
                var v = JSON.parse(raw);
                return (v && v.pct && v.pct !== 100) ? v : null;
            } catch (e) { return null; }
        }
        function posterSizeExpected() { return caseMixOn() || !!posterSizeRemembered(); } // hold under the mix
        function posterSizeRemember(pct, anchor) {
            try {
                localStorage.setItem(POSTERSIZE_HOLD_STORAGE_KEY,
                    (pct && pct !== 100) ? JSON.stringify({ pct: pct, anchor: anchor || 'Default' }) : '0');
            } catch (e) { /* private mode */ }
        }

        function posterSizeRuleFor(pct, anchor) {
            var cls = 'artworkplus-ps-' + String(pct).replace(/[^0-9]/g, '')
                    + '-' + String(anchor).replace(/[^A-Za-z]/g, '');
            if (posterSizeRulesInjected[cls]) { return cls; }
            posterSizeRulesInjected[cls] = true;
            var f = pct / 100;
            var a = POSTER_SIZE_ANCHORS[anchor] || [0, 0];
            var css = [];
            POSTER_SIZE_LAYOUTS.forEach(function (lay) {
                var root = lay.sel + ' .itemDetailPage.' + cls + ' .detailImageContainer ';
                var sx = lay.w * (1 - f) * a[0];
                css.push(root + '.card {',
                         '    width: ' + (lay.w * f) + 'vw;',
                         '    max-width: ' + (lay.w * f) + 'vw;',
                         '    margin-left: ' + sx + 'vw;',
                         '}');
                POSTER_SIZE_SHAPES.forEach(function (sh) {
                    var sy = lay.w * sh[1] * (1 - f) * (lay.fromBottom ? (1 - a[1]) : a[1]);
                    css.push(root + '.card' + sh[0] + ' {',
                             '    margin-' + (lay.fromBottom ? 'bottom' : 'top') + ': ' + sy + 'vw;',
                             '}');
                });
                // The case boxes carry their SIZE and their vertical offset
                // in their own generated rule (see posterSizeScaleAnswer);
                // only the horizontal shift lands here, because their left
                // is a percentage of the container while this is a vw - and
                // a margin adds the two without converting between them.
                css.push(root + '.' + BOX_CLASS + ',',
                         root + '.' + TUNE_PREVIEW_CLASS + ' {',
                         '    margin-left: ' + sx + 'vw;',
                         '}');
            });
            var st = document.createElement('style');
            st.id = cls;
            st.textContent = css.join('\n');
            document.head.appendChild(st);
            return cls;
        }

        // Puts the rule on the view. Idempotent, and cheap enough to run
        // before the answer is in - which is the point: the remembered value
        // is applied at navigation time, so the card is BORN at its size
        // instead of being corrected into it one frame later.
        function posterSizeApplyTo(view, pct, anchor) {
            if (!view) { return; }
            var want = (pct && pct !== 100) ? posterSizeRuleFor(pct, anchor || 'Default') : '';
            if (posterSizeView && posterSizeClass && (posterSizeView !== view || posterSizeClass !== want)) {
                posterSizeView.classList.remove(posterSizeClass);
            }
            posterSizeView = view;
            posterSizePct = pct || 100;
            posterSizeAnchor = anchor || 'Default';
            posterSizeClass = want;
            if (want) { view.classList.add(want); }
        }

        // Called from startDetail BEFORE the poster element is waited for.
        function posterSizePreapply() {
            var v = posterSizeRemembered();
            if (!v) { return; }
            var view = document.querySelector('.itemDetailPage:not(.hide)')
                    || document.querySelector('.itemDetailPage');
            if (view) { posterSizeApplyTo(view, v.pct, v.anchor); }
        }

        // The case boxes are placed by our OWN generated rules, in vw and %
        // against the same container as the poster. Scaling them is
        // therefore arithmetic on the numbers that go into those rules, not
        // a second pass over the DOM:
        //     left%  ->  3.3 + (left - 3.3) * f   (3.3 % is the poster's own left)
        //     topVw  ->  top * f + verticalShift  (both vw on the same -80 % base)
        //     size   ->  size * f
        // The horizontal shift is added as a margin by the rule above.
        function posterSizeScaleAnswer(response) {
            var pct = response && response.PosterSizePercent;
            posterSizeRule = { f: 1, sy: 0 };
            if (!pct || pct === 100) { return; }
            var f = pct / 100;
            var a = POSTER_SIZE_ANCHORS[response.PosterSizeAnchor] || [0, 0];
            var sy = POSTER_SIZE_BOX_H * (1 - f) * a[1];
            posterSizeRule = { f: f, sy: sy };
            function left(v) { return 3.3 + (v - 3.3) * f; }
            function top(v) { return v * f + sy; }
            response.LeftPercent = left(response.LeftPercent);
            response.TopPercent = top(response.TopPercent);
            response.WidthVw *= f;
            response.HeightVw *= f;
            response.DiscLeftPercent = left(response.DiscLeftPercent);
            response.DiscTopPercent = top(response.DiscTopPercent);
            response.DiscSizeVw *= f;
            response.InnerCaseLeftPercent = left(response.InnerCaseLeftPercent);
            response.InnerCaseTopPercent = top(response.InnerCaseTopPercent);
            response.InnerCaseWidthVw *= f;
            response.InnerCaseHeightVw *= f;
            response.HubLeftPercent = left(response.HubLeftPercent);
            response.HubTopPercent = top(response.HubTopPercent);
            response.HubSizeVw *= f;
        }
        async function check(coord, itemId, posterEl, myGeneration) {
            removeExistingOverlay();
            // Poster size is NOT reset here. startDetail has just applied the
            // remembered value to this view, and a reset would take it
            // straight off again - the card would appear at Jellyfin's size
            // and flicker when the answer lands. posterSizeApplyTo() below
            // takes the previous view's class off when it sets the new one.
            ThreejsCaseModule.reset();   // a case from the previous item goes with it
            var holdView = posterEl.closest ? posterEl.closest('.itemDetailPage') : null;
            if (holdView && (caseTiltExpected() || posterSizeExpected()) && caseTiltHold.view !== holdView) { caseModHoldPoster(holdView); }

            // Started BEFORE our own request so both are in
            // flight together - a movie with the feature on must not wait
            // twice. Null when a synchronous gate already said no.
            var threejsClaim = ThreejsCaseModule.claimFor(itemId);

            var response;
            try {
                response = await fetch('/CaseMod/' + encodeURIComponent(itemId) + webglQuery('?'), { cache: 'no-store' })
                    .then(function (r) { return r.json(); });
            } catch (e) {
                log('Fetch error', e);
                caseModReleasePoster();
                return;
            }

            // Poster size first, and unconditionally: it is not part of
            // the case and must survive every exit below - the Three.js
            // hand-over, "not applicable", and the Show-on exclusions.
            // startDetail has usually applied the REMEMBERED value already,
            // before the card existed; this is the correction to the answer,
            // and on the common path it changes nothing at all.
            var wantPct = (response && response.PosterSizePercent) || 100;
            var wantAnchor = (response && response.PosterSizeAnchor) || 'Default';
            posterSizeRemember(wantPct, wantAnchor);
            posterSizeApplyTo(holdView, wantPct, wantAnchor);
            // The case boxes are placed by our own generated rules, so their
            // numbers are scaled here, once, before any of them is built.
            posterSizeScaleAnswer(response);
            // Released here and not at the end: from this point the card
            // carries its final size, and everything after - the Three.js
            // hand-over, "not applicable", the Show-on exits - must not
            // leave it hidden. The tilt keeps its own hold if it wants one.
            if (!caseTiltExpected()) { caseModReleasePoster(); }
            if (wantPct !== 100) { log('poster size ' + wantPct + '% ' + wantAnchor); }

            // If the Three.js Case takes this item, the flat case
            // stands down completely - one slot, one winner. Everything this
            // module did so far is undone first (the hold, any overlay), so a
            // claim leaves the page exactly as if CaseMod had never run.
            if (threejsClaim) {
                var claim = await threejsClaim;
                if (myGeneration !== currentGeneration()) { caseModReleasePoster(); return; }
                if (claim) {
                    caseModReleasePoster();
                    removeExistingOverlay();
                    // Poster size is the 2D mechanism, `Case size` is the
                    // Three.js one; they work independently and must not
                    // multiply. `Case size` is a percentage of the
                    // poster BOX, so leaving a scaled card underneath would
                    // make the 3D case 0.7 * 0.8 of the box at Poster size 70
                    // and Case size 80. Undone here rather than skipped
                    // earlier on purpose: the claim is only known after an
                    // await, and Poster size has to be applied before the
                    // first paint or the card pops in.
                    if (posterSizePct !== 100) {
                        posterSizeApplyTo(posterSizeView, 100, 'Default');
                        log('Three.js case: poster size stands down - the case carries its own size');
                    }
                    ThreejsCaseModule.render(claim, itemId, posterEl, myGeneration);
                    return;
                }
            }

            if (myGeneration !== currentGeneration()) { caseModReleasePoster(); return; }

            if (!response || !response.IsApplicable) {
                log('Not applicable for', itemId);
                caseModReleasePoster(); // (the remembered "3D expected" stays - Show-on/type exclusions are per item, not a config change)
                return;
            }

            if (!document.body.contains(posterEl)) { caseModReleasePoster(); return; }
            var tiltComing = response.CaseType === 'vivaelite3dcases' && !!(response.CaseAngleDegrees || 0);
            caseTiltRemember(tiltComing);
            if (!tiltComing) { caseModReleasePoster(); } // nothing to tilt: the card shows as always

            // The real poster CARD (position:absolute, vw/vh/%-based,
            // z-index:3) - NOT .cardImageContainer itself (that's deeper
            // inside it, and the one that clips - see ensureStylesInjected).
            // Our own box becomes this
            // card's own SIBLING, one level up, inside the same shared,
            // always-present parent.
            var realCard = posterEl.closest('.card');
            var detailImageContainer = (realCard && realCard.parentElement) || posterEl.closest('.detailImageContainer');
            if (!detailImageContainer) {
                log('Could not find detailImageContainer for', itemId);
                caseModReleasePoster();
                return;
            }

            ensureStylesInjected(response.OpenAngleDegrees);
            ensureSizedStylesInjected(
                response.CaseType,
                response.TopPercent, response.LeftPercent,
                response.WidthVw, response.HeightVw
            );

            // Open Case is active whenever at least one of its triggers is
            // on (and the item has a disc). That combined boolean also
            // decides whether the real poster (+ Keyart/Extrakeyart
            // logo) swings open together with it, and whether the Disc
            // is included at all. Computed once up front since several
            // branches below need it.
            var animateOpen = !!((response.OpenAutomatic || response.OpenOnClickAutomatic
                                  || response.OpenOnClick) && response.HasDiscart);

            // Every texture of this case goes through here, so Case colour
            // has exactly one place to substitute. With ColorMode 'Original'
            // the map stays empty and this returns the plain texture URL.
            var case2dUrls = {};
            /// Every texture address carries ?v=<TextureVersion>. The endpoint
            /// answers "immutable" for a month, so a changed file has to be a
            /// changed ADDRESS, or the browser keeps the old picture (see the
            /// server field's own comment).
            function case2dTexVersion() {
                return response.TextureVersion ? ('?v=' + encodeURIComponent(response.TextureVersion)) : '';
            }
            function case2dTexUrl(variant, key) {
                return case2dUrls[variant + '/' + key]
                    || ('/CaseMod/Texture/' + encodeURIComponent(variant) + '/' + encodeURIComponent(key)
                        + case2dTexVersion());
            }
            // The inside comes from the case type's own folder. For
            // vivaelite3dcases it is NOT back_* - those files are the OUTSIDE
            // back of the rendered case (no tray, no ring) - it ships under its own `inside_`
            // prefix, and there it does have a set artwork.
            var innerVariant = response.CaseType;
            var innerKey;
            if (response.CaseType === 'vivaelite3dcases') {
                innerKey = 'inside_' + response.BackTextureKey.replace(/^back_/, '');
            } else {
                // The flat three have no set inside; back_tvseries (gold)
                // stands in for it.
                innerKey = response.BackTextureKey === 'back_set'
                    ? 'back_tvseries' : response.BackTextureKey;
            }
            // The hub belongs to the DISC, not to the inner-case box (whose
            // section lives inside the vivaelite3dcases-only tilt branch), so
            // it is resolved for all four case types.
            //
            // Its URL is NOT kept in a variable here. Case colour substitutes
            // composed textures into case2dUrls further down, and a URL taken
            // before that would keep the uncoloured original. It is resolved
            // at the point of use.
            var frontTextureUrl = case2dTexUrl(response.CaseType, response.TextureKey);
            var backTextureUrl = case2dTexUrl(response.CaseType, response.BackTextureKey);
            // Standard Jellyfin image endpoint (Jellyfin.Api's
            // ImageController.GetItemImage - no [Authorize] on the route,
            // the same mechanism
            // every native poster/backdrop/logo <img> already uses) -
            // no dedicated CaseMod endpoint needed for the disc itself.
            var discImageUrl = '/Items/' + encodeURIComponent(itemId) + '/Images/Disc';

            // Small local helper - front and back box are structurally
            // identical (same BOX_CLASS, same per-case-type sized
            // geometry class, same 100%-filling <img>), differing only
            // in their layer modifier class and texture. `fadeIn`:
            // Front/Back start at opacity:0 with a transition already
            // attached, so calling
            // fadeInBox() (below) right after appendChild produces a
            // visible 200ms fade instead of a hard pop-in. Disc
            // deliberately never gets this - it attaches while the
            // case is still closed (behind the front cover), so its
            // own appendChild is never visually perceived as a "pop"
            // in the first place; the Open Case rotation is its own,
            // already-existing reveal.
            function buildBox(modifierClass, sizedClass, textureUrl, fadeIn) {
                var b = document.createElement('div');
                b.className = BOX_CLASS + ' ' + modifierClass + ' ' + sizedClass;
                if (fadeIn) {
                    b.style.opacity = '0';
                    b.style.transition = 'opacity ' + CASE_FADE_IN_MS + 'ms ease';
                }
                var i = document.createElement('img');
                i.className = OVERLAY_CLASS;
                i.src = textureUrl;
                i.style.position = 'absolute';
                i.style.left = '0';
                i.style.top = '0';
                i.style.width = '100%';
                i.style.height = '100%';
                i.style.pointerEvents = 'none';
                b.appendChild(i);
                // Nothing to do for Poster size here: a box carries its size
                // and offset in its own generated rule, whose numbers were
                // scaled once when the answer came in, and the horizontal
                // shift comes from the view's rule.
                return b;
            }

            // Front and Back fade in over 200ms instead of popping in hard -
            // Disc excluded (see buildBox). Same technique as ExtraModule's
            // crossfade: an opacity:0->1 flip in the same tick as the
            // element's append can be coalesced into one paint, so the
            // transition never shows. A DOUBLE requestAnimationFrame
            // guarantees the opacity:0 state has been painted first.
            // Generation/liveness is re-checked when the fade starts, so a
            // navigation in that gap fires nothing on the old page.
            function fadeInBox(box) {
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        if (myGeneration !== currentGeneration() || !document.body.contains(box)) { return; }
                        box.style.opacity = '1';
                    });
                });
            }

            var frontSizedClass = sizedClassName(response.CaseType, response.TopPercent, response.LeftPercent, response.WidthVw, response.HeightVw);

            // Performance: Front is the ONLY thing the visible-case path
            // waits on. Back and Disc are never read by the Front/Rotator
            // setup below (Back is written once and never referenced again;
            // Disc is only read inside case2dRunCycle()/case2dEndCycle(),
            // reachable only after a delay or a click), so they stay off the
            // awaited path to the first visible paint.
            // Case colour, before the front is preloaded - the
            // composed texture has to BE the front, not replace it a moment
            // later. Costs nothing in the default mode: case2dPrepare returns
            // immediately when the mode is 'Original'.
            try {
                await case2dPrepare(response, coord, itemId, [
                    [response.CaseType, response.TextureKey],
                    [response.CaseType, response.BackTextureKey],
                    [innerVariant, innerKey],
                    [innerVariant, innerKey + '_hub']
                ], case2dUrls);
                frontTextureUrl = case2dTexUrl(response.CaseType, response.TextureKey);
                backTextureUrl = case2dTexUrl(response.CaseType, response.BackTextureKey);
            } catch (e) {
                log('Case colour failed, keeping the original textures', e);
            }

            // For EVERY case type. The tilt branch has its own
            // copy for the 3D case, which runs later and sets the same
            // property to the same value - harmless, and left alone because
            // it also drives that type's own hold.
            tuneHidePoster(posterEl, response.TuneHidePoster);

            try {
                await Core.preloadImage(frontTextureUrl);
            } catch (e) {
                log('Texture preload failed, skipping', e);
                return;
            }

            // Generation/liveness guard for Front's own append (Back/Disc
            // have their own check further down).
            if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }

            // Front cover, with the Open Case animation (a port of a Kodi
            // skin's rotatey effect - see ensureStylesInjected). It runs ONLY
            // when Open Case is on AND the item has a discart - a case with
            // nothing inside to reveal stays static. The hinge sits on the
            // texture's measured visible left edge (HINGE_ORIGIN_X_PERCENT).
            // ROTATOR_HOST_CLASS exists for the browser quirk where
            // `perspective` directly on the rotated element's parent breaks
            // the rotation (see ROTATOR_HOST_CLASS).
            var frontBox = buildBox(BOX_FRONT_CLASS, frontSizedClass, frontTextureUrl, true);
            // The whole case takes the click, not only the poster inside it: the
            // front box spans the case's own outline, which is wider than the
            // poster on every side. Made clickable AFTER case2dLid exists -
            // see the call further down, next to the lid's own setup.
            // The rotator lives inside frontBox while Open Case runs, so
            // hiding the box takes the moving cover with it.
            tuneHide(frontBox, response.TuneHideFrontCase);
            var rotator = null;
            var cardScalableEl = null;
            var padderEl = null;
            var discBox = null;
            /// The disc box is built in its OWN block further
            /// down, after a network round trip, and needs two things from the
            /// lid's block - whether a cycle is running, and the disc's own
            /// one-revolution gesture. Handed over explicitly instead of
            /// reached for across blocks.
            var case2dLid = null;
            /// The inside of the case is part of its click surface - see
            /// CASE_CLICK_CLASS. It is built in its own block too, and in two
            /// different places, one per case kind, so this is the one door both
            /// go through. Only while the case can be opened BY CLICK: in a case
            /// that only opens by itself a click has nothing to do.
            /// WHO NEEDS A CLICK SURFACE. Not only the manual mode: the
            /// click-started sequence needs one too, and so does the disc's own
            /// click - the disc is not a target itself (see case2dHitsDisc), it
            /// is reached through the case's surfaces, which is why "Spinning
            /// disc: On click" alone has to bring them into being.
            var case2dTakesClicks = !!(response.OpenOnClick || response.OpenOnClickAutomatic
                                       || response.SpinOnClick);

            function case2dMakeCaseClickable(box) {
                if (!box || !case2dLid || !case2dTakesClicks) { return; }
                box.classList.add(CASE_CLICK_CLASS);
                box.addEventListener('click', case2dLid.click);
            }
            if (animateOpen) {
                var frontImg = frontBox.firstChild;
                var rotatorHost = document.createElement('div');
                rotatorHost.className = ROTATOR_HOST_CLASS;
                // ROTATOR_CLASS alone, WITHOUT ROTATOR_OPEN_CLASS - the structure is built
                // immediately, but the animation itself only starts
                // once case2dRunCycle() below actually runs
                // (via the admin-configurable delay and/or a valid
                // poster click - see PluginConfiguration's own
                // CaseMod2DOpenAutomatic/OpenOnClick doc
                // comments). ensureStylesInjected's own CSS already
                // requires BOTH classes together for the animation to
                // apply, so this alone is inert until then.
                rotator = document.createElement('div');
                rotator.className = ROTATOR_CLASS;
                rotator.appendChild(frontImg);
                rotatorHost.appendChild(rotator);
                frontBox.appendChild(rotatorHost);

                // The real poster, any Extraposter overlay layers, and the
                // Keyart/Extrakeyart logo overlay (if present) all swing open
                // TOGETHER with the front cover as one rigid unit, by rotating
                // `.cardScalable` itself (see POSTER_ROTATE_CLASS) - whatever
                // lives inside it moves along.
                ensurePosterOriginStylesInjected(
                    response.CaseType,
                    HINGE_ORIGIN_X_PERCENT[response.CaseType] || 0,
                    response.LeftPercent, response.WidthVw
                );
                var posterOriginClass = POSTER_ORIGIN_CLASS_PREFIX + response.CaseType;
                cardScalableEl = posterEl.closest('.cardScalable');
                if (cardScalableEl) {
                    cardScalableEl.classList.add(posterOriginClass, POSTER_ROTATE_CLASS);
                }
                // `.card` gets its per-type class (contain without paint,
                // default cursor) - see ensurePosterOriginStylesInjected.
                realCard.classList.add(CARD_PERSPECTIVE_CLASS_PREFIX + response.CaseType);

                // Background padder (see ensureStylesInjected) - the HIDE
                // class itself is only added once
                // the animation actually starts (see
                // case2dRunCycle() below), not eagerly here.
                padderEl = realCard.querySelector('.cardPadder');
            }

            detailImageContainer.appendChild(frontBox);
            trackMobileCardWidth(detailImageContainer, realCard || detailImageContainer.querySelector('.card'));
            fadeInBox(frontBox);

            // Case Angle (response.CaseAngleDegrees) is admin-editable. The
            // sign determines the hinge side: negative = right (93.128%),
            // positive = left
            // (mirrored, 6.872%). At exactly 0 the side has no effect
            // (nothing visible), the code then simply picks the right
            // side.
            //
            // Hinge sharing follows the same principle as for opening: ONE
            // shared hingeXPx (measured from the
            // case box itself), passed on to case, poster, inner case
            // AND disc - otherwise they would tilt around different
            // axes and visibly drift apart.
            //
            // applyTilt() lives HERE, outside the following if block:
            // 'use strict' makes a function declaration INSIDE a block
            // block-scoped (unlike var), and backBox's .then() further down
            // needs to reach it.
            var tiltAngle, tiltHingeXPx, tiltScreenW, tiltScreenH, tiltCameraX, tiltCameraY, tiltPosterRect;
            var tiltTarget = null, tiltFrontRect = null, tiltHingePct = 0, tiltCardScalableEl = null;
            var scheduleInnerCaseDiscPreview = null;
            // applyTilt() rotates around the REAL right spine - no
            // compensation needed, since computeNestedKodiMatrix3dString
            // (Open Case, see runRotationFrame) reduces exactly to this same
            // rotation at openAngle=0, so rest tilt and Open Case share the
            // same maths.
            // The Kodi matrix bakes SCREEN coordinates in - the object's
            // position against a fixed camera. Kodi never scrolls; the
            // plugin's equivalent is the DESIGN frame: the element's layout
            // position at scroll 0 (viewport rect + the scroll offsets of
            // every scrolling ancestor and the window). Every measurement for
            // the case geometry goes through measureDesignRect - a raw
            // getBoundingClientRect() is viewport-relative, so the angle
            // would wander while scrolling, the first tilt after a mid-page
            // reload would be wrong, and an open-case animation measured
            // while scrolled would jump against the rest tilt.
 
            function applyTilt(el, rect) {
                el.style.transformOrigin = '0 0';
                el.style.transform = computeKodiMatrix3dString(
                    tiltAngle, tiltHingeXPx, rect.left, rect.top,
                    tiltScreenW, tiltScreenH, tiltCameraX, tiltCameraY
                );
                if (tiltedEls.indexOf(el) === -1) { tiltedEls.push(el); }
            }

            // The Kodi matrix bakes ABSOLUTE design-frame coordinates in
            // (rect.left/top, hinge px, screen size, camera centre) measured
            // ONCE right after the box was appended. If that measurement
            // was taken before the page settled (poster decode, padder
            // toggle, scroll restore, late fonts) or the viewport changed
            // afterwards (resize, scroll), the perspective divide runs
            // against a wrong Y - the trapezoid degenerates into a sheared
            // parallelogram. retilt() re-measures every tilted element
            // UNTRANSFORMED (transform cleared, measured, re-applied inside
            // one frame - no visible flicker) and re-applies the matrix; it
            // runs at settle points and on resize (not on scroll), never while the
            // Open Case animation holds the rotator.
            var tiltedEls = [];
            var retiltQueued = null;
            function retilt() {
                retiltQueued = null;
                if (myGeneration !== currentGeneration()) { return; }
                if (!tiltTarget || !document.body.contains(tiltTarget)) { return; }
                if (rotator && (rotator.classList.contains(ROTATOR_OPEN_CLASS)
                                || rotator.classList.contains(ROTATOR_HOLD_CLASS))) { return; }
                tiltedEls = tiltedEls.filter(function (el) { return document.body.contains(el); });
                // The rotator/poster carry a CSS transition on transform (Open
                // Case) - clearing and re-setting would ANIMATE from flat.
                // Transition off for the re-measure, reflow, restore afterwards.
                var savedTransitions = tiltedEls.map(function (el) { return el.style.transition; });
                tiltedEls.forEach(function (el) { el.style.transition = 'none'; el.style.transform = ''; });
                var rect = measureDesignRect(tiltTarget);
                if (rect.width && rect.height) {
                    var cam = designCamera(rect);
                    tiltScreenW = cam.screenW; tiltScreenH = cam.screenH;
                    tiltHingeXPx = rect.left + (tiltHingePct / 100) * rect.width;
                    tiltCameraX = cam.cameraX; tiltCameraY = cam.cameraY;
                    tiltFrontRect = rect;
                    if (tiltCardScalableEl && document.body.contains(tiltCardScalableEl)) { tiltPosterRect = measureDesignRect(tiltCardScalableEl); }
                }
                tiltedEls.forEach(function (el) { applyTilt(el, measureDesignRect(el)); });
                void document.body.offsetWidth; // commit the untransitioned state before the transition comes back
                tiltedEls.forEach(function (el, i) { el.style.transition = savedTransitions[i]; });
            }
            function queueRetilt() {
                if (retiltQueued !== null) { return; }
                retiltQueued = requestAnimationFrame(retilt);
            }
            if (response.CaseType === 'vivaelite3dcases') {
                tiltAngle = response.CaseAngleDegrees || 0;
                var tiltHingeKey = tiltAngle > 0 ? 'vivaelite3dcases_mirrored' : 'vivaelite3dcases';
                tiltCardScalableEl = posterEl.closest('.cardScalable');
                // frontBox itself must NOT get the tilt when Open Case is
                // active: the image then lives in "rotator" (child of
                // frontBox), whose own absolute matrix the opening animation
                // sets. CSS transforms on a child are relative to the
                // parent's already transformed space, while
                // computeKodiMatrix3dString computes in absolute coordinates,
                // so the two would stack into a distorted duplicate. With
                // Open Case "rotator" gets the rest tilt and frontBox stays
                // untransformed; without it (rotator == null) frontBox does.
                tiltTarget = rotator || frontBox;
                tiltFrontRect = measureDesignRect(tiltTarget);
                tiltHingePct = HINGE_ORIGIN_X_PERCENT[tiltHingeKey] || 0;
                var restCam = designCamera(tiltFrontRect);
                tiltScreenW = restCam.screenW; tiltScreenH = restCam.screenH;
                tiltHingeXPx = tiltFrontRect.left + (tiltHingePct / 100) * tiltFrontRect.width;
                tiltCameraX = restCam.cameraX; tiltCameraY = restCam.cameraY;

                applyTilt(tiltTarget, tiltFrontRect);
                if (tiltCardScalableEl) {
                    ensurePosterOriginStylesInjected(
                        response.CaseType,
                        tiltHingePct,
                        response.LeftPercent, response.WidthVw
                    );
                    tiltCardScalableEl.classList.add(POSTER_ORIGIN_CLASS_PREFIX + response.CaseType);
                    realCard.classList.add(CARD_PERSPECTIVE_CLASS_PREFIX + response.CaseType);
                    // Cache the rect BEFORE the tilt -
                    // measureGeometryFor() further down needs this
                    // undeformed value again, not a later, already
                    // tilted re-measurement.
                    tiltPosterRect = measureDesignRect(tiltCardScalableEl);
                    applyTilt(tiltCardScalableEl, tiltPosterRect);
                }
                if (response.TuneHidePoster && tiltCardScalableEl) {
                    tiltCardScalableEl.style.opacity = '0';
                }
                caseModReleasePoster(); // tilt is on - the poster may appear now, already tilted
                // Settle passes + viewport listeners (see retilt()).
                navTimers.track(setTimeout(queueRetilt, 250));
                navTimers.track(setTimeout(queueRetilt, 1200));
                // No scroll listener - the design frame
                // (measureDesignRect) does not move with the scroll position, so
                // only a real geometry change (resize, card size) needs a re-tilt.
                var onViewportChange = function () {
                    if (myGeneration !== currentGeneration()) {
                        window.removeEventListener('resize', onViewportChange);
                        return;
                    }
                    queueRetilt();
                };
                window.addEventListener('resize', onViewportChange);
                var tiltRo = null;
                if (window.ResizeObserver && realCard) {
                    tiltRo = new ResizeObserver(function () {
                        if (myGeneration !== currentGeneration()) { tiltRo.disconnect(); return; }
                        queueRetilt();
                    });
                    tiltRo.observe(realCard);
                }
                // Released at the end of this generation, not lazily on the next resize.
                onGenerationEnd(function () { window.removeEventListener('resize', onViewportChange); if (tiltRo) { tiltRo.disconnect(); } });

                // 1) The inner case is only needed when Open Case is active
                // (animateOpen) - otherwise nothing is loaded.
                //
                // 2) When Open Case is active it is queued into the same
                // "front-first" loading chain backBox/discBox use
                // (posterDecisionSettled + preload BEFORE appending), not
                // created synchronously with the front, so it never flashes
                // on fast page changes before front+poster are complete.
                if (animateOpen) {
                    // The inside comes from the case type's OWN folder.
                    // Only vivaelite3dcases has a set artwork of its own;
                    // the flat three fall back to back_tvseries (gold).
                    // innerVariant/innerKey are resolved once, further up.
                    var innerImgUrl = case2dTexUrl(innerVariant, innerKey);
                    // posterDecisionSettled is only assigned further down
                    // (near Back/Disc) - here it would still be undefined
                    // despite var hoisting. Hence only defined as a function
                    // here (closing over innerImgUrl); it is called further
                    // down, together with Back/Disc, once posterDecisionSettled
                    // has its value.
                    scheduleInnerCaseDiscPreview = function () {
                    posterDecisionSettled.then(function () {
                        return Core.preloadImage(innerImgUrl);
                    }).then(function () {
                        if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }

                        // Inner case: lies BEHIND the front (z-index lower
                        // than frontBox) and gets the same applyTilt() as
                        // above - otherwise it would drift apart when
                        // case+poster tilt.
                        // Sized through the same sized-class mechanism as the
                        // front box, keyed by its own geometry, so it follows
                        // Jellyfin's `top: 10%` below 62.5em (librarybrowser.scss)
                        // and the mobile/tv layouts like the front box does.
                        var innerCaseType = response.CaseType + '-inner';
                        ensureSizedStylesInjected(innerCaseType, response.InnerCaseTopPercent, response.InnerCaseLeftPercent, response.InnerCaseWidthVw, response.InnerCaseHeightVw);
                        var innerCaseBox = document.createElement('div');
                        innerCaseBox.className = BOX_CLASS + ' ' + BOX_FRONT_CLASS + ' ' + TUNE_PREVIEW_CLASS + ' '
                            + sizedClassName(innerCaseType, response.InnerCaseTopPercent, response.InnerCaseLeftPercent, response.InnerCaseWidthVw, response.InnerCaseHeightVw);
                        innerCaseBox.style.position = 'absolute';
                        // z-index 1: BEHIND both BOX_BACK_CLASS (2) and the
                        // real poster (.card, native z-index 3), and visible,
                        // so it shows through the front texture's transparent
                        // centre wherever nothing native covers it. (Hiding
                        // would need visibility:hidden, not display:none - that
                        // would zero getBoundingClientRect() for the tilt.)
                        innerCaseBox.style.zIndex = '1';
                        innerCaseBox.style.visibility = 'visible';
                        var innerImg = document.createElement('img');
                        innerImg.style.width = '100%';
                        innerImg.style.height = '100%';
                        // The inner case shows the INSIDE VIEW (the
                        // back/interior texture), not the front/cover.
                        innerImg.src = innerImgUrl;
                        case2dMakeCaseClickable(innerCaseBox);
                        innerCaseBox.appendChild(innerImg);
                        detailImageContainer.appendChild(innerCaseBox);
                        applyTilt(innerCaseBox, measureDesignRect(innerCaseBox));

                    }).catch(function (e) {
                        log('Inner case preload failed, skipping', e);
                    });
                    };
                }
            }
            // ═══ FRONT IS NOW VISIBLE - everything below either sets up
            // triggers for LATER interaction, or loads Back/Disc in the
            // background without blocking anything already painted. ═══

            // Starts the ENTIRE synchronized effect (front cover rotation,
            // poster+keyart rotation, padder hide, disc spin) in one JS tick,
            // whichever trigger (delay, click) fires first. A click DURING a
            // running animation is ignored; a fresh click after the door is
            // fully closed again starts a new cycle.
            if (animateOpen) {
                /// THE LID'S STATE, in the same terms as the 3D kind - the
                /// flat case can STAND open, close on a click, and spin its
                /// disc on a click of its own.
                ///
                ///   'shut'     closed, nothing running
                ///   'cycle'    the whole open/spin/close timeline is running
                ///   'opening'  the lid is swinging up and will STAY up
                ///   'open'     it stands open, waiting to be closed
                ///   'closing'  it is swinging back down
                var case2dPhase = 'shut';
                /// THE ARMED TIMER, and it is beatable: a click BEATS a timer
                /// that has not fired - the timer is cancelled and the
                /// automatic is off for this visit, so with both modes on the
                /// manual mode still responds during the delay. A running
                /// MOVEMENT is never interrupted - the rule both kinds share.
                var case2dOpenTimer = null;
                /// The disc's own revolution (Spinning Disc: On click). Its own
                /// flag, because it may not run while the cycle writes the same
                /// rotation.
                var case2dSpinning = false;
                /// The measurement the standing-open lid was opened with. The
                /// close has to use the SAME one: measureGeometryFor bakes
                /// absolute viewport coordinates in, and re-measuring a lid that
                /// is currently up would measure the OPEN pose.
                var case2dHoldGeo = null;
                var case2dHoldAngle = 0;

                // Cubic Bezier equivalent of "quadratic ease-out", as a JS
                // function, since the rotation sets the Kodi matrix per frame
                // instead of a CSS rotateY().
                function bezierEaseY(t) {
                    var y1 = 0.6667, y2 = 1.0, x1 = 0.3333, x2 = 0.6667;
                    var lo = 0, hi = 1, mid;
                    for (var i = 0; i < 30; i++) {
                        mid = (lo + hi) / 2;
                        var mt = 1 - mid;
                        var x = 3*mt*mt*mid*x1 + 3*mt*mid*mid*x2 + mid*mid*mid;
                        if (x < t) { lo = mid; } else { hi = mid; }
                    }
                    var mt2 = 1 - mid;
                    return 3*mt2*mt2*mid*y1 + 3*mt2*mid*mid*y2 + mid*mid*mid;
                }

                // The angle hinge (rest tilt, right) and the Open Case hinge
                // (left) are two different pivots. restAngle stays CONSTANT
                // over the whole animation - only the OPENING PART (0 to
                // toOpenAngle or reverse) is interpolated, and every frame
                // composes both rotations via computeNestedKodiMatrix3dString
                // (the left hinge rotated along with the static tilt). The
                // other three case types (no rest hinge) use the single
                // rotation.
                function runRotationFrame(startTs, durationMs, fromOpenAngle, toOpenAngle, geoRotator, geoPoster) {
                    function frame(now) {
                        if (myGeneration !== currentGeneration()) { return; }
                        var elapsed = now - startTs;
                        var t = Math.min(1, elapsed / durationMs);
                        var eased = bezierEaseY(t);
                        var openAngle = fromOpenAngle + (toOpenAngle - fromOpenAngle) * eased;
                        rotator.style.transform = (geoRotator.restHingeXPx !== undefined)
                            ? computeNestedKodiMatrix3dString(
                                  geoRotator.restAngle, geoRotator.restHingeXPx, openAngle, geoRotator.hingeXPx,
                                  geoRotator.ctrlLeft, geoRotator.ctrlTop,
                                  geoRotator.screenW, geoRotator.screenH, geoRotator.cameraX, geoRotator.cameraY
                              )
                            : computeKodiMatrix3dString(
                                  openAngle, geoRotator.hingeXPx, geoRotator.ctrlLeft, geoRotator.ctrlTop,
                                  geoRotator.screenW, geoRotator.screenH, geoRotator.cameraX, geoRotator.cameraY
                              );
                        if (cardScalableEl) {
                            cardScalableEl.style.transform = (geoPoster.restHingeXPx !== undefined)
                                ? computeNestedKodiMatrix3dString(
                                      geoPoster.restAngle, geoPoster.restHingeXPx, openAngle, geoPoster.hingeXPx,
                                      geoPoster.ctrlLeft, geoPoster.ctrlTop,
                                      geoPoster.screenW, geoPoster.screenH, geoPoster.cameraX, geoPoster.cameraY
                                  )
                                : computeKodiMatrix3dString(
                                      openAngle, geoPoster.hingeXPx, geoPoster.ctrlLeft, geoPoster.ctrlTop,
                                      geoPoster.screenW, geoPoster.screenH, geoPoster.cameraX, geoPoster.cameraY
                                  );
                        }
                        if (t < 1) {
                            activeRotationRafId = requestAnimationFrame(frame);
                        } else if (typeof runRotationFrame.onDone === 'function') {
                            runRotationFrame.onDone();
                        }
                    }
                    activeRotationRafId = requestAnimationFrame(frame);
                }

                // hingeXPx (hingePct% of rect.width) is only correct for the
                // case box itself, since HINGE_ORIGIN_X_PERCENT is a
                // percentage of ITS texture width. The poster (a different,
                // smaller box) must swing around the SAME absolute point, or
                // case and poster drift apart when opening - hingeXPxOverride
                // passes the case box's point in.
                function measureGeometryFor(el, hingeXPxOverride) {
                    // With "Viva Elite 3D Case" rotator/cardScalableEl already
                    // carry the static rest tilt, so a new measurement would
                    // return the tilted position. Reuse the rects cached
                    // before the tilt (tiltFrontRect/tiltPosterRect).
                    var rect = measureDesignRect(el);
                    if (response.CaseType === 'vivaelite3dcases') {
                        if (el === rotator && tiltFrontRect) { rect = tiltFrontRect; }
                        else if (el === cardScalableEl && tiltPosterRect) { rect = tiltPosterRect; }
                    }
                    // There are TWO separate hinges: the RIGID angle hinge
                    // (Case Angle, rest tilt, further up, RIGHT) and the
                    // MOVING Open Case hinge (here). Open Case always opens
                    // from the LEFT like the other three case types (like a
                    // book from the front), whichever side the angle hinge
                    // sits on - so no CaseAngleDegrees sign check here, and
                    // the value is kept separate from HINGE_ORIGIN_X_PERCENT.
                    // Measured by an alpha scan of 1080p.png
                    // (422px wide): columns 0-5 completely transparent,
                    // column 6 antialiasing transition, column 7 real
                    // texture start (609/625 rows already fully opaque).
                    // 7 / 422 * 100 = 1.659%.
                    var hingePct = (response.CaseType === 'vivaelite3dcases')
                        ? 1.659
                        : (HINGE_ORIGIN_X_PERCENT[response.CaseType] || 0);
                    // The camera is bound to the FRONT box (designCamera) for
                    // the poster too - one camera for the whole case, at every window size.
                    var frontRect = (el === rotator) ? rect
                        : (response.CaseType === 'vivaelite3dcases' && tiltFrontRect) ? tiltFrontRect
                        : measureDesignRect(rotator);
                    var cam = designCamera(frontRect);
                    var hingeXPx = (hingeXPxOverride !== undefined)
                        ? hingeXPxOverride
                        : rect.left + (hingePct / 100) * rect.width;
                    return {
                        ctrlLeft: rect.left, ctrlTop: rect.top,
                        ctrlW: rect.width, ctrlH: rect.height,
                        hingeXPx: hingeXPx,
                        screenW: cam.screenW, screenH: cam.screenH,
                        cameraX: cam.cameraX, cameraY: cam.cameraY
                    };
                }

                /// THE WHOLE TIMELINE: open, turn the disc, close itself.
                /// Automatic runs it, and so does a click while "Spinning Disc:
                /// Automatic" is on - the 3D kind decides the same way, and the
                /// two kinds must not disagree about what a click means.
                /// case2dCycleSpins: whether the running sequence turns the
                /// disc. Read by the disc's own click: with nobody else writing
                /// that rotation there is no reason to refuse the gesture.
                var case2dCycleSpins = false;
                var case2dCycleStart = 0;

                function case2dRunCycle(spin) {
                    if (case2dPhase !== 'shut') { return; }
                    if (myGeneration !== currentGeneration()) { return; }
                    case2dCancelOpenTimer();
                    case2dPhase = 'cycle';
                    case2dCycleSpins = !!spin;
                    case2dCycleStart = performance.now();
                    rotator.classList.add(ROTATOR_OPEN_CLASS);
                    if (cardScalableEl) { cardScalableEl.classList.add(ROTATOR_OPEN_CLASS); }
                    if (padderEl) { padderEl.classList.add(PADDER_HIDE_CLASS); }
                    if (discBox && case2dCycleSpins) {
                        discBox.firstChild.classList.add(discSpinClassFor(response.SpinDirection));
                    }
                    // The 3D rotation runs per rAF through the Kodi matrix -
                    // geometry is measured ONCE at the start (angle=0,
                    // unrotated), the camera is the case-bound design camera
                    // (designCamera). Timeline (CASE_CYCLE): open over
                    // OPEN_MS, hold (the last matrix simply stays, no rAF
                    // needed), close from CLOSE_AT over CLOSE_MS.
                    //
                    // SIGN: the case must fold OUTWARDS like a book.
                    // setYRotationMatrix moves the far edge to
                    // LARGER Z at a POSITIVE angle - and our camera sits
                    // at NEGATIVE Z, looking towards +Z. Larger Z
                    // therefore means FURTHER AWAY from the camera, not
                    // closer (recomputed: at +90 degrees z_rel' =
                    // sin(90)*x_rel = +x_rel, while "closer to the
                    // camera" would mean NEGATIVE z_rel). So a negative
                    // angle moves the far edge to SMALLER Z, i.e. towards
                    // the viewer.
                    var angleDeg = -response.OpenAngleDegrees;
                    // With "Viva Elite 3D Case" the opening animation builds
                    // on the permanent Case Angle base tilt. The Open Case
                    // hinge is ALWAYS on the left (see measureGeometryFor),
                    // the side the convention "negative = opens outwards" is
                    // derived for, so no mirroring is needed.
                    //
                    // restAngle (Case Angle, rest tilt
                    // around the RIGHT hinge) stays a CONSTANT that is
                    // composed EVERY frame via real matrix
                    // multiplication with the interpolating opening
                    // rotation (around the LEFT hinge, rotated along
                    // with the static tilt) - see
                    // computeNestedKodiMatrix3dString and
                    // runRotationFrame's own comments. angleDeg (the pure
                    // opening part, WITHOUT restAngle addition)
                    // interpolates from 0 (closed, only the rest tilt
                    // applies) to the full opening angle.
                    var geo = case2dMeasureGeometry();
                    runRotationFrame(performance.now(), CASE2D_OPEN_MS, 0, angleDeg, geo.rotator, geo.poster);
                    activeCloseTimeoutId = setTimeout(function () {
                        activeCloseTimeoutId = null;
                        if (myGeneration !== currentGeneration()) { return; }
                        runRotationFrame(performance.now(), CASE2D_CLOSE_MS, angleDeg, 0, geo.rotator, geo.poster);
                    }, CASE_CYCLE.CLOSE_AT);
                    // THE SEQUENCE ENDS ON ITS OWN CLOCK, not only on the
                    // rotator's animationend (a keyframe rule that animates
                    // nothing): that event depends on the compositor and cannot
                    // be driven by a virtual clock. The listener stays as a
                    // SAFETY NET below (whichever comes first ends it), so the
                    // state cannot get stuck either way.
                    case2dCycleEndTimer = setTimeout(function () {
                        case2dCycleEndTimer = null;
                        if (myGeneration !== currentGeneration()) { return; }
                        if (case2dPhase !== 'cycle') { return; }
                        case2dEndCycle();
                    }, CASE_CYCLE.MS);
                }

                var case2dCycleEndTimer = null;

                function case2dCancelOpenTimer() {
                    if (case2dOpenTimer !== null) {
                        clearTimeout(case2dOpenTimer);
                        case2dOpenTimer = null;
                    }
                }

                /// The two geometries every movement needs, measured in the
                /// CLOSED pose. Shared by the cycle and the standing-open
                /// gesture, so both measure exactly the same way.
                function case2dMeasureGeometry() {
                    var restAngle = 0;
                    if (response.CaseType === 'vivaelite3dcases') {
                        restAngle = response.CaseAngleDegrees || 0;
                    }
                    var geoRotator = measureGeometryFor(rotator);
                    var geoPoster = cardScalableEl
                        ? measureGeometryFor(cardScalableEl, geoRotator.hingeXPx)
                        : geoRotator;
                    if (response.CaseType === 'vivaelite3dcases' && typeof tiltHingeXPx === 'number') {
                        geoRotator.restAngle = restAngle;
                        geoRotator.restHingeXPx = tiltHingeXPx;
                        geoPoster.restAngle = restAngle;
                        geoPoster.restHingeXPx = tiltHingeXPx;
                    }
                    return { rotator: geoRotator, poster: geoPoster };
                }

                /// OPEN, AND STAY OPEN, as on the 3D kind's plain click: the
                /// lid swings up over the same 1000 ms and then
                /// simply stands there. No animation carries that state - the
                /// matrix runRotationFrame last wrote IS the pose, exactly as it
                /// is through the cycle's own middle section, and the padder is
                /// held hidden by a plain property instead of by keyframes.
                function case2dOpenAndHold() {
                    if (case2dPhase !== 'shut') { return; }
                    if (myGeneration !== currentGeneration()) { return; }
                    case2dPhase = 'opening';
                    rotator.classList.add(ROTATOR_HOLD_CLASS);
                    if (cardScalableEl) { cardScalableEl.classList.add(ROTATOR_HOLD_CLASS); }
                    if (padderEl) { padderEl.classList.add(PADDER_HIDE_STATIC_CLASS); }
                    case2dHoldAngle = -response.OpenAngleDegrees;
                    case2dHoldGeo = case2dMeasureGeometry();
                    runRotationFrame(performance.now(), CASE2D_OPEN_MS, 0, case2dHoldAngle,
                                     case2dHoldGeo.rotator, case2dHoldGeo.poster);
                    // The lid counts as open only once it has finished swinging:
                    // a click while it is still on its way is ignored, which is
                    // the ground rule both kinds follow.
                    activeCloseTimeoutId = setTimeout(function () {
                        activeCloseTimeoutId = null;
                        if (myGeneration !== currentGeneration()) { return; }
                        case2dPhase = 'open';
                        log('2D case stands open - a click closes it');
                    }, CASE2D_OPEN_MS);
                }

                /// And closing it again, from that standing-open state. With the
                /// same measurement the opening used: re-measuring now would
                /// measure the OPEN pose, and the lid would swing from a hinge
                /// that is no longer where it was.
                function case2dCloseFromHold() {
                    if (case2dPhase !== 'open' || !case2dHoldGeo) { return; }
                    case2dPhase = 'closing';
                    runRotationFrame(performance.now(), CASE2D_CLOSE_MS, case2dHoldAngle, 0,
                                     case2dHoldGeo.rotator, case2dHoldGeo.poster);
                    activeCloseTimeoutId = setTimeout(function () {
                        activeCloseTimeoutId = null;
                        if (myGeneration !== currentGeneration()) { return; }
                        // The last frame of the swing and this timeout are due in
                        // the same millisecond, and a frame that lands AFTER the
                        // reset writes the matrix back - so the loop is stopped
                        // first, as at the cycle's own end.
                        cancelActiveRotation();
                        case2dRestoreRest();
                        case2dPhase = 'shut';
                        log('2D case shut again');
                    }, CASE2D_CLOSE_MS);
                }

                /// BACK TO THE RESTING POSE. Shared by the cycle's end and the
                /// standing-open close - one copy, so the rest tilt is restored
                /// the same way in both.
                function case2dRestoreRest() {
                    rotator.classList.remove(ROTATOR_OPEN_CLASS, ROTATOR_HOLD_CLASS);
                    // For the other three case types "" (flat, no tilt) is
                    // the rest state - only vivaelite3dcases has a non-zero
                    // rest tilt (Case Angle). tiltAngle/tiltFrontRect/
                    // tiltPosterRect are cached in the outer scope by the
                    // static application further up in check(), so
                    // applyTilt() restores exactly the same rest tilt
                    // instead of snapping back to 0.
                    if (response.CaseType === 'vivaelite3dcases' && typeof applyTilt === 'function' && tiltFrontRect) {
                        applyTilt(rotator, tiltFrontRect);
                    } else {
                        rotator.style.transform = '';
                    }
                    if (cardScalableEl) {
                        cardScalableEl.classList.remove(ROTATOR_OPEN_CLASS, ROTATOR_HOLD_CLASS);
                        if (response.CaseType === 'vivaelite3dcases' && typeof applyTilt === 'function' && tiltPosterRect) {
                            applyTilt(cardScalableEl, tiltPosterRect);
                        } else {
                            cardScalableEl.style.transform = '';
                        }
                    }
                    if (padderEl) {
                        padderEl.classList.remove(PADDER_HIDE_CLASS);
                        padderEl.classList.remove(PADDER_HIDE_STATIC_CLASS);
                    }
                    if (discBox) {
                        discBox.firstChild.classList.remove(DISC_SPIN_CLASS, DISC_SPIN_CLASS_RIGHT);
                    }
                }

                /// The sequence is over: the pose goes back and the case is
                /// shut. Reached from its own timer, and from the rotator's
                /// animationend as a safety net - whichever comes first.
                function case2dEndCycle() {
                    cancelActiveRotation();
                    if (case2dCycleEndTimer !== null) {
                        clearTimeout(case2dCycleEndTimer);
                        case2dCycleEndTimer = null;
                    }
                    case2dRestoreRest();
                    case2dPhase = 'shut';
                    case2dCycleSpins = false;
                }

                rotator.addEventListener('animationend', function (e) {
                    if (e.target !== rotator) { return; }
                    if (case2dPhase !== 'cycle') { return; }
                    case2dEndCycle();
                });

                if (response.OpenAutomatic) {
                    // No per-item memory: every real navigation (including
                    // "back then forward to the same item") auto-opens again,
                    // like a fresh visit and like the Theme Song feature.
                    // Switching browser tabs cannot fire 'viewshow' in
                    // jellyfin-web 10.10.7 (no visibilitychange hook in that
                    // dispatch chain), so it needs no guard.
                    // "Automatic: sequence on visit" - once, after the delay,
                    // with the disc turning if ITS Automatic box is ticked.
                    // The handle is kept so a click can beat the timer.
                    case2dOpenTimer = setTimeout(function () {
                        case2dOpenTimer = null;
                        if (myGeneration !== currentGeneration()) { return; }
                        case2dRunCycle(response.SpinAutomatic);
                    }, response.OpenDelayMs);
                }

                /// WHAT A CLICK ON THE CASE MEANS:
                ///   "On click automatic: sequence on click"
                ///   "On click: manual case open/close"
                /// and above them the one ground rule both case kinds share:
                ///   a running MOVEMENT of the case is never interrupted -
                ///   except that a standing-open case may be closed while the
                ///   disc is still turning, because those two animations are
                ///   independent.
                ///
                /// The disc's own settings have no say over the case: whether a
                /// click runs the whole sequence is decided by the Open case
                /// modes alone.
                function case2dCaseToggle() {
                    if (myGeneration !== currentGeneration()) { return; }
                    if (case2dPhase === 'cycle') { log('a sequence is running - the click is ignored'); return; }
                    if (case2dPhase === 'open') { log('click -> closing'); case2dCloseFromHold(); return; }
                    if (case2dPhase !== 'shut') { log('the lid is moving - the click is ignored'); return; }
                    // A CLICK BEATS A TIMER THAT HAS NOT FIRED. From here on the
                    // case is the viewer's for this visit; the automatic does not
                    // come back and close it under their hand.
                    if (case2dOpenTimer !== null) {
                        log('click during the delay - the automatic stands down');
                        case2dCancelOpenTimer();
                    }
                    if (response.OpenOnClickAutomatic) {
                        log('click -> sequence, ' + CASE_CYCLE.MS + ' ms');
                        case2dRunCycle(response.SpinOnClickAutomatic);
                        return;
                    }
                    if (!response.OpenOnClick) { log('click, but no click mode is on'); return; }
                    log('click -> open ' + response.OpenAngleDegrees + ' and stay open');
                    case2dOpenAndHold();
                }

                /// THE DISC, TURNING ONCE ON ITS OWN CLICK. One revolution
                /// finishes before another can be asked for, and the gesture is
                /// refused only while SOMETHING ELSE writes that rotation - a
                /// sequence that spins it (two writers would fight frame by
                /// frame). A sequence that leaves the disc alone leaves the
                /// click free, so the disc can be turned by hand in the
                /// automatic modes too.
                function case2dSpinOnce() {
                    if (!discBox || !response.SpinOnClick) { return; }
                    if (case2dSpinning) { log('the disc is already turning'); return; }
                    if (case2dPhase === 'cycle' && case2dCycleSpins) {
                        log('the sequence is turning the disc - the click is ignored'); return;
                    }
                    var img = discBox.firstChild;
                    var cls = discSpinOnceClassFor(response.SpinDirection);
                    case2dSpinning = true;
                    log('disc clicked -> one revolution');
                    // ENDS ON ITS OWN CLOCK, with animationend as the safety net -
                    // whichever comes first. On animationend alone the flag could
                    // never come back in a BACKGROUND tab: the browser does not
                    // advance CSS animations there, so the event never arrives and
                    // the disc would refuse every further click for the rest of
                    // this item's life - the same reason the sequence ends on its
                    // own clock.
                    var spinEndTimer = null;
                    var done = function (e) {
                        if (e && e.target !== img) { return; }
                        if (spinEndTimer !== null) { clearTimeout(spinEndTimer); spinEndTimer = null; }
                        img.removeEventListener('animationend', done);
                        img.classList.remove(cls);
                        img.style.transform = '';
                        case2dSpinning = false;
                    };
                    img.addEventListener('animationend', done);
                    spinEndTimer = setTimeout(function () { spinEndTimer = null; done(); }, CASE2D_SPIN_MS);
                    img.classList.add(cls);
                }

                /// DOES THIS CLICK BELONG TO THE DISC? The 3D kind asks its
                /// raycaster ("is the disc the FIRST thing the ray meets"); the
                /// flat one has to ask geometry, and cannot let paint order
                /// decide, because in the flat case the poster's own `.card`
                /// keeps its rectangle even after the lid has swung away - only
                /// `.cardScalable` INSIDE it carries the matrix. The card sits at
                /// z-index 3 over the disc's 2, so it swallows every click over
                /// the disc, open lid or not.
                ///
                /// A disc is a circle in a square box, so the test is the circle
                /// - a corner of that box is case, not disc. And it only counts
                /// while the lid really stands open, which is what the 3D kind
                /// gets for free from the ray meeting the lid first.
                /// Is the lid out of the way? Standing open, yes. Inside a
                /// sequence, only between the end of the opening and the start of
                /// the closing - in 2D geometry cannot answer that, because the
                /// front box's rectangle does not move with the lid, so the
                /// sequence's own clock answers it.
                function case2dLidIsUp() {
                    if (case2dPhase === 'open') { return true; }
                    if (case2dPhase !== 'cycle') { return false; }
                    var ct = performance.now() - case2dCycleStart;
                    return ct >= CASE2D_OPEN_MS && ct < CASE_CYCLE.CLOSE_AT;
                }

                function case2dHitsDisc(x, y) {
                    if (!discBox || !response.SpinOnClick) { return false; }
                    if (!case2dLidIsUp()) { return false; }
                    var r = discBox.getBoundingClientRect();
                    if (!r.width || !r.height) { return false; }
                    var dx = x - (r.left + r.width / 2);
                    var dy = y - (r.top + r.height / 2);
                    var rad = Math.min(r.width, r.height) / 2;
                    return (dx * dx + dy * dy) <= (rad * rad);
                }

                /// The disc takes the click only where it IS the disc; everything
                /// else in the case is the case. One handler for every surface of
                /// it, so the two can never disagree about which was hit.
                function case2dClick(e) {
                    if (case2dHitsDisc(e.clientX, e.clientY)) { case2dSpinOnce(); return; }
                    case2dCaseToggle();
                }

                case2dLid = {
                    spinOnce: case2dSpinOnce,
                    click: case2dClick,
                    isCycling: function () { return case2dPhase === 'cycle'; }
                };
                // The case's outline itself, front side. Its rectangle stays put
                // while only the lid inside it turns - which is exactly what makes
                // it a reliable surface: wherever on the case one clicks, open or
                // shut, the click arrives, and case2dHitsDisc decides whether the
                // disc was meant.
                case2dMakeCaseClickable(frontBox);

                if (case2dTakesClicks) {
                    // The poster surface takes the click too: Case boxes are
                    // pointer-events: none (except the click surfaces), so a
                    // click reaches posterEl underneath. No cursor change. A
                    // click while the animation runs is ignored - the phase
                    // above covers that.
                    posterEl.addEventListener('click', case2dClick);
                    posterEl._artworkplusCaseModClickHandler = case2dClick;
                }
            }

            log('Applied (front)', response.CaseType, response.TextureKey,
                'openCase:', animateOpen, 'angle:', response.OpenAngleDegrees,
                '(automatic:', !!response.OpenAutomatic, 'onClick:', !!response.OpenOnClick,
                'discart:', !!response.HasDiscart + ')', 'for', itemId);

            // ═══ Back and Disc's network requests wait for the
            // poster-arbiter's decision to stop being pending before they
            // START: during that phase a burst of CaseMod image requests
            // would compete for the connection pool with the arbiter's own
            // decision-relevant fetches. Front (already appended) and the
            // Open Case wiring are not delayed. Read-only observation of
            // `coord` - CaseMod never writes into the arbiter.
            //
            // Timeout 8000ms, the same as PRELOAD_TIMEOUT_MS in
            // Custom/Animated/Extra and waitForPosterElement() - this file's
            // limit for one piece of loading work. If the decision never
            // arrives, Back/Disc proceed anyway rather than block forever.
            var posterDecisionSettled = coord && coord.decisionPromise
                ? Promise.race([
                    coord.decisionPromise,
                    new Promise(function (resolve) { setTimeout(resolve, 8000); })
                  ])
                : Promise.resolve();

            // Now that posterDecisionSettled has its value, start the
            // inner-case loading chain DEFINED further up - it joins the
            // same front-first loading phase as Back/Disc below.
            if (typeof scheduleInnerCaseDiscPreview === 'function') {
                scheduleInnerCaseDiscPreview();
            }

            // ═══ Back and Disc load and attach INDEPENDENTLY from here
            // on - fire-and-forget from the main function's own
            // perspective (check() itself does not await either), each
            // with its OWN generation/liveness guard immediately before
            // its own appendChild, the same mechanism Front uses above.
            // Neither can attach to a page that has since been left. ═══

            // Back cover: same geometry class as the front (a real case's
            // front/back share physical outer dimensions, no separate back
            // tuning); z-index 2 puts it BEHIND the real poster card
            // (z-index 3), giving the back/poster/front layering. Always
            // static - never rotates, whatever the Open Case state; only
            // the front cover + poster open.
            //
            // "Viva Elite 3D Case" has no back box at all - no preload
            // request, no DOM element. The other three get theirs.
            if (response.CaseType !== 'vivaelite3dcases') {
            posterDecisionSettled.then(function () {
                return Core.preloadImage(backTextureUrl);
            }).then(function () {
                if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }
                var backBox = buildBox(BOX_BACK_CLASS, frontSizedClass, backTextureUrl, true);
                case2dMakeCaseClickable(backBox);
                detailImageContainer.appendChild(backBox);
                fadeInBox(backBox);
                // A back box on a tilted case needs the same Case Angle tilt
                // as the front, or the flat back shows through where the
                // tilted front is smaller. Uses applyTilt() and its closure
                // variables from the vivaelite3dcases block further up.
                // (Unreachable today, since vivaelite3dcases builds no back
                // box; kept in case the back side is enabled for it.)
                if (response.CaseType === 'vivaelite3dcases' && typeof applyTilt === 'function') {
                    applyTilt(backBox, measureDesignRect(backBox));
                }
                log('Applied (back)', response.CaseType, 'for', itemId);
            }).catch(function (e) {
                log('Back texture preload failed, front only', e);
            });
            }

            // Disc - appended after Back so, tied on z-index, it paints
            // above Back and below the real card. ensureDiscSizedStylesInjected
            // must run before the preload and stays OUTSIDE the
            // decision-wait (pure style injection, no request). Static by
            // default; Spinning Disc adds its own-axis spin. discBox is
            // declared with Front's local state further up
            // (`var discBox = null`) so case2dRunCycle()/case2dEndCycle(),
            // which a delay or click may reach BEFORE this promise
            // resolves, can guard with `if (discBox && ...)`.
            if (animateOpen) {
                ensureDiscSizedStylesInjected(
                    response.CaseType,
                    response.DiscTopPercent, response.DiscLeftPercent, response.DiscSizeVw
                );
                posterDecisionSettled.then(function () {
                    return Core.preloadImage(discImageUrl);
                }).then(function () {
                    if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }
                    discBox = buildBox(BOX_DISC_CLASS, discSizedClassName(response.CaseType, response.DiscTopPercent, response.DiscLeftPercent, response.DiscSizeVw), discImageUrl);
                    tuneHide(discBox, response.TuneHideDisc);
                    detailImageContainer.appendChild(discBox);
                    // The disc gets the same static Case Angle tilt as
                    // front/poster, or it would stay flat while they distort.
                    if (response.CaseType === 'vivaelite3dcases' && typeof applyTilt === 'function') {
                        applyTilt(discBox, measureDesignRect(discBox));
                    }
                    // Rare edge case, explicitly handled: the Open Case
                    // animation may already be running by the time Disc
                    // arrives (a short delay, or an immediate click,
                    // both entirely possible before Disc's own network
                    // round trip finishes) - case2dLid.isCycling() tells us
                    // so, and the spin class is applied
                    // retroactively here so Disc still spins correctly
                    // even though it missed case2dRunCycle()'s
                    // own moment of adding it.
                    if (animateOpen && case2dLid && case2dLid.isCycling() && response.SpinAutomatic) {
                        discBox.firstChild.classList.add(discSpinClassFor(response.SpinDirection));
                    }
                    // The disc box is NOT a click target. Where a
                    // click belongs is decided by geometry (case2dHitsDisc),
                    // because the poster's own card keeps its rectangle over the
                    // disc even when the lid has swung away - a listener here
                    // would never be reached. The disc only has to be
                    // MEASURABLE, and it is.
                    log('Applied (disc)', response.CaseType, 'for', itemId);
                }).then(function () {
                    // The hub, in the same stack as the disc. Its own
                    // preload, and a failure only costs the decal - a case
                    // type whose hub has not been split out yet simply
                    // keeps the disc without a peg instead of showing a
                    // broken image. Sized through the DISC's own generator
                    // with a '-hub' suffix on the key: a hub box is square
                    // in vw exactly like a disc box, so that rule is
                    // already the right one.
                    if (!response.HubSizeVw) { return; }
                    var hubImgUrl = case2dTexUrl(innerVariant, innerKey + '_hub');
                    return Core.preloadImage(hubImgUrl).then(function () {
                        if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }
                        ensureDiscSizedStylesInjected(response.CaseType + '-hub',
                            response.HubTopPercent, response.HubLeftPercent, response.HubSizeVw);
                        var hubBox = buildBox(BOX_HUB_CLASS,
                            discSizedClassName(response.CaseType + '-hub',
                                response.HubTopPercent, response.HubLeftPercent, response.HubSizeVw),
                            hubImgUrl);
                        tuneHide(hubBox, response.TuneHideHub);
                        // BEFORE the disc, not after. The peg does go through
                        // the disc's hole, but the disc
                        // LIES ON the tray: all that shows of the hub is what
                        // the hole leaves open, and the hole is transparent in
                        // the discart anyway. So the order is tray, hub, disc -
                        // same z-index, DOM order decides.
                        if (discBox && discBox.parentNode === detailImageContainer) {
                            detailImageContainer.insertBefore(hubBox, discBox);
                        } else {
                            detailImageContainer.appendChild(hubBox);
                        }
                        if (response.CaseType === 'vivaelite3dcases' && typeof applyTilt === 'function') {
                            applyTilt(hubBox, measureDesignRect(hubBox));
                        }
                        log('Applied (hub)', response.CaseType, 'for', itemId);
                    }).catch(function () { log('no hub decal for this case type - disc stays bare'); });
                }).catch(function (e) {
                    log('Disc image preload failed, skipping disc', e);
                });
            }
        }

        return { check: check, removeExistingOverlay: removeExistingOverlay,
                 posterSizePreapply: posterSizePreapply };
    })();

    // =====================================================================
    // Shared navigation wiring - ONE scheduleDetail/startDetail pair for
    // all modules. Custom/Animated/Extra/CaseMod run in parallel under the
    // same `myGeneration` and the same `coord`, from a single call site.
    // =====================================================================

    async function startDetail(myGeneration) {
        if (!isDetailsPage()) { return; }
        var itemId = getItemIdFromHash();
        if (!itemId) { return; }
        contentReady = true;

        // Poster size, from the value the last answer left behind, BEFORE
        // the card is waited for - so the card is born at its size instead
        // of being corrected into it. The answer that follows either
        // confirms it or changes it once.
        CaseModModule.posterSizePreapply();

        var posterEl = await waitForPosterElement(8000);
        if (!posterEl || myGeneration !== currentGeneration()) { return; }
        var coord = posterArbiterGet(posterEl);

        // All four run in parallel. CaseMod's Front is independent of the
        // arbiter; Back/Disc observe `coord`'s decision state read-only -
        // Case never registers with or participates in the arbiter.
        CustomModule.check(coord, itemId, posterEl, myGeneration);
        AnimatedModule.check(coord, itemId, posterEl, myGeneration);
        ExtraModule.check(coord, itemId, posterEl, myGeneration);
        CaseModModule.check(coord, itemId, posterEl, myGeneration);
    }

    function scheduleDetail() {
        navTimers.clearTimers();
        runGenerationDisposers();
        navGeneration++;
        var myGeneration = navGeneration;
        contentReady = false;
        Core.scheduleNavigationBurst(function () {
            if (contentReady) { return; }
            startDetail(myGeneration);
        }, navTimers.track);
    }

    document.addEventListener('viewshow', function () {
        scheduleDetail();
    });

    // Continuous poll as a backup - see Core's watchForNavigation doc
    // comment. scheduleDetail() is safe to call redundantly (generation
    // guard).
    Core.watchForNavigation(scheduleDetail);

    // One-shot fallback for hard-refresh-already-on-a-details-page.
    setTimeout(function () {
        if (contentReady || !isDetailsPage()) { return; }
        startDetail(navGeneration);
    }, 1200);
})();
