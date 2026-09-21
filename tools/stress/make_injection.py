"""Builds the text that is injected into the browser tab: runner.js + the
playbook + the start call. `--smoke` uses the first N steps with short
dwells to validate the recorder before a real run.

    python tools/stress/make_injection.py <label> [--smoke N]
"""
import json
import os
import sys

D = os.path.dirname(__file__)
label = sys.argv[1] if len(sys.argv) > 1 else 'run'
runner = open(os.path.join(D, 'runner.js'), encoding='utf-8').read()
pb = json.load(open(os.path.join(D, 'playbook.json'), encoding='utf-8'))
if '--smoke' in sys.argv:
    n = int(sys.argv[sys.argv.index('--smoke') + 1])
    pb['steps'] = [dict(s, d=min(s['d'], 6000)) for s in pb['steps'][:n]]
out = runner + '\nwindow.__stressStart(' + json.dumps(pb, separators=(',', ':')) + ', ' + json.dumps(label) + ');\n"started ' + label + ' with " + window.__stress.steps.length + " steps";'
path = os.path.join(D, 'inject_' + label + '.js')
open(path, 'w', encoding='utf-8').write(out)
print(path, len(out), 'chars,', len(pb['steps']), 'steps')
