"""
Runs the standard verification routine for Configuration/configPage.html
in one go (the manual 7-step checklist from the project guide, steps 1-5):

  1. node --check on the page's inline <script> blocks (syntax)
  2. test_configpage.py            (105 regression tests)
  2b. test_rotation_engine / test_debug_switch / test_backdrops_render (client scripts in a stub page)
  3. test_tree_self_containment.py (no node greys its own trigger)
  4. test_single_grey_level.py     (Fibel rule 14: one grey level only)
  5. diagnostic_duplicate_id_check.py
     diagnostic_js_cs_defaults_sync.py
     diagnostic_nested_collapse_check.py

The remaining diagnostics (cross-node, nesting, header-consistency,
gegenaudit) are informational - their known findings are documented in
the Fibel (rules 3b-3d, 6) - and are run with --all.

test_casemod.py (118 Playwright tests for the 3D case module) is not
part of this routine because it tests Posters-v1.js, not the config page;
run it directly when the CaseMod module changes.

Usage:  python run_checks.py [--all]
Exit code 0 when every gating step passes.
"""
import os
import re
import subprocess
import sys
import tempfile

from _common import CONFIG_PAGE, TESTS_DIR, ROOT

GATING = [
    'test_configpage.py',
    'test_tree_self_containment.py',
    'test_single_grey_level.py',
    'diagnostic_duplicate_id_check.py',
    'diagnostic_js_cs_defaults_sync.py',
    'diagnostic_nested_collapse_check.py',
    'diagnostic_batch_key_format.py',   # Session 122: batch maps keyed like the tile data-id (no dashes)
    # Session 113-116: client-engine and render checks (no server needed)
    'test_rotation_engine.py',
    'test_debug_switch.py',
    'test_backdrops_render.py',
    'test_description_length.py',   # rule 27: one-line descriptions (needs the preview, built below)
    'test_backdrop_resolver.py',    # Session 118: Custom listener = Jellyfin's rules 1:1 (builds tests/resolver_harness on first run)
    'test_renderart_render.py',     # Session 119: Characterart/Red Carpet as the CSS clearlogo replica (anchors, units, cycle/delay/fade, hide, fullscreen class)
    'test_library_tiles.py',        # Session 122: library tile arbiter (flash prevention, order, fallback, safety net) against a Jellyfin tile replica
    'test_backdrops_transitions.py',  # Session 120: the handover matrix of all six backdrop owners + Jellyfin (concept Part R)
]
INFORMATIONAL = [
    'diagnostic_cross_node_check.py',
    'diagnostic_nesting_check.py',
    'diagnostic_header_consistency_check.py',
    'diagnostic_gegenaudit.py',
]


def node_check():
    html = open(CONFIG_PAGE, encoding='utf-8').read()
    scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
    ok = True
    for i, body in enumerate(scripts, 1):
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
            f.write(body)
            path = f.name
        try:
            r = subprocess.run(['node', '--check', path], capture_output=True, text=True, shell=os.name == 'nt')
        finally:
            os.unlink(path)
        if r.returncode != 0:
            ok = False
            print(f"[FAIL] node --check, script block {i}:\n{r.stderr.strip()}")
    print(f"[{'PASS' if ok else 'FAIL'}] node --check ({len(scripts)} inline script blocks)")
    return ok


def run(script):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    r = subprocess.run([sys.executable, os.path.join(TESTS_DIR, script)],
                       capture_output=True, text=True, encoding='utf-8', env=env)
    tail = '\n'.join((r.stdout.strip().splitlines() or [''])[-3:])
    status = 'PASS' if r.returncode == 0 else 'FAIL'
    print(f"[{status}] {script}\n       " + tail.replace('\n', '\n       '))
    if r.returncode != 0 and r.stderr.strip():
        print('       ' + r.stderr.strip().replace('\n', '\n       '))
    return r.returncode == 0


if __name__ == '__main__':
    # rule 27's test renders the preview - make sure it is current
    subprocess.run([sys.executable, os.path.join(ROOT, 'build_preview.py')], capture_output=True)
    results = [node_check()] + [run(s) for s in GATING]
    if '--all' in sys.argv:
        print('\n--- informational diagnostics (findings documented in the Fibel) ---')
        for s in INFORMATIONAL:
            run(s)
    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} gating checks passed")
    sys.exit(1 if failed else 0)
