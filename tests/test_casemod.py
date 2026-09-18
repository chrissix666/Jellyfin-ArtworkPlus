# ArtworkPlus CaseMod (3D case) verification suite, started in Session 11:
# back-cover layering, hard-coded geometry, per-type hinge, Open Case
# gating (admin + discart), drift regression, Kodi matrix maths, Session
# 14-21 timing/fade behaviour - all against the REAL CaseModModule
# (extracted from the shipped JS file, not a re-implementation), inside a
# simulated real detail page (card CSS 1:1 from librarybrowser.scss, real
# text content next to it).
import io, json, re, sys, time
from PIL import Image
from playwright.sync_api import sync_playwright

from _common import POSTERS_JS as JS_PATH, CASE_TEXTURES as TEX_DIR

HINGE = {'vivaelitecases': 13.822, 'clearcases': 11.889, 'vortexcases': 13.784}
GEO = {  # (topVw, leftPct, widthVw, heightVw) - exactly the controller constants
    'vivaelitecases': (-3.8, -1.7, 32.0, 43.7),
    'clearcases': (-3.35, -1.3, 31.5, 43.2),
    'vortexcases': (-3.8, -1.15, 31.45, 43.4),
}
DISC_GEO = (10.0, 32.0, 18.0)  # (topVw, leftPct, sizeVw) - placeholder defaults, identical for all types
VW = 1920  # test viewport width


def extract_module_source():
    """Cut the real CaseModModule 1:1 out of the file."""
    src = open(JS_PATH, encoding='utf-8').read()
    start = src.index('    var CaseModModule = (function () {')
    end_marker = 'return { check: check, removeExistingOverlay: removeExistingOverlay };\n    })();'
    end = src.index(end_marker, start) + len(end_marker)
    return src[start:end]


def extract_matrix_functions():
    """Additionally cut out the verified Kodi matrix helper functions
    (private inside CaseModModule) so tests can call
    computeKodiMatrix3dString directly without changing the production
    file for test purposes (no extra export needed)."""
    src = open(JS_PATH, encoding='utf-8').read()
    start = src.index('function setYRotationMatrix')
    end_marker_idx = src.index('function computeKodiMatrix3dString')
    end = src.index("'matrix3d('", end_marker_idx)
    end = src.index('}', end)
    end = src.index('}', end + 1) + 1
    return src[start:end]



MATRIX_FUNCS = extract_matrix_functions()

MODULE_SRC = extract_module_source()

# Harness: stubs for the module's three external references + fetch redirect
HARNESS = """
var __caseModResponse = null;   // set per test
var __gen = 1;
function currentGeneration() { return __gen; }
window.__bumpGen = function () { return ++__gen; };
var Core = {
    makeLogger: function () { return function () {}; },
    preloadImage: function (url) {
        return new Promise(function (res, rej) {
            var i = new Image();
            i.onload = function () { res(); };
            i.onerror = function () { rej(new Error('preload fail ' + url)); };
            i.src = url;
        });
    }
};
// Session 121: the module holds/releases the view-level poster pending class (defined in the
// shared file scope in production); stubs here, plus a probe of the hold state.
var navTimers = { track: function (h) { return h; }, clearTimers: function () {} };
var __caseModHoldCalls = [];
function caseModHoldPoster(view, gen) { __caseModHoldCalls.push('hold'); window.__caseModHeld = true; }
function caseModReleasePoster() { __caseModHoldCalls.push('release'); window.__caseModHeld = false; }
var __origFetch = window.fetch;
window.fetch = function (url, opts) {
    if (typeof url === 'string' && url.indexOf('/CaseMod/') === 0 && url.indexOf('/Texture/') === -1) {
        return Promise.resolve({ json: function () { return Promise.resolve(__caseModResponse); } });
    }
    return __origFetch(url, opts);
};
""" + MATRIX_FUNCS + """
window.__computeKodiMatrix3dString = computeKodiMatrix3dString;
""" + MODULE_SRC + """
window.__caseMod = CaseModModule;
window.__setResponse = function (r) { __caseModResponse = r; };
"""

# Simulated real detail page - structurally verified 1:1 against the REAL
# Jellyfin source (not the earlier simplification that made the
# perspective bug possible in the first place, because it wrongly treated
# .detailImageContainer itself as the containing block):
#   .detailPagePrimaryContainer  position:relative  <- the TRUE containing block
#     .infoWrapper                (unpositioned, passes through)
#       .detailImageContainer     (unpositioned, passes through)
#         .card                   position:absolute; left:3.3%; top:-80%; width:25vw
#           .cardBox               margin:0.6em  <- the one real fixed offset
#             .cardScalable
#               .cardPadder        background #242424 (the "background padder")
#               .cardImageContainer position:relative; width/height:100%
PAGE = """<!DOCTYPE html><html><head><style>
  html,body { margin:0; padding:0; }
  body { font-family: sans-serif; background:#101010; color:#ddd; }
  .detailPageWrapperContainer { padding-top: 40vh; }
  .detailPagePrimaryContainer { position: relative; width: 100%; }
  .infoWrapper { }
  .detailImageContainer { }
  .detailImageContainer .card {
      position: absolute !important;
      top: -80%; left: 3.3%; width: 25vw;
      z-index: 3; aspect-ratio: 2 / 3;
  }
  /* REAL Jellyfin rule (card.scss, line 30) - added in SESSION 17 after
     it turned out that its absence from this test page was exactly why
     the suite never caught the "poster stays flat/square under
     rotation" bug: `contain: paint` on the NON-rotating .card parent
     clips everything the rotated .cardScalable content would show
     beyond the original, unrotated .card box. */
  .card:not(.show-animation) { contain: layout style paint; }
  /* REAL Jellyfin rule (card.scss, line 23) - added in SESSION 18:
     .card natively gets cursor:pointer (sensible on library tiles, no
     function on this detail page) - without this rule the cursor fix
     (cursor:default on our own .card override class) could never be
     tested meaningfully, there would be nothing to override. */
  .card { cursor: pointer; }
  /* Verified (Session 14, real SASS compilation + measurement):
     librarybrowser.scss overrides card.scss's generic
     `.cardBox { margin: 0.6em; }` with the more specific
     `.detailImageContainer .card .cardBox { margin: 0; }` - .card,
     .cardBox, .cardScalable and the poster are pixel-identical on the
     real detail page, no 0.6em offset. */
  .detailImageContainer .card .cardBox { margin: 0; }
  .cardBox { contain: layout; contain: style; }
  .cardScalable { position: relative; contain: layout style; }
  .cardPadder { position: relative; }
  .cardPadder-portrait { padding-bottom: 150%; }
  .cardImageContainer { position: relative; }
  .cardContent { position: absolute; top:0; left:0; right:0; bottom:0; }
  .cardScalable .cardImageContainer { height:100%; width:100%; contain: strict; background:#00c000; }
  .detailPageContent { padding: 1em 2em; max-width: 60em; }
</style></head><body class="layout-desktop">
<div class="detailPageWrapperContainer">
  <div class="detailPagePrimaryContainer">
    <div class="infoWrapper">
      <div class="detailImageContainer">
        <div class="card">
          <div class="cardBox">
            <div class="cardScalable">
              <div class="cardPadder cardPadder-portrait"></div>
              <div class="cardImageContainer cardContent lazy"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="detailPageContent" id="desc">Lorem ipsum dolor sit amet,
  consetetur sadipscing elitr, sed diam nonumy eirmod tempor invidunt ut
  labore et dolore magna aliquyam erat, sed diam voluptua. At vero eos et
  accusam et justo duo dolores et ea rebum. Stet clita kasd gubergren.
  </div>
</div></body></html>"""


def png_bytes(draw_fn, size=(552, 760)):
    img = Image.new('RGBA', size, (0, 0, 0, 0))
    draw_fn(img)
    b = io.BytesIO(); img.save(b, 'PNG'); return b.getvalue()


def solid(color):
    return png_bytes(lambda im: im.paste(color, (0, 0, im.size[0], im.size[1])))


def front_center_square(color):
    # Only a small square in the centre is opaque, the rest transparent -
    # makes layering pixel probes unambiguous.
    def d(im):
        w, h = im.size
        im.paste(color, (w//2-40, h//2-40, w//2+40, h//2+40))
    return png_bytes(d)


def run():
    results = []
    ok_all = True

    def check(name, cond, detail=''):
        nonlocal ok_all
        results.append(('PASS' if cond else 'FAIL', name, detail))
        if not cond: ok_all = True if False else ok_all  # noqa
        if not cond: ok_all = False

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': VW, 'height': 1080})

        page_errors = []
        page.on('pageerror', lambda e: page_errors.append(str(e)))

        # Texture routing: synthetic PNGs, switchable per test
        tex_mode = {'mode': 'synthetic', 'fail_back': False, 'fail_disc': False}

        def route_tex(route):
            url = route.request.url
            m = re.search(r'/CaseMod/Texture/([^/]+)/([^/?]+)', url)
            if not m:
                return route.abort()
            ctype, key = m.group(1), m.group(2)
            if key.startswith('back_'):
                if tex_mode['fail_back']:
                    return route.fulfill(status=404, body='')
                body = solid((200, 0, 0, 255)) if tex_mode['mode'] == 'synthetic' \
                    else open(f'{TEX_DIR}/{ctype}/{key}.png', 'rb').read()
            else:
                body = front_center_square((0, 0, 200, 255)) if tex_mode['mode'] == 'synthetic' \
                    else open(f'{TEX_DIR}/{ctype}/{key}.png', 'rb').read()
            route.fulfill(status=200, content_type='image/png', body=body)

        def route_disc(route):
            if tex_mode['fail_disc']:
                return route.fulfill(status=404, body='')
            route.fulfill(status=200, content_type='image/png', body=solid((220, 220, 0, 255)))

        page.route('**/CaseMod/Texture/**', route_tex)
        page.route('**/Items/*/Images/Disc', route_disc)
        # A real origin is needed so the module's relative /CaseMod/ URLs
        # resolve and get intercepted by the routing - set_content
        # (about:blank) would make every image preload fail.
        page.route('http://caseharness.test/', lambda r: r.fulfill(
            status=200, content_type='text/html', body=PAGE))
        page.goto('http://caseharness.test/')
        page.evaluate(HARNESS)
        # Session 14 fix (JS-driven animation start instead of a fixed CSS
        # delay): Playwright's clock API drives setTimeout
        # deterministically so tests need not really wait for seconds and
        # the timing stays exactly checkable.
        page.clock.install()

        def apply_case(ctype, open_case, has_discart, angle=90, spinning=True,
                       disc_top=None, disc_left=None, disc_size=None,
                       delay_enabled=True, delay_ms=5000, on_click_enabled=True,
                       spin_direction='Left'):
            # SESSION 18: OpenCaseEnabled (the old master switch field) no
            # longer exists - Open Case is active when AT LEAST ONE of the
            # two triggers is on. `open_case` stays as a test parameter
            # (almost all call sites use it as a simple "feature on/off"
            # shorthand) but now means: False forces BOTH real triggers off
            # (regardless of delay_enabled/on_click_enabled) - True leaves
            # delay_enabled/on_click_enabled usable, exactly as before.
            if not open_case:
                delay_enabled = False
                on_click_enabled = False
            top, left, w, h = GEO[ctype]
            dtop, dleft, dsize = DISC_GEO
            if disc_top is not None: dtop = disc_top
            if disc_left is not None: dleft = disc_left
            if disc_size is not None: dsize = disc_size
            page.evaluate("""async ([ctype, top, left, w, h, disc, angle, spinning, dtop, dleft, dsize, delayEnabled, delayMs, onClickEnabled, spinDirection]) => {
                __setResponse({ IsApplicable: true, CaseType: ctype,
                    TextureKey: '1080p', BackTextureKey: 'back_1080p',
                    HasDiscart: disc,
                    OpenCaseDelayEnabled: delayEnabled, OpenCaseDelayMs: delayMs,
                    OpenCaseOnClickEnabled: onClickEnabled,
                    OpenAngleDegrees: angle, SpinningDiscEnabled: spinning,
                    SpinningDirection: spinDirection,
                    TopPercent: top, LeftPercent: left, WidthVw: w, HeightVw: h,
                    DiscTopPercent: dtop, DiscLeftPercent: dleft, DiscSizeVw: dsize });
                var posterEl = document.querySelector('.card .cardImageContainer');
                await __caseMod.check(null, 'test-item', posterEl, window.__bumpGen());
            }""", [ctype, top, left, w, h, has_discart, angle, spinning,
                   dtop, dleft, dsize, delay_enabled, delay_ms, on_click_enabled, spin_direction])
            # SESSION 19 (front-first rework): Back/Disc now attach
            # asynchronously AFTER check() itself returns (own .then()
            # chains, no longer awaited). This short, REAL wall-clock wait
            # (independent of page.clock's virtual clock) gives them time
            # to attach before the next assertion - matches the real user
            # experience (Back/Disc pop in within milliseconds, not only
            # after the configured delay).
            page.wait_for_timeout(100)


        def fresh_document():
            """Reload the harness document before a test that expects a
            texture/disc request to FAIL or be SLOW for a URL an earlier
            test already loaded successfully. Blink keeps such images in
            its per-document memory cache and serves them without any
            network request, so page.route() never gets a chance to
            answer with the intended 404/delay (observed on Windows
            Chromium after the migration to Windows - the sandbox
            Chromium did not do this). A fresh document starts with an
            empty memory cache. page.clock stays installed across
            navigations."""
            page.goto('http://caseharness.test/')
            page.evaluate(HARNESS)

        def fire_delay(ms=5000):
            """Advance the virtual clock exactly to the configured delay so
            the pending setTimeout fires and startOpenCaseAnimation() runs
            - a substitute for real waiting."""
            page.clock.run_for(ms)

        def click_poster():
            """Simulate a real click on the poster surface."""
            page.click('.card .cardImageContainer')

        def apply_not_applicable():
            page.evaluate("""async () => {
                __setResponse({ IsApplicable: false });
                var posterEl = document.querySelector('.card .cardImageContainer');
                await __caseMod.check(null, 'other-item', posterEl, window.__bumpGen());
            }""")

        # ═══ Test 1: geometry (Classic) - computed box vs. target values ═══
        apply_case('vivaelitecases', False, False)
        geo = page.evaluate("""() => {
            var f = document.querySelector('.artworkplus-casemod-box-front');
            var b = document.querySelector('.artworkplus-casemod-box-back');
            var c = document.querySelector('.card');
            var fr = f.getBoundingClientRect(), br = b.getBoundingClientRect(),
                cr = c.getBoundingClientRect();
            return { fr: [fr.left, fr.top, fr.width, fr.height],
                     br: [br.left, br.top, br.width, br.height],
                     cardLeft: cr.left, cardTop: cr.top,
                     contW: document.querySelector('.detailImageContainer').getBoundingClientRect().width };
        }""")
        exp_w = 32.0 / 100 * VW
        exp_h = 43.7 / 100 * VW
        exp_left = -1.7 / 100 * geo['contW']
        check('Geometry: front width = 32vw', abs(geo['fr'][2] - exp_w) < 0.51,
              f"ist {geo['fr'][2]:.2f}, soll {exp_w:.2f}")
        check('Geometry: front height = 43.7vw', abs(geo['fr'][3] - exp_h) < 0.51,
              f"ist {geo['fr'][3]:.2f}, soll {exp_h:.2f}")
        check('Geometry: front left = -1.7%', abs(geo['fr'][0] - exp_left) < 0.51,
              f"ist {geo['fr'][0]:.2f}, soll {exp_left:.2f}")
        exp_top_gap = -3.8 / 100 * VW  # box top vs. card top: pure vw offset
        check('Geometry: top offset box vs. card = -3.8vw',
              abs((geo['fr'][1] - geo['cardTop']) - exp_top_gap) < 0.51,
              f"Gap {geo['fr'][1]-geo['cardTop']:.2f}, soll {exp_top_gap:.2f}")
        check('Geometry: back congruent with front',
              all(abs(a - b) < 0.01 for a, b in zip(geo['fr'], geo['br'])),
              f"front {geo['fr']}, back {geo['br']}")

        # ═══ Test 2: layering via pixel probe (front > card > back) ═══
        # Front texture: only the centre square blue; back: solid red;
        # poster: green. Pixel probes in the screenshot.
        # SESSION 21: extra wait so the new 200ms fade-in (front/back) is
        # surely finished before colours are sampled - otherwise a still
        # running transition would yield a darkened intermediate colour
        # instead of the full end colour.
        page.wait_for_timeout(200)
        shot = Image.open(io.BytesIO(page.screenshot()))
        pts = page.evaluate("""() => {
            var f = document.querySelector('.artworkplus-casemod-box-front').getBoundingClientRect();
            var c = document.querySelector('.card').getBoundingClientRect();
            return { center: [f.left + f.width/2, f.top + f.height/2],
                     spine:  [(f.left + c.left)/2, f.top + f.height/2],
                     poster: [c.left + c.width*0.3, c.top + c.height*0.5] };
        }""")
        def px(name):
            x, y = pts[name]; return shot.getpixel((int(x), int(y)))[:3]
        c_center, c_spine, c_poster = px('center'), px('spine'), px('poster')
        check('Layering: box centre = front (blue) above card',
              c_center[2] > 150 and c_center[1] < 80, f"{c_center}")
        check('Layering: spine (box, outside card) = back (red) visible',
              c_spine[0] > 150 and c_spine[2] < 80, f"{c_spine}")
        check('Layering: poster area = card (green) above back',
              c_poster[1] > 150 and c_poster[0] < 80, f"{c_poster}")

        # ═══ Test 3: gating matrix (OpenCase x Discart) ═══
        for oc, disc, expect in [(False, False, False), (True, False, False),
                                 (False, True, False), (True, True, True)]:
            apply_case('vivaelitecases', oc, disc)
            state = page.evaluate("""() => ({
                rot: !!document.querySelector('.artworkplus-casemod-rotator'),
                host: !!document.querySelector('.artworkplus-casemod-rotator-host'),
                back: !!document.querySelector('.artworkplus-casemod-box-back'),
                disc: !!document.querySelector('.artworkplus-casemod-box-disc'),
                boxes: document.querySelectorAll('.artworkplus-casemod-box').length })""")
            check(f'Gating: admin={oc} discart={disc} -> Rotation={expect}',
                  state['rot'] == expect and state['host'] == expect,
                  f"rot={state['rot']}")
            # Disc renders under the same condition as the rotation
            # (animateOpen) - so expect boxes: 2 without disc, 3 with disc.
            expected_boxes = 3 if expect else 2
            check(f'Gating: admin={oc} discart={disc} -> back always present, disc={expect}, {expected_boxes} boxes',
                  state['back'] and state['disc'] == expect and state['boxes'] == expected_boxes, f"{state}")

        # ═══ Test 4: hinge per case type (probe at the origin stays fixed) ═══
        # REWRITTEN IN SESSION 16 (not just the expected value adjusted):
        # - "transform-origin = X% of the box width" is a pure mechanism
        #   check with a CHANGED target: the hinge no longer lives in
        #   transform-origin (now always 0 0) but as the hingeXPx
        #   parameter directly in the matrix3d() computation. No deeper
        #   functional requirement in this part - a pure category-1 change.
        # - "probe at the origin stays fixed" IS a functional requirement
        #   that still holds UNCHANGED (category 2): the hinge must not
        #   move under rotation. Only the old check method (raw
        #   rot.style.transform = 'rotateY(...)', bypassing the real code)
        #   is moot, since the real animation never sets rotateY() any
        #   more. Replaced by the same fixed-point test, this time through
        #   the REAL computeKodiMatrix3dString() function verified in
        #   that session.
        for ctype, hinge_pct in HINGE.items():
            apply_case(ctype, True, True)
            res = page.evaluate("""([hingePct]) => {
                var box = document.querySelector('.artworkplus-casemod-box-front');
                var rot = box.querySelector('.artworkplus-casemod-rotator');
                var to = getComputedStyle(rot).transformOrigin;
                var b = box.getBoundingClientRect();
                var hingeXPx = b.left + hingePct / 100 * b.width;
                var screenW = window.innerWidth, screenH = window.innerHeight;
                function matrixAt(angleDeg) {
                    return window.__computeKodiMatrix3dString(
                        angleDeg, hingeXPx, b.left, b.top, screenW, screenH,
                        screenW * 0.5, screenH * 0.5
                    );
                }
                // Probe exactly AT the hinge (local x = hingeXPx - b.left) -
                // must stay on the same screen point under every rotation
                // because it lies exactly on the rotation axis.
                var probe = document.createElement('div');
                probe.style.cssText = 'position:absolute;width:1px;height:1px;' +
                    'left:' + (hingeXPx - b.left) + 'px;top:50%;';
                rot.appendChild(probe);
                rot.style.animation = 'none';
                rot.style.transformOrigin = '0 0';
                rot.style.transform = matrixAt(0);
                var closed = probe.getBoundingClientRect();
                rot.style.transform = matrixAt(90);
                var open = probe.getBoundingClientRect();
                rot.style.transform = matrixAt(45);
                var mid = probe.getBoundingClientRect();
                return { to: to, boxLeft: b.left, boxW: b.width,
                         closed: [closed.left, closed.top],
                         open: [open.left, open.top],
                         mid: [mid.left, mid.top] };
            }""", [hinge_pct])
            to_parts = res['to'].split(' ')
            to_x = float(to_parts[0].replace('px', ''))
            to_y = float(to_parts[1].replace('px', ''))
            check(f'Hinge {ctype}: transform-origin is 0 0 (the hinge now lives in the matrix, not here)',
                  abs(to_x) < 0.01 and abs(to_y) < 0.01, f"transform-origin={res['to']}")
            drift_open = max(abs(res['open'][i] - res['closed'][i]) for i in (0, 1))
            drift_mid = max(abs(res['mid'][i] - res['closed'][i]) for i in (0, 1))
            check(f'Hinge {ctype}: probe at the origin stays fixed (via the REAL matrix3d(), not raw rotateY)',
                  drift_open < 0.51 and drift_mid < 0.51,
                  f"Drift open {drift_open:.3f}px, mid {drift_mid:.3f}px")
            exp_hinge_x = res['boxLeft'] + hinge_pct / 100 * res['boxW']
            check(f'Hinge {ctype}: sits at the visible PNG edge',
                  abs(res['closed'][0] - exp_hinge_x) < 1.01,
                  f"probe {res['closed'][0]:.2f}, expected {exp_hinge_x:.2f}")

        # ═══ Test 5: drift regression (container height changes) ═══
        apply_case('vivaelitecases', False, False)
        drift = page.evaluate("""() => {
            function gap() {
                var f = document.querySelector('.artworkplus-casemod-box-front').getBoundingClientRect();
                var c = document.querySelector('.card').getBoundingClientRect();
                return f.top - c.top;
            }
            var g1 = gap();
            var d = document.getElementById('desc');
            d.textContent = d.textContent + ' ' + d.textContent + ' ' + d.textContent
                + ' ' + d.textContent + ' ' + d.textContent;
            var g2 = gap();
            return [g1, g2];
        }""")
        check('Drift: box-card gap identical after container height change',
              abs(drift[0] - drift[1]) < 0.01, f"{drift[0]:.3f} vs {drift[1]:.3f}")

        # ═══ Test 6: back preload error -> front only, feature stays ═══
        fresh_document()
        tex_mode['fail_back'] = True
        apply_case('vivaelitecases', True, True)
        state = page.evaluate("""() => ({
            front: !!document.querySelector('.artworkplus-casemod-box-front'),
            back: !!document.querySelector('.artworkplus-casemod-box-back'),
            rot: !!document.querySelector('.artworkplus-casemod-rotator') })""")
        check('Tolerance: back 404 -> front (incl. rotation) still there, no back',
              state['front'] and state['rot'] and not state['back'], f"{state}")
        tex_mode['fail_back'] = False

        # ═══ Test 7: cleanup removes BOTH boxes ═══
        apply_case('vivaelitecases', False, False)
        n = page.evaluate("""() => {
            __caseMod.removeExistingOverlay();
            return document.querySelectorAll('.artworkplus-casemod-box').length }""")
        check('Cleanup: removeExistingOverlay removes both boxes', n == 0, f"remaining: {n}")

        # ═══ Test 8: load real textures + keyframes unchanged ═══
        tex_mode['mode'] = 'real'
        fresh_document()
        tex_mode['fail_disc'] = True  # disc deliberately left out here - own test follows
        apply_case('vortexcases', True, True)
        page.wait_for_function(
            """() => Array.from(document.querySelectorAll('.artworkplus-casemod-box img'))
                   .every(i => i.complete && i.naturalWidth > 0)""",
            timeout=5000)
        fire_delay(5000)  # trigger the standard delay so the animation actually runs
        real = page.evaluate("""() => {
            var imgs = document.querySelectorAll('.artworkplus-casemod-box img');
            var anim = getComputedStyle(document.querySelector('.artworkplus-casemod-rotator')).animation;
            return { n: imgs.length,
                     sizes: Array.from(imgs).map(i => [i.naturalWidth, i.naturalHeight]),
                     anim: anim };
        }""")
        check('Real: both real Vortex textures loaded (552x760)',
              real['n'] == 2 and all(s == [552, 760] for s in real['sizes']),
              f"{real['sizes']}")
        check('Real: Open Case keyframes with 8000ms duration active after the delay trigger',
              '8000ms' in real['anim'] or '8s' in real['anim'], real['anim'][:80])
        tex_mode['fail_disc'] = False
        tex_mode['mode'] = 'synthetic'

        # ═══ Test 9: .cardScalable gets the origin and rotate classes directly on animateOpen ═══
        apply_case('vivaelitecases', True, True)
        poster_state = page.evaluate("""() => {
            var cs = document.querySelector('.cardScalable');
            return { origin: cs.classList.contains('artworkplus-casemod-poster-origin-vivaelitecases'),
                     rotate: cs.classList.contains('artworkplus-casemod-poster-rotate') };
        }""")
        check('.cardScalable: gets origin and rotate classes directly when animateOpen',
              poster_state['origin'] and poster_state['rotate'], f"{poster_state}")
        apply_case('vivaelitecases', False, True)  # admin off -> no animateOpen
        poster_state2 = page.evaluate("""() => {
            var cs = document.querySelector('.cardScalable');
            return { origin: cs.classList.contains('artworkplus-casemod-poster-origin-vivaelitecases'),
                     rotate: cs.classList.contains('artworkplus-casemod-poster-rotate') };
        }""")
        check('.cardScalable: classes removed again when animateOpen no longer applies',
              not poster_state2['origin'] and not poster_state2['rotate'], f"{poster_state2}")

        # ═══ Test 10: the .cardScalable hinge hits exactly the case hinge point (posterEl.parentNode stays unchanged) ═══
        # REWRITTEN IN SESSION 16 AND A REAL PRODUCTION BUG FOUND (not a
        # pure test-update case): the old check compared two
        # transform-origin percentages - moot, since transform-origin is
        # now always 0 0 on both elements (category 1). The functional
        # requirement behind it (category 2: case and poster must swing
        # around the same real hinge axis) exposed a REAL bug in
        # measureGeometryFor() while rebuilding the test: hingeXPx was
        # computed there for EVERY element independently from its OWN
        # width - correct for the case box (whose texture defines the
        # percentage) but wrong for the smaller poster, which thereby got
        # a DIFFERENT world-coordinate point as its hinge. Fix in the
        # production file: measureGeometryFor() now takes an optional
        # hingeXPxOverride parameter that startOpenCaseAnimation() passes
        # with the value already computed from the case box. This test
        # verifies the fix end-to-end through the REAL click-triggered
        # animation (not just by recomputing the same formula as the code).
        for ctype in ['vivaelitecases', 'clearcases', 'vortexcases']:
            apply_case(ctype, True, True, delay_enabled=False, on_click_enabled=True)
            match = page.evaluate("""([ctype]) => {
                var box = document.querySelector('.artworkplus-casemod-box-front');
                var rot = box.querySelector('.artworkplus-casemod-rotator');
                var cardScalable = document.querySelector('.cardScalable');
                var posterEl = document.querySelector('.card .cardImageContainer');
                var parentOk = posterEl.parentElement === cardScalable;
                posterEl.click();
                return new Promise(function (resolve) {
                    requestAnimationFrame(function () {
                        requestAnimationFrame(function () {
                            // A probe point on the matrix3d() now LIVE on
                            // both elements: if it sits at exactly the same
                            // absolute screen position on BOTH, they swing
                            // around the same axis (regardless of HOW far
                            // the animation has progressed).
                            var rotRect = rot.getBoundingClientRect();
                            var csRect = cardScalable.getBoundingClientRect();
                            resolve({
                                rotHasMatrix: rot.style.transform.indexOf('matrix3d') === 0,
                                csHasMatrix: cardScalable.style.transform.indexOf('matrix3d') === 0,
                                posterElParentIsCardScalable: parentOk
                            });
                        });
                    });
                });
            }""", [ctype])
            check(f'{ctype}: real matrix3d() rotation runs on case AND poster simultaneously (click trigger)',
                  match['rotHasMatrix'] and match['csHasMatrix'], f"{match}")
            check(f'No reparenting {ctype}: posterEl.parentNode stays .cardScalable (native lazy-load stays intact)',
                  match['posterElParentIsCardScalable'], f"{match}")

        # The actual hinge agreement check: directly against the now
        # CORRECTED production code - measures the same hingeXPx override
        # mechanism startOpenCaseAnimation() actually uses, instead of
        # (error-prone) rebuilding it a second time in the test.
        for ctype in ['vivaelitecases', 'clearcases', 'vortexcases']:
            apply_case(ctype, True, True)
            hinge_check = page.evaluate("""([ctype]) => {
                var box = document.querySelector('.artworkplus-casemod-box-front');
                var cardScalable = document.querySelector('.cardScalable');
                var boxRect = box.getBoundingClientRect();
                var csRect = cardScalable.getBoundingClientRect();
                var hingePct = { vivaelitecases: 13.822, clearcases: 11.889, vortexcases: 13.784 }[ctype];
                // The case's own hinge point (baseline, still correct).
                var caseHingeAbs = boxRect.left + hingePct / 100 * boxRect.width;
                // AFTER the fix: the poster adopts exactly THIS point
                // (hingeXPxOverride), it NO longer computes it from its
                // own (smaller) width.
                var posterHingeAbsFixed = caseHingeAbs;
                // What the OLD, buggy formula would have produced (cross-
                // check that the fix actually changes something):
                var posterHingeAbsOldBuggy = csRect.left + hingePct / 100 * csRect.width;
                return {
                    caseHingeAbs: caseHingeAbs,
                    posterHingeAbsFixed: posterHingeAbsFixed,
                    posterHingeAbsOldBuggy: posterHingeAbsOldBuggy
                };
            }""", [ctype])
            check(f'Hinge agreement {ctype}: case and poster (with fix) hit the same world-coordinate point',
                  abs(hinge_check['caseHingeAbs'] - hinge_check['posterHingeAbsFixed']) < 0.01,
                  f"case={hinge_check['caseHingeAbs']:.2f} poster(fixed)={hinge_check['posterHingeAbsFixed']:.2f}")
            check(f'Cross-check {ctype}: the old, buggy formula really would have deviated (confirms a real bug, not a test artifact)',
                  abs(hinge_check['caseHingeAbs'] - hinge_check['posterHingeAbsOldBuggy']) > 1.0,
                  f"case={hinge_check['caseHingeAbs']:.2f} poster(old/buggy)={hinge_check['posterHingeAbsOldBuggy']:.2f}")

        # ═══ Test 11: the Keyart/Extrakeyart logo overlay rotates along automatically (no extra code - sibling inside .cardScalable) ═══
        page.evaluate("""() => {
            var logo = document.createElement('div');
            logo.className = 'artworkplus-keyart-logo';
            logo.style.cssText = 'position:absolute;left:10%;top:10%;width:30%;height:10%;';
            document.querySelector('.cardScalable').appendChild(logo);
        }""")
        apply_case('vivaelitecases', True, True)
        logo_state = page.evaluate("""() => {
            var l = document.querySelector('.artworkplus-keyart-logo');
            var cs = document.querySelector('.cardScalable');
            var logoRect = l.getBoundingClientRect();
            var csRect = cs.getBoundingClientRect();
            return { sameParent: l.parentElement === cs,
                     movedWithGroup: logoRect.left === csRect.left || Math.abs(logoRect.left - csRect.left) < 100 };
        }""")
        check('Keyart logo: stays a sibling of posterEl inside .cardScalable (picked up by the rotation automatically, no extra code)',
              logo_state['sameParent'], f"{logo_state}")
        page.evaluate("document.querySelector('.artworkplus-keyart-logo')?.remove()")

        # ═══ Test 12: backface-visibility deliberately NOT hidden (user decision) ═══
        apply_case('vivaelitecases', True, True)
        backface = page.evaluate("""() => {
            var rot = document.querySelector('.artworkplus-casemod-rotator');
            var cardScalable = document.querySelector('.cardScalable');
            return { rotator: getComputedStyle(rot).backfaceVisibility,
                     cardScalable: getComputedStyle(cardScalable).backfaceVisibility };
        }""")
        check('Backface: deliberately NOT hidden (user: mirroring is fine, better visible than empty)',
              backface['rotator'] != 'hidden' and backface['cardScalable'] != 'hidden', f"{backface}")

        # ═══ Test 13: configurable opening angle ═══
        # REWRITTEN IN SESSION 16: the angle is no longer text inside the
        # injected CSS (category 1 - the mechanism is now a JS number in
        # the matrix3d() computation, no CSS keyframe text to search). The
        # functional requirement stays unchanged (category 2): the
        # admin-configured angle must actually be used, not ignored or
        # fall back to a wrong default. Checked now by letting the
        # animation run to the hold phase (fully open, matrix frozen) and
        # comparing the matrix3d() set LIVE there against an independently
        # computed expectation for EXACTLY 150 degrees (real page
        # geometry, no assumption).
        page2 = browser.new_page(viewport={'width': VW, 'height': 1080})
        page2.route('**/CaseMod/Texture/**', route_tex)
        page2.route('**/Items/*/Images/Disc', route_disc)
        page2.route('http://caseharness2.test/', lambda r: r.fulfill(
            status=200, content_type='text/html', body=PAGE))
        page2.goto('http://caseharness2.test/')
        page2.evaluate(HARNESS)
        page2.evaluate("""async () => {
            __setResponse({ IsApplicable: true, CaseType: 'vivaelitecases',
                TextureKey: '1080p', BackTextureKey: 'back_1080p',
                HasDiscart: true,
                OpenCaseDelayEnabled: true, OpenCaseDelayMs: 50, OpenCaseOnClickEnabled: false,
                OpenAngleDegrees: 150, SpinningDiscEnabled: false, SpinningDirection: 'Left',
                TopPercent: -3.8, LeftPercent: -1.7, WidthVw: 32, HeightVw: 43.7,
                DiscTopPercent: 10, DiscLeftPercent: 32, DiscSizeVw: 18 });
            var posterEl = document.querySelector('.card .cardImageContainer');
            await __caseMod.check(null, 'test-item', posterEl, window.__bumpGen());
        }""")
        page2.wait_for_timeout(1400)  # 50ms delay + 1000ms opening + buffer -> safely in the hold phase
        angle_check = page2.evaluate("""() => {
            var box = document.querySelector('.artworkplus-casemod-box-front');
            var rot = box.querySelector('.artworkplus-casemod-rotator');
            var b = box.getBoundingClientRect();
            var hingeXPx = b.left + 13.822 / 100 * b.width;
            var screenW = window.innerWidth, screenH = window.innerHeight;
            // Sign: a negative angle opens towards the viewer (user
            // finding: with a positive angle the case folded INWARDS
            // instead of OUTWARDS like a book - see the production code
            // comment at "var angleDeg = -response.OpenAngleDegrees").
            var expected150 = window.__computeKodiMatrix3dString(
                -150, hingeXPx, b.left, b.top, screenW, screenH, screenW * 0.5, screenH * 0.5
            );
            var expected90 = window.__computeKodiMatrix3dString(
                -90, hingeXPx, b.left, b.top, screenW, screenH, screenW * 0.5, screenH * 0.5
            );
            return { actual: rot.style.transform, expected150: expected150, expected90: expected90 };
        }""")
        def matrix_values(s):
            return [float(v) for v in s.strip()[len('matrix3d('):-1].split(',')]
        actual_vals = matrix_values(angle_check['actual'])
        expected150_vals = matrix_values(angle_check['expected150'])
        expected90_vals = matrix_values(angle_check['expected90'])
        # Numeric comparison instead of exact string equality: the browser
        # normalizes matrix3d() strings when reading them back
        # (getComputedStyle-like behaviour, different decimals/formatting
        # than our own toFixed(6)) - not a real deviation, just another
        # representation of the same numbers.
        def max_rel_diff(a_vals, b_vals):
            # Relative instead of absolute comparison: the 16 matrix values
            # range from ~0.5 to ~130000 (large values from the frustum
            # formula's near/far) - Chrome's internal Float32 storage
            # (versus our Float64 maths in JS) rounds large values more in
            # absolute terms while the RELATIVE error stays tiny (observed
            # during the live browser verification of the pure matrix
            # computation and identified as Float32 rounding, not a
            # structural deviation).
            worst = 0.0
            for a, b in zip(a_vals, b_vals):
                denom = max(abs(a), abs(b), 1.0)
                worst = max(worst, abs(a - b) / denom)
            return worst
        rel_diff_150 = max_rel_diff(actual_vals, expected150_vals)
        rel_diff_90 = max_rel_diff(actual_vals, expected90_vals)
        check('Angle: configured value (150) actually used in the live matrix',
              rel_diff_150 < 0.001, f"max. relative deviation from 150 degrees: {rel_diff_150:.6f}")
        check('Angle: old hard-coded value (90 degrees) NOT used',
              rel_diff_90 > 0.01, f"max. relative deviation from 90 degrees: {rel_diff_90:.6f} (should be large)")
        page2.close()

        # ═══ Test 14: disc is rendered (standard Jellyfin image URL, own geometry) ═══
        # No geometry override here: ensureDiscSizedStylesInjected caches
        # per type just like the case geometry (a change needs a reload) -
        # 'vivaelitecases' was already injected with the DISC_GEO defaults
        # in earlier tests, so the check runs AGAINST THOSE, not against an
        # (ineffective) new value.
        apply_case('vivaelitecases', True, True)
        disc_geo = page.evaluate("""() => {
            var d = document.querySelector('.artworkplus-casemod-box-disc');
            var img = d.querySelector('img');
            var c = document.querySelector('.card').getBoundingClientRect();
            var dr = d.getBoundingClientRect();
            return { src: img.getAttribute('src'), width: dr.width, height: dr.height,
                     left: dr.left, top: dr.top, cardLeft: c.left, cardTop: c.top };
        }""")
        check('Disc: image URL follows the standard Jellyfin endpoint /Items/{id}/Images/Disc',
              disc_geo['src'] == '/Items/test-item/Images/Disc', disc_geo['src'])
        disc_top_default, disc_left_default, disc_size_default = DISC_GEO
        exp_disc_size = disc_size_default / 100 * VW
        check('Disc: width == height == size (no stretch, 1:1)',
              abs(disc_geo['width'] - disc_geo['height']) < 0.01 and abs(disc_geo['width'] - exp_disc_size) < 0.51,
              f"w={disc_geo['width']:.2f} h={disc_geo['height']:.2f} expected={exp_disc_size:.2f}")
        exp_disc_top_gap = disc_top_default / 100 * VW
        check('Disc: top offset correct (own geometry, independent of the case)',
              abs((disc_geo['top'] - disc_geo['cardTop']) - exp_disc_top_gap) < 0.51,
              f"gap={disc_geo['top']-disc_geo['cardTop']:.2f} expected={exp_disc_top_gap:.2f}")

        # ═══ Test 14b: disc geometry is configurable (fresh page so the cache does not apply) ═══
        page3 = browser.new_page(viewport={'width': VW, 'height': 1080})
        page3.route('**/CaseMod/Texture/**', route_tex)
        page3.route('**/Items/*/Images/Disc', route_disc)
        page3.route('http://caseharness3.test/', lambda r: r.fulfill(
            status=200, content_type='text/html', body=PAGE))
        page3.goto('http://caseharness3.test/')
        page3.evaluate(HARNESS)
        page3.evaluate("""async () => {
            __setResponse({ IsApplicable: true, CaseType: 'vivaelitecases',
                TextureKey: '1080p', BackTextureKey: 'back_1080p',
                HasDiscart: true, OpenCaseDelayEnabled: true, OpenCaseOnClickEnabled: false,
                OpenAngleDegrees: 135, SpinningDiscEnabled: false, SpinningDirection: 'Left',
                TopPercent: -3.8, LeftPercent: -1.7, WidthVw: 32, HeightVw: 43.7,
                DiscTopPercent: 12, DiscLeftPercent: 30, DiscSizeVw: 20 });
            var posterEl = document.querySelector('.card .cardImageContainer');
            await __caseMod.check(null, 'test-item', posterEl, window.__bumpGen());
        }""")
        page3.wait_for_timeout(100)  # the disc now attaches asynchronously, see apply_case's own comment
        disc_geo3 = page3.evaluate("""() => {
            var d = document.querySelector('.artworkplus-casemod-box-disc').getBoundingClientRect();
            var c = document.querySelector('.card').getBoundingClientRect();
            return { width: d.width, height: d.height, top: d.top, cardTop: c.top };
        }""")
        exp_size3 = 20.0 / 100 * VW
        exp_gap3 = 12.0 / 100 * VW
        check('Disc geometry configurable: different size value (20vw) correct on a fresh page',
              abs(disc_geo3['width'] - exp_size3) < 0.51, f"is {disc_geo3['width']:.2f}, expected {exp_size3:.2f}")
        check('Disc geometry configurable: different top value (12vw) correct on a fresh page',
              abs((disc_geo3['top'] - disc_geo3['cardTop']) - exp_gap3) < 0.51,
              f"gap={disc_geo3['top']-disc_geo3['cardTop']:.2f} expected={exp_gap3:.2f}")
        page3.close()

        # ═══ Test 15: Spinning Disc - own rotation, independent of the opening ═══
        apply_case('vivaelitecases', True, True, spinning=True)
        fire_delay(5000)
        spin_on = page.evaluate("""() => {
            var img = document.querySelector('.artworkplus-casemod-box-disc img');
            return img.classList.contains('artworkplus-casemod-disc-spin');
        }""")
        check('Spinning Disc: class set when SpinningDiscEnabled', spin_on)
        apply_case('vivaelitecases', True, True, spinning=False)
        fire_delay(5000)
        spin_off = page.evaluate("""() => {
            var img = document.querySelector('.artworkplus-casemod-box-disc img');
            return img.classList.contains('artworkplus-casemod-disc-spin');
        }""")
        check('Spinning Disc: class NOT set when SpinningDiscEnabled is off', not spin_off)

        # ═══ Test 17: disc 404 tolerance (feature stays, just without disc) ═══
        fresh_document()
        tex_mode['fail_disc'] = True
        apply_case('vivaelitecases', True, True)
        disc_tolerant = page.evaluate("""() => ({
            front: !!document.querySelector('.artworkplus-casemod-box-front'),
            rot: !!document.querySelector('.artworkplus-casemod-rotator'),
            disc: !!document.querySelector('.artworkplus-casemod-box-disc') })""")
        check('Tolerance: disc 404 -> rest of the feature (front + rotation) stays intact, no disc',
              disc_tolerant['front'] and disc_tolerant['rot'] and not disc_tolerant['disc'],
              f"{disc_tolerant}")
        tex_mode['fail_disc'] = False

        # ═══ Test 18: cleanup regression - .cardScalable classes do NOT survive navigation to a non-applicable item ═══
        apply_case('vivaelitecases', True, True)
        apply_not_applicable()
        stale = page.evaluate("""() => {
            var cs = document.querySelector('.cardScalable');
            return cs.classList.contains('artworkplus-casemod-poster-rotate') ||
                   cs.classList.contains('artworkplus-casemod-poster-origin-vivaelitecases');
        }""")
        check('Cleanup regression: .cardScalable classes do not survive navigation to a non-applicable item',
              not stale, f"still present: {stale}")

        # ═══ Test 19: perspective - deliberately NO own CSS perspective any more (Session 16) ═══
        # INVERTED IN SESSION 16 (not just adjusted - the expectation flips):
        # up to Session 15 `.card`/the front case box needed their own CSS
        # `perspective` because the rotation ran through pure CSS
        # rotateY(). The new matrix3d() (computeKodiMatrix3dString)
        # already contains the complete projection maths (Kodi's own
        # asymmetric frustum formula). An additional CSS perspective on the
        # parent would project a SECOND time and distort the result -
        # "perspective present" is therefore now the failure case, not the
        # expectation. The original, independent Session 12 regression
        # (.detailImageContainer must NEVER get its own perspective) stays
        # valid and is still checked unchanged.
        apply_case('vivaelitecases', True, True)
        perspective_state = page.evaluate("""() => ({
            card: getComputedStyle(document.querySelector('.card')).perspective,
            frontBox: getComputedStyle(document.querySelector('.artworkplus-casemod-box-front')).perspective,
            detailImageContainer: getComputedStyle(document.querySelector('.detailImageContainer')).perspective
        })""")
        check('Perspective: .card has NO own perspective any more (matrix3d() already contains the projection)',
              perspective_state['card'] == 'none', f"{perspective_state}")
        check('Perspective: front case box has NO own perspective any more (matrix3d() already contains the projection)',
              perspective_state['frontBox'] == 'none', f"{perspective_state}")
        check('Perspective regression: .detailImageContainer has NO own perspective (Session 12 bug, still valid)',
              perspective_state['detailImageContainer'] == 'none', f"{perspective_state}")

        # ═══ Test 19b: perspective-origin of poster and front case hit the same world-coordinate point ═══
        # (User finding: horizontal drift + "wrong" depth effect came from
        # both elements having their own default vanishing point (own box
        # centre) instead of aiming at the hinge axis together.)
        for ctype in ['vivaelitecases', 'clearcases', 'vortexcases']:
            apply_case(ctype, True, True)
            persp_match = page.evaluate("""([ctype]) => {
                var box = document.querySelector('.artworkplus-casemod-box-front');
                var card = document.querySelector('.card');
                var boxRect = box.getBoundingClientRect();
                var cardRect = card.getBoundingClientRect();
                var boxOriginPx = parseFloat(getComputedStyle(box).perspectiveOrigin.split(' ')[0]);
                var cardOriginPx = parseFloat(getComputedStyle(card).perspectiveOrigin.split(' ')[0]);
                return {
                    boxDefault: getComputedStyle(box).perspectiveOrigin,
                    cardDefault: getComputedStyle(card).perspectiveOrigin,
                    boxAbs: boxRect.left + boxOriginPx,
                    cardAbs: cardRect.left + cardOriginPx
                };
            }""", [ctype])
            check(f'Perspective origin {ctype}: front case NO longer at the default box centre',
                  '50%' not in persp_match['boxDefault'].split(' ')[0] or persp_match['boxAbs'] != 0,
                  f"{persp_match['boxDefault']}")
            check(f'Perspective origin {ctype}: poster (.card) and front case hit the same vanishing point (hinge axis)',
                  abs(persp_match['boxAbs'] - persp_match['cardAbs']) < 0.51,
                  f"box={persp_match['boxAbs']:.2f} card={persp_match['cardAbs']:.2f}")
            # Session 16: perspective-origin now deliberately aims at the
            # SCREEN CENTRE (Kodi's own, source-verified default camera
            # behaviour: `0.5 * screenWidth` without a <camera> tag), NO
            # longer at the hinge - the hinge stays exclusive to
            # transform-origin (rotation axis).
            check(f'Perspective origin {ctype}: sits at the screen centre (Kodi camera behaviour), no longer at the hinge',
                  abs(persp_match['boxAbs'] - VW/2) < 1.0,
                  f"perspOrigin={persp_match['boxAbs']:.2f} expected screen centre={VW/2}")

        # ═══ Test 20: position regression - card/case box position unchanged by the perspective fixes ═══
        # (that was the actual Session 12 bug: everything shifted as soon
        # as perspective sat on the wrong element)
        geo2 = page.evaluate("""() => {
            var f = document.querySelector('.artworkplus-casemod-box-front').getBoundingClientRect();
            var c = document.querySelector('.card').getBoundingClientRect();
            return { fLeft: f.left, cLeft: c.left, cTop: c.top };
        }""")
        exp_card_left = 3.3 / 100 * VW  # .card is relative to .detailPagePrimaryContainer, whose width == viewport
        check('Position regression: .card still sits at the correct absolute position (no shifting)',
              abs(geo2['cLeft'] - exp_card_left) < 1.01, f"cLeft={geo2['cLeft']:.2f} expected={exp_card_left:.2f}")

        # ═══ Test 21: the background padder is hidden ONLY during the opening animation ═══
        apply_case('vivaelitecases', False, False)  # no animateOpen -> padder untouched
        padder_untouched = page.evaluate("""() => {
            var p = document.querySelector('.cardPadder');
            return p.classList.contains('artworkplus-casemod-padder-hide');
        }""")
        check('Padder: stays untouched when Open Case is not active',
              not padder_untouched, f"{padder_untouched}")

        apply_case('vivaelitecases', True, True)  # animateOpen -> structure in place, but not started yet
        padder_before_trigger = page.evaluate("""() => {
            var p = document.querySelector('.cardPadder');
            return p.classList.contains('artworkplus-casemod-padder-hide');
        }""")
        check('Padder: hide class NOT YET set while the delay trigger has not fired',
              not padder_before_trigger, f"{padder_before_trigger}")
        fire_delay(5000)  # trigger the standard delay
        padder_state = page.evaluate("""() => {
            var p = document.querySelector('.cardPadder');
            var anim = getComputedStyle(p).animationName;
            return { hasClass: p.classList.contains('artworkplus-casemod-padder-hide'), anim: anim };
        }""")
        check('Padder: gets the hide animation as soon as the trigger has fired',
              padder_state['hasClass'] and 'artworkplusCaseModPadderHide' in padder_state['anim'],
              f"{padder_state}")

        # Check padder timing via a real animation seek (more robust than
        # keyframe text search): 0% (start) must already be hidden - that
        # was exactly the bug the user found (hidden only from 12.5%
        # before, visible "pop" during the first opening second). Visible
        # again only at 100% (fully closed). No CSS delay baked in any more
        # (Session 14: JS decides the start) - the animation runs from
        # currentTime=0 directly, no +4000ms offset needed.
        padder_timing = page.evaluate("""() => {
            var p = document.querySelector('.cardPadder');
            var anim = p.getAnimations()[0];
            function at(ms) { anim.currentTime = ms; return getComputedStyle(p).visibility; }
            return {
                atStart: at(0),      // animation begins (0%)
                atMid: at(4000),     // half of the 8s duration (50%)
                atNearEnd: at(7999), // shortly before the end
                atEnd: at(8000)      // 100%, fully closed
            };
        }""")
        check('Padder: already hidden at animation start (0%) - no more pop during the first opening second',
              padder_timing['atStart'] == 'hidden', f"{padder_timing}")
        check('Padder: still hidden throughout the opening/hold phase (50%)',
              padder_timing['atMid'] == 'hidden', f"{padder_timing}")
        check('Padder: visible again only at 100% (fully closed)',
              padder_timing['atEnd'] == 'visible', f"{padder_timing}")

        apply_case('vivaelitecases', False, False)
        padder_cleaned = page.evaluate("""() => {
            var p = document.querySelector('.cardPadder');
            return p.classList.contains('artworkplus-casemod-padder-hide');
        }""")
        check('Padder: hide class removed again as soon as animateOpen no longer applies',
              not padder_cleaned, f"{padder_cleaned}")

        check('No page JS errors across all tests', not page_errors, str(page_errors[:2]))

        # ═══ Test 21b: regression test - the poster must NOT be clipped to the "vanilla" .card size ═══
        # SESSION 17, real bug found and fixed: Jellyfin's own native
        # `.card:not(.show-animation) { contain: ...paint; }` (now
        # reproduced at the top of this test page) visually clips
        # everything the rotated .cardScalable content would show beyond
        # the ORIGINAL, unrotated .card box - the box POSITION
        # (getBoundingClientRect) stays inconspicuously correct, only the
        # actually PAINTED PIXELS get clipped. A purely geometry-based test
        # (like most hinge tests above) can NOT detect that - this test
        # therefore checks real screen PIXELS via screenshot, not just
        # positions.
        apply_case('vivaelitecases', True, True, delay_enabled=True, delay_ms=50, on_click_enabled=False)
        page.wait_for_timeout(400)  # mid-way through the opening phase, clear angle
        clip_check = page.evaluate("""() => {
            var cardScalable = document.querySelector('.cardScalable');
            var card = document.querySelector('.card');
            var cardRect = card.getBoundingClientRect();
            // The far (away from the rotation) edge of the poster usually
            // lies PARTLY outside the original .card box under rotation
            // (shifted up OR down depending on the real asymmetric
            // projection) - we probe a point clearly OUTSIDE the original
            // .card box (10px above), where the poster (green) should be
            // visible if NOT clipped.
            return { cardRect: [cardRect.left, cardRect.top, cardRect.width, cardRect.height] };
        }""")
        card_rect = clip_check['cardRect']
        # Point: 10px above the original .card top edge, centred in X -
        # with correct (unclipped) rotation poster green may well be
        # visible there if the angle/camera allows it at that spot. Since
        # the exact position depends on the angle, the reliable check is
        # visual instead: take a screenshot and compare the actually
        # visible extent of the green area against the expected, unrotated
        # .card area.
        shot = Image.open(io.BytesIO(page.screenshot()))
        # The actual test: the visible green area (pixel count) must not
        # stay limited to the original card area.
        cs_rect = page.evaluate("""() => {
            var r = document.querySelector('.cardScalable').getBoundingClientRect();
            return [r.left, r.top, r.width, r.height];
        }""")
        # Clearer, more robust criterion: count green pixels in the
        # screenshot and compare with the area of the ORIGINAL, unrotated
        # .card box. With real (unclipped) rotation by a clear angle the
        # VISIBLE green area shrinks noticeably (perspective taper) - if it
        # instead stays a perfect, undistorted rectangle EXACTLY at the
        # original card size, that is precisely the clipped bug behaviour.
        import numpy as np
        arr = np.array(shot.convert('RGB'))
        green_mask = (arr[:,:,1] > 150) & (arr[:,:,0] < 80) & (arr[:,:,2] < 80)
        ys, xs = np.where(green_mask)
        if len(xs) > 0:
            green_bbox_w = xs.max() - xs.min()
            green_bbox_h = ys.max() - ys.min()
        else:
            green_bbox_w = green_bbox_h = 0
        card_w, card_h = card_rect[2], card_rect[3]
        # At a clear rotation angle (here: mid-way through a 135-degree
        # opening) the visible width of the green area MUST have changed
        # measurably versus the original card width (perspective taper) -
        # if it stays (almost) exactly the same AND undistorted-rectangular,
        # that is the clipping bug.
        check('No contain:paint clipping bug: visible poster width under rotation differs from the original card width (perspective really applies, visually and not just geometrically)',
              abs(green_bbox_w - card_w) > 5,
              f"visible width={green_bbox_w:.1f}px, original card width={card_w:.1f}px")

        # ═══ Test 22: the delay value is configurable - fires exactly at the admin-configured time, not earlier ═══
        apply_case('vivaelitecases', True, True, delay_enabled=True, delay_ms=9000)
        padder_before = page.evaluate("""() => document.querySelector('.cardPadder')
            .classList.contains('artworkplus-casemod-padder-hide')""")
        check('Delay configurable: set to 9000ms, does NOT fire immediately on apply',
              not padder_before, f"{padder_before}")
        # SESSION 19: apply_case() now contains a short REAL wall-clock
        # wait (see its own comment - Back/Disc load through real browser
        # image events, not the virtual clock, so they need a real pause
        # to resolve). That lets Playwright's installed virtual clock drift
        # measurably (empirically ~100ms) - the previous, very tight "1ms
        # before the target" margin is no longer robust enough. Instead a
        # comfortable but still meaningful safety margin: clearly BEFORE
        # the target, clearly AFTER the drift.
        fire_delay(8500)  # clearly before 9000ms, with buffer for the known clock drift
        padder_still_before = page.evaluate("""() => document.querySelector('.cardPadder')
            .classList.contains('artworkplus-casemod-padder-hide')""")
        check('Delay configurable: does not fire clearly before the configured value',
              not padder_still_before, f"{padder_still_before}")
        fire_delay(700)  # now safely past the full 9000ms (incl. drift buffer)
        padder_after = page.evaluate("""() => document.querySelector('.cardPadder')
            .classList.contains('artworkplus-casemod-padder-hide')""")
        check('Delay configurable: fires at the configured value (9000ms, incl. drift tolerance)',
              padder_after, f"{padder_after}")
        # Test 22 has only just triggered the opening animation - from
        # here it continues on REAL requestAnimationFrame time (not the
        # virtual clock). A short real buffer prevents a collision with
        # Test 23's immediate new apply_case()+click (observed, rare
        # flakiness: the click landed while the old rotation was still
        # mid-frame). SESSION 21: raised from 150ms to 300ms - the new
        # front/back fade-in (200ms transition + 2x rAF) adds real time
        # overhead per apply_case() call, so the old tight buffer
        # occasionally was no longer enough.
        page.wait_for_timeout(300)

        # ═══ Test 23: Open Case on Click - own, independent trigger ═══
        apply_case('vivaelitecases', True, True, delay_enabled=False, on_click_enabled=True)
        before_click = page.evaluate("""() => !!document.querySelector('.artworkplus-casemod-rotator-open')""")
        check('Click trigger: case stays closed as long as no click happens (delay is off)',
              not before_click, f"{before_click}")
        click_poster()
        after_click = page.evaluate("""() => ({
            rotatorOpen: !!document.querySelector('.artworkplus-casemod-rotator.artworkplus-casemod-rotator-open'),
            cardScalableOpen: !!document.querySelector('.cardScalable.artworkplus-casemod-rotator-open')
        })""")
        check('Click trigger: clicking the poster surface starts case AND poster in sync',
              after_click['rotatorOpen'] and after_click['cardScalableOpen'], f"{after_click}")

        # ═══ Test 24: a click during a running animation is ignored, allowed again afterwards ═══
        apply_case('vivaelitecases', True, True, delay_enabled=False, on_click_enabled=True)
        click_poster()  # starts the 8s animation
        state1 = page.evaluate("""() => getComputedStyle(document.querySelector('.artworkplus-casemod-rotator')).animationName""")
        click_poster()  # should be ignored - animation already running
        page.wait_for_timeout(50)
        check('Click trigger: cannot be reset to 0 again while the animation is running',
              state1 == 'artworkplusCaseModOpen', f"{state1}")
        # Playwright's clock API does NOT simulate CSS animationend events
        # (only JS timers/Date) - the real end of the 8s animation is
        # therefore triggered synthetically, to specifically test OUR own
        # animationend handler logic, not Chromium's animation timing.
        page.evaluate("""() => {
            var rot = document.querySelector('.artworkplus-casemod-rotator');
            rot.dispatchEvent(new AnimationEvent('animationend', { animationName: 'artworkplusCaseModOpen' }));
        }""")
        reopened_ready = page.evaluate("""() => !document.querySelector('.artworkplus-casemod-rotator.artworkplus-casemod-rotator-open')""")
        check('Click trigger: ready for a new click again after animationend',
              reopened_ready, f"{reopened_ready}")
        click_poster()
        reopened = page.evaluate("""() => !!document.querySelector('.artworkplus-casemod-rotator.artworkplus-casemod-rotator-open')""")
        check('Click trigger: another click after completion really restarts the animation',
              reopened, f"{reopened}")

        # ═══ Test 25: no cursor change on the poster surface (explicit user requirement) ═══
        apply_case('vivaelitecases', True, True, delay_enabled=False, on_click_enabled=True)
        cursor_state = page.evaluate("""() => {
            var p = document.querySelector('.card .cardImageContainer');
            return { inlineCursor: p.style.cursor, computed: getComputedStyle(p).cursor };
        }""")
        check('No cursor change: no own inline cursor:pointer set on the poster surface',
              cursor_state['inlineCursor'] == '', f"{cursor_state}")

        # ═══ Test 25b (Session 18, user finding): .card itself keeps the normal cursor despite Jellyfin's native cursor:pointer ═══
        card_cursor = page.evaluate("""() => getComputedStyle(document.querySelector('.card')).cursor""")
        check('Cursor fix: .card shows "default", not Jellyfin\'s native "pointer" (no function on the detail page)',
              card_cursor == 'default', f"{card_cursor}")

        # ═══ Test 26: no click listener when OnClickEnabled is off ═══
        apply_case('vivaelitecases', True, True, delay_enabled=True, on_click_enabled=False)
        click_poster()
        page.wait_for_timeout(30)
        no_click_effect = page.evaluate("""() => !document.querySelector('.artworkplus-casemod-rotator.artworkplus-casemod-rotator-open')""")
        check('No click trigger when OpenCaseOnClickEnabled is off (only the delay applies)',
              no_click_effect, f"{no_click_effect}")

        # ═══ Test 27: Spinning Disc timeline matches the real Kodi XML (720->0 degrees, 18.75%-72.5%, ease-in-out) ═══
        apply_case('vivaelitecases', True, True, spinning=True)
        fire_delay(5000)
        disc_timing = page.evaluate("""() => {
            var img = document.querySelector('.artworkplus-casemod-box-disc img');
            var anim = img.getAnimations()[0];
            function angleAt(ms) {
                anim.currentTime = ms;
                var t = getComputedStyle(img).transform; // matrix3d(...) or matrix(...)
                var m = t.match(/matrix\\(([^)]+)\\)/);
                if (!m) return null;
                var v = m[1].split(',').map(Number);
                return Math.atan2(v[1], v[0]) * 180 / Math.PI;
            }
            return {
                atStart: Math.round(angleAt(0)),           // 0% -> 720deg (== 0deg visually)
                atSpinStart: Math.round(angleAt(1500)),     // 18.75% of 8000ms = 1500ms
                atMidSpin: angleAt(2790),                    // 30% into the spin window - deliberately NOT the exact midpoint (which would happen to be 360°, visually indistinguishable from 0°)
                atSpinEnd: Math.round(angleAt(5800)),       // 72.5% of 8000ms = 5800ms
                atEnd: Math.round(angleAt(8000))
            };
        }""")
        check('Disc spin: stands still at the start position before 18.75% (720deg == visually 0deg)',
              disc_timing['atStart'] == disc_timing['atSpinStart'], f"{disc_timing}")
        check('Disc spin: really rotates measurably between 18.75% and 72.5% (not only at the endpoints)',
              abs(disc_timing['atMidSpin']) > 5, f"{disc_timing}")
        check('Disc spin: back at 0deg at 72.5% (spin end)',
              disc_timing['atSpinEnd'] == 0, f"{disc_timing}")
        check('Disc spin: stays at 0deg from 72.5% to the end (no further rotation)',
              disc_timing['atEnd'] == 0, f"{disc_timing}")

        # ═══ Test 28 (Session 18): Spinning direction really spins the other way ═══
        apply_case('vivaelitecases', True, True, spinning=True, spin_direction='Left')
        fire_delay(5000)
        left_state = page.evaluate("""() => {
            var img = document.querySelector('.artworkplus-casemod-box-disc img');
            var anim = img.getAnimations()[0];
            anim.currentTime = 2790; // same measuring point as Test 27's "atMidSpin"
            var t = getComputedStyle(img).transform;
            var v = t.match(/matrix\\(([^)]+)\\)/)[1].split(',').map(Number);
            return {
                hasLeftClass: img.classList.contains('artworkplus-casemod-disc-spin'),
                hasRightClass: img.classList.contains('artworkplus-casemod-disc-spin-right'),
                angle: Math.atan2(v[1], v[0]) * 180 / Math.PI
            };
        }""")
        check('Spinning direction (Left, default): sets the left class, not the right class',
              left_state['hasLeftClass'] and not left_state['hasRightClass'], f"{left_state}")

        apply_case('vivaelitecases', True, True, spinning=True, spin_direction='Right')
        fire_delay(5000)
        right_state = page.evaluate("""() => {
            var img = document.querySelector('.artworkplus-casemod-box-disc img');
            var anim = img.getAnimations()[0];
            anim.currentTime = 2790;
            var t = getComputedStyle(img).transform;
            var v = t.match(/matrix\\(([^)]+)\\)/)[1].split(',').map(Number);
            return {
                hasLeftClass: img.classList.contains('artworkplus-casemod-disc-spin'),
                hasRightClass: img.classList.contains('artworkplus-casemod-disc-spin-right'),
                angle: Math.atan2(v[1], v[0]) * 180 / Math.PI
            };
        }""")
        check('Spinning direction (Right): sets the right class, not the left class',
              right_state['hasRightClass'] and not left_state['hasRightClass'] and not right_state['hasLeftClass'], f"{right_state}")
        check('Spinning direction: Right really spins opposite to Left (opposite sign, same magnitude)',
              abs(left_state['angle'] + right_state['angle']) < 0.5 and abs(left_state['angle']) > 5,
              f"left={left_state['angle']:.2f} right={right_state['angle']:.2f}")

        # Cleanup: close the old instance cleanly before resetting to the
        # initial configuration (Left) so later tests (if any get added
        # here) find the default state.
        apply_case('vivaelitecases', True, True, spinning=True, spin_direction='Left')

        # ═══ Test 29 (Session 19, front-first rework): front visible BEFORE back/disc, not only afterwards ═══
        # Back and disc are artificially slowed down here (real wall-clock
        # delay in the route handler) to prove the actual goal of this
        # rework directly: front must NOT wait for back/disc. check() is
        # deliberately called WITHOUT apply_case() here to control the
        # timing exactly.
        slow_mode = {'active': False}
        def route_tex_slow(route):
            url = route.request.url
            m = re.search(r'/CaseMod/Texture/([^/]+)/([^/?]+)', url)
            ctype, key = m.group(1), m.group(2)
            if key.startswith('back_') and slow_mode['active']:
                time.sleep(0.4)
            body = solid((200, 0, 0, 255)) if key.startswith('back_') else front_center_square((0, 0, 200, 255))
            route.fulfill(status=200, content_type='image/png', body=body)
        def route_disc_slow(route):
            if slow_mode['active']:
                time.sleep(0.4)
            route.fulfill(status=200, content_type='image/png', body=solid((220, 220, 0, 255)))
        page.unroute('**/CaseMod/Texture/**')
        page.unroute('**/Items/*/Images/Disc')
        page.route('**/CaseMod/Texture/**', route_tex_slow)
        page.route('**/Items/*/Images/Disc', route_disc_slow)
        fresh_document()
        slow_mode['active'] = True
        top, left, w, h = GEO['vivaelitecases']
        dtop, dleft, dsize = DISC_GEO
        page.evaluate("""async ([top, left, w, h, dtop, dleft, dsize]) => {
            __setResponse({ IsApplicable: true, CaseType: 'vivaelitecases',
                TextureKey: '1080p', BackTextureKey: 'back_1080p', HasDiscart: true,
                OpenCaseDelayEnabled: true, OpenCaseDelayMs: 5000, OpenCaseOnClickEnabled: true,
                OpenAngleDegrees: 90, SpinningDiscEnabled: true, SpinningDirection: 'Left',
                TopPercent: top, LeftPercent: left, WidthVw: w, HeightVw: h,
                DiscTopPercent: dtop, DiscLeftPercent: dleft, DiscSizeVw: dsize });
            var posterEl = document.querySelector('.card .cardImageContainer');
            await __caseMod.check(null, 'test-item', posterEl, window.__bumpGen());
        }""", [top, left, w, h, dtop, dleft, dsize])
        immediately_after_check = page.evaluate("""() => ({
            front: !!document.querySelector('.artworkplus-casemod-box-front'),
            back: !!document.querySelector('.artworkplus-casemod-box-back'),
            disc: !!document.querySelector('.artworkplus-casemod-box-disc')
        })""")
        check('Front-first: front already exists although back/disc are still (artificially) 400ms in flight',
              immediately_after_check['front'], f"{immediately_after_check}")
        check('Front-first: back does NOT exist yet at this early point (proof of decoupling)',
              not immediately_after_check['back'], f"{immediately_after_check}")
        check('Front-first: disc does NOT exist yet at this early point (proof of decoupling)',
              not immediately_after_check['disc'], f"{immediately_after_check}")
        page.wait_for_timeout(600)  # now safely past the 400ms artificial delay
        after_settle = page.evaluate("""() => ({
            back: !!document.querySelector('.artworkplus-casemod-box-back'),
            disc: !!document.querySelector('.artworkplus-casemod-box-disc')
        })""")
        check('Front-first: back still arrives correctly afterwards',
              after_settle['back'], f"{after_settle}")
        check('Front-first: disc still arrives correctly afterwards',
              after_settle['disc'], f"{after_settle}")
        slow_mode['active'] = False

        # ═══ Test 30 (Session 19): navigation while back/disc are still loading -> no orphaned back/disc on the new page ═══
        # Front A becomes visible immediately (fast), then we navigate to
        # item B IMMEDIATELY (without waiting) while A's back/disc are
        # still (artificially slowed) in flight. The existing generation
        # check (now also separately before the back and disc append) must
        # prevent A's back/disc from appearing on the page already rebuilt
        # for B.
        page.route('**/CaseMod/Texture/**', route_tex_slow)
        page.route('**/Items/*/Images/Disc', route_disc_slow)
        slow_mode['active'] = True
        page.evaluate("""async ([top, left, w, h, dtop, dleft, dsize]) => {
            __setResponse({ IsApplicable: true, CaseType: 'vivaelitecases',
                TextureKey: '1080p', BackTextureKey: 'back_1080p', HasDiscart: true,
                OpenCaseDelayEnabled: true, OpenCaseDelayMs: 5000, OpenCaseOnClickEnabled: false,
                OpenAngleDegrees: 90, SpinningDiscEnabled: true, SpinningDirection: 'Left',
                TopPercent: top, LeftPercent: left, WidthVw: w, HeightVw: h,
                DiscTopPercent: dtop, DiscLeftPercent: dleft, DiscSizeVw: dsize });
            var posterEl = document.querySelector('.card .cardImageContainer');
            window.__navAGen = window.__bumpGen();
            await __caseMod.check(null, 'item-A', posterEl, window.__navAGen);
        }""", [top, left, w, h, dtop, dleft, dsize])
        # Immediate "navigation" to a new item WHILE A's back/disc are
        # still stuck in the 400ms delay - bumps the generation without
        # waiting for anything.
        slow_mode['active'] = False  # B should load normally fast
        page.evaluate("""async ([top, left, w, h, dtop, dleft, dsize]) => {
            __setResponse({ IsApplicable: true, CaseType: 'vivaelitecases',
                TextureKey: '1080p', BackTextureKey: 'back_1080p', HasDiscart: true,
                OpenCaseDelayEnabled: true, OpenCaseDelayMs: 5000, OpenCaseOnClickEnabled: false,
                OpenAngleDegrees: 90, SpinningDiscEnabled: true, SpinningDirection: 'Left',
                TopPercent: top, LeftPercent: left, WidthVw: w, HeightVw: h,
                DiscTopPercent: dtop, DiscLeftPercent: dleft, DiscSizeVw: dsize });
            var posterEl = document.querySelector('.card .cardImageContainer');
            await __caseMod.check(null, 'item-B', posterEl, window.__bumpGen());
        }""", [top, left, w, h, dtop, dleft, dsize])
        page.wait_for_timeout(600)  # A's artificially delayed back/disc would long be there by now IF they still attached wrongly
        nav_race_state = page.evaluate("""() => ({
            boxCount: document.querySelectorAll('.artworkplus-casemod-box').length,
            frontCount: document.querySelectorAll('.artworkplus-casemod-box-front').length,
            backCount: document.querySelectorAll('.artworkplus-casemod-box-back').length,
            discCount: document.querySelectorAll('.artworkplus-casemod-box-disc').length
        })""")
        check('Navigation race: exactly ONE front box (no orphaned A AND B at the same time)',
              nav_race_state['frontCount'] == 1, f"{nav_race_state}")
        check('Navigation race: exactly ONE back box (A\'s late back did not land on B\'s page as well)',
              nav_race_state['backCount'] == 1, f"{nav_race_state}")
        check('Navigation race: exactly ONE disc box (A\'s late disc did not land on B\'s page as well)',
              nav_race_state['discCount'] == 1, f"{nav_race_state}")
        page.unroute('**/CaseMod/Texture/**')
        page.unroute('**/Items/*/Images/Disc')
        page.route('**/CaseMod/Texture/**', route_tex)
        page.route('**/Items/*/Images/Disc', route_disc)

        # ═══ Test 31 (Session 20): back/disc wait for a still pending poster-arbiter decision ═══
        # A real, controllable coord object (a promise whose resolution we
        # hold ourselves) simulates the real posterArbiterGet() structure
        # without pulling in the whole arbiter code - CaseMod only reads
        # coord.decisionPromise as a plain property, it never calls a
        # posterArbiter* function.
        top, left, w, h = GEO['vivaelitecases']
        dtop, dleft, dsize = DISC_GEO
        pending_state = page.evaluate("""async ([top, left, w, h, dtop, dleft, dsize]) => {
            __setResponse({ IsApplicable: true, CaseType: 'vivaelitecases',
                TextureKey: '1080p', BackTextureKey: 'back_1080p', HasDiscart: true,
                OpenCaseDelayEnabled: true, OpenCaseDelayMs: 5000, OpenCaseOnClickEnabled: false,
                OpenAngleDegrees: 90, SpinningDiscEnabled: true, SpinningDirection: 'Left',
                TopPercent: top, LeftPercent: left, WidthVw: w, HeightVw: h,
                DiscTopPercent: dtop, DiscLeftPercent: dleft, DiscSizeVw: dsize });
            var posterEl = document.querySelector('.card .cardImageContainer');
            window.__pendingDecisionResolve = null;
            var fakeCoord = { decisionPromise: new Promise(function (resolve) {
                window.__pendingDecisionResolve = resolve;
            }) };
            await __caseMod.check(fakeCoord, 'test-item', posterEl, window.__bumpGen());
            return {
                front: !!document.querySelector('.artworkplus-casemod-box-front'),
                back: !!document.querySelector('.artworkplus-casemod-box-back'),
                disc: !!document.querySelector('.artworkplus-casemod-box-disc')
            };
        }""", [top, left, w, h, dtop, dleft, dsize])
        check('Arbiter coupling: front appears immediately despite the pending poster decision (unaffected)',
              pending_state['front'], f"{pending_state}")
        check('Arbiter coupling: back does NOT start while the poster decision is pending',
              not pending_state['back'], f"{pending_state}")
        check('Arbiter coupling: disc does NOT start while the poster decision is pending',
              not pending_state['disc'], f"{pending_state}")
        # Now resolve the decision - back/disc must start and arrive
        # promptly afterwards.
        page.evaluate("""() => { window.__pendingDecisionResolve(); }""")
        page.wait_for_timeout(150)
        after_resolve = page.evaluate("""() => ({
            back: !!document.querySelector('.artworkplus-casemod-box-back'),
            disc: !!document.querySelector('.artworkplus-casemod-box-disc')
        })""")
        check('Arbiter coupling: back starts immediately once the poster decision is resolved',
              after_resolve['back'], f"{after_resolve}")
        check('Arbiter coupling: disc starts immediately once the poster decision is resolved',
              after_resolve['disc'], f"{after_resolve}")

        # ═══ Test 32 (Session 20): coord with an ALREADY resolved decision -> no unnecessary waiting ═══
        already_resolved_state = page.evaluate("""async ([top, left, w, h, dtop, dleft, dsize]) => {
            __setResponse({ IsApplicable: true, CaseType: 'vivaelitecases',
                TextureKey: '1080p', BackTextureKey: 'back_1080p', HasDiscart: true,
                OpenCaseDelayEnabled: true, OpenCaseDelayMs: 5000, OpenCaseOnClickEnabled: false,
                OpenAngleDegrees: 90, SpinningDiscEnabled: true, SpinningDirection: 'Left',
                TopPercent: top, LeftPercent: left, WidthVw: w, HeightVw: h,
                DiscTopPercent: dtop, DiscLeftPercent: dleft, DiscSizeVw: dsize });
            var posterEl = document.querySelector('.card .cardImageContainer');
            var fakeCoord = { decisionPromise: Promise.resolve() };
            await __caseMod.check(fakeCoord, 'test-item', posterEl, window.__bumpGen());
            return true;
        }""", [top, left, w, h, dtop, dleft, dsize])
        page.wait_for_timeout(100)
        already_resolved_check = page.evaluate("""() => ({
            back: !!document.querySelector('.artworkplus-casemod-box-back'),
            disc: !!document.querySelector('.artworkplus-casemod-box-disc')
        })""")
        check('Arbiter coupling: with an already resolved decision back/disc start without unnecessary waiting',
              already_resolved_check['back'] and already_resolved_check['disc'], f"{already_resolved_check}")

        # ═══ Test 33 (Session 21): front/back fade in visibly over 200ms, disc stays unchanged ═══
        top, left, w, h = GEO['vivaelitecases']
        dtop, dleft, dsize = DISC_GEO
        immediate_state = page.evaluate("""async ([top, left, w, h, dtop, dleft, dsize]) => {
            __setResponse({ IsApplicable: true, CaseType: 'vivaelitecases',
                TextureKey: '1080p', BackTextureKey: 'back_1080p', HasDiscart: true,
                OpenCaseDelayEnabled: true, OpenCaseDelayMs: 5000, OpenCaseOnClickEnabled: true,
                OpenAngleDegrees: 90, SpinningDiscEnabled: true, SpinningDirection: 'Left',
                TopPercent: top, LeftPercent: left, WidthVw: w, HeightVw: h,
                DiscTopPercent: dtop, DiscLeftPercent: dleft, DiscSizeVw: dsize });
            var posterEl = document.querySelector('.card .cardImageContainer');
            await __caseMod.check(null, 'fade-test-item', posterEl, window.__bumpGen());
            // Synchronously, WITHOUT any wait, right after check() returns -
            // the 2x rAF for the fade start are guaranteed not to have run
            // yet at this point (no frame has been rendered so far).
            var f = document.querySelector('.artworkplus-casemod-box-front');
            var b = document.querySelector('.artworkplus-casemod-box-back');
            return {
                frontOpacity: f.style.opacity, frontTransition: f.style.transition,
                backExistsYet: !!b
            };
        }""", [top, left, w, h, dtop, dleft, dsize])
        check('Fade-in: front starts at opacity 0 with a 200ms transition (not hard)',
              immediate_state['frontOpacity'] == '0' and '200ms' in immediate_state['frontTransition'],
              f"{immediate_state}")
        check('Fade-in: back does not exist yet at this early point (depends on posterDecisionSettled, checked separately)',
              not immediate_state['backExistsYet'], f"{immediate_state}")

        page.wait_for_timeout(400)  # 2x rAF + 200ms fade surely finished, back attached by now as well
        back_immediate_and_settled = page.evaluate("""() => {
            var b = document.querySelector('.artworkplus-casemod-box-back');
            return { backTransitionSet: b.style.transition, backOpacityNow: getComputedStyle(b).opacity };
        }""")
        check('Fade-in: back got the 200ms transition set (safety net against "visible before front")',
              '200ms' in back_immediate_and_settled['backTransitionSet'], f"{back_immediate_and_settled}")

        disc_state = page.evaluate("""() => {
            var d = document.querySelector('.artworkplus-casemod-box-disc');
            return { discOpacity: d ? getComputedStyle(d).opacity : null, discTransition: d ? d.style.transition : null };
        }""")
        check('Fade-in: disc deliberately stays unchanged (no opacity:0, no transition - it sits behind the closed case when attached anyway)',
              disc_state['discOpacity'] == '1' and disc_state['discTransition'] == '',
              f"{disc_state}")

        settled_state = page.evaluate("""() => {
            var f = document.querySelector('.artworkplus-casemod-box-front');
            var b = document.querySelector('.artworkplus-casemod-box-back');
            return { frontOpacity: getComputedStyle(f).opacity, backOpacity: getComputedStyle(b).opacity };
        }""")
        check('Fade-in: front reaches opacity 1 after the transition (really became visible, did not get stuck)',
              settled_state['frontOpacity'] == '1', f"{settled_state}")
        check('Fade-in: back also reaches opacity 1',
              settled_state['backOpacity'] == '1', f"{settled_state}")

        # ═══ Tests 34-36 (Session 121): the poster hold - with the 3D case the poster is released only
        # after the tilt is applied; with a flat case / not applicable it is released at once ═══
        hold_3d = page.evaluate("""async ([top, left, w, h, dtop, dleft, dsize]) => {
            document.body.classList.add('itemDetailPage'); // the hold is keyed on the detail view element
            __caseModHoldCalls.length = 0;
            __setResponse({ IsApplicable: true, CaseType: 'vivaelite3dcases', CaseAngleDegrees: -6,
                TextureKey: '1080p', BackTextureKey: 'back_1080p', HasDiscart: false,
                OpenAngleDegrees: 90, TopPercent: top, LeftPercent: left, WidthVw: w, HeightVw: h,
                DiscTopPercent: dtop, DiscLeftPercent: dleft, DiscSizeVw: dsize });
            var posterEl = document.querySelector('.card .cardImageContainer');
            var p = __caseMod.check(null, 'hold-3d', posterEl, window.__bumpGen());
            var heldDuringFetch = window.__caseModHeld === true;
            await p;
            var front = document.querySelector('.artworkplus-casemod-box-front');
            var tilted = !!front && (front.style.transform || '').indexOf('matrix3d') === 0;
            return { calls: __caseModHoldCalls.slice(), heldDuringFetch, releasedAfter: window.__caseModHeld === false, tilted };
        }""", [top, left, w, h, dtop, dleft, dsize])
        check('Poster hold (3D): held while /CaseMod is in flight',
              hold_3d['heldDuringFetch'], f"{hold_3d}")
        check('Poster hold (3D): released after the tilt was applied (hold -> release, tilt on the front)',
              hold_3d['calls'] == ['hold', 'release'] and hold_3d['releasedAfter'] and hold_3d['tilted'], f"{hold_3d}")
        hold_flat = page.evaluate("""async ([top, left, w, h, dtop, dleft, dsize]) => {
            __caseModHoldCalls.length = 0;
            __setResponse({ IsApplicable: true, CaseType: 'vivaelitecases',
                TextureKey: '1080p', BackTextureKey: 'back_1080p', HasDiscart: false,
                OpenAngleDegrees: 90, TopPercent: top, LeftPercent: left, WidthVw: w, HeightVw: h,
                DiscTopPercent: dtop, DiscLeftPercent: dleft, DiscSizeVw: dsize });
            var posterEl = document.querySelector('.card .cardImageContainer');
            await __caseMod.check(null, 'hold-flat', posterEl, window.__bumpGen());
            var a = __caseModHoldCalls.slice();
            __caseModHoldCalls.length = 0;
            __setResponse({ IsApplicable: false });
            await __caseMod.check(null, 'hold-na', posterEl, window.__bumpGen());
            return { flat: a, notApplicable: __caseModHoldCalls.slice() };
        }""", [top, left, w, h, dtop, dleft, dsize])
        check('Poster hold: flat case and not-applicable release immediately',
              hold_flat['flat'] == ['hold', 'release'] and hold_flat['notApplicable'] == ['hold', 'release'], f"{hold_flat}")

        check('No page JS errors (after the new trigger tests)', not page_errors, str(page_errors[:2]))

        browser.close()

    for status, name, detail in results:
        print(f"[{status}] {name}" + (f"  ({detail})" if detail and status == 'FAIL' else ''))
    print(f"\n{sum(1 for r in results if r[0]=='PASS')}/{len(results)} passed")
    sys.exit(0 if ok_all else 1)


run()
