"""Backdrops transition matrix (concept Part R): every page-to-page handover
between the six implementations, Jellyfin and nothing must be seamless.

Runs the REAL Core + Backdrops scripts against a threaded stub server that can
delay JSON and image responses (a real slow image is what breaks a handover),
samples every 100 ms and asserts per scenario:

  no_gap      while an owner of ours is claimed for the new page, at no sample
              are ALL our layers below 0.5 (the old one stays until the new
              one is decoded, then crossfade)
  order       the outgoing container reaches 0 only after the incoming layer
              reached >= 0.9
  prompt_out  when nobody of ours is responsible (Home) or the successor is
              empty, the outgoing container is gone within FADE + slack
  class       body.artworkplus-backdrops-override is on exactly while one of
              ours shows (or is claimed), off on Home / empty pages
  final       the expected owner's container shows a decoded, visible layer

    python tests/test_backdrops_transitions.py [--baseline]
"""
import base64
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
from _common import ROOT, CORE_JS

BACKDROPS_JS = os.path.join(ROOT, 'Jellyfin-ArtworkPlus-Backdrops-v1.js')
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVQI12P4z8DwHwAFAAH/"
    "pO8hGgAAAABJRU5ErkJggg==")
FADE = 800

PAGE = """<html><head><style>
.backdropContainer{position:fixed;top:0;left:0;right:0;bottom:0;z-index:-1;contain:layout style size}
.backdropImage{position:absolute;inset:0;background-size:cover}
body.artworkplus-backdrops-override .backdropContainer:not(.artworkplus-own-backdrop){visibility:hidden!important}
</style></head><body class="force-scroll"><div class="backdropContainer"></div><div class="backgroundContainer"></div>
<div class="page itemDetailPage"></div></body></html>"""

APICLIENT = """
window.ApiClient = {
  getCurrentUserId: () => 'u1', serverId: () => 's1', serverAddress: () => location.origin,
  getUrl: (p, q) => location.origin + '/' + p + (q ? '?' + new URLSearchParams(q).toString() : ''),
  getScaledImageUrl: (id, o) => location.origin + '/img?id=' + id + '&i=' + (o.index||0) + '&d=' + (window.__imgDelay||0),
  getJSON: async (u) => (await fetch(u)).json(),
  getItem: async () => ({ Id: 'x', Type: 'Movie', BackdropImageTags: [], ImageTags: {} }),
  getAuthorizationHeader: () => 'x', accessToken: () => 'x'
};
"""


def img(id_, i, d=0):
    return f"/img?id={id_}&i={i}&d={d}"


KB = {"KenBurnsEnabled": False, "KenBurnsZoomMs": 20000, "KenBurnsPanMs": 10000}


class Stub(BaseHTTPRequestHandler):
    img_delay = 0   # ms, set per scenario
    people_delay = 0
    library_enabled = False

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

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        if p == '/web/index.html':
            body = PAGE.encode()
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if p == '/img':
            d = int(q.get('d', 0) or 0)
            if d:
                time.sleep(d / 1000)
            self.send_response(200); self.send_header('Content-Type', 'image/png'); self.send_header('Content-Length', str(len(PNG))); self.end_headers(); self.wfile.write(PNG); return
        if p == '/Backdrops/settings':
            item = q.get('itemId', '')
            d = Stub.img_delay
            if item == 'm0':
                return self._json(dict(KB, Enabled=True, CycleTimeMs=5000, OrderMode='Sequential', Images=[], ImageSource='', EpisodeOrderMode='Shuffle'))
            if item.startswith('m'):
                return self._json(dict(KB, Enabled=True, CycleTimeMs=5000, OrderMode='Sequential', Images=[img(item, 0, d), img(item, 1, d)], ImageSource='Item', EpisodeOrderMode='Shuffle'))
            if item.startswith('p'):
                return self._json(dict(KB, Enabled=True, CycleTimeMs=5000, OrderMode='Sequential', Images=[], ImageSource='', EpisodeOrderMode='Shuffle'))
            return self._json(dict(KB, Enabled=True, CycleTimeMs=5000, OrderMode='Sequential', Images=[], ImageSource='', EpisodeOrderMode='Shuffle'))
        if p in ('/Backdrops/genre-pool', '/Backdrops/tag-pool', '/Backdrops/studio-pool', '/Backdrops/favorites-pool'):
            key = q.get('genreId') or q.get('tag') or q.get('studioId') or q.get('type') or 'x'
            if key.endswith('0'):
                return self._json(dict(KB, Enabled=True, SortMode='Sequential', CycleTimeMs=5000, Images=[]))
            return self._json(dict(KB, Enabled=True, SortMode='Sequential', CycleTimeMs=5000,
                                   Images=[{"SourceId": key + 'a', "Tag": "t", "Index": 0, "Url": img(key, 0, Stub.img_delay)},
                                           {"SourceId": key + 'b', "Tag": "t", "Index": 0, "Url": img(key, 1, Stub.img_delay)}]))
        if p == '/Backdrops/studio-settings':
            sid = q.get('studioId', '')
            return self._json(dict(KB, Enabled=True, HasImage=not sid.endswith('0'), SourceMode='StudioImage'))
        if p == '/Backdrops/studio-image':
            d = Stub.img_delay
            if d:
                time.sleep(d / 1000)
            self.send_response(200); self.send_header('Content-Type', 'image/png'); self.send_header('Content-Length', str(len(PNG))); self.end_headers(); self.wfile.write(PNG); return
        if p == '/Backdrops/favorites-people-pool':
            return self._json(dict(KB, Enabled=True, SourceMode='WallpapersCom', SortMode='Sequential', CycleTimeMs=5000, WallpaperUrls=[img('fp', 0, Stub.img_delay)], Images=[]))
        if p.startswith('/PeopleBackdrops/'):
            pid = p.split('/')[2]
            scope = q.get('scope', 'info')
            if not pid.startswith('p'):
                # a movie/series id: People answers "not applicable" (the real controller does the same)
                lines = [dict(Type='Header', IsApplicable=False, Reason='The requested id does not resolve to a Person item')]
            else:
                lines = [dict(Type='Header', IsApplicable=True, Reason=None, CycleTimeMs=5000, OrderMode='Sequential', SourceMode='WallpapersCom' if pid.startswith('pw') else 'Appearances', **KB)]
            if pid.startswith('p') and not pid.endswith('0'):
                lines += [dict(Type='Image', Url=img(pid, 0, Stub.img_delay)), dict(Type='Image', Url=img(pid, 1, Stub.img_delay))]
            lines.append(dict(Type='Done'))
            body = ('\n'.join(json.dumps(x) for x in lines) + '\n').encode()
            delay = Stub.people_delay if pid.startswith('pw') else 0
            if delay:
                time.sleep(delay / 1000)
            self.send_response(200); self.send_header('Content-Type', 'application/x-ndjson'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if p == '/Backdrops/allowed-indices':
            return self._json([0, 1])
        if p == '/Backdrops/library-pool':
            # Session 130: Library View claims Home/library/search/settings pages; the server
            # decides. Enabled only in the scenarios that switch it on (Stub.library_enabled) and
            # never for a parentId ending in 0 (a folder that is no boxsets library).
            page = q.get('page', '')
            parent = q.get('parentId', '')
            if not Stub.library_enabled or parent.endswith('0'):
                return self._json(dict(KB, Enabled=False, SortMode='Sequential', CycleTimeMs=5000, Images=[]))
            key = 'lib' + page
            return self._json(dict(KB, Enabled=True, SortMode='Sequential', CycleTimeMs=5000,
                                   Images=[{"SourceId": key + 'a', "Tag": "t", "Index": 0, "Url": img(key, 0, Stub.img_delay)},
                                           {"SourceId": key + 'b', "Tag": "t", "Index": 0, "Url": img(key, 1, Stub.img_delay)}]))
        self.send_response(404); self.end_headers()


SAMPLE = """() => {
  const owners = [...document.querySelectorAll('[class*="artworkplus-"][class*="backdrop"]')].filter(e => e.parentElement === document.body);
  const layers = [];
  let maxOp = 0; const per = {};
  for (const c of owners) {
    const cop = parseFloat(getComputedStyle(c).opacity);
    const ls = [...c.querySelectorAll('.backdropImage, img')];
    const name = [...c.classList].find(k => k.startsWith('artworkplus-')) || '?';
    let m = 0;
    for (const l of ls) { const o = parseFloat(getComputedStyle(l).opacity) * cop; const decoded = l.tagName === 'IMG' ? l.naturalWidth > 0 : !!l.style.backgroundImage; if (decoded) m = Math.max(m, o); }
    per[name] = +m.toFixed(2); maxOp = Math.max(maxOp, m);
  }
  const nat = document.querySelector('.backdropContainer:not([class*="artworkplus-"])');
  const dim = document.querySelector('.backgroundContainer'); const withBackdrop = !!dim && dim.classList.contains('withBackdrop');
  return { t: performance.now(), max: withBackdrop ? +maxOp.toFixed(2) : 0, rawMax: +maxOp.toFixed(2), withBackdrop, per, cls: document.body.classList.contains('artworkplus-backdrops-override'), natVis: nat ? getComputedStyle(nat).visibility : 'none', hash: location.hash.slice(2, 30) };
}"""

SCENARIOS = [
    # name, from hash, to hash, img delay ms, expected final owner class (None = nobody), expect class at end
    # 900 ms image = inside the 1200 ms handover window: must crossfade, no gap
    ("Tag -> Movie (slow image)", "#/list.html?tag=Horror&parentId=p1&serverId=s1", "#/details?id=m1&serverId=s1", 900, "artworkplus-own-backdrop", True),
    ("Movie -> Tag (slow image)", "#/details?id=m1&serverId=s1", "#/list.html?tag=Horror&parentId=p1&serverId=s1", 900, "artworkplus-tag-backdrop", True),
    # Session 131: a 4000 ms image is inside the EXTENDED window (claim still pending -> wait up to 6000 ms): crossfade, no gap
    ("Tag -> Movie (4 s image, extended window)", "#/list.html?tag=Horror&parentId=p1&serverId=s1", "#/details?id=m1&serverId=s1", 4000, "artworkplus-own-backdrop", True),
    # 6600 ms image = beyond even the extended window: the outgoing fades at 6000 ms by design (blank accepted), the incoming still arrives
    ("Tag -> Movie (beyond window)", "#/list.html?tag=Horror&parentId=p1&serverId=s1", "#/details?id=m1&serverId=s1", 6600, "artworkplus-own-backdrop", "cap"),
    ("Genre -> Studio image", "#/list.html?genreId=g1&parentId=p1&serverId=s1", "#/list.html?studioId=s1&parentId=p1&serverId=s1", 600, "artworkplus-studio-backdrop", True),
    ("Movie A -> Movie B (same owner)", "#/details?id=m1&serverId=s1", "#/details?id=m2&serverId=s1", 600, "artworkplus-own-backdrop", True),
    ("Tag -> Home (nobody)", "#/list.html?tag=Horror&parentId=p1&serverId=s1", "#/home.html", 0, None, False),
    ("Tag -> Movie without backdrops (empty)", "#/list.html?tag=Horror&parentId=p1&serverId=s1", "#/details?id=m0&serverId=s1", 0, None, False),
    ("Movie -> Person Appearances", "#/details?id=m1&serverId=s1", "#/details?id=pa1&serverId=s1", 600, "artworkplus-people-backdrop", True),
    ("Person Appearances -> Movie", "#/details?id=pa1&serverId=s1", "#/details?id=m1&serverId=s1", 600, "artworkplus-own-backdrop", True),
    ("Movie -> Person Wallpapers (2 s stream)", "#/details?id=m1&serverId=s1", "#/details?id=pw1&serverId=s1", 0, "artworkplus-people-backdrop", True),
    ("Favorites -> Genre", "#/list.html?type=Movie&IsFavorite=true&serverId=s1", "#/list.html?genreId=g1&parentId=p1&serverId=s1", 600, "artworkplus-genre-backdrop", True),
    ("Home stays vanilla", "#/home.html", "#/home.html", 0, None, False),
    # live-found (Session 120): the owner that claimed the new page but got "no images" must fade its OLD content
    ("Movie -> Person (Detail's old image must go)", "#/details?id=m1&serverId=s1", "#/details?id=pa2&serverId=s1", 300, "artworkplus-people-backdrop", "exclusive"),
    ("Person -> Movie (People's old image must go)", "#/details?id=pa2&serverId=s1", "#/details?id=m2&serverId=s1", 300, "artworkplus-own-backdrop", "exclusive"),
    # Session 130: Library View Backdrops (vanilla's random library backdrops, rebuilt). The
    # scenarios above keep the category OFF (server answers Enabled=false -> a claim that ends
    # in `empty`, the page stays vanilla); these switch it on.
    ("LIB Tag -> Home (Library View)", "#/list.html?tag=Horror&parentId=p1&serverId=s1", "#/home.html", 600, "artworkplus-library-backdrop", True),
    ("LIB Home -> Movie (Detail View)", "#/home.html", "#/details?id=m1&serverId=s1", 600, "artworkplus-own-backdrop", True),
    ("LIB Movie -> Movies library", "#/details?id=m1&serverId=s1", "#/movies.html?topParentId=p1&serverId=s1", 600, "artworkplus-library-backdrop", True),
    ("LIB Home -> Favourites tab (same visit)", "#/home.html", "#/home.html?tab=1", 0, "artworkplus-library-backdrop", True),
    ("LIB Home -> Genre list (other owner)", "#/home.html", "#/list.html?genreId=g1&parentId=p1&serverId=s1", 600, "artworkplus-genre-backdrop", True),
    ("LIB Home -> Folders list (nobody)", "#/home.html", "#/list.html?parentId=f0&serverId=s1", 0, None, False),
    ("LIB Home -> Search (Home set)", "#/home.html", "#/search.html", 600, "artworkplus-library-backdrop", True),
    ("LIB Tag -> Home with vanilla-style clearBackdrop", "#/list.html?tag=Horror&parentId=p1&serverId=s1", "#/mypreferencesdisplay.html", 600, "artworkplus-library-backdrop", True),
]


def run(baseline=False):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Stub)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{port}"
    core = open(CORE_JS, encoding='utf-8').read()
    bd = open(BACKDROPS_JS, encoding='utf-8').read()
    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, frm, to, delay, expect_owner, expect_cls in SCENARIOS:
            Stub.img_delay = delay
            Stub.people_delay = 2000 if 'pw' in to else 0
            Stub.library_enabled = name.startswith('LIB ')
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(f"{origin}/web/index.html{frm}")
            page.add_script_tag(content=APICLIENT)
            page.add_script_tag(content=core)
            page.add_script_tag(content=bd)
            page.evaluate("document.dispatchEvent(new CustomEvent('viewshow'))")
            page.wait_for_timeout(2500 + delay)
            before = page.evaluate(SAMPLE)
            from_owner = max(before['per'].items(), key=lambda kv: kv[1])[0] if before['per'] else None
            # navigate like Jellyfin: hash change, viewshow shortly after; Jellyfin's own viewshow handler
            # calls clearBackdrop() on list/person pages, which REMOVES .withBackdrop (theme: the
            # background container is opaque without it) - simulated 120 ms after the hash change
            page.evaluate("(h) => { location.hash = h; setTimeout(() => document.dispatchEvent(new CustomEvent('viewshow')), 60); setTimeout(() => document.querySelector('.backgroundContainer').classList.remove('withBackdrop'), 120); }", to)
            samples = []
            t_end = 4500 + delay + Stub.people_delay + (2500 if delay >= 4000 else 0)
            t0 = time.time()
            while (time.time() - t0) * 1000 < t_end:
                samples.append(page.evaluate(SAMPLE))
                page.wait_for_timeout(100)
            final = samples[-1]
            problems = []
            # final owner visible
            if expect_owner:
                if final['per'].get(expect_owner, 0) < 0.9:
                    problems.append(f"final: {expect_owner} not visible ({final['per']})")
                if expect_cls == "cap":
                    # beyond the handover window: outgoing must be gone by 1200 + FADE (+ slack)
                    t_gone = next((s['t'] for s in samples if from_owner and s['per'].get(from_owner, 1) < 0.05), None)
                    if t_gone is None or (t_gone - samples[0]['t']) > 6000 + FADE + 400:
                        problems.append(f"cap: outgoing not gone by the handover cap (gone at {None if t_gone is None else int(t_gone - samples[0]['t'])})")
                # no gap while a successor of ours exists (not for the wallpapers case: blank accepted)
                if 'pw' not in to and expect_cls != "cap":
                    gap = [s for s in samples if s['max'] < 0.5]
                    if gap:
                        problems.append(f"gap: {len(gap)} samples with all our layers < 0.5 (first at +{int(gap[0]['t'] - samples[0]['t'])} ms)")
                # order: outgoing reaches 0 only after incoming >= 0.9 (different owners only)
                if from_owner and from_owner != expect_owner and 'pw' not in to and expect_cls != "cap":
                    t_in = next((s['t'] for s in samples if s['per'].get(expect_owner, 0) >= 0.9), None)
                    t_out0 = next((s['t'] for s in samples if s['per'].get(from_owner, 1) < 0.05), None)
                    if t_in is not None and t_out0 is not None and t_out0 < t_in - 50:
                        problems.append(f"order: outgoing gone at +{int(t_out0 - samples[0]['t'])} ms before incoming visible at +{int(t_in - samples[0]['t'])} ms")
                if expect_cls == "exclusive":
                    others = {k: v for k, v in final['per'].items() if k != expect_owner and v > 0.05}
                    if others:
                        problems.append(f"exclusive: other owners still visible at the end: {others}")
                if not final['withBackdrop']:
                    problems.append("curtain: .withBackdrop missing although ours is showing")
                # body class at end
                if not final['cls']:
                    problems.append("class: override class off although ours is showing")
            else:
                # nobody / empty: outgoing gone promptly, class off, native visible
                if from_owner:
                    t_gone = next((s['t'] for s in samples if s['per'].get(from_owner, 1) < 0.05), None)
                    limit = FADE + 400 + (1300 if 'm0' in to else 0)
                    if t_gone is None or (t_gone - samples[0]['t']) > limit:
                        problems.append(f"prompt_out: outgoing still there after {limit} ms (gone at {None if t_gone is None else int(t_gone - samples[0]['t'])})")
                if final['cls']:
                    problems.append("class: override class still on although nothing of ours shows")
                if final['natVis'] == 'hidden':
                    problems.append("native container hidden although we show nothing")
            ok = not problems
            fails += 0 if ok else 1
            print(("ok  " if ok else "FAIL"), f"{name:42s}", "" if ok else "; ".join(problems))
            page.close()
        # Session 128: playback transparency contract - while Jellyfin's setBackdropTransparency has
        # made .backgroundContainer transparent, our curtain (.withBackdrop) must be absent even
        # though ours is still showing/claimed; it comes back when playback ends.
        Stub.img_delay = 0
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.goto(f"{origin}/web/index.html#/details?id=m1&serverId=s1")
        page.add_script_tag(content=APICLIENT)
        page.add_script_tag(content=core)
        page.add_script_tag(content=bd)
        page.evaluate("document.dispatchEvent(new CustomEvent('viewshow'))")
        page.wait_for_timeout(2500)
        pb = page.evaluate("""async () => {
            var bg = document.querySelector('.backgroundContainer');
            var out = { before: bg.classList.contains('withBackdrop') };
            // level Full (video OSD): Jellyfin adds the transparency class and removes withBackdrop
            bg.classList.add('backgroundContainer-transparent'); bg.classList.remove('withBackdrop');
            await new Promise(r => setTimeout(r, 100));
            out.fullStaysClear = !bg.classList.contains('withBackdrop');
            // level Backdrop (windowed player): Jellyfin keeps withBackdrop on purpose - we leave it
            bg.classList.add('withBackdrop');
            await new Promise(r => setTimeout(r, 100));
            out.backdropLevelKept = bg.classList.contains('withBackdrop');
            bg.classList.remove('withBackdrop');
            await new Promise(r => setTimeout(r, 100));
            out.fullStaysClearAgain = !bg.classList.contains('withBackdrop');
            // playback ends: transparency gone, our curtain comes back while ours is showing
            bg.classList.remove('backgroundContainer-transparent');
            await new Promise(r => setTimeout(r, 100));
            out.afterPlayback = bg.classList.contains('withBackdrop');
            return out;
        }""")
        ok = pb['before'] and pb['fullStaysClear'] and pb['backdropLevelKept'] and pb['fullStaysClearAgain'] and pb['afterPlayback']
        fails += 0 if ok else 1
        print(("ok  " if ok else "FAIL"), f"{'playback: curtain yields to transparency':42s}", "" if ok else str(pb))
        page.close()
        browser.close()
    server.shutdown()
    print("RESULT", "FAILED" if fails else "OK", f"({fails} failure(s))", "[baseline run]" if baseline else "")
    return fails


if __name__ == "__main__":
    f = run(baseline='--baseline' in sys.argv)
    sys.exit(0 if ('--baseline' in sys.argv or f == 0) else 1)
