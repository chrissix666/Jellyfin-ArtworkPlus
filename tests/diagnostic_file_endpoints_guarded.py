"""Audit S1-04 (Session 138): every controller action that serves a local file
must do so inside a try/catch, so a file that is locked by a writing tool or
removed between the directory scan and the open answers 404 + a warning
instead of a 500 from Jellyfin's ExceptionMiddleware (proven live with
tools/probe_locked_file.py: locked -> 500 before the fix, 404 after).

Gating: an action containing `File(`/`PhysicalFile(` without a `try` before it.
Informational (S1-04b): `PhysicalFile(` sites - the result opens the file only
when it executes, OUTSIDE the action's try, so those still answer 500 under a
lock (probe: /LogoArt/font locked -> 500). Listed, not gated, until their own
/fix.
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
fails = []
deferred = []
for fn in sorted(os.listdir(os.path.join(ROOT, 'Controllers'))):
    if not fn.endswith('.cs'):
        continue
    text = open(os.path.join(ROOT, 'Controllers', fn), encoding='utf-8').read()
    # split into methods by the 'public ActionResult' / 'private ActionResult' signatures
    for m in re.finditer(r'\n    (?:public|private|internal) (?:async )?(?:Task<)?ActionResult[^\n]*\n    \{', text):
        start = m.start()
        nxt = re.search(r'\n    (?:public|private|internal|\[)', text[m.end():])
        body = text[m.end():m.end() + (nxt.start() if nxt else len(text))]
        name = re.search(r'ActionResult(?:<[^>]+>)?\s+(\w+)\(', m.group(0))
        name = name.group(1) if name else '?'
        line = text.count('\n', 0, start) + 2
        serves = re.search(r'\breturn (?:File|PhysicalFile)\(', body)
        if not serves:
            continue
        if name == 'ServeLocalImage' or name == 'ServeFile':
            # helpers: their callers must be guarded (checked as actions above)
            continue
        first_try = body.find('try')
        if first_try == -1 or first_try > serves.start():
            fails.append(f'{fn}:{line} {name} serves a file without try/catch')
        for pm in re.finditer(r'PhysicalFile\(', body):
            deferred.append(f'{fn}:{line} {name} (PhysicalFile - deferred open, S1-04b)')
# helpers used by guarded callers
for fn, helper in (('LogoArtController.cs', 'ServeFile'), ('BackdropsController.cs', 'ServeLocalImage')):
    text = open(os.path.join(ROOT, 'Controllers', fn), encoding='utf-8').read()
    if helper == 'ServeFile' and 'PhysicalFile(' in text[text.index('private ActionResult ServeFile'):]:
        deferred.append(f'{fn} {helper} (PhysicalFile - deferred open, S1-04b)')

for f in fails:
    print('FAIL', f)
print('deferred-open sites (informational, S1-04b): %d' % len(deferred))
for d in deferred:
    print('  ', d)
print('RESULT ' + ('OK' if not fails else 'FAILED') + ' (%d unguarded file action(s))' % len(fails))
sys.exit(0 if not fails else 1)
