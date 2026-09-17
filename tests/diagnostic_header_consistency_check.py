"""
Lists every collapse key that is managed by some EP_TREE node via target
or headerTarget - the inventory of headers whose greying is tree-driven.
A collapse header missing from this list is managed by nobody (see also
diagnostic_gegenaudit.py, check B).
"""
from playwright.sync_api import sync_playwright

from _common import CONFIG_PAGE as PAGE_PATH, STUBS, file_url

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.add_init_script(STUBS)
    page.goto(file_url(PAGE_PATH))
    page.wait_for_timeout(300)
    page.evaluate("() => document.getElementById('epRestoreAllBtn').click()")
    page.wait_for_timeout(100)

    # Collect all collapse keys that appear anywhere as target OR
    # headerTarget.
    result = page.evaluate("""() => {
        var collapseKeys = new Set();
        function collect(n) {
            (n.target||[]).forEach(function(t){ if (document.querySelector('.epCollapseHeader[data-collapse="'+t+'"]')) collapseKeys.add(t); });
            (n.headerTarget||[]).forEach(function(t){ collapseKeys.add(t); });
            (n.children||[]).forEach(collect);
        }
        EP_TREE.forEach(collect);
        return Array.from(collapseKeys);
    }""")
    print(f"Collapse keys with header management: {len(result)}")
    print(result)
    browser.close()
