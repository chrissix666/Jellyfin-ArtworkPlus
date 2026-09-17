"""
Fibel rule 19 (Session 93; numbered 11 before the Session 111 renumbering): every sub-collapse that sits below an OUTER
feature level (its parent node in EP_TREE already has a headerTarget of its
own AND is not the tab root) must carry the CSS class 'epCollapseNested' on
BOTH header AND body - purely visual indentation showing the nesting depth.
Forgotten three times in this project already (Postercase/Keyart/
Extraposter/Extrakeyart Session 76, Favorites' 11 subs Session 78/81,
Animated Poster Session 90) - this script catches it automatically from
now on instead of relying on "looks right when viewed".
"""
import sys
from playwright.sync_api import sync_playwright

from _common import CONFIG_PAGE as PAGE_PATH, STUBS, file_url

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.add_init_script(STUBS)
    page.goto(file_url(PAGE_PATH))
    page.wait_for_timeout(300)

    result = page.evaluate("""() => {
        var problems = [];
        var checked = 0;

        function checkNode(collapseKey, path) {
            checked++;
            var header = document.querySelector('.epCollapseHeader[data-collapse="' + collapseKey + '"]');
            var body = document.querySelector('.epCollapseBody[data-collapsebody="' + collapseKey + '"]');
            if (!header) { problems.push(path + ': header element "' + collapseKey + '" not found'); return; }
            if (!header.classList.contains('epCollapseNested')) {
                problems.push(path + ': header "' + collapseKey + '" has NO epCollapseNested class');
            }
            if (body && !body.classList.contains('epCollapseNested')) {
                problems.push(path + ': body "' + collapseKey + '" has NO epCollapseNested class');
            }
        }

        function walk(node, parentHasHeaderTarget, parentIsTabRoot, path) {
            var myPath = path.concat([node.id]);
            var myHeaderTargets = node.headerTarget || [];

            // Only check when the PARENT node is itself a headerTarget
            // collapse AND is not the tab root (tab root -> first feature
            // is the OUTERMOST level, no nesting yet - only feature -> its
            // own subs is the nested level).
            if (parentHasHeaderTarget && !parentIsTabRoot) {
                myHeaderTargets.forEach(function (key) {
                    checkNode(key, myPath.join(' > '));
                });
            }

            (node.children || []).forEach(function (child) {
                walk(child, myHeaderTargets.length > 0, !!node.isTabRoot, myPath);
            });
        }

        EP_TREE.forEach(function (root) {
            walk(root, false, false, []);
        });

        return { problems: problems, checked: checked };
    }""")

    print(f"Collapse nodes checked (with potential nesting): {result['checked']}")
    print(f"Missing epCollapseNested classes found: {len(result['problems'])}")
    for p_ in result['problems']:
        print("  " + p_)

    browser.close()
    sys.exit(1 if result['problems'] else 0)
