"""
Checks the precondition for shouldApplyOwnVisual: when a node AND its direct
parent both have their own 'target', the child target must be a real DOM
descendant of (or equal to) the parent target - otherwise skipping at
parentActive=false would wrongly grey NOTHING at all.

Informational: the known findings (Red Carpet position rows, Backdrops
Show-on) are sibling-target patterns documented as safe in the Fibel, rule 6.
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
        function resolveTargetEls(targetId) {
            var body = document.querySelector('.epCollapseBody[data-collapsebody="' + targetId + '"]');
            var row = !body ? document.getElementById(targetId) : null;
            return body ? [body] : (row ? [row] : []);
        }
        var problems = [];
        function walk(node, parentTargetEls, path) {
            var myPath = path.concat([node.id]);
            var myTargetEls = (node.target || []).reduce(function (acc, t) {
                return acc.concat(resolveTargetEls(t));
            }, []);
            if (myTargetEls.length && parentTargetEls && parentTargetEls.length) {
                myTargetEls.forEach(function (myEl) {
                    var containedInAny = parentTargetEls.some(function (pEl) { return pEl.contains(myEl); });
                    if (!containedInAny) {
                        problems.push({ path: myPath.join(' > '), issue: 'child target is NOT inside any parent target - shouldApplyOwnVisual could be skipped wrongly' });
                    }
                });
            }
            (node.children || []).forEach(function (child) {
                // Next level: the relevant 'parentTargetEls' for the
                // children is this node's own target if it has one -
                // otherwise the last known one (so the check also works
                // across a node WITHOUT its own target).
                walk(child, myTargetEls.length ? myTargetEls : parentTargetEls, myPath);
            });
        }
        EP_TREE.forEach(function (root) { walk(root, [], []); });
        return problems;
    }""")

    print(f"Nesting findings: {len(result)}")
    for p_ in result:
        print(f"  {p_['path']}: {p_['issue']}")
    browser.close()
