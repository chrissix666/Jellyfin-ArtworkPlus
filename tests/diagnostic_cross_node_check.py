"""
Extends test_tree_self_containment.py: does a node's 'target' contain the
trigger checkbox of ANOTHER node (not just its own)? That would be a
subtler deadlock: node A greys node B's trigger although A and B are not
in a parent/child relationship.

Informational: the known findings (Sort/Traversal pairs in Backdrops)
are documented as safe in the Fibel, rules 3b-3d.
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
            if (body) return [body];
            var row = document.getElementById(targetId);
            return row ? [row] : [];
        }
        var allTriggerIds = {}; // id -> [nodePath,...]
        function collectTriggers(n, path) {
            var myPath = path.concat([n.id]);
            (n.when||[]).forEach(function(c) {
                (c.kind === 'valueIn' ? [c.id] : c.ids).forEach(function(id) {
                    if (!allTriggerIds[id]) { allTriggerIds[id] = []; }
                    allTriggerIds[id].push(myPath.join(' > '));
                });
            });
            (n.children||[]).forEach(function(c) { collectTriggers(c, myPath); });
        }
        EP_TREE.forEach(function(r) { collectTriggers(r, []); });

        var problems = [];
        function walkTargets(n, path) {
            var myPath = path.concat([n.id]);
            (n.target||[]).forEach(function(targetId) {
                resolveTargetEls(targetId).forEach(function(el) {
                    Object.keys(allTriggerIds).forEach(function(triggerId) {
                        var triggerEl = document.getElementById(triggerId);
                        if (triggerEl && el.contains(triggerEl)) {
                            var ownerPaths = allTriggerIds[triggerId];
                            var isOwnTrigger = ownerPaths.some(function(p) { return p === myPath.join(' > '); });
                            var isAncestorOrDescendant = ownerPaths.some(function(p) {
                                return p.indexOf(myPath.join(' > ')) === 0 || myPath.join(' > ').indexOf(p) === 0;
                            });
                            if (!isAncestorOrDescendant) {
                                problems.push({ node: myPath.join(' > '), target: targetId, foreignTrigger: triggerId, ownedBy: ownerPaths.join(' | ') });
                            }
                        }
                    });
                });
            });
            (n.children||[]).forEach(function(c) { walkTargets(c, myPath); });
        }
        EP_TREE.forEach(function(r) { walkTargets(r, []); });
        return problems;
    }""")

    print(f"Cross-node findings: {len(result)}")
    for p_ in result:
        print(f"  node '{p_['node']}' greys, via its target '{p_['target']}', the trigger '{p_['foreignTrigger']}' of a FOREIGN node ({p_['ownedBy']})")
    browser.close()
