"""Audit S2-09 (Session 138): every script.js endpoint must revalidate (no-cache +
ETag through Helpers.ScriptCaching), otherwise browsers cache the scripts
heuristically and an open tab runs mixed script versions after a deploy."""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
fails = []
n = 0
for fn in sorted(os.listdir(os.path.join(ROOT, 'Controllers'))):
    if not fn.endswith('.cs'):
        continue
    text = open(os.path.join(ROOT, 'Controllers', fn), encoding='utf-8').read()
    for m in re.finditer(r'\[HttpGet\("script\.js"\)\]', text):
        n += 1
        body = text[m.end():m.end() + 2500]
        if 'ScriptCaching.NotModified(' not in body:
            fails.append(fn + ': script.js endpoint without ScriptCaching.NotModified')
for f in fails:
    print('FAIL', f)
print('RESULT ' + ('OK' if not fails else 'FAILED') + ' (%d script endpoint(s), %d unguarded)' % (n, len(fails)))
sys.exit(0 if not fails else 1)
