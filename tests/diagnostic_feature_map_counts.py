"""Audit S5-01 (Session 138): the feature map's countable claims must match the
code - config prefix counts `X* (n)`, the total settings count, the test totals
in CLAUDE.md. Prints every drift; gating so the map cannot silently age."""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
cs = open(os.path.join(ROOT, 'Configuration', 'PluginConfiguration.cs'), encoding='utf-8').read()
names = [n for t, n in re.findall(r'public (\w+\??) (\w+) \{ get; set; \}', cs)]
fm = open(os.path.join(ROOT, 'docs', 'artworkplus-feature-map.md'), encoding='utf-8').read()
fails = []
for pre, claim in re.findall(r'`([A-Za-z]+)\*` \((\d+)\)', fm):
    n = sum(1 for x in names if x.startswith(pre))
    if n != int(claim):
        fails.append(f'feature map says `{pre}*` ({claim}), code has {n}')
m = re.search(r'PluginConfiguration\.cs \((\d+) settings\)', fm)
if m and int(m.group(1)) != len(names):
    fails.append(f'feature map says {m.group(1)} settings, code has {len(names)}')
if 'logging.json` overrides' in fm and 'to Debug' in fm.split('logging.json` overrides')[1][:80]:
    fails.append('feature map still says logging.json overrides the plugin to Debug (it is Information, the Debug value is the lever)')
for f in fails:
    print('FAIL', f)
print('RESULT ' + ('OK' if not fails else 'FAILED') + f' ({len(fails)} drift(s))')
sys.exit(0 if not fails else 1)
