"""Session 129: the CaseMod module measures its geometry ONLY through
measureDesignRect() (layout position at scroll 0). A raw
getBoundingClientRect() call anywhere else in the module would mix the
viewport frame back in (angle wandering with the scroll, wrong first tilt
after a reload mid-page, open-case jump). Comments may mention the name.
Session 132: the camera comes ONLY from designCamera() (a window-centred camera
made the trapezoid depend on the window size), and no box gets an inline
`top: calc(-80% ...)` (an inline top never follows Jellyfin's top: 10% below
62.5em - the sized classes do).
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
cam_start = module.index('function designCamera(')
cam_end = module.index('\n        }', cam_start)
outside_cam = module[:cam_start] + module[cam_end:]
window_cam = [l.strip()[:110] for l in outside_cam.split('\n')
              if 'innerHeight' in l.split('//')[0] or 'innerWidth * 0.5' in l.split('//')[0]]
inline_top = [l.strip()[:110] for l in module.split('\n') if ".style.top = 'calc(-80%" in l.split('//')[0]]
print(f"CaseMod module: {len(module.splitlines())} lines, raw getBoundingClientRect calls outside measureDesignRect: {len(raw)}, scroll listeners: {len(scroll)}, window-camera uses outside designCamera: {len(window_cam)}, inline -80% tops: {len(inline_top)}")
for r in raw: print('  ', r)
for s in scroll + window_cam + inline_top: print('  ', s)
ok = not raw and not scroll and not window_cam and not inline_top
print('RESULT', 'OK' if ok else 'FAILED')
sys.exit(0 if ok else 1)
