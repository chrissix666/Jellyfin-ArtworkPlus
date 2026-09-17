"""
Rule 14 (Fibel): the whole admin menu has exactly ONE grey level - for
every DOM element, at most ONE element in its own ancestor-or-self chain
may carry the epFieldDisabled class at any time, never two at once
(otherwise the CSS opacity visibly doubles).

Checks after EVERY single toggle of every checkbox/select referenced in
the tree, plus specifically after the known multi-level mutation cascades
(Detail/Library -> ShowOn -> Enable) for all affected groups.
"""
import sys
from playwright.sync_api import sync_playwright

from _common import CONFIG_PAGE as PAGE_PATH, STUBS, file_url

CHECK_JS = """() => {
    var violations = [];
    document.querySelectorAll('.epFieldDisabled').forEach(function (el) {
        var node = el.parentElement;
        while (node) {
            if (node.classList && node.classList.contains('epFieldDisabled')) {
                violations.push({
                    inner: el.id || el.className,
                    outer: node.id || node.className
                });
                break;
            }
            node = node.parentElement;
        }
    });
    return violations;
}"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(STUBS)
    page.goto(file_url(PAGE_PATH))
    page.wait_for_timeout(300)
    page.evaluate("() => document.getElementById('epRestoreAllBtn').click()")
    page.wait_for_timeout(100)

    all_violations = []

    # Open all collapses first so nested elements are reachable in the DOM
    # (Playwright visibility does not matter for a pure classList check,
    # but all are opened anyway for completeness).
    page.evaluate("""() => {
        document.querySelectorAll('.epCollapseHeader').forEach(h => h.click());
    }""")
    page.wait_for_timeout(100)

    # 1) Toggle every checkbox referenced in the tree individually
    toggle_ids = page.evaluate("""() => {
        var ids = new Set();
        function collect(n) {
            (n.when||[]).forEach(function(c) {
                (c.kind === 'valueIn' ? [] : c.ids).forEach(id => ids.add(id));
            });
            (n.children||[]).forEach(collect);
        }
        EP_TREE.forEach(collect);
        return Array.from(ids).filter(id => {
            var el = document.getElementById(id);
            return el && el.type === 'checkbox';
        });
    }""")

    for cid in toggle_ids:
        page.evaluate("(id) => { var el=document.getElementById(id); el.checked=false; el.dispatchEvent(new Event('change',{bubbles:true})); }", cid)
        v = page.evaluate(CHECK_JS)
        if v:
            all_violations.append((f"after {cid}=off", v))
        page.evaluate("(id) => { var el=document.getElementById(id); el.checked=true; el.dispatchEvent(new Event('change',{bubbles:true})); }", cid)
        v = page.evaluate(CHECK_JS)
        if v:
            all_violations.append((f"after {cid}=on", v))

    # 1b) Session 31 (gap closed, user-reported): also cycle every <select>
    # referenced in the tree (ValueIn conditions such as Position/ScaleMode)
    # through ALL of its possible values - these were NEVER tested before,
    # although exactly here (Red Carpet Position x ScaleMode) the last real
    # bug was found.
    select_ids = page.evaluate("""() => {
        var ids = new Set();
        function collect(n) {
            (n.when||[]).forEach(function(c) {
                if (c.kind === 'valueIn') { ids.add(c.id); }
            });
            (n.children||[]).forEach(collect);
        }
        EP_TREE.forEach(collect);
        return Array.from(ids).filter(id => {
            var el = document.getElementById(id);
            return el && el.tagName === 'SELECT';
        });
    }""")

    page.evaluate("() => document.getElementById('epRestoreAllBtn').click()")
    page.wait_for_timeout(80)
    for sid in select_ids:
        options = page.evaluate("(id) => Array.from(document.getElementById(id).options).map(o => o.value)", sid)
        for opt in options:
            page.evaluate("([id, v]) => { var el=document.getElementById(id); el.value=v; el.dispatchEvent(new Event('change',{bubbles:true})); }", [sid, opt])
            v = page.evaluate(CHECK_JS)
            if v:
                all_violations.append((f"after {sid}={opt}", v))

    page.evaluate("() => document.getElementById('epRestoreAllBtn').click()")
    page.wait_for_timeout(100)

    # 2) The full mutation cascades for every group, specifically
    cascades = [
        ('Postercase', ['PostercaseMoviesDetailEnabled', 'PostercaseMoviesLibraryEnabled', 'PostercaseTvShowsDetailEnabled', 'PostercaseTvShowsLibraryEnabled']),
        ('Keyart', ['KeyartMoviesDetailEnabled', 'KeyartMoviesLibraryEnabled', 'KeyartTvShowsDetailEnabled', 'KeyartTvShowsLibraryEnabled']),
        ('Extraposter', ['ExtraposterMoviesDetailEnabled', 'ExtraposterMoviesLibraryEnabled', 'ExtraposterTvShowsDetailEnabled', 'ExtraposterTvShowsLibraryEnabled']),
        ('Extrakeyart', ['ExtrakeyartMoviesDetailEnabled', 'ExtrakeyartMoviesLibraryEnabled', 'ExtrakeyartTvShowsDetailEnabled', 'ExtrakeyartTvShowsLibraryEnabled']),
        ('Backdrops (ShowOn->Enable only, no Detail/Library)', ['BackdropsShowOnMovies', 'BackdropsShowOnSets', 'BackdropsShowOnTvShows', 'BackdropsShowOnSeasons', 'BackdropsShowOnEpisodes', 'BackdropsShowOnVideos']),
        ('AnimatedPoster Movies', ['AnimatedPosterMoviesDetailEnabled', 'AnimatedPosterMoviesLibraryEnabled']),
    ]
    for name, ids in cascades:
        page.evaluate("() => document.getElementById('epRestoreAllBtn').click()")
        page.wait_for_timeout(50)
        for cid in ids:
            page.evaluate("(id) => { var el=document.getElementById(id); el.checked=false; el.dispatchEvent(new Event('change',{bubbles:true})); }", cid)
        v = page.evaluate(CHECK_JS)
        if v:
            all_violations.append((f"full cascade {name}", v))

    print(f"Rule-14 violations found: {len(all_violations)}")
    for label, vlist in all_violations:
        print(f"  {label}:")
        for viol in vlist:
            print(f"    inner='{viol['inner']}' already greyed INSIDE outer='{viol['outer']}' (also greyed)")
    print("JS errors:", errors)
    browser.close()
    sys.exit(1 if (all_violations or errors) else 0)
