"""Session 129: the CaseMod module measures its geometry ONLY through
measureDesignRect() (layout position at scroll 0). A raw
getBoundingClientRect() call anywhere else in the module would mix the
viewport frame back in (angle wandering with the scroll, wrong first tilt
after a reload mid-page, open-case jump). Comments may mention the name.
"""
import re
import sys
from _common import POSTERS_JS

src = open(POSTERS_JS, encoding='utf-8').read()
start = src.index('var CaseModModule = (function () {')
end = src.index('\n    })();', start)
module = src[start:end]
raw = []
for i, line in enumerate(module.split('\n'), 1):
    code = line.split('//')[0]
    if 'getBoundingClientRect()' in code and 'var r = el.getBoundingClientRect();' not in code:
        raw.append((i, line.strip()[:110]))
scroll = [l.strip()[:110] for l in module.split('\n') if "addEventListener('scroll'" in l.split('//')[0]]
print(f"CaseMod module: {len(module.splitlines())} lines, raw getBoundingClientRect calls outside measureDesignRect: {len(raw)}, scroll listeners: {len(scroll)}")
for r in raw: print('  ', r)
for s in scroll: print('  ', s)
ok = not raw and not scroll
print('RESULT', 'OK' if ok else 'FAILED')
sys.exit(0 if ok else 1)
