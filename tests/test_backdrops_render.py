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
  getJSON: async (u) => ({ Items: [] }),
  getItem: async () => ({ Id: 'i1', Type: 'Movie', BackdropImageTags: ['t1','t2'], ImageTags: {} }),
  getAuthorizationHeader: () => 'MediaBrowser Token="x"',
  accessToken: () => 'x',
};
"""

POOL = {"Enabled": True, "SortMode": "Shuffle", "CycleTimeMs": 5000, "KenBurnsEnabled": False,
        "KenBurnsZoomMs": 1000, "KenBurnsPanMs": 500,
        "Images": [{"SourceId": "aaaa", "Tag": "t1", "Index": 0}, {"SourceId": "bbbb", "Tag": "t2", "Index": 0}]}

CASES = [
    # (name, hash, endpoint substring -> json, container selector)
    ("Genre", "#/list.html?genreId=g1&parentId=p1&serverId=s1", {"/Backdrops/genre-pool": POOL}, ".artworkplus-genre-backdrop"),
    ("Studio", "#/list.html?studioId=st1&parentId=p1&serverId=s1",
     {"/Backdrops/studio-settings": {"Enabled": True, "HasImage": True, "KenBurnsEnabled": False, "KenBurnsZoomMs": 1000, "KenBurnsPanMs": 500}},
     ".artworkplus-studio-backdrop"),
    ("Tag", "#/list.html?tag=Horror&parentId=p1&serverId=s1", {"/Backdrops/tag-pool": POOL}, ".artworkplus-tag-backdrop"),
    ("Favorites", "#/list.html?type=Movie&IsFavorite=true&serverId=s1", {"/Backdrops/favorites-pool": POOL}, ".artworkplus-favorites-backdrop"),
]

PROBE = """
(sel) => {
  const c = document.querySelector(sel);
  if (!c) return { container: false };
  const els = [...c.querySelectorAll('*')];
  const imgs = els.filter(e => e.tagName === 'IMG').map(e => ({ src: e.getAttribute('src') || '', complete: e.complete, nat: e.naturalWidth, op: getComputedStyle(e).opacity }));
  const bgs = els.map(e => e.style.backgroundImage).filter(b => b && b !== 'none');
  return { container: true, imgs, bgs, rect: [c.offsetWidth, c.offsetHeight] };
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
            fails += 0 if ok else 1
            print(("ok  " if ok else "FAIL"), f"{name:9s}", "" if ok else "; ".join(problems))
            page.close()
        browser.close()
    print("RESULT", "FAILED" if fails else "OK", f"({len(CASES) - fails}/{len(CASES)})")
    sys.exit(1 if fails else 0)


def _serve(route, stubs):
    url = route.request.url
    path = url[len(ORIGIN):]
    for key, payload in stubs.items():
        if path.startswith(key):
            import json
            route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
            return
    if "/Images/" in path or "studio-image" in path:
        route.fulfill(status=200, content_type="image/png", body=PNG)
        return
    if path.startswith("/web/index.html"):
        route.fulfill(status=200, content_type="text/html", body="<html><body><div class='backdropContainer'></div><div class='page'></div></body></html>")
        return
    route.fulfill(status=404, body="")


if __name__ == "__main__":
    main()
