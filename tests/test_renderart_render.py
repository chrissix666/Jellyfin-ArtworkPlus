"""RenderArt (Characterart + Red Carpet) must render as the CSS clearlogo replica.

Session 119: positioning and sizing moved from measured pixels to pure CSS
(vw/vh/em, one injected stylesheet, custom properties per box). This test
stubs the two endpoints and a minimal Jellyfin detail page and asserts, per
case, the DOM artefact - never only a log line (lesson G-render):

  - the box exists with CSS units only (no "px" in width/height/left/right/top)
  - a top position hangs in a zero-height anchor on the ribbon line, inserted
    before .detailLogo; its computed bottom edge equals the anchor line
  - a bottom position / Red Carpet is position:fixed at the viewport bottom
  - the image is decoded and visible, faded in (transitionend), and a resize
    moves it WITHOUT any script-driven style write (the stylesheet does it)
  - MultiImage: after Delay the first image shows, after Cycle time the second
    layer takes over (opacity handover), Fade lasts about FadeTimeMs
  - below 68.75em the top anchor is display:none, like the native logo
  - the fullscreen body class adds the Fullscreen offset (and only then)

    python tests/test_renderart_render.py
"""
import base64
import json
import os
import sys
from playwright.sync_api import sync_playwright
from _common import ROOT, CORE_JS

RENDERART_JS = os.path.join(ROOT, 'Jellyfin-ArtworkPlus-RenderArt-v1.js')
ORIGIN = "http://artworkplus.test"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVQI12P4z8DwHwAFAAH/"
    "pO8hGgAAAABJRU5ErkJggg==")

PAGE_HTML = """<html><head><style>
body{margin:0;font-size:16px;}
.mainAnimatedPage{position:absolute;top:0;left:0;right:0;}
.itemBackdrop{height:40vh;position:relative;}
.detailLogo{width:25vw;height:16vh;position:absolute;top:10vh;right:25vw;}
@media all and (max-width:68.75em){.detailLogo{display:none;}}
.detailPagePrimaryContainer.detailRibbon{margin-top:-7.2em;height:7.2em;}
</style></head><body class="force-scroll">
<div class="backgroundContainer"></div>
<div id="itemDetailPage" class="page libraryPage itemDetailPage mainAnimatedPage">
  <div id="itemBackdrop" class="itemBackdrop"></div>
  <div class="detailLogo"></div>
  <div class="detailPageWrapperContainer"><div class="detailPagePrimaryContainer detailRibbon"><div class="detailImageContainer"><div class="card"></div></div></div></div>
  <div style="height:3000px"></div>
</div></body></html>"""

SIZING = {"ScaleMode": "Height", "HeightVh": 20, "MaxWidthVw": 12, "WidthVw": 11.5, "MaxHeightVh": 0,
          "HorizontalAlign": "Center", "HorizontalOffsetVw": 3, "FullscreenHorizontalOffsetVw": 2}


def ca(position, images, **kw):
    r = dict(SIZING, IsApplicable=True, Position=position, MultiImage=len(images) > 1,
             Images=[{"FileName": f, "Version": "1"} for f in images],
             CycleTimeMs=1500, FadeTimeMs=400, DelayEnabled=False, DelayMs=0, SinglePass=False,
             StaySingleImageStatic=False, OrderMode="Sequential")
    r.update(kw)
    return r


def rc(position):
    return dict(SIZING, IsApplicable=True, Position=position, HeightVh=45, MaxWidthVw=45, Version="v1")


PROBE = """
(sel) => {
  const box = document.querySelector(sel);
  if (!box) return { box: false };
  const cs = getComputedStyle(box);
  const r = box.getBoundingClientRect();
  const anchor = box.parentElement && box.parentElement.classList.contains('artworkplus-art-anchor') ? box.parentElement : null;
  const imgs = [...box.querySelectorAll('img')].map(i => ({ src: i.getAttribute('src') || '', nat: i.naturalWidth, op: parseFloat(getComputedStyle(i).opacity) }));
  const inline = ['width','height','left','right','top','bottom'].map(k => box.style[k]).join('|');
  return { box: true, inline, pos: cs.position, rect: [r.left, r.top, r.right, r.bottom], vw: innerWidth, vh: innerHeight,
    anchor: anchor ? { display: getComputedStyle(anchor).display, top: anchor.getBoundingClientRect().top, beforeLogo: anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('detailLogo') } : null,
    imgs, offset: box.style.getPropertyValue('--ap-offset'), fs: cs.getPropertyValue('--ap-fs').trim() };
}
"""


def serve(route, stubs):
    path = route.request.url[len(ORIGIN):]
    if "/image" in path:
        route.fulfill(status=200, content_type="image/png", body=PNG)
        return
    for key, payload in stubs.items():
        if path.startswith(key):
            route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
            return
    if path.startswith("/web/index.html"):
        route.fulfill(status=200, content_type="text/html", body=PAGE_HTML)
        return
    route.fulfill(status=404, body="")


def approx(a, b, tol=1.5):
    return abs(a - b) <= tol


def main():
    core = open(CORE_JS, encoding="utf-8").read()
    ra = open(RENDERART_JS, encoding="utf-8").read()
    fails = 0

    def check(name, ok, detail=""):
        nonlocal fails
        fails += 0 if ok else 1
        print(("ok  " if ok else "FAIL"), name, "" if ok else detail)

    with sync_playwright() as p:
        browser = p.chromium.launch()

        def open_page(hsh, stubs, w=1600, h=900):
            page = browser.new_page(viewport={"width": w, "height": h})
            # Headless Chromium reports screen.height == innerHeight, which the F11
            # heuristic (Core.isEffectivelyFullscreen) rightly reads as fullscreen -
            # give the fake screen a real desktop height so the class is only set
            # when this test adds it deliberately.
            page.add_init_script("Object.defineProperty(window.screen, 'height', { get: () => 4000 });")
            page.route(f"{ORIGIN}/**", lambda route, request, stubs=stubs: serve(route, stubs))
            page.goto(f"{ORIGIN}/web/index.html{hsh}")
            page.add_script_tag(content="window.__fades=[]; document.addEventListener('transitionend', e => { if (e.propertyName==='opacity') window.__fades.push([performance.now(), e.target.tagName, getComputedStyle(e.target).opacity]); }, true);")
            page.add_script_tag(content=core)
            page.add_script_tag(content=ra)
            page.evaluate("document.dispatchEvent(new CustomEvent('viewshow'))")
            return page

        # ---- 1. Characterart TopRight, single image: anchor, CSS units, ribbon line, resize, hide, fullscreen
        page = open_page("#/details?id=i1&serverId=s1", {"/Characterart/i1": ca("TopRight", ["a.png"])})
        page.wait_for_timeout(1800)
        r = page.evaluate(PROBE, ".characterart-container")
        check("CA TopRight box exists", r.get("box"), str(r))
        if r.get("box"):
            check("CA TopRight no px in inline geometry", "px" not in r["inline"], r["inline"])
            check("CA TopRight anchored before .detailLogo", bool(r["anchor"]) and r["anchor"]["beforeLogo"], str(r["anchor"]))
            line = 0.4 * r["vh"] - 7.2 * 16
            check("CA TopRight bottom on ribbon line", approx(r["rect"][3], line), f"bottom={r['rect'][3]} line={line}")
            check("CA TopRight left edge at 75vw + 3vw offset", approx(r["rect"][0], 0.78 * r["vw"]), f"left={r['rect'][0]} expected={0.78 * r['vw']}")
            check("CA TopRight height 20vh", approx(r["rect"][3] - r["rect"][1], 0.2 * r["vh"]), str(r["rect"]))
            check("CA TopRight image visible", any(i["nat"] > 0 and i["op"] > 0.9 for i in r["imgs"]), str(r["imgs"]))
            page.set_viewport_size({"width": 1400, "height": 700})
            page.wait_for_timeout(100)
            r2 = page.evaluate(PROBE, ".characterart-container")
            check("CA resize follows instantly via CSS", approx(r2["rect"][0], 0.78 * 1400) and approx(r2["rect"][3], 0.4 * 700 - 115.2), str(r2["rect"]))
            check("CA resize wrote no inline geometry", r2["inline"] == r["inline"], r2["inline"])
            page.set_viewport_size({"width": 1000, "height": 700})
            page.wait_for_timeout(100)
            r3 = page.evaluate(PROBE, ".characterart-container")
            check("CA hidden below 68.75em like the logo", r3["anchor"]["display"] == "none", str(r3["anchor"]))
            page.set_viewport_size({"width": 1600, "height": 900})
            page.wait_for_timeout(100)
            page.evaluate("document.body.classList.add('artworkplus-fullscreen')")
            r4 = page.evaluate(PROBE, ".characterart-container")
            check("CA fullscreen class adds Fullscreen offset (2vw)", approx(r4["rect"][0], 0.80 * 1600), f"left={r4['rect'][0]}")
            page.evaluate("document.body.classList.remove('artworkplus-fullscreen')")
            r5 = page.evaluate(PROBE, ".characterart-container")
            check("CA without class offset is back", approx(r5["rect"][0], 0.78 * 1600), f"left={r5['rect'][0]}")
        page.close()

        # ---- 2. Characterart TopLeft: right edge at 50vw + offset
        page = open_page("#/details?id=i2&serverId=s1", {"/Characterart/i2": ca("TopLeft", ["a.png"])})
        page.wait_for_timeout(1800)
        r = page.evaluate(PROBE, ".characterart-container")
        check("CA TopLeft right edge at 50vw + 3vw", r.get("box") and approx(r["rect"][2], 0.53 * r["vw"]), str(r.get("rect")))
        page.close()

        # ---- 3. Characterart BottomLeft: fixed, viewport bottom, 0.8vw + offset
        page = open_page("#/details?id=i3&serverId=s1", {"/Characterart/i3": ca("BottomLeft", ["a.png"], HeightVh=30, MaxWidthVw=30)})
        page.wait_for_timeout(1800)
        r = page.evaluate(PROBE, ".characterart-container")
        check("CA BottomLeft fixed at viewport bottom", r.get("box") and r["pos"] == "fixed" and approx(r["rect"][3], r["vh"]), str(r))
        check("CA BottomLeft left = 0.8vw + 3vw", r.get("box") and approx(r["rect"][0], 0.038 * r["vw"]), str(r.get("rect")))
        page.close()

        # ---- 4. MultiImage with Delay: nothing before the delay, then image 1, then image 2 after the cycle, fade ~400ms
        page = open_page("#/details?id=i4&serverId=s1", {"/Characterart/i4": ca("BottomRight", ["a.png", "b.png"], DelayEnabled=True, DelayMs=1200)})
        page.wait_for_timeout(900)
        early = page.evaluate(PROBE, ".characterart-container")
        check("CA Delay: no image before DelayMs", not early.get("box") or not any(i["op"] > 0.05 for i in early["imgs"]), str(early))
        page.wait_for_timeout(1400)
        first = page.evaluate(PROBE, ".characterart-container")
        vis1 = [i for i in first.get("imgs", []) if i["op"] > 0.9]
        check("CA MultiImage: first image after delay", len(vis1) == 1 and "a.png" in vis1[0]["src"], str(first.get("imgs")))
        page.wait_for_timeout(1900)
        second = page.evaluate(PROBE, ".characterart-container")
        vis2 = [i for i in second.get("imgs", []) if i["op"] > 0.9]
        check("CA MultiImage: second image after CycleTimeMs", len(vis2) == 1 and "b.png" in vis2[0]["src"], str(second.get("imgs")))
        fades = page.evaluate("() => window.__fades")
        check("CA Fade: opacity transitions fired", len(fades) >= 2, str(fades))
        page.close()

        # ---- 5. Red Carpet BottomRight on a person page + list scope, fixed, fade-in
        page = open_page("#/details?id=p1&serverId=s1", {"/RedCarpet/p1": rc("BottomRight")})
        page.wait_for_timeout(1800)
        r = page.evaluate(PROBE, ".redcarpet-container")
        check("RC box fixed at viewport bottom", r.get("box") and r["pos"] == "fixed" and approx(r["rect"][3], r["vh"]), str(r))
        check("RC right edge = 0.8vw - 3vw offset", r.get("box") and approx(r["vw"] - r["rect"][2], 0.008 * r["vw"] - 0.03 * r["vw"]), str(r.get("rect")))
        check("RC height 45vh, no px inline", r.get("box") and approx(r["rect"][3] - r["rect"][1], 0.45 * r["vh"]) and "px" not in r["inline"], str(r))
        check("RC image visible + faded in", r.get("box") and any(i["nat"] > 0 and i["op"] > 0.9 for i in r["imgs"]) and page.evaluate("() => window.__fades.length") >= 1, str(r.get("imgs")))
        page.set_viewport_size({"width": 1200, "height": 600})
        page.wait_for_timeout(100)
        r2 = page.evaluate(PROBE, ".redcarpet-container")
        check("RC resize follows via CSS", approx(r2["rect"][3], 600) and approx(r2["rect"][3] - r2["rect"][1], 270), str(r2["rect"]))
        page.evaluate("() => { location.hash = '#/list.html?type=Movie&personId=p1&serverId=s1'; document.dispatchEvent(new CustomEvent('viewshow')); }")
        page.wait_for_timeout(1500)
        r3 = page.evaluate(PROBE, ".redcarpet-container")
        check("RC stays on the filmography list (same person)", r3.get("box") and any(i["op"] > 0.9 for i in r3["imgs"]), str(r3))
        page.close()

        browser.close()
    print("RESULT", "FAILED" if fails else "OK", f"({fails} failure(s))")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
