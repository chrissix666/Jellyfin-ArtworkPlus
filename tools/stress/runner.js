/*!
 * ArtworkPlus stress test - in-page runner + recorder (Session 135).
 * Injected into the logged-in Jellyfin tab; walks the playbook (hash
 * navigation like a person: dwell, scroll on library pages) and records per
 * step, from the moment the hash changes:
 *   tImg     ms until the page's main image is decoded (poster / first card)
 *   tBd      ms until a backdrop is painted (vanilla .backdropImage or ours)
 *   tLogo    ms until the logo slot shows something (.detailLogo bg / .logoart-container)
 *   tSettle  ms until the DOM stayed quiet for 700 ms
 *   lt/ltMs/ltMax   long tasks in the step window (count, total ms, longest)
 *   gap/gapMs       rAF gaps > 50 ms (count, total ms) - dropped-frame proxy
 *   sgap/sgapMs     the same during the scroll phase (library pages)
 *   req/kb/img/plug requests, transferred KB, image requests, plugin-endpoint requests
 *   nodes    DOM element count at step end
 *   left     leftover plugin elements at step end (containers that should be gone after leaving)
 *   heap     JS heap MB at step end (Chrome only)
 *   err      console.error + window error count in the window
 * Results: compact arrays in localStorage.__stressResults (gzip+base64 via
 * __stressExport()). window.__stress exposes progress; __stressStop() aborts.
 */
(function () {
    'use strict';
    var PLUGIN_RX = /\/(LogoArt|Characterart|Extraposter|AnimatedPoster|CustomPoster|Backdrops|PeopleBackdrops|RedCarpet|CaseMod|RenderArt|PostersPlus|ArtworkPlusCore)\//;
    var S = window.__stress = { i: -1, steps: [], results: [], running: false, label: '', started: 0 };

    // ---- global observers (run for the whole session) ----
    var longTasks = [], gaps = [], errors = [], resources = [], mutations = 0, lastMutation = 0;
    try {
        new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { longTasks.push([e.startTime, e.duration]); }); }).observe({ type: 'longtask', buffered: true });
    } catch (e) { /* no longtask support */ }
    try {
        new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { resources.push([e.startTime, e.transferSize || 0, e.initiatorType, e.name]); }); }).observe({ type: 'resource', buffered: true });
    } catch (e) { /* ignore */ }
    (function rafLoop() {
        var last = performance.now();
        function tick(now) { var d = now - last; if (d > 50) { gaps.push([last, d]); } last = now; if (S.running || S.i === -1) { requestAnimationFrame(tick); } }
        requestAnimationFrame(tick);
    })();
    var origErr = console.error;
    console.error = function () { errors.push(performance.now()); return origErr.apply(console, arguments); };
    window.addEventListener('error', function () { errors.push(performance.now()); });
    new MutationObserver(function () { mutations++; lastMutation = performance.now(); }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    function inWindow(list, t0, t1) { return list.filter(function (e) { return e[0] >= t0 && e[0] < t1; }); }
    function mb(n) { return Math.round(n / 1048576 * 10) / 10; }

    // ---- what "content is there" means per page kind ----
    function mainImageReady(kind) {
        var root = document.querySelector('.mainAnimatedPage:not(.hide)') || document;
        if (/movie|series|season|episode|set|person/.test(kind)) {
            var el = root.querySelector('.detailImageContainer .cardImageContainer');
            if (!el) { return false; }
            var img = el.querySelector('img');
            if (img) { return img.complete && img.naturalWidth > 0; }
            return !!(el.style.backgroundImage || (el.classList.contains('lazy-image-fadein') || el.classList.contains('lazy-image-fadein-fast')));
        }
        var cards = root.querySelectorAll('.cardImageContainer');
        for (var i = 0; i < cards.length; i++) {
            var c = cards[i];
            var im = c.querySelector('img');
            if (im ? (im.complete && im.naturalWidth > 0) : (c.classList.contains('lazy-image-fadein') || c.classList.contains('lazy-image-fadein-fast') || (c.style.backgroundImage && c.style.backgroundImage !== 'none'))) { return true; }
        }
        return false;
    }
    function backdropReady() {
        var own = document.querySelector('.artworkplus-own-backdrop img, .artworkplus-own-backdrop');
        if (own && (own.tagName !== 'IMG' || (own.complete && own.naturalWidth > 0))) {
            var bg = own.tagName === 'IMG' ? own : own.querySelector('img');
            if (!bg || (bg.complete && bg.naturalWidth > 0)) { return true; }
        }
        var v = document.querySelector('.backdropContainer .backdropImage');
        return !!(v && v.style.backgroundImage && v.classList.contains('backdropImageFadeIn'));
    }
    function logoReady(kind) {
        if (!/movie|series|season|episode|set|person/.test(kind)) { return null; }
        var la = document.querySelector('.logoart-container');
        if (la) { var i = la.querySelector('img'); if (i ? (i.complete && i.naturalWidth > 0) : la.querySelector('.logoart-text')) { return true; } }
        var d = document.querySelector('.mainAnimatedPage:not(.hide) .detailLogo') || document.querySelector('.detailLogo');
        return !!(d && !d.classList.contains('hide') && d.style.backgroundImage && d.style.backgroundImage !== 'none' && getComputedStyle(d).visibility !== 'hidden');
    }
    function leftovers() {
        return document.querySelectorAll('.logoart-container, .characterart-container, .characterart-anchor, .redcarpet-container, .artworkplus-art-box, [class*="artworkplus-tile"], .artworkplus-own-backdrop').length;
    }

    function runStep(idx) {
        if (!S.running || idx >= S.steps.length) { finish(); return; }
        var st = S.steps[idx];
        S.i = idx;
        var t0 = performance.now();
        var r = { i: idx, k: st.k, p: st.p, tImg: -1, tBd: -1, tLogo: -1, tSettle: -1, sgap: 0, sgapMs: 0 };
        var leftBefore = leftovers();
        location.hash = st.u;
        var settleTimer = null, scrolled = false, scrollT0 = 0, scrollT1 = 0;
        var poll = setInterval(function () {
            var now = performance.now() - t0;
            if (r.tImg < 0 && mainImageReady(st.k)) { r.tImg = Math.round(now); }
            if (r.tBd < 0 && backdropReady()) { r.tBd = Math.round(now); }
            if (r.tLogo < 0 && logoReady(st.k)) { r.tLogo = Math.round(now); }
            if (r.tSettle < 0 && lastMutation && performance.now() - lastMutation > 700 && now > 700) { r.tSettle = Math.round(now); }
            // scroll the library pages like a reader: after 2 s, 6 wheel steps, then back up
            if (st.scroll && !scrolled && now > 2000 && st.d > 6000) {
                scrolled = true; scrollT0 = performance.now();
                var n = 0; var sc = setInterval(function () { window.scrollBy(0, 900); if (++n >= 6) { clearInterval(sc); setTimeout(function () { window.scrollTo(0, 0); scrollT1 = performance.now(); }, 600); } }, 450);
            }
        }, 50);
        setTimeout(function () {
            clearInterval(poll);
            var t1 = performance.now();
            var lt = inWindow(longTasks, t0, t1), gp = inWindow(gaps, t0, t1), rs = inWindow(resources, t0, t1);
            r.lt = lt.length; r.ltMs = Math.round(lt.reduce(function (a, e) { return a + e[1]; }, 0)); r.ltMax = Math.round(lt.reduce(function (a, e) { return Math.max(a, e[1]); }, 0));
            r.gap = gp.length; r.gapMs = Math.round(gp.reduce(function (a, e) { return a + e[1]; }, 0));
            if (scrollT0) { var sg = inWindow(gaps, scrollT0, scrollT1 || t1); r.sgap = sg.length; r.sgapMs = Math.round(sg.reduce(function (a, e) { return a + e[1]; }, 0)); }
            r.req = rs.length; r.kb = Math.round(rs.reduce(function (a, e) { return a + e[1]; }, 0) / 1024);
            r.img = rs.filter(function (e) { return e[2] === 'img' || /\/Images\//.test(e[3]); }).length;
            r.plug = rs.filter(function (e) { return PLUGIN_RX.test(e[3]); }).length;
            r.nodes = document.getElementsByTagName('*').length;
            r.left = leftBefore;
            r.heap = performance.memory ? mb(performance.memory.usedJSHeapSize) : -1;
            r.err = inWindow(errors.map(function (t) { return [t]; }), t0, t1).length;
            r.d = Math.round(t1 - t0);
            S.results.push(r);
            try { localStorage.setItem('__stressResults', JSON.stringify({ label: S.label, results: S.results })); } catch (e) { /* quota */ }
            runStep(idx + 1);
        }, st.d);
    }
    function finish() {
        S.running = false; S.done = true;
        try { localStorage.setItem('__stressResults', JSON.stringify({ label: S.label, results: S.results, done: true })); } catch (e) { /* quota */ }
    }
    window.__stressStart = function (playbook, label) {
        S.steps = playbook.steps; S.label = label || ''; S.results = []; S.running = true; S.done = false; S.started = Date.now();
        localStorage.removeItem('__stressResults');
        runStep(0);
    };
    window.__stressStop = function () { S.running = false; };
    window.__stressExport = async function () {
        var json = JSON.stringify({ label: S.label, results: S.results, done: !!S.done });
        var cs = new CompressionStream('gzip');
        var w = cs.writable.getWriter(); w.write(new TextEncoder().encode(json)); w.close();
        var buf = await new Response(cs.readable).arrayBuffer();
        var b = ''; new Uint8Array(buf).forEach(function (x) { b += String.fromCharCode(x); });
        return btoa(b);
    };
})();
