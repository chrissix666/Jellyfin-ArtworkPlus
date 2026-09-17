"""
Automated self-containment check for EP_TREE.

For EVERY node in the tree: none of its own "when" condition checkbox IDs
may be a DOM descendant of any of its own "target" elements. That is the
exact, confirmed failure mechanism (People Backdrops, Enable native
Backdrops override, Keyart, Extrakeyart) - not a sample, but a complete,
mechanical check against the REAL, rendered DOM tree in the browser.
"""
import sys, json
from playwright.sync_api import sync_playwright

from _common import CONFIG_PAGE as PAGE_PATH, STUBS, file_url

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.add_init_script(STUBS)
    page.goto(file_url(PAGE_PATH))
    page.wait_for_timeout(300)

    result = page.evaluate("""() => {
        function collectConditionIds(when) {
            var ids = [];
            (when || []).forEach(function (cond) {
                if (cond.kind === 'valueIn') { ids.push(cond.id); }
                else { ids = ids.concat(cond.ids); }
            });
            return ids;
        }

        // Resolves a 'target' entry exactly like epApplyNodeVisual does:
        // collapse body (data-collapsebody) first, then the collapse header
        // (data-collapse) separately, then a plain element by ID.
        function resolveTargetElements(targetId) {
            var els = [];
            var body = document.querySelector('.epCollapseBody[data-collapsebody="' + targetId + '"]');
            var header = document.querySelector('.epCollapseHeader[data-collapse="' + targetId + '"]');
            var row = document.getElementById(targetId);
            if (body) { els.push({ el: body, kind: 'collapse-body', targetId: targetId }); }
            if (header) { els.push({ el: header, kind: 'collapse-header', targetId: targetId }); }
            if (!body && row) { els.push({ el: row, kind: 'row', targetId: targetId }); }
            return els;
        }

        var violations = [];
        var totalNodesChecked = 0;

        function walk(node, path) {
            totalNodesChecked++;
            var myPath = path.concat([node.id]);
            var conditionIds = collectConditionIds(node.when);
            (node.target || []).forEach(function (targetId) {
                resolveTargetElements(targetId).forEach(function (t) {
                    // Only targets that disable INPUTS are dangerous
                    // (collapse-body and row disable all descendant
                    // inputs; collapse-header is purely cosmetic, never
                    // dangerous).
                    if (t.kind === 'collapse-header') { return; }
                    conditionIds.forEach(function (condId) {
                        var condEl = document.getElementById(condId);
                        if (condEl && t.el.contains(condEl)) {
                            violations.push({
                                nodePath: myPath.join(' > '),
                                targetId: targetId,
                                targetKind: t.kind,
                                selfContainedConditionId: condId
                            });
                        }
                    });
                });
            });
            (node.children || []).forEach(function (child) { walk(child, myPath); });
        }

        EP_TREE.forEach(function (root) { walk(root, []); });
        return { violations: violations, totalNodesChecked: totalNodesChecked };
    }""")

    print(f"Nodes checked: {result['totalNodesChecked']}")
    print(f"Self-containment violations found: {len(result['violations'])}")
    print()
    for v in result['violations']:
        print(f"  NODE: {v['nodePath']}")
        print(f"    target '{v['targetId']}' (kind: {v['targetKind']}) contains its own condition checkbox '{v['selfContainedConditionId']}'")
        print()
    browser.close()
    sys.exit(1 if result['violations'] else 0)
