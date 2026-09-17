"""
Counter-audit: actively looks for bug classes the other check scripts
(self containment, nesting, header consistency) do NOT cover:
  A) target/headerTarget IDs managed by more than one node
  B) collapse header/body pairs in the HTML without ANY EP_TREE management
  C) 'Enabled'-style checkboxes never referenced as a condition anywhere
  D) EP_FIELDS entries without a matching DOM element (dead configuration)

Informational: the two known C) findings (BackdropsStudioTvShowsEnabled,
CaseModDeveloperSettingsEnabled) are intentional leaf switches.
"""
from playwright.sync_api import sync_playwright

from _common import CONFIG_PAGE as PAGE_PATH, STUBS, file_url

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.add_init_script(STUBS)
    page.goto(file_url(PAGE_PATH))
    page.wait_for_timeout(300)

    result = page.evaluate("""() => {
        var out = { A: [], B: [], C: [], D: [] };

        // A) target/headerTarget IDs managed by several nodes
        var seen = {};
        function walkA(n) {
            (n.target||[]).concat(n.headerTarget||[]).forEach(function(t) {
                if (!seen[t]) { seen[t] = []; }
                seen[t].push(n.id);
            });
            (n.children||[]).forEach(walkA);
        }
        EP_TREE.forEach(walkA);
        Object.keys(seen).forEach(function(t) {
            if (seen[t].length > 1) {
                out.A.push(t + ' is managed by several nodes: ' + seen[t].join(', '));
            }
        });

        // B) all collapse headers in the HTML vs. all managed by the tree
        var allHeaders = Array.from(document.querySelectorAll('.epCollapseHeader[data-collapse]')).map(function(h) { return h.dataset.collapse; });
        var managedKeys = {};
        function walkB(n) {
            (n.target||[]).forEach(function(t) { managedKeys[t] = true; });
            (n.headerTarget||[]).forEach(function(t) { managedKeys[t] = true; });
            (n.children||[]).forEach(walkB);
        }
        EP_TREE.forEach(walkB);
        allHeaders.forEach(function(key) {
            if (!managedKeys[key]) { out.B.push(key + ' has a collapse header in the HTML but NO tree node managing it'); }
        });

        // C) all checkboxes whose name ends in 'Enabled' vs. all IDs
        // referenced anywhere in the tree as a condition source
        var allEnabledCheckboxes = Object.keys(EP_FIELDS).filter(function(id) {
            return EP_FIELDS[id].type === 'checkbox' && /Enabled$/.test(id);
        });
        var referencedIds = {};
        function collectIds(when) {
            (when||[]).forEach(function(c) {
                (c.kind === 'valueIn' ? [c.id] : c.ids).forEach(function(id) { referencedIds[id] = true; });
            });
        }
        function walkC(n) { collectIds(n.when); (n.children||[]).forEach(walkC); }
        EP_TREE.forEach(walkC);
        allEnabledCheckboxes.forEach(function(id) {
            if (!referencedIds[id]) { out.C.push(id + ' (checkbox ends in "Enabled" but is referenced NOWHERE in the tree as a condition - could be missing wiring, OR an intentional General/tab-root switch)'); }
        });

        // D) EP_FIELDS entries without a DOM element
        Object.keys(EP_FIELDS).forEach(function(id) {
            if (!document.getElementById(id)) { out.D.push(id + ' declared in EP_FIELDS, but no DOM element with this ID found'); }
        });

        return out;
    }""")

    print("A) Targets managed by several nodes:", len(result['A']))
    for x in result['A']: print(" ", x)
    print()
    print("B) Unmanaged collapse headers:", len(result['B']))
    for x in result['B']: print(" ", x)
    print()
    print("C) 'Enabled' checkboxes without tree reference:", len(result['C']))
    for x in result['C']: print(" ", x)
    print()
    print("D) EP_FIELDS without DOM element:", len(result['D']))
    for x in result['D']: print(" ", x)
    browser.close()
