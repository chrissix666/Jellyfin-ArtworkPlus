"""Every backdrop category must put a REAL image on the page.

Bug class (Session 116): the four library-view IIFEs in Backdrops-v1.js
(Genre/Studio/Tag/Favorites) created their <img>, preloaded the URL, appended
the element - and never assigned img.src. The server logged "100 images", the
client logged "shown", the page stayed black. Nothing in the suite looked at
the rendered element. This test does: for each category it stubs the plugin
endpoints and Jellyfin's ApiClient, navigates to the page the IIFE detects,
fires `viewshow` and asserts that the category's own container holds an image
element whose source resolves to a stub image and that becomes visible.

    python tests/test_backdrops_render.py
"""
import base64
import re
import sys
from playwright.sync_api import sync_playwright
from _common import ROOT, CORE_JS

import os
BACKDROPS_JS = os.path.join(ROOT, 'Jellyfin-ArtworkPlus-Backdrops-v1.js')
ORIGIN = "http://artworkplus.test"
# 2x2 opaque PNG - a real, decodable image for every stubbed image URL
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVQI12P4z8DwHwAFAAH/"
    "pO8hGgAAAABJRU5ErkJggg==")

APICLIENT_STUB = """
window.ApiClient = {
  getCurrentUserId: () => 'u1',
  serverId: () => 's1',
  serverAddress: () => location.origin,
  getUrl: (p) => location.origin + '/' + p,
  getScaledImageUrl: (id, o) => location.origin + '/Items/' + id + '/Images/' + (o.type||'Backdrop') + '/' + (o.index||0) + '?tag=' + (o.tag||''),
  getImageUrl: (id, o) => location.origin + '/Items/' + id + '/Images/' + (o.type||'Backdrop') + '/' + (o.index||0),
  getJSON: async (u) => { const r = await fetch(u, { headers: { Authorization: 'MediaBrowser Token="x"' } }); return r.json(); },
  getItem: async () => ({ Id: 'i1', Type: 'Movie', BackdropImageTags: ['t1','t2'], ImageTags: {} }),
  getAuthorizationHeader: () => 'MediaBrowser Token="x"',
  accessToken: () => 'x',
};
"""

POOL = {"Enabled": True, "SortMode": "Shuffle", "CycleTimeMs": 5000, "KenBurnsEnabled": False,
        "KenBurnsZoomMs": 1000, "KenBurnsPanMs": 500,
        "Images": [{"SourceId": "aaaa", "Tag": "t1", "Index": 0}, {"SourceId": "bbbb", "Tag": "t2", "Index": 0}]}

DV = {"Enabled": True, "CycleTimeMs": 5000, "OrderMode": "Shuffle", "KenBurnsEnabled": False, "KenBurnsZoomMs": 1000, "KenBurnsPanMs": 500}

CASES = [
    # (name, hash, endpoint substring -> json, container selector)
    # Session 118: Detail View takes the server-resolved list (settings.Images) -
    # Custom listener URLs and per-episode files never reach Jellyfin's DTO.
    ("DetailView", "#/details?id=i1&serverId=s1",
     {"/Backdrops/settings": dict(DV, Images=["/Backdrops/custom-image?itemId=i1&index=0", "/Backdrops/custom-image?itemId=i1&index=1"], ImageSource="Item", EpisodeOrderMode="Shuffle")},
     ".artworkplus-own-backdrop"),
    ("Episode", "#/details?id=e1&serverId=s1",
     {"/Backdrops/settings": dict(DV, Images=["/Backdrops/episode-image?itemId=e1&index=0", "/Backdrops/episode-image?itemId=e1&index=1"], ImageSource="Episode", EpisodeOrderMode="Sequential")},
     ".artworkplus-own-backdrop"),
    ("Genre", "#/list.html?genreId=g1&parentId=p1&serverId=s1", {"/Backdrops/genre-pool": POOL}, ".artworkplus-genre-backdrop"),
    ("Studio", "#/list.html?studioId=st1&parentId=p1&serverId=s1",
     {"/Backdrops/studio-settings": {"Enabled": True, "HasImage": True, "KenBurnsEnabled": False, "KenBurnsZoomMs": 1000, "KenBurnsPanMs": 500}},
     ".artworkplus-studio-backdrop"),
    ("StudioApp", "#/list.html?studioId=st2&parentId=p1&serverId=s1",
     {"/Backdrops/studio-settings": {"Enabled": True, "HasImage": False, "SourceMode": "Appearances", "KenBurnsEnabled": False, "KenBurnsZoomMs": 1000, "KenBurnsPanMs": 500},
      "/Backdrops/studio-pool": POOL},
     ".artworkplus-studio-backdrop"),
    ("Tag", "#/list.html?tag=Horror&parentId=p1&serverId=s1", {"/Backdrops/tag-pool": POOL}, ".artworkplus-tag-backdrop"),
    ("Favorites", "#/list.html?type=Movie&IsFavorite=true&serverId=s1", {"/Backdrops/favorites-pool": POOL}, ".artworkplus-favorites-backdrop"),
    # Session 116: Favorites-People with the Folder source delivers ready-made
    # /PeopleBackdrops/{id}/folder-image URLs in WallpaperUrls (same as Wallpapers.com).
    ("FavPeople", "#/list.html?type=Person&IsFavorite=true&serverId=s1",
     {"/Backdrops/favorites-people-pool": {"Enabled": True, "SourceMode": "Folder", "SortMode": "Sequential", "CycleTimeMs": 5000, "KenBurnsEnabled": False, "KenBurnsZoomMs": 1000, "KenBurnsPanMs": 500,
       "WallpaperUrls": ["/PeopleBackdrops/p1/folder-image?index=0&mode=Single", "/PeopleBackdrops/p2/folder-image?index=0&mode=Single"], "Images": []}},
     ".artworkplus-favorites-backdrop"),
]

PROBE = """
(sel) => {
  const c = document.querySelector(sel);
  if (!c) return { container: false };
  const els = [...c.querySelectorAll('*')];
  const imgs = els.filter(e => e.tagName === 'IMG').map(e => ({ src: e.getAttribute('src') || '', complete: e.complete, nat: e.naturalWidth, op: getComputedStyle(e).opacity }));
  const bgs = els.map(e => e.style.backgroundImage).filter(b => b && b !== 'none');
  const cop = parseFloat(getComputedStyle(c).opacity);
  const bgVisible = els.filter(e => e.style.backgroundImage && e.style.backgroundImage !== 'none').map(e => parseFloat(getComputedStyle(e).opacity) * cop);
  return { container: true, imgs, bgs, bgVisible, rect: [c.offsetWidth, c.offsetHeight] };
}
"""


def main():
    core = open(CORE_JS, encoding="utf-8").read()
    bd = open(BACKDROPS_JS, encoding="utf-8").read()
    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, hsh, stubs, sel in CASES:
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.route(f"{ORIGIN}/**", lambda route, request, stubs=stubs: _serve(route, stubs))
            page.goto(f"{ORIGIN}/web/index.html{hsh}")
            page.add_script_tag(content=APICLIENT_STUB)
            page.add_script_tag(content="window.__apFades=0; document.addEventListener('transitionend', e => { if (e.propertyName==='opacity' && e.target.tagName==='IMG') window.__apFades++; }, true);")
            page.add_script_tag(content=core)
            page.add_script_tag(content=bd)
            page.evaluate("document.dispatchEvent(new CustomEvent('viewshow'))")
            page.wait_for_timeout(2500)
            r = page.evaluate(PROBE, sel)
            ok = (r.get("container") and (
                any(i["src"] and i["nat"] > 0 and float(i["op"]) > 0.5 for i in r.get("imgs", []))
                or any(bgs for bgs in r.get("bgs", []))))
            problems = []
            if not r.get("container"):
                problems.append("own container not created")
            elif not r.get("imgs") and not r.get("bgs"):
                problems.append("no image element at all")
            elif r.get("imgs") and not any(i["src"] for i in r["imgs"]):
                problems.append("img has no src")
            elif not ok:
                problems.append(f"image not decoded/visible: {r}")
            # (b) the shown image must have FADED in (transitionend fired), not popped
            if ok and r.get("imgs"):
                faded = page.evaluate("() => window.__apFades || 0")
                if faded < 1:
                    ok = False
                    problems.append("no opacity transitionend - image popped in hard")
            # (c) backdrops come last: no bulk preload of the pool
            img_requests = [q for q in REQUEST_LOG if "/Images/" in q or "studio-image" in q]
            if len(img_requests) > 3:
                ok = False
                problems.append(f"{len(img_requests)} image requests on entry - pool bulk-preloaded")
            fails += 0 if ok else 1
            print(("ok  " if ok else "FAIL"), f"{name:9s}", "" if ok else "; ".join(problems))
            # (a) rapid switch to a second page of the same category must never end empty
            if not name.startswith("Studio") and name not in ("FavPeople", "DetailView", "Episode") and hsh.count("=") > 1:
                # Recorded live (Session 116): leave the category page (clear
                # arms a 1.2 s fallback fade), come back to another page of
                # the same category before it fires; the new page's first
                # image was appended and then wiped by the old fade 17 ms
                # later. Reproduce exactly that: away -> back within 300 ms.
                page.evaluate("() => { location.hash = '#/home.html'; document.dispatchEvent(new CustomEvent('viewshow')); }")
                page.wait_for_timeout(300)
                page.evaluate("(h) => { location.hash = h; document.dispatchEvent(new CustomEvent('viewshow')); }", hsh.replace("g1", "g3").replace("Horror", "Comedy").replace("type=Movie", "type=Episode"))
                page.wait_for_timeout(3000)
                r2 = page.evaluate(PROBE, sel)
                vis2 = r2.get("container") and (any(i["src"] and i["nat"] > 0 and float(i["op"]) > 0.5 for i in r2.get("imgs", []))
                                                or any(o > 0.5 for o in r2.get("bgVisible", [])))
                fails += 0 if vis2 else 1
                print(("ok  " if vis2 else "FAIL"), f"{name:9s}", "rapid switch" if vis2 else f"rapid switch left the page black: {r2}")
            REQUEST_LOG.clear()
            page.close()
        browser.close()
    print("RESULT", "FAILED" if fails else "OK", f"({fails} failure(s))")
    sys.exit(1 if fails else 0)


REQUEST_LOG = []


def _serve(route, stubs):
    url = route.request.url
    path = url[len(ORIGIN):]
    REQUEST_LOG.append(path)
    for key, payload in stubs.items():
        if path.startswith(key):
            import json
            route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
            return
    if "/Images/" in path or "studio-image" in path or "folder-image" in path or "custom-image" in path or "episode-image" in path:
        route.fulfill(status=200, content_type="image/png", body=PNG)
        return
    if path.startswith("/web/index.html"):
        route.fulfill(status=200, content_type="text/html", body="<html><body><div class='backgroundContainer'></div><div class='backdropContainer'></div><div class='page itemDetailPage'></div></body></html>")
        return
    route.fulfill(status=404, body="")


if __name__ == "__main__":
    main()
