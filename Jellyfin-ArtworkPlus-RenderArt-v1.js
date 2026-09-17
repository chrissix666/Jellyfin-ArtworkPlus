/*!
 * ArtworkPlus - RenderArt (CharacterArt + RedCarpet, merged)
 * ------------------------------------------------------
 * FILE-LEVEL CONSOLIDATION ONLY - explicit user requirement: nothing about
 * either feature's own behavior, its own admin-UI section, or its own
 * settings changes because of this merge. CharacterArt and RedCarpet were
 * never coordinating with each other in the first place (unlike the three
 * former poster scripts, which all competed for the same DOM element and
 * needed the PostersPlus consolidation for exactly that reason) - they
 * target entirely different page types (CharacterArt: movie/show detail
 * pages; RedCarpet: person detail pages + filmography lists) and never
 * touch the same element. There is therefore no shared state, no shared
 * controller, and no shared decision-making introduced here - this is a
 * pure "two files become one file" change, kept as TWO SEPARATE,
 * independently-scoped IIFEs below (exactly the same pattern already used
 * for ExtraPoster's own detail-page/library-view split, and for People
 * Backdrops' own merge into Backdrops-v1.js) so neither section's own
 * local variables (several are same-named across the two, e.g. `DEBUG`/
 * `log`/`preloadImage`/`waitFor`) can collide or shadow one another. Both
 * still run completely independently side by side, exactly as before the
 * merge.
 *
 * Requires Jellyfin-ArtworkPlus-Core-v1.js to be loaded first (hard
 * dependency, unchanged for both sections).
 */

/*!
 * Characterart - positioning script
 * ------------------------------------------------------
 * A completely standalone file, separate from script.js/library.js
 * (Extraposter) - its own endpoint (/Characterart/...), its own placement
 * on the page instead of in the poster slot (curriculum section E).
 *
 * DOM facts verified against the jellyfin-web 10.10.7 source (curriculum
 * section E, positioning research):
 *   - .itemBackdrop { background-attachment: fixed; height: 40vh; }
 *   - .detailLogo { position: absolute; top: 10vh; right: 25vw; width: 25vw;
 *     height: 16vh; } -> the left edge sits at 50vw (a pure CSS coordinate
 *     value, independent of whether a logo image is actually loaded)
 *   - .detailPagePrimaryContainer.detailRibbon { margin-top: -7.2em; } ->
 *     this container's top edge is the vertical anchor point for the top
 *     positions (Characterart "stands" on this line)
 *
 * NO ribbon-line-derived height cap (removed entirely, not just set
 * aside): an earlier version of this file also read .skinHeader's own
 * bottom edge as an automatic "growth limit" for the "top" positions,
 * applied on top of whatever the admin configured. The user explicitly
 * asked to discard that whole concept - the ScaleMode/Height/Width/Max*
 * fields (see Core.computeBoxSize()) are meant to be the ONLY sizing
 * constraints in effect for this feature.
 *
 * INTERPRETATION NOTE (can't be taken 1:1 from the chat, since only
 * "mirrored" was deliberately said there, see curriculum E): for TopRight,
 * the same gap width as TopLeft (poster edge to logo edge) is used, but
 * applied starting from the RIGHT logo edge going right - there's no
 * second poster reference on the right side. If this doesn't look right
 * visually, this is the spot that would need adjusting during the first
 * real test.
 */
(function () {
    'use strict';

    // Duplicate-load guard: see Core.claimSingleton()'s own doc comment.
    // CharacterArt and RedCarpet are guarded independently (two separate
    // names) since they are two genuinely independent sections within
    // this one file, never sharing state with each other.
    if (!window.ArtworkPlusCore.claimSingleton('Characterart')) { return; }

    var DEBUG = true;
    var PRELOAD_TIMEOUT_MS = 8000;
    // Same reasoning as Posters-v1.js's ExtraModule's own
    // MAX_CONSECUTIVE_FAILURES - found in the same formal audit pass,
    // the same tight-retry-forever risk applies here identically.
    var MAX_CONSECUTIVE_FAILURES = 6;
    var BOTTOM_MARGIN_VW = 0.8; // inset from the left/right screen edge for the bottom positions, as a percentage of viewport width (≈15px at 1920px) - matches Jellyfin's own vw/vh-based sizing (.detailLogo etc.) instead of a fixed pixel value, so it looks proportionally the same across different screen resolutions

    var log = window.ArtworkPlusCore.makeLogger('[Characterart]', DEBUG);

    // Shared engine functions - see Jellyfin-ArtworkPlus-Core-v1.js. This
    // script is unusable without it (hard dependency, not optional),
    // loaded first by FileTransformationRegistrar.cs for exactly that
    // reason.
    var Core = window.ArtworkPlusCore;

    // See Core.ensureBodyIsPositioned()'s own doc comment for the full
    // reasoning - needed for the "top" positions specifically, which use
    // position:absolute (they're anchored to other page content - the
    // logo/poster/ribbon - and are meant to scroll away WITH the page,
    // same as the vanilla clearlogo). Without this, <body> has no
    // explicit CSS "position" set, so it isn't a valid containing block
    // for position:absolute descendants, and they'd effectively behave
    // like position:fixed instead - completely independent of whether
    // the scroll-offset math itself is correct. The "bottom" positions
    // (RedCarpet, and this file's own BottomLeft/BottomRight) are
    // DELIBERATELY genuine position:fixed instead - the user explicitly
    // confirmed (after a sketch comparing the two) that they should stay
    // glued to the window at all times, same as .skinHeader/the backdrop
    // - so this fix doesn't apply to them at all, only to "top".
    Core.ensureBodyIsPositioned();

    var vwToPx = Core.vwToPx;
    var getItemIdFromHash = Core.getItemIdFromHash;
    var isDetailsPage = Core.isDetailsPage;

    // Real, user-reported bug fix: the Fullscreen API
    // (document.fullscreenElement, with vendor prefixes for broader
    // browser coverage) only ever reflects fullscreen state triggered by
    // an explicit element.requestFullscreen() call - it has NO
    // visibility at all into the browser's own native F11 fullscreen
    // toggle, which is a purely OS/browser-chrome-level state. Confirmed
    // directly by the user testing both. Fixed the same way another of
    // the user's own existing userscripts (VideoOSD ClearLogoArt)
    // already handles this exact, otherwise-undetectable ambiguity:
    // additionally treating the window filling the ENTIRE screen height
    // (no browser chrome/tabs/toolbar consuming any of it) as a second,
    // independent signal for "effectively fullscreen" - a pragmatic
    // heuristic, not a perfect proof, but the standard approach for this
    // specific gap.
    function isEffectivelyFullscreen() {
        var isRealFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
        var isBrowserChromeFullscreen = !isRealFullscreen && window.innerHeight === screen.height;
        return isRealFullscreen || isBrowserChromeFullscreen;
    }

    var runToken = 0;
    var tracker = Core.createTimerTracker();
    var clearTimers = tracker.clearTimers;
    var track = tracker.track;
    // Holds the currently active window resize listener (for "top"
    // positions only - see its registration site in start() below) plus
    // its debounce timer handle, so a NEW start() call (new navigation)
    // can tear down the PREVIOUS run's listener before it might register
    // its own - without this, resize listeners from old, already-
    // abandoned runs would pile up indefinitely across navigations, each
    // one still firing and doing pointless work against a container that
    // isn't even on screen anymore.
    var activeResizeListener = null;
    var activeResizeDebounceHandle = null;
    var activeFullscreenListener = null;
    // Separate tracker JUST for the burst timers in schedule() below -
    // NOT the same one start() itself clears. Needed because start()
    // calls clearTimers() (the ORIGINAL tracker) right at its own
    // beginning, to stop old internal work (a still-running rotation,
    // a pending waitFor() poll) from a previous run - if the burst
    // timers shared that same tracker, the very FIRST burst attempt
    // calling start() would immediately wipe out its own still-pending
    // LATER burst attempts before they ever got a chance to fire,
    // silently defeating the whole point of the burst.
    var navTracker = Core.createTimerTracker();
    // Set false on every new detected navigation, true as soon as a
    // start() attempt gets a definitive server response for the CURRENT
    // navigation (regardless of applicable/not) - lets later staggered
    // burst attempts (see schedule() below) cheaply no-op instead of
    // redoing a fetch/DOM rebuild once an earlier attempt already
    // resolved things for this same navigation.
    var contentReady = false;
    // Tracks the actual SHOULD-BE-VISIBLE state, separate from
    // contentReady above (true even when the answer was "nothing to
    // show here") - specifically for Core.startPresenceHeartbeat()
    // below: while this is false, an absent .characterart-container is
    // completely normal (still loading, or genuinely nothing to show)
    // and must NOT be treated as something needing recovery. Only set
    // true once start() has actually successfully built and populated
    // a real, currently-correct container.
    var shouldHaveContainer = false;

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

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

    // resolveWith:'image' - this script needs img.naturalWidth/Height for
    // its aspect-ratio math (see Core's preloadImage doc comment).
    function preloadImage(url) {
        return Core.preloadImage(url, { resolveWith: 'image', timeoutMs: PRELOAD_TIMEOUT_MS, track: track });
    }

    // computeBoxSize/horizontalAlignToObjectPosition now live in Core
    // (Jellyfin-ArtworkPlus-Core-v1.js) - shared with RedCarpet, which
    // needs the exact same ScaleMode-based sizing logic, to avoid
    // duplicating it in both scripts. See Core's own doc comments on
    // these two functions for the full reasoning.
    var computeBoxSize = Core.computeBoxSize;
    var horizontalAlignToObjectPosition = Core.horizontalAlignToObjectPosition;

    // -----------------------------------------------------------------
    // Positioning
    // -----------------------------------------------------------------

    // Root cause of a real "manchmal erscheint es nicht, erst nach
    // Reload" bug (up to three cached itemDetailPage DOM trees alive
    // simultaneously, a document-wide query can grab a stale, hidden
    // one) - see Core.findVisibleDetailPage()'s own doc comment for the
    // full reasoning; now shared there since ExtraPoster/AnimatedPoster
    // hit the exact same issue with their own anchor lookups.

    function findAnchors() {
        // No visible detail page found at all (shouldn't normally
        // happen while this script is even running) - fall back to a
        // document-wide search rather than returning nothing, since
        // that was at least the previous (imperfect but non-zero)
        // behavior.
        var root = Core.findVisibleDetailPage() || document;
        return {
            logo: root.querySelector('.detailLogo'),
            poster: root.querySelector('.detailImageContainer .card'),
            ribbon: root.querySelector('.detailPagePrimaryContainer.detailRibbon')
        };
    }

    /// Computes the position for the "top" variants (TopLeft/TopRight).
    /// Returns VIEWPORT-relative coordinates (straight from
    /// getBoundingClientRect()) - applyLayout() converts centerX/bottomY
    /// to document-relative coordinates by adding the current scroll
    /// offset, since the container itself is now position:absolute, not
    /// position:fixed (see the note on container.style.position in
    /// applyLayout for why this changed).
    /// No maxHeight/growth-limit here anymore - an earlier version of
    /// this function also computed a ribbon-line-derived height cap
    /// (curriculum E's original "growth limit"), applied automatically
    /// on top of whatever the admin configured. The user explicitly
    /// asked to discard that whole concept, not just set it aside in the
    /// admin UI text - the ScaleMode/Max* fields the admin actually
    /// configures (see Core.computeBoxSize()) are meant to be the ONLY
    /// constraints in effect.
    ///
    /// frozenGapWidthFraction: on the very first call for a given
    /// rotation, pass null - gapWidth is measured live from the real
    /// anchor positions (posterRect/logoRect), exactly as it always was.
    /// On every call AFTER that (resize/fullscreenchange
    /// recalculations), pass in the fraction captured from that first
    /// call instead - see this function's return value and its call
    /// site in applyLayout() for how that's threaded through.
    ///
    /// WHY: user-reported bug (with real before/after screenshots) -
    /// toggling into fullscreen visibly shrank the gap between
    /// CharacterArt and the native clearlogo, even though every
    /// individual measurement going into this formula (logo position:
    /// pure vw, poster width: window.innerWidth * 0.25, both source-
    /// confirmed) LOOKS purely proportional on its own. Rather than
    /// fully chase down which specific piece of Jellyfin's own layout
    /// (poster's own document-flow position depends on page padding
    /// that's a mix of %/env() values per librarybrowser.scss, and
    /// possibly a max-width container cap not yet confirmed one way or
    /// the other) breaks that proportionality in practice, this takes a
    /// more robust approach: capture whatever the live gapWidth ACTUALLY
    /// is, expressed as a fraction of THAT MOMENT's viewport width, once
    /// - at the first calculation, in whatever mode the page happened to
    /// load in - and reapply that same fraction against the CURRENT
    /// viewport width on every later recalculation. This guarantees the
    /// visual relationship the user configured and confirmed looks right
    /// stays exactly proportional at any later viewport size, without
    /// needing to fully diagnose which underlying CSS value was the
    /// actual source of the non-proportionality.
    function computeTopPosition(position, anchors, offsetPx, frozenGapWidthFraction) {
        if (!anchors.logo || !anchors.poster || !anchors.ribbon) { return null; }

        var logoRect = anchors.logo.getBoundingClientRect();
        var posterRect = anchors.poster.getBoundingClientRect();
        var ribbonRect = anchors.ribbon.getBoundingClientRect();

        // Real, source-confirmed cause of a serious bug (getBoundingClientRect
        // debug output showed logoRect collapsing to all-zero at certain
        // widths): .detailLogo itself gets `display: none` below a
        // 68.75em (1100px) viewport width media query
        // (librarybrowser.scss, confirmed earlier in this same project).
        // A display:none element's getBoundingClientRect() is always all
        // zeros - not "small", not "off to the side", genuinely (0,0,0,0)
        // - and the old code had no guard against that, so centerX
        // collapsed to near 0% of the viewport instead of anywhere
        // sensible. Same risk applies to poster/ribbon if they were ever
        // hidden too, so all three get the same check. Returning null
        // here makes applyLayout() report failure, which leaves
        // whatever position was already applied from the last genuinely
        // successful calculation in place, rather than jumping to a
        // broken one.
        if (logoRect.width === 0 || posterRect.width === 0 || ribbonRect.width === 0) {
            return null;
        }

        var gapWidth = (frozenGapWidthFraction === null || frozenGapWidthFraction === undefined)
            ? logoRect.left - posterRect.right // first call: measure live, exactly as before
            : frozenGapWidthFraction * window.innerWidth; // later calls: reapply the frozen proportion against the CURRENT viewport width
        var centerX;
        if (position === 'TopLeft') {
            centerX = posterRect.right + gapWidth / 2;
        } else {
            // TopRight - see the interpretation note at the top of the file.
            centerX = logoRect.right + gapWidth / 2;
        }
        centerX += offsetPx;

        return {
            centerX: centerX,
            bottomY: ribbonRect.top, // Characterart "stands" on this line
            // Only meaningful on the FIRST call (frozenGapWidthFraction
            // was null) - the caller stores this to pass back in on
            // every later recalculation. On later calls this just
            // echoes back the same frozen value unchanged.
            gapWidthFraction: (frozenGapWidthFraction === null || frozenGapWidthFraction === undefined)
                ? (logoRect.left - posterRect.right) / window.innerWidth
                : frozenGapWidthFraction
        };
    }

    /// The "bottom" variants: viewport-anchored (position:fixed), exactly
    /// like Jellyfin's own .skinHeader/backdrop - the user explicitly
    /// confirmed this after a sketch comparing the two: RedCarpet and
    /// this feature's "bottom" positions should stay "glued" to the
    /// window at all times, completely unlike the "top" positions (which
    /// mirror the vanilla clearlogo and DO scroll away with the page).
    /// An earlier version of this function computed a document-relative
    /// top offset (scrollY + innerHeight - elementHeight) for use with
    /// position:absolute - that's gone now: position:fixed is ALREADY
    /// viewport-relative by definition, so no scroll-offset math is
    /// needed here at all anymore.
    function computeBottomPosition(position, offsetPx) {
        return {
            side: position === 'BottomLeft' ? 'left' : 'right',
            sideOffsetPx: vwToPx(BOTTOM_MARGIN_VW) + (position === 'BottomLeft' ? offsetPx : -offsetPx)
        };
    }

    // -----------------------------------------------------------------
    // Building the element
    // -----------------------------------------------------------------

    function createContainer() {
        document.querySelectorAll('.characterart-container').forEach(function (el) { el.remove(); });
        var div = document.createElement('div');
        div.className = 'characterart-container';
        div.style.position = 'fixed'; // correct default for "bottom" as-is; applyLayout() switches to absolute for "top" specifically
        div.style.zIndex = '5';
        div.style.pointerEvents = 'none';
        document.body.appendChild(div);
        return div;
    }

    function createImageLayer(container, fadeMs, horizontalAlign) {
        var img = document.createElement('img');
        img.className = 'characterart-layer';
        img.style.position = 'absolute';
        img.style.inset = '0';
        img.style.width = '100%';
        // height:100% + object-fit:contain, NOT height:auto - fixes a
        // user-reported "jump": with height:auto, each image's OWN
        // natural aspect ratio determined the container's own height
        // (applyLayout() used to run fresh on every single image change,
        // computing height = width / naturalAspectRatio each time) - for
        // the "top" positions specifically, the container's bottom edge
        // is pinned to a fixed line (pos.bottomY), so a taller/shorter
        // image shifted the container's TOP edge up/down as its height
        // changed, visibly "jumping" whenever two images in the same
        // rotation happened to have different aspect ratios. Now the
        // container itself gets a fixed size ONCE (see the
        // layoutAppliedOnce flag in showNext()), and each image just
        // fits itself within that fixed box via object-fit:contain,
        // scaling to fit without stretching/distorting and without ever
        // changing the box's own size/position.
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        // object-position: the vertical half is ALWAYS bottom (see
        // horizontalAlignToObjectPosition()'s own doc comment for why -
        // both "top" and "bottom" position modes anchor the BOX's bottom
        // edge to a fixed line/the screen edge, so every image's own
        // bottom edge needs to stay flush with that regardless of its
        // individual aspect ratio). The HORIZONTAL half is now
        // configurable (HorizontalAlign: Left/Right/Center) - only ever
        // visible when an image's own aspect ratio doesn't exactly match
        // the box's (which is set once, from the FIRST loaded image in
        // the rotation), leaving leftover horizontal space to place the
        // image within.
        img.style.objectPosition = horizontalAlignToObjectPosition(horizontalAlign);
        img.style.opacity = '0';
        img.style.transition = 'opacity ' + fadeMs + 'ms ease';
        container.appendChild(img);
        return img;
    }

    // -----------------------------------------------------------------
    // Core
    // -----------------------------------------------------------------

    async function start() {
        clearTimers();
        var myToken = ++runToken;

        // Tear down the PREVIOUS run's resize listener (if any) before
        // this run might register its own - see activeResizeListener's
        // own doc comment above for why.
        if (activeResizeListener) {
            window.removeEventListener('resize', activeResizeListener);
            activeResizeListener = null;
        }
        if (activeFullscreenListener) {
            document.removeEventListener('fullscreenchange', activeFullscreenListener);
            activeFullscreenListener = null;
        }
        if (activeResizeDebounceHandle) {
            clearTimeout(activeResizeDebounceHandle);
            activeResizeDebounceHandle = null;
        }

        var itemId = getItemIdFromHash();
        if (!itemId) { return; }
        // Set as early as possible - synchronously, right after the
        // cheap sync check above, NOT after the fetch below. See
        // Posters-v1.js's ExtraModule (identical comment there) for
        // the full reasoning:
        // a slow fetch otherwise leaves a window where a later staggered
        // burst attempt could call start() a second time while the
        // first call is still in flight, causing a visible "flicker
        // loop" as two overlapping runs fight over the same container.
        contentReady = true;

        log('Starting for item', itemId);

        var result;
        try {
            // cache: 'no-store' - explicitly bypasses ANY browser caching
            // (not just relying on the server's own Cache-Control header),
            // since some browsers serve SPA fetch() calls from an
            // in-memory cache that doesn't always strictly respect
            // Cache-Control for repeat requests to the same URL within
            // one page session - found after a user report that already-
            // visited items kept showing an old configured size value
            // while newly-visited items picked up config changes
            // correctly, consistent with exactly this kind of caching.
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

        // Anchor elements are only strictly needed for the "top"
        // positions - for "bottom", it's enough that the page has loaded
        // at all.
        var anchors = null;
        if (result.Position === 'TopLeft' || result.Position === 'TopRight') {
            await waitFor(function () {
                var a = findAnchors();
                return a.logo && a.poster && a.ribbon ? a : null;
            });
            if (myToken !== runToken) { return; }
            anchors = findAnchors();
        }

        var container = createContainer();
        var layers = [createImageLayer(container, result.FadeTimeMs, result.HorizontalAlign), createImageLayer(container, result.FadeTimeMs, result.HorizontalAlign)];
        var visibleIndex = -1;
        var slideIndex = 0;
        var consecutiveFailures = 0; // see MAX_CONSECUTIVE_FAILURES near the top of the file
        var layoutAppliedOnce = false; // see applyLayout()'s call site in showNext() for why this exists
        // Captured on the first successful "top" position calculation,
        // reused (instead of remeasuring) on every later resize/
        // fullscreenchange recalculation - see computeTopPosition()'s
        // own doc comment for the full "why".
        var frozenGapWidthFraction = null;
        // Bumped on every single showNext() call, checked inside the
        // fade-in requestAnimationFrame below - see that callback's own
        // comment for the full "why" (overlapping images after the tab
        // was backgrounded and comes back).
        var fadeInGeneration = 0;

        // Real, confirmed cause of a serious bug (found via a real user
        // report plus a real console trace showing "window.innerWidth=
        // 150" fire on a full 1920px desktop window): window.innerWidth
        // can report a bogus, momentary value during some browser-level
        // state change (window minimize/restore, tab switch, and
        // similar - never fully identified WHICH one, but confirmed
        // real via that trace) that has nothing to do with the window
        // actually being resized. The old code trusted that single
        // resize-event reading unconditionally and permanently hid the
        // container - and since the user never performs another REAL
        // resize afterward, no later event ever corrects it, matching
        // the reported "stays hidden until a full page reload" symptom
        // exactly.
        //
        // Fixed by not deriving the hide decision from window.innerWidth
        // at all anymore - instead directly reading the REAL native
        // .detailLogo's own already-computed display value. This ties
        // our own visibility decision to the actual, current, browser-
        // computed state of the real element we're trying to mirror,
        // rather than re-guessing it from a width threshold that a
        // transient bad reading can corrupt. Matches the native logo's
        // own breakpoint (68.75em/1100px, librarybrowser.scss) by
        // definition, since it reads that exact element's real result
        // instead of duplicating the threshold ourselves.
        function isNativeLogoHidden() {
            var root = Core.findVisibleDetailPage() || document;
            var logo = root.querySelector('.detailLogo');
            // No real logo element found at all: nothing reliable to
            // mirror, so default to NOT hiding rather than guessing.
            if (!logo) { return false; }
            return getComputedStyle(logo).display === 'none';
        }

        function applyLayout(naturalAspectRatio) {
            // Returns true on success, false on any early-return path -
            // showNext() only latches layoutAppliedOnce on a true result,
            // so a failed attempt (container removed from DOM, or "top"
            // anchors unexpectedly missing) can still be retried on the
            // next image instead of permanently skipping layout forever.
            if (!document.body.contains(container)) { return false; }

            if (isNativeLogoHidden()) {
                container.style.display = 'none';
                return true; // deliberately hidden, not a failure - matches native .detailLogo behavior at this same breakpoint
            }
            container.style.display = '';

            // Pragmatic, directly user-tunable compensation on top of
            // the position-specific offset above, applied ONLY while
            // the tab is actually in fullscreen. Real, user-reported bug
            // fixed here: only checking document.fullscreenElement (the
            // Fullscreen API, only ever engaged by an explicit
            // element.requestFullscreen() call - e.g. a custom
            // fullscreen-button script) completely misses the browser's
            // OWN native F11 fullscreen toggle, which is purely an OS/
            // browser-chrome-level state the Fullscreen API has no
            // visibility into at all - confirmed directly by the user
            // testing both: works via a script-triggered
            // requestFullscreen(), not via plain F11. Fixed the same way
            // another of the user's own existing userscripts (VideoOSD
            // ClearLogoArt) already handles this exact ambiguity:
            // additionally treating the window filling the ENTIRE
            // screen height (no browser chrome/tabs/toolbar consuming
            // any of it) as a second, independent signal - not a perfect
            // proof (a precisely screen-sized non-fullscreen window is
            // theoretically possible), but the standard, pragmatic
            // heuristic for this exact, otherwise undetectable case.
            var offsetPx = vwToPx(result.HorizontalOffsetVw)
                + (isEffectivelyFullscreen() ? vwToPx(result.FullscreenHorizontalOffsetVw) : 0);

            if (result.Position === 'TopLeft' || result.Position === 'TopRight') {
                // Sit behind the native clearlogo (.detailLogo) for the
                // "top" positions specifically - per user request.
                //
                // Moved to run FIRST, unconditionally, before
                // computeTopPosition() below - a real, confirmed bug
                // otherwise: this z-index/DOM-position correction only
                // ever depends on anchors.logo (never on whether the
                // POSITION math below succeeds), but used to sit AFTER
                // the `if (!pos) { return false; }` early-return. If
                // computeTopPosition() failed on the very first attempt
                // (e.g. logo/poster/ribbon briefly reporting zero width
                // before the page finished its own initial layout - see
                // that function's own doc comment) and no later resize/
                // fullscreenchange event ever re-ran applyLayout(), this
                // correction below would simply never run - leaving the
                // container stuck at createContainer()'s original
                // zIndex:5, last child of <body>, i.e. back in front of
                // the logo exactly like the original reported bug -
                // even though the container itself was otherwise
                // perfectly healthy and present. Running this first
                // means the stacking fix always takes effect the moment
                // the logo anchor is known, independent of whether the
                // pixel-position math happens to succeed this time.
                //
                // SECOND CORRECTION (the first z-index-based attempts
                // were both wrong, in opposite directions - see git/
                // conversation history if this needs revisiting again):
                // real source-confirmed DOM structure (RootAppRouter.tsx
                // + Backdrop.tsx) shows the FULL relevant stacking order
                // on this page is actually THREE layers deep, not two:
                // 1) .backgroundContainer.withBackdrop - a real,
                //    source-confirmed dimming overlay (background-color:
                //    rgba(0,0,0,0.86) in every bundled theme, e.g.
                //    themes/dark/theme.css) covering the FULL viewport,
                //    rendered once near the very start of <body> by the
                //    app's root layout, well before .detailLogo even
                //    exists in the DOM.
                // 2) .detailLogo itself - rendered later, once the
                //    details page's own markup mounts.
                // Both have z-index:auto - with NO explicit z-index
                // differing between them, their stacking order is
                // decided purely by DOM position, not by any numeric
                // value. That's exactly why a single explicit z-index on
                // our own container could never correctly sit "between"
                // them: 0 shared the same effective level as both and,
                // being later in the DOM than both (this element used to
                // always be appended at the very end of <body>), ended
                // up above both, including the logo (the ORIGINAL
                // reported bug); -1 then corrected the logo relationship
                // but pushed us below BOTH, including the dimming
                // overlay itself (a later regression - sitting behind
                // the darkening too, not just behind the logo).
                // There is no third numeric z-index value that sits
                // strictly between two same-level, DOM-order-decided
                // elements - the fix has to change actual DOM position
                // instead. zIndex is reset to '' (back to the browser
                // default, auto) here, and the container - which
                // createContainer() already appended at the end of
                // <body> - is moved via insertBefore() to sit exactly
                // between the two: after wherever .backgroundContainer
                // already is (still earlier in the DOM than this move
                // target), but before anchors.logo itself.
                // NOTE: this must be an actual explicit number (0), NOT
                // '' (auto) - root cause confirmed via real
                // getComputedStyle diagnostics: the empty wrapper div
                // itself WAS correctly DOM-ordered before the logo (
                // confirmed: nextElementSibling === logo, no duplicates,
                // both auto/absolute) - yet the visible result was still
                // wrong. Reason: this container's own CHILDREN (the
                // actual visible image layers, createImageLayer() below)
                // carry their OWN explicit z-index (1/2, for the
                // crossfade-between-rotating-images logic). A
                // position:absolute element with z-index:auto does NOT
                // establish a new stacking context of its own - so those
                // children's explicit z-index values were never actually
                // contained "inside" this wrapper's slot at all; they
                // escaped upward and competed directly against the logo
                // in whatever ancestor stacking context actually exists
                // higher up the tree, at explicit values (1, 2) that
                // always outrank the logo's implicit auto/0 level
                // regardless of DOM order. Giving the wrapper itself an
                // explicit z-index (0 is enough) makes it establish its
                // own local stacking context, which traps the 1/2
                // children safely inside it - the wrapper itself then
                // still stacks correctly against the logo via DOM order,
                // exactly as already confirmed (0 and auto are ordered
                // the same way between siblings, so the earlier-proven
                // DOM-order correctness still applies to the wrapper).
                container.style.zIndex = '0';
                if (anchors.logo && anchors.logo.parentNode) {
                    anchors.logo.parentNode.insertBefore(container, anchors.logo);
                    // NO extra z-index here - source-confirmed via real
                    // console output (container.parentNode ===
                    // logo.parentNode: true) that this insertBefore()
                    // move alone correctly reparents the container to
                    // sit immediately before the logo, in the exact
                    // same parent. That's sufficient on its own: with
                    // both elements at z-index:auto, DOM order alone
                    // decides, and the logo (later in the DOM) already
                    // paints on top. A z-index:-1 was tried in addition
                    // to this move as a "belt and suspenders" measure,
                    // reasoning that .mainAnimatedPage's own
                    // "contain: layout" would isolate this page's local
                    // stacking order from the globally-earlier
                    // .backgroundContainer dimming overlay - that
                    // reasoning turned out to be WRONG, confirmed by
                    // real testing: the negative z-index dropped the
                    // container behind the dimming overlay again, so
                    // whatever the precise interaction with that
                    // contain-generated stacking context actually is,
                    // it does NOT provide the isolation assumed. Do not
                    // reintroduce a negative z-index here without new
                    // evidence it's actually needed and safe.
                }

                var pos = computeTopPosition(result.Position, anchors, offsetPx, frozenGapWidthFraction);
                if (!pos) { return false; }
                frozenGapWidthFraction = pos.gapWidthFraction; // no-op after the first call - see computeTopPosition()'s own doc comment

                // computeBoxSize() resolves ScaleMode/Height/Width/Max*
                // into actual width/height - no extra, page-derived cap
                // on top anymore (see computeTopPosition()'s own doc
                // comment for why the earlier ribbon-line growth limit
                // was removed entirely, not just set aside).
                var boxSize = computeBoxSize(result, naturalAspectRatio);
                var width = boxSize.width;
                var height = boxSize.height;

                // position:absolute, NOT fixed - changed after the user
                // pointed out (and it was then confirmed directly against
                // real DOM/CSS, not assumed) that the REAL native
                // .detailLogo is itself position:absolute
                // (librarybrowser.scss), meaning the actual vanilla
                // clearlogo scrolls WITH the page - it does not stay
                // stuck to the screen. The earlier position:fixed choice
                // here was based on a wrong assumption from early in this
                // project that the vanilla logo was scroll-locked - it
                // never was. Since anchors.logo/poster/ribbon are read via
                // getBoundingClientRect() (viewport-relative), and this
                // container is now document-relative (position:absolute),
                // the current scroll offset has to be added once here to
                // convert - computeTopPosition() itself still returns
                // viewport-relative values (see its own doc comment).
                // Core.getScrollOffset() - NOT window.scrollX/scrollY
                // directly, see that function's own doc comment (real
                // scrolling element here is <body>, not <html>).
                var scrollOffset = Core.getScrollOffset();
                var scrollXNow = scrollOffset.x;
                var scrollYNow = scrollOffset.y;

                container.style.position = 'absolute';
                container.style.width = width + 'px';
                container.style.height = height + 'px';
                // A short transition on left/top specifically for "top"
                // positions - softens the resize-triggered recalculation
                // above into a brief glide instead of an instant jump.
                // This can't make it truly seamless like the native
                // .detailLogo (that tracks every single resize frame via
                // its own vw/vh units, no JS involved at all) - our own
                // position instead depends on other rendered content's
                // actual pixel geometry (poster/ribbon size varies with
                // real image dimensions and admin config, not a fixed
                // viewport fraction - source-confirmed via
                // findAnchors(), .poster resolves to .detailImageContainer
                // .card, real rendered artwork), so a JS recalculation on
                // a debounce timer is unavoidable here.
                //
                // NO transition here (removed at explicit user request,
                // after real jellyfin-web source was checked directly to
                // confirm the mechanism): the native .detailLogo itself
                // has NO CSS transition either (librarybrowser.scss:495 -
                // .detailLogo{width/height/top/right}, no `transition`
                // property anywhere on it) and no JS ever touches its
                // position/size at all (confirmed:
                // itemDetails/index.js's only two touches on .detailLogo
                // are the `hide` class and its own image URL). Its
                // "seamless" appearance during continuous window
                // resizing isn't an animation at all - it's the browser
                // recomputing plain vw/vh values on every single render
                // frame, with nothing to visibly jump between. That same
                // absence of a transition is exactly why it also snaps
                // instantly, with no glide, on a discrete resize (e.g.
                // toggling fullscreen) - there was never a fundamentally
                // different mechanism for the two cases, only how often
                // the underlying value happens to change. A user report
                // correctly identified that an EARLIER version of this
                // fix added a 200ms glide transition here that was never
                // requested and made this LESS like the vanilla behavior,
                // not more - matching that behavior as closely as
                // possible (given a JS recalculation on a debounce timer
                // can't literally run every render frame the way pure
                // CSS units do) means an instant, un-transitioned jump on
                // every recalculation, exactly like this.
                container.style.left = (scrollXNow + pos.centerX - width / 2) + 'px';
                container.style.top = (scrollYNow + pos.bottomY - height) + 'px';
                container.style.right = '';
                container.style.bottom = '';
                log('Top position recalculated: viewport=', window.innerWidth, '| logo.right=', anchors.logo.getBoundingClientRect().right.toFixed(1),
                    '| centerX=', pos.centerX.toFixed(1), '| centerX as % of viewport=', (pos.centerX / window.innerWidth * 100).toFixed(3),
                    '| width=', width.toFixed(1), '| width as % of viewport=', (width / window.innerWidth * 100).toFixed(3),
                    '| left(container)=', (scrollXNow + pos.centerX - width / 2).toFixed(1), '| left as % of viewport=', ((scrollXNow + pos.centerX - width / 2) / window.innerWidth * 100).toFixed(3),
                    '| frozenGapWidthFraction=', frozenGapWidthFraction.toFixed(5), '| offsetPx=', offsetPx.toFixed(1));
            } else {
                var boxSize2 = computeBoxSize(result, naturalAspectRatio);
                var w = boxSize2.width;
                var h = boxSize2.height;
                var bottomPos = computeBottomPosition(result.Position, offsetPx);

                // position:fixed, viewport-anchored - see
                // computeBottomPosition()'s own doc comment. bottom:0
                // matches the original math exactly (the old topPx =
                // scrollY + innerHeight - elementHeight always placed
                // the bottom edge flush with the window's bottom edge,
                // no vertical margin) - BOTTOM_MARGIN_VW is a HORIZONTAL
                // (left/right) inset only, never applies vertically.
                container.style.position = 'fixed';
                container.style.width = w + 'px';
                container.style.height = h + 'px';
                container.style.top = '';
                container.style.bottom = '0px';
                container.style.left = bottomPos.side === 'left' ? bottomPos.sideOffsetPx + 'px' : '';
                container.style.right = bottomPos.side === 'right' ? bottomPos.sideOffsetPx + 'px' : '';
            }
            return true;
        }

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
            consecutiveFailures = 0; // a successful load resets the streak

            // applyLayout() now runs ONLY ONCE per slideshow, not on
            // every single image change - fixes a user-reported "jump":
            // see the comment on createImageLayer()'s object-fit:contain
            // for the full explanation. Every subsequent image in the
            // same rotation reuses this same fixed container - it no
            // longer sets its OWN aspect ratio on the container at all,
            // it just fits itself inside via object-fit:contain. The
            // FIRST loaded image's aspect ratio is passed in as
            // naturalAspectRatio, but per Core.computeBoxSize()'s own
            // doc comment, that value only actually matters for whichever
            // dimension is left on "auto" (its own Max*Vw/Max*Vh is 0) -
            // once Max* is set for a dimension, the box is fully fixed
            // from the admin's settings alone, regardless of which image
            // happened to be first.
            if (!layoutAppliedOnce) {
                var aspectRatio = loadedImg.naturalWidth / loadedImg.naturalHeight;
                layoutAppliedOnce = applyLayout(aspectRatio || 1); // only latches on genuine success, see applyLayout()'s own doc comment

                // Both "top" AND "bottom" positions need to recompute on
                // viewport size changes - NEITHER is actually a one-off
                // calculation that stays valid. "Top" derives its
                // placement from other page elements' live pixel
                // positions (getBoundingClientRect() on the logo/poster/
                // ribbon anchors). "Bottom" was WRONGLY assumed (in an
                // earlier version of this comment) to be "plain vw/vh,
                // inherently fluid on its own" - that's only true for
                // the vertical side (bottom:0px, a fixed value that
                // genuinely never needs recalculating); the horizontal
                // side (computeBottomPosition()'s sideOffsetPx) is a
                // vwToPx() snapshot - a real pixel number computed once
                // and frozen from then on, the exact same staleness
                // pattern "top" had before this fix, just not noticed as
                // quickly since it's a fixed margin rather than a
                // position relative to another moving element. Neither
                // case had a resize listener at all before this fix
                // (confirmed directly, not assumed) - both get one now.
                // Debounced (150ms) since 'resize' can fire many times
                // per second while actively dragging a window edge -
                // only the FINAL size in a burst needs a recalculation,
                // not every intermediate one.
                if (layoutAppliedOnce) {
                    var recalculate = function () {
                        if (activeResizeDebounceHandle) { clearTimeout(activeResizeDebounceHandle); }
                        activeResizeDebounceHandle = track(setTimeout(function () {
                            if (myToken !== runToken) { return; } // this run is no longer current - let its own start() call's cleanup (above) remove this listener instead
                            applyLayout(aspectRatio || 1);
                        }, 150));
                    };
                    activeResizeListener = recalculate;
                    window.addEventListener('resize', activeResizeListener);
                    // ALSO listen for fullscreenchange specifically, not
                    // just plain 'resize' - user-reported: toggling
                    // fullscreen left "top" positions visibly overlapping
                    // the native clearlogo, matching a genuine viewport-
                    // size-dependent geometry (this container's own
                    // configured offset from the logo needs to scale
                    // right along with the logo's own now-bigger size,
                    // exactly what a fresh recalculation provides) - but
                    // it's not fully confirmed whether entering/exiting
                    // fullscreen reliably fires a plain 'resize' event on
                    // every browser, with reliable timing relative to
                    // when the new layout has actually settled. Rather
                    // than assume 'resize' alone is sufficient, this adds
                    // the browser's own dedicated fullscreen event as a
                    // second, more direct trigger for the exact same
                    // recalculation - real jellyfin-web source
                    // (apphost.js) itself lists 'fullscreenchange' as a
                    // real, relevant browser feature, confirming it's a
                    // genuine event to rely on here, not a guess.
                    activeFullscreenListener = recalculate;
                    document.addEventListener('fullscreenchange', activeFullscreenListener);
                }
            }

            var nextLayerIndex = visibleIndex === 0 ? 1 : 0;
            var nextLayer = layers[nextLayerIndex];
            var prevLayer = visibleIndex === -1 ? null : layers[visibleIndex];
            var myGeneration = ++fadeInGeneration; // see the fade-in requestAnimationFrame below for why this exists

            nextLayer.src = url;
            nextLayer.style.zIndex = '2';
            // Force the "0" starting state to actually be committed/
            // painted before the fade-in below - without this, a REUSED
            // layer (from the 3rd image onward, once both layers have
            // already been through one fade cycle) can have its opacity
            // change from the previous cycle's fade-out and this cycle's
            // src+opacity change coalesced into a single paint by the
            // browser, since nothing forces it to actually render the "0"
            // state in between - CSS transitions only fire on an actual
            // computed-style change between two rendered frames, so
            // without this the element can jump straight to opacity:1
            // with no visible transition at all (matches the reported
            // symptom: fades only on the very first image, hard cuts
            // after). A freshly created layer (1st/2nd image) doesn't
            // need this - its initial opacity:0 from createImageLayer()
            // has already had plenty of time to paint before the first
            // showNext() call - but it's harmless to always do it.
            nextLayer.style.opacity = '0';
            void nextLayer.offsetWidth; // forces a synchronous reflow
            if (prevLayer) {
                prevLayer.style.zIndex = '1';
                // Bug fix: without this, the previous layer stayed at
                // opacity:1 forever, only ever pushed BEHIND the new one
                // via z-index - invisible for fully opaque images (the
                // new layer completely covers it), but for transparent
                // PNGs (Characterart's whole point) the old image stays
                // visible through the new one's transparent areas,
                // making it look like images pile up on top of each
                // other instead of actually replacing one another.
                prevLayer.style.opacity = '0';
            }

            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    if (myToken !== runToken) { return; }
                    // Guards against a real, confirmed bug: while a tab
                    // is backgrounded, Chrome pauses requestAnimationFrame
                    // entirely, but setTimeout (the CycleTimeMs rotation
                    // timer just below) keeps firing (throttled, but
                    // still fires). That means several showNext() calls
                    // can run in a row while backgrounded - each one's
                    // own synchronous opacity/background-image/z-index
                    // changes apply immediately as normal, but each
                    // one's OWN "fade in" step (this very rAF pair) just
                    // queues up, paused, without ever actually running.
                    // When the tab becomes visible again, Chrome fires
                    // ALL of those queued, stale rAF callbacks in a
                    // burst - and without this check, every single one
                    // of them would unconditionally set opacity:1 on
                    // whatever layer IT captured, including layers that
                    // a LATER showNext() call has since correctly told
                    // to fade back OUT again - visibly appearing as
                    // several images overlapping at once, exactly the
                    // reported symptom (only ever seen after returning
                    // from a backgrounded tab, never while staying in
                    // focus the whole time, which matches this exact
                    // mechanism precisely). Only the MOST RECENTLY
                    // scheduled fade-in (myGeneration === the latest
                    // fadeInGeneration by the time it actually fires) is
                    // allowed to apply - every earlier, now-stale queued
                    // one becomes a harmless no-op instead.
                    if (myGeneration !== fadeInGeneration) { return; }
                    nextLayer.style.opacity = '1';
                });
            });

            visibleIndex = nextLayerIndex;
            slideIndex++;

            // Normally the recursive showNext() call below only gets
            // scheduled when there's genuinely more than 1 image to
            // rotate between - with only 1, there was nothing further to
            // show, so the timer was simply never set, and the one image
            // stayed visible forever/statically. That incidentally also
            // meant SinglePass's own "fade out after one pass" check
            // (further up in this function) never got a chance to run
            // either, even with Play once configured, since it only runs
            // from INSIDE a showNext() call that this scheduling is what
            // triggers in the first place. StaySingleImageStatic (false
            // by default, per user request) is the deliberate escape
            // hatch: with it off, a single found image now schedules one
            // more showNext() call after CycleTimeMs same as the
            // multi-image case would, and THAT call is what reaches the
            // SinglePass check and fades it out - making the
            // single-image case behave consistently with what "Play
            // once" otherwise always means, instead of being a silent,
            // permanently-exempt special case.
            var isSingleImageThatShouldStillEnd = imageUrls.length === 1 && result.SinglePass && !result.StaySingleImageStatic;
            if ((result.MultiImage && imageUrls.length > 1) || isSingleImageThatShouldStillEnd) {
                track(setTimeout(showNext, result.CycleTimeMs));
            }
        }

        var delayMs = result.DelayEnabled ? result.DelayMs : 0;
        await new Promise(function (resolve) { track(setTimeout(resolve, delayMs)); });
        if (myToken !== runToken) { return; }

        log('Showing Characterart, position:', result.Position, '| MultiImage:', result.MultiImage, '|', imageUrls.length, 'image(s)');
        shouldHaveContainer = true; // see its own doc comment above - this is the exact "committed to actually showing something" point
        showNext();
    }

    // -----------------------------------------------------------------
    // Intercepting SPA navigation
    // -----------------------------------------------------------------

    function schedule() {
        log('DIAGNOSTIC: schedule() running | itemId from hash right now=', getItemIdFromHash(), '| isDetailsPage()=', isDetailsPage());
        clearTimers();
        navTracker.clearTimers();
        runToken++;
        document.querySelectorAll('.characterart-container').forEach(function (el) { el.remove(); });
        contentReady = false;
        shouldHaveContainer = false; // fresh navigation - whatever the PREVIOUS page should have had no longer applies
        // Burst: several staggered attempts instead of just one - see
        // Core.scheduleNavigationBurst()'s own doc comment for the
        // full reasoning (a user-reported "needs a manual refresh"
        // symptom, root-caused via comparing against BackdropsPlus, the
        // one feature that didn't have this problem). Each attempt
        // re-checks isDetailsPage() itself and skips if contentReady is
        // already true (an earlier attempt already resolved this
        // navigation). navTracker, NOT the main tracker - see its own
        // declaration comment for why: start() clears the main tracker
        // internally, which would otherwise wipe out these very burst
        // timers before later ones got a chance to fire.
        Core.scheduleNavigationBurst(function () {
            if (contentReady || !isDetailsPage()) { return; }
            start();
        }, navTracker.track);
    }

    document.addEventListener('viewshow', function () {
        log('DIAGNOSTIC: viewshow event fired | location.hash=', location.hash, '| performance.now()=', performance.now().toFixed(1));
        schedule();
    });
    // Continuous poll as a backup - see Core's watchForNavigation doc
    // comment for why 'viewshow' alone isn't reliable enough for every
    // kind of navigation. schedule() is safe to call redundantly (guards
    // itself via runToken/isDetailsPage()).
    Core.watchForNavigation(function () {
        log('DIAGNOSTIC: watchForNavigation (hash poll) detected a change | location.hash=', location.hash, '| performance.now()=', performance.now().toFixed(1));
        schedule();
    });
    // Navigation-INDEPENDENT self-healing - re-added at explicit user
    // request; see Core.startPresenceHeartbeat()'s own doc comment for
    // the full reasoning (a genuine additional safety net for a
    // different failure class than findVisibleDetailPage()/the
    // z-index-independent-of-position-math fix address). schedule()
    // itself is reused as the recovery action - it's already safe to
    // call redundantly.
    Core.startPresenceHeartbeat(
        function () { return !shouldHaveContainer || !!document.querySelector('.characterart-container'); },
        function () { log('DIAGNOSTIC: presence heartbeat detected a missing container and is recovering | performance.now()=', performance.now().toFixed(1)); schedule(); }
    );
    // One-shot fallback for the "hard refresh WHILE already on a details
    // page" case specifically - no navigation ever happens there (the
    // page just loads once, already on that URL), so neither 'viewshow'
    // nor watchForNavigation's hash-change poll has anything to react
    // to; something still has to make the very first attempt. Guarded by
    // contentReady, NOT unconditional - a second, real bug found via a
    // user report of a "pops up, disappears, pops up again" pattern:
    // this timer used to call start() completely independently of
    // schedule()'s own contentReady/runToken bookkeeping, so a genuine
    // SPA navigation happening to land within this same 1.2s window (a
    // very ordinary case - e.g. clicking a poster right after the page
    // finishes loading) produced a real SECOND, totally uncoordinated
    // start() call on top of the correct one from
    // viewshow->schedule()->burst, each doing its own
    // clearTimers()/rebuild and fighting over the same container/
    // overlay. Checking contentReady here first means this fallback
    // correctly stays silent whenever an earlier, real navigation has
    // already resolved things - it only ever actually fires for the
    // genuine hard-refresh-already-there case it was built for.
    track(setTimeout(function () {
        if (contentReady || !isDetailsPage()) { return; }
        start();
    }, 1200));
})();

/*!
 * Red Carpet - script
 * ------------------------------------------------------
 * A completely standalone file (curriculum section H). Unlike all other
 * feature blocks: shows up ONCE PER PAGE (not per tile/item like
 * library.js), at a viewport-anchored position (bottom left/right,
 * position:fixed - stays glued to the window at all times, same as
 * Jellyfin's own .skinHeader/backdrop, NOT scroll-following like the
 * vanilla clearlogo). No crossfade rotation needed - always exactly 1
 * static image per person, just a single fade-in on appearance (duration
 * hardcoded, no admin setting for it, curriculum H).
 *
 * Two recognized page types (curriculum H, verified against the user's own
 * JellyfinKeyboardLibraryNavigation.js):
 *   - Person detail page: #/details?id=<personId> -> scope=info
 *   - Filmography list:   #/list.html?type=Movie|Series|Episode&personId=<personId>
 *     -> scope=movie|series|episode
 * The server checks for itself whether the itemId even belongs to a person
 * - this script doesn't have to detect the page type itself via DOM
 * analysis, it just always asks and trusts the result.
 */
(function () {
    'use strict';

    // Duplicate-load guard: see Core.claimSingleton()'s own doc comment
    // and CharacterArt's own identical guard above for the full
    // reasoning.
    if (!window.ArtworkPlusCore.claimSingleton('RedCarpet')) { return; }

    var DEBUG = true;
    var PRELOAD_TIMEOUT_MS = 8000;
    var FADE_MS = 500; // hardcoded, see the top of the file
    var BOTTOM_MARGIN_VW = 0.8; // inset from the left/right screen edge, as a percentage of viewport width (≈15px at 1920px) - matches Jellyfin's own vw/vh-based sizing instead of a fixed pixel value, so it looks proportionally the same across different screen resolutions

    var log = window.ArtworkPlusCore.makeLogger('[RedCarpet]', DEBUG);

    // Shared engine functions - see Jellyfin-ArtworkPlus-Core-v1.js. This
    // script is unusable without it (hard dependency, not optional).
    var Core = window.ArtworkPlusCore;

    // No Core.ensureBodyIsPositioned() call here (unlike CharacterArt) -
    // this script exclusively uses position:fixed now (see the file
    // header), which is always viewport-relative by CSS definition
    // regardless of <body>'s own "position" property - the containing-
    // block fix that function provides only matters for
    // position:absolute elements.
    var vwToPx = Core.vwToPx;
    var computeBoxSize = Core.computeBoxSize;
    var horizontalAlignToObjectPosition = Core.horizontalAlignToObjectPosition;

    // Real, user-reported bug fix (same investigation as
    // this file's own CharacterArt section above's identical helper - see
    // that section's own doc comment for the full explanation): the Fullscreen API
    // (document.fullscreenElement) has no visibility at all into the
    // browser's own native F11 fullscreen toggle, purely an OS/browser-
    // chrome-level state. Fixed the same way the user's own existing
    // VideoOSD ClearLogoArt userscript already handles this exact
    // ambiguity: additionally treating the window filling the ENTIRE
    // screen height as a second, independent "effectively fullscreen"
    // signal.
    function isEffectivelyFullscreen() {
        var isRealFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
        var isBrowserChromeFullscreen = !isRealFullscreen && window.innerHeight === screen.height;
        return isRealFullscreen || isBrowserChromeFullscreen;
    }

    var runToken = 0;
    var tracker = Core.createTimerTracker();
    var track = tracker.track;
    var clearTimers = tracker.clearTimers;
    // Holds the currently active resize/fullscreenchange listener (if
    // any) - see its registration site in start() below for the full
    // reasoning (matches this file's own CharacterArt section above's
    // identical pattern). Torn
    // down at the start of every new start() call so listeners from an
    // abandoned previous run don't pile up across navigations.
    var activeRepositionListener = null;
    // Separate tracker JUST for the burst timers in schedule() below -
    // see this file's own CharacterArt section above's identical
    // navTracker declaration for the full reasoning (start() clears the main tracker internally, which
    // would otherwise wipe out these very burst timers before later
    // ones got a chance to fire).
    var navTracker = Core.createTimerTracker();
    // Set false on every new detected navigation, true as soon as
    // start() gets a definitive server response for the CURRENT
    // navigation - lets later staggered burst attempts cheaply no-op
    // instead of redoing a fetch/DOM rebuild.
    var contentReady = false;
    // The personId RedCarpet is CURRENTLY showing an image for (null if
    // nothing is shown right now). Source-confirmed via
    // RedCarpetController.cs: position/size/all other display settings
    // come from a single global config.RedCarpetPosition etc. - there is
    // no per-scope (info/movie/series/episode) variant of any of them -
    // so as long as the person is the same, nothing about how the image
    // should be displayed could possibly have changed either, no matter
    // which of the person's own pages (detail vs. filmography list) was
    // navigated to.
    var currentPersonId = null;

    // resolveWith:'image' for the aspect-ratio math below. No `track`
    // option passed - this timeout was never routed through the
    // race-condition tracker in the original either, kept as-is.
    function preloadImage(url) {
        return Core.preloadImage(url, { resolveWith: 'image', timeoutMs: PRELOAD_TIMEOUT_MS });
    }

    /// Determines the person ID + scope from the current URL, or null if
    /// the current page can't be relevant for Red Carpet at all.
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

    function createContainer() {
        // Real, confirmed bug this fixes: createContainer() used to
        // instantly remove ('.remove()', no fade) any existing
        // '.redcarpet-container' before building the new one. start()
        // always calls fadeOutAndRemoveContainer() BEFORE reaching this
        // function whenever a different person is being shown, so the
        // old container's own 500ms opacity transition is already
        // under way - but createContainer() ran synchronously as soon
        // as the new person's fetch+image-preload finished, which can
        // easily be well under 500ms (fast server response, or the
        // image already in the browser's own cache). When that
        // happened, this line ripped the still-fading-out old container
        // straight out of the DOM mid-transition, before the fade was
        // ever visible - the exact "the fade-out is gone again" bug
        // reported after the fact. fadeOutAndRemoveContainer() already
        // owns removal of the old container correctly (see its own,
        // now-untracked setTimeout below for why that removal is
        // guaranteed to still happen on time) - createContainer() only
        // needs to build the NEW one now. Old and new containers
        // briefly coexisting (one fading out, one fading in) is the
        // correct, intended crossfade - not a bug to guard against.
        var div = document.createElement('div');
        div.className = 'redcarpet-container';
        div.style.position = 'fixed';
        div.style.zIndex = '5';
        div.style.pointerEvents = 'none';
        div.style.opacity = '0';
        div.style.transition = 'opacity ' + FADE_MS + 'ms ease';
        document.body.appendChild(div);
        return div;
    }

    /// position:fixed, viewport-anchored - the user explicitly confirmed
    /// (after a sketch comparing this to Jellyfin's own .skinHeader/
    /// backdrop) that RedCarpet should stay glued to the window at all
    /// times, not scroll away with the page. bottom:0 matches the
    /// original math exactly (an earlier version computed a
    /// document-relative top offset - scrollY + innerHeight - height -
    /// for use with position:absolute, always placing the bottom edge
    /// flush with the window's bottom edge with no vertical margin;
    /// bottom:0 achieves the identical visual result directly, and
    /// position:fixed needs no scroll-offset math at all since it's
    /// already viewport-relative by definition).
    function positionContainer(container, position, offsetPx) {
        container.style.top = '';
        container.style.bottom = '0px';
        // Same sign convention as characterart.js: positive offsetPx always
        // shifts further right, negative always shifts further left,
        // regardless of which side the element is anchored to.
        if (position === 'BottomRight') {
            container.style.right = (vwToPx(BOTTOM_MARGIN_VW) - offsetPx) + 'px';
            container.style.left = '';
        } else {
            container.style.left = (vwToPx(BOTTOM_MARGIN_VW) + offsetPx) + 'px';
            container.style.right = '';
        }
    }

    /// Fades the currently shown container out via its own existing
    /// opacity transition, then actually removes it from the DOM once
    /// the fade completes - used at every point below where the
    /// detected person is NOT the one currently being shown (or there
    /// is no relevant person at all), matching the graceful "nothing to
    /// show" behavior schedule() used to apply unconditionally (and
    /// instantly) on every navigation before this existed.
    function fadeOutAndRemoveContainer(myToken) {
        currentPersonId = null; // reflects reality immediately - nothing is "currently shown" anymore, regardless of how long the fade-out visually takes
        var containers = document.querySelectorAll('.redcarpet-container');
        log('fadeOutAndRemoveContainer called, found', containers.length, 'container(s), setting opacity to 0');
        containers.forEach(function (el) { el.style.opacity = '0'; });
        // Deliberately NOT run through track() (so clearTimers() at the
        // top of a later start() call can't delete this before it
        // fires) and deliberately NOT gated on myToken === runToken
        // anymore either - both would leave this specific, already-
        // fading-out container stuck in the DOM forever (invisible,
        // but never cleaned up) the moment a newer run starts before
        // this timer's own FADE_MS has elapsed, which is common (a
        // fast server response or a cached image can easily finish
        // well under 500ms). `containers` above is a static snapshot
        // captured at THIS specific call, not a live query - it can
        // only ever remove the exact old element(s) it already had in
        // hand, never anything a later run has since created, so
        // neither guard was actually needed for correctness; both were
        // only ever blocking this removal from happening reliably.
        setTimeout(function () {
            log('fadeOutAndRemoveContainer: removal timer fired, actually removing now');
            containers.forEach(function (el) { el.remove(); });
        }, FADE_MS);
    }

    async function start() {
        clearTimers();
        var myToken = ++runToken;

        // Tear down the PREVIOUS run's reposition listener (if any) -
        // see activeRepositionListener's own doc comment above.
        if (activeRepositionListener) {
            window.removeEventListener('resize', activeRepositionListener);
            document.removeEventListener('fullscreenchange', activeRepositionListener);
            activeRepositionListener = null;
        }

        var detected = detectPersonAndScope();
        log('start() called, hash:', location.hash, '| detected:', JSON.stringify(detected), '| currentPersonId:', currentPersonId);
        if (!detected) {
            // Navigated to a page RedCarpet has nothing to show on at
            // all (e.g. back to a library view) - eases out rather than
            // vanishing abruptly, since there's no new image about to
            // replace it that a hard cut would otherwise be masked by.
            fadeOutAndRemoveContainer(myToken);
            return;
        }

        // Same person as what's already being shown (regardless of
        // which of their own pages - detail vs. filmography list - this
        // navigation landed on): the existing image, container,
        // position and size all remain correct as-is (see
        // currentPersonId's own doc comment for why), so do nothing at
        // all rather than removing and recreating the same thing - this
        // is what stops the image from visibly disappearing and
        // fading back in when navigating between a person's own pages,
        // which it did before this check existed.
        if (detected.personId === currentPersonId) {
            contentReady = true;
            return;
        }

        // A genuinely different person - OR, just as often in practice,
        // navigating to something else entirely whose URL happens to
        // match the same #/details?id=X shape a person page has (most
        // commonly: clicking from a person's filmography straight to
        // one of their movies/shows) - detectPersonAndScope() has no
        // way to tell those apart from the URL alone (that would need
        // an extra server round-trip just to check the item's type).
        // Both cases get the same graceful fade-out treatment as
        // navigating away entirely, for exactly that reason - there's
        // no reliable way to single out "real person switch" for the
        // instant-cut behavior instead.
        fadeOutAndRemoveContainer(myToken);

        // Set as early as possible - synchronously, right after the
        // cheap sync check above, NOT after the fetch below. See
        // Posters-v1.js's ExtraModule (identical comment there) for
        // the full reasoning:
        // a slow fetch otherwise leaves a window where a later staggered
        // burst attempt could call start() a second time while the
        // first call is still in flight.
        contentReady = true;

        var result;
        try {
            // cache: 'no-store' - see Characterart's fetch call for the
            // full reasoning.
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

        // computeBoxSize() resolves ScaleMode/Height/Width/Max* into
        // actual width/height - see Core's own doc comment for the full
        // reasoning (same system as CharacterArt, moved to Core to avoid
        // duplicating it here). Since RedCarpet only ever shows ONE
        // image at a time (no rotation, unlike CharacterArt), this call
        // happens fresh every time a new person's image loads - there's
        // no "layoutAppliedOnce" latch here at all, so the box is always
        // computed from THIS specific image's own aspect ratio whenever
        // a dimension is left on "auto" (its Max* is 0).
        var aspectRatio = (loadedImg.naturalWidth / loadedImg.naturalHeight) || 1;
        var boxSize = computeBoxSize(result, aspectRatio);
        var width = boxSize.width;
        var height = boxSize.height;

        var container = createContainer();
        var img = document.createElement('img');
        img.src = url;
        img.style.display = 'block';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        // Whenever a Max*Vw/Max*Vh is actually configured (a genuine
        // fixed container, per Core.computeBoxSize()'s own doc comment),
        // this single image may leave leftover space on one axis if its
        // own aspect ratio doesn't exactly fill the configured box -
        // object-fit:contain + a configurable object-position handles
        // that exactly like CharacterArt does, so HorizontalAlign has a
        // real, visible effect here too, not just when a dimension is
        // left on "auto" (where the box hugs the image exactly and
        // there's nothing to align in the first place).
        img.style.objectPosition = horizontalAlignToObjectPosition(result.HorizontalAlign);
        container.appendChild(img);

        container.style.width = width + 'px';
        container.style.height = height + 'px';

        function currentOffsetPx() {
            // See PluginConfiguration.CharacterartFullscreenHorizontalOffsetVw's
            // own doc comment for the full reasoning - same idea, here
            // for RedCarpet.
            return vwToPx(result.HorizontalOffsetVw)
                + (isEffectivelyFullscreen() ? vwToPx(result.FullscreenHorizontalOffsetVw) : 0);
        }
        positionContainer(container, result.Position, currentOffsetPx());

        // RedCarpet is position:fixed (viewport-relative) using vwToPx()
        // pixel snapshots for its horizontal offset - the exact same
        // "computed once, frozen from then on" staleness pattern this
        // file's own CharacterArt section above had before its own
        // resize/fullscreenchange fix (see that section's history for the
        // full investigation).
        // Re-applies the position (not a full reload - same container,
        // same image, just re-running the cheap position math) on any
        // later resize or fullscreen toggle during the same view.
        activeRepositionListener = function () {
            if (myToken !== runToken) { return; } // this run is no longer current
            if (!document.body.contains(container)) { return; }
            positionContainer(container, result.Position, currentOffsetPx());
        };
        window.addEventListener('resize', activeRepositionListener);
        document.addEventListener('fullscreenchange', activeRepositionListener);

        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                if (myToken !== runToken) { return; }
                container.style.opacity = '1';
            });
        });

        currentPersonId = detected.personId;
        log('Red Carpet shown for person', detected.personId, '| Scope:', detected.scope, '| Position:', result.Position);
    }

    function schedule() {
        clearTimers();
        navTracker.clearTimers();
        runToken++;
        // NOTE: no longer unconditionally removing '.redcarpet-container'
        // here on every single navigation - that was the direct cause of
        // the image visibly disappearing and fading back in when
        // navigating between a person's own pages (detail <-> filmography
        // list). start() now decides for itself, based on whether the
        // detected person actually changed, whether removing the
        // existing container is warranted at all - see its own comments.
        contentReady = false;
        // Burst: several staggered attempts instead of just one - see
        // Core.scheduleNavigationBurst()'s own doc comment for the full
        // reasoning. No isDetailsPage()-style guard here - start() itself
        // already freshly checks detectPersonAndScope() on every call
        // (RedCarpet must work on both "details" AND list.html filmography
        // pages, so a details-only guard would be wrong here). navTracker,
        // not the main tracker - see its own declaration comment above.
        Core.scheduleNavigationBurst(function () {
            if (contentReady) { return; }
            start();
        }, navTracker.track);
    }

    document.addEventListener('viewshow', schedule);
    // Continuous poll as a backup - see Core's watchForNavigation doc
    // comment. schedule() is safe to call redundantly (runToken guard).
    Core.watchForNavigation(schedule);
    // One-shot fallback for hard-refresh-already-on-a-relevant-page -
    // see this file's own CharacterArt section above's identical comment
    // for the full reasoning. start() itself already checks
    // detectPersonAndScope() internally.
    track(setTimeout(function () {
        if (contentReady) { return; }
        start();
    }, 1200));
})();
