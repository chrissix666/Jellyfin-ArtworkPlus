"""Core.makeLogger must be silent unless localStorage.ArtworkPlusDebug enables
the module's tag (Session 114). Guards against the console spam that made
every live console read twice as long.

    python tests/test_debug_switch.py
"""
import sys
from playwright.sync_api import sync_playwright
from _common import CORE_JS, STUBS

CORE = open(CORE_JS, encoding="utf-8").read()
PROBE = """
(setting) => {
    if (setting === null) localStorage.removeItem('ArtworkPlusDebug'); else localStorage.setItem('ArtworkPlusDebug', setting);
    const seen = [];
    const orig = console.log; console.log = (...a) => seen.push(a.join(' '));
    try {
        for (const tag of ['[Backdrops]', '[PeopleBackdrops]', '[PostersPlus/CaseMod]', '[RedCarpet]']) {
            window.ArtworkPlusCore.makeLogger(tag, true)('hello');
            window.ArtworkPlusCore.makeLogger(tag, false)('never');   // module DEBUG=false stays silent
        }
    } finally { console.log = orig; }
    return seen;
}
"""
CASES = [
    (None, []),
    ("", []),
    ("all", ["[Backdrops] hello", "[PeopleBackdrops] hello", "[PostersPlus/CaseMod] hello", "[RedCarpet] hello"]),
    ("casemod", ["[PostersPlus/CaseMod] hello"]),
    ("Backdrops, RedCarpet", ["[Backdrops] hello", "[PeopleBackdrops] hello", "[RedCarpet] hello"]),
]


def main():
    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        # localStorage needs a real origin: serve an empty page under http://
        page.route("http://artworkplus.test/**", lambda r: r.fulfill(status=200, content_type="text/html", body="<html><body></body></html>"))
        page.goto("http://artworkplus.test/")
        page.add_script_tag(content=STUBS)
        page.add_script_tag(content=CORE)
        for setting, expected in CASES:
            got = page.evaluate(PROBE, setting)
            ok = got == expected
            fails += 0 if ok else 1
            print(("ok  " if ok else "FAIL"), repr(setting), "->", got if not ok else f"{len(got)} line(s)")
        msg = page.evaluate("() => window.ArtworkPlusCore.setDebug('all')")
        print("setDebug:", msg)
        browser.close()
    print("RESULT", "FAILED" if fails else "OK", f"({len(CASES) - fails}/{len(CASES)})")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
