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
 * under any circumstance. Jellyfin's own native backdrop rotation keeps
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

    // Duplicate-load guard: see Core.claimSingleton()'s own doc comment
    // in Core.js. Backdrops and People Backdrops are guarded
    // independently (two separate names) since they are two genuinely
    // independent sections within this one file, never sharing state
    // with each other.
    if (!window.ArtworkPlusCore.claimSingleton('Backdrops')) { return; }

    var DEBUG = true;
    var FADE_MS = 800; // identical to the native value (the backdrop-fadein keyframe)

    // Ken Burns effect - replicated from a real Kodi skin (Aeon MQ7,
    // its "HomeBG" include block), not invented from scratch. The
    // original applies two INDEPENDENT, continuously pulsing effects to
    // the same background image: a slow zoom (110%->130% scale, cubic
    // inout, auto-reversing) and a pan (-15,-15 -> 15,15px, same cubic
    // inout easing, also auto-reversing). Kodi's pulse="true" attribute
    // is what creates the auto-reverse/oscillating behavior - the CSS/
    // Web Animations equivalent is direction:'alternate' with
    // iterations:Infinity. cubic-bezier(0.645,0.045,0.355,1) is the
    // standard "easeInOutCubic" curve, matching Kodi's tween="cubic"
    // easing="inout" as closely as a CSS cubic-bezier can.
    //
    // Zoom/pan DURATION (how fast each pulses) is admin-configurable
    // (settings.KenBurnsZoomMs/KenBurnsPanMs, per user request) - the
    // zoom range, pan distance, and easing curve below stay fixed.
    var KEN_BURNS_EASING = 'cubic-bezier(0.645, 0.045, 0.355, 1)';
    var KEN_BURNS_ZOOM_START = 1.10;
    var KEN_BURNS_ZOOM_END = 1.30;
    var KEN_BURNS_PAN_PX = 15;

    var log = window.ArtworkPlusCore.makeLogger('[Backdrops]', DEBUG);

    // Invalidates in-flight loadBackdropsForCurrentItem() calls on fast
    // navigation - without this, an older navigation's async getItem()
    // call could resolve AFTER a newer one and incorrectly apply the
    // PREVIOUS item's backdrop URLs on top of the current item. Every
    // other script in this project already guards against this with the
    // same pattern; this file was missing it.
    var itemLoadToken = 0;

    function isFirefox() {
        return navigator.userAgent.toLowerCase().indexOf('firefox') !== -1;
    }

    // -----------------------------------------------------------------
    // detailsBanner: READ-ONLY. Never written by this project.
    // -----------------------------------------------------------------
    //
    // REWRITTEN after a direct user request to stop manipulating this
    // value entirely - the previous version (see this project's own
    // curriculum for the full history) temporarily wrote
    // "<userId>-detailsBanner" to "false" while overriding, restoring it
    // afterwards. Two real, confirmed problems with that approach:
    // (1) it meant Jellyfin's own "Details Banner" switch in the normal
    // display settings visibly showed "off" while our override was
    // active, even though the user's real preference was "on" - their
    // own setting no longer reliably reflected their own actual choice.
    // (2) confirmed directly against the real jellyfin-web source
    // (viewManager.js: `bubbles: true` on the 'viewshow' CustomEvent;
    // itemDetails/index.js:2099: `view.addEventListener('viewshow', ...)`
    // registered directly on the view element) - per the DOM event
    // dispatch specification, a listener on the event's own target
    // ALWAYS runs before a listener on an ancestor during the bubble
    // phase, REGARDLESS of registration order or added delay. Since this
    // project's own override write happened via a `document`-level
    // 'viewshow' listener while Jellyfin's own `renderBackdrop()` (which
    // reads detailsBanner() to decide whether to start its own native
    // rotation) runs via a listener on the view element itself, this
    // project's own write was STRUCTURALLY GUARANTEED to always run too
    // late for a given navigation - not a timing race that could be won
    // with a shorter delay, a race that could never be won at all this
    // way. (The one earlier-firing hook that exists, Jellyfin's own
    // 'HISTORY_UPDATE', is dispatched via `Events.trigger()` -
    // `utils/events.ts` confirms this is a private, in-module callback
    // array, not a real DOM CustomEvent, so it cannot be listened for
    // from outside that module at all.)
    //
    // The fix for both problems at once: never write detailsBanner. Let
    // Jellyfin's own native rotation start normally, based on the user's
    // real, untouched preference - then visually cover it with this
    // project's own, separately-tagged backdrop container (see
    // getBackdropContainer() below) via a static, always-present CSS rule
    // (FileTransformationRegistrar.cs's own PrehidingStyleTag-style
    // mechanism) keyed off a body class this project toggles - a rule
    // that applies the instant Jellyfin's own container exists, with no
    // timing race at all, the same principle already used for posterEl's
    // own FOOC-prehiding.

    function readDetailsBannerPreference() {
        var userId = window.ApiClient && window.ApiClient.getCurrentUserId ? window.ApiClient.getCurrentUserId() : null;
        if (!userId) { return true; } // matches userSettings.js's own default
        try {
            var stored = localStorage.getItem(userId + '-detailsBanner');
            // Same default resolution as userSettings.js's own
            // detailsBanner(): toBoolean(value, true) - absence of the
            // key means ON, confirmed directly from the real source.
            return stored === null ? true : stored === 'true';
        } catch (e) {
            log('localStorage access failed (private browsing or similar restriction?), treating detailsBanner as its own default (on)', e);
            return true;
        }
    }

    /// Purely informational: whether this project's own override should
    /// be visually active right now. Read-only - never writes anything.
    function resolveOverrideState(settings) {
        var shouldOverride = settings.Enabled && !isFirefox() && readDetailsBannerPreference();
        document.body.classList.toggle('artworkplus-backdrops-override', shouldOverride);
        return shouldOverride;
    }

    // -----------------------------------------------------------------
    // Backdrop display - uses the same CSS classes as native
    // (backdrop.scss is already loaded as part of the same bundle), but
    // in this project's OWN, separately-tagged container - never
    // Jellyfin's own `.backdropContainer` element itself.
    //
    // CHANGED: previously reused Jellyfin's own, single, page-independent
    // `.backdropContainer` element directly (`document.querySelector(
    // '.backdropContainer')`) - meaning this project's own images and
    // Jellyfin's own native rotation's images were BOTH children of the
    // exact same container, with no way to tell them apart. Now that
    // detailsBanner is never written (see resolveOverrideState() above),
    // Jellyfin's own native rotation keeps running normally in ITS OWN
    // container - this project's own container must be a separate
    // element so a static CSS rule can hide Jellyfin's own one without
    // also hiding this project's own images. Still uses the
    // `.backdropContainer` CLASS (for the native positioning/sizing CSS
    // already loaded in the same bundle - confirmed identical, no need to
    // duplicate it), plus an additional, unique class
    // (`artworkplus-own-backdrop`) this project's own static prehiding
    // CSS rule (FileTransformationRegistrar.cs) specifically excludes.
    // -----------------------------------------------------------------

    var backdropContainerEl = null;
    function getBackdropContainer() {
        if (backdropContainerEl && document.body.contains(backdropContainerEl)) { return backdropContainerEl; }
        backdropContainerEl = document.querySelector('.backdropContainer.artworkplus-own-backdrop');
        if (!backdropContainerEl) {
            backdropContainerEl = document.createElement('div');
            backdropContainerEl.classList.add('backdropContainer', 'artworkplus-own-backdrop');
            document.body.insertBefore(backdropContainerEl, document.body.firstChild);
        }
        return backdropContainerEl;
    }

    // Ken Burns "frame": one continuously-running zoom+pan camera motion
    // that the whole slideshow happens INSIDE, rather than each new image
    // getting its own fresh animation. Fixed after a user report,
    // comparing to how Ken Burns actually works in real slideshow
    // software/Kodi skins: the camera motion is one ongoing process
    // spanning the whole show - individual photos crossfade in and out
    // WITHIN it, the camera itself never resets. The previous
    // implementation gave every new backdropImage div its own
    // div.animate() call, always starting fresh at KEN_BURNS_ZOOM_START/
    // the pan's starting position - visibly restarting the effect on
    // every single image change instead of a smooth continuous zoom/pan.
    //
    // kenBurnsFrameEl is the PAN element specifically (the innermost of
    // the two nested wrappers) - callers append their per-image
    // crossfade divs into this, exactly like they used to append directly
    // into backdropContainerEl.
    var kenBurnsFrameEl = null;
    function getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs) {
        var container = getBackdropContainer();
        if (!kenBurnsEnabled) {
            // Ken Burns off: no extra nesting at all, exactly as before -
            // images crossfade directly inside backdropContainer.
            return container;
        }
        if (kenBurnsFrameEl && container.contains(kenBurnsFrameEl)) {
            return kenBurnsFrameEl; // already running - do NOT restart the animation
        }

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

        // Random start point in the animation cycle, per user request -
        // without this, every fresh frame (i.e. every new item's
        // slideshow, since clearOwnRotation() resets the frame on item
        // change) always started at the exact same zoom/pan extreme,
        // looking visibly identical/repetitive across different items.
        // Each animation's currentTime is set independently right after
        // starting it, so zoom and pan don't always land in the same
        // relative phase as each other either. Safe with
        // direction:'alternate'/iterations:Infinity - any point within
        // one full duration is a valid position in the endless
        // back-and-forth cycle.
        //
        // zoomMs/panMs: admin-configurable (per user request) - only the
        // two durations, NOT the zoom range/pan distance/easing, which
        // stay fixed (see the file header's own doc comment on the Kodi
        // skin this was replicated from).
        var zoomAnimation = zoomEl.animate(
            [{ transform: 'scale(' + KEN_BURNS_ZOOM_START + ')' }, { transform: 'scale(' + KEN_BURNS_ZOOM_END + ')' }],
            { duration: zoomMs, easing: KEN_BURNS_EASING, iterations: Infinity, direction: 'alternate' }
        );
        zoomAnimation.currentTime = Math.random() * zoomMs;
        var panAnimation = panEl.animate(
            [
                { transform: 'translate(-' + KEN_BURNS_PAN_PX + 'px, -' + KEN_BURNS_PAN_PX + 'px)' },
                { transform: 'translate(' + KEN_BURNS_PAN_PX + 'px, ' + KEN_BURNS_PAN_PX + 'px)' }
            ],
            { duration: panMs, easing: KEN_BURNS_EASING, iterations: Infinity, direction: 'alternate' }
        );
        panAnimation.currentTime = Math.random() * panMs;

        kenBurnsFrameEl = panEl;
        return panEl;
    }

    function setBackgroundContainerWithBackdrop(hasBackdrop) {
        var bg = document.querySelector('.backgroundContainer');
        if (!bg) { return; }
        bg.classList.toggle('withBackdrop', hasBackdrop);
    }

    // resolveWith:'url' (default), no timeoutMs - deliberately no
    // timeout at all here, relying purely on the browser's own
    // image-loading behavior, same as the original. Passes options
    // through unchanged - added so silentlyPreload() below can opt into
    // priority:'low' without this wrapper silently discarding it.
    function preloadImage(url, options) {
        return window.ArtworkPlusCore.preloadImage(url, options);
    }

    // Same timing fix as People Backdrops' own silentlyPreload() - see
    // that function's own doc comment for the full "why" (a real bug
    // found via a dedicated stress test: without this, the currently-
    // shown image stays visible for its own configured cycle time PLUS
    // however long the NEXT image takes to load, since the switch only
    // happens once the new image is actually ready). Applies here too
    // despite these being Jellyfin's own local images, not hotlinked
    // ones - "local" only means same-server, not zero-latency; a slow
    // network or a large, unoptimized backdrop can still take real time
    // to fetch. Fire-and-forget with its own .catch() that does
    // nothing: a failure here must never surface anywhere - the LATER,
    // real load attempt at actual display time is what legitimately
    // decides whether this image is shown or removed via
    // removeFailedImage(), exactly as before.
    //
    // REAL, MEASURED PERFORMANCE BUG FOUND AND FIXED (red-team
    // hardening pass): priority:'low' added here after measuring the
    // actual impact against a real local HTTP server with genuine
    // browser connection-limit behavior (not just a mock, which
    // couldn't have shown this at all) - THIS feature specifically has
    // no MaxImages cap the way People Backdrops does (bounded to 10 by
    // the server), since BackdropImageTags/ParentBackdropImageTags can
    // in principle carry many entries. Without priority:'low', all of
    // them silently preloading at 'high' priority competed directly
    // with the ONE actually-important, currently-visible image for the
    // browser's own limited concurrent connections - measured directly
    // at 200 images: the visible image took 11504ms to appear (vs. an
    // ~1-image baseline of ~1300ms) with everything at 'high', and
    // 1617ms (matching the baseline almost exactly) once background
    // preloads here were dropped to 'low'.
    function silentlyPreload(url) {
        preloadImage(url, { priority: 'low' }).catch(function () { /* intentionally ignored - see doc comment above */ });
    }

    function setBackdropImage(url, kenBurnsEnabled, cycleMs, zoomMs, panMs, onFailure) {
        // Captured NOW, before the async preload below - see
        // renderGeneration's own doc comment (near clearOwnRotation)
        // for the full "why".
        var myGeneration = renderGeneration;
        // Images now crossfade INSIDE the Ken Burns frame (or directly in
        // backdropContainer when Ken Burns is off) - not directly in
        // backdropContainer itself when Ken Burns is on. getKenBurnsFrame()
        // creates the frame and starts its animation only once; repeat
        // calls (every subsequent image in the same slideshow) reuse the
        // same, still-running frame instead of restarting anything.
        var frame = getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs);
        var existing = frame.querySelector('.displayingBackdropImage');
        if (existing && existing.getAttribute('data-url') === url) {
            // Same image picked again (possible in Random order - see
            // Core.js's own tick() doc comment) - nothing to re-render,
            // but the timer still needs telling "shown, starting now"
            // for this tick, same reasoning as People Backdrops' own
            // identical early-return case - without this the rotation
            // would effectively freeze on repeats.
            rotationEngine.imageShown();
            return;
        }

        preloadImage(url).then(function () {
            if (myGeneration !== renderGeneration) {
                // A newer clearOwnRotation()/startOwnRotation() call
                // happened while this image was still loading - see
                // renderGeneration's own doc comment for the full
                // "why" this must be discarded rather than rendered.
                log('Discarding a stale image render for a no-longer-current rotation. URL:', url);
                return;
            }
            var div = document.createElement('div');
            // Same fix as People Backdrops' own renderPreloadedBackdropImage
            // (see that function's own doc comment for the full
            // investigation): 'backdropImageFadeIn' is Jellyfin's OWN
            // native class with its own uncontrollable 0.8s @keyframes
            // animation, not something this project ever defined itself -
            // confirmed directly via a real Jellyfin CSS bundle. It
            // overrides this element's own inline opacity while it's
            // running, and this function never actually set a
            // `transition` on the element despite this function's own
            // nearby comment (a few lines down) claiming one existed -
            // so the 'transitionend' cleanup listener there could never
            // really have fired reliably. Fixed by not adding the
            // native class and setting a real, own transition instead,
            // matching what that comment always claimed was happening.
            div.classList.add('backdropImage', 'displayingBackdropImage');
            div.style.transition = 'opacity ' + FADE_MS + 'ms ease';
            div.style.opacity = '0';
            div.setAttribute('data-url', url);
            // No more per-image zoom/pan nesting/animation here - the
            // Ken Burns camera motion (when enabled) now lives entirely
            // in the shared frame from getKenBurnsFrame(), which this
            // image sits inside of. Each image is just a plain crossfade
            // layer, exactly like the "Ken Burns off" case always was.
            div.style.backgroundImage = window.ArtworkPlusCore.cssUrl(url);

            if (existing) { existing.classList.remove('displayingBackdropImage'); }
            frame.appendChild(div);

            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    // Explicit user request: lets People Backdrops (a
                    // completely separate, unrelated script - see
                    // ArtworkPlusBackdropTransition's own doc comment
                    // near the top of this file) fade its own outgoing
                    // image out IN SYNC with this incoming one, instead
                    // of on its own, uncoordinated timer. Harmless if
                    // nothing is listening (e.g. a plain movie-to-movie
                    // transition, or the same item's own rotation
                    // cycling to its next image) - notifyIncomingReady()
                    // is a no-op with zero subscribers.
                    ArtworkPlusBackdropTransition.notifyIncomingReady();
                    div.style.opacity = '1';
                });
            });

            setBackgroundContainerWithBackdrop(true);

            // Real bug this project's own People Backdrops audit found
            // and fixed, applying the same fix here to avoid a genuine
            // regression: Core.js's rotation engine no longer starts its
            // cycle timer on its own the moment start()/addImages() runs -
            // it now waits for an explicit imageShown() confirmation (see
            // that function's own doc comment in Core.js for the full
            // "why" - the old blind setInterval could count a full cycle
            // from an unrelated earlier moment rather than from when an
            // image was actually visible). Without this call here, this
            // rotation would silently stop advancing past its first
            // image entirely.
            rotationEngine.imageShown();

            // Only remove the old image AFTER the crossfade finishes
            // (curriculum G, point 2) - via the same kind of
            // "animationend" mechanism as native, reproduced here via
            // transitionend on the NEW element, since we use a CSS
            // transition instead of a named keyframe animation.
            if (existing) {
                var cleanup = function (event) {
                    // Explicitly check for the opacity transition, not
                    // just any transitionend - kept as a defensive check
                    // even though this div now only ever has the opacity
                    // transition (Ken Burns' zoom/pan no longer run on
                    // individual image divs, see getKenBurnsFrame() -
                    // they're on the shared frame now, a separate
                    // Element.animate() context this div doesn't
                    // participate in at all).
                    if (event && event.propertyName && event.propertyName !== 'opacity') { return; }
                    div.removeEventListener('transitionend', cleanup);
                    if (existing.parentNode) { existing.parentNode.removeChild(existing); }
                };
                div.addEventListener('transitionend', cleanup);
                // A safety net in case transitionend doesn't fire for
                // some reason (e.g. a background tab being throttled).
                setTimeout(cleanup, FADE_MS + 1000);
            }
        }).catch(function (e) {
            if (myGeneration !== renderGeneration) {
                // Same reasoning as the success path above - must not
                // call onFailure() against a rotation that's no longer
                // current.
                log('Discarding a stale image load failure for a no-longer-current rotation. URL:', url);
                return;
            }
            log('The image could not be loaded, skipping', e);
            // Same fix as People Backdrops' own startOwnRotation (see
            // that function's own doc comment for the full "why" this
            // audit found necessary): previously this just logged and
            // did nothing further, leaving the rotation stalled on this
            // dead image until its own regular schedule eventually tried
            // again - harmless with reliable local Jellyfin images most
            // of the time, but the same permanent-removal fix is applied
            // here too for consistency and to guard against the same
            // rare edge case (e.g. a locally-indexed image file that's
            // since been deleted/moved).
            if (onFailure) { onFailure(url); }
        });
    }

    // -----------------------------------------------------------------
    // Our own rotation
    // -----------------------------------------------------------------

    // Real, user-approved refactor: the actual rotation-timing/ordering
    // mechanics (which image is next, in Sequential/Shuffle/Random
    // order, on what interval) now live in Core.js's own
    // createBackdropRotationEngine() - shared with the new
    // BackdropsPeople-v1.js rather than duplicated, since the two
    // features' actual logic here was genuinely identical. This file
    // keeps its own instance (own images list, own current index, own
    // shuffle-bag) - see that factory function's own doc comment in
    // Core.js for the full "why one instance per feature, not shared
    // globally" reasoning. Everything below this point that's specific
    // to HOW an image actually gets drawn (the Ken Burns frame, the
    // separate .artworkplus-own-backdrop container, the crossfade
    // itself) is unchanged and stays entirely in this file, exactly as
    // before this refactor - only the bookkeeping of "which image, when"
    // moved.
    var rotationEngine = window.ArtworkPlusCore.createBackdropRotationEngine();

    // Same fix as People Backdrops' own renderGeneration - see that
    // file's own doc comment (near its clearOwnRotation) for the full
    // "why": without this, a stale preloadImage().then() callback from
    // an item the user has already navigated away from could still
    // insert its image into whatever's now showing for the NEW item,
    // once its own async load finally resolved. Applies here too
    // despite these being local Jellyfin images - fast item-to-item
    // navigation is just as possible on a details page as fast
    // person-to-filmography navigation was for People Backdrops.
    var renderGeneration = 0;

    // Session 86, fade concept: the same value as in the other five
    // categories, deliberately duplicated per IIFE.
    var MAX_WAIT_FOR_INCOMING_MS = 1200;

    function clearOwnRotation() {
        renderGeneration++;
        rotationEngine.clear();
        // Also reset the Ken Burns frame - called both on a genuine item
        // change (a fresh slideshow deserves a fresh camera start, not
        // one inherited from whatever item was showing before) and when
        // the feature is disabled entirely (Firefox, override turned
        // off) - in both cases nothing should keep running/left behind.
        if (kenBurnsFrameEl && kenBurnsFrameEl.parentNode) {
            var zoomWrapper = kenBurnsFrameEl.parentNode; // .artworkplus-kenburns-zoom
            if (zoomWrapper.parentNode) { zoomWrapper.parentNode.removeChild(zoomWrapper); }
        }
        kenBurnsFrameEl = null;
        // Real gap found while introducing this project's own, separate
        // container (see getBackdropContainer()'s own doc comment above):
        // with Ken Burns OFF, images crossfade directly as children of
        // this container (getKenBurnsFrame() returns the container itself
        // in that case) - the code above only ever cleaned up the Ken
        // Burns wrapper, never these direct children. Previously,
        // harmless: Jellyfin's own native rotation shared the exact same
        // container, so a leftover image looked identical to native
        // content either way. Now that this project's own container is
        // separate from Jellyfin's, a leftover image here would stay
        // visibly on top of Jellyfin's own (correctly un-hidden, since
        // shouldOverride is false whenever this runs) native rotation -
        // clearing it explicitly.
        // BUG FIXED (Session 86, fade concept): the direct firstChild
        // removal loop used to run immediately, regardless of whether
        // another category (e.g. People when changing to a person page)
        // fades something in itself the next moment anyway. Now like
        // the other five categories: first wait briefly for the next
        // project-wide signal, with a timeout fallback.
        if (!backdropContainerEl || !backdropContainerEl.firstChild || backdropContainerEl.style.opacity === '0') {
            return;
        }
        var fired = false;
        function startFadeNow() {
            if (fired) { return; }
            fired = true;
            backdropContainerEl.style.transition = 'opacity ' + FADE_MS + 'ms ease';
            backdropContainerEl.style.opacity = '0';
            setTimeout(function () {
                if (backdropContainerEl) {
                    while (backdropContainerEl.firstChild) {
                        backdropContainerEl.removeChild(backdropContainerEl.firstChild);
                    }
                    backdropContainerEl.style.opacity = '';
                    backdropContainerEl.style.transition = '';
                }
            }, FADE_MS);
        }
        ArtworkPlusBackdropTransition.onNextIncomingReady(startFadeNow);
        setTimeout(startFadeNow, MAX_WAIT_FOR_INCOMING_MS);
    }

    function startOwnRotation(images, settings) {
        renderGeneration++;
        // Real regression found via explicit user report + source
        // comparison against vanilla Jellyfin's own item-to-item
        // transition (which crossfades smoothly, never cuts): this used
        // to immediately clear every child of backdropContainerEl right
        // here, copied verbatim from People Backdrops' own
        // startOwnRotation during the merge ("Same fix as People
        // Backdrops' own startOwnRotation") - but that fix solves a
        // DIFFERENT problem (People Backdrops streams images in one at a
        // time with real load-failure risk) that doesn't apply the same
        // way here, where every URL is already known upfront and
        // preloaded below. The immediate clear left the container empty
        // for the duration of the incoming image's own fade-in - instead
        // of crossfading the new item's first image OVER the previous
        // item's still-visible one (exactly what the render function a
        // few lines below already does correctly WITHIN a single item's
        // own rotation - see its own "existing" cleanup, which only
        // removes the old image AFTER the new one finishes fading in).
        // renderGeneration (incremented above) already fully covers the
        // original concern on its own: any late/failed callback from a
        // now-superseded item's own image load is already ignored via
        // the myGeneration !== renderGeneration checks further down, so
        // a stale previous-item image can never get "confirmed" or left
        // orphaned by a genuinely later navigation - no separate,
        // eager DOM clear was needed here at all. Removed; the previous
        // item's image now stays visible and correctly gets crossfaded
        // over once the new item's own first image is ready, matching
        // vanilla's own behavior.
        // Same clamp as People Backdrops' own startOwnRotation - see
        // that function's own doc comment for the full "why" (a real
        // stress-test requirement, and why FADE_MS*1.5, not just
        // FADE_MS, was needed after the first attempt still measured
        // stacked DOM elements at the boundary).
        var effectiveCycleMs = Math.max(settings.CycleTimeMs, Math.ceil(FADE_MS * 1.5));
        // Unlike People Backdrops (which streams images in one at a
        // time and preloads each as it arrives), every URL here is
        // already known upfront - so every image except the very first
        // (which the rotation's own first tick already preloads via
        // setBackdropImage) can be silently warmed in the browser's
        // cache right now, rather than only once the rotation actually
        // reaches it. See silentlyPreload's own doc comment for the
        // full "why" this matters even for same-server images.
        for (var i = 1; i < images.length; i++) {
            silentlyPreload(images[i]);
        }
        rotationEngine.start(images, settings.OrderMode, effectiveCycleMs, function (url) {
            setBackdropImage(url, settings.KenBurnsEnabled, effectiveCycleMs, settings.KenBurnsZoomMs, settings.KenBurnsPanMs, function (failedUrl) {
                rotationEngine.removeFailedImage(failedUrl);
                rotationEngine.advance();
            });
        });
    }

    // -----------------------------------------------------------------
    // Determining an item's backdrop URLs (detail pages only, see the
    // scope note)
    // -----------------------------------------------------------------

    var getItemIdFromHash = window.ArtworkPlusCore.getItemIdFromHash;
    var isDetailsPage = window.ArtworkPlusCore.isDetailsPage;

    async function loadBackdropsForCurrentItem(settings) {
        if (!isDetailsPage()) {
            // Bug fix, user-reported: without this, navigating AWAY from
            // a detail page (e.g. to Jellyfin's own settings pages) left
            // the previous item's rotation/interval running and its
            // image still visible in the background - this function
            // simply returned early, never stopping anything. Native
            // Jellyfin backdrops only ever show on detail pages too - our
            // own override needs to match that by actually clearing
            // itself here, not just declining to start something new.
            clearOwnRotation();
            return;
        }
        var itemId = getItemIdFromHash();
        if (!itemId || !window.ApiClient) {
            clearOwnRotation(); // same reasoning as above - no valid item here, nothing of ours should stay visible
            return;
        }

        var myToken = ++itemLoadToken;

        var item;
        try {
            item = await window.ApiClient.getItem(window.ApiClient.getCurrentUserId(), itemId);
        } catch (e) {
            log('The item could not be loaded', e);
            return;
        }
        if (myToken !== itemLoadToken) { return; } // a newer navigation has already started

        var tags = (item.BackdropImageTags && item.BackdropImageTags.length ? item.BackdropImageTags : null)
            || (item.ParentBackdropImageTags && item.ParentBackdropImageTags.length ? item.ParentBackdropImageTags : null);
        var sourceId = item.BackdropImageTags && item.BackdropImageTags.length ? item.Id : item.ParentBackdropItemId;

        if (!tags || !sourceId) {
            // Same fix as the isDetailsPage()/itemId checks above -
            // without clearing here, navigating from an item WITH
            // backdrops to one WITHOUT any left the previous item's
            // rotation/image running and visible.
            clearOwnRotation();
            log('No backdrops for this item, the native display (if any) stays untouched');
            return;
        }

        // CHANGED: BackdropsAllowedFormats is a real, working DISPLAY
        // GATE now (explicit user correction: "sollte aber schon tied zu
        // den sub below sein! sonst ist ja das alles unnuetz") - not a
        // file search of our own (this feature never searches for
        // files, it only reuses whichever backdrops Jellyfin itself
        // already resolved) but a filter on top of those already-known
        // images, by their own actual on-disk extension. Ask the server
        // which of this sourceId's own backdrop indices are allowed
        // BEFORE building any URLs, so a disallowed format never even
        // gets fetched. On failure, fail open (keep every tag) rather
        // than silently going dark - a broken filter request shouldn't
        // take down the whole feature.
        var allowedIndices = null;
        try {
            allowedIndices = await fetch('/Backdrops/allowed-indices?sourceId=' + encodeURIComponent(sourceId), { cache: 'no-store' })
                .then(function (r) { return r.json(); });
        } catch (e) {
            log('Could not load allowed backdrop indices, showing all formats', e);
        }
        if (myToken !== itemLoadToken) { return; } // a newer navigation started while this was in flight

        var allowedSet = Array.isArray(allowedIndices) ? new Set(allowedIndices) : null;
        var indexedTags = tags.map(function (tag, index) { return { tag: tag, index: index }; });
        var filteredTags = allowedSet ? indexedTags.filter(function (it) { return allowedSet.has(it.index); }) : indexedTags;

        if (!filteredTags.length) {
            clearOwnRotation();
            log('This item has backdrops, but none match the allowed formats');
            return;
        }

        var urls = filteredTags.map(function (it) {
            return window.ApiClient.getScaledImageUrl(sourceId, {
                type: 'Backdrop',
                tag: it.tag,
                maxWidth: window.innerWidth,
                index: it.index
            });
        });

        startOwnRotation(urls, settings);
    }

    // -----------------------------------------------------------------
    // The video page: transparency/pause, via the same page events as
    // native (curriculum G, point 6 - in practice also covers point 5,
    // since playbackManager itself isn't reachable, see the top of the
    // file).
    // -----------------------------------------------------------------

    function isVideoPage() {
        var hash = location.hash || '';
        return hash.split('?')[0].replace(/^#\/?/, '') === 'video';
    }

    // -----------------------------------------------------------------
    // Flow
    // -----------------------------------------------------------------

    var currentSettings = null;
    // Separate token from itemLoadToken above (that one guards the
    // per-item backdrop URL fetch further downstream; this one guards
    // THIS function's own settings fetch specifically) - needed now that
    // settings are no longer fetched once at start() and reused, but
    // re-fetched on every navigation (see refresh()'s own doc comment
    // below for why) - without this, a slower, older settings fetch
    // could resolve AFTER a newer one and incorrectly apply a stale
    // Enabled/type decision on top of the current, already-newer item.
    var settingsFetchToken = 0;

    async function refresh() {
        if (isVideoPage()) {
            rotationEngine.setPaused(true);
            return;
        }
        rotationEngine.setPaused(false);

        // CHANGED: settings are now item-type-dependent (Movies/TvShows/
        // Seasons/Episodes/Videos each independently switchable, real
        // gap found and fixed per explicit user request) - the server
        // can no longer answer correctly without knowing which item is
        // currently showing, so this can no longer reuse one
        // fetched-once-at-start value the way it used to. Re-fetches on
        // every call instead (every navigation, via the same
        // viewshow/watchForNavigation triggers this function already
        // had) - itemId omitted when not on a details page/no item
        // resolvable yet, matching the server's own documented
        // backward-compatible "no itemId = no type filtering" fallback.
        var itemId = isDetailsPage() ? getItemIdFromHash() : null;
        var myFetchToken = ++settingsFetchToken;
        try {
            var url = '/Backdrops/settings' + (itemId ? ('?itemId=' + encodeURIComponent(itemId)) : '');
            currentSettings = await fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); });
        } catch (e) {
            log('The settings could not be loaded', e);
            return;
        }
        if (myFetchToken !== settingsFetchToken) { return; } // a newer refresh() call has already started

        if (!currentSettings) { return; }
        var shouldOverride = resolveOverrideState(currentSettings);
        if (!shouldOverride) {
            clearOwnRotation();
            return;
        }

        await loadBackdropsForCurrentItem(currentSettings);
    }

    async function start() {
        if (isFirefox()) {
            // Firefox is never supported at all (see the file header's
            // own doc comment) - no point even trying a first settings
            // fetch, matches this function's own previous behavior of
            // bailing out immediately for Firefox.
            resolveOverrideState({ Enabled: false });
            return;
        }

        refresh();
        document.addEventListener('viewshow', function () { setTimeout(refresh, 300); });
    }

    // Continuous poll as a backup - see Core's watchForNavigation doc
    // comment. Registered once at top level (not inside start(), to
    // avoid adding a fresh interval on every navigation) - refresh()
    // itself already no-ops safely if currentSettings hasn't loaded yet.
    window.ArtworkPlusCore.watchForNavigation(function () { setTimeout(refresh, 300); });

    setTimeout(start, 1200);
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

    // Duplicate-load guard: see Core.claimSingleton()'s own doc comment
    // and the Backdrops section's own identical guard above for the full
    // reasoning.
    if (!window.ArtworkPlusCore.claimSingleton('PeopleBackdrops')) { return; }

    var DEBUG = true;
    var FADE_MS = 800; // matches Backdrops-v1.js's own value (the native backdrop-fadein keyframe)

    // Same Ken Burns constants as Backdrops-v1.js - see that file's
    // own doc comment for the full "replicated from a real Kodi skin"
    // reasoning, not repeated here. Kept as an independent copy (not
    // extracted to Core.js) since these are simple constants, not logic
    // - not worth the indirection for four numbers.
    var KEN_BURNS_EASING = 'cubic-bezier(0.645, 0.045, 0.355, 1)';
    var KEN_BURNS_ZOOM_START = 1.10;
    var KEN_BURNS_ZOOM_END = 1.30;
    var KEN_BURNS_PAN_PX = 15;

    var log = window.ArtworkPlusCore.makeLogger('[PeopleBackdrops]', DEBUG);

    var Core = window.ArtworkPlusCore;
    if (!Core) {
        console.error('[PeopleBackdrops] window.ArtworkPlusCore is not defined - Core-v1.js must be loaded BEFORE this script. Check the JavaScript Injector\'s script order. This feature will not run.');
        return;
    }
    var tracker = Core.createTimerTracker();

    // -----------------------------------------------------------------
    // Page detection - verified directly against list.js's own
    // getItem()/params.personId/params.type usage (see file header) -
    // these are exactly the URL parameters the real controller reads.
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

    // -----------------------------------------------------------------
    // Our own background container - deliberately appended directly to
    // document.body, NOT inside Jellyfin's own .mainAnimatedPage - see
    // this file's own header doc comment for exactly why that
    // independence is what makes the "frozen across subpages" model
    // possible at all: Jellyfin tears down/rebuilds its OWN page
    // between #/details and #/list.html, but never touches this
    // element, since it isn't part of what Jellyfin itself manages.
    // -----------------------------------------------------------------

    // REAL BUG FOUND AND FIXED (user report: after leaving a person page
    // for e.g. a movie, that movie's backdrops were sometimes entirely
    // missing - pure black, i.e. '.withBackdrop' set with nothing
    // underneath): this element used to carry Jellyfin's own
    // 'backdropContainer' class (for its native positioning CSS) plus
    // 'artworkplus-own-backdrop', and is inserted as body.firstChild.
    // Verified against the real sources: Jellyfin's backdrop.js
    // getBackdropContainer() does document.querySelector(
    // '.backdropContainer') - the FIRST match in DOM order - and caches
    // it forever; Backdrops-v1.js looks up
    // '.backdropContainer.artworkplus-own-backdrop'. Whenever this
    // element existed first (e.g. a session that starts on a person
    // page), BOTH resolved to THIS container and rendered their own
    // images into it - and this feature's own destroyVisit() (which the
    // burst mechanism runs 4x after every leave) then emptied it,
    // wiping the other feature's backdrops. Session-order dependent,
    // hence "sometimes". Fix: this element no longer carries EITHER
    // shared class, so no other lookup can ever match it; the two CSS
    // properties it needed from Jellyfin's '.backdropContainer' rule
    // (position:fixed inset:0; z-index:-1 - librarybrowser.scss) plus
    // its contain hint (backdrop.scss) are set inline instead.
    // '.backdropImage' stays on the image elements themselves: that
    // class is only ever queried scoped to a container, never globally
    // (verified), and its backdrop.scss rule (absolute, cover, centered)
    // is exactly what these images need.
    var backdropContainerEl = null;
    function getBackdropContainer() {
        if (backdropContainerEl && document.body.contains(backdropContainerEl)) { return backdropContainerEl; }
        backdropContainerEl = document.querySelector('.artworkplus-people-backdrop');
        if (!backdropContainerEl) {
            backdropContainerEl = document.createElement('div');
            backdropContainerEl.classList.add('artworkplus-people-backdrop');
            backdropContainerEl.style.position = 'fixed';
            backdropContainerEl.style.top = '0';
            backdropContainerEl.style.left = '0';
            backdropContainerEl.style.right = '0';
            backdropContainerEl.style.bottom = '0';
            backdropContainerEl.style.zIndex = '-1';
            backdropContainerEl.style.contain = 'layout style size';
            document.body.insertBefore(backdropContainerEl, document.body.firstChild);
            log('Created own .artworkplus-people-backdrop container');
        }
        return backdropContainerEl;
    }

    // Ken Burns "frame" - identical mechanism to Backdrops-v1.js's own
    // getKenBurnsFrame().
    var kenBurnsFrameEl = null;
    function getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs) {
        var container = getBackdropContainer();
        if (!kenBurnsEnabled) {
            return container;
        }
        if (kenBurnsFrameEl && container.contains(kenBurnsFrameEl)) {
            return kenBurnsFrameEl; // already running - do NOT restart the animation
        }

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

        var zoomAnimation = zoomEl.animate(
            [{ transform: 'scale(' + KEN_BURNS_ZOOM_START + ')' }, { transform: 'scale(' + KEN_BURNS_ZOOM_END + ')' }],
            { duration: zoomMs, easing: KEN_BURNS_EASING, iterations: Infinity, direction: 'alternate' }
        );
        zoomAnimation.currentTime = Math.random() * zoomMs;
        var panAnimation = panEl.animate(
            [
                { transform: 'translate(-' + KEN_BURNS_PAN_PX + 'px, -' + KEN_BURNS_PAN_PX + 'px)' },
                { transform: 'translate(' + KEN_BURNS_PAN_PX + 'px, ' + KEN_BURNS_PAN_PX + 'px)' }
            ],
            { duration: panMs, easing: KEN_BURNS_EASING, iterations: Infinity, direction: 'alternate' }
        );
        panAnimation.currentTime = Math.random() * panMs;

        kenBurnsFrameEl = panEl;
        return panEl;
    }

    function preloadImage(url, options) {
        return Core.preloadImage(url, options);
    }

    // Background-warms an image the moment its URL is known (streamed
    // in), rather than waiting for the rotation to actually need it -
    // see Core.preloadImage's own doc comment for the fetchPriority
    // measurement behind priority:'low' here.
    function silentlyPreload(url) {
        preloadImage(url, { priority: 'low' }).catch(function () { /* intentionally ignored - failure here is not a verdict, see setBackdropImageWithSkipOnFailure's own real load attempt */ });
    }

    // Per-visit dedupe so the same-person seamless subpage continuation
    // doesn't re-warm URLs it already warmed - cleared in destroyVisit()
    // alongside everything else, since a genuinely fresh visit should
    // warm its own images from scratch.
    var alreadyPreloadedUrls = new Set();
    function silentlyPreloadOnce(url) {
        if (alreadyPreloadedUrls.has(url)) { return; }
        alreadyPreloadedUrls.add(url);
        silentlyPreload(url);
    }

    // ===================================================================
    // '.withBackdrop' defense - see this file's own header doc comment
    // for the full, source-verified "why" (Jellyfin's own itemDetails
    // controller calls clearBackdrop() asynchronously on the person's
    // own page, which can remove this class AFTER this feature has
    // already correctly applied it, since this feature cannot use
    // Jellyfin's own non-exported externalBackdrop() API from an
    // external script). Rather than trying to win a timing race against
    // an async call this feature has no visibility into, a
    // MutationObserver simply re-asserts the class whenever Jellyfin
    // removes it while this feature legitimately has an image on
    // screen. Started once, runs for the page's entire lifetime (cheap
    // - only fires on the rare class-list mutation, not continuously).
    // ===================================================================

    var backgroundContainerConfirmedOnce = false;
    // REAL BUG FOUND AND FIXED (user report: after leaving a person page
    // for Home specifically, the People image correctly disappears but
    // the dark overlay stays - "das Schwarze löst sich nicht auf"). Root
    // cause: this was NEVER set back to false anywhere in this file -
    // deliberately, from an earlier audit, reasoned as "other pages
    // either manage the class themselves, or the difference over an
    // empty container is invisible". That reasoning does not hold for
    // Home specifically: Home is itself a 'backdropPage' with its own
    // rotating backdrops (autoBackdrops.js) and calls Jellyfin's own
    // clearBackdrop() on resume (verified in home.tsx) - which SHOULD
    // reset the class via hasInternalBackdrop, but whether and when that
    // actually wins the race against Home's own subsequent backdrop load
    // is Jellyfin's own timing, not ours to rely on. This flag tracks
    // whether WE were the one who last set the class to true, so
    // destroyVisit() (see below) can safely set it back to false when
    // leaving - restoring the clean, transparent baseline every other
    // page already expects - without ever touching a class that a
    // DIFFERENT owner (BackdropsPlus, Jellyfin itself) set afterward.
    var weSetWithBackdrop = false;
    function setBackgroundContainerWithBackdrop(hasBackdrop) {
        var bg = document.querySelector('.backgroundContainer');
        if (!bg) {
            log('WARNING: .backgroundContainer not found in the DOM - backdrop images may render but be invisible. This could mean Jellyfin\'s own page structure changed, or this ran before the page finished loading.');
            return;
        }
        bg.classList.toggle('withBackdrop', hasBackdrop);
        weSetWithBackdrop = hasBackdrop;
        if (hasBackdrop && !backgroundContainerConfirmedOnce) {
            backgroundContainerConfirmedOnce = true;
            log('.backgroundContainer found and .withBackdrop applied - backdrop should be visible');
        }
    }

    var withBackdropObserverStarted = false;
    function ensureWithBackdropDefense() {
        if (withBackdropObserverStarted) { return; }
        var bg = document.querySelector('.backgroundContainer');
        if (!bg) { return; } // will retry the next time an image is actually shown
        withBackdropObserverStarted = true;
        var observer = new MutationObserver(function () {
            // Only re-assert while THIS feature genuinely has a visible
            // image right now (activePersonId set AND a real displaying
            // element in our own container) - never force the class on
            // when we have nothing to show, since Jellyfin's own removal
            // might be entirely legitimate in that case.
            if (!activePersonId) { return; }
            var container = backdropContainerEl;
            if (!container || !container.querySelector('.displayingBackdropImage')) { return; }
            if (!bg.classList.contains('withBackdrop')) {
                log('Jellyfin\'s own code removed .withBackdrop while this feature still has a valid image showing - re-asserting it');
                bg.classList.add('withBackdrop');
            }
        });
        observer.observe(bg, { attributes: true, attributeFilter: ['class'] });
    }

    // ===================================================================
    // LIFECYCLE STATE - see this file's own header doc comment for the
    // full architecture. visitId is the SINGLE source of truth for
    // staleness (replaces the previous separate runToken/
    // renderGeneration pair with one counter answering the same
    // question). activePersonId/activeScope describe what's currently
    // considered "live" - a subpage change compares against
    // activePersonId ONLY (scope is deliberately irrelevant to whether
    // a reset happens).
    // ===================================================================

    var visitId = 0;
    var activePersonId = null;
    var activeScope = null;
    // Every fetch started for the current visit registers its own
    // AbortController here so destroyVisit() can actually cancel the
    // underlying network request (not just ignore its eventual result)
    // - a Set (not a single variable) because with the seamless
    // same-person model, a subpage change genuinely can have its OWN
    // fetch in flight (a different scope's own data) at the same time
    // the person's initial fetch is still finishing - both belong to
    // the SAME visit and must both be abortable independently when the
    // visit itself ends.
    var visitAbortControllers = new Set();
    // Guards against the burst mechanism (schedule() below) starting a
    // second, redundant fetch for a key that already has one running
    // for the CURRENT visit.
    var fetchInProgressKeys = new Set();
    // Scopes of the CURRENT visit that already received a definitive
    // server answer (images shown, or "not applicable"). All four
    // scopes of one person share the exact same server-side
    // backdrops.json, so re-asking for a scope this visit already
    // asked about is pure overhead - measured directly: a single visit
    // plus 10 back-and-forth own-page<->filmography clicks issued 11
    // server requests, when only 2 distinct scopes were ever involved.
    // A fetch that failed with a genuine (non-abort) error is NOT
    // recorded here, so it can be retried. Cleared by destroyVisit().
    var fetchedScopesThisVisit = new Set();

    // Cancels whatever fade-related rAF/timeout callbacks are currently
    // pending for the CURRENTLY DISPLAYING image, if any - tracked here
    // so destroyVisit() can actually stop them rather than letting them
    // fire against a container that's about to be emptied anyway.
    var pendingFadeCancel = null;

    // Whether startOwnRotation() has actually been called for the
    // CURRENT visit. Needed because activePersonId being set only means
    // "this person's visit is live", NOT "a rotation is running" - a
    // fresh visit can resolve to "not applicable / 0 images" (a
    // completely ordinary result) with activePersonId deliberately kept
    // set (see the not-applicable branch in fetchAndApplyForVisit for
    // why - the historical 6-redundant-fetches bug). A later same-person
    // subpage change must then start fresh (startOwnRotation) rather
    // than addImages() into an engine that was never started, which
    // would render nothing at all.
    var rotationStarted = false;
    // True once the CURRENT visit's first image has actually begun its
    // fade. The "wait for a quiet page" logic in
    // renderPreloadedBackdropImage only applies before this: the first
    // image is the only one that overlaps Jellyfin's own page build;
    // every later rotation image lands on a long-settled page, where the
    // wait would be pure delay - measured: it added its full length
    // (~750ms) to EVERY rotation cycle (G6: 2266ms gaps at a 1500ms
    // cycle). Reset by destroyVisit().
    var visitHasShownImage = false;
    // Guards the fade-out delay below against being superseded by a
    // newer clearOwnRotation()/startOwnRotation() call before its own
    // setTimeout fires (e.g. the user leaves and immediately re-enters,
    // or destroyVisit() runs twice in quick succession) - only the
    // LATEST fade-out is ever allowed to actually remove anything or
    // touch opacity.
    var clearFadeToken = 0;
    // How long to wait for BackdropsPlus's own "incoming image ready"
    // signal before giving up and fading on our own, uncoordinated
    // schedule anyway - covers every case where nothing will ever
    // signal (Home/any other non-backdrop page, or a destination where
    // BackdropsPlus itself is disabled/has no backdrop of its own).
    // Generous relative to BackdropsPlus's own typical settings+item+
    // allowed-indices round trip (2-3 sequential fetches), but still
    // short enough that a genuinely signal-less navigation doesn't
    // leave the old image sitting untouched for long.
    var MAX_WAIT_FOR_INCOMING_MS = 1200;

    // Actually removes the currently-showing content (Ken Burns wrapper
    // or plain image, whichever is active) and resets the container to
    // a clean state - shared by both the delayed, faded-out removal
    // below AND startOwnRotation's own immediate cleanup before it
    // renders a genuinely fresh image (a stale, still-waiting-to-fade
    // Ken Burns wrapper must never be left behind when a new render
    // starts, or getKenBurnsFrame() could either wrongly reuse it or,
    // if Ken Burns is off for the new image, leave it orphaned
    // alongside the new plain image).
    function removeExistingBackdropContent() {
        if (kenBurnsFrameEl && kenBurnsFrameEl.parentNode) {
            var zoomWrapper = kenBurnsFrameEl.parentNode; // .artworkplus-kenburns-zoom
            if (zoomWrapper.parentNode) { zoomWrapper.parentNode.removeChild(zoomWrapper); }
        }
        kenBurnsFrameEl = null;
        if (backdropContainerEl) {
            while (backdropContainerEl.firstChild) {
                backdropContainerEl.removeChild(backdropContainerEl.firstChild);
            }
            backdropContainerEl.style.opacity = '';
            backdropContainerEl.style.transition = '';
        }
    }

    function clearOwnRotation() {
        rotationEngine.clear();
        if (pendingFadeCancel) { pendingFadeCancel(); pendingFadeCancel = null; }
        // Real regression found via explicit user report + source
        // comparison against vanilla: leaving a person page for a movie/
        // series detail page used to cut instantly here (this container
        // and BackdropsPlus's own, completely separate one, both sit at
        // the same low z-index - confirmed by reading both containers'
        // own inline styles - so they're free to overlap during a
        // transition without any stacking conflict). Fading this
        // container out first (rather than clearing it instantly) gave
        // BackdropsPlus's own incoming image room to crossfade in over
        // it - but with each side running its own, uncoordinated timer,
        // real testing (with realistic network latency, not just an
        // instant mock) showed the actual overlap was razor-thin: People's
        // own fixed-schedule fade-out nearly always finished before
        // BackdropsPlus's own multi-step fetch chain (settings, item,
        // allowed-indices - all sequential) even started its own fade-in,
        // so it visually read as "fade to black, then fade in" rather
        // than a genuine crossfade.
        // Explicit user request, and confirmed feasible specifically
        // because both scripts now live in this same file: rather than
        // fading on a fixed schedule, wait for BackdropsPlus's own signal
        // (ArtworkPlusBackdropTransition, declared once near the top of
        // this file, shared by both IIFEs) that its incoming image has
        // actually started its own fade-in, and start OUR fade-out at
        // that exact same moment - a genuine, synchronized crossfade,
        // not a timing coincidence. Falls back to the old, own-schedule
        // fade if nothing signals within MAX_WAIT_FOR_INCOMING_MS (Home,
        // or any destination where BackdropsPlus itself won't render
        // anything) - see that constant's own doc comment.
        // Deliberately does NOT touch the same-person-subpage-change
        // path at all (that path never calls destroyVisit()/this
        // function in the first place - completely untouched, zero risk
        // of regression there).
        if (!backdropContainerEl || !backdropContainerEl.firstChild || backdropContainerEl.style.opacity === '0') {
            return; // nothing currently showing, or already mid-fade-out
        }

        var myClearToken = ++clearFadeToken;
        var elToClear = backdropContainerEl;
        var fired = false;

        function startFadeNow() {
            // Guards against BOTH the signal AND the fallback timeout
            // firing (only the first of the two should ever act), AND
            // against a newer clearOwnRotation()/startOwnRotation() call
            // having superseded this one entirely in the meantime -
            // real bug found via testing (not just reasoning): the
            // Core.js "burst" mechanism calls start() up to 4 times per
            // navigation (0/300/800/1500ms) - for a genuine leave, every
            // one of those would otherwise re-enter this whole function
            // and could restart the wait/fade repeatedly, the same
            // "never actually completes" failure mode fixed once already
            // for the old fixed-schedule version.
            if (fired || myClearToken !== clearFadeToken) { return; }
            fired = true;
            elToClear.style.transition = 'opacity ' + FADE_MS + 'ms ease';
            elToClear.style.opacity = '0';
            setTimeout(function () {
                if (myClearToken !== clearFadeToken) { return; }
                removeExistingBackdropContent();
            }, FADE_MS);
        }

        ArtworkPlusBackdropTransition.onNextIncomingReady(startFadeNow);
        setTimeout(startFadeNow, MAX_WAIT_FOR_INCOMING_MS);
    }

    // PERSON_LEAVE / PERSON_RESET - the ONLY place a full teardown
    // happens. Called for every case that is NOT a same-person subpage
    // change: leaving to an unrelated page, switching to a different
    // person, and re-entering the SAME person after a real leave (that
    // last case deliberately gets no special "maybe reuse the old
    // state" treatment - "LEAVE = DESTROY" is an intentional design
    // choice, not an oversight).
    function destroyVisit() {
        visitId++; // invalidates every still-pending callback from the old visit
        visitAbortControllers.forEach(function (controller) {
            try { controller.abort(); } catch (e) { /* already aborted/settled - fine */ }
        });
        visitAbortControllers.clear();
        fetchInProgressKeys.clear();
        fetchedScopesThisVisit.clear();
        alreadyPreloadedUrls.clear();
        clearOwnRotation();
        rotationStarted = false;
        visitHasShownImage = false;
        activePersonId = null;
        activeScope = null;
        // See weSetWithBackdrop's own doc comment: only reset the class
        // if WE were the one who last set it to true. Runs synchronously
        // here, at the very start of every non-subpage-change navigation
        // (before any other feature's own async fetch/preload could
        // possibly have set its own true afterward), so there is no
        // window in which this could clobber a DIFFERENT feature's own,
        // later-arriving backdrop.
        if (weSetWithBackdrop) {
            setBackgroundContainerWithBackdrop(false);
        }
    }

    // -----------------------------------------------------------------
    // Rendering a single image for the CURRENT visit. myVisitId is
    // captured by the caller before any async work starts and checked
    // again here and in every callback below - a mismatch means a real
    // visit change happened in the meantime and this call must do
    // nothing further (STALE_VISIT_IGNORED).
    // -----------------------------------------------------------------

    // onShown: invoked exactly when the fade actually begins (NOT when the
    // element is appended) - see the audit note at its call site in
    // setBackdropImageWithSkipOnFailure for why that distinction matters.
    function renderPreloadedBackdropImage(url, kenBurnsEnabled, zoomMs, panMs, onShown) {
        ensureWithBackdropDefense();
        var frame = getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs);
        var existing = frame.querySelector('.displayingBackdropImage');
        if (existing && existing.getAttribute('data-url') === url) {
            // Already showing exactly this - still report "shown" so the
            // rotation timer re-anchors rather than stalling.
            if (onShown) { onShown(); }
            return;
        }

        var div = document.createElement('div');
        // 'backdropImageFadeIn' is deliberately NOT added - it is
        // Jellyfin's own native class with its own uncontrollable 0.8s
        // @keyframes animation that overrides an element's own inline
        // opacity while running. A real, own transition is set instead
        // for actual working control over the fade.
        div.classList.add('backdropImage', 'displayingBackdropImage');
        div.style.transition = 'opacity ' + FADE_MS + 'ms ease';
        // Gives the element its own compositor layer so that, should a
        // main-thread burst still land AFTER the fade has started (the
        // quiet-window wait above makes this unlikely, not impossible),
        // the opacity transition keeps being composited on the
        // compositor thread instead of freezing with the main thread -
        // the standard, documented purpose of will-change for opacity.
        // Honest note: this specific effect cannot be observed in the
        // headless test environment (screenshots there require the
        // renderer main thread), so unlike everything else in this
        // function it is included on documented browser behavior rather
        // than a local measurement. Cost: one layer per image, at most
        // two images exist at once.
        div.style.willChange = 'opacity';
        div.style.opacity = '0';
        div.setAttribute('data-url', url);
        div.style.backgroundImage = Core.cssUrl(url);

        if (existing) { existing.classList.remove('displayingBackdropImage'); }
        frame.appendChild(div);

        // Deliberately NOT calling pendingFadeCancel() here (a full
        // audit found an earlier draft did): that cancel function
        // belongs to the PREVIOUS render and, besides its own fade rAFs,
        // also owns the transitionend/timeout cleanup that removes the
        // PREVIOUS render's own predecessor element. Cancelling it on
        // every new render would silently abort that removal whenever a
        // new render arrived before it fired (e.g. a background tab
        // where transitionend never fires and only the FADE_MS+1000ms
        // fallback would have removed it) - leaving an orphaned,
        // never-removed .backdropImage in the DOM. The previous fade
        // rAFs firing late are harmless (they'd set opacity=1 on an
        // element that's already displaying / already being replaced).
        // pendingFadeCancel is for clearOwnRotation()/destroyVisit()
        // only, where the container is emptied anyway.

        // REAL BUG FOUND AND FIXED (user report: on a fresh entry into a
        // person page whose first image is available immediately, the
        // fade is "swallowed" - technically it runs, visually it reads
        // as a hard cut; with a little load delay the very same fade is
        // clearly visible). Cause: a CSS transition runs on wall-clock
        // time regardless of whether the browser actually gets to paint
        // frames. Right after entering a person page Jellyfin is busy
        // building the whole view (its own item fetch, poster decodes,
        // layout - real logs show 60-90ms long tasks in exactly this
        // window), so an 800ms fade started in that window plays out
        // largely between painted frames. The old fixed double-rAF only
        // guaranteed the initial opacity:0 had been committed, not that
        // the page was quiet enough to show the fade. Now the fade only
        // starts once two CONSECUTIVE animation frames arrived within a
        // normal frame interval (<= 34ms, i.e. the main thread is free
        // and actually painting), capped at 1500ms so a permanently
        // janky device still gets its image. On an idle page this is the
        // same two frames as before - zero added latency; the wait only
        // exists when the page is genuinely too busy to show a fade
        // anyway. Deliberately NOT a fixed delay: that would either be
        // too short under load or add a pointless wait when idle.
        // Measured in a reproduction (100ms idle after append, then a
        // 400ms main-thread block, i.e. Jellyfin's own view build
        // landing mid-fade): the old fade got to 7% before the block and
        // the next painted frame was already at 88% - only 9 of the ~31
        // intermediate frames of an 800ms fade ever reached the screen.
        // Waiting for just two quiet frames did not help (the page was
        // briefly quiet, THEN the burst hit). What does help, measurably,
        // is requiring a SUSTAINED quiet window - QUIET_FRAMES_NEEDED
        // consecutive frames each within a normal frame interval - so
        // the fade only begins once the page has genuinely settled. On
        // an idle page this costs ~200ms once; while the page is busy
        // it waits exactly as long as needed. Capped so a permanently
        // janky device still gets its image.
        // Tuned by measurement against the real activity waveform from a
        // production log (Jellyfin's own view build lands in WAVES until
        // ~+2.1s after viewshow: a long task at +300, poster decodes at
        // +584..+763, a second poster wave at +1889..+2070) and a
        // deliberately later/longer variant: 12 frames (~200ms) was
        // perfect on the real pattern but lost frames on the later one;
        // 30 frames actually started INSIDE the later wave (visible 0.14
        // jump - a longer window is not monotonically safer); 45 frames
        // (~750ms of sustained calm) was the smallest window perfect on
        // both. Explicit user decision: stability over speed - a fade
        // that is always fully visible beats one that is ~1s earlier but
        // occasionally swallowed. The cap is raised to match: with the
        // waves ending ~+2.1s, a 2000ms cap could itself fire mid-wave.
        // Only the visit's FIRST image waits for the page to settle; later
        // rotation images just need the two frames that let the initial
        // opacity:0 commit (the pre-quiet-window behavior, which was
        // measured accurate to 5ms) - see visitHasShownImage.
        var QUIET_FRAMES_NEEDED = visitHasShownImage ? 2 : 45;
        var QUIET_WAIT_CAP_MS = 3500;
        var cancelled = false;
        var currentRafId = null;
        var appendedAt = performance.now();
        var previousFrameTs = null;
        var quietRun = 0;
        var beginFade = function () {
            if (cancelled) { return; }
            currentRafId = null;
            // Session 86, Fade-Konzept: People selbst hat dieses Signal
            // bisher NIE gesendet - nur empfangen (siehe clearOwnRotation
            // weiter unten). Jetzt symmetrisch: People nimmt auch als
            // "eingehende Seite" am gemeinsamen Signal teil, z.B. wenn
            // eine andere Kategorie beim Verlassen darauf wartet.
            ArtworkPlusBackdropTransition.notifyIncomingReady();
            div.style.opacity = '1';
            if (!visitHasShownImage) {
                // REAL BUG FOUND AND FIXED (user: "nichts -> so eine Art
                // Schwarzblende -> dann Fade"): applying '.withBackdrop'
                // switches Jellyfin's .backgroundContainer from opaque
                // #101010 to rgba(0,0,0,0.86) with NO transition (verified
                // in the real CSS). At fade start the image underneath is
                // still at opacity 0, so the page snapped from dark grey
                // to near-black in a single frame and only THEN faded the
                // image in - two separate visual events. Measured (visible
                // brightness per frame): 16 -> 3 -> 3 -> 4 ... vs. with
                // this fix 16 -> 15 -> 14 -> 15 -> 16 -> 18 ... - one
                // smooth rise, no dip. It only ever showed when the class
                // was NOT already set (i.e. Jellyfin's own async
                // clearBackdrop() had removed it before our now-later
                // fade start), which is why it looked right sometimes and
                // wrong other times. Scoped tightly: first image of the
                // visit only, only if the class isn't already there, and
                // the inline transition is removed again right after the
                // fade so Jellyfin's own overlay toggles on every other
                // page stay exactly as they were. Deliberately a plain
                // setTimeout (not tracker.track): the tracker is cleared
                // on every viewshow, which would strand the inline
                // transition on Jellyfin's element.
                var bgEl = document.querySelector('.backgroundContainer');
                if (bgEl && !bgEl.classList.contains('withBackdrop')) {
                    bgEl.style.transition = 'background-color ' + FADE_MS + 'ms ease';
                    setTimeout(function () { bgEl.style.transition = ''; }, FADE_MS + 100);
                }
            }
            setBackgroundContainerWithBackdrop(true);
            visitHasShownImage = true;
            if (onShown) { onShown(); }
        };
        var waitForQuietFrames = function (ts) {
            if (cancelled) { return; }
            if (previousFrameTs !== null && (ts - previousFrameTs) <= 34) { quietRun++; } else { quietRun = 0; }
            previousFrameTs = ts;
            if (quietRun >= QUIET_FRAMES_NEEDED || (performance.now() - appendedAt) >= QUIET_WAIT_CAP_MS) { beginFade(); return; }
            currentRafId = requestAnimationFrame(waitForQuietFrames);
        };
        currentRafId = requestAnimationFrame(waitForQuietFrames);

        var cleanupTimeoutId = null;
        var cleanup = null;
        if (existing) {
            cleanup = function (event) {
                if (event && event.propertyName && event.propertyName !== 'opacity') { return; }
                div.removeEventListener('transitionend', cleanup);
                if (cleanupTimeoutId) { clearTimeout(cleanupTimeoutId); cleanupTimeoutId = null; }
                if (existing.parentNode) { existing.parentNode.removeChild(existing); }
            };
            div.addEventListener('transitionend', cleanup);
            // Safety net in case transitionend doesn't fire (e.g. a
            // background tab being throttled) - same as
            // Backdrops-v1.js's own identical fallback.
            cleanupTimeoutId = setTimeout(cleanup, FADE_MS + 1000);
        }

        pendingFadeCancel = function () {
            cancelled = true;
            if (currentRafId !== null) { cancelAnimationFrame(currentRafId); }
            if (cleanup) { div.removeEventListener('transitionend', cleanup); }
            if (cleanupTimeoutId) { clearTimeout(cleanupTimeoutId); }
        };
    }

    // Real, user-requested resilience mechanism: a load failure should
    // immediately skip to the next image, not just silently fail and
    // wait for the next scheduled tick.
    function setBackdropImageWithSkipOnFailure(url, kenBurnsEnabled, zoomMs, panMs, onFailureAdvance) {
        var myVisitId = visitId;
        var frame = getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs);
        var existing = frame.querySelector('.displayingBackdropImage');
        if (existing && existing.getAttribute('data-url') === url) {
            // Same image picked again (possible in Random order, which
            // deliberately allows repeats) - nothing to re-render, but
            // the timer still needs "shown, starting now" for this new
            // tick, or it would effectively freeze.
            rotationEngine.imageShown();
            return;
        }

        preloadImage(url).then(function () {
            if (myVisitId !== visitId) {
                log('STALE_VISIT_IGNORED: image load succeeded for', url, 'but the visit that requested it has since ended - discarding');
                return;
            }
            // REAL BUG FOUND AND FIXED (scoped fade audit): imageShown() -
            // the rotation timer's anchor - used to be called right here,
            // immediately after the element was APPENDED. Since the fade
            // now waits for a sustained quiet window first, "appended" and
            // "visible" can be more than one cycle apart on a busy page:
            // reproduced with dense main-thread waves and a 1200ms cycle -
            // image 1 appended at 212ms, the rotation tick appended image
            // 2 at 1413ms while image 1 had NOT even started fading (its
            // fade began at 2373ms, simultaneously with image 2's), so
            // image 1 popped in hard behind image 2. The anchor now sits
            // at the actual fade start (onShown, fired from beginFade), so
            // every image is on screen for its full cycle and a second
            // image can never be scheduled before the first is visible.
            // If the fade is cancelled (visit ended) onShown never fires -
            // correct, the rotation was cleared anyway.
            renderPreloadedBackdropImage(url, kenBurnsEnabled, zoomMs, panMs, function () {
                rotationEngine.imageShown();
            });
        }).catch(function (e) {
            if (myVisitId !== visitId) {
                log('STALE_VISIT_IGNORED: image load failed for', url, 'but the visit that requested it has since ended - discarding');
                return;
            }
            log('Candidate image failed to load (dead hotlink?) - skipping to the next image immediately. URL:', url, e);
            onFailureAdvance(url);
        });
    }

    // -----------------------------------------------------------------
    // Our own rotation - shares Core.js's own rotation-timing engine
    // with Backdrops-v1.js (own, independent instance).
    // -----------------------------------------------------------------

    var rotationEngine = Core.createBackdropRotationEngine();

    function startOwnRotation(images, settings) {
        rotationStarted = true;
        // Only ever called for a genuinely fresh visit (the caller in
        // start() below already ran destroyVisit() first), so no
        // additional generation bump is needed here specifically - it
        // already happened. BUT: destroyVisit()'s own clearOwnRotation()
        // may now be mid-wait for BackdropsPlus's own "ready" signal (or
        // mid-fade, if the signal or fallback already fired) - see that
        // function's own doc comment. If the user leaves and re-enters
        // quickly enough that this is still in flight, its content
        // (Ken Burns wrapper or plain image) must be fully cleared here,
        // not just have its opacity reset - reusing removeExistingBack-
        // dropContent() (the same helper the fade path itself uses)
        // rather than only touching opacity/transition avoids leaving a
        // stale Ken Burns wrapper orphaned in the DOM if the new image
        // has Ken Burns off (getKenBurnsFrame() would otherwise never
        // remove it, only skip past it).
        clearFadeToken++;
        removeExistingBackdropContent();
        var effectiveCycleMs = Math.max(settings.CycleTimeMs, Math.ceil(FADE_MS * 1.5));
        rotationEngine.start(images, settings.OrderMode, effectiveCycleMs, function (url) {
            setBackdropImageWithSkipOnFailure(url, settings.KenBurnsEnabled, settings.KenBurnsZoomMs, settings.KenBurnsPanMs, function (failedUrl) {
                rotationEngine.removeFailedImage(failedUrl);
                rotationEngine.advance();
            });
        });
    }

    // ===================================================================
    // THE STATE MACHINE
    //
    //   NOT_ON_PERSON --(enter)--> PERSON_ACTIVE
    //   PERSON_ACTIVE --(subpage change, same personId)--> PERSON_ACTIVE
    //       (visitId UNCHANGED - nothing torn down, nothing restarted)
    //   PERSON_ACTIVE --(leave / different person / re-enter same
    //                     person after a leave)--> destroyVisit()
    //                     --> NOT_ON_PERSON or straight into a fresh
    //                         PERSON_ACTIVE for the new person
    //
    // This single function is now the ONLY place that decides which
    // transition applies - handleParsedLine() below no longer makes
    // its own separate "is this the same person" judgment call; it's
    // simply told isFreshVisit up front.
    // ===================================================================

    async function start() {
        var detected = detectPersonAndScope();
        var isSubpageChangeOnSamePerson = !!(detected && activePersonId !== null && detected.personId === activePersonId);

        if (!isSubpageChangeOnSamePerson) {
            // Every other case - leaving entirely, a different person,
            // or re-entering the same person after a real leave - is a
            // full PERSON_RESET. Safe to call even if nothing was
            // active (activePersonId already null): destroyVisit()'s
            // own work is then simply a cheap, harmless no-op-ish
            // cleanup.
            destroyVisit();
        }

        if (!detected) {
            return; // PERSON_LEAVE complete (destroyVisit() already ran above)
        }

        if (isSubpageChangeOnSamePerson) {
            // PERSON_SUBPAGE_CHANGE - the defining case of this whole
            // rewrite: visitId stays EXACTLY as it was, nothing above
            // touched it. If this exact scope was already fetched
            // before, there's nothing further to do at all.
            if (detected.scope === activeScope) { return; }
            activeScope = detected.scope;
            if (fetchedScopesThisVisit.has(detected.scope)) {
                // This scope was already definitively answered during
                // this same visit - nothing new to learn from the
                // server (see fetchedScopesThisVisit's own doc comment).
                // The running rotation, if any, simply continues.
                return;
            }
            // Seamless continuation (addImages into the running
            // rotation) is only correct if a rotation is actually
            // running. If the earlier scope resolved to "not applicable"
            // (rotationStarted still false), this new scope must start
            // the rotation itself - see rotationStarted's own doc
            // comment.
            fetchAndApplyForVisit(detected, visitId, /* isFreshVisit */ !rotationStarted);
            return;
        }

        // PERSON_ENTER - fresh visit, destroyVisit() already ran above.
        activePersonId = detected.personId;
        activeScope = detected.scope;
        fetchAndApplyForVisit(detected, visitId, /* isFreshVisit */ true);
    }

    // Fetches and streams this visit's data. myVisitId is captured by
    // the caller (start()) and compared throughout - the single source
    // of truth for staleness.
    async function fetchAndApplyForVisit(detected, myVisitId, isFreshVisit) {
        var key = detected.personId + '|' + detected.scope;
        if (fetchInProgressKeys.has(key)) {
            log('Fetch for', key, 'already in flight for this visit (burst attempt caught by the in-flight guard), skipping duplicate request');
            return;
        }
        fetchInProgressKeys.add(key);

        var controller = new AbortController();
        visitAbortControllers.add(controller);

        log('Detected', detected.personId, '| Scope:', detected.scope, '- fetching', isFreshVisit ? '(fresh visit)' : '(same-person subpage - seamless continuation)');

        var settings = null;
        var receivedAnyImage = false;

        function handleParsedLine(parsed) {
            if (parsed.Type === 'Header') {
                settings = parsed;
            } else if (parsed.Type === 'Image' && parsed.Url) {
                if (!settings) {
                    // Protocol violation (the server always sends Header
                    // first - see PeopleBackdropsStreamLine) - without
                    // this guard, settings.OrderMode below would throw
                    // and abort the whole stream. Skip the line and keep
                    // reading rather than crash.
                    log('Protocol violation: Image line arrived before the Header line, skipping it:', parsed.Url);
                    return;
                }
                if (!receivedAnyImage) {
                    receivedAnyImage = true;
                    if (isFreshVisit) {
                        // Explicit point of streaming: time-to-first-
                        // visible-image is bounded by ONE accepted
                        // candidate, not the full population flow.
                        startOwnRotation([parsed.Url], {
                            OrderMode: settings.OrderMode,
                            CycleTimeMs: settings.CycleTimeMs,
                            KenBurnsEnabled: settings.KenBurnsEnabled,
                            KenBurnsZoomMs: settings.KenBurnsZoomMs,
                            KenBurnsPanMs: settings.KenBurnsPanMs
                        });
                    } else {
                        // Same-person subpage continuation: the
                        // rotation is already running (or about to be,
                        // from an earlier still-in-flight fetch for
                        // this same visit) - just add this candidate to
                        // the pool.
                        rotationEngine.addImages([parsed.Url]);
                        silentlyPreloadOnce(parsed.Url);
                    }
                } else {
                    rotationEngine.addImages([parsed.Url]);
                    silentlyPreloadOnce(parsed.Url);
                }
            }
        }

        try {
            var response = await fetch('/PeopleBackdrops/' + encodeURIComponent(detected.personId) + '?scope=' + detected.scope, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) {
                log('Server responded with HTTP', response.status, response.statusText, '- this is NOT the normal "not applicable" path (the controller always returns 200 for that), check the Jellyfin server log and/or any reverse proxy in front of it');
            }

            if (response.body && typeof response.body.getReader === 'function') {
                var reader = response.body.getReader();
                var decoder = new TextDecoder('utf-8');
                var buffer = '';

                while (true) {
                    var readResult = await reader.read();
                    if (readResult.done) { break; }

                    buffer += decoder.decode(readResult.value, { stream: true });
                    var lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (var i = 0; i < lines.length; i++) {
                        if (myVisitId !== visitId) {
                            reader.cancel().catch(function () {});
                            log('STALE_VISIT_IGNORED: aborting mid-chunk stream read for', key, '- a newer visit has started');
                            // No Set cleanup here: visitId already
                            // changed, so destroyVisit() has cleared
                            // both Sets, and any entries present now
                            // belong to the NEWER visit - see the
                            // catch block's own doc comment.
                            return;
                        }
                        var line = lines[i].trim();
                        if (!line) { continue; }
                        try {
                            handleParsedLine(JSON.parse(line));
                        } catch (parseErr) {
                            log('Failed to parse one NDJSON stream line, skipping just this line:', line, parseErr);
                        }
                    }

                    if (myVisitId !== visitId) {
                        reader.cancel().catch(function () {});
                        log('STALE_VISIT_IGNORED: aborting stream for', key, '- a newer visit has started');
                        return;
                    }
                }

                var finalLine = buffer.trim();
                if (finalLine) {
                    try {
                        handleParsedLine(JSON.parse(finalLine));
                    } catch (parseErr) {
                        log('Failed to parse the final NDJSON stream line, skipping:', finalLine, parseErr);
                    }
                }
            } else {
                var fullText = await response.text();
                var fallbackLines = fullText.split('\n');
                for (var j = 0; j < fallbackLines.length; j++) {
                    var fallbackLine = fallbackLines[j].trim();
                    if (!fallbackLine) { continue; }
                    try {
                        handleParsedLine(JSON.parse(fallbackLine));
                    } catch (parseErr) {
                        log('Failed to parse one NDJSON stream line (fallback path), skipping just this line:', fallbackLine, parseErr);
                    }
                }
            }
        } catch (e) {
            // Only touch the visit-scoped bookkeeping if this fetch
            // still belongs to the CURRENT visit. If destroyVisit()
            // already ran (which aborts this fetch AND clears both
            // Sets), a fresh visit for the very same key may already
            // have re-registered itself by the time this async catch
            // runs - deleting blindly here would remove the NEW
            // visit's own guard. (Found by audit as a state-correctness
            // issue; start()'s own same-person/same-scope early return
            // currently masks any visible effect, but the Set must not
            // be wrong regardless.)
            if (myVisitId === visitId) {
                fetchInProgressKeys.delete(key);
                visitAbortControllers.delete(controller);
            }
            if (e && e.name === 'AbortError') {
                // Expected, not an error: destroyVisit() aborted this
                // fetch because the visit it belonged to has ended.
                // Nothing further to do - no retry, since a genuine
                // fresh visit (if the user is now somewhere relevant)
                // already started its own independent fetch when
                // destroyVisit()'s caller (start()) proceeded.
                log('Fetch aborted for', key, '(visit ended)');
                return;
            }
            log('Fetch or streaming failed for', key, '- check that the ArtworkPlus plugin is installed/enabled, and check the Jellyfin server log around this time for a matching error', e);
            if (myVisitId === visitId && isFreshVisit && !rotationStarted) {
                // A genuine (non-abort) failure on a fresh visit with
                // nothing shown yet: unlike the definitive "not
                // applicable" answer below, a network/server error is
                // transient - reset so the burst mechanism's remaining
                // staggered attempts (and any later start() for this
                // hash) genuinely retry rather than hitting start()'s
                // same-person/same-scope early return forever.
                activePersonId = null;
                activeScope = null;
            }
            return;
        }

        if (myVisitId === visitId) {
            fetchInProgressKeys.delete(key);
            visitAbortControllers.delete(controller);
        }

        if (myVisitId !== visitId) {
            log('STALE_VISIT_IGNORED: fetch for', key, 'completed but a newer visit has since started - discarding result');
            return;
        }

        if (!settings || !settings.IsApplicable || !receivedAnyImage) {
            log('Not applicable for', key, '- reason:', (settings && settings.Reason) || '(no reason given by server - unexpected, check the Jellyfin server log)');
            fetchedScopesThisVisit.add(detected.scope);
            if (isFreshVisit) {
                // A fresh visit that turned out to have nothing to show.
                // The container is cleared, but activePersonId/
                // activeScope are DELIBERATELY KEPT SET: this is a
                // definitive, final answer for this key ("0 images" is
                // an ordinary result, not an error), and the burst
                // mechanism (schedule() fires start() again at 300/800/
                // 1500ms) plus any later same-hash start() call must
                // hit start()'s own "same person, same scope, nothing
                // to do" early return instead of re-fetching. A full
                // audit found an earlier draft reset them to null here,
                // which re-introduced the exact historical bug this
                // project already fixed once: 6 redundant fetches for a
                // single person with 0 images within ~2 seconds.
                // rotationStarted stays false (startOwnRotation() was
                // never reached), so a later same-person subpage change
                // correctly starts fresh instead of addImages()-ing into
                // an engine that was never started.
                clearOwnRotation();
            }
            // If this was a same-person subpage continuation that
            // turned out not applicable, deliberately leave the
            // existing, already-running rotation (from an earlier
            // scope) completely untouched.
            return;
        }

        fetchedScopesThisVisit.add(detected.scope);
        log('People Backdrops shown for person', detected.personId, '| Scope:', detected.scope, '| Order:', settings.OrderMode, '| Cycle:', settings.CycleTimeMs + 'ms');
    }

    function schedule() {
        tracker.clearTimers();
        Core.scheduleNavigationBurst(function () {
            start();
        }, tracker.track);
    }

    document.addEventListener('viewshow', schedule);
    // Continuous poll as a backup - see Core's watchForNavigation doc
    // comment.
    Core.watchForNavigation(schedule);
    setTimeout(schedule, 1200);
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
    var DEBUG = true; // gated at runtime by localStorage.ArtworkPlusDebug (Core.makeLogger, Session 114)
    function log() {
        if (!DEBUG) { return; }
        var args = ['[ArtworkPlus GenreBackdrops]'].concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
    }

    var FADE_MS = 800;

    // Own container - library-view pages have no equivalent native
    // single-backdrop element to reuse, same reasoning as People
    // Backdrops' own getBackdropContainer() (see that function's own
    // doc comment above in this file for the full class-collision bug
    // history that shaped this pattern).
    var backdropContainerEl = null;
    function getBackdropContainer() {
        if (backdropContainerEl && document.body.contains(backdropContainerEl)) { return backdropContainerEl; }
        backdropContainerEl = document.querySelector('.artworkplus-genre-backdrop');
        if (!backdropContainerEl) {
            backdropContainerEl = document.createElement('div');
            backdropContainerEl.classList.add('artworkplus-genre-backdrop');
            backdropContainerEl.style.position = 'fixed';
            backdropContainerEl.style.top = '0';
            backdropContainerEl.style.left = '0';
            backdropContainerEl.style.right = '0';
            backdropContainerEl.style.bottom = '0';
            backdropContainerEl.style.zIndex = '-1';
            backdropContainerEl.style.contain = 'layout style size';
            document.body.insertBefore(backdropContainerEl, document.body.firstChild);
            log('Created own .artworkplus-genre-backdrop container');
        }
        return backdropContainerEl;
    }

    var kenBurnsFrameEl = null;
    function getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs) {
        var container = getBackdropContainer();
        if (!kenBurnsEnabled) { return container; }
        if (kenBurnsFrameEl && container.contains(kenBurnsFrameEl)) {
            return kenBurnsFrameEl; // already running - do NOT restart the animation
        }

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

        var KEN_BURNS_ZOOM_START = 1;
        var KEN_BURNS_ZOOM_END = 1.12;
        var KEN_BURNS_PAN_PX = 30;
        var KEN_BURNS_EASING = 'ease-in-out';

        var zoomAnimation = zoomEl.animate(
            [{ transform: 'scale(' + KEN_BURNS_ZOOM_START + ')' }, { transform: 'scale(' + KEN_BURNS_ZOOM_END + ')' }],
            { duration: zoomMs, easing: KEN_BURNS_EASING, iterations: Infinity, direction: 'alternate' }
        );
        zoomAnimation.currentTime = Math.random() * zoomMs;
        var panAnimation = panEl.animate(
            [
                { transform: 'translate(-' + KEN_BURNS_PAN_PX + 'px, -' + KEN_BURNS_PAN_PX + 'px)' },
                { transform: 'translate(' + KEN_BURNS_PAN_PX + 'px, ' + KEN_BURNS_PAN_PX + 'px)' }
            ],
            { duration: panMs, easing: KEN_BURNS_EASING, iterations: Infinity, direction: 'alternate' }
        );
        panAnimation.currentTime = Math.random() * panMs;

        kenBurnsFrameEl = panEl;
        return panEl;
    }

    var backgroundContainerConfirmedOnce = false;
    function setBackgroundContainerWithBackdrop(hasBackdrop) {
        var bg = document.querySelector('.backgroundContainer');
        if (!bg) {
            log('WARNING: .backgroundContainer not found in the DOM.');
            return;
        }
        bg.classList.toggle('withBackdrop', hasBackdrop);
        if (hasBackdrop && !backgroundContainerConfirmedOnce) {
            backgroundContainerConfirmedOnce = true;
            log('.backgroundContainer found and .withBackdrop applied');
        }
    }

    // renderGeneration guard - same purpose as the first IIFE's own
    // identically-named variable (see setBackdropImage's own doc
    // comment above in this file): discards an image that finishes
    // loading after a NEWER clearOwnRotation()/loadGenreBackdrops() call
    // has already superseded it.
    var renderGeneration = 0;
    var rotationEngine = null;
    var preloadNextHook = null; // Session 116: set by the loader, warms the next image on idle

    // Session 86, fade concept: the same value as in People/Detail View -
    // see MAX_WAIT_FOR_INCOMING_MS's own detailed comment there
    // (deliberately duplicated per IIFE, no shared variable - exactly the
    // same isolation convention as FADE_MS/log() in this file).
    var MAX_WAIT_FOR_INCOMING_MS = 1200;

    function clearOwnRotation() {
        renderGeneration++;
        if (rotationEngine) { rotationEngine.clear(); }
        var container = document.querySelector('.artworkplus-genre-backdrop');
        if (!container || !container.firstChild || container.style.opacity === '0') {
            if (container) { container.innerHTML = ''; }
            kenBurnsFrameEl = null;
            setBackgroundContainerWithBackdrop(false);
            return;
        }
        // BUG FIXED (Session 86, fade concept): innerHTML='' used to be
        // called here immediately - a hard cut when leaving Genre,
        // regardless of what comes next. Now like People: first wait
        // briefly for the next notifyIncomingReady() of any other
        // category (real crossfade when another category takes over in
        // time), with a timeout fallback in case nothing takes over
        // (e.g. going back to the home page).
        var fired = false;
        // Session 116 (live recording): this deferred fade used to wipe
        // the container unconditionally. Leaving category page A and
        // entering page B of the SAME category within ~1.2 s let A's
        // fallback delete B's freshly appended first image ("removed
        // ... imgs=2" 17 ms after "img+"), leaving the page black until
        // the next rotation tick a full cycle later. Now the fade only
        // runs if no newer render has taken the container over since.
        var clearGeneration = renderGeneration;
        function startFadeNow() {
            if (fired) { return; }
            fired = true;
            if (renderGeneration !== clearGeneration) { return; } // a newer render owns the container
            container.style.transition = 'opacity ' + FADE_MS + 'ms ease';
            container.style.opacity = '0';
            setTimeout(function () {
                if (renderGeneration !== clearGeneration) {
                    // A render started during the fade-out: keep its
                    // content, just restore the container's opacity.
                    container.style.opacity = '';
                    container.style.transition = '';
                    return;
                }
                container.innerHTML = '';
                container.style.opacity = '';
                container.style.transition = '';
                kenBurnsFrameEl = null;
                setBackgroundContainerWithBackdrop(false);
            }, FADE_MS);
        }
        ArtworkPlusBackdropTransition.onNextIncomingReady(startFadeNow);
        setTimeout(startFadeNow, MAX_WAIT_FOR_INCOMING_MS);
    }

    function setBackdropImage(url, kenBurnsEnabled, zoomMs, panMs, onFailure) {
        var myGeneration = renderGeneration;
        var frame = getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs);
        var existing = frame.querySelector('.displayingBackdropImage');
        if (existing && existing.getAttribute('data-url') === url) {
            // Same image picked again (possible in Random order) -
            // nothing to re-render, but the engine still needs its
            // "shown, starting the timer now" confirmation for this
            // tick, same reasoning as the two IIFEs above.
            rotationEngine.imageShown();
            return;
        }

        Core.preloadImage(url).then(function () {
            if (myGeneration !== renderGeneration) {
                log('Discarding a stale image render for a no-longer-current rotation. URL:', url);
                return;
            }
            var img = document.createElement('img');
            img.className = 'backdropImage displayingBackdropImage';
            img.setAttribute('data-url', url);
            // Session 116: the src assignment was missing in all four
            // library-view IIFEs (Genre/Studio/Tag/Favorites) - the image
            // was preloaded and the element appended, but stayed empty.
            // Found live: "background turns black, no picture".
            img.src = url;
            img.style.position = 'absolute';
            img.style.inset = '0';
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.opacity = '0';
            img.style.transition = 'opacity ' + FADE_MS + 'ms';
            frame.appendChild(img);
            // Session 116: force the initial opacity:0 to be computed
            // before switching to 1 - without this flush the transition
            // has no start value and the image pops in hard.
            void img.offsetWidth;
            // If a clear() fade-out is in flight on this container, the
            // render above has bumped renderGeneration, so the clear
            // keeps the content - but the container may already be at
            // opacity 0 (or transitioning there). Restore it here.
            var ownContainer = frame.closest('[class*="artworkplus-"][class*="backdrop"]');
            if (ownContainer && ownContainer.style.opacity === '0') {
                ownContainer.style.transition = '';
                ownContainer.style.opacity = '';
            }
            requestAnimationFrame(function () {
                // Session 86, Fade-Konzept: Genre nimmt jetzt am
                // gemeinsamen, projektweiten Signal teil.
                ArtworkPlusBackdropTransition.notifyIncomingReady();
                img.style.opacity = '1';
            });
            setBackgroundContainerWithBackdrop(true);
            rotationEngine.imageShown();
            if (typeof preloadNextHook === 'function') { preloadNextHook(); }

            var previous = existing;
            if (previous) {
                previous.style.opacity = '0';
                setTimeout(function () {
                    if (previous.parentNode) { previous.parentNode.removeChild(previous); }
                }, FADE_MS);
            }
        }).catch(function () {
            if (myGeneration !== renderGeneration) { return; }
            if (onFailure) { onFailure(url); }
        });
    }

    // -----------------------------------------------------------------
    // Detecting a genre-filtered library-view page. URL scheme confirmed
    // against jellyfin-web's own source (list.js, moviegenres.js,
    // tvgenres.js) - not guessed: #/list.html?genreId=X, optionally with
    // &parentId=Y when reached from a specific library's own Movies/TV
    // shows genre tab. Global genre list = genreId present, parentId
    // absent. The server endpoint (GetGenrePool) does the actual
    // CollectionType lookup for parentId - this function only extracts
    // the two raw ids from the hash.
    // -----------------------------------------------------------------
    function detectGenreListPage() {
        var hash = window.location.hash || '';
        var qIndex = hash.indexOf('?');
        if (qIndex === -1) { return null; }
        var path = hash.slice(0, qIndex);
        if (path.indexOf('list.html') === -1) { return null; }
        var params = new URLSearchParams(hash.slice(qIndex + 1));
        var genreId = params.get('genreId');
        if (!genreId) { return null; }
        return { genreId: genreId, parentId: params.get('parentId') || null };
    }

    // Guards against re-fetching/reshuffling mid-visit if viewshow fires
    // again for the SAME genre (e.g. a filter/sort change on the page
    // itself, which does not change genreId) - matches this project's
    // own concept decision: fresh pool+shuffle per NAVIGATION to a new
    // genre, stable while staying on the same one.
    var activeGenreId = null;
    var loadToken = 0;

    async function loadGenreBackdrops() {
        var detected = detectGenreListPage();
        if (!detected) {
            if (activeGenreId !== null) {
                activeGenreId = null;
                clearOwnRotation();
            }
            return;
        }
        if (detected.genreId === activeGenreId) { return; }

        var myToken = ++loadToken;
        activeGenreId = detected.genreId;

        var poolParams = { genreId: detected.genreId };
        if (detected.parentId) { poolParams.parentId = detected.parentId; }
        var url = window.ApiClient.getUrl('Backdrops/genre-pool', poolParams);

        var settings;
        try {
            settings = await window.ApiClient.getJSON(url);
        } catch (e) {
            log('Could not load genre pool', e);
            return;
        }
        if (myToken !== loadToken) { return; } // a newer navigation already started

        if (!settings.Enabled || !settings.Images || !settings.Images.length) {
            clearOwnRotation();
            log('Genre Backdrops: not enabled or no images for this genre');
            return;
        }

        var urls = settings.Images.map(function (entry) {
            return window.ApiClient.getScaledImageUrl(entry.SourceId, {
                type: 'Backdrop',
                tag: entry.Tag,
                maxWidth: window.innerWidth,
                index: entry.Index
            });
        });

        // Session 116: no bulk preload of the whole pool any more (99
        // requests + decoding per page view, measured live as 1.4 s long
        // tasks while the grid's own tiles were still loading). Backdrops
        // come last on every page: only the next image is warmed, and
        // only when the browser is idle.
        var preloadNext = function () {
            var next = rotationEngine && rotationEngine.peekNext ? rotationEngine.peekNext() : null;
            if (!next) { return; }
            Core.preloadImage(next, { priority: 'low' }).catch(function () { /* not a verdict, see setBackdropImage's own real attempt */ });
        };
        var scheduleIdle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1500); };

        var orderMode = (settings.SortMode === 'Shuffle' || settings.SortMode === 'Random') ? settings.SortMode : 'Sequential';
        var effectiveCycleMs = Math.max(settings.CycleTimeMs, Math.ceil(FADE_MS * 1.5));

        if (rotationEngine) { rotationEngine.clear(); }
        // Session 116: a new render takes ownership of the container -
        // any clear() fade still pending from the page we just left
        // compares against this and leaves our content alone.
        renderGeneration++;
        rotationEngine = Core.createBackdropRotationEngine();
        preloadNextHook = function () { scheduleIdle(preloadNext); };
        rotationEngine.start(urls, orderMode, effectiveCycleMs, function (imgUrl) {
            setBackdropImage(imgUrl, settings.KenBurnsEnabled, settings.KenBurnsZoomMs, settings.KenBurnsPanMs, function (failedUrl) {
                rotationEngine.removeFailedImage(failedUrl);
                rotationEngine.advance();
            });
        });

        log('Genre Backdrops shown | genreId:', detected.genreId, '| parentId:', detected.parentId, '| images:', urls.length, '| sort:', settings.SortMode);
    }

    var tracker = Core.createTimerTracker();
    function schedule() {
        tracker.clearTimers();
        Core.scheduleNavigationBurst(function () { loadGenreBackdrops(); }, tracker.track);
    }

    document.addEventListener('viewshow', schedule);
    Core.watchForNavigation(schedule);
    setTimeout(schedule, 1200);
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
    var DEBUG = true; // gated at runtime by localStorage.ArtworkPlusDebug (Core.makeLogger, Session 114)
    function log() {
        if (!DEBUG) { return; }
        console.log.apply(console, ['[ArtworkPlus StudioBackdrops]'].concat(Array.prototype.slice.call(arguments)));
    }
    // NEW (Session 86, fade concept): own constant instead of the
    // previously hard-wired '800ms' string - identical to the value of
    // all other five categories, now a real, central value here too.
    var FADE_MS = 800;

    var backdropContainerEl = null;
    function getBackdropContainer() {
        if (backdropContainerEl && document.body.contains(backdropContainerEl)) { return backdropContainerEl; }
        backdropContainerEl = document.querySelector('.artworkplus-studio-backdrop');
        if (!backdropContainerEl) {
            backdropContainerEl = document.createElement('div');
            backdropContainerEl.classList.add('artworkplus-studio-backdrop');
            backdropContainerEl.style.position = 'fixed';
            backdropContainerEl.style.top = '0';
            backdropContainerEl.style.left = '0';
            backdropContainerEl.style.right = '0';
            backdropContainerEl.style.bottom = '0';
            backdropContainerEl.style.zIndex = '-1';
            backdropContainerEl.style.contain = 'layout style size';
            document.body.insertBefore(backdropContainerEl, document.body.firstChild);
        }
        return backdropContainerEl;
    }

    var kenBurnsFrameEl = null;
    function getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs) {
        var container = getBackdropContainer();
        if (!kenBurnsEnabled) { return container; }
        if (kenBurnsFrameEl && container.contains(kenBurnsFrameEl)) { return kenBurnsFrameEl; }

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

        var ZOOM_START = 1, ZOOM_END = 1.12, PAN_PX = 30, EASING = 'ease-in-out';
        var zoomAnim = zoomEl.animate(
            [{ transform: 'scale(' + ZOOM_START + ')' }, { transform: 'scale(' + ZOOM_END + ')' }],
            { duration: zoomMs, easing: EASING, iterations: Infinity, direction: 'alternate' }
        );
        zoomAnim.currentTime = Math.random() * zoomMs;
        var panAnim = panEl.animate(
            [{ transform: 'translate(-' + PAN_PX + 'px, -' + PAN_PX + 'px)' }, { transform: 'translate(' + PAN_PX + 'px, ' + PAN_PX + 'px)' }],
            { duration: panMs, easing: EASING, iterations: Infinity, direction: 'alternate' }
        );
        panAnim.currentTime = Math.random() * panMs;

        kenBurnsFrameEl = panEl;
        return panEl;
    }

    function setBackgroundContainerWithBackdrop(hasBackdrop) {
        var bg = document.querySelector('.backgroundContainer');
        if (!bg) { return; }
        bg.classList.toggle('withBackdrop', hasBackdrop);
    }

    var renderGeneration = 0;
    // Session 116: Source=Appearances rotates like Genre - own engine
    // instance (see Core.createBackdropRotationEngine), null while the
    // Source is the single studio image.
    var rotationEngine = null;
    var preloadNextHook = null;
    // Session 86, fade concept: the same value as in the other five
    // categories, deliberately duplicated per IIFE.
    var MAX_WAIT_FOR_INCOMING_MS = 1200;
    function clearOwn() {
        renderGeneration++;
        if (rotationEngine) { rotationEngine.clear(); rotationEngine = null; }
        var container = document.querySelector('.artworkplus-studio-backdrop');
        if (!container || !container.firstChild || container.style.opacity === '0') {
            if (container) { container.innerHTML = ''; }
            kenBurnsFrameEl = null;
            setBackgroundContainerWithBackdrop(false);
            return;
        }
        var fired = false;
        // Session 116 (live recording): this deferred fade used to wipe
        // the container unconditionally. Leaving category page A and
        // entering page B of the SAME category within ~1.2 s let A's
        // fallback delete B's freshly appended first image ("removed
        // ... imgs=2" 17 ms after "img+"), leaving the page black until
        // the next rotation tick a full cycle later. Now the fade only
        // runs if no newer render has taken the container over since.
        var clearGeneration = renderGeneration;
        function startFadeNow() {
            if (fired) { return; }
            fired = true;
            if (renderGeneration !== clearGeneration) { return; } // a newer render owns the container
            container.style.transition = 'opacity ' + FADE_MS + 'ms ease';
            container.style.opacity = '0';
            setTimeout(function () {
                if (renderGeneration !== clearGeneration) {
                    // A render started during the fade-out: keep its
                    // content, just restore the container's opacity.
                    container.style.opacity = '';
                    container.style.transition = '';
                    return;
                }
                container.innerHTML = '';
                container.style.opacity = '';
                container.style.transition = '';
                kenBurnsFrameEl = null;
                setBackgroundContainerWithBackdrop(false);
            }, FADE_MS);
        }
        ArtworkPlusBackdropTransition.onNextIncomingReady(startFadeNow);
        setTimeout(startFadeNow, MAX_WAIT_FOR_INCOMING_MS);
    }

    function showStudioImage(url, kenBurnsEnabled, zoomMs, panMs, onShown, onFailure) {
        var myGeneration = renderGeneration;
        var frame = getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs);
        var existing = frame.querySelector('.displayingBackdropImage');
        if (existing && existing.getAttribute('data-url') === url) {
            if (onShown) { onShown(); } // same image again (Random order) - the timer still needs its anchor
            return;
        }

        Core.preloadImage(url).then(function () {
            if (myGeneration !== renderGeneration) { return; }
            var img = document.createElement('img');
            img.className = 'backdropImage displayingBackdropImage';
            img.setAttribute('data-url', url);
            // Session 116: the src assignment was missing in all four
            // library-view IIFEs (Genre/Studio/Tag/Favorites) - the image
            // was preloaded and the element appended, but stayed empty.
            // Found live: "background turns black, no picture".
            img.src = url;
            img.style.position = 'absolute';
            img.style.inset = '0';
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.opacity = '0';
            img.style.transition = 'opacity ' + FADE_MS + 'ms';
            frame.appendChild(img);
            // Session 116: force the initial opacity:0 to be computed
            // before switching to 1 - without this flush the transition
            // has no start value and the image pops in hard.
            void img.offsetWidth;
            // If a clear() fade-out is in flight on this container, the
            // render above has bumped renderGeneration, so the clear
            // keeps the content - but the container may already be at
            // opacity 0 (or transitioning there). Restore it here.
            var ownContainer = frame.closest('[class*="artworkplus-"][class*="backdrop"]');
            if (ownContainer && ownContainer.style.opacity === '0') {
                ownContainer.style.transition = '';
                ownContainer.style.opacity = '';
            }
            requestAnimationFrame(function () {
                // Session 86, fade concept: Studio now takes part in the
                // shared, project-wide signal (see its own comment at the
                // top of this file) - no special case needed, the signal
                // is already designed for any number of participants.
                ArtworkPlusBackdropTransition.notifyIncomingReady();
                img.style.opacity = '1';
            });
            setBackgroundContainerWithBackdrop(true);
            if (onShown) { onShown(); }

            // BUG FIXED (Session 86, fade-concept audit): the old image
            // used to ALWAYS be removed hard via clearOwn()/innerHTML=''
            // before this one even started loading - also on a direct
            // change from one studio to another, not only when actually
            // leaving. Now like Genre/Tag/Favorites: the old image fades
            // out itself and is removed only afterwards - a real crossfade
            // between two studios.
            var previous = existing;
            if (previous) {
                previous.style.opacity = '0';
                setTimeout(function () {
                    if (previous.parentNode) { previous.parentNode.removeChild(previous); }
                }, FADE_MS);
            }
        }).catch(function () {
            if (myGeneration !== renderGeneration) { return; }
            log('Studio image failed to load', url);
            if (onFailure) { onFailure(url); }
        });
    }

    function detectStudioListPage() {
        var hash = window.location.hash || '';
        var qIndex = hash.indexOf('?');
        if (qIndex === -1) { return null; }
        var path = hash.slice(0, qIndex);
        if (path.indexOf('list.html') === -1) { return null; }
        var params = new URLSearchParams(hash.slice(qIndex + 1));
        var studioId = params.get('studioId');
        if (!studioId) { return null; }
        return { studioId: studioId, parentId: params.get('parentId') || null };
    }

    var activeStudioId = null;
    var loadToken = 0;

    async function loadStudioBackdrop() {
        var detected = detectStudioListPage();
        if (!detected) {
            if (activeStudioId !== null) { activeStudioId = null; clearOwn(); }
            return;
        }
        if (detected.studioId === activeStudioId) { return; }

        var myToken = ++loadToken;
        activeStudioId = detected.studioId;

        var url = '/Backdrops/studio-settings?studioId=' + encodeURIComponent(detected.studioId);
        if (detected.parentId) { url += '&parentId=' + encodeURIComponent(detected.parentId); }

        var settings;
        try {
            settings = await fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); });
        } catch (e) {
            log('Could not load studio settings', e);
            return;
        }
        if (myToken !== loadToken) { return; }

        if (settings.Enabled && settings.SourceMode === 'Appearances') {
            await loadStudioAppearances(detected, myToken);
            return;
        }
        if (rotationEngine) { rotationEngine.clear(); rotationEngine = null; }

        if (!settings.Enabled || !settings.HasImage) {
            clearOwn();
            log('Studio Backdrops: not enabled or no image for this studio');
            return;
        }

        // BUG FIXED (Session 86, fade-concept audit): clearOwn() used to
        // run here UNCONDITIONALLY before every new image, also on a
        // direct studio-to-studio change - that removed the old image
        // immediately (innerHTML='') before the new one even started
        // loading, turning every change into a hard cut instead of a
        // crossfade. showStudioImage() itself now takes care of cleanly
        // fading out/removing the old image (see its own comment) - here
        // only the render generation is incremented, so a late preload
        // from the PREVIOUS studio (if the user clicks on very quickly)
        // is discarded correctly without hard-removing the DOM content.
        renderGeneration++;
        var imageUrl = '/Backdrops/studio-image?studioId=' + encodeURIComponent(detected.studioId);
        showStudioImage(imageUrl, settings.KenBurnsEnabled, settings.KenBurnsZoomMs, settings.KenBurnsPanMs);
        log('Studio Backdrops shown | studioId:', detected.studioId);
    }

    // Session 116: Source=Appearances - the backdrops of the titles the
    // studio appears in, rotated exactly like Genre (same pool shape,
    // same engine, same next-image-only preload).
    async function loadStudioAppearances(detected, myToken) {
        var poolParams = { studioId: detected.studioId };
        if (detected.parentId) { poolParams.parentId = detected.parentId; }
        var url = window.ApiClient.getUrl('Backdrops/studio-pool', poolParams);
        var pool;
        try {
            pool = await window.ApiClient.getJSON(url);
        } catch (e) {
            log('Could not load studio pool', e);
            return;
        }
        if (myToken !== loadToken) { return; }
        if (!pool.Enabled || !pool.Images || !pool.Images.length) {
            clearOwn();
            log('Studio Backdrops (Appearances): not enabled or no images for this studio');
            return;
        }
        var urls = pool.Images.map(function (entry) {
            return window.ApiClient.getScaledImageUrl(entry.SourceId, {
                type: 'Backdrop',
                tag: entry.Tag,
                maxWidth: window.innerWidth,
                index: entry.Index
            });
        });
        var preloadNext = function () {
            var next = rotationEngine && rotationEngine.peekNext ? rotationEngine.peekNext() : null;
            if (!next) { return; }
            Core.preloadImage(next, { priority: 'low' }).catch(function () { /* not a verdict */ });
        };
        var scheduleIdle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1500); };
        var orderMode = (pool.SortMode === 'Shuffle' || pool.SortMode === 'Random') ? pool.SortMode : 'Sequential';
        var effectiveCycleMs = Math.max(pool.CycleTimeMs, Math.ceil(FADE_MS * 1.5));

        if (rotationEngine) { rotationEngine.clear(); }
        renderGeneration++;
        rotationEngine = Core.createBackdropRotationEngine();
        preloadNextHook = function () { scheduleIdle(preloadNext); };
        var engine = rotationEngine;
        engine.start(urls, orderMode, effectiveCycleMs, function (imgUrl) {
            showStudioImage(imgUrl, pool.KenBurnsEnabled, pool.KenBurnsZoomMs, pool.KenBurnsPanMs, function () {
                engine.imageShown();
                if (typeof preloadNextHook === 'function') { preloadNextHook(); }
            }, function (failedUrl) {
                engine.removeFailedImage(failedUrl);
                engine.advance();
            });
        });
        log('Studio Backdrops shown (Appearances) | studioId:', detected.studioId, '| images:', urls.length, '| sort:', pool.SortMode);
    }

    var tracker = Core.createTimerTracker();
    function schedule() {
        tracker.clearTimers();
        Core.scheduleNavigationBurst(function () { loadStudioBackdrop(); }, tracker.track);
    }

    document.addEventListener('viewshow', schedule);
    Core.watchForNavigation(schedule);
    setTimeout(schedule, 1200);
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
    var DEBUG = true; // gated at runtime by localStorage.ArtworkPlusDebug (Core.makeLogger, Session 114)
    function log() {
        if (!DEBUG) { return; }
        console.log.apply(console, ['[ArtworkPlus TagBackdrops]'].concat(Array.prototype.slice.call(arguments)));
    }

    var FADE_MS = 800;

    var backdropContainerEl = null;
    function getBackdropContainer() {
        if (backdropContainerEl && document.body.contains(backdropContainerEl)) { return backdropContainerEl; }
        backdropContainerEl = document.querySelector('.artworkplus-tag-backdrop');
        if (!backdropContainerEl) {
            backdropContainerEl = document.createElement('div');
            backdropContainerEl.classList.add('artworkplus-tag-backdrop');
            backdropContainerEl.style.position = 'fixed';
            backdropContainerEl.style.top = '0';
            backdropContainerEl.style.left = '0';
            backdropContainerEl.style.right = '0';
            backdropContainerEl.style.bottom = '0';
            backdropContainerEl.style.zIndex = '-1';
            backdropContainerEl.style.contain = 'layout style size';
            document.body.insertBefore(backdropContainerEl, document.body.firstChild);
        }
        return backdropContainerEl;
    }

    var kenBurnsFrameEl = null;
    function getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs) {
        var container = getBackdropContainer();
        if (!kenBurnsEnabled) { return container; }
        if (kenBurnsFrameEl && container.contains(kenBurnsFrameEl)) { return kenBurnsFrameEl; }

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

        var ZOOM_START = 1, ZOOM_END = 1.12, PAN_PX = 30, EASING = 'ease-in-out';
        var zoomAnim = zoomEl.animate(
            [{ transform: 'scale(' + ZOOM_START + ')' }, { transform: 'scale(' + ZOOM_END + ')' }],
            { duration: zoomMs, easing: EASING, iterations: Infinity, direction: 'alternate' }
        );
        zoomAnim.currentTime = Math.random() * zoomMs;
        var panAnim = panEl.animate(
            [{ transform: 'translate(-' + PAN_PX + 'px, -' + PAN_PX + 'px)' }, { transform: 'translate(' + PAN_PX + 'px, ' + PAN_PX + 'px)' }],
            { duration: panMs, easing: EASING, iterations: Infinity, direction: 'alternate' }
        );
        panAnim.currentTime = Math.random() * panMs;

        kenBurnsFrameEl = panEl;
        return panEl;
    }

    function setBackgroundContainerWithBackdrop(hasBackdrop) {
        var bg = document.querySelector('.backgroundContainer');
        if (!bg) { return; }
        bg.classList.toggle('withBackdrop', hasBackdrop);
    }

    var renderGeneration = 0;
    var rotationEngine = null;
    var preloadNextHook = null; // Session 116: set by the loader, warms the next image on idle
    var MAX_WAIT_FOR_INCOMING_MS = 1200;

    function clearOwnRotation() {
        renderGeneration++;
        if (rotationEngine) { rotationEngine.clear(); }
        var container = document.querySelector('.artworkplus-tag-backdrop');
        if (!container || !container.firstChild || container.style.opacity === '0') {
            if (container) { container.innerHTML = ''; }
            kenBurnsFrameEl = null;
            setBackgroundContainerWithBackdrop(false);
            return;
        }
        var fired = false;
        // Session 116 (live recording): this deferred fade used to wipe
        // the container unconditionally. Leaving category page A and
        // entering page B of the SAME category within ~1.2 s let A's
        // fallback delete B's freshly appended first image ("removed
        // ... imgs=2" 17 ms after "img+"), leaving the page black until
        // the next rotation tick a full cycle later. Now the fade only
        // runs if no newer render has taken the container over since.
        var clearGeneration = renderGeneration;
        function startFadeNow() {
            if (fired) { return; }
            fired = true;
            if (renderGeneration !== clearGeneration) { return; } // a newer render owns the container
            container.style.transition = 'opacity ' + FADE_MS + 'ms ease';
            container.style.opacity = '0';
            setTimeout(function () {
                if (renderGeneration !== clearGeneration) {
                    // A render started during the fade-out: keep its
                    // content, just restore the container's opacity.
                    container.style.opacity = '';
                    container.style.transition = '';
                    return;
                }
                container.innerHTML = '';
                container.style.opacity = '';
                container.style.transition = '';
                kenBurnsFrameEl = null;
                setBackgroundContainerWithBackdrop(false);
            }, FADE_MS);
        }
        ArtworkPlusBackdropTransition.onNextIncomingReady(startFadeNow);
        setTimeout(startFadeNow, MAX_WAIT_FOR_INCOMING_MS);
    }

    function setBackdropImage(url, kenBurnsEnabled, zoomMs, panMs, onFailure) {
        var myGeneration = renderGeneration;
        var frame = getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs);
        var existing = frame.querySelector('.displayingBackdropImage');
        if (existing && existing.getAttribute('data-url') === url) {
            rotationEngine.imageShown();
            return;
        }

        Core.preloadImage(url).then(function () {
            if (myGeneration !== renderGeneration) { return; }
            var img = document.createElement('img');
            img.className = 'backdropImage displayingBackdropImage';
            img.setAttribute('data-url', url);
            // Session 116: the src assignment was missing in all four
            // library-view IIFEs (Genre/Studio/Tag/Favorites) - the image
            // was preloaded and the element appended, but stayed empty.
            // Found live: "background turns black, no picture".
            img.src = url;
            img.style.position = 'absolute';
            img.style.inset = '0';
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.opacity = '0';
            img.style.transition = 'opacity ' + FADE_MS + 'ms';
            frame.appendChild(img);
            // Session 116: force the initial opacity:0 to be computed
            // before switching to 1 - without this flush the transition
            // has no start value and the image pops in hard.
            void img.offsetWidth;
            // If a clear() fade-out is in flight on this container, the
            // render above has bumped renderGeneration, so the clear
            // keeps the content - but the container may already be at
            // opacity 0 (or transitioning there). Restore it here.
            var ownContainer = frame.closest('[class*="artworkplus-"][class*="backdrop"]');
            if (ownContainer && ownContainer.style.opacity === '0') {
                ownContainer.style.transition = '';
                ownContainer.style.opacity = '';
            }
            requestAnimationFrame(function () {
                // Session 86, Fade-Konzept: Tag nimmt jetzt am
                // gemeinsamen, projektweiten Signal teil.
                ArtworkPlusBackdropTransition.notifyIncomingReady();
                img.style.opacity = '1';
            });
            setBackgroundContainerWithBackdrop(true);
            rotationEngine.imageShown();
            if (typeof preloadNextHook === 'function') { preloadNextHook(); }

            if (existing) {
                existing.style.opacity = '0';
                setTimeout(function () {
                    if (existing.parentNode) { existing.parentNode.removeChild(existing); }
                }, FADE_MS);
            }
        }).catch(function () {
            if (myGeneration !== renderGeneration) { return; }
            if (onFailure) { onFailure(url); }
        });
    }

    function detectTagListPage() {
        var hash = window.location.hash || '';
        var qIndex = hash.indexOf('?');
        if (qIndex === -1) { return null; }
        var path = hash.slice(0, qIndex);
        if (path.indexOf('list.html') === -1) { return null; }
        var params = new URLSearchParams(hash.slice(qIndex + 1));
        var tag = params.get('tag');
        if (!tag) { return null; }
        return { tag: tag };
    }

    var activeTag = null;
    var loadToken = 0;

    async function loadTagBackdrops() {
        var detected = detectTagListPage();
        if (!detected) {
            if (activeTag !== null) { activeTag = null; clearOwnRotation(); }
            return;
        }
        if (detected.tag === activeTag) { return; }

        var myToken = ++loadToken;
        activeTag = detected.tag;

        var url = window.ApiClient.getUrl('Backdrops/tag-pool', { tag: detected.tag });
        var settings;
        try {
            settings = await window.ApiClient.getJSON(url);
        } catch (e) {
            log('Could not load tag pool', e);
            return;
        }
        if (myToken !== loadToken) { return; }

        if (!settings.Enabled || !settings.Images || !settings.Images.length) {
            clearOwnRotation();
            log('Tag Backdrops: not enabled or no images for this tag');
            return;
        }

        var urls = settings.Images.map(function (entry) {
            return window.ApiClient.getScaledImageUrl(entry.SourceId, {
                type: 'Backdrop',
                tag: entry.Tag,
                maxWidth: window.innerWidth,
                index: entry.Index
            });
        });

        // Session 116: no bulk preload of the whole pool any more (99
        // requests + decoding per page view, measured live as 1.4 s long
        // tasks while the grid's own tiles were still loading). Backdrops
        // come last on every page: only the next image is warmed, and
        // only when the browser is idle.
        var preloadNext = function () {
            var next = rotationEngine && rotationEngine.peekNext ? rotationEngine.peekNext() : null;
            if (!next) { return; }
            Core.preloadImage(next, { priority: 'low' }).catch(function () { /* not a verdict, see setBackdropImage's own real attempt */ });
        };
        var scheduleIdle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1500); };

        var orderMode = (settings.SortMode === 'Shuffle' || settings.SortMode === 'Random') ? settings.SortMode : 'Sequential';
        var effectiveCycleMs = Math.max(settings.CycleTimeMs, Math.ceil(FADE_MS * 1.5));

        if (rotationEngine) { rotationEngine.clear(); }
        // Session 116: a new render takes ownership of the container -
        // any clear() fade still pending from the page we just left
        // compares against this and leaves our content alone.
        renderGeneration++;
        rotationEngine = Core.createBackdropRotationEngine();
        preloadNextHook = function () { scheduleIdle(preloadNext); };
        rotationEngine.start(urls, orderMode, effectiveCycleMs, function (imgUrl) {
            setBackdropImage(imgUrl, settings.KenBurnsEnabled, settings.KenBurnsZoomMs, settings.KenBurnsPanMs, function (failedUrl) {
                rotationEngine.removeFailedImage(failedUrl);
                rotationEngine.advance();
            });
        });

        log('Tag Backdrops shown | tag:', detected.tag, '| images:', urls.length, '| sort:', settings.SortMode);
    }

    var tagTracker = Core.createTimerTracker();
    function scheduleTag() {
        tagTracker.clearTimers();
        Core.scheduleNavigationBurst(function () { loadTagBackdrops(); }, tagTracker.track);
    }

    document.addEventListener('viewshow', scheduleTag);
    Core.watchForNavigation(scheduleTag);
    setTimeout(scheduleTag, 1200);
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
    var DEBUG = true; // gated at runtime by localStorage.ArtworkPlusDebug (Core.makeLogger, Session 114)
    function log() {
        if (!DEBUG) { return; }
        console.log.apply(console, ['[ArtworkPlus FavoritesBackdrops]'].concat(Array.prototype.slice.call(arguments)));
    }

    var FADE_MS = 800;
    var KNOWN_TYPES = ['Movie', 'Series', 'Episode', 'Video', 'BoxSet', 'Playlist', 'MusicArtist', 'MusicAlbum', 'Audio', 'Book'];

    var backdropContainerEl = null;
    function getBackdropContainer() {
        if (backdropContainerEl && document.body.contains(backdropContainerEl)) { return backdropContainerEl; }
        backdropContainerEl = document.querySelector('.artworkplus-favorites-backdrop');
        if (!backdropContainerEl) {
            backdropContainerEl = document.createElement('div');
            backdropContainerEl.classList.add('artworkplus-favorites-backdrop');
            backdropContainerEl.style.position = 'fixed';
            backdropContainerEl.style.top = '0';
            backdropContainerEl.style.left = '0';
            backdropContainerEl.style.right = '0';
            backdropContainerEl.style.bottom = '0';
            backdropContainerEl.style.zIndex = '-1';
            backdropContainerEl.style.contain = 'layout style size';
            document.body.insertBefore(backdropContainerEl, document.body.firstChild);
        }
        return backdropContainerEl;
    }

    var kenBurnsFrameEl = null;
    function getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs) {
        var container = getBackdropContainer();
        if (!kenBurnsEnabled) { return container; }
        if (kenBurnsFrameEl && container.contains(kenBurnsFrameEl)) { return kenBurnsFrameEl; }

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

        var ZOOM_START = 1, ZOOM_END = 1.12, PAN_PX = 30, EASING = 'ease-in-out';
        var zoomAnim = zoomEl.animate(
            [{ transform: 'scale(' + ZOOM_START + ')' }, { transform: 'scale(' + ZOOM_END + ')' }],
            { duration: zoomMs, easing: EASING, iterations: Infinity, direction: 'alternate' }
        );
        zoomAnim.currentTime = Math.random() * zoomMs;
        var panAnim = panEl.animate(
            [{ transform: 'translate(-' + PAN_PX + 'px, -' + PAN_PX + 'px)' }, { transform: 'translate(' + PAN_PX + 'px, ' + PAN_PX + 'px)' }],
            { duration: panMs, easing: EASING, iterations: Infinity, direction: 'alternate' }
        );
        panAnim.currentTime = Math.random() * panMs;

        kenBurnsFrameEl = panEl;
        return panEl;
    }

    function setBackgroundContainerWithBackdrop(hasBackdrop) {
        var bg = document.querySelector('.backgroundContainer');
        if (!bg) { return; }
        bg.classList.toggle('withBackdrop', hasBackdrop);
    }

    var renderGeneration = 0;
    var rotationEngine = null;
    var preloadNextHook = null; // Session 116: set by the loader, warms the next image on idle
    var MAX_WAIT_FOR_INCOMING_MS = 1200;

    function clearOwnRotation() {
        renderGeneration++;
        if (rotationEngine) { rotationEngine.clear(); }
        var container = document.querySelector('.artworkplus-favorites-backdrop');
        if (!container || !container.firstChild || container.style.opacity === '0') {
            if (container) { container.innerHTML = ''; }
            kenBurnsFrameEl = null;
            setBackgroundContainerWithBackdrop(false);
            return;
        }
        var fired = false;
        // Session 116 (live recording): this deferred fade used to wipe
        // the container unconditionally. Leaving category page A and
        // entering page B of the SAME category within ~1.2 s let A's
        // fallback delete B's freshly appended first image ("removed
        // ... imgs=2" 17 ms after "img+"), leaving the page black until
        // the next rotation tick a full cycle later. Now the fade only
        // runs if no newer render has taken the container over since.
        var clearGeneration = renderGeneration;
        function startFadeNow() {
            if (fired) { return; }
            fired = true;
            if (renderGeneration !== clearGeneration) { return; } // a newer render owns the container
            container.style.transition = 'opacity ' + FADE_MS + 'ms ease';
            container.style.opacity = '0';
            setTimeout(function () {
                if (renderGeneration !== clearGeneration) {
                    // A render started during the fade-out: keep its
                    // content, just restore the container's opacity.
                    container.style.opacity = '';
                    container.style.transition = '';
                    return;
                }
                container.innerHTML = '';
                container.style.opacity = '';
                container.style.transition = '';
                kenBurnsFrameEl = null;
                setBackgroundContainerWithBackdrop(false);
            }, FADE_MS);
        }
        ArtworkPlusBackdropTransition.onNextIncomingReady(startFadeNow);
        setTimeout(startFadeNow, MAX_WAIT_FOR_INCOMING_MS);
    }

    function setBackdropImage(url, kenBurnsEnabled, zoomMs, panMs, onFailure) {
        var myGeneration = renderGeneration;
        var frame = getKenBurnsFrame(kenBurnsEnabled, zoomMs, panMs);
        var existing = frame.querySelector('.displayingBackdropImage');
        if (existing && existing.getAttribute('data-url') === url) {
            rotationEngine.imageShown();
            return;
        }

        Core.preloadImage(url).then(function () {
            if (myGeneration !== renderGeneration) { return; }
            var img = document.createElement('img');
            img.className = 'backdropImage displayingBackdropImage';
            img.setAttribute('data-url', url);
            // Session 116: the src assignment was missing in all four
            // library-view IIFEs (Genre/Studio/Tag/Favorites) - the image
            // was preloaded and the element appended, but stayed empty.
            // Found live: "background turns black, no picture".
            img.src = url;
            img.style.position = 'absolute';
            img.style.inset = '0';
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.opacity = '0';
            img.style.transition = 'opacity ' + FADE_MS + 'ms';
            frame.appendChild(img);
            // Session 116: force the initial opacity:0 to be computed
            // before switching to 1 - without this flush the transition
            // has no start value and the image pops in hard.
            void img.offsetWidth;
            // If a clear() fade-out is in flight on this container, the
            // render above has bumped renderGeneration, so the clear
            // keeps the content - but the container may already be at
            // opacity 0 (or transitioning there). Restore it here.
            var ownContainer = frame.closest('[class*="artworkplus-"][class*="backdrop"]');
            if (ownContainer && ownContainer.style.opacity === '0') {
                ownContainer.style.transition = '';
                ownContainer.style.opacity = '';
            }
            requestAnimationFrame(function () {
                // Session 86, Fade-Konzept: Favorites nimmt jetzt am
                // gemeinsamen, projektweiten Signal teil.
                ArtworkPlusBackdropTransition.notifyIncomingReady();
                img.style.opacity = '1';
            });
            setBackgroundContainerWithBackdrop(true);
            rotationEngine.imageShown();
            if (typeof preloadNextHook === 'function') { preloadNextHook(); }

            if (existing) {
                existing.style.opacity = '0';
                setTimeout(function () {
                    if (existing.parentNode) { existing.parentNode.removeChild(existing); }
                }, FADE_MS);
            }
        }).catch(function () {
            if (myGeneration !== renderGeneration) { return; }
            if (onFailure) { onFailure(url); }
        });
    }

    // Detects one of the eleven Favorites "See All" lists - list.html
    // with IsFavorite=true AND a recognized type, INCLUDING Person now
    // (handled via a different endpoint/URL-building branch below, but
    // detected the same way here - see loadFavoritesBackdrops' own
    // Person branch).
    function detectFavoritesListPage() {
        var hash = window.location.hash || '';
        var qIndex = hash.indexOf('?');
        if (qIndex === -1) { return null; }
        var path = hash.slice(0, qIndex);
        if (path.indexOf('list.html') === -1) { return null; }
        var params = new URLSearchParams(hash.slice(qIndex + 1));
        if (params.get('IsFavorite') !== 'true') { return null; }
        var type = params.get('type');
        if (!type || (KNOWN_TYPES.indexOf(type) === -1 && type !== 'Person')) { return null; }
        return { type: type };
    }

    var activeType = null;
    var loadToken = 0;

    async function loadFavoritesBackdrops() {
        var detected = detectFavoritesListPage();
        if (!detected) {
            if (activeType !== null) { activeType = null; clearOwnRotation(); }
            return;
        }
        if (detected.type === activeType) { return; }

        var myToken = ++loadToken;
        activeType = detected.type;

        // Person has its own endpoint and two mutually exclusive URL
        // shapes (WallpaperUrls are already-complete external URLs;
        // Images are Jellyfin's own item images, built the same way as
        // every other section) - see FavoritesPeoplePoolResult's own
        // doc comment server-side.
        var isPerson = detected.type === 'Person';
        // Session 116: the two Favorites endpoints are [Authorize] now -
        // IsFavorite is per-user data and the server needs to know WHOSE
        // favorites (it threw "no such column: IsFavorite" without a user).
        // ApiClient.getJSON sends the session's token like every native
        // page call does; nothing token-related is handled here.
        var url = isPerson
            ? window.ApiClient.getUrl('Backdrops/favorites-people-pool')
            : window.ApiClient.getUrl('Backdrops/favorites-pool', { type: detected.type });
        var settings;
        try {
            settings = await window.ApiClient.getJSON(url);
        } catch (e) {
            log('Could not load favorites pool', e);
            return;
        }
        if (myToken !== loadToken) { return; }

        var urls;
        if (isPerson && (settings.SourceMode === 'WallpapersCom' || settings.SourceMode === 'Folder')) {
            // Wallpapers.com: hotlinked URLs; Folder (Session 116): the
            // /PeopleBackdrops/{id}/folder-image URLs - both come ready-made.
            urls = settings.WallpaperUrls || [];
        } else {
            var entries = settings.Images || [];
            urls = entries.map(function (entry) {
                return window.ApiClient.getScaledImageUrl(entry.SourceId, {
                    type: 'Backdrop',
                    tag: entry.Tag,
                    maxWidth: window.innerWidth,
                    index: entry.Index
                });
            });
        }

        if (!settings.Enabled || !urls.length) {
            clearOwnRotation();
            log('Favorites Backdrops: not enabled or no images for this section');
            return;
        }

        // Session 116: no bulk preload of the whole pool any more (99
        // requests + decoding per page view, measured live as 1.4 s long
        // tasks while the grid's own tiles were still loading). Backdrops
        // come last on every page: only the next image is warmed, and
        // only when the browser is idle.
        var preloadNext = function () {
            var next = rotationEngine && rotationEngine.peekNext ? rotationEngine.peekNext() : null;
            if (!next) { return; }
            Core.preloadImage(next, { priority: 'low' }).catch(function () { /* not a verdict, see setBackdropImage's own real attempt */ });
        };
        var scheduleIdle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1500); };

        var orderMode = (settings.SortMode === 'Shuffle' || settings.SortMode === 'Random') ? settings.SortMode : 'Sequential';
        var effectiveCycleMs = Math.max(settings.CycleTimeMs, Math.ceil(FADE_MS * 1.5));

        if (rotationEngine) { rotationEngine.clear(); }
        // Session 116: a new render takes ownership of the container -
        // any clear() fade still pending from the page we just left
        // compares against this and leaves our content alone.
        renderGeneration++;
        rotationEngine = Core.createBackdropRotationEngine();
        preloadNextHook = function () { scheduleIdle(preloadNext); };
        rotationEngine.start(urls, orderMode, effectiveCycleMs, function (imgUrl) {
            setBackdropImage(imgUrl, settings.KenBurnsEnabled, settings.KenBurnsZoomMs, settings.KenBurnsPanMs, function (failedUrl) {
                rotationEngine.removeFailedImage(failedUrl);
                rotationEngine.advance();
            });
        });

        log('Favorites Backdrops shown | type:', detected.type, '| images:', urls.length);
    }

    var favTracker = Core.createTimerTracker();
    function scheduleFav() {
        favTracker.clearTimers();
        Core.scheduleNavigationBurst(function () { loadFavoritesBackdrops(); }, favTracker.track);
    }

    document.addEventListener('viewshow', scheduleFav);
    Core.watchForNavigation(scheduleFav);
    setTimeout(scheduleFav, 1200);
})();
