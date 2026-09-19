"""Session 122 (step 4): the library tile arbiter in Posters-v1.js against a
faithful replica of Jellyfin's tile pipeline (cardBuilder.js structure +
imageLoader.js lazy loading: 50% margin, preload, rAF fill, fade-in class,
blurhash canvas hidden on animationend, emptied on scroll-out) and a stub
server for the three batch endpoints and their images, with per-scenario
delays and failures.

A rAF recorder inside the page samples every tile every frame: what
background-image is on it, its computed opacity, the overlay layers and the
pending class. The assertions are frame-based: "no frame shows the wrong
image" is measured, not inferred.

Run: python tests/test_library_tiles.py
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

from _common import CORE_JS, POSTERS_JS

PNG = bytes.fromhex(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' '01f15c4890000000d49444154789c63f8cfc0f01f0005000101' '2a5f2b6a0000000049454e44ae426082')

PAGE = r"""<!doctype html><html><head><meta charset="utf-8">
<style>
body{margin:0;background:#101010}
.itemsContainer{display:flex;flex-wrap:wrap;width:1200px}
.card{width:200px;margin:8px}
.cardBox{position:relative}
.cardScalable{position:relative}
.cardPadder{padding-bottom:150%;position:relative}
.blurhash-canvas{position:absolute;inset:0;width:100%;height:100%;background:#345}
.cardImageContainer{position:absolute;inset:0;background-size:cover;background-position:center}
.cardIndicators{position:absolute;top:4px;right:4px;z-index:1}
.cardOverlayContainer{position:absolute;inset:0;opacity:0}
.lazy-image-fadein{opacity:1;animation:fadein .5s}
.lazy-image-fadein-fast{opacity:1;animation:fadein .1s}
.lazy-hidden,.lazy-hidden-children *{opacity:0}
@keyframes fadein{from{opacity:0}to{opacity:1}}
</style></head><body>
<div class="itemsContainer" id="items"></div>
<script>
// --- imageLoader.js replica (10.10.7) ---
function onAnimationEnd(event){var elem=event.target;requestAnimationFrame(function(){var canvas=elem.previousSibling;if(elem.classList.contains('blurhashed')&&canvas&&canvas.tagName==='CANVAS'){canvas.classList.add('lazy-hidden');}var padder=elem.parentNode&&elem.parentNode.querySelector('.cardPadder');if(padder){padder.classList.add('lazy-hidden-children');}});elem.removeEventListener('animationend',onAnimationEnd);}
function fillImageElement(elem,url){var pre=new Image();pre.src=url;elem.classList.add('lazy-hidden');elem.addEventListener('animationend',onAnimationEnd);pre.addEventListener('load',function(){requestAnimationFrame(function(){elem.style.backgroundImage="url('"+url+"')";elem.removeAttribute('data-src');elem.classList.add('lazy-image-fadein');elem.classList.remove('lazy-hidden');});});}
function emptyImageElement(elem){elem.removeEventListener('animationend',onAnimationEnd);var canvas=elem.previousSibling;if(canvas&&canvas.tagName==='CANVAS'){canvas.classList.remove('lazy-hidden');}var padder=elem.parentNode&&elem.parentNode.querySelector('.cardPadder');if(padder){padder.classList.remove('lazy-hidden-children');}var url=elem.style.backgroundImage.slice(4,-1).replace(/"/g,'');elem.style.backgroundImage='none';elem.setAttribute('data-src',url);elem.classList.remove('lazy-image-fadein-fast','lazy-image-fadein');elem.classList.add('lazy-hidden');}
function fillImage(entry){var target=entry.target;var source=target.getAttribute('data-src');if(entry.isIntersecting){if(source){fillImageElement(target,source);}}else if(!source){emptyImageElement(target);}}
var lazyObserver=new IntersectionObserver(function(entries){entries.forEach(fillImage);},{rootMargin:'50%',threshold:0});
function lazyChildren(root){root.querySelectorAll('.lazy').forEach(function(el){lazyObserver.observe(el);});}
// --- cardBuilder.js replica ---
window.buildPage=function(items){var html='';items.forEach(function(it,i){html+='<div data-index="'+i+'" data-id="'+it.id+'" data-type="'+it.type+'" class="card portraitCard card-hoverable card-withuserdata"><div class="cardBox cardBox-bottompadded"><div class="cardScalable"><div class="cardPadder cardPadder-portrait"></div><canvas class="blurhash-canvas" aria-hidden="true"></canvas><a href="#" class="cardImageContainer coveredImage cardContent itemAction lazy blurhashed" data-src="/Items/'+it.id+'/Images/Primary?tag=x"><div class="cardIndicators"></div></a><div class="cardOverlayContainer itemAction"><a href="#" class="cardImageContainer"></a><button class="cardOverlayButton">play</button></div></div></div></div>';});var c=document.getElementById('items');c.innerHTML=html;lazyChildren(c);};
// --- recorder ---
window.__rec=[];
(function rec(){var tiles=[];document.querySelectorAll('.card').forEach(function(c){var ic=c.querySelector('.cardImageContainer');var layers=[];ic.querySelectorAll('.extraposter-lib-layer').forEach(function(l){layers.push({bg:l.style.backgroundImage,op:+getComputedStyle(l).opacity});});var cv=c.querySelector('canvas');tiles.push({id:c.dataset.id,bg:ic.style.backgroundImage,op:+getComputedStyle(ic).opacity,pending:ic.classList.contains('artworkplus-tile-pending'),canvasOp:cv?+getComputedStyle(cv).opacity:-1,layers:layers,src:ic.getAttribute('data-src')||''});});window.__rec.push({t:performance.now(),tiles:tiles});requestAnimationFrame(rec);})();
</script></body></html>"""

APICLIENT = """
window.ApiClient = { getCurrentUserId: function(){return 'u';}, serverAddress: function(){return '';}, getUrl: function(p,q){return '/'+p;}, getJSON: function(){return Promise.resolve({});}, accessToken: function(){return 't';} };
"""


class Scenario:
    def __init__(self, name, items, custom=None, animated=None, extra=None, flags=None,
                 batch_delay=None, img_delay=None, img_fail=None, extra_opts=None, viewport_rows=2, custom_logo=None):
        self.name = name
        self.items = items                     # [(id, type)]
        self.custom = custom or {}             # id -> True
        self.animated = animated or {}
        self.extra = extra or {}               # id -> n images
        self.flags = flags                     # None = no server flags
        self.batch_delay = batch_delay or {}   # 'custom'|'animated'|'extra' -> ms
        self.img_delay = img_delay or {}       # substring of url -> ms
        self.img_fail = img_fail or []         # substrings of urls that 404
        self.extra_opts = extra_opts or {}     # DelayEnabled/DelayMs/CycleTimeMs/FadeTimeMs
        self.viewport_rows = viewport_rows
        self.custom_logo = custom_logo         # dict merged into every applicable Custom answer (LogoEnabled/...)


class Stub(BaseHTTPRequestHandler):
    scenario = None

    def log_message(self, *a):
        pass

    def _json(self, obj, delay=0):
        if delay:
            time.sleep(delay / 1000)
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _png(self):
        sc = Stub.scenario
        for sub, ms in sc.img_delay.items():
            if sub in self.path:
                time.sleep(ms / 1000)
        for sub in sc.img_fail:
            if sub in self.path:
                self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header('Content-Type', 'image/png'); self.send_header('Content-Length', str(len(PNG))); self.end_headers(); self.wfile.write(PNG)

    def do_GET(self):
        sc = Stub.scenario
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        if p == '/web/index.html':
            body = PAGE.encode()
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if p.startswith('/Items/') or '/image' in p:
            return self._png()
        ids = [i for i in q.get('ids', '').split(',') if i]
        if p == '/CustomPoster/batch':
            items = {i: dict({"IsApplicable": True, "ResolvedType": "postercase", "Version": "1", "FileName": "x"}, **(sc.custom_logo or {})) for i in ids if sc.custom.get(i)}
            return self._json({"Items": items}, sc.batch_delay.get('custom', 0))
        if p == '/AnimatedPoster/batch':
            items = {i: {"IsApplicable": True, "ResolvedType": "animatedposter", "Version": "1", "FileName": "x"} for i in ids if sc.animated.get(i)}
            return self._json({"Items": items}, sc.batch_delay.get('animated', 0))
        if p == '/Extraposter/batch':
            items = {}
            for i in ids:
                n = sc.extra.get(i, 0)
                if n:
                    items[i] = dict({"IsMovie": True, "OrderMode": "Sequential", "CycleTimeMs": 600, "FadeTimeMs": 200, "DelayEnabled": False, "DelayMs": 0, "SinglePass": False, "ResolvedType": "extraposter", "SyncEnabled": False,
                                     "Posters": [{"FileName": "e%d.jpg" % k, "Version": "1"} for k in range(n)]}, **sc.extra_opts)
                else:
                    items[i] = {"IsMovie": False, "Posters": []}
            return self._json({"Items": items}, sc.batch_delay.get('extra', 0))
        self.send_response(404); self.end_headers()


def vanilla(bg):
    return '/Items/' in bg


def visible_wrong_frames(rec, tile_id, ok_pred):
    """Frames in which the tile's own image is visible (opacity > 0.01) and not what ok_pred allows."""
    bad = []
    for s in rec:
        for t in s['tiles']:
            if t['id'] != tile_id:
                continue
            if t['op'] > 0.01 and t['bg'] and t['bg'] != 'none' and not ok_pred(t):
                bad.append((round(s['t']), t['bg'][:60], t['op']))
    return bad


def final_tile(rec, tile_id):
    for t in rec[-1]['tiles']:
        if t['id'] == tile_id:
            return t
    return None


def run():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Stub)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{port}"
    core = open(CORE_JS, encoding='utf-8').read()
    posters = open(POSTERS_JS, encoding='utf-8').read()

    ROWS5 = [('t%02d' % i, 'Movie') for i in range(30)]  # 6 per row at 1200px -> 5 rows, ~1100px tall
    scenarios = [
        Scenario('S1 nothing of ours: every tile released fast, vanilla shows', ROWS5),
        Scenario('S2 animated on a below-fold tile: never vanilla', ROWS5, animated={'t20': True}),
        Scenario('S3 animated on a first-screen tile, slow GIF: no vanilla frame', ROWS5, animated={'t01': True}, img_delay={'AnimatedPoster': 400}),
        Scenario('S4 order: extra fast, animated slow batch -> animated is the base under extra', ROWS5, animated={'t02': True}, extra={'t02': 2}, batch_delay={'animated': 300}, extra_opts={"DelayEnabled": True, "DelayMs": 300}),
        Scenario('S5 extra without delay: no frame shows the base before the overlay', ROWS5, animated={'t03': True}, extra={'t03': 2}),
        Scenario('S6 extra with delay: base visible during the delay, overlay after', ROWS5, custom={'t04': True}, extra={'t04': 2}, extra_opts={"DelayEnabled": True, "DelayMs": 600}),
        Scenario('S7 animated image fails -> custom takes the tile', ROWS5, custom={'t05': True}, animated={'t05': True}, img_fail=['AnimatedPoster']),
        Scenario('S8 batch never answers in time -> safety net releases with vanilla', ROWS5, batch_delay={'custom': 5000}),
        Scenario('S9 server flags: only animated expected, custom batch slow is ignored', ROWS5, animated={'t06': True}, flags={"custom": False, "animated": True, "extra": False}, batch_delay={'custom': 4000}),
        Scenario('S10 scroll out and back keeps the animated poster', ROWS5, animated={'t01': True}),
        Scenario('S11 extra layers sit under the hover menu', ROWS5, extra={'t07': 1}),
        Scenario('S12 all three off via flags: no tile is ever pending', ROWS5, flags={"custom": False, "animated": False, "extra": False}),
        Scenario('S13 sync on: a late tile waits for the next tick and then changes together', ROWS5, extra={'t01': 2, 't02': 2}, img_delay={'t02/image/e0': 300}, extra_opts={"SyncEnabled": True, "CycleTimeMs": 800, "FadeTimeMs": 100, "DelayEnabled": True, "DelayMs": 100}),
        Scenario('S14 sync off: a late tile appears as soon as it is ready', ROWS5, extra={'t01': 2, 't02': 2}, img_delay={'t02/image/e0': 300}, extra_opts={"SyncEnabled": False, "CycleTimeMs": 800, "FadeTimeMs": 100, "DelayEnabled": True, "DelayMs": 100}),
        Scenario('S15 keyart logo on the tile (custom winner), none on an animated tile', ROWS5, custom={'t01': True}, animated={'t02': True}, custom_logo={"ResolvedType": "keyart", "LogoEnabled": True, "LogoVerticalPositionPercent": 80, "LogoSizePercent": 50, "HasLogo": True}),
        Scenario('S16 extrakeyart logo appears with the first overlay image', ROWS5, extra={'t01': 2}, extra_opts={"ResolvedType": "extrakeyart", "LogoEnabled": True, "LogoVerticalPositionPercent": 85, "LogoSizePercent": 40, "HasLogo": True}),
    ]

    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for sc in scenarios:
            Stub.scenario = sc
            page = browser.new_page(viewport={"width": 1280, "height": 600})
            page.goto(f"{origin}/web/index.html#/movies.html?topParentId=lib")
            if sc.flags is not None:
                page.evaluate("f => { window.ArtworkPlusLibraryTiles = f; }", sc.flags)
            page.add_script_tag(content=APICLIENT)
            page.add_script_tag(content=core)
            page.add_script_tag(content=posters)
            page.wait_for_timeout(100)
            page.evaluate("items => buildPage(items.map(([id, type]) => ({id, type})))", sc.items)
            page.wait_for_timeout(1500)
            problems = []
            rec = page.evaluate("window.__rec")

            if sc.name.split(' ')[0] == 'S1':
                t = final_tile(rec, 't01')
                if not (t and vanilla(t['bg']) and t['op'] > 0.99 and not t['pending']):
                    problems.append(f"t01 final {t}")
                # released quickly: first frame without pending after the cards exist
                first = next((s['t'] for s in rec if any(x['id'] == 't01' and not x['pending'] for x in s['tiles'])), None)
                t_cards = next((s['t'] for s in rec if s['tiles']), None)
                if first is None or first - t_cards > 400:
                    problems.append(f"release took {first and t_cards and first - t_cards} ms")
            if sc.name.split(' ')[0] == 'S2':
                page.evaluate("document.querySelector('[data-id=t20]').scrollIntoView({block:'center'})")
                page.wait_for_timeout(1200)
                rec = page.evaluate("window.__rec")
                bad = visible_wrong_frames(rec, 't20', lambda t: 'AnimatedPoster' in t['bg'])
                if bad: problems.append(f"vanilla frames on t20: {bad[:3]}")
                t = final_tile(rec, 't20')
                if not (t and 'AnimatedPoster' in t['bg'] and t['op'] > 0.99): problems.append(f"t20 final {t}")
            if sc.name.split(' ')[0] == 'S3':
                bad = visible_wrong_frames(rec, 't01', lambda t: 'AnimatedPoster' in t['bg'])
                if bad: problems.append(f"vanilla frames on t01: {bad[:3]}")
                t = final_tile(rec, 't01')
                if not (t and 'AnimatedPoster' in t['bg'] and t['op'] > 0.99 and not t['pending']): problems.append(f"t01 final {t}")
                # the blurhash stayed visible while pending
                if not any(x['id'] == 't01' and x['pending'] and x['canvasOp'] > 0.99 for s in rec for x in s['tiles']):
                    problems.append("canvas not kept visible while pending")
            if sc.name.split(' ')[0] == 'S4':
                page.wait_for_timeout(800)
                rec = page.evaluate("window.__rec")
                t = final_tile(rec, 't02')
                if not (t and 'AnimatedPoster' in t['bg']): problems.append(f"base is not animated: {t and t['bg'][:60]}")
                if not (t and sum(l['op'] for l in t['layers'] if 'Extraposter' in l['bg']) > 0.95): problems.append(f"no extra overlay: {t and t['layers']}")
            if sc.name.split(' ')[0] == 'S5':
                # a frame counts as wrong when the tile is visible with no fully-opaque overlay layer
                # wrong = the tile is visible and its overlay does not cover it (a crossfade between
                # two layers keeps the sum of their opacities at ~1, so the base never shows through)
                bad = [(round(s['t']), x['bg'][:40], [l['op'] for l in x['layers']]) for s in rec for x in s['tiles']
                       if x['id'] == 't03' and x['op'] > 0.01 and sum(l['op'] for l in x['layers']) < 0.95]
                if bad: problems.append(f"base visible before overlay: {bad[:3]}")
                t = final_tile(rec, 't03')
                if not (t and sum(l['op'] for l in t['layers']) > 0.95): problems.append(f"no overlay at the end: {t}")
            if sc.name.split(' ')[0] == 'S6':
                base_frames = [s for s in rec for x in s['tiles'] if x['id'] == 't04' and x['op'] > 0.99 and 'CustomPoster' in x['bg'] and not any(l['op'] > 0.5 for l in x['layers'])]
                if not base_frames: problems.append("custom base never visible during the delay")
                t = final_tile(rec, 't04')
                if not (t and sum(l['op'] for l in t['layers']) > 0.95): problems.append(f"overlay missing after the delay: {t}")
            if sc.name.split(' ')[0] == 'S7':
                page.wait_for_timeout(600)
                rec = page.evaluate("window.__rec")
                t = final_tile(rec, 't05')
                if not (t and 'CustomPoster' in t['bg'] and t['op'] > 0.99 and not t['pending']): problems.append(f"custom did not take over: {t}")
                bad = visible_wrong_frames(rec, 't05', lambda x: 'CustomPoster' in x['bg'])
                if bad: problems.append(f"wrong frames: {bad[:3]}")
            if sc.name.split(' ')[0] == 'S8':
                page.wait_for_timeout(2400)
                rec = page.evaluate("window.__rec")
                t = final_tile(rec, 't01')
                if not (t and not t['pending'] and vanilla(t['bg']) and t['op'] > 0.99): problems.append(f"safety net failed: {t}")
                t_cards = next((s['t'] for s in rec if s['tiles']), None)
                first = next((s['t'] for s in rec if any(x['id'] == 't01' and not x['pending'] for x in s['tiles'])), None)
                if first is None or first - t_cards > 3400 or first - t_cards < 2800: problems.append(f"safety timing {first - t_cards if first else None}")
            if sc.name.split(' ')[0] == 'S9':
                t = final_tile(rec, 't06')
                if not (t and 'AnimatedPoster' in t['bg'] and t['op'] > 0.99 and not t['pending']): problems.append(f"flags not honoured: {t}")
            if sc.name.split(' ')[0] == 'S10':
                page.evaluate("window.scrollTo(0, 5000)")
                page.wait_for_timeout(500)
                mid = page.evaluate("(()=>{var ic=document.querySelector('[data-id=t01] .cardImageContainer');return {bg:ic.style.backgroundImage, src:ic.getAttribute('data-src')||''};})()")
                if 'AnimatedPoster' not in mid['src'] or mid['bg'] != 'none': problems.append(f"scroll-out state {mid}")
                page.evaluate("window.scrollTo(0, 0)")
                page.wait_for_timeout(1200)
                rec = page.evaluate("window.__rec")
                bad = visible_wrong_frames(rec, 't01', lambda x: 'AnimatedPoster' in x['bg'])
                if bad: problems.append(f"vanilla frames: {bad[:3]}")
                t = final_tile(rec, 't01')
                if not (t and 'AnimatedPoster' in t['bg'] and t['op'] > 0.99): problems.append(f"final {t}")
            if sc.name.split(' ')[0] == 'S11':
                order = page.evaluate("(()=>{var c=document.querySelector('[data-id=t07]');var layer=c.querySelector('.extraposter-lib-layer');var hover=c.querySelector('.cardOverlayContainer');var ind=c.querySelector('.cardIndicators');if(!layer)return 'no layer';return {layerInContainer: layer.parentElement.classList.contains('cardImageContainer'), hoverAfter: !!(layer.compareDocumentPosition(hover) & Node.DOCUMENT_POSITION_FOLLOWING), indicatorsAfter: !!(layer.compareDocumentPosition(ind) & Node.DOCUMENT_POSITION_FOLLOWING), z: getComputedStyle(layer).zIndex};})()")
                if order == 'no layer' or not (order['layerInContainer'] and order['hoverAfter'] and order['indicatorsAfter'] and order['z'] == 'auto'):
                    problems.append(f"stacking {order}")
            if sc.name.split(' ')[0] == 'S12':
                if any(x['pending'] for s in rec for x in s['tiles']): problems.append("a tile was pending although nothing is enabled")
                t = final_tile(rec, 't01')
                if not (t and vanilla(t['bg']) and t['op'] > 0.99): problems.append(f"vanilla broken {t}")

            if sc.name.split(' ')[0] in ('S13', 'S14'):
                page.wait_for_timeout(1400)
                rec = page.evaluate("window.__rec")
                def first_visible(tid):
                    for smp in rec:
                        for x in smp['tiles']:
                            if x['id'] == tid and any(l['op'] > 0.9 for l in x['layers']):
                                return smp['t']
                    return None
                def switch_times(tid):
                    out, prev = [], None
                    for smp in rec:
                        for x in smp['tiles']:
                            if x['id'] != tid: continue
                            vis = [l['bg'] for l in x['layers'] if l['op'] > 0.5]
                            cur = vis[0] if vis else None
                            if cur and cur != prev and prev is not None: out.append(smp['t'])
                            if cur: prev = cur
                    return out
                a, b = first_visible('t01'), first_visible('t02')
                if a is None or b is None:
                    problems.append(f"first appearance missing: {a} {b}")
                elif sc.name.startswith('S13'):
                    if not (700 <= b - a <= 1000): problems.append(f"late tile did not wait for the tick: gap {b - a:.0f} ms (period 800)")
                    sa, sb = switch_times('t01'), switch_times('t02')
                    together = [abs(x - y) for x in sa for y in sb if abs(x - y) < 100]
                    if len(sb) and not together: problems.append(f"changes not together: {sa[:3]} vs {sb[:3]}")
                else:
                    if not (150 <= b - a <= 500): problems.append(f"late tile did not appear when ready: gap {b - a:.0f} ms")
            if sc.name.split(' ')[0] == 'S15':
                page.wait_for_timeout(300)
                info = page.evaluate("(()=>{var q=id=>{var c=document.querySelector('[data-id='+id+']');var l=c.querySelector('.artworkplus-tile-logo');return l?{top:l.style.top,width:l.style.width,src:l.firstChild.getAttribute('src'),inContainer:l.parentElement.classList.contains('cardImageContainer')}:null;};return {t01:q('t01'),t02:q('t02')};})()")
                if not (info['t01'] and info['t01']['top'] == '80%' and info['t01']['width'] == '50%' and '/Items/t01/Images/Logo' in info['t01']['src'] and info['t01']['inContainer']):
                    problems.append(f"keyart logo wrong: {info['t01']}")
                if info['t02'] is not None: problems.append(f"animated tile has a logo: {info['t02']}")
            if sc.name.split(' ')[0] == 'S16':
                page.wait_for_timeout(300)
                info = page.evaluate("(()=>{var c=document.querySelector('[data-id=t01]');var l=c.querySelector('.artworkplus-tile-logo');var layer=c.querySelector('.extraposter-lib-layer');return l?{top:l.style.top,afterLayers:!!(layer.compareDocumentPosition(l)&Node.DOCUMENT_POSITION_FOLLOWING)}:null;})()")
                if not (info and info['top'] == '85%' and info['afterLayers']): problems.append(f"extrakeyart logo wrong: {info}")

            errs = page.evaluate("window.__errors || []")
            status = 'ok  ' if not problems else 'FAIL'
            if problems:
                fails += 1
            print(f"{status} {sc.name}" + (f"  -> {problems}" if problems else ''))
            page.close()
        browser.close()
    server.shutdown()
    print(f"RESULT {'OK' if not fails else 'FAILED'} ({fails} failure(s))")
    return 0 if not fails else 1


if __name__ == '__main__':
    sys.exit(run())
