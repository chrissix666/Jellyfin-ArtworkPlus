/*!
 * ArtworkPlus - PostersPlus (unified poster system)
 * ------------------------------------------------------
 * ARCHITECTURE NOTE (read before touching anything below): this file
 * replaces three previously independent scripts
 * (Jellyfin-ArtworkPlus-CustomPoster-v1.js, -AnimatedPoster-v1.js,
 * -ExtraPoster-v1.js) that used to run as three separate IIFEs, each with
 * its own navigation lifecycle, each writing directly to the poster DOM
 * element once it decided it had "won". They coordinated ONLY through a
 * shared arbiter object in Core.js (`posterCoordinatorState`) - the
 * WINNER decision was already centralized there, but the actual VISUAL
 * RENDERING was not: each script still painted `posterEl` itself,
 * subject to its own timing, its own safety-net DOM resets on every
 * `viewshow`, and its own protection observers.
 *
 * A real Jellyfin test found Custom Poster's image visible during an
 * ExtraPoster Delay - a forensic, code-based investigation proved this
 * exact case was NOT a bug (a lower-priority fallback is explicitly
 * allowed to show while Extra's own Delay is running), but it also
 * proved something else concretely: `posterArbiterMaintainExtraBackdrop()`
 * paints onto the exact same DOM element (`.cardImageContainer`) that
 * the "real" poster winner would also paint onto - there is no separate
 * backdrop layer. That single fact is why "logical winner" and
 * "actually rendered source" must be modeled as two DISTINCT, explicit
 * states rather than assumed to always match - see PostersState's own
 * doc comment below for the full model.
 *
 * This file's job: keep Custom/Animated/Extra as three internal SOURCE
 * MODULES (each still owns its own network fetch, its own preload, its
 * own Delay/rotation/crossfade timing where relevant) feeding into ONE
 * shared per-navigation state object and ONE central render function
 * that is the ONLY code allowed to write `posterEl.style.backgroundImage`
 * /`opacity`/`visibility`/pending-classes for a static (non-rotating)
 * result. ExtraPoster's own rotation still animates its own overlay
 * layers directly (that mechanism doesn't touch `posterEl`'s own
 * background-image at all, and was never part of the bug class this
 * consolidation addresses) - but even THAT is now gated by the same
 * shared generation/state object, not by its own independent
 * `runToken`.
 *
 * Requires Jellyfin-ArtworkPlus-Core-v1.js to be loaded first (hard
 * dependency, unchanged). Core.js itself no longer contains ANY
 * poster-arbiter/poster-protection code - that entire subsystem moved
 * here in full. Core.js keeps only genuinely cross-feature
 * infrastructure (verified by checking actual usage across
 * Backdrops-v1.js, CharacterArt-v1.js, RedCarpet-v1.js before moving
 * anything - see this project's own migration notes).
 *
 * DOM facts (verified against the jellyfin-web 10.10.7 source, carried
 * over unchanged from the previous three files):
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
    // Duplicate-load guard: a second execution of this exact file on the
    // same page (e.g. an accidental duplicate entry in JavaScript
    // Injector) must not register a second navigation listener, a second
    // installPosterPendingByDefault() 'viewshow' hook, a second
    // Core.watchForNavigation() poll, or second Custom/Animated/Extra
    // module instances - the FIRST instance already owns the poster
    // arbiter's own coordinator state and must keep running completely
    // undisturbed. See Core.claimSingleton()'s own doc comment for the
    // shared mechanism this uses.
    if (!Core.claimSingleton('PostersPlus')) { return; }
    var log = Core.makeLogger('[PostersPlus]', DEBUG);

    var getItemIdFromHash = Core.getItemIdFromHash;
    var isDetailsPage = Core.isDetailsPage;
    var cssUrl = Core.cssUrl;

    // =====================================================================
    // Poster-element discovery - moved verbatim from Core.js. Confirmed
    // (by grepping actual usage across BackdropsPlus/CharacterArt/RedCarpet)
    // that nothing outside the poster system ever called this - safe to
    // move in full, nothing left behind in Core.
    // =====================================================================

    var pendingPosterElementResolvers = [];
    var posterElementObserver = null;

    function checkPendingPosterElementResolvers() {
        if (pendingPosterElementResolvers.length === 0) { return; }
        var root = Core.findVisibleDetailPage() || document;
        var el = root.querySelector('.detailImageContainer .cardImageContainer');
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
    // synchronously if already present, otherwise via a single shared
    // MutationObserver (not a poll) the first time any source module
    // needs it. Deliberately still page-wide/singleton (not per-
    // navigation) - it has no per-navigation state of its own, it merely
    // reports "an element matching this selector now exists somewhere
    // visible", which is exactly as true regardless of which navigation
    // asked.
    function waitForPosterElement(timeoutMs) {
        return new Promise(function (resolve) {
            var root = Core.findVisibleDetailPage() || document;
            var existing = root.querySelector('.detailImageContainer .cardImageContainer');
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
    // Native-overwrite / native-fade-animation protection - moved verbatim
    // from Core.js. Confirmed poster-exclusive: Backdrops-v1.js has its
    // own, entirely separate, inline MutationObserver-based protection for
    // 'backdropImageFadeIn' - it never called this shared function despite
    // an earlier, since-corrected doc comment implying it did. Nothing
    // else in the project calls either function - safe to move in full.
    // =====================================================================

    /**
     * REAL BUG CLASS: Jellyfin's own native lazy-load pipeline
     * (imageLoader.js's fillImageElement()) doesn't just add/remove a
     * class - it also unconditionally SETS `elem.style.backgroundImage`
     * to Main's own image once ITS OWN preload finishes, via its own
     * independent `preloaderImg.addEventListener('load', ...)` callback.
     * If that native reveal happens to complete AFTER this project's own
     * reveal, it silently overwrites our own correctly-set image back to
     * Main - a genuine race between two entirely independent processes
     * writing to the same style property.
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
     * Same underlying cause as protectBackgroundImageFromNativeOverwrite()
     * above, different mechanism: `imageLoader.js`'s own
     * `fillImageElement()` adds `lazy-image-fadein`/`lazy-image-fadein-fast`
     * to posterEl once ITS OWN preloaded image finishes loading - a
     * running CSS Animation sits above normal author declarations
     * (including inline styles) in the cascade, so for the ~0.1-0.5s this
     * animation plays, it overrides this project's own inline
     * `posterEl.style.opacity` regardless of what value was set. Fix:
     * watch for either class being added, and remove it immediately -
     * this cancels the animation outright.
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
    // Priority model UNCHANGED from the previously separate arbiter:
    // Main=0, CustomPoster=1, AnimatedPoster=2, ExtraPoster/ExtraKeyArt=3.
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
    //                                    is never ambiguous between "Custom
    //                                    actually won" and "Custom is
    //                                    Extra's own allowed fallback
    //                                    during its Delay" - a real,
    //                                    forensically-confirmed ambiguity
    //                                    in the previous architecture,
    //                                    where both cases painted the exact
    //                                    same DOM property on the exact
    //                                    same element with no distinguishing
    //                                    signal at all.
    // }
    // =====================================================================

    var posterCoordinatorState = null;

    function ensureParticipant(coord, priority) {
        if (!coord.participants[priority]) {
            coord.participants[priority] = { registered: false, resolved: false, available: false, url: null };
        }
        return coord.participants[priority];
    }

    function posterArbiterGet(posterEl) {
        if (!posterCoordinatorState || posterCoordinatorState.posterEl !== posterEl) {
            posterArbiterCleanupCoord(posterCoordinatorState);
            posterEl.classList.add('artworkplus-pending');
            posterEl.style.visibility = 'hidden';
            posterCoordinatorState = {
                posterEl: posterEl,
                participants: {
                    1: { registered: false, resolved: false, available: false, url: null },
                    2: { registered: false, resolved: false, available: false, url: null, hasDelay: false },
                    3: { registered: false, resolved: false, available: false, url: null, hasDelay: false }
                },
                decision: { logicalWinner: null, renderedSource: -1, renderReason: null },
                arbiterProtectionObservers: [],
                // Tracks which priority's own logo overlay (if any) is
                // CURRENTLY shown - see posterArbiterSyncLogo()'s own doc
                // comment. Deliberately separate from `decision` itself:
                // logo visibility follows `renderedSource` (what's
                // actually painted on screen right now, including
                // Extra-Delay-fallback), not `logicalWinner` (the final
                // arbiter decision) - the two can legitimately differ for
                // a while.
                activeLogoPriority: null,
                // Extra-specific runtime handles the render path needs to
                // reach into for generation-safety (see section 10/11) -
                // populated/cleared by the Extra module below, read only
                // by posterArbiterCleanupCoord().
                extraRuntime: null
            };
            // SESSION 20: minimal, purely additive signal for CaseMod to
            // observe when the arbiter's decision stops being pending -
            // does NOT change what the decision IS or how it's computed,
            // only lets an outside observer know WHEN it became final.
            // A resolved Promise rather than reusing the existing
            // polling-based waitFor() (see posterArbiterRecomputeDecision
            // below for where this resolves) - avoids importing an
            // unrelated 150ms polling granularity and an 8000ms default
            // timeout chosen for a different call site (Extra's own
            // rotation start) into a new use case that deserves its own
            // timeout decision. No new global variable - lives on coord
            // itself, cleaned up naturally whenever coord itself is
            // replaced (posterArbiterCleanupCoord/posterArbiterGet
            // above already fully replace coord on every navigation).
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
        // SESSION 20: resolves the moment (and ONLY the moment) the
        // decision stops being pending - `_resolveDecision` is itself
        // idempotent-safe (a Promise's own resolve() is a no-op if
        // already settled), so no separate "already resolved" guard is
        // needed here.
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

    // Flips ONLY this priority's own `available` flag - every other
    // priority's own record is completely untouched (the direct fix for
    // the audited "withdraw destroys sibling state" root cause).
    // `resolved` stays true - this priority reached a definitive answer,
    // it just changed from "available" to "not available".
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

    // Session 121 (user: "das Lazy Image lädt bei 0 Grad und rotiert
    // hinterher"): with the Viva Elite 3D Case the tilt of the whole
    // .cardScalable arrives with Case Mod's own /CaseMod answer. Until then
    // Jellyfin has already rendered the card: the blurhash placeholder
    // (<canvas>, a SIBLING of the image container) and the padder icon are
    // visible and FLAT - none of the poster-pending rules covers them -
    // and they jump into the rotation when the tilt lands. Verified in
    // jellyfin-web 10.10.7 (imageLoader.js drawBlurhash inserts the canvas
    // before the element; itemDetails renderDetailImage rebuilds the card
    // after viewshow). Therefore, ONLY when the 3D case with a non-zero
    // angle is in use (remembered from the last /CaseMod answer, so the
    // hold can start at viewshow - before the card even exists), the whole
    // .cardScalable stays visibility:hidden until the tilt is applied; the
    // answer "not applicable / flat case / angle 0" releases at once.
    // Safety net 3 s. Nothing changes for the three flat cases.
    var TILT_HOLD_CLASS = 'artworkplus-case-tilt-pending';
    var TILT_HOLD_STORAGE_KEY = 'ArtworkPlusCase3DTilt';
    var caseTiltHold = { view: null, timer: null, styleInjected: false };
    function caseTiltExpected() {
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
        // Real, confirmed root cause (found via a live-server DIAGNOSTIC
        // dump): Jellyfin's OWN lazy-loader adds a `lazy-hidden` class to
        // posterEl the moment its own IntersectionObserver first sees the
        // element, removed only once ITS OWN preload of Main's own image
        // finishes - which may never happen once we've replaced its image.
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
        // Real bug found via testing: this function is ALSO called
        // directly from ExtraModule's own showNext() (when Extra itself
        // becomes the actual winner, bypassing posterArbiterRender()
        // entirely) - not just from within posterArbiterRenderImpl()'s
        // own "winner is 1 or 2" branch. posterArbiterRender()'s own
        // wrapper alone therefore isn't a complete hook for every place
        // `renderedSource` can change - called here directly too, since
        // this function is the one truly universal centralization point
        // (see its own doc comment above). Safe to call twice for the
        // SAME transition (once from here, once from
        // posterArbiterRender()'s own wrapper) - posterArbiterSyncLogo()
        // is idempotent, it returns immediately if nothing changed.
        posterArbiterSyncLogo(coord);
    }

    /**
     * THE central render path. Reacts to a (re)computed logical winner by
     * deciding renderedSource + renderReason EXPLICITLY, separate from
     * logicalWinner itself - this is the direct fix for the forensically
     * confirmed ambiguity: `renderedSource===1` (Custom) can legitimately
     * mean either "Custom actually won" (renderReason='Winner') or
     * "Custom is Extra's own allowed fallback while its Delay counts
     * down" (renderReason='ExtraDelayFallback') - both paint the exact
     * same DOM property on the exact same element, so the reason has to
     * be tracked explicitly rather than re-derived from what's on screen.
     */
    /**
     * Real bug found via user report: the two Keyart/Extrakeyart logo
     * overlays used to be triggered by each module's own check() reading
     * `posterArbiterIsWinner()` - the FINAL arbiter decision - directly.
     * That's the wrong condition: Custom's own image can be legitimately
     * VISIBLE on screen as Extra's own Delay-fallback backdrop
     * (`renderedSource===1, renderReason='ExtraDelayFallback'`) while
     * `logicalWinner` is ALREADY 3 (Extra) - meaning Custom's own logo
     * never appeared even while Custom's own poster was genuinely the
     * thing on screen, and once Extra actually took over, nothing ever
     * told Custom's own logo (if it HAD appeared) to disappear either.
     * Logo visibility must follow `renderedSource` (what's ACTUALLY
     * painted right now) exactly the same way the poster image itself
     * does - not the eventual final decision. Called from
     * posterArbiterRender()'s own wrapper below, guaranteed to run after
     * EVERY render pass regardless of which internal branch executed,
     * since `renderedSource` can change from several different places
     * (posterArbiterMarkVisible, posterArbiterMaintainExtraBackdrop's own
     * direct assignment) and a single hook needs to catch all of them.
     */
    function posterArbiterSyncLogo(coord) {
        var renderedSource = coord.decision.renderedSource;
        var desired = null;
        if (renderedSource === 1 || renderedSource === 3) {
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
     * Shared by both Keyart's and Extrakeyart's own logo overlay -
     * genuinely the same operation for both (draw Jellyfin's own native
     * Logo image, centered, pinned via CSS percentages of the poster
     * box), differing only in which CSS class/config values are used,
     * both already resolved by the caller. Appended to `parent` (the
     * SAME element the poster's own visible background/layers live on -
     * NOT necessarily `posterEl` itself, which Extra's own rendering can
     * leave at opacity:0 - see the milestone on why the previous,
     * per-module version of this function got this wrong for
     * Extrakeyart specifically).
     */
    async function applySharedLogoOverlay(coord, priority, parent, posterEl, itemId, className, verticalPercent, sizePercent) {
        try {
            var apiClient = window.ApiClient;
            if (!apiClient) { return; }
            var userId = apiClient.getCurrentUserId ? apiClient.getCurrentUserId() : null;
            var item = await apiClient.getItem(userId, itemId);
            // Re-validated AFTER the async gap, not just at entry: the
            // coord could have been torn down (navigation) or this
            // priority could have stopped being the desired logo source
            // (renderedSource changed again) while this fetch was in
            // flight.
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
            // Deliberately silent - a failed logo overlay must never be
            // mistaken for a failed poster render. Nothing else here
            // depends on this succeeding.
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
            // The real winner has already visually taken over - nothing
            // left to decide, but Extra's own backdrop bookkeeping still
            // needs to stay live in case a still-loading lower source's
            // url becomes known afterward (harmless once Extra's own
            // opaque layer covers it either way).
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

        // winner is 1 or 2 - safety net for the case where this source's
        // own module has ALREADY finished running by the time it becomes
        // the winner (e.g. Extra withdraws well after Custom/Animated's
        // own module already decided "not the winner" and exited).
        var participant = coord.participants[winner];
        if (participant && participant.url) {
            var cssUrlValue = cssUrl(participant.url);
            coord.posterEl.style.backgroundImage = cssUrlValue;
            posterArbiterMarkVisible(coord, winner, 'Winner');
            posterArbiterApplyProtections(coord, cssUrlValue);
        }
        // else: this priority IS the winner but hasn't finished its own
        // preload yet - its own still-running module will paint and
        // reveal itself once ready (see posterArbiterIsWinner() below).
    }

    /**
     * Extra is the logical winner but may not have visually taken over
     * yet (its own Delay is still counting down, or its own crossfade
     * simply hasn't reached its first frame yet). Shows the best already-
     * known lower-priority url as a passive, explicitly-labeled fallback
     * - renderReason='ExtraDelayFallback', NEVER 'Winner', so nothing
     * downstream can mistake this for Custom/Animated having actually won.
     * If nothing lower is available and Extra reported a Delay, shows
     * Main (renderReason='NoneAvailable') as the placeholder instead -
     * matches the pre-existing, explicitly required Delay semantics
     * ("ein zulässiger niedrigerer Fallback darf sichtbar sein"). With no
     * Delay and nothing lower available, posterEl stays hidden - the
     * original, already-solved "no Main flash without a Delay" behavior.
     */
    function posterArbiterMaintainExtraBackdrop(coord) {
        // Real, reproduced "show before" bug fix: this check used to gate
        // ONLY the Main-fallback branch further below, not this
        // function's own primary "show the best available lower
        // priority" branch - so Custom/Animated could flash onto screen
        // while Extra was merely in its own ordinary, always-present,
        // short preparation period (fetching its full list, preloading
        // its first image - the same kind of wait every priority goes
        // through before it can render itself) even with NO Delay
        // configured at all. `hasDelay` means exactly one thing: Extra
        // itself reported a DELIBERATE, admin-configured wait during
        // which showing something else is the explicitly desired
        // behavior - it does NOT mean "Extra hasn't rendered yet for any
        // reason". Without a genuine Delay, nothing here may touch
        // posterEl at all - it stays exactly as hidden as
        // posterArbiterGet() already left it, and Extra's own reveal
        // (posterArbiterMarkVisible(coord, 3, 'Winner') inside its own
        // crossfade) is the only thing ever allowed to change that,
        // mirroring exactly how Custom/Animated themselves stay hidden
        // during their own preload wait when THEY are the winner.
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
        // Nothing lower available either - Delay is genuinely active
        // (already confirmed above), so Main serves as the placeholder
        // instead, exactly as before.
        if (coord.decision.renderedSource === -1) {
            posterArbiterMarkVisible(coord, 0, 'NoneAvailable');
        }
    }

    // Real lifecycle gap this must never reintroduce: every 'viewshow'
    // must disconnect the OUTGOING coord's own observers (and stop its
    // own Extra Delay timer/rotation - see the Extra module below) BEFORE
    // the reference is dropped, or a stale observer/timer from navigation
    // A can still act on navigation B's own state once Jellyfin's view
    // cache reuses the same posterEl. Deliberately pure cleanup - no
    // winner/priority/fallback decision of any kind belongs here.
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
    // Shared navigation generation - Generation Safety (one counter for
    // the WHOLE poster system, replacing three separate, independent
    // tokens the three old scripts each maintained on their own). Every
    // async continuation below (fetch, preload, Delay timer, rotation
    // timer, crossfade rAF) checks its own captured generation against
    // this shared counter before touching the DOM or `coord` - a
    // continuation from navigation A can structurally never affect
    // navigation B's own state, because B's own scheduleDetail() call
    // increments this ONE counter before B's own async work starts.
    // =====================================================================

    var navGeneration = 0;
    var navTimers = Core.createTimerTracker();
    var contentReady = false;

    function currentGeneration() { return navGeneration; }

    // Previously an identical copy in all three source files - one shared
    // implementation now. Polling-based (not event-driven) is unchanged
    // from before; only the duplication is gone.
    function waitFor(fn, timeoutMs) {
        return new Promise(function (resolve) {
            var t0 = Date.now();
            (function poll() {
                var el = fn();
                if (el) { return resolve(el); }
                if (Date.now() - t0 > (timeoutMs || 8000)) { return resolve(null); }
                navTimers.track(setTimeout(poll, 150));
            })();
        });
    }


    /**
     * Real lifecycle gap this collapses: each of the three previous
     * scripts had its OWN 'viewshow' listener doing its OWN unconditional
     * `document.querySelectorAll('.detailImageContainer .cardImageContainer')
     * .forEach(el => el.style.visibility = '')`-style safety-net reset,
     * three times over, all document-wide, all independent of the
     * arbiter's own knowledge of the current generation. Collapsed into
     * ONE reset here, tied to the ONE shared generation counter -
     * functionally equivalent (still a document-wide safety net for a
     * genuinely abandoned previous run) but no longer triplicated, and
     * now happens in the same place that also bumps navGeneration, so
     * there is no window where three independent resets could observe
     * three different notions of "the current navigation".
     */
    function installPosterPendingByDefault() {
        document.addEventListener('viewshow', function (e) {
            var view = e && e.target;
            if (!view || !view.classList || !view.classList.contains('itemDetailPage')) { return; }
            view.classList.add('artworkplus-poster-pending');
            if (caseTiltExpected()) { caseTiltHoldView(view); } // Session 121: whole card hidden until the 3D tilt is on
            // Cleanup MUST happen before the reference is dropped - the
            // outgoing coord (and its own observers/Extra runtime) is
            // still reachable here, one line before it stops being so.
            posterArbiterCleanupCoord(posterCoordinatorState);
            posterCoordinatorState = null;
            // Safety net for a genuinely abandoned previous run (see this
            // function's own doc comment above) - reset AFTER cleanup,
            // not instead of it: cleanup above stops old timers/observers
            // at their source; this only repairs whatever raw inline
            // style a stale run may have left behind on the DOM itself.
            document.querySelectorAll('.detailImageContainer .cardImageContainer').forEach(function (el) {
                el.style.visibility = '';
                el.style.opacity = '';
            });
            // Real bug found via an explicit multi-hop navigation test
            // (A=Custom -> B=Extra -> C=Animated, same posterEl reused):
            // ExtraModule's own createOverlayLayers() only ever removes a
            // PREVIOUS run's stale `.extraposter-layer` elements as a side
            // effect of ITSELF being called again - which only happens if
            // Extra is applicable AGAIN on some later navigation. If a
            // SUBSEQUENT navigation simply doesn't have Extra applicable
            // at all (not a withdrawal/rotation-end Extra itself would
            // clean up after, just never running again), its own old,
            // fully-opaque layer element was confirmed left behind in the
            // DOM - `position:absolute; inset:0` - visually covering
            // whatever the new navigation's own winner correctly painted
            // onto posterEl underneath, even though the underlying
            // backgroundImage data was itself completely correct. Same
            // "abandoned previous run" category as the two resets above,
            // added here for the same reason and at the same single
            // shared checkpoint rather than duplicated per-module.
            document.querySelectorAll('.detailImageContainer .extraposter-layer').forEach(function (el) {
                el.remove();
            });
            // Real bug found via user report (Keyart's own logo appearing
            // to "stop working" whenever Extrakeyart's own logo overlay
            // was also enabled) - same underlying category as the
            // extraposter-layer fix immediately above, just for the two
            // logo overlays instead: BOTH CustomModule's own
            // applyLogoOverlay (`.artworkplus-keyart-logo`) and
            // ExtraModule's own (`.artworkplus-extrakeyart-logo`) only
            // ever clean up a PREVIOUS run's own stale logo element as a
            // side effect of that SAME module's own check() reaching far
            // enough to do so again - which never happens if a
            // SUBSEQUENT navigation's item simply isn't applicable for
            // that module at all (an early return happens well before
            // either module's own stale-logo cleanup code). The old,
            // fully-opaque, absolutely-positioned logo div was then left
            // behind - directly covering whichever module's own poster
            // (and, if it also has one, its own logo) the NEW navigation
            // actually resolved to underneath, with the underlying
            // decision itself always having been completely correct.
            // Same shared checkpoint, same reasoning as the fix above.
            document.querySelectorAll('.detailImageContainer .artworkplus-keyart-logo, .detailImageContainer .artworkplus-extrakeyart-logo, .detailImageContainer .artworkplus-casemod-overlay').forEach(function (el) {
                el.remove();
            });
            // Restored view (Back button): Jellyfin's own placeholder
            // (blurhash canvas / .cardPadder) may have already been
            // hidden by an earlier visit's own native fade-in - bring it
            // back exactly the way Jellyfin's own imageLoader.
            // emptyImageElement() does, so there is no empty box between
            // now and our own next decision.
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
        });
    }
    installPosterPendingByDefault();

    // =====================================================================
    // LIBRARY TILE SWAPPER (Session 122) - shared by Custom and Animated
    // Mirrors Jellyfin's own tile behaviour (cardBuilder.js +
    // imageLoader.js): Jellyfin knows for the WHOLE page which tile has a
    // poster (the Items answer carries ImageTags, the URL sits in
    // data-src) and only loads the image at 50% viewport margin. Each
    // instance does the same for its files: every tile is asked in one
    // batch as soon as it is in the DOM, and an applicable tile gets the
    // instance's URL written into its data-src so Jellyfin's own lazy
    // loader fetches the file itself (blurhash -> ours, its own fade-in).
    // A tile Jellyfin has already filled (the first screen) is overridden
    // after a preload, and a per-tile guard re-applies the URL if
    // Jellyfin's in-flight poster lands after ours (race). Jellyfin's
    // emptyImageElement() keeps our URL: it copies the current
    // background-image back into data-src when a tile scrolls away.
    //
    // Tile ownership: several instances may answer for the same tile
    // (an item with both a Custom Poster and an Animated Poster). The
    // HIGHEST priority number owns the tile - the same order as the
    // detail-page arbiter (posterArbiterRecomputeDecision walks 3 -> 1:
    // Extra 3 > Animated 2 > Custom 1). A lower-ranked instance never
    // touches an owned tile; a higher-ranked instance arriving later
    // takes it over, and the previous guard steps down the moment it
    // sees it is no longer the owner. The full chain
    // (fallback on a load error, Extra's overlay, flash prevention) is
    // a later step - this is only the minimum that keeps two guards from
    // fighting over one tile.
    // =====================================================================

    var libraryTileOwners = new WeakMap(); // .cardImageContainer -> { priority, url }

    function createLibraryTileSwapper(options) {
        var FETCH_DEBOUNCE_MS = 150;
        var PRELOAD_TIMEOUT_MS = 8000;
        var BATCH_CHUNK = 200; // the servers cap one batch at 200 ids
        var priority = options.priority;
        var log = options.log;

        var resultCache = {};
        var pendingIds = [];
        var fetchTimer = null;
        var appliedElements = new WeakSet();
        var observedElements = new WeakSet();

        function findCardImageContainer(cardEl) {
            return cardEl.querySelector('.cardImageContainer') || cardEl.querySelector('.cardContent');
        }

        function isOurUrl(value, url) {
            return typeof value === 'string' && value.indexOf(url) !== -1;
        }

        function ownsTile(imageContainer, url) {
            var owner = libraryTileOwners.get(imageContainer);
            return !!owner && owner.priority === priority && owner.url === url;
        }

        // Jellyfin's imageLoader writes background-image after ITS preload
        // finished - if that lands after our override, put ours back.
        // Steps down as soon as a higher-ranked instance owns the tile.
        function installTileGuard(imageContainer, url) {
            var guard = new MutationObserver(function () {
                if (!ownsTile(imageContainer, url)) { guard.disconnect(); return; }
                var bg = imageContainer.style.backgroundImage;
                if (!bg || bg === 'none' || isOurUrl(bg, url)) { return; }
                imageContainer.style.backgroundImage = cssUrl(url);
                log('re-applied to tile after Jellyfin\'s own poster landed');
            });
            guard.observe(imageContainer, { attributes: true, attributeFilter: ['style'] });
        }

        function applyToCard(cardEl, itemId, result) {
            if (appliedElements.has(cardEl)) { return; }
            if (!result || !result.IsApplicable) { return; }
            var imageContainer = findCardImageContainer(cardEl);
            if (!imageContainer) { return; }
            appliedElements.add(cardEl);

            var owner = libraryTileOwners.get(imageContainer);
            if (owner && owner.priority > priority) {
                log('tile', itemId, 'already owned by priority', owner.priority, '- not touched');
                return;
            }
            var url = options.imageUrl(itemId, result);
            libraryTileOwners.set(imageContainer, { priority: priority, url: url });
            var currentBg = imageContainer.style.backgroundImage;
            var alreadyFilled = !!currentBg && currentBg !== 'none';

            // Not loaded yet (or emptied by Jellyfin after scrolling away):
            // point data-src at our file, Jellyfin loads it at its own 50%
            // margin with its own fade-in. The guard covers an in-flight
            // vanilla load that still lands afterwards.
            if (imageContainer.hasAttribute('data-src')) {
                imageContainer.setAttribute('data-src', url);
            }
            installTileGuard(imageContainer, url);
            if (!alreadyFilled) {
                log('queued for tile via data-src', itemId, '(resolved:', result.ResolvedType + ')');
                return;
            }

            // Jellyfin (or a lower-ranked instance) already shows an image:
            // override once our file is decoded.
            Core.preloadImage(url, { timeoutMs: PRELOAD_TIMEOUT_MS }).then(function () {
                if (!document.body.contains(cardEl) || !ownsTile(imageContainer, url)) { return; }
                imageContainer.style.backgroundImage = cssUrl(url);
                log('set for tile', itemId, '(resolved:', result.ResolvedType + ')');
            }).catch(function (e) {
                log('skipped for tile (load error)', itemId, e);
            });
        }

        function scheduleFetch() {
            if (fetchTimer) { return; }
            fetchTimer = setTimeout(function () { fetchTimer = null; flushFetch(); }, FETCH_DEBOUNCE_MS);
        }

        function flushFetch() {
            var ids = pendingIds;
            pendingIds = [];
            if (ids.length === 0) { return; }
            var idsToFetch = ids.filter(function (id) { return !(id in resultCache); });
            idsToFetch = idsToFetch.filter(function (id, idx) { return idsToFetch.indexOf(id) === idx; });

            function applyAll() {
                ids.forEach(function (id) {
                    var result = resultCache[id];
                    if (!result) { return; }
                    document.querySelectorAll('.card[data-id="' + id + '"]').forEach(function (cardEl) { applyToCard(cardEl, id, result); });
                });
            }

            if (idsToFetch.length === 0) { applyAll(); return; }

            var chunks = [];
            for (var i = 0; i < idsToFetch.length; i += BATCH_CHUNK) { chunks.push(idsToFetch.slice(i, i + BATCH_CHUNK)); }
            Promise.all(chunks.map(function (chunk) {
                return fetch(options.batchUrl(chunk))
                    .then(function (r) { return r.json(); })
                    .then(function (batchResponse) {
                        var items = batchResponse.Items || {};
                        // Keys normalised to the tile's data-id form (32 hex, no
                        // dashes): older builds of the server keyed the map with
                        // dashed Guids, which never matched a tile (Session 122).
                        Object.keys(items).forEach(function (id) { resultCache[id.replace(/-/g, '')] = items[id]; });
                        chunk.forEach(function (id) { if (!(id in resultCache)) { resultCache[id] = null; } });
                    });
            })).then(applyAll).catch(function (e) { log('Error during the library batch request', e); });
        }

        // Every tile on the page is asked as soon as it exists - like
        // Jellyfin, which knows all its posters from the Items answer.
        function observeLibraryCards() {
            document.querySelectorAll('.card[data-type="Movie"], .card[data-type="Series"], .card[data-type="BoxSet"]').forEach(function (card) {
                if (observedElements.has(card)) { return; }
                observedElements.add(card);
                var itemId = card.dataset.id;
                if (!itemId) { return; }
                if (itemId in resultCache) {
                    var result = resultCache[itemId];
                    if (result) { applyToCard(card, itemId, result); }
                } else if (pendingIds.indexOf(itemId) === -1) {
                    pendingIds.push(itemId);
                    scheduleFetch();
                }
            });
        }

        var mutationObserver = new MutationObserver(function () { observeLibraryCards(); });
        mutationObserver.observe(document.body, { childList: true, subtree: true });

        return { observeLibraryCards: observeLibraryCards };
    }

    // =====================================================================
    // CUSTOM MODULE (Postercase/Keyart) - priority 1
    // Own fetch, own preload, own optional Keyart logo overlay. Reports
    // exclusively into the shared controller (register/reserve/decline/
    // setFallbackUrl) - does NOT decide for itself whether it is allowed
    // to paint; the central render path (posterArbiterRender) does that,
    // reading posterArbiterIsWinner(coord, 1) only to know whether ITS
    // OWN extra step (the Keyart logo overlay, which the central render
    // path has no reason to know about) should run.
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
            var resultPromise = fetch('/CustomPoster/' + encodeURIComponent(itemId) + '?scope=detail', { cache: 'no-store' })
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
            // Set once here, as soon as it's known - posterArbiterSyncLogo()
            // (called from the shared render path, see its own doc
            // comment) decides WHEN this actually gets shown, based on
            // `renderedSource`, not on this module's own timing.
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
                // Without this, if Custom is the ONLY registered
                // participant (Animated/Extra disabled or not applicable
                // either), Main would never be revealed - this priority's
                // own record would stay stuck at available=true forever.
                posterArbiterWithdrawReservation(coord, 1);
                return;
            }
            if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }

            // Reported unconditionally, regardless of whether this source
            // ends up the actual winner right now - a higher priority
            // that later withdraws (or is used as ExtraPoster's own
            // backdrop while its own Delay counts down) needs to be able
            // to find this url too.
            posterArbiterSetFallbackUrl(coord, 1, url);
        }

        // Library view (Session 122): the shared tile swapper, priority 1
        // (the lowest - Animated and Extra outrank it, as on the detail
        // page). Postercase vs. Keyart is the server's own "auto"
        // resolution (CustomPosterPriority), same as the detail page. The
        // Keyart logo overlay of the detail page is deliberately not drawn
        // on tiles.
        var library = createLibraryTileSwapper({
            priority: 1,
            log: Core.makeLogger('[PostersPlus/Custom/Library]', DEBUG),
            batchUrl: function (ids) { return '/CustomPoster/batch?ids=' + ids.map(encodeURIComponent).join(',') + '&scope=library'; },
            imageUrl: function (itemId, result) {
                return '/CustomPoster/' + encodeURIComponent(itemId) + '/image?type=' + encodeURIComponent(result.ResolvedType) + '&scope=library' + '&v=' + encodeURIComponent(result.Version);
            }
        });

        return { check: check, priority: 1, observeLibraryCards: library.observeLibraryCards };
    })();

    // =====================================================================
    // ANIMATED MODULE - priority 2
    // Detail-page check() reports into the shared controller, same shape
    // as CustomModule. The library view is an instance of the shared
    // tile swapper above (Session 122) - independent of the arbiter.
    // =====================================================================

    var AnimatedModule = (function () {
        var PRELOAD_TIMEOUT_MS = 8000;
        var log = Core.makeLogger('[PostersPlus/Animated]', DEBUG);

        function preloadImage(url) {
            return Core.preloadImage(url, { timeoutMs: PRELOAD_TIMEOUT_MS });
        }

        // Phase 2 (Session 92): no explicit "type" in the initial fetch -
        // relies on the server's own "auto" default (AnimatedPoster vs.
        // Animated Keyart, resolved by AnimatedPosterPriority), exact
        // same pattern as CustomModule's own check() above. The image
        // URL below then uses result.ResolvedType, same reasoning as
        // CustomModule's own image URL just above this module.
        async function check(coord, itemId, posterEl, myGeneration) {
            var resultPromise = fetch('/AnimatedPoster/' + encodeURIComponent(itemId) + '?scope=detail', { cache: 'no-store' })
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

        // Library view (Session 122): the shared tile swapper, priority 2.
        var library = createLibraryTileSwapper({
            priority: 2,
            log: Core.makeLogger('[PostersPlus/Animated/Library]', DEBUG),
            batchUrl: function (ids) { return '/AnimatedPoster/batch?ids=' + ids.map(encodeURIComponent).join(',') + '&scope=library'; },
            imageUrl: function (itemId, result) {
                return '/AnimatedPoster/' + encodeURIComponent(itemId) + '/image?type=' + encodeURIComponent(result.ResolvedType) + '&scope=library' + '&v=' + encodeURIComponent(result.Version);
            }
        });

        return { check: check, priority: 2, observeLibraryCards: library.observeLibraryCards };
    })();

    // =====================================================================
    // EXTRA MODULE (ExtraPoster/ExtraKeyArt) - priority 3
    // Owns its own Delay wait, rotation, and crossfade - these still
    // animate its own overlay layers directly (a mechanism that never
    // touches posterEl's own background-image, and was never part of the
    // bug class this consolidation addresses). What changed: generation-
    // safety now uses the ONE shared navGeneration counter instead of its
    // own independent runToken, and the end-of-rotation/withdrawal calls
    // go through the exact same posterArbiterWithdrawReservation() the
    // other two modules use - no separate fallback-search of its own.
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
            // Same reasoning as CustomModule's own stale-logo removal
            // (view-cache reuse showing a PREVIOUS navigation's
            // Extrakeyart-with-logo, before this navigation's own
            // applyLogoOverlay call - if any - gets a chance to run) -
            // this function already runs once per navigation right
            // before rotation starts, so it's the natural shared place
            // for this cleanup too, rather than a separate pass.
            // `parent` is posterEl's OWN parent (see this function's own
            // call site), but querySelector searches its entire subtree
            // regardless - which includes posterEl's own children, where
            // applyLogoOverlay() actually appends the logo div.
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
            var quickCheckPromise = fetch('/Extraposter/' + encodeURIComponent(itemId) + '/quickcheck', { cache: 'no-store' })
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
            // Real, user-reported bug fix this replaced (kept for the
            // record): posterEl used to stay stuck at visibility:hidden
            // for this module's ENTIRE Delay period whenever Animated
            // wasn't also active to reveal it itself, because nothing
            // ever called a reveal for plain Main during that wait. Now
            // handled automatically and centrally by posterArbiterRender()
            // (via posterArbiterMaintainExtraBackdrop()) every time the
            // decision is recomputed - reading `hasDelay` directly off
            // this priority's own participant record - so no explicit
            // call is needed here. With no Delay, that same central logic
            // correctly does nothing extra either (Main must never flash
            // visible in between).

            var listResponse;
            try {
                listResponse = await fetch('/Extraposter/' + encodeURIComponent(itemId) + '?type=' + encodeURIComponent(quickCheck.ResolvedType), { cache: 'no-store' }).then(function (r) { return r.json(); });
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

            // Set once here, as soon as it's known - posterArbiterSyncLogo()
            // (called from the shared render path, see its own doc
            // comment) decides WHEN this actually gets shown, based on
            // `renderedSource`, not on this module's own timing.
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
                return '/Extraposter/' + encodeURIComponent(itemId) + '/image/' + encodeURIComponent(entry.FileName)
                    + '?type=' + encodeURIComponent(listResponse.ResolvedType) + '&v=' + encodeURIComponent(entry.Version);
            });

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

            // Registered on coord so a generation change can proactively
            // stop this rotation's own recurring timer, in addition to
            // the myGeneration checks already guarding every continuation
            // below (belt and suspenders - see posterArbiterCleanupCoord's
            // own doc comment on why pure cleanup never decides anything).
            coord.extraRuntime = { cleanup: function () { stopped = true; } };

            async function showNext() {
                if (stopped || myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }

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
                try {
                    await preloadImage(url);
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
                if (stopped || myGeneration !== currentGeneration()) { return; }
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
                if (prevLayer) {
                    prevLayer.style.zIndex = '1';
                    prevLayer.style.opacity = '0';
                }

                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        if (stopped || myGeneration !== currentGeneration()) { return; }
                        if (myFadeGeneration !== fadeInGeneration) { return; }
                        if (isFirstImageOfRotation) {
                            // Forces the pending-class removal (an
                            // opacity:0->1 computed-style change) to apply
                            // with NO transition, so posterEl always lands
                            // on a stable, fully-opaque opacity:1 in a
                            // single unanimated step before the REAL,
                            // intended fade-to-0 below ever starts -
                            // otherwise Jellyfin's native image shows
                            // through for the transition's own duration
                            // whenever nothing lower has resolved yet.
                            posterEl.style.transition = 'none';
                            posterArbiterMarkVisible(coord, 3, 'Winner');
                            void posterEl.offsetHeight;
                            posterEl.style.transition = 'opacity ' + listResponse.FadeTimeMs + 'ms ease';
                            arbiterNotified = true;
                        }
                        nextLayer.style.opacity = '1';
                        if (prevLayer === null) {
                            // Crossfade the original itself out in the
                            // exact same frame the first layer fades in.
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
            // Waiting here for the decision to no longer be pending means
            // any applicable lower priority has already reported its own
            // url by the time showNext() below runs - and every reported
            // url is immediately reflected in this priority's own passive
            // backdrop via posterArbiterRender(), so posterEl's own
            // background-image is already correct before the crossfade's
            // very first frame, never mid-flight.
            await waitFor(function () { return posterArbiterIsDecisionPending(coord) ? null : true; }, 5000);
            if (stopped || myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }
            showNext();
        }

        // -----------------------------------------------------------------
        // Library view (Session 122) - arbiter-independent, priority 3 in
        // the tile ownership (libraryTileOwners: Extra outranks Animated
        // and Custom, as on the detail page - their image, or Jellyfin's
        // own poster, is what shows underneath during Extra's Delay).
        //
        // Knowledge like Jellyfin: every tile of the page is asked in one
        // batch as soon as it is in the DOM. Activation like Jellyfin's
        // lazy loader: a tile within 50% viewport margin gets its overlay
        // layers and preloads its first image; on leaving that margin the
        // layers are removed (a re-entry restarts Delay and rotation, as
        // a detail page re-entry does). One synchronized clock per tile
        // type keeps all visible tiles changing together.
        //
        // Layers live INSIDE .cardImageContainer as its first children,
        // without z-index (card.scss/cardBuilder.js, verified): Jellyfin's
        // indicators and progress bar (z-index 1, later children) and the
        // hover menu (.cardOverlayContainer, a later sibling) keep painting
        // above them, the blurhash canvas (an earlier sibling) below.
        // -----------------------------------------------------------------

        var FETCH_DEBOUNCE_MS = 150;
        var BATCH_CHUNK = 200;
        var libLog = Core.makeLogger('[PostersPlus/Extra/Library]', DEBUG);
        var LIB_PRIORITY = 3;

        function libPreloadImage(url) {
            return Core.preloadImage(url, { timeoutMs: PRELOAD_TIMEOUT_MS });
        }

        var resultCache = {};
        var activeTiles = new Map();
        var conductors = {};
        var pendingIds = [];
        var pendingFetchTimer = null;

        function findCardImageContainer(cardEl) {
            return cardEl.querySelector('.cardImageContainer') || cardEl.querySelector('.cardContent');
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

        function showLayer(tile, url) {
            return libPreloadImage(url).then(function () {
                if (!tile.active) { return; }
                var nextLayerIndex = tile.visibleIndex === 0 ? 1 : 0;
                var nextLayer = tile.layers[nextLayerIndex];
                var prevLayer = tile.visibleIndex === -1 ? null : tile.layers[tile.visibleIndex];
                var myGeneration = ++tile.fadeInGeneration;
                nextLayer.style.backgroundImage = cssUrl(url);
                nextLayer.style.opacity = '0';
                // The incoming layer must paint above the outgoing one:
                // both are position:absolute without z-index, so DOM order
                // decides - move the incoming layer after the outgoing one.
                if (prevLayer && prevLayer.nextSibling !== nextLayer) { prevLayer.parentNode.insertBefore(nextLayer, prevLayer.nextSibling); }
                void nextLayer.offsetWidth;
                if (prevLayer) { prevLayer.style.opacity = '0'; }
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        if (!tile.active) { return; }
                        if (myGeneration !== tile.fadeInGeneration) { return; }
                        nextLayer.style.opacity = '1';
                    });
                });
                tile.visibleIndex = nextLayerIndex;
            }).catch(function (e) { libLog('Image skipped (load error)', tile.id, e); });
        }

        function ensureConductor(type, cycleMs) {
            if (conductors[type]) { return; }
            conductors[type] = { intervalHandle: null, cycleMs: cycleMs };
            conductors[type].intervalHandle = setInterval(function () { tickConductor(type); }, cycleMs);
            libLog('Synchronized clock for', type, 'started, cycle:', cycleMs, 'ms');
        }

        function tickConductor(type) {
            activeTiles.forEach(function (tile) {
                if (!tile || tile.type !== type || !tile.joined) { return; }
                if (!document.body.contains(tile.el)) { deactivateTile(tile.el); return; }
                if (tile.urls.length < 2) { return; } // one image: static overlay, nothing to rotate
                if (tile.singlePass && tile.slideIndex >= tile.urls.length) {
                    var visibleLayer = tile.visibleIndex === -1 ? null : tile.layers[tile.visibleIndex];
                    if (visibleLayer) { visibleLayer.style.opacity = '0'; }
                    tile.finished = true;
                    return;
                }
                if (tile.finished) { return; }
                var url = tile.urls[tile.slideIndex % tile.urls.length];
                tile.slideIndex++;
                showLayer(tile, url);
            });
        }

        function activateTile(cardEl, itemId, result) {
            if (activeTiles.has(cardEl)) { return; }
            // Library like the detail page: one image is enough (Session 122).
            if (!result || !result.IsMovie || !Array.isArray(result.Posters) || result.Posters.length < 1) { return; }
            var imageContainer = findCardImageContainer(cardEl);
            if (!imageContainer) { return; }
            var type = cardEl.dataset.type;
            var resolvedType = result.ResolvedType || 'extraposter';
            var urls = result.Posters.map(function (entry) {
                return '/Extraposter/' + encodeURIComponent(itemId) + '/image/' + encodeURIComponent(entry.FileName)
                    + '?type=' + encodeURIComponent(resolvedType) + '&v=' + encodeURIComponent(entry.Version);
            });
            // Tile ownership: Extra outranks the swappers - whatever they
            // (or Jellyfin) painted stays underneath as the Delay backdrop.
            libraryTileOwners.set(imageContainer, { priority: LIB_PRIORITY, url: urls[0] });
            var layers = libCreateOverlayLayers(imageContainer, result.FadeTimeMs);
            var tile = {
                id: itemId, el: cardEl, type: type, layers: layers, urls: urls,
                slideIndex: 0, visibleIndex: -1, singlePass: !!result.SinglePass,
                finished: false, joined: false, active: true, fadeInGeneration: 0
            };
            activeTiles.set(cardEl, tile);
            ensureConductor(type, result.CycleTimeMs);
            var delayMs = result.DelayEnabled ? result.DelayMs : 0;
            setTimeout(function () {
                if (!tile.active) { return; }
                tile.slideIndex = 1;
                showLayer(tile, urls[0]).then(function () { tile.joined = true; });
            }, delayMs);
        }

        function deactivateTile(cardEl) {
            var tile = activeTiles.get(cardEl);
            if (!tile) { return; }
            tile.active = false;
            tile.layers.forEach(function (l) { l.remove(); });
            activeTiles.delete(cardEl);
        }

        function scheduleBatchFetch() {
            if (pendingFetchTimer) { return; }
            pendingFetchTimer = setTimeout(function () { pendingFetchTimer = null; flushBatchFetch(); }, FETCH_DEBOUNCE_MS);
        }

        function flushBatchFetch() {
            var allIds = pendingIds;
            pendingIds = [];
            if (allIds.length === 0) { return; }
            var idsToFetch = allIds.filter(function (id) { return !(id in resultCache); });
            idsToFetch = idsToFetch.filter(function (id, idx) { return idsToFetch.indexOf(id) === idx; });

            function activateKnownVisible() {
                allIds.forEach(function (id) {
                    var result = resultCache[id];
                    if (!result) { return; }
                    document.querySelectorAll('.card[data-id="' + id + '"]').forEach(function (cardEl) {
                        if (nearViewport.has(cardEl)) { activateTile(cardEl, id, result); }
                    });
                });
            }

            if (idsToFetch.length === 0) { activateKnownVisible(); return; }

            var chunks = [];
            for (var i = 0; i < idsToFetch.length; i += BATCH_CHUNK) { chunks.push(idsToFetch.slice(i, i + BATCH_CHUNK)); }
            Promise.all(chunks.map(function (chunk) {
                return fetch('/Extraposter/batch?ids=' + chunk.map(encodeURIComponent).join(',') + '&scope=library')
                    .then(function (r) { return r.json(); })
                    .then(function (batchResponse) {
                        var items = batchResponse.Items || {};
                        // Same key normalisation as the Animated library path (Session 122).
                        Object.keys(items).forEach(function (id) { resultCache[id.replace(/-/g, '')] = items[id]; });
                        chunk.forEach(function (id) { if (!(id in resultCache)) { resultCache[id] = null; } });
                    });
            })).then(activateKnownVisible).catch(function (e) { libLog('Error during the batch request', e); });
        }

        // Activation window = Jellyfin's own lazy-load window (50% margin).
        var nearViewport = new WeakSet();
        var libObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                var cardEl = entry.target;
                var itemId = cardEl.dataset.id;
                if (!itemId) { return; }
                if (entry.isIntersecting) {
                    nearViewport.add(cardEl);
                    var result = resultCache[itemId];
                    if (result) { activateTile(cardEl, itemId, result); }
                } else {
                    nearViewport.delete(cardEl);
                    deactivateTile(cardEl);
                }
            });
        }, { root: null, rootMargin: '50%', threshold: 0 });

        var libObservedElements = new WeakSet();

        // Every tile is asked as soon as it exists (knowledge for the whole
        // page, like Jellyfin's ImageTags) and watched for the 50% window.
        function observeNewCards() {
            document.querySelectorAll('.card[data-type="Movie"], .card[data-type="Series"], .card[data-type="BoxSet"]').forEach(function (card) {
                if (libObservedElements.has(card)) { return; }
                libObservedElements.add(card);
                var itemId = card.dataset.id;
                if (!itemId) { return; }
                if (!(itemId in resultCache) && pendingIds.indexOf(itemId) === -1) {
                    pendingIds.push(itemId);
                    scheduleBatchFetch();
                }
                libObserver.observe(card);
            });
        }

        function resetForNavigation() {
            Array.from(activeTiles.keys()).forEach(deactivateTile);
            Object.keys(conductors).forEach(function (type) { clearInterval(conductors[type].intervalHandle); delete conductors[type]; });
            observeNewCards();
        }

        var libMutationObserver = new MutationObserver(function () { observeNewCards(); });
        libMutationObserver.observe(document.body, { childList: true, subtree: true });

        document.addEventListener('viewshow', function () { setTimeout(resetForNavigation, 300); });
        setTimeout(observeNewCards, 1200);

        return { check: check, priority: 3 };
    })();

    // =====================================================================
    // Case (Case Mod tab) - boxes.zip concept session. Deliberately
    // independent of the poster arbiter system (Custom/Animated/Extra's
    // own priority/winner machinery, coordinated above via `coord`) -
    // this overlay applies UNCONDITIONALLY on top of whatever is
    // currently in the poster slot, regardless of which source won it
    // (explicit user decision for this first version: "fürs erste mal
    // immer"). Much simpler lifecycle than the other three modules as a
    // direct result: no reservation, no priority, no waiting for a
    // decision - just "is this item applicable, and if so, where does
    // the texture go". Explicit user request: folded into this shared
    // file rather than its own separate feature script, unlike every
    // other module here.
    //
    // Positioning: percentage-of-parent CSS only (left/top/width/height
    // all in %, tied to the SAME .cardImageContainer the poster itself
    // lives in) - explicit user requirement ("fix draufgeklebt ... darf
    // nicht hin und herzappeln"). A CSS percentage recalculates natively
    // against its parent's own current box on every resize/zoom, with no
    // JS resize listener and no per-frame recomputation needed - the
    // same technique already proven in this plugin for the
    // Keyart/Extrakeyart logo overlays.
    var CaseModModule = (function () {
        var DEBUG = true; // gated at runtime by localStorage.ArtworkPlusDebug (Core.makeLogger, Session 114)
        var log = Core.makeLogger('[PostersPlus/CaseMod]', DEBUG);
        var BOX_CLASS = 'artworkplus-casemod-box';
        // Session 44 (real bug, user finding: "both visible at the same
        // time" when switching between case types): own marker class,
        // independent of BOX_CLASS, for the two temporary 3D-case
        // preview elements (inner case + disc preview) - so
        // removeExistingOverlay() finds and removes them reliably,
        // independent of BOX_CLASS's own CSS rules, which must not
        // leak in here unintentionally.
        var TUNE_PREVIEW_CLASS = 'artworkplus-casemod-3dtune-preview';
        var OVERLAY_CLASS = 'artworkplus-casemod-overlay';
        // Explicit user request (Session 21): Front and Back fade in
        // instead of popping in hard, Disc excluded - see buildBox's/
        // fadeInBox's own doc comments further down for the full
        // reasoning.
        var CASE_FADE_IN_MS = 200;
        // Back cover reintroduced (was removed while the front's own
        // geometry was being re-tuned; tuning done, values locked in
        // as C# defaults). Explicit user requirement - three layers:
        // back case BEHIND the real poster card, poster, front case in
        // front. The real card's own z-index is 3 (confirmed against
        // Jellyfin's own librarybrowser.scss, .detailImageContainer
        // .card) - back gets 2 (under it), front keeps 4 (above it).
        // All three are SIBLINGS inside the same .detailImageContainer,
        // i.e. the same stacking context, so these z-index values
        // compare directly against each other. The back box reuses the
        // front's exact same per-case-type geometry class (a real
        // case's front and back cover share the same physical outer
        // dimensions) and stays fully static - it never rotates, even
        // during the Open Case animation (explicit user scoping).
        var BOX_FRONT_CLASS = 'artworkplus-casemod-box-front';
        var BOX_BACK_CLASS = 'artworkplus-casemod-box-back';
        // Explicit user correction (see ensureSizedStylesInjected's own
        // doc comment for the full history of why this exists): the box
        // now gets its REAL, actual width/left/top/aspect-ratio baked in
        // per case type - no more scale() transform pretending a
        // poster-sized box is case-sized. One class per case type (only
        // 3 exist: vivaelitecases/clearcases/vortexcases), computed once and
        // cached.
        var SIZED_CLASS_PREFIX = 'artworkplus-casemod-sized-';
        var ROTATOR_CLASS = 'artworkplus-casemod-rotator';
        // Real browser quirk found via isolated A/B testing (not
        // documented behavior I knew in advance): `perspective` set
        // DIRECTLY on the rotated element's own parent visibly breaks
        // both the rotation's hinge point AND its own rendered height,
        // even with transform-style:preserve-3d also present - adding
        // one plain, untransformed wrapper level IN BETWEEN perspective
        // and the rotation fixes both, confirmed by a direct before/
        // after measurement (hinge fixed at the exact same pixel
        // position with the wrapper present, visibly shifted without
        // it). ROTATOR_HOST_CLASS is that wrapper - no transform, no
        // special styling beyond filling its own parent.
        var ROTATOR_HOST_CLASS = 'artworkplus-casemod-rotator-host';
        var ROTATOR_OPEN_CLASS = 'artworkplus-casemod-rotator-open';
        var OPEN_KEYFRAMES_NAME = 'artworkplusCaseModOpen';
        // Session 12: the real poster (posterEl, i.e. .cardImageContainer
        // - the ONE shared element Main/Custom/Animated/Extra all paint
        // their backgroundImage into, per the arbiter design; NOT four
        // separate DOM layers) now swings open TOGETHER with the front
        // cover as one rigid unit (explicit user request: "poster layer
        // beim öffnen mitzunehmen"). posterEl is left in its REAL,
        // native DOM position (never reparented into the case's own
        // rotator - reparenting a native Jellyfin element risks
        // breaking CSS selectors or native JS that assume its position
        // in the tree).
        //
        // Its own transform-origin CANNOT simply reuse the case box's
        // own %-based hinge: a `transform-origin` percentage ALWAYS
        // resolves against the element it is applied to - there is no
        // way to express "a percentage of some OTHER element's width"
        // inside it (found the hard way: a first pure-calc() attempt
        // assumed a %-of-container term would carry through, proven
        // wrong by an isolated Playwright measurement showing the
        // computed hinge nowhere near the case's own). A SECOND attempt
        // used a one-time getBoundingClientRect() JS measurement
        // instead - technically correct at load time, but explicitly
        // rejected on review: it goes stale on a later window resize
        // (unlike everything else here, which is pure vw/%/em CSS and
        // stays correct through any resize automatically), and more
        // importantly it was built on the WRONG assumption about which
        // ancestor is `.card`'s own real containing block, which
        // caused a SEPARATE, worse production bug (see
        // `.detailImageContainer .card { perspective: ... }`'s own doc
        // comment above for the full story).
        //
        // THE ACTUAL FIX, verified directly in Jellyfin's own source:
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
        // FIX (session 14, user-found real production bug, THEN
        // corrected again after a mandated deep-verification pass):
        // posterEl (.cardImageContainer) and the Keyart/Extrakeyart
        // logo overlay are both frequently, independently repainted by
        // OTHER code completely unrelated to Case Mod - the Poster
        // Arbiter swaps posterEl's own background-image whenever a
        // higher-priority source (e.g. a delayed Extraposter) becomes
        // available, AND Jellyfin's own native lazy-load pipeline adds
        // its own `lazy-image-fadein` class (its own CSS animation) to
        // posterEl every time a NEW image finishes loading into it.
        // Putting the Open Case rotation's own `animation` property
        // directly on posterEl meant either of these unrelated repaints
        // could stomp it mid-flight (confirmed via live user report).
        //
        // FIRST fix attempted (session 14, reverted): wrap posterEl
        // dynamically in a brand-new DIV, rotate the wrapper instead.
        // This broke a DIFFERENT, real thing: Jellyfin's own
        // `imageLoader.js` looks up the padder via
        // `elem.parentNode.querySelector('.cardPadder')` - once
        // posterEl's real parent became our wrapper instead of
        // `.cardScalable`, that lookup silently returned nothing,
        // permanently breaking native's own fade-in/padder handshake
        // (confirmed by reading `imageLoader.js` directly). It ALSO
        // only covered posterEl and the Keyart logo, missing
        // Extraposter entirely - Extraposter never touches posterEl at
        // all, it creates its own two `.extraposter-layer` sibling divs
        // via `createOverlayLayers(posterEl.parentElement, ...)`
        // (confirmed in the real source) - these lived OUTSIDE the
        // wrapper and never rotated.
        //
        // THE ACTUAL FIX: rotate `.cardScalable` itself - the real,
        // native, NEVER-reparented common ancestor that already
        // contains the poster, the padder, any Extraposter layers, and
        // the Keyart/Extrakeyart logo (all genuine DOM siblings inside
        // it, confirmed in the real source). `posterEl.parentNode`
        // never changes, so native's own padder lookup stays intact.
        // No per-element wrapping or tracking is needed at all: since
        // whichever content currently lives inside `.cardScalable` is a
        // real, physical descendant, rotating the parent carries all of
        // it along automatically, including Extraposter layers created
        // AFTER the rotation already started (Extraposter's own layers
        // are created once and reused for its whole navigation, not
        // recreated per image-cycle - but even if they were, a later-
        // inserted child of an already-rotated 3D parent still renders
        // correctly in that same 3D space, no special-casing needed).
        // Also structurally eliminates the animationend-collision risk
        // the wrapper never fully ruled out: native's own one-shot
        // `elem.addEventListener('animationend', ...)` is registered on
        // posterEl itself - an animationend firing on `.cardScalable` (a
        // PARENT of posterEl) can never reach it, since DOM events only
        // bubble upward to ancestors, never down to descendants.
        // Verified end to end (real SCSS compilation, real rendered
        // geometry, real 4-angle hinge measurement, real layering/
        // z-index screenshots, and 3 explicit falsification attempts)
        // before implementing - see the curriculum's own Session 14
        // entry for the full verification record.
        var POSTER_ORIGIN_CLASS_PREFIX = 'artworkplus-casemod-poster-origin-';
        // FIX (this session): `.card`'s own perspective-origin needs
        // the SAME per-type treatment as the poster's transform-origin
        // - see ensurePosterOriginStylesInjected's own doc comment for
        // the full reasoning (matching vanishing points between poster
        // and front case, not just matching depth values).
        var CARD_PERSPECTIVE_CLASS_PREFIX = 'artworkplus-casemod-card-perspective-';
        // Background padder (explicit user finding - see
        // ensureStylesInjected's own doc comment for the full
        // reasoning): hidden only during the open/held window, never
        // otherwise.
        var PADDER_HIDE_CLASS = 'artworkplus-casemod-padder-hide';
        var PADDER_HIDE_KEYFRAMES_NAME = 'artworkplusCaseModPadderHide';
        // Disc (session 12): a real, separate static layer (never
        // rotates with the hinge - explicit user correction: "nein, nur
        // die disc dreht sich" refers to the SEPARATE continuous
        // Spinning Disc effect below, not the opening motion) sitting
        // behind the poster/front assembly, revealed by their
        // perspective foreshortening as they swing open - already
        // visible early in the animation, not gated on crossing 90°
        // (explicit user point: "die disc muss zumindest beim öffnen
        // schon sichtbar sein"). Same per-case-type sized-class pattern
        // as the Case box, but with only ONE size value (no
        // width/height stretch - a disc is 1:1, stretching would
        // visibly oval it).
        var BOX_DISC_CLASS = 'artworkplus-casemod-box-disc';
        var SIZED_DISC_CLASS_PREFIX = 'artworkplus-casemod-disc-sized-';
        var DISC_SPIN_CLASS = 'artworkplus-casemod-disc-spin';
        var DISC_SPIN_KEYFRAMES_NAME = 'artworkplusCaseModDiscSpin';
        // SESSION 18, new field (Spinning direction, Left/Right): the
        // existing spin (720deg -> 0deg, i.e. the angle DECREASING over
        // time) is designated "Left" - kept as-is, unchanged appearance
        // for existing installs. "Right" is a SEPARATE class + keyframes
        // with the mirrored sign (-720deg -> 0deg, angle INCREASING
        // toward zero from a negative start) - same easing/timing shape,
        // opposite rotational direction. Picked at runtime by
        // discSpinClassFor() below, never both at once.
        var DISC_SPIN_CLASS_RIGHT = 'artworkplus-casemod-disc-spin-right';
        var DISC_SPIN_KEYFRAMES_NAME_RIGHT = 'artworkplusCaseModDiscSpinRight';
        function discSpinClassFor(direction) {
            return direction === 'Right' ? DISC_SPIN_CLASS_RIGHT : DISC_SPIN_CLASS;
        }
        // Per-case-type hinge position (transform-origin X, in % of the
        // box width) - the session-9 finding that the true hinge sits
        // slightly INSIDE the PNG's own left edge, not at 0%, finally
        // fixed. Measured ONCE per case type directly from the texture
        // files themselves (alpha profile of the left edge, mean alpha
        // per column over the middle 60% of the height to exclude
        // corner rounding, edge = 50%-of-plateau crossing, subpixel-
        // interpolated): vivaelitecases x=76.30px, clearcases x=65.62px,
        // vortexcases x=76.09px, all of the shared 552px canvas width.
        // Verified beforehand that within each type ALL 9 resolution
        // textures (480p..tvseries) have the pixel-identical left edge,
        // so one value per type is genuinely sufficient - measured, not
        // assumed. A PERCENTAGE (not px/vw) is deliberately the right
        // unit here: the <img> fills the box 100%, so a % of the box is
        // automatically a % of the rendered texture at every box size -
        // the percentage-invariance proof from the curriculum means no
        // separate conversion for the user's tuned Width/Left values is
        // needed, the browser does it inherently. If the texture PNGs
        // are ever regenerated, re-measure these.
        var HINGE_ORIGIN_X_PERCENT = {
            vivaelitecases: 13.822,
            clearcases: 11.889,
            vortexcases: 13.784,
            // Session 42: REAL measured value, verified against all 6
            // resolution textures (480p/720p/1080p/4k/3d/p, all
            // identical 93.128%) - the same alpha-profile method as for
            // the other three case types, only searched from the LEFT
            // this time (first column with alpha>128 in the middle 60%
            // of the height). Used when CaseAngleDegrees is NEGATIVE
            // (hinge on the right, user-confirmed correct).
            'vivaelite3dcases': 93.128,
            // Session 43: mirrored value (100 - 93.128) for the case
            // that CaseAngleDegrees is POSITIVE (hinge on the left,
            // admin-selectable via the sign of Case Angle).
            'vivaelite3dcases_mirrored': 6.872
        };
        var stylesInjected = false;

        /**
         * SESSION 16 - complete, empirically verified replica of Kodi's
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
         *   That was the actual error point of the first computation
         *   in that session - isolated by comparing with the known real
         *   0-degree position (884px deviation, exactly 1080 - 98 - 98).
         *
         * NOT adopted: Kodi's own internal sign inversion of the angle
         * (`m_startAngle *= -1`) - that is a Kodi-internal compensation
         * for a DIFFERENT, Kodi-specific Y-axis handling at a place we
         * already correct explicitly and separately at our OWN Y-flip
         * point above. Our own angle (0 to +angleDeg) already reflects
         * the user-confirmed desired rotation direction ("opens
         * towards the viewer") - an additional Kodi-internal sign
         * inversion would flip that back, not reinforce it.
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
        function mat4ColMulVec(M, v) {
            var out = [0, 0, 0, 0];
            for (var i = 0; i < 4; i++) {
                out[i] = M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2] + M[i][3] * v[3];
            }
            return out;
        }
        function rowVecMulMat4(v, M) {
            // Zeilenvektor-Konvention: out[i] = sum_j v[j] * M[j][i]
            var out = [0, 0, 0, 0];
            for (var i = 0; i < 4; i++) {
                out[i] = v[0] * M[0][i] + v[1] * M[1][i] + v[2] * M[2][i] + v[3] * M[3][i];
            }
            return out;
        }
        function buildCameraMatrices(cameraX, cameraY, screenW, screenH) {
            var offsetX = cameraX - screenW * 0.5;
            var offsetY = cameraY - screenH * 0.5;
            var w = screenW * 0.5, h = screenH * 0.5;

            // ModelView: Translatef(-(w+offsetX), h+offsetY, 0) dann LookAt(0,0,-2h -> 0,0,0, up=0,-1,0)
            // Eigene LookAt-Basis (Gram-Schmidt, wie in CMatrixGL::LookAt)
            var eye = [0, 0, -2 * h], center = [0, 0, 0], up = [0, -1, 0];
            var fwd = [center[0]-eye[0], center[1]-eye[1], center[2]-eye[2]];
            var fl = Math.sqrt(fwd[0]*fwd[0]+fwd[1]*fwd[1]+fwd[2]*fwd[2]);
            fwd = [fwd[0]/fl, fwd[1]/fl, fwd[2]/fl];
            var side = [fwd[1]*up[2]-fwd[2]*up[1], fwd[2]*up[0]-fwd[0]*up[2], fwd[0]*up[1]-fwd[1]*up[0]];
            var sl = Math.sqrt(side[0]*side[0]+side[1]*side[1]+side[2]*side[2]);
            side = [side[0]/sl, side[1]/sl, side[2]/sl];
            var up2 = [side[1]*fwd[2]-side[2]*fwd[1], side[2]*fwd[0]-side[0]*fwd[2], side[0]*fwd[1]-side[1]*fwd[0]];

            // Zeilenvektor-konsistente Kombination: this_neu = arg @ this_alt (aus MultMatrixf)
            function matMulRow(A, B) { // A,B als A[row][col]=flat, Standard-Matrixmultiplikation
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
            // Standard-Matrixmultiplikation, A[row][col], A@B
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
         * Builds the complete, empirically verified matrix3d() for a
         * given intermediate angle. Derivation AND numeric verification
         * (angle-0 position exact, hinge fixed point exact, reference
         * pipeline vs. this matrix form exactly equal over several
         * angles/all four corners, max. deviation 1.99e-13 = pure
         * floating-point noise) see that session's own derivation. In
         * short:
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
        function computeKodiMatrix3dString(angleDeg, hingeXPx, ctrlLeft, ctrlTop,
                                            screenW, screenH, cameraX, cameraY) {
            var angleRad = angleDeg * Math.PI / 180;
            var Robj = setYRotationMatrix(angleRad, hingeXPx, 0);
            return finishKodiMatrix(Robj, ctrlLeft, ctrlTop, ctrlLeft, ctrlTop, 0, screenW, screenH, cameraX, cameraY);
        }

        // Session 65 FIX (real bug from Sessions 62/64, found via an
        // external hint: the Open Case hinge is FIXED TO THE CASE
        // BODY - when the body is rotated by the static tilt, the
        // hinge point MUST rotate along, exactly as would happen
        // automatically with nested CSS transforms (parent rotation,
        // then child rotation with its own transform-origin). The
        // previous versions wrongly treated the left hinge as a fixed
        // WORLD coordinate, unchanged by the static tilt - that was
        // the actual reason for the remaining "wandering" (~18px), not
        // an unavoidable geometric property. Fix: the left hinge is
        // FIRST transformed by the static rotation (its new X/Z
        // position computed), then the opening rotation is applied
        // around EXACTLY THIS transformed point - then composed
        // (Robj_open * Robj_static, Robj_static acts first). At
        // openAngle=0 this reduces exactly to the pure, unchanged
        // static rotation - no approximation/compensation needed for
        // the rest position any more.
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

        // Like computeKodiMatrix3dString, but with an additional fixed
        // translation (offsetX/Y/Z) on the Tcol shift - the screen
        // reference point (ctrlLeft/ctrlTop in row0/row1) stays
        // UNTOUCHED, only where the object is actually moved changes.
        // This lets the compensation above be applied directly.
        function computeKodiMatrix3dStringWithOffset(angleDeg, hingeXPx, ctrlLeft, ctrlTop,
                                                       offsetX, offsetY, offsetZ,
                                                       screenW, screenH, cameraX, cameraY) {
            var angleRad = angleDeg * Math.PI / 180;
            var Robj = setYRotationMatrix(angleRad, hingeXPx, 0);
            return finishKodiMatrix(Robj, ctrlLeft, ctrlTop,
                ctrlLeft + offsetX, ctrlTop + offsetY, offsetZ,
                screenW, screenH, cameraX, cameraY);
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
         * Real architectural bug found via direct user report, AFTER the
         * feature already worked for a simple case: a physical disc
         * case is a FRAME - genuinely LARGER than the poster artwork it
         * holds - unlike the Keyart/Extrakeyart logo overlays (which sit
         * entirely WITHIN the poster's own box). Jellyfin's own poster
         * card element (`.cardImageContainer`) has both `overflow:
         * hidden` AND `contain: strict` (confirmed directly against
         * Jellyfin's own card.scss) - anything appended as ITS
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
         * Fix: don't nest inside the card's own subtree AT ALL - create
         * a completely separate SIBLING element instead, appended
         * directly to `.detailImageContainer` (the poster CARD's own
         * parent - confirmed via Jellyfin's own itemDetails/index.html
         * and cardBuilder.js: `<div class="detailImageContainer">`
         * exists in the page from the start, empty, and the actual
         * `.card` element is inserted into it later as a plain child -
         * our own sibling box slots in right alongside it, at the same
         * level, entirely unaffected by the card's own containment).
         *
         * Positioning that sibling box so it tracks the real card
         * perfectly, with NO JS resize/fullscreen listener needed
         * (explicit user requirement: "es darf sich ... bei
         * Fensteränderung ... nicht hin- und herplatzieren"), confirmed
         * directly against Jellyfin's own librarybrowser.scss: the real
         * `.card` element is positioned with `position: absolute` using
         * ONLY viewport-relative units (vw/vh) and percentages -
         * NEVER pixels - varying by the current `.layout-desktop`/
         * `.layout-mobile`/`.layout-tv` class Jellyfin itself already
         * puts on a shared ancestor, plus one narrow-viewport media
         * query override. Copying the REAL card's own RESOLVED/computed
         * style (getComputedStyle) was deliberately ruled out - that
         * API always returns absolute pixel values regardless of the
         * original unit, which would silently defeat the entire
         * "no JS needed, purely responsive" property being copied in
         * the first place. Instead, these are the exact same rules,
         * re-declared once for our own class name - the browser's own
         * CSS engine then keeps both elements in perfect sync under
         * every resize/fullscreen/layout-mode change, exactly the same
         * way it already does for the real card, since it's genuinely
         * the same mechanism, not an imitation of it.
         */
        function ensureStylesInjected(angleDeg) {
            if (stylesInjected) { return; }
            stylesInjected = true;
            // Session 12: `angleDeg` is read from the admin-configured
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
                // Disc (session 12): same numeric z-index as Back, but
                // ALWAYS appended to the DOM right after it - elements
                // tied on z-index paint in DOM order, so Disc reliably
                // paints above Back while staying below the real card
                // (3) and the front assembly (4). Physically correct
                // too: the disc sits inside the case, in front of the
                // case's own back-interior surface, behind the printed
                // front cover.
                '.detailImageContainer .' + BOX_DISC_CLASS + ' { z-index: 2; }',
                // FIX (this session): the perspective architecture
                // change described below in the old comment was WRONG
                // and caused a real production bug - reverted.
                // `.detailImageContainer` has NO CSS position of its
                // own anywhere in Jellyfin's stylesheets (verified in
                // the real source) - `.card`'s own `position: absolute;
                // top: -80%; left: 3.3%` therefore normally escapes
                // PAST it and resolves against a much higher ancestor,
                // `.detailPagePrimaryContainer` (the only ancestor in
                // between that actually has `position: relative` on
                // `.layout-desktop`). Setting `perspective` directly on
                // `.detailImageContainer` made IT into a new containing
                // block instead (a documented, unavoidable side effect
                // of `perspective`/`transform`/`filter` on ANY element -
                // not a bug, a CSS rule) - `.card`'s percentages then
                // resolved against `.detailImageContainer`'s own
                // (differently-sized, itself padded) box instead,
                // visibly shifting both the real poster AND every case
                // box that also lives inside `.detailImageContainer`.
                // Fix: give `.card` its OWN perspective directly -
                // `.card` is ALREADY `position: absolute` (already a
                // positioned element), so this changes nothing about
                // its own position, only how ITS 3D-transformed
                // descendants (the poster) are rendered. The front
                // case's own perspective goes back to living on
                // BOX_FRONT_CLASS alone (verbatim Session 11), fully
                // independent of the poster's.
                // SESSION 16: no more CSS `perspective` on `.card`/
                // BOX_FRONT_CLASS - the new, verified matrix3d() (see
                // computeKodiMatrix3dString) already contains the
                // complete projection maths itself. An additional CSS
                // `perspective` on the parent would project a SECOND
                // time and distort the result.
                '.detailImageContainer .' + BOX_FRONT_CLASS + ' { transform-style: preserve-3d; }',
                '.' + ROTATOR_HOST_CLASS + ' {',
                '    position: absolute; left: 0; top: 0; width: 100%; height: 100%;',
                '}',
                '.' + ROTATOR_CLASS + ' {',
                '    position: absolute; left: 0; top: 0; width: 100%; height: 100%;',
                '    transform-style: preserve-3d;',
                // FIX (this session, explicit user decision): removed
                // `backface-visibility: hidden`. Past 90°, the browser's
                // default `visible` shows a horizontally-MIRRORED
                // duplicate of the front texture - user explicitly
                // accepted this ("der Spiegel-Artefakt ist mir egal,
                // darf ruhig dann alles gespiegelt sehen"), preferring
                // that over the door vanishing into blankness with
                // nothing else properly visible behind it yet.
                //
                // 0% is only the FALLBACK hinge - the real, per-case-
                // type hinge (measured from each texture's own visible
                // left edge, see HINGE_ORIGIN_X_PERCENT above) is
                // injected as a higher-specificity override per sized
                // class in ensureSizedStylesInjected below.
                '    transform-origin: 0% 50%;',
                '}',
                // FIX (this session): ZERO baked-in CSS delay now. The
                // user wants the delay itself admin-editable AND a
                // second, independent "open on click" trigger - a
                // fixed CSS `animation-delay` can't serve both (a click
                // needs to start the SAME animation at an unpredictable
                // JS-determined moment, not a fixed offset from page
                // load). JS now decides exactly when to add
                // ROTATOR_OPEN_CLASS (see check() below: either after
                // OpenCaseDelayMs via setTimeout, or on a valid poster
                // click, whichever happens first) - the animation
                // itself, once started, still takes exactly 8000ms.
                '.' + ROTATOR_CLASS + '.' + ROTATOR_OPEN_CLASS + ' {',
                '    animation: ' + OPEN_KEYFRAMES_NAME + ' 8000ms linear 0ms 1 normal forwards;',
                '}',
                // Session 14 (corrected): the real poster, any
                // Extraposter overlay layers, and the Keyart/Extrakeyart
                // logo overlay (if present) all share this EXACT same
                // @keyframes timeline via this SAME class, declared
                // directly on `.cardScalable` (the real, native, never-
                // reparented common ancestor of all three - see this
                // class's own doc comment near its declaration for the
                // full architecture reasoning) - guarantees they stay in
                // perfect lockstep, since ROTATOR_OPEN_CLASS is added to
                // both the case rotator AND `.cardScalable` in the SAME
                // JS tick (see startOpenCaseAnimation() in check()
                // below). Its own transform-origin comes from a
                // SEPARATE, per-case-type class (ensurePosterOriginStylesInjected
                // below, pure CSS calc() - no runtime measurement), not
                // from here, since `.cardScalable`'s own box has
                // different dimensions than the case box. POSTER_ROTATE_CLASS
                // itself is now PURELY STRUCTURAL (transform-style only)
                // - the actual animation only applies once
                // ROTATOR_OPEN_CLASS is ALSO present, mirroring the case
                // rotator's own structure/start separation above.
                '.' + POSTER_ROTATE_CLASS + ' {',
                '    transform-style: preserve-3d;',
                '}',
                '.' + POSTER_ROTATE_CLASS + '.' + ROTATOR_OPEN_CLASS + ' {',
                '    animation: ' + OPEN_KEYFRAMES_NAME + ' 8000ms linear 0ms 1 normal forwards;',
                '}',
                '@keyframes ' + OPEN_KEYFRAMES_NAME + ' {',
                // SESSION 16: deliberately animates NO real property any
                // more (rotateY removed) - the actual 3D rotation now
                // comes per frame via JS through a verified matrix3d()
                // (see computeKodiMatrix3dString and runRotationFrame in
                // check() below), which replicates Kodi's own camera/
                // projection maths instead of the pure CSS
                // perspective/rotateY approximation. This @keyframes
                // rule stays anyway, unchanged in duration/timing - it
                // still delivers the reliable `animationend` signal (see
                // the code listening for it) that the rest of the cycle
                // (state reset, re-trigger permission) relies on, without
                // us having to rebuild that logic separately.
                // `outline-offset` has no visible effect whatsoever
                // without a set outline-style.
                '    0% { outline-offset: 0px; }',
                '    100% { outline-offset: 0px; }',
                '}',
                // Background padder (explicit user finding): `.cardPadder`
                // - the dark #242424 placeholder behind the poster
                // image, normally invisible once a real poster image is
                // loaded (background-size:cover fully covers it) - sits
                // BONDED inside `.card` (same element as the poster,
                // can't be reordered via z-index relative to our own
                // Back/Disc boxes without restructuring native
                // Jellyfin markup, which we deliberately avoid).
                // Hidden from the very START of the animation (0%)
                // rather than only during the "fully open" window - the
                // door already visibly swings open starting at 0% (over
                // the first 1s), progressively exposing more of
                // whatever sits behind via perspective foreshortening;
                // hiding the padder only once the door finished opening
                // left a visible "pop". Hiding it right at 0% has no
                // visible discontinuity, since at that exact instant
                // nothing of the padder is exposed yet anyway.
                // Reappears only once the door is fully closed again at
                // 100%. ZERO baked-in delay now too, added by JS in the
                // exact same tick as ROTATOR_OPEN_CLASS above - stays
                // perfectly synced regardless of which trigger fired.
                '.' + PADDER_HIDE_CLASS + ' {',
                '    animation: ' + PADDER_HIDE_KEYFRAMES_NAME + ' 8000ms linear 0ms 1 normal forwards;',
                '}',
                '@keyframes ' + PADDER_HIDE_KEYFRAMES_NAME + ' {',
                '    0%, 99.999% { visibility: hidden; }',
                '    100% { visibility: visible; }',
                '}',
                // Disc's own Spinning Disc effect - FIX (this session):
                // was an invented, unsourced continuous infinite spin;
                // the user found the REAL effect in the original Kodi
                // skin's own ViewsRightList.xml ("Thumb Box Discart"):
                // <effect type="rotate" start="720" center="auto"
                //  end="0" delay="5500" time="4300" tween="cubic"
                //  easing="inout"/>
                // - a two-full-turn SPIN-DOWN (720deg -> 0deg, i.e.
                // decelerating to rest), not an infinite spin. Ported
                // onto the SAME shared 4000ms-delay/8000ms-duration
                // timeline the door itself uses (both are measured from
                // the same Kodi WindowOpen t=0 in the original skin):
                // delay=5500ms -> (5500-4000)/8000 = 18.75% of our own
                // timeline; delay+time=9800ms -> (9800-4000)/8000 =
                // 72.5%. Sits entirely inside the door's own "held open"
                // window (12.5%-87.5%) - the disc only starts spinning
                // once the door has fully opened, and finishes well
                // before the door starts closing again, exactly
                // matching the sourced numbers (a 1200ms rest before
                // closing falls out of the math on its own, not
                // separately tuned). "tween=cubic, easing=inout" ->
                // CSS's own `ease-in-out` (a reasonable, standard
                // approximation - same spirit as the door's own
                // quadratic-easing approximation, not a literal Kodi
                // engine port). Same own-axis rotateZ, fully independent
                // of the Open Case hinge motion (explicit user
                // correction: "nein, nur die disc dreht sich"). ZERO
                // baked-in delay, added by JS in the same tick as
                // everything else above.
                '.' + DISC_SPIN_CLASS + ' {',
                '    animation: ' + DISC_SPIN_KEYFRAMES_NAME + ' 8000ms linear 0ms 1 normal forwards;',
                '}',
                '@keyframes ' + DISC_SPIN_KEYFRAMES_NAME + ' {',
                '    0% { transform: rotate(720deg); }',
                '    18.75% { transform: rotate(720deg); animation-timing-function: ease-in-out; }',
                '    72.5% { transform: rotate(0deg); }',
                '    100% { transform: rotate(0deg); }',
                '}',
                // SESSION 18: mirrored ("Right") spin direction - exact
                // same timing/easing shape as the class above, opposite
                // sign throughout, so it visibly spins the other way.
                '.' + DISC_SPIN_CLASS_RIGHT + ' {',
                '    animation: ' + DISC_SPIN_KEYFRAMES_NAME_RIGHT + ' 8000ms linear 0ms 1 normal forwards;',
                '}',
                '@keyframes ' + DISC_SPIN_KEYFRAMES_NAME_RIGHT + ' {',
                '    0% { transform: rotate(-720deg); }',
                '    18.75% { transform: rotate(-720deg); animation-timing-function: ease-in-out; }',
                '    72.5% { transform: rotate(0deg); }',
                '    100% { transform: rotate(0deg); }',
                '}'
            ].join('\n');
            document.head.appendChild(style);
        }

        // Real user-driven architectural correction, SECOND one for this
        // exact spot (explicit user quote: "das heißt ich muss alles
        // nochmal machen" - acknowledged, this was genuinely two
        // separate reworks): the FIRST rework (relative Offset/Width/
        // Height/SizePercent baked into computed width/left/top/aspect-
        // ratio) still could not solve "box exactly matches the visible
        // case artwork" - proven via an exchanged counter-example, not
        // just asserted: a uniform shift/scale of a box+image pair can
        // never change the RATIO of visible-content to transparent-
        // padding inside the underlying PNG, and that ratio only exists
        // in the file itself, never in any relative transform of it.
        // The user's own correct fix, arrived at after that proof: give
        // the box its literal, DIRECT Top/Left/Width/Height instead of
        // relative multipliers - the admin tunes the box's own real
        // geometry (comparing it against the visible case by eye) until
        // it matches, with no scale-factor indirection left at all.
        //
        // Units match the shared desktop-layout base exactly (width in
        // vw, top/left in %, matching the base 25vw/-80%/3.3%) so an
        // admin value of e.g. width=25 genuinely means "unchanged from
        // the poster's own real size" - no separate "100% = neutral"
        // convention to remember. Height is now a real, independent vw
        // value too (no more 2:3-ratio-derived height) - Width/
        // HeightPercent used to imply the aspect-ratio automatically;
        // with direct geometry the admin sets both independently, same
        // as the real poster card would if it needed a non-2:3 shape.
        //
        // Mobile/tv equivalents are DERIVED, not separately configured
        // (still an accepted approximation, same status as before) -
        // computed as the proportional scale/shift these direct desktop
        // values represent relative to the shared desktop base (25vw/
        // 37.5vw/-80%/3.3%), then applied to mobile/tv's own respective
        // bases. Revisit only if one of those specific layout modes is
        // ever reported as visibly wrong - all reported bugs and all
        // manual verification so far happened on .layout-desktop.
        var sizedClassesInjected = {};
        var discSizedClassesInjected = {};
        var posterOriginClassesInjected = {};
        // Session 121: one sized class per GEOMETRY, not per case type.
        // Since "Case width Sets" the same case type has two geometries
        // (Sets 28.5 vw, everything else 27.35 vw); keyed by type alone,
        // whichever item came first fixed the width for every later item
        // of that type (user: "von Set zu Movie bleibt manchmal die alte
        // Set-Breite"). The key carries the values, so a geometry change
        // switches to its own class.
        function sizedClassName(caseType, topVwOffset, leftPct, widthVw, heightVw) {
            return SIZED_CLASS_PREFIX + caseType + '-' + [topVwOffset, leftPct, widthVw, heightVw].map(function (v) {
                return String(v).replace(/[^0-9a-z]/gi, '_');
            }).join('-');
        }

        function ensureSizedStylesInjected(caseType, topVwOffset, leftPct, widthVw, heightVw) {
            var cls = sizedClassName(caseType, topVwOffset, leftPct, widthVw, heightVw);
            if (sizedClassesInjected[cls]) { return; }
            sizedClassesInjected[cls] = true;

            // Real bug found via user testing: `top` as an absolute
            // PERCENTAGE (matching the poster's own -80% pattern) drifts
            // relative to the poster on any viewport-width change (e.g.
            // opening devtools) - because that percentage resolves
            // against the SURROUNDING CONTAINER's own height, which is
            // driven by unrelated page content (the description text's
            // own wrap length), not by the poster's own vw-based size.
            // Confirmed with an isolated test: the gap between box-top
            // and poster-top changed by 25px purely from a container
            // height change, with neither box nor poster themselves
            // touched. `left`/`width` never had this problem because the
            // container's WIDTH scales predictably with viewport width;
            // only its HEIGHT is textwrap-dependent.
            //
            // Fix: `top` is no longer an absolute replacement value - it
            // is now a vw OFFSET added on top of the poster's own
            // unchanged -80% base (`calc(-80% + Xvw)`), matching how
            // Width/Height already work. Since vw is entirely independent
            // of the surrounding container's own (unreliable) height,
            // this offset stays locked to the poster regardless of how
            // much the container's height changes on resize - exactly
            // the same guarantee Width/Height already had.
            var scaleX = widthVw / 25;
            var shiftLeftPct = leftPct - 3.3;

            var mobileWidthVw = 30 * scaleX;
            var mobileLeftShiftVw = shiftLeftPct; // treated as directly transferable percentage-point delta

            var css = [
                '.detailImageContainer .' + cls + ' {',
                '    width: ' + widthVw + 'vw;',
                '    height: ' + heightVw + 'vw;',
                '}',
                '.layout-mobile .detailImageContainer .' + cls + ' {',
                '    left: calc(5% + ' + mobileLeftShiftVw + '%);',
                '    width: ' + mobileWidthVw + 'vw;',
                '}',
                '.layout-desktop .detailImageContainer .' + cls + ' {',
                '    left: ' + leftPct + '%;',
                '    top: calc(-80% + ' + topVwOffset + 'vw);',
                '    width: ' + widthVw + 'vw;',
                '}',
                '.layout-tv .detailImageContainer .' + cls + ' {',
                '    left: calc(5% + ' + shiftLeftPct + '%);',
                '    top: 50%;',
                '    width: ' + widthVw + 'vw;',
                '    transform: translateY(calc(-50% + ' + topVwOffset + 'vw));',
                '}',
                '@media all and (max-width: 62.5em) {',
                '    .layout-desktop .detailImageContainer .' + cls + ',',
                '    .layout-tv .detailImageContainer .' + cls + ' {',
                '        top: calc(10% + ' + topVwOffset + 'vw);',
                '    }',
                '}',
                '[dir="rtl"] .detailImageContainer .' + cls + ' { left: unset; }',
                '[dir="rtl"] .layout-mobile .detailImageContainer .' + cls + ',',
                '[dir="rtl"] .layout-tv .detailImageContainer .' + cls + ' { right: calc(5% + ' + shiftLeftPct + '%); }',
                '[dir="rtl"] .layout-desktop .detailImageContainer .' + cls + ' { right: ' + leftPct + '%; }',
                // Per-case-type hinge (see HINGE_ORIGIN_X_PERCENT's own
                // doc comment): overrides the generic 0% fallback via
                // higher specificity (.sized-class .rotator vs plain
                // .rotator). The % resolves against the rotator's own
                // width (= the box's width, rotator fills it 100%), so
                // it lands on the texture's visible left edge at every
                // box size the admin values produce - no separate
                // stretch/position conversion needed (percentage
                // invariance, proven in the curriculum).
                // SESSION 16: transform-origin is now ALWAYS 0 0 - see
                // ensurePosterOriginStylesInjected's own comment for the
                // full reasoning (matrix3d() starts from the element's
                // own origin, the hinge point now lives in the matrix
                // itself, no longer here).
                '.' + cls + ' .' + ROTATOR_CLASS + ' {',
                '    transform-origin: 0 0;',
                '}',
                // CORRECTED SESSION 16 (see ensurePosterOriginStylesInjected's
                // own doc comment for the full derivation and Kodi-
                // source citation): the front box's own perspective-
                // origin now targets the VIEWPORT'S OWN horizontal
                // center (50vw) too, matching the real Kodi engine's
                // screen-fixed default camera instead of the hinge.
                // Expressed here as a PERCENTAGE OF THIS BOX'S OWN
                // WIDTH (this rule's own existing convention, since
                // `perspective-origin` on `.` + cls always resolves
                // against that box's own dimensions) - `leftPct` is
                // vw-equivalent (same container-width reasoning as
                // ensurePosterOriginStylesInjected), so
                // `(50 - leftPct) / widthVw * 100` gives the same real-
                // world screen-center point, just re-expressed in this
                // box's own coordinate space. `transform-origin`
                // (the rotation axis, one rule above) stays at the
                // hinge, unchanged - only the camera moved.
                '.detailImageContainer .' + BOX_FRONT_CLASS + '.' + cls + ' {',
                '    perspective-origin: ' + ((50 - leftPct) / widthVw * 100) + '% 50vh;',
                '}'
            ].join('\n');

            var styleEl = document.createElement('style');
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        }

        // Poster's own transform-origin (rotation axis - stays at the
        // real, per-case-type hinge, unchanged) - declared on
        // `.cardScalable` (the real, native, never-reparented common
        // ancestor of the poster, Extraposter's own overlay layers, and
        // the Keyart/Extrakeyart logo - see POSTER_ROTATE_CLASS's own
        // doc comment above for the full architecture reasoning). Pure
        // CSS, no JS measurement: the case box's own `leftPct`/
        // `widthVw` and the poster's own base `3.3%` left (desktop/tv)
        // or `5%` (mobile) all resolve against the SAME container
        // (`.detailPagePrimaryContainer`) whose content width equals
        // the viewport width on `.layout-desktop` - so a %-of-that-
        // container is numerically identical to the same number of vw.
        //
        // CORRECTED SESSION 15 (real, already-shipped bug found via a
        // mandated deep verification pass): earlier sessions subtracted
        // a fixed `0.6em` here, on the assumption that `.cardBox {
        // margin: 0.6em }` (card.scss's own GENERIC rule) shifts the
        // poster's real content 0.6em right of `.card`'s own left edge.
        // That generic rule is overridden on the actual detail page by
        // a MORE SPECIFIC one in librarybrowser.scss:
        // `.detailImageContainer .card { .cardBox { margin: 0; } }`
        // - verified via real SCSS compilation and a full headless-
        // browser render: `.card`, `.cardBox`, `.cardScalable` and the
        // poster all land at the EXACT same pixel box. The `- 0.6em`
        // was removed entirely.
        //
        // CORRECTED SESSION 16 (explicit user finding + user-provided
        // Kodi skin XML AND the real XBMC/Kodi engine source, studied
        // directly): the ORIGINAL Kodi effect this project ports
        // (`rotatey`) does NOT use a per-object-centered camera the way
        // our own `perspective-origin` did until now. Verified directly
        // in `xbmc/guilib/GUIControl.cpp`: a control's own 3D camera
        // (`m_camera`) is only ever pushed onto the shared render-
        // context camera stack when the skin XML gives that SPECIFIC
        // control its own `<camera>` tag (`m_hasCamera`) - confirmed
        // absent anywhere in the user's own uploaded `ViewsRightList.xml`
        // (grepped case-insensitively for "camera", zero matches; the
        // user independently confirmed from memory that no separate
        // camera-defining file was ever used either). With no per-
        // control camera pushed, Kodi's render loop keeps using
        // whatever camera is ALREADY on top of the stack - traced to
        // `xbmc/windowing/GraphicContext.cpp`'s own stack reset:
        // `m_cameras.emplace(0.5f * m_iScreenWidth, 0.5f *
        // m_iScreenHeight)` - the EXACT SCREEN CENTER of the skin's own
        // base resolution, not the object's own center. This explains
        // the user's own visual observation precisely: in the real
        // Kodi skin, the case sits well away from screen center
        // (measured directly from the user's own XML: left=-8, top=98,
        // width=368, height=525, i.e. object center at roughly x=176,
        // y=360 on a 1920x1080 canvas whose center is 960,540) - a
        // camera fixed far from the object introduces perspective
        // distortion in BOTH width (already present in our own prior,
        // object-centered version) AND height (top/bottom edges tilt
        // relative to each other) - which our old object-centered
        // camera could mathematically never produce (proven directly:
        // a pure Y-axis rotation never changes any point's own Y
        // coordinate, so top and bottom edges ALWAYS scale by the
        // identical factor at each given X position regardless of
        // where perspective-origin's own Y sits, UNLESS the object
        // itself sits away from the camera's X position too - which is
        // exactly what a screen-fixed, off-object camera achieves).
        //
        // Ported as: perspective-origin's X targets the VIEWPORT'S OWN
        // horizontal center (50vw) instead of the hinge - independent
        // of case type entirely, since it no longer depends on the
        // Case Mod geometry at all, only on `.card`'s own fixed native
        // left position (3.3% desktop/tv, 5% mobile - both already
        // vw-equivalent per the reasoning above). The Y-component uses
        // 50vh as a documented approximation: `.card`'s own real
        // vertical position is NOT expressible in a clean, resize-safe
        // vh formula the way X is (its `top: -80%` resolves against
        // `.detailImageContainer`'s own height, which depends on
        // sibling page content, not a fixed viewport fraction) - and
        // since Kodi's own measured vertical offset (180px of 1080,
        // ~17%) is far smaller than its horizontal one (784px of 1920,
        // ~41%), this approximation captures the dominant part of the
        // real effect without requiring a JS runtime measurement (which
        // would break on window resize, unlike everything else here).
        function ensurePosterOriginStylesInjected(caseType, hingePct, leftPct, widthVw) {
            if (posterOriginClassesInjected[caseType]) { return; }
            posterOriginClassesInjected[caseType] = true;
            var cls = POSTER_ORIGIN_CLASS_PREFIX + caseType;
            var cardCls = CARD_PERSPECTIVE_CLASS_PREFIX + caseType;
            var shiftLeftVw = leftPct - 3.3;
            var mobileWidthVw = 30 * (widthVw / 25);
            var desktopTvTotalVw = shiftLeftVw + (hingePct / 100) * widthVw;
            var mobileTotalVw = shiftLeftVw + (hingePct / 100) * mobileWidthVw;

            // Screen-centered camera (session 16) - `.card`'s own fixed
            // base left position is 3.3% (desktop/tv) or 5% (mobile),
            // independent of case type; the viewport's own center is
            // 50vw, so the offset from `.card`'s own left edge to that
            // center is a single constant per layout, not per case type.
            var desktopTvCameraVw = 50 - 3.3;
            var mobileCameraVw = 50 - 5;

            var css = [
                // SESSION 16: transform-origin is now ALWAYS 0 0 (top
                // left) - the new matrix3d() (computeKodiMatrix3dString)
                // explicitly starts from this origin. The hinge effect
                // comes entirely from the matrix itself (hingeXPx), no
                // longer from transform-origin - if a percentage hinge
                // value were still set here, the browser would anchor
                // the matrix at the WRONG point and shift the result.
                '.layout-desktop .detailImageContainer .cardScalable.' + cls + ',',
                '.layout-tv .detailImageContainer .cardScalable.' + cls + ' {',
                '    transform-origin: 0 0;',
                '    perspective-origin: calc(' + desktopTvCameraVw + 'vw) 50vh;',
                '}',
                '.layout-mobile .detailImageContainer .cardScalable.' + cls + ' {',
                '    transform-origin: 0 0;',
                '    perspective-origin: calc(' + mobileCameraVw + 'vw) 50vh;',
                '}',
                // `.card` itself keeps its own, separately-declared
                // perspective-origin - it's a DIFFERENT element (the
                // one `perspective` for the front case box's own
                // foreshortening ultimately chains through). Same
                // screen-centered value as `.cardScalable`'s own above,
                // since both now target the viewport's own center
                // rather than either box's own position.
                //
                // REAL BUG FOUND AND FIXED (Session 17, user finding
                // "gets clipped top/bottom exactly at the vanilla poster
                // dimensions"): Jellyfin's own native card.scss sets
                // `.card:not(.show-animation) { contain: layout style
                // paint; }` - verified directly in the real source AND
                // by an isolated comparison test (identical matrix3d()
                // on `.cardScalable`, once with `contain: ...paint` on
                // the NON-rotating `.card` parent, once without: WITH
                // paint the area stayed a perfect, undistorted rectangle
                // at exactly the original size - the confirmed bug;
                // WITHOUT paint the correctly distorted 3D shape showed).
                // `contain: paint` clips everything that visually
                // extends beyond the OWN (here: unrotated, since `.card`
                // itself has NO transform) box - exactly the "stays
                // square, clipped at the old edge" the user described,
                // although the actual rotation/position of .cardScalable
                // was demonstrably (verified via debug log over all
                // frames) exactly correct. Fix: force contain WITHOUT
                // paint on .card while our own classes are active - our
                // own selector specificity (4 classes) is already higher
                // than the native rule (.card:not(...), 2-class
                // equivalent), !important additionally as a safeguard
                // against other/later rules.
                // CURSOR FIX (Session 18, user finding: "when the case
                // is open the cursor changes to the pointing hand, that
                // is completely unnecessary"): Jellyfin's own native
                // card.scss sets `cursor: pointer;` directly on `.card`
                // (line 23, same rule neighbourhood as the contain:paint
                // finding above) - makes sense on a library tile (a
                // click navigates to the detail page there), but has no
                // function on THIS detail page itself, just a visual
                // leftover. Same override logic as for contain above.
                '.layout-desktop .detailImageContainer .card.' + cardCls + ',',
                '.layout-tv .detailImageContainer .card.' + cardCls + ' {',
                '    perspective-origin: calc(' + desktopTvCameraVw + 'vw) 50vh;',
                '    contain: layout style !important;',
                '    cursor: default !important;',
                '}',
                '.layout-mobile .detailImageContainer .card.' + cardCls + ' {',
                '    perspective-origin: calc(' + mobileCameraVw + 'vw) 50vh;',
                '    contain: layout style !important;',
                '    cursor: default !important;',
                '}'
            ].join('\n');

            var styleEl = document.createElement('style');
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        }


        // Disc sized styles (session 12) - same top-vw-offset-from-
        // poster-base + left% pattern as the Case box
        // (ensureSizedStylesInjected above), but width AND height both
        // get the SAME single `sizeVw` value (explicit user correction:
        // "kein Stretch da die disc 1:1 ist" - no independent
        // width/height, or a circular disc would render as an oval).
        // Session 121: same geometry-keyed class as the case box (sweep of
        // the same pattern) - the disc geometry does not differ per item
        // type today, but a per-type cache would fix the first geometry seen.
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
                '}',
                '.layout-mobile .detailImageContainer .' + cls + ' {',
                '    left: calc(5% + ' + shiftLeftPct + '%);',
                '}',
                '.layout-desktop .detailImageContainer .' + cls + ' {',
                '    left: ' + leftPct + '%;',
                '    top: calc(-80% + ' + topVwOffset + 'vw);',
                '}',
                '.layout-tv .detailImageContainer .' + cls + ' {',
                '    left: calc(5% + ' + shiftLeftPct + '%);',
                '    top: 50%;',
                '    transform: translateY(calc(-50% + ' + topVwOffset + 'vw));',
                '}',
                '@media all and (max-width: 62.5em) {',
                '    .layout-desktop .detailImageContainer .' + cls + ',',
                '    .layout-tv .detailImageContainer .' + cls + ' {',
                '        top: calc(10% + ' + topVwOffset + 'vw);',
                '    }',
                '}',
                '[dir="rtl"] .detailImageContainer .' + cls + ' { left: unset; }',
                '[dir="rtl"] .layout-mobile .detailImageContainer .' + cls + ',',
                '[dir="rtl"] .layout-tv .detailImageContainer .' + cls + ' { right: calc(5% + ' + shiftLeftPct + '%); }',
                '[dir="rtl"] .layout-desktop .detailImageContainer .' + cls + ' { right: ' + leftPct + '%; }'
            ].join('\n');

            var styleEl = document.createElement('style');
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        }

        /**
         * Removes any stale overlay left behind by a PREVIOUS navigation
         * - called unconditionally at the start of every new navigation
         * attempt, BEFORE the new item's own applicability is even
         * known. Real bug class this specifically guards against (found
         * the hard way, in this same plugin, for the Logo overlays - see
         * that feature's own curriculum milestone): a stale element only
         * ever gets cleaned up as a side effect of the SAME feature
         * reaching a certain point again on a LATER navigation - which
         * never happens if that later navigation's own item isn't
         * applicable at all. Calling this removal unconditionally, every
         * single time, regardless of outcome, sidesteps that whole bug
         * class entirely rather than trying to catch every early-return
         * path. Removes the whole BOX (not just the inner overlay image)
         * since the box itself is now our own dedicated element, not a
         * repurposed piece of Jellyfin's own DOM.
         */

        // All three POSTER_ORIGIN_CLASS_PREFIX+type classes, listed
        // explicitly - only 3 case types exist, cheaper and clearer
        // than deriving this list from HINGE_ORIGIN_X_PERCENT's own
        // keys at cleanup time.
        var ALL_POSTER_ORIGIN_CLASSES = [
            POSTER_ORIGIN_CLASS_PREFIX + 'vivaelitecases',
            POSTER_ORIGIN_CLASS_PREFIX + 'clearcases',
            POSTER_ORIGIN_CLASS_PREFIX + 'vortexcases',
            // Session 44 FIX (real bug, user finding "both visible at
            // the same time"): vivaelite3dcases was missing here
            // completely - its own class was NEVER removed again after
            // being set, so it stayed on .cardScalable across EVERY
            // following navigation, whatever case type came next.
            POSTER_ORIGIN_CLASS_PREFIX + 'vivaelite3dcases'
        ];
        // Same list, for .card's own perspective-origin class (FIX,
        // this session) - see ensurePosterOriginStylesInjected's own
        // doc comment.
        var ALL_CARD_PERSPECTIVE_CLASSES = [
            CARD_PERSPECTIVE_CLASS_PREFIX + 'vivaelitecases',
            CARD_PERSPECTIVE_CLASS_PREFIX + 'clearcases',
            CARD_PERSPECTIVE_CLASS_PREFIX + 'vortexcases',
            // Session 44 FIX - same reason as for
            // ALL_POSTER_ORIGIN_CLASSES above.
            CARD_PERSPECTIVE_CLASS_PREFIX + 'vivaelite3dcases'
        ];

        // SESSION 16: module-wide (not per-check closure-local)
        // reference to the currently running rotation - enables
        // IMMEDIATE cancellation on every new navigation instead of
        // relying solely on the own generation check IN the next rAF
        // tick. Without it an old, "actually already invalid" rAF loop
        // stays actively registered until its next tick - reproducibly
        // proven by an isolated minimal test that an actively running
        // requestAnimationFrame loop measurably destabilizes the
        // precision of parallel setTimeout boundaries under
        // Playwright's simulated clock (0/30 premature firings without
        // an active rAF loop, 17/30 WITH an active rAF loop in the
        // exact same test setup) - not just a theoretical cleanup
        // detail but the proven cause of observed flakiness in the own
        // test suite.
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
            // Session 44 FIX: discPreviewBox carried NO BOX_CLASS (only
            // innerCaseBox did) - so it stayed behind on every
            // navigation, whatever item, whatever case type. Own,
            // explicit cleanup, independent of whether BOX_CLASS is ever
            // included or not.
            document.querySelectorAll('.detailImageContainer .' + TUNE_PREVIEW_CLASS).forEach(function (el) {
                el.remove();
            });
            // FIX (this session): no more wrapping/unwrapping -
            // POSTER_ROTATE_CLASS and the per-type origin class now go
            // directly on `.cardScalable` (the real, native, never-
            // reparented common ancestor of the poster, Extraposter's
            // own overlay layers, and the Keyart/Extrakeyart logo - see
            // POSTER_ROTATE_CLASS's own doc comment above for the full
            // architecture reasoning). Unconditional cleanup on every
            // navigation, same reasoning as before: `.cardScalable` is
            // a real, reused native element, never itself removed/
            // recreated, so a PREVIOUS item's Case must never leave its
            // classes behind on an item that has no Case at all.
            document.querySelectorAll('.detailImageContainer .cardScalable').forEach(function (el) {
                el.classList.remove(POSTER_ROTATE_CLASS);
                el.classList.remove(ROTATOR_OPEN_CLASS);
                el.classList.remove.apply(el.classList, ALL_POSTER_ORIGIN_CLASSES);
                // Session 44 FIX: TuneHidePoster sets opacity directly
                // as an inline style on this real, never re-created
                // element - without a reset here the poster would stay
                // invisible for EVERY following item, not only 3D-case
                // items.
                el.style.opacity = '';
                el.style.transform = '';
                el.style.transformOrigin = '';
            });
            // FIX (this session): "Open Case on Click" attaches a click
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
            // origin class (FIX, this session).
            document.querySelectorAll('.detailImageContainer .card').forEach(function (el) {
                el.classList.remove.apply(el.classList, ALL_CARD_PERSPECTIVE_CLASSES);
            });
            // Background padder (explicit user finding) - same
            // unconditional-cleanup reasoning: `.cardPadder` is a real,
            // reused native element too.
            document.querySelectorAll('.detailImageContainer .cardPadder').forEach(function (el) {
                el.classList.remove(PADDER_HIDE_CLASS);
            });
        }

        // SESSION 20: `coord` is the SAME poster-arbiter coordinator
        // object Custom/Animated/Extra already use - CaseMod receives
        // it PURELY to read `coord.decisionPromise`/
        // posterArbiterIsDecisionPending(coord) further below (Back/
        // Disc's own start), never to register a participant, set a
        // fallback url, or otherwise write into it. The dependency
        // runs strictly one way: poster-arbiter state -> CaseMod, never
        // the reverse - CaseMod cannot influence which poster type
        // wins or when.
        async function check(coord, itemId, posterEl, myGeneration) {
            removeExistingOverlay();
            var holdView = posterEl.closest ? posterEl.closest('.itemDetailPage') : null;
            if (holdView && caseTiltExpected() && caseTiltHold.view !== holdView) { caseModHoldPoster(holdView); }

            var response;
            try {
                response = await fetch('/CaseMod/' + encodeURIComponent(itemId), { cache: 'no-store' })
                    .then(function (r) { return r.json(); });
            } catch (e) {
                log('Fetch error', e);
                caseModReleasePoster();
                return;
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
            // inside it, and the one with the clipping problem this
            // whole rework exists to avoid). Our own box becomes this
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

            // SESSION 18 (admin menu overhaul): the old separate "Enable
            // Open Case" master switch (response.OpenCaseEnabled) is
            // gone - Open Case is now active whenever at least one of
            // its two triggers is on. That combined boolean also
            // decides whether the real poster (+ Keyart/Extrakeyart
            // logo) swings open together with it, and whether the Disc
            // is included at all. Computed once up front since several
            // branches below need it.
            var animateOpen = !!((response.OpenCaseDelayEnabled || response.OpenCaseOnClickEnabled) && response.HasDiscart);

            var frontTextureUrl = '/CaseMod/Texture/'
                + encodeURIComponent(response.CaseType) + '/'
                + encodeURIComponent(response.TextureKey);
            var backTextureUrl = '/CaseMod/Texture/'
                + encodeURIComponent(response.CaseType) + '/'
                + encodeURIComponent(response.BackTextureKey);
            // Standard Jellyfin image endpoint (verified directly
            // against Jellyfin.Api's own ImageController.GetItemImage -
            // no [Authorize] on the route, the exact same mechanism
            // every native poster/backdrop/logo <img> already uses) -
            // no dedicated CaseMod endpoint needed for the disc itself.
            var discImageUrl = '/Items/' + encodeURIComponent(itemId) + '/Images/Disc';

            // Small local helper - front and back box are structurally
            // identical (same BOX_CLASS, same per-case-type sized
            // geometry class, same 100%-filling <img>), differing only
            // in their layer modifier class and texture. `fadeIn`
            // (Session 21, explicit user request): Front/Back start at
            // opacity:0 with a transition already attached, so calling
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
                return b;
            }

            // Explicit user request: Front and Back fade in over 200ms
            // instead of popping in hard - Disc excluded (see buildBox's
            // own doc comment above for why). Same technique already
            // proven correct elsewhere in this file (see ExtraModule's
            // own crossfade, e.g. its makeLayer()/showNext()): a plain
            // single opacity:0->1 flip in the same tick as the element's
            // own creation/append risks the browser coalescing both
            // style changes into one paint, meaning the transition never
            // becomes visible at all (the exact failure mode the user
            // explicitly flagged from past experience) - a DOUBLE
            // requestAnimationFrame guarantees at least one full paint
            // of the opacity:0 starting state has already happened
            // before opacity flips to 1, so the browser has something
            // to actually transition FROM. Generation/liveness re-
            // checked at the point the fade actually starts, not just
            // at append time - if the user has since navigated away in
            // the one-or-two-frame gap, nothing fires on the old page.
            function fadeInBox(box) {
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        if (myGeneration !== currentGeneration() || !document.body.contains(box)) { return; }
                        box.style.opacity = '1';
                    });
                });
            }

            var frontSizedClass = sizedClassName(response.CaseType, response.TopPercent, response.LeftPercent, response.WidthVw, response.HeightVw);

            // SESSION 19 (performance): Front is now the ONLY thing the
            // visible-case path waits on - Back and Disc are proven, by
            // exhaustive code-level dependency analysis, to never be
            // read by anything in the Front/Rotator setup below (Back is
            // written once and never referenced again anywhere in this
            // file; Disc is only read much later, inside
            // startOpenCaseAnimation()/endOpenCaseAnimation(), themselves
            // only reachable after a delay or a click - never during
            // this initial render). Moving Back/Disc off the AWAITED
            // path removes real time from the critical path to first
            // visible paint (previously: API + Front + Back + Disc; now:
            // API + Front only) without changing what either one does
            // once it does load - see this session's own research
            // entries in the curriculum for the full before/after
            // analysis and the exact code-reference proof.
            try {
                await Core.preloadImage(frontTextureUrl);
            } catch (e) {
                log('Texture preload failed, skipping', e);
                return;
            }

            // Same generation/liveness guard as before, just moved
            // earlier - this now protects Front's own append (the
            // previous single combined check further down still exists,
            // now guarding Back/Disc's own appends instead - see below).
            if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }

            // Front cover, with the Open Case animation (explicit user
            // request, porting a Kodi skin's own rotatey effect - see
            // ensureStylesInjected's own doc comment). Gating (explicit
            // user requirement): the animation runs ONLY when BOTH the
            // admin-side Open Case checkbox is on AND the item actually
            // has a discart - a case with nothing inside to reveal
            // stays static. The rotator's per-case-type transform-
            // origin (HINGE_ORIGIN_X_PERCENT, injected in
            // ensureSizedStylesInjected) puts the hinge on the
            // texture's own measured visible left edge instead of the
            // old 0% box edge. ROTATOR_HOST_CLASS stays required - it
            // exists purely for the separate, confirmed browser quirk
            // where `perspective` set directly on the rotated element's
            // own parent breaks the rotation (see ensureStylesInjected's
            // own doc comment).
            var frontBox = buildBox(BOX_FRONT_CLASS, frontSizedClass, frontTextureUrl, true);
            var rotator = null;
            var cardScalableEl = null;
            var padderEl = null;
            var discBox = null;
            if (animateOpen) {
                var frontImg = frontBox.firstChild;
                var rotatorHost = document.createElement('div');
                rotatorHost.className = ROTATOR_HOST_CLASS;
                // FIX (this session): ROTATOR_CLASS alone now, WITHOUT
                // ROTATOR_OPEN_CLASS - the structure is built
                // immediately, but the animation itself only starts
                // once startOpenCaseAnimation() below actually runs
                // (via the admin-configurable delay and/or a valid
                // poster click - see PluginConfiguration's own
                // CaseModOpenCaseDelayEnabled/OnClickEnabled doc
                // comments). ensureStylesInjected's own CSS already
                // requires BOTH classes together for the animation to
                // apply, so this alone is inert until then.
                rotator = document.createElement('div');
                rotator.className = ROTATOR_CLASS;
                rotator.appendChild(frontImg);
                rotatorHost.appendChild(rotator);
                frontBox.appendChild(rotatorHost);

                // Session 14 (corrected, deep-verification pass): the
                // real poster, any Extraposter overlay layers, and the
                // Keyart/Extrakeyart logo overlay (if present) all swing
                // open TOGETHER with the front cover as one rigid unit -
                // achieved by rotating `.cardScalable` itself (the real,
                // native, never-reparented common ancestor of all three
                // - see POSTER_ROTATE_CLASS's own doc comment for the
                // full architecture reasoning and verification). No
                // per-element wrapping/tracking needed: whichever poster
                // source or overlay currently lives inside
                // `.cardScalable` moves with it automatically, since
                // it's a real, physical DOM ancestor being rotated, not
                // a set of individually-classed elements.
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
                // `.card` itself gets the matching perspective-origin
                // class - see ensurePosterOriginStylesInjected's own
                // doc comment. `perspective` lives on `.card`, so its
                // own perspective-origin must be set there too,
                // separate from `.cardScalable`'s own declaration.
                realCard.classList.add(CARD_PERSPECTIVE_CLASS_PREFIX + response.CaseType);

                // Background padder (explicit user finding - see
                // ensureStylesInjected's own doc comment for the full
                // reasoning) - the HIDE class itself is only added once
                // the animation actually starts (see
                // startOpenCaseAnimation() below), not eagerly here.
                padderEl = realCard.querySelector('.cardPadder');
            }

            detailImageContainer.appendChild(frontBox);
            fadeInBox(frontBox);

            // Session 43: Case Angle is now a permanent, admin-editable
            // field (response.CaseAngleDegrees) instead of a hard-wired
            // value. The sign determines the hinge side: negative =
            // right (93.128%, user-confirmed), positive = left
            // (mirrored, 6.872%). At exactly 0 the side has no effect
            // (nothing visible), the code then simply picks the right
            // side.
            //
            // Hinge sharing follows the same, already proven principle
            // as for opening: ONE shared hingeXPx (measured from the
            // case box itself), passed on to case, poster, inner case
            // AND disc - otherwise they would tilt around different
            // axes and visibly drift apart.
            //
            // Session 50 FIX: applyTilt() now lives HERE, outside the
            // following if block - 'use strict' makes a function
            // declaration INSIDE a block block-scoped (unlike var, which
            // stays function-scoped), so it was not reachable at all
            // from backBox's own .then() further down (see there). The
            // tiltAngle/tiltHingeXPx/tiltScreenW/H/tiltCameraX/Y
            // variables themselves are still var (function-scoped), so
            // unaffected - only the function itself had to move out.
            var tiltAngle, tiltHingeXPx, tiltScreenW, tiltScreenH, tiltCameraX, tiltCameraY, tiltPosterRect;
            var tiltTarget = null, tiltFrontRect = null, tiltHingePct = 0, tiltCardScalableEl = null;
            var scheduleInnerCaseDiscPreview = null;
            // Session 65: applyTilt() rotates around the REAL right
            // spine again (as originally, before Session 64) - no
            // compensation needed any more, since
            // computeNestedKodiMatrix3dString (Open Case, see
            // runRotationFrame) reduces exactly to this same pure
            // rotation at openAngle=0. Rest tilt and Open Case now use
            // the same, CORRECT maths instead of an approximated
            // compensation.
            function applyTilt(el, rect) {
                el.style.transformOrigin = '0 0';
                el.style.transform = computeKodiMatrix3dString(
                    tiltAngle, tiltHingeXPx, rect.left, rect.top,
                    tiltScreenW, tiltScreenH, tiltCameraX, tiltCameraY
                );
                if (tiltedEls.indexOf(el) === -1) { tiltedEls.push(el); }
            }

            // Session 121 (user: "manchmal ein Parallelogramm statt Trapez"):
            // the Kodi matrix bakes ABSOLUTE viewport coordinates in
            // (rect.left/top, hinge px, screen size, camera centre) measured
            // ONCE right after the box was appended. If that measurement
            // was taken before the page settled (poster decode, padder
            // toggle, scroll restore, late fonts) or the viewport changed
            // afterwards (resize, scroll), the perspective divide runs
            // against a wrong Y - the trapezoid degenerates into a sheared
            // parallelogram. retilt() re-measures every tilted element
            // UNTRANSFORMED (transform cleared, measured, re-applied inside
            // one frame - no visible flicker) and re-applies the matrix; it
            // runs at settle points and on resize/scroll, never while the
            // Open Case animation holds the rotator.
            var tiltedEls = [];
            var retiltQueued = null;
            function retilt() {
                retiltQueued = null;
                if (myGeneration !== currentGeneration()) { return; }
                if (!tiltTarget || !document.body.contains(tiltTarget)) { return; }
                if (rotator && rotator.classList.contains(ROTATOR_OPEN_CLASS)) { return; }
                tiltedEls = tiltedEls.filter(function (el) { return document.body.contains(el); });
                // The rotator/poster carry a CSS transition on transform (Open
                // Case) - clearing and re-setting would ANIMATE from flat
                // (user: "erst 0 Grad flach, dann die Rotation"). Transition
                // off for the re-measure, reflow, restore afterwards.
                var savedTransitions = tiltedEls.map(function (el) { return el.style.transition; });
                tiltedEls.forEach(function (el) { el.style.transition = 'none'; el.style.transform = ''; });
                var rect = tiltTarget.getBoundingClientRect();
                if (rect.width && rect.height) {
                    tiltScreenW = window.innerWidth; tiltScreenH = window.innerHeight;
                    tiltHingeXPx = rect.left + (tiltHingePct / 100) * rect.width;
                    tiltCameraX = tiltScreenW * 0.5; tiltCameraY = tiltScreenH * 0.5;
                    tiltFrontRect = rect;
                    if (tiltCardScalableEl && document.body.contains(tiltCardScalableEl)) { tiltPosterRect = tiltCardScalableEl.getBoundingClientRect(); }
                }
                tiltedEls.forEach(function (el) { applyTilt(el, el.getBoundingClientRect()); });
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
                // Session 53 FIX (user finding: "front duplicate, not a
                // back-texture mix-up"): frontBox itself must NOT get
                // the tilt when Open Case is active - as soon as
                // animateOpen is true, the actual image moves into
                // "rotator" (child of frontBox), and Open Case's own
                // animation SEPARATELY sets rotator.style.transform with
                // its own absolute matrix. Both transforms (parent tilt
                // on frontBox + the child's own absolute matrix on
                // rotator) then stacked incorrectly - CSS transforms on
                // a child are relative to the parent's already
                // transformed coordinate space, but
                // computeKodiMatrix3dString computes in absolute
                // viewport coordinates as if rotator itself were
                // undeformed. Result: the same front graphic was drawn
                // twice, contradictorily distorted - looked like a copy.
                // Fix: with Open Case active "rotator" itself gets the
                // rest tilt (the same element the opening animation
                // moves) - frontBox (the outer, never transformed
                // wrapper) stays untouched. Without Open Case (rotator
                // == null) unchanged as before: frontBox directly.
                tiltTarget = rotator || frontBox;
                tiltFrontRect = tiltTarget.getBoundingClientRect();
                tiltHingePct = HINGE_ORIGIN_X_PERCENT[tiltHingeKey] || 0;
                tiltScreenW = window.innerWidth; tiltScreenH = window.innerHeight;
                tiltHingeXPx = tiltFrontRect.left + (tiltHingePct / 100) * tiltFrontRect.width;
                tiltCameraX = tiltScreenW * 0.5; tiltCameraY = tiltScreenH * 0.5;

                applyTilt(tiltTarget, tiltFrontRect);
                if (tiltCardScalableEl) {
                    ensurePosterOriginStylesInjected(
                        response.CaseType,
                        tiltHingePct,
                        response.LeftPercent, response.WidthVw
                    );
                    tiltCardScalableEl.classList.add(POSTER_ORIGIN_CLASS_PREFIX + response.CaseType);
                    realCard.classList.add(CARD_PERSPECTIVE_CLASS_PREFIX + response.CaseType);
                    // Session 53: cache the rect BEFORE the tilt (see the
                    // tiltFrontRect comment above, same reason) -
                    // measureGeometryFor() further down needs this
                    // undeformed value again, not a later, already
                    // tilted re-measurement.
                    tiltPosterRect = tiltCardScalableEl.getBoundingClientRect();
                    applyTilt(tiltCardScalableEl, tiltPosterRect);
                }
                if (response.TuneHidePoster && tiltCardScalableEl) {
                    tiltCardScalableEl.style.opacity = '0';
                }
                caseModReleasePoster(); // tilt is on - the poster may appear now, already tilted
                // Settle passes + viewport listeners (Session 121, see retilt()).
                navTimers.track(setTimeout(queueRetilt, 250));
                navTimers.track(setTimeout(queueRetilt, 1200));
                var onViewportChange = function () {
                    if (myGeneration !== currentGeneration()) {
                        window.removeEventListener('resize', onViewportChange);
                        document.removeEventListener('scroll', onViewportChange, true);
                        return;
                    }
                    queueRetilt();
                };
                window.addEventListener('resize', onViewportChange);
                document.addEventListener('scroll', onViewportChange, true);
                if (window.ResizeObserver && realCard) {
                    var tiltRo = new ResizeObserver(function () {
                        if (myGeneration !== currentGeneration()) { tiltRo.disconnect(); return; }
                        queueRetilt();
                    });
                    tiltRo.observe(realCard);
                }

                // Session 66 (user finding: "on fast page changes I see
                // the inner-case texture and discart in the background"
                // + "if Open Case is not enabled we don't need to load
                // inner case/discart at all"): two separate
                // improvements.
                //
                // 1) Inner-case/disc preview are pure tuning aids for
                // the Open Case alignment - without active Open Case
                // (animateOpen) there is nothing to tune, hence nothing
                // to load. Skipped completely for all items without
                // Open Case.
                //
                // 2) When Open Case is active they are now queued into
                // the same "front-first" loading chain backBox/discBox
                // already use (posterDecisionSettled + preload BEFORE
                // appending) - no longer created immediately/
                // synchronously with the front. Prevents the brief flash
                // on fast page changes while front+poster are already
                // visible but inner case/disc have not loaded yet.
                if (animateOpen) {
                    // The inside view is always borrowed from the Viva
                    // Elite folder, which has no Set artwork of its own
                    // (Sets use "p" there). Found live in Session 115:
                    // vivaelitecases/back_set 404 -> no inner case on
                    // BoxSets (lesson E1, an unmapped enumeration). The
                    // user picked back_tvseries (gold) as the inside for
                    // the green 3D Set case - back_p is red and clashes.
                    var innerKey = response.BackTextureKey === 'back_set' ? 'back_tvseries' : response.BackTextureKey;
                    var innerImgUrl = '/CaseMod/Texture/vivaelitecases/' + encodeURIComponent(innerKey);
                    var discPreviewImgUrl = '/Items/' + encodeURIComponent(itemId) + '/Images/Disc';
                    // Session 66 FIX: posterDecisionSettled is only
                    // actually assigned further down (near Back/Disc) -
                    // at THIS point in the code it would still be
                    // undefined despite var hoisting, since the
                    // assignment itself happens LATER in execution
                    // order. Hence only defined as a function here
                    // (closes over innerImgUrl/discPreviewImgUrl
                    // correctly) - the actual call happens further down,
                    // TOGETHER with Back/Disc, right after
                    // posterDecisionSettled got its real value.
                    scheduleInnerCaseDiscPreview = function () {
                    posterDecisionSettled.then(function () {
                        return Promise.all([
                            Core.preloadImage(innerImgUrl),
                            Core.preloadImage(discPreviewImgUrl)
                        ]);
                    }).then(function () {
                        if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }

                        // Session 43: inner case (reuses the
                        // vivaelitecases graphic 1:1, only its own
                        // position) and disc - both normally hidden
                        // BEHIND the front (z-index lower than
                        // frontBox), brought to the front only by the
                        // two TEMPORARY preview switches so the admin
                        // can align them against the front. Both get
                        // the same applyTilt() as above - otherwise they
                        // would visibly drift apart when case+poster
                        // tilt.
                        var innerCaseBox = document.createElement('div');
                        innerCaseBox.className = BOX_CLASS + ' ' + BOX_FRONT_CLASS + ' ' + TUNE_PREVIEW_CLASS;
                        innerCaseBox.style.position = 'absolute';
                        innerCaseBox.style.top = 'calc(-80% + ' + response.InnerCaseTopPercent + 'vw)';
                        innerCaseBox.style.left = response.InnerCaseLeftPercent + '%';
                        innerCaseBox.style.width = response.InnerCaseWidthVw + 'vw';
                        innerCaseBox.style.height = response.InnerCaseHeightVw + 'vw';
                        // Session 46 FIX (real bug, user finding: "still
                        // shown with Viva Elite 3D Case too"): a low
                        // z-index only means "lies behind", NOT
                        // "invisible" - the front texture has a
                        // transparent centre (for the real poster)
                        // through which the inner-case graphic simply
                        // shines, regardless of stacking order. Real
                        // hiding needs visibility:hidden (not
                        // display:none - that would reset
                        // getBoundingClientRect() below for the tilt
                        // matrix to all zeros, since display:none
                        // removes the element from the layout entirely).
                        // Session 55 (user request: "I also need it the
                        // way it will natively be, without compiling
                        // again"): unchecked now NO longer means
                        // "completely gone" but "at the final, real
                        // position" - z-index 1 already lies correctly
                        // BEHIND both BOX_BACK_CLASS (2) and the real
                        // poster (.card, native Jellyfin z-index 3) -
                        // that was always set correctly. The only reason
                        // unchecked was "invisible" instead of "natively
                        // visible" so far is visibility:hidden - switched
                        // to visible so it actually shines through the
                        // transparent centre of the front (meant for the
                        // poster) and everywhere else nothing native
                        // covers it.
                        innerCaseBox.style.zIndex = response.TuneShowInnerCase ? '999' : '1';
                        innerCaseBox.style.visibility = 'visible';
                        var innerImg = document.createElement('img');
                        innerImg.style.width = '100%';
                        innerImg.style.height = '100%';
                        // Session 46 FIX (user clarification: "it should
                        // show the back case of the non-3D case"): inner
                        // case means the INSIDE VIEW of the reused Viva
                        // Elite case (i.e. its back/interior texture),
                        // not its front/cover. Use BackTextureKey instead
                        // of TextureKey.
                        innerImg.src = innerImgUrl;
                        innerCaseBox.appendChild(innerImg);
                        detailImageContainer.appendChild(innerCaseBox);
                        applyTilt(innerCaseBox, innerCaseBox.getBoundingClientRect());

                        var discPreviewBox = document.createElement('div');
                        discPreviewBox.className = TUNE_PREVIEW_CLASS;
                        discPreviewBox.style.position = 'absolute';
                        discPreviewBox.style.top = 'calc(-80% + ' + response.DiscTopPercent + 'vw)';
                        discPreviewBox.style.left = response.DiscLeftPercent + '%';
                        discPreviewBox.style.width = response.DiscSizeVw + 'vw';
                        discPreviewBox.style.height = response.DiscSizeVw + 'vw';
                        discPreviewBox.style.zIndex = response.TuneShowDisc ? '999' : '1';
                        discPreviewBox.style.visibility = response.TuneShowDisc ? 'visible' : 'hidden';
                        var discImg = document.createElement('img');
                        discImg.style.width = '100%';
                        discImg.style.height = '100%';
                        discImg.src = discPreviewImgUrl;
                        discPreviewBox.appendChild(discImg);
                        detailImageContainer.appendChild(discPreviewBox);
                        applyTilt(discPreviewBox, discPreviewBox.getBoundingClientRect());
                    }).catch(function (e) {
                        log('Inner case/disc preview preload failed, skipping', e);
                    });
                    };
                }
            }
            // ═══ FRONT IS NOW VISIBLE - everything below either sets up
            // triggers for LATER interaction, or loads Back/Disc in the
            // background without blocking anything already painted. ═══

            // FIX (this session): starts the ENTIRE synchronized effect
            // (front cover rotation, poster+keyart rotation, padder
            // hide, disc spin) in one JS tick, whichever of the two
            // independent triggers (delay, click) fires first.
            // Explicit user requirement: exactly ONE of the two
            // triggers may fire the SAME cycle - `started` guards
            // against a click firing after the delay already did (or
            // vice versa), and against a second click while the cycle
            // is still running. Once the full 8s cycle completes
            // (animationend on the rotator, the most reliable single
            // signal all four pieces share exactly one 8000ms duration
            // with), `started` resets - explicit user point was only
            // that a click DURING a running animation is ignored, not
            // that the whole feature is a one-shot per page view; a
            // fresh click after the door is fully closed again is a
            // perfectly reasonable, expected re-trigger.
            if (animateOpen) {
                var started = false;

                // Same easing as before via CSS (exact cubic Bezier
                // equivalent of "quadratic ease-out", derived and
                // verified in that session) - here as a JS function,
                // since the rotation now sets the Kodi matrix per frame
                // instead of a pure CSS rotateY().
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

                // Session 62 (real matrix composition, user
                // requirement: "it should look as good as possible" -
                // not the previous hinge-interpolation crutch discarded
                // here): the angle hinge (rest tilt, right) and the Open
                // Case hinge (left) are two GENUINELY different pivots.
                // restAngle stays a CONSTANT HERE over the whole
                // animation (no interpolation of this part any more) -
                // only the OPENING PART (0 to toOpenAngle or reverse) is
                // interpolated. Every frame composes both rotations anew
                // via real matrix multiplication - for the other three
                // case types (no rest hinge set) it falls back unchanged
                // to the simple, single rotation.
                // Session 64 (replaced the Session 62 composition) tried
                // sharing ONE axis (tiltHingeXPx, left) with a fixed
                // compensation offset; Session 65 replaced that in turn
                // by the nested composition in
                // computeNestedKodiMatrix3dString (the left hinge is
                // rotated along with the static tilt) - see
                // runRotationFrame's frame() body.
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

                // BUG FOUND AND FIXED (Session 16, uncovered by the own
                // "hinge agreement" test, not a pure test-update case):
                // hingeXPx used to be computed for EVERY element
                // independently from its OWN width (hingePct% of
                // rect.width). That is only correct for the case box
                // itself, since HINGE_ORIGIN_X_PERCENT was measured as a
                // percentage of ITS texture width. For the poster (a
                // different, smaller box) the same formula yielded a
                // DIFFERENT absolute world-coordinate point than for the
                // case box - case and poster would have swung around two
                // different axes when opening and visibly drifted apart.
                // Fix: hingeXPxOverride allows adopting the same
                // absolute point already computed from the case box for
                // the poster, instead of recomputing it (wrongly) there.
                function measureGeometryFor(el, hingeXPxOverride) {
                    // Session 53 FIX: with "Viva Elite 3D Case"
                    // rotator/cardScalableEl have already received the
                    // static rest tilt at this point - a NEW
                    // getBoundingClientRect() measurement now would
                    // yield the ALREADY tilted, shifted position instead
                    // of the original flat one. Reuse the rects cached
                    // before the tilt (tiltFrontRect/tiltPosterRect)
                    // instead of measuring anew (and wrongly) here.
                    var rect = el.getBoundingClientRect();
                    if (response.CaseType === 'vivaelite3dcases') {
                        if (el === rotator && tiltFrontRect) { rect = tiltFrontRect; }
                        else if (el === cardScalableEl && tiltPosterRect) { rect = tiltPosterRect; }
                    }
                    // Session 53 FIX (user clarification: there are TWO
                    // separate hinges - the RIGID angle hinge (Case
                    // Angle, rest tilt, further up in the code, RIGHT,
                    // measured in Session 42) and the MOVING Open Case
                    // hinge (here, the opening animation itself). The
                    // user wants Open Case to open from the LEFT EXACTLY
                    // LIKE THE OTHER THREE case types ("like a book from
                    // the front") - completely independent of which side
                    // the angle hinge sits on. Hence no
                    // CaseAngleDegrees sign check HERE any more - always
                    // left, kept separate from HINGE_ORIGIN_X_PERCENT so
                    // later tuning does not shift the other values.
                    // Session 59: really measured (no longer a
                    // placeholder) - pixel-exact alpha scan of 1080p.png
                    // (422px wide): columns 0-5 completely transparent,
                    // column 6 antialiasing transition, column 7 real
                    // texture start (609/625 rows already fully opaque).
                    // 7 / 422 * 100 = 1.659%.
                    var hingePct = (response.CaseType === 'vivaelite3dcases')
                        ? 1.659
                        : (HINGE_ORIGIN_X_PERCENT[response.CaseType] || 0);
                    var screenW = window.innerWidth, screenH = window.innerHeight;
                    var hingeXPx = (hingeXPxOverride !== undefined)
                        ? hingeXPxOverride
                        : rect.left + (hingePct / 100) * rect.width;
                    return {
                        ctrlLeft: rect.left, ctrlTop: rect.top,
                        ctrlW: rect.width, ctrlH: rect.height,
                        hingeXPx: hingeXPx,
                        screenW: screenW, screenH: screenH,
                        cameraX: screenW * 0.5, cameraY: screenH * 0.5
                    };
                }

                function startOpenCaseAnimation() {
                    if (started) { return; }
                    if (myGeneration !== currentGeneration()) { return; }
                    started = true;
                    rotator.classList.add(ROTATOR_OPEN_CLASS);
                    if (cardScalableEl) { cardScalableEl.classList.add(ROTATOR_OPEN_CLASS); }
                    if (padderEl) { padderEl.classList.add(PADDER_HIDE_CLASS); }
                    if (discBox && response.SpinningDiscEnabled) {
                        discBox.firstChild.classList.add(discSpinClassFor(response.SpinningDirection));
                    }
                    // SESSION 16: the actual 3D rotation now runs per rAF
                    // through the verified Kodi matrix instead of pure
                    // CSS rotateY() - geometry is measured ONCE at the
                    // start (angle=0, unrotated state, exactly the "known
                    // real value" from that session's own verification),
                    // the camera stays fixed at the screen centre (Kodi's
                    // own default without a <camera> tag). Timeline:
                    // 0-1000ms open (from OpenAngleDegrees), 1000-7000ms
                    // hold (the last matrix state simply stays, no
                    // further rAF tick needed), 7000-8000ms close again -
                    // exactly the same key points as the previous
                    // @keyframes.
                    //
                    // SIGN (user finding from a real test: the case
                    // folded INWARDS instead of OUTWARDS like a book):
                    // our own setYRotationMatrix moves the far edge to
                    // LARGER Z at a POSITIVE angle - and our camera sits
                    // at NEGATIVE Z, looking towards +Z. Larger Z
                    // therefore means FURTHER AWAY from the camera, not
                    // closer (recomputed: at +90 degrees z_rel' =
                    // sin(90)*x_rel = +x_rel, while "closer to the
                    // camera" would mean NEGATIVE z_rel). Fix: a
                    // negative angle moves the far edge to SMALLER Z,
                    // i.e. actually towards the viewer.
                    var angleDeg = -response.OpenAngleDegrees;
                    // Session 43: with "Viva Elite 3D Case" the opening
                    // animation builds on the permanent Case Angle base
                    // tilt. Session 51/53: the opening direction used to
                    // be mirrored when the hinge sat on the left
                    // (CaseAngleDegrees positive) - since Session 53 the
                    // Open Case hinge is ALWAYS on the left (see
                    // measureGeometryFor above), exactly the hinge side
                    // for which the base convention ("negative = opens
                    // outwards") was originally derived - no mirroring
                    // needed any more.
                    //
                    // Session 62/65: restAngle (Case Angle, rest tilt
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
                    var cycleStart = performance.now();
                    runRotationFrame(cycleStart, 1000, 0, angleDeg, geoRotator, geoPoster);
                    activeCloseTimeoutId = setTimeout(function () {
                        activeCloseTimeoutId = null;
                        if (myGeneration !== currentGeneration()) { return; }
                        runRotationFrame(performance.now(), 1000, angleDeg, 0, geoRotator, geoPoster);
                    }, 7000);
                }

                function endOpenCaseAnimation() {
                    started = false;
                    cancelActiveRotation();
                    rotator.classList.remove(ROTATOR_OPEN_CLASS);
                    // Session 61 FIX (user finding: "snaps back to angle
                    // 0 at animation end although Case Angle should be
                    // the fixed point"): for the other three case types
                    // "" (flat, no tilt) really is the correct rest
                    // state - only vivaelite3dcases has its own,
                    // non-zero rest tilt (Case Angle). tiltAngle/
                    // tiltFrontRect/tiltPosterRect are already cached in
                    // the outer scope by the original, static
                    // application (further up in the same check()
                    // function, Sessions 50/53) - applyTilt() applied
                    // to them restores exactly the same rest tilt
                    // instead of removing it completely.
                    if (response.CaseType === 'vivaelite3dcases' && typeof applyTilt === 'function' && tiltFrontRect) {
                        applyTilt(rotator, tiltFrontRect);
                    } else {
                        rotator.style.transform = '';
                    }
                    if (cardScalableEl) {
                        cardScalableEl.classList.remove(ROTATOR_OPEN_CLASS);
                        if (response.CaseType === 'vivaelite3dcases' && typeof applyTilt === 'function' && tiltPosterRect) {
                            applyTilt(cardScalableEl, tiltPosterRect);
                        } else {
                            cardScalableEl.style.transform = '';
                        }
                    }
                    if (padderEl) { padderEl.classList.remove(PADDER_HIDE_CLASS); }
                    if (discBox && response.SpinningDiscEnabled) {
                        discBox.firstChild.classList.remove(DISC_SPIN_CLASS, DISC_SPIN_CLASS_RIGHT);
                    }
                }

                rotator.addEventListener('animationend', function (e) {
                    if (e.target !== rotator) { return; }
                    endOpenCaseAnimation();
                });

                if (response.OpenCaseDelayEnabled) {
                    // Session 38 (reverts Session 34): the earlier
                    // per-item memory here was based on a wrong
                    // diagnosis - direct source-level confirmation
                    // (jellyfin-web 10.10.7) already established that
                    // browser-tab switching cannot fire 'viewshow' at
                    // all (no visibilitychange hook anywhere in that
                    // dispatch chain), so it never needed guarding
                    // against here. What the memory actually did was
                    // suppress genuinely wanted re-triggers on real,
                    // repeated navigation to the same item (e.g.
                    // clicking the same title again from the library).
                    // Every real navigation (including a genuine "back
                    // then forward to the same item") should auto-open
                    // again, same as a fresh visit or a hard refresh -
                    // explicit user requirement, matching how the
                    // Theme Song feature already behaves.
                    setTimeout(startOpenCaseAnimation, response.OpenCaseDelayMs);
                }

                if (response.OpenCaseOnClickEnabled) {
                    // Explicit user requirements: the click target is
                    // the POSTER surface, not the case texture (already
                    // guaranteed - every Case box has pointer-events:
                    // none, see buildBox's own CSS, so a click always
                    // reaches posterEl underneath regardless of which
                    // Case box visually overlaps it); no cursor change
                    // ("brauchst du den Mauscursor nicht ändern"); only
                    // registers while the poster is in its native,
                    // not-currently-animating state ("während die
                    // Animation schon am Laufen ist, ist der Klick
                    // gesperrt/ignoriert") - `started` already covers
                    // exactly that, no separate check needed.
                    var clickHandler = function () { startOpenCaseAnimation(); };
                    posterEl.addEventListener('click', clickHandler);
                    posterEl._artworkplusCaseModClickHandler = clickHandler;
                }
            }

            log('Applied (front)', response.CaseType, response.TextureKey,
                'openCase:', animateOpen, 'angle:', response.OpenAngleDegrees,
                '(delay:', !!response.OpenCaseDelayEnabled, 'onClick:', !!response.OpenCaseOnClickEnabled,
                'discart:', !!response.HasDiscart + ')', 'for', itemId);

            // ═══ SESSION 20: Back and Disc's own network requests now
            // wait for the poster-arbiter's decision to stop being
            // pending before they START - the decision-critical phase
            // for Custom/Animated/Extra is exactly the window where an
            // extra, concentrated burst of CaseMod's own image requests
            // (Back+Disc, running concurrently since session 19) could
            // compete for the same connection pool as their own
            // decision-relevant fetches. This does NOT delay Front
            // (already resolved/appended above) or the Open Case
            // trigger wiring below (both already ran by this point) -
            // only Back/Disc's own appendChild() calls remain
            // fire-and-forget from check()'s own perspective, unchanged
            // from session 19 in that respect. Read-only observation of
            // `coord` - never registers, reserves, or otherwise writes
            // into the arbiter (see check()'s own doc comment on the
            // `coord` parameter above).
            //
            // Timeout choice: 8000ms, not an arbitrary new number -
            // reuses the EXACT same PRELOAD_TIMEOUT_MS already
            // established independently in Custom/Animated/Extra
            // (every one of them gives a single image load up to this
            // long before giving up) and in waitForPosterElement()
            // above - the existing convention in this file for "the
            // longest we'd ever reasonably wait for one piece of
            // loading work" already fits this new case, no new policy
            // invented. If the decision is somehow never reached within
            // that window, Back/Disc simply proceed anyway rather than
            // block forever - Front's own visibility was never at
            // stake either way.
            var posterDecisionSettled = coord && coord.decisionPromise
                ? Promise.race([
                    coord.decisionPromise,
                    new Promise(function (resolve) { setTimeout(resolve, 8000); })
                  ])
                : Promise.resolve();

            // Session 66: now that posterDecisionSettled has its real
            // value, actually kick off the inner-case/disc preview
            // loading chain that was only DEFINED (not yet executed)
            // further up - it thereby joins the same front-first
            // loading phase as Back/Disc below.
            if (typeof scheduleInnerCaseDiscPreview === 'function') {
                scheduleInnerCaseDiscPreview();
            }

            // ═══ Back and Disc load and attach INDEPENDENTLY from here
            // on - fire-and-forget from the main function's own
            // perspective (check() itself does not await either), each
            // with its OWN generation/liveness guard immediately before
            // its own appendChild, reusing the exact same mechanism
            // Front used above. Neither can ever attach to a page the
            // user has since navigated away from. ═══

            // Back cover: same geometry class as the front (a real
            // case's front/back share physical outer dimensions -
            // explicit user decision, no separate back tuning), z-index
            // 2 puts it BEHIND the real poster card (z-index 3), giving
            // the requested back/poster/front layering. Always fully
            // static - never rotates, never gets a rotator, regardless
            // of the Open Case animation state (explicit user scoping:
            // only the front cover + poster open).
            //
            // Session 54 (explicit user request: "we don't need the
            // back side at all yet. Remove it." - for "Viva Elite 3D
            // Case" ONLY): Back skipped completely, not merely made
            // invisible - no preload request, no DOM element. Affects
            // exclusively this one case type; the other three get their
            // back box unchanged as before.
            if (response.CaseType !== 'vivaelite3dcases') {
            posterDecisionSettled.then(function () {
                return Core.preloadImage(backTextureUrl);
            }).then(function () {
                if (myGeneration !== currentGeneration() || !document.body.contains(posterEl)) { return; }
                var backBox = buildBox(BOX_BACK_CLASS, frontSizedClass, backTextureUrl, true);
                detailImageContainer.appendChild(backBox);
                fadeInBox(backBox);
                // Session 50 FIX (real bug, user finding via DOM
                // inspection: "case duplicate, flat, 0 degrees in the
                // background"): backBox NEVER got the Case Angle tilt -
                // so it still sat flat at its original position while
                // the front distorts perspectively. The unchanged, flat
                // back thereby showed through where the tilted front is
                // now smaller. Uses the same applyTilt() function (and
                // its already computed closure variables: tiltAngle,
                // tiltHingeXPx, tiltScreenW/H, tiltCameraX/Y) from the
                // vivaelite3dcases block further up - both are part of
                // the same check() function, var is function-scoped, so
                // it stays accessible here in this later .then() as
                // well. (Session 54: this branch is dead code for
                // vivaelite3dcases anyway now, since the whole block no
                // longer runs for this type - left unchanged instead of
                // removed, in case the back side is re-enabled later.)
                if (response.CaseType === 'vivaelite3dcases' && typeof applyTilt === 'function') {
                    applyTilt(backBox, backBox.getBoundingClientRect());
                }
                log('Applied (back)', response.CaseType, 'for', itemId);
            }).catch(function (e) {
                log('Back texture preload failed, front only', e);
            });
            }

            // Disc (session 12) - appended right after Back so, tied on
            // z-index, it paints above Back and below the real card;
            // ensureDiscSizedStylesInjected must run before the preload
            // (unchanged requirement) - kept OUTSIDE the decision-wait
            // (pure style injection, no network request, no reason to
            // delay it). Static by default; SpinningDiscEnabled adds
            // the separate, own-axis continuous spin (explicit user
            // correction: only the disc itself spins, never the
            // opening motion). discBox is declared with the rest of
            // Front's own local state further up (`var discBox = null`)
            // specifically so startOpenCaseAnimation()/
            // endOpenCaseAnimation() above - reachable via a delay or a
            // click that may well fire BEFORE this promise resolves -
            // keep working unchanged via the exact same closure they
            // already used before this session: their own
            // `if (discBox && ...)` guard already tolerated discBox
            // being unset, no new guard needed.
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
                    detailImageContainer.appendChild(discBox);
                    // Session 60 FIX (user finding, same pattern as
                    // backBox in Session 50): discBox NEVER got the
                    // static Case Angle tilt - so it stayed flat at its
                    // original position while front/poster distort
                    // perspectively. Only the admin preview
                    // (discPreviewBox) got applyTilt() - the real
                    // discBox visible in normal operation never did.
                    if (response.CaseType === 'vivaelite3dcases' && typeof applyTilt === 'function') {
                        applyTilt(discBox, discBox.getBoundingClientRect());
                    }
                    // Rare edge case, explicitly handled: the Open Case
                    // animation may already be running by the time Disc
                    // arrives (a short delay, or an immediate click,
                    // both entirely possible before Disc's own network
                    // round trip finishes) - `started` (closed over from
                    // above) tells us so, and the spin class is applied
                    // retroactively here so Disc still spins correctly
                    // even though it missed startOpenCaseAnimation()'s
                    // own moment of adding it.
                    if (animateOpen && typeof started !== 'undefined' && started && response.SpinningDiscEnabled) {
                        discBox.firstChild.classList.add(discSpinClassFor(response.SpinningDirection));
                    }
                    log('Applied (disc)', response.CaseType, 'for', itemId);
                }).catch(function (e) {
                    log('Disc image preload failed, skipping disc', e);
                });
            }
        }

        return { check: check, removeExistingOverlay: removeExistingOverlay };
    })();

    // =====================================================================
    // Shared navigation wiring - ONE scheduleDetail/startDetail pair for
    // all three modules, replacing three independent, duplicated
    // scheduleDetail()/schedule() functions. Custom/Animated/Extra now
    // run in parallel under the exact same `myGeneration` and the exact
    // same `coord`, exactly like before, but from a single call site
    // instead of three separately-wired 'viewshow' listeners.
    // =====================================================================

    async function startDetail(myGeneration) {
        if (!isDetailsPage()) { return; }
        var itemId = getItemIdFromHash();
        if (!itemId) { return; }
        contentReady = true;

        var posterEl = await waitForPosterElement(8000);
        if (!posterEl || myGeneration !== currentGeneration()) { return; }
        var coord = posterArbiterGet(posterEl);

        // All four run in parallel - Front is independent of the
        // arbiter (starts immediately regardless), but Back/Disc now
        // observe `coord`'s own decision state (see CaseModModule's own
        // doc comment on this) - a strictly read-only dependency, Case
        // never registers with or otherwise participates in the
        // arbiter itself.
        CustomModule.check(coord, itemId, posterEl, myGeneration);
        AnimatedModule.check(coord, itemId, posterEl, myGeneration);
        ExtraModule.check(coord, itemId, posterEl, myGeneration);
        CaseModModule.check(coord, itemId, posterEl, myGeneration);
    }

    function scheduleDetail() {
        navTimers.clearTimers();
        navGeneration++;
        var myGeneration = navGeneration;
        contentReady = false;
        Core.scheduleNavigationBurst(function () {
            if (contentReady) { return; }
            startDetail(myGeneration);
        }, navTimers.track);
    }

    // Library view: both tile swappers scan the page (each has its own
    // MutationObserver too - this is the viewshow/hard-refresh kick).
    function observeLibraryCards() {
        CustomModule.observeLibraryCards();
        AnimatedModule.observeLibraryCards();
    }

    document.addEventListener('viewshow', function () {
        scheduleDetail();
        setTimeout(observeLibraryCards, 300);
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
    setTimeout(observeLibraryCards, 1200);
})();
