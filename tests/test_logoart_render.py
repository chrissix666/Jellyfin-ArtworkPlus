"""LogoArt (Session 134) must render the logo slot as the concept's geometry.

Stubs /LogoArt/{id} and a minimal Jellyfin detail page (the .detailLogo box
with the vanilla CSS) and asserts the DOM artefact per case (lesson G-render):

  - zero intervention: no container, .detailLogo gets the release class only
  - VanillaLogo / FolderLogo / Text stage: the vanilla slot (25vw x 16vh, top
    10vh, centre 62.5vw), Size / Offset / Vertical offset applied as CSS
  - Clearart (16:9, own Size/Offsets, no cap) / Characterart (the Characterart
    sizing block, Height 0 = ribbon line up to the page top): bottom edge on the
    ribbon line (40vh - 7.2em), centre 62.5vw
  - chain: a stage whose image fails to load is skipped, the next one shows
  - Hide: nothing, .detailLogo stays hidden
  - Characterart stage rotates (second image after CycleTimeMs)
  - Text stage: two layers, the real bundled font, fitted into the box,
    re-fitted on resize
  - hidden below 68.75em like the native logo

    python tests/test_logoart_render.py
"""
import base64
import json
import os
import sys
from playwright.sync_api import sync_playwright
from _common import ROOT, CORE_JS

RENDERART_JS = os.path.join(ROOT, 'Jellyfin-ArtworkPlus-RenderArt-v1.js')
FONTS = os.path.join(ROOT, 'Fonts')
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
.detailLogo:not(.artworkplus-logoart-vanilla){visibility:hidden!important}
.detailPagePrimaryContainer.detailRibbon{margin-top:-7.2em;height:7.2em;}
</style></head><body class="force-scroll">
<div id="itemDetailPage" class="page libraryPage itemDetailPage mainAnimatedPage">
  <div id="itemBackdrop" class="itemBackdrop"></div>
  <div class="detailLogo"></div>
  <div class="detailPageWrapperContainer"><div class="detailPagePrimaryContainer detailRibbon"></div></div>
  <div style="height:3000px"></div>
</div></body></html>"""

FONT_FILE = "Signature/Activity.otf"


def result(stages, **kw):
    r = dict(IsApplicable=True, ItemType="Movie", ZeroIntervention=False, Stages=stages, SizePercent=100, OffsetVw=0, VerticalOffsetVh=0,
             ClearartSizePercent=100, ClearartOffsetVw=0, ClearartVerticalOffsetVh=0,
             ScaleMode="Height", HeightVh=0, MaxWidthVw=0, WidthVw=20, MaxHeightVh=0, HorizontalAlign="Center", HorizontalOffsetVw=0,
             MultiImage=True, OrderMode="Sequential", SinglePass=False, StaySingleImageStatic=False, CycleTimeMs=1200, FadeTimeMs=300,
             TextStroke=0, Outline=1)
    r.update(kw)
    return r


def serve(route, stubs):
    path = route.request.url[len(ORIGIN):]
    if path.startswith("/LogoArt/font/"):
        rel = path[len("/LogoArt/font/"):].split("?")[0]
        with open(os.path.join(FONTS, rel.replace('/', os.sep)), 'rb') as f:
            route.fulfill(status=200, content_type="font/otf", body=f.read())
        return
    if "/bad" in path:
        route.fulfill(status=404, body="")
        return
    if "/Images/" in path or "/characterart/" in path or "/person/" in path:
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


PROBE = """
() => {
  const box = document.querySelector('.logoart-container');
  const logo = document.querySelector('.detailLogo');
  const out = { box: !!box, released: logo.classList.contains('artworkplus-logoart-vanilla'), vw: innerWidth, vh: innerHeight };
  if (!box) return out;
  const cs = getComputedStyle(box);
  const r = box.getBoundingClientRect();
  out.cls = box.className; out.display = cs.display; out.rect = [r.left, r.top, r.right, r.bottom];
  out.afterLogo = box.previousElementSibling === logo;
  out.inline = ['width','height','left','right','top','bottom'].map(k => box.style[k]).join('|');
  out.imgs = [...box.querySelectorAll('img')].map(i => ({ src: i.getAttribute('src') || '', nat: i.naturalWidth, op: parseFloat(getComputedStyle(i).opacity) }));
  const spans = [...box.querySelectorAll('.logoart-text:not(.logoart-text-measure)')];
  out.text = spans.map(s => ({ cls: s.className, text: s.textContent, size: parseFloat(getComputedStyle(s).fontSize), family: getComputedStyle(s).fontFamily, w: s.getBoundingClientRect().width, h: s.getBoundingClientRect().height }));
  return out;
}
"""


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

        def open_page(item, payload, w=1600, h=900):
            page = browser.new_page(viewport={"width": w, "height": h})
            page.add_init_script("Object.defineProperty(window.screen, 'height', { get: () => 4000 });")
            page.route(f"{ORIGIN}/**", lambda route, request, stubs={"/LogoArt/" + item: payload}: serve(route, stubs))
            page.goto(f"{ORIGIN}/web/index.html#/details?id={item}&serverId=s1")
            page.add_script_tag(content=core)
            page.add_script_tag(content=ra)
            page.evaluate("document.dispatchEvent(new CustomEvent('viewshow'))")
            return page

        # 1. zero intervention
        page = open_page("z1", result([], ZeroIntervention=True))
        page.wait_for_timeout(1500)
        r = page.evaluate(PROBE)
        check("zero intervention: no container, .detailLogo released", not r["box"] and r["released"], str(r))
        page.close()

        # 2. VanillaLogo stage: the vanilla slot, then Size/Offset/Vertical offset
        page = open_page("v1", result([{"Kind": "VanillaLogo", "Url": "/Items/x/Images/Logo?tag=1", "Level": "Item"}]))
        page.wait_for_timeout(1500)
        r = page.evaluate(PROBE)
        check("VanillaLogo: container after .detailLogo, slot class, logo not released", r["box"] and r["afterLogo"] and "logoart-slot" in r["cls"] and not r["released"], str(r))
        if r["box"]:
            vw, vh = r["vw"], r["vh"]
            check("VanillaLogo: 25vw x 16vh at top 10vh", approx(r["rect"][2] - r["rect"][0], 0.25 * vw) and approx(r["rect"][3] - r["rect"][1], 0.16 * vh) and approx(r["rect"][1], 0.10 * vh), str(r["rect"]))
            check("VanillaLogo: centre 62.5vw", approx((r["rect"][0] + r["rect"][2]) / 2, 0.625 * vw), str(r["rect"]))
            check("VanillaLogo: no px inline geometry", "px" not in r["inline"], r["inline"])
            check("VanillaLogo: image decoded", any(i["nat"] > 0 for i in r["imgs"]), str(r["imgs"]))
            page.set_viewport_size({"width": 1000, "height": 700})
            page.wait_for_timeout(100)
            r2 = page.evaluate(PROBE)
            check("hidden below 68.75em like the native logo", r2["display"] == "none", str(r2.get("display")))
        page.close()
        page = open_page("v2", result([{"Kind": "VanillaLogo", "Url": "/Items/x/Images/Logo?tag=1", "Level": "Item"}], SizePercent=150, OffsetVw=5, VerticalOffsetVh=-2))
        page.wait_for_timeout(1500)
        r = page.evaluate(PROBE)
        if r["box"]:
            vw, vh = r["vw"], r["vh"]
            check("Size 150: 37.5vw x 24vh", approx(r["rect"][2] - r["rect"][0], 0.375 * vw) and approx(r["rect"][3] - r["rect"][1], 0.24 * vh), str(r["rect"]))
            check("Offset 5 / Vertical -2: centre 67.5vw, top 8vh", approx((r["rect"][0] + r["rect"][2]) / 2, 0.675 * vw) and approx(r["rect"][1], 0.08 * vh), str(r["rect"]))
        else:
            check("Size/Offset case rendered", False, str(r))
        page.close()

        # 3. chain: VanillaLogo fails (404) -> Clearart on the ribbon line, 16:9
        page = open_page("c1", result([{"Kind": "VanillaLogo", "Url": "/Items/bad/Images/Logo", "Level": "Item"}, {"Kind": "Clearart", "Url": "/Items/x/Images/Art?tag=2", "Level": "Parent"}]))
        page.wait_for_timeout(2500)
        r = page.evaluate(PROBE)
        check("chain: failed stage skipped, Clearart shown", r["box"] and "logoart-clearart" in r["cls"] and any("Images/Art" in i["src"] for i in r["imgs"]), str(r))
        if r["box"]:
            vw, vh = r["vw"], r["vh"]
            line = 0.4 * vh - 7.2 * 16
            w, h = r["rect"][2] - r["rect"][0], r["rect"][3] - r["rect"][1]
            check("Clearart: bottom on the ribbon line", approx(r["rect"][3], line), f"bottom={r['rect'][3]} line={line}")
            check("Clearart: 16:9 at 25vw x Size, no cap", approx(h, 0.25 * vw * 9 / 16) and approx(w / h, 16 / 9, 0.02), f"w={w} h={h}")
            check("Clearart: centre 62.5vw", approx((r["rect"][0] + r["rect"][2]) / 2, 0.625 * vw), str(r["rect"]))
            # a short window: the box keeps its size (no cap) and rises above 10vh
            page.set_viewport_size({"width": 1600, "height": 520})
            page.wait_for_timeout(100)
            r2 = page.evaluate(PROBE)
            h2 = r2["rect"][3] - r2["rect"][1]
            check("Clearart: keeps its size in a short window (user: no cap)", approx(h2, 0.25 * 1600 * 9 / 16) and r2["rect"][1] < 52, f"h={h2} top={r2['rect'][1]}")
        page.close()
        # 3b. Clearart with its own Size / Offset / Vertical offset (independent of the logo values)
        page = open_page("c2", result([{"Kind": "Clearart", "Url": "/Items/x/Images/Art?tag=2", "Level": "Item"}], SizePercent=50, OffsetVw=-9, VerticalOffsetVh=9, ClearartSizePercent=200, ClearartOffsetVw=5, ClearartVerticalOffsetVh=-3))
        page.wait_for_timeout(1500)
        r = page.evaluate(PROBE)
        if r["box"]:
            vw, vh = r["vw"], r["vh"]
            w = r["rect"][2] - r["rect"][0]
            check("Clearart: own Size 200 = 50vw wide, own Offset 5 -> centre 67.5vw, own Vertical offset -3 -> bottom 3vh above the line", approx(w, 0.5 * vw) and approx((r["rect"][0] + r["rect"][2]) / 2, 0.675 * vw) and approx(r["rect"][3], 0.4 * vh - 115.2 - 0.03 * vh), str(r["rect"]))
        else:
            check("Clearart own-geometry case rendered", False, str(r))
        page.close()

        page.close()

        # 4. Hide
        page = open_page("h1", result([{"Kind": "Hide"}]))
        page.wait_for_timeout(1500)
        r = page.evaluate(PROBE)
        check("Hide: no container, logo stays hidden", not r["box"] and not r["released"], str(r))
        page.close()

        # 5. Characterart stage: the Characterart sizing block on the ribbon line; Height 0 = full height (ribbon line to page top), rotates
        page = open_page("a1", result([{"Kind": "Characterart", "Images": [{"FileName": "a.png", "Version": "1"}, {"FileName": "b.png", "Version": "1"}]}], CycleTimeMs=2500))
        page.wait_for_timeout(1500)
        r = page.evaluate(PROBE)
        line = 0.4 * r["vh"] - 115.2
        check("Characterart: floor box, bottom on the ribbon line, Height 0 = up to the page top (1:1 image -> square)", r["box"] and "logoart-characterart" in r["cls"] and approx(r["rect"][3], line) and approx(r["rect"][1], 0, 1) and approx((r["rect"][2] - r["rect"][0]), line, 1.5), str(r))
        vis1 = [i for i in r.get("imgs", []) if i["op"] > 0.9]
        check("Characterart: first image visible via /LogoArt/{id}/characterart/", len(vis1) == 1 and "/LogoArt/a1/characterart/a.png" in vis1[0]["src"], str(r.get("imgs")))
        page.wait_for_timeout(2500)
        r2 = page.evaluate(PROBE)
        vis2 = [i for i in r2.get("imgs", []) if i["op"] > 0.9]
        check("Characterart: second image after CycleTimeMs", len(vis2) == 1 and "b.png" in vis2[0]["src"], str(r2.get("imgs")))
        page.close()
        # 5b. Characterart with a fixed Height / max width / Align Left / Offset
        page = open_page("a2", result([{"Kind": "Characterart", "Images": [{"FileName": "a.png", "Version": "1"}]}], ScaleMode="Height", HeightVh=20, MaxWidthVw=30, HorizontalAlign="Left", HorizontalOffsetVw=4))
        page.wait_for_timeout(1500)
        r = page.evaluate(PROBE)
        if r["box"]:
            vw, vh = r["vw"], r["vh"]
            obj = page.evaluate("() => getComputedStyle(document.querySelector('.logoart-container img')).objectPosition")
            check("Characterart: Height 20vh x max width 30vw, centre 62.5vw + 4vw, image aligned left bottom", approx(r["rect"][3] - r["rect"][1], 0.2 * vh) and approx(r["rect"][2] - r["rect"][0], 0.3 * vw) and approx((r["rect"][0] + r["rect"][2]) / 2, 0.665 * vw) and obj.startswith("0%") and obj.endswith("100%"), f"{r['rect']} {obj}")
        else:
            check("Characterart fixed-size case rendered", False, str(r))
        page.close()

        # 6. Text stage (Persons): real bundled font, two layers, fitted, re-fitted on resize
        page = open_page("p1", result([{"Kind": "FolderLogo", "Url": None}, {"Kind": "Text", "Text": "Scarlett Johansson", "FontFile": FONT_FILE, "FontFamily": "Activity", "Uppercase": False}], ItemType="Persons", TextStroke=0, Outline=1))
        page.wait_for_timeout(2500)
        r = page.evaluate(PROBE)
        check("Text: slot container with rim + fill layers", r["box"] and "logoart-slot" in r["cls"] and len(r["text"]) == 2 and all(t["text"] == "Scarlett Johansson" for t in r["text"]), str(r))
        if r["box"] and r["text"]:
            bw, bh = r["rect"][2] - r["rect"][0], r["rect"][3] - r["rect"][1]
            fitted = all(t["w"] <= bw + 1 and t["h"] <= bh + 1 for t in r["text"]) and r["text"][0]["size"] > 12
            check("Text: fitted into the box (binary search)", fitted, f"box={bw}x{bh} text={r['text']}")
            check("Text: uses the bundled font family", "Activity" in r["text"][0]["family"], r["text"][0]["family"])
            loaded = page.evaluate("() => document.fonts.check(\"20px 'Activity'\")")
            check("Text: @font-face loaded from /LogoArt/font/", loaded)
            page.set_viewport_size({"width": 1200, "height": 900})
            page.wait_for_timeout(300)
            r2 = page.evaluate(PROBE)
            bw2 = r2["rect"][2] - r2["rect"][0]
            check("Text: re-fitted on resize", r2["text"][0]["size"] < r["text"][0]["size"] and all(t["w"] <= bw2 + 1 for t in r2["text"]), f"{r['text'][0]['size']} -> {r2['text'][0]['size']}")
        page.close()

        browser.close()
    print("RESULT", "FAILED" if fails else "OK", f"({fails} failure(s))")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
