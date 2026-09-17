"""Tests for Core's createBackdropRotationEngine() - the rotation-timing
engine shared by Backdrops-v1.js and the People Backdrops module.

Bug class covered: "the image list shrinks (removeFailedImage) but derived
state lags behind". Found live in Session 113 when a DNS outage killed every
hotlink: the Shuffle bag still held indices into the old, longer list and
handed `undefined` to the image loader. Runs Core in a bare page with the
shared stubs; no server needed.

    python tests/test_rotation_engine.py
"""
import sys
from playwright.sync_api import sync_playwright
from _common import CORE_JS, STUBS

CORE = open(CORE_JS, encoding="utf-8").read()

# Drives the engine exactly like Backdrops-v1.js does: every render of a
# "dead" URL reports failure, which removes the image and advances. The
# rendered list is what the loader would have been asked to show.
DRIVER = """
(args) => {
    const [images, dead, order, rounds] = args;
    const engine = window.ArtworkPlusCore.createBackdropRotationEngine();
    const rendered = [];
    let ticks = 0;
    engine.start(images.slice(), order, 1000, function (url) {
        rendered.push(url);
        if (dead.indexOf(url) !== -1) {
            engine.removeFailedImage(url);
            engine.advance();
            return;
        }
        engine.imageShown();
    });
    // Drive by hand (no timers): each advance() is one tick. Dead images
    // advance themselves in the callback, so the manual ticks needed to
    // finish the first round are (images - 1 initial tick - dead); after
    // that `rounds` full rounds of survivors, so the tail is round-aligned.
    const survivors = images.filter(u => dead.indexOf(u) === -1);
    const manual = (images.length - 1 - dead.length) + rounds * survivors.length;
    while (ticks++ < manual) { engine.advance(); }
    return rendered;
}
"""

CASES = [
    # (images, dead, order)
    (["a", "b", "c", "d", "e", "f", "g", "h"], ["a", "b", "c", "d", "e", "f", "g", "h"], "Shuffle"),
    (["a", "b", "c", "d", "e", "f", "g", "h"], ["h", "g"], "Shuffle"),
    (["a", "b", "c", "d", "e", "f", "g", "h"], ["a"], "Shuffle"),
    (["a", "b", "c", "d", "e"], ["c"], "Sequential"),
    (["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "e"], "Sequential"),
    (["a", "b", "c", "d", "e"], ["b", "d"], "Random"),
]


def main():
    failures = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.set_content("<html><body></body></html>")
        page.add_script_tag(content=STUBS)
        page.add_script_tag(content=CORE)
        for images, dead, order in CASES:
            for run in range(20 if order != "Sequential" else 1):
                rendered = page.evaluate(DRIVER, [images, dead, order, 3])
                survivors = [u for u in images if u not in dead]
                problems = []
                if any(u is None for u in rendered):
                    problems.append("undefined handed to the loader")
                shown = [u for u in rendered if u not in dead]
                if not set(shown) <= set(survivors):
                    problems.append(f"shown something that is not a survivor: {sorted(set(shown) - set(survivors))}")
                # Random is documented as a plain independent draw that may
                # skip images for a while - only Shuffle/Sequential must
                # cover every survivor.
                if order != "Random" and survivors and set(shown) != set(survivors):
                    problems.append(f"shown {sorted(set(shown))} != survivors {survivors}")
                if not survivors and shown:
                    problems.append(f"rendered after the list was emptied: {shown}")
                for u in dead:
                    if rendered.count(u) > 1:
                        problems.append(f"dead image {u} retried {rendered.count(u)}x")
                if order == "Shuffle" and survivors:
                    # Every full round after the removals must contain each survivor exactly once.
                    tail = shown[-len(survivors):]
                    if sorted(tail) != sorted(survivors):
                        problems.append(f"last shuffle round {tail} is not a permutation of {survivors}")
                if problems:
                    failures += 1
                    print(f"FAIL {order} images={images} dead={dead} run={run}: " + "; ".join(problems))
                    break
            else:
                print(f"ok   {order:10s} {len(images)} images, {len(dead)} dead")
        browser.close()
    print("RESULT", "FAILED" if failures else "OK", f"({len(CASES) - failures}/{len(CASES)} cases)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
