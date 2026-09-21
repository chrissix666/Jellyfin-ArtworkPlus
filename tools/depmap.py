"""Dependency map of the plugin, generated from the code (Session 138).

    python tools/depmap.py            -> docs/artworkplus-dependency-map.md

The map answers "who depends on this?" mechanically before a fix (the /fix
rulebook's impact map):

  1. Endpoints: every route of every controller with its auth state, the
     client call sites (scripts + admin page + tools), the config properties
     the controller reads, and the tests that mention the route.
  2. Config properties: C# default, EP_FIELDS default, the EP_TREE nodes whose
     conditions or targets name the field, the server files that read it, and
     whether the client sees it indirectly (through a DTO field of the same
     name).
  3. Scripts: endpoints called, Jellyfin DOM selectors, standing timers and
     observers, Core exports used.
  4. Tests: the source files each test reads.

Deterministic ordering, so `git diff` after a change shows exactly which
edges came or went. Regenerate and diff as step 6 of every /fix.

Call sites are matched by route prefix + first template segment, so a
parameter-only template (`/{personId}`) matches every call of that prefix -
over-inclusive on purpose: an impact map must not miss a caller.
"""
import os
import re
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
OUT = os.path.join(ROOT, 'docs', 'artworkplus-dependency-map.md')


def rel(p):
    return os.path.relpath(p, ROOT).replace('\\', '/')


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def files(sub, exts):
    out = []
    for dp, _, fns in os.walk(os.path.join(ROOT, sub)):
        if '_backup' in dp or 'node_modules' in dp or '\\bin' in dp or '\\obj' in dp:
            continue
        for fn in fns:
            if fn.endswith(exts):
                out.append(os.path.join(dp, fn))
    return sorted(out)


controllers = files('Controllers', ('.cs',))
helpers = files('Helpers', ('.cs',)) + files('FileTransformation', ('.cs',)) + [os.path.join(ROOT, 'Plugin.cs')]
scripts = [os.path.join(ROOT, 'EmbeddedScripts', 'Jellyfin-ArtworkPlus-Core-v1.js')] + sorted(
    os.path.join(ROOT, f) for f in os.listdir(ROOT) if f.startswith('Jellyfin-ArtworkPlus-') and f.endswith('.js'))
page = os.path.join(ROOT, 'Configuration', 'configPage.html')
config_cs = os.path.join(ROOT, 'Configuration', 'PluginConfiguration.cs')
tests = files('tests', ('.py', '.js'))
tools = [p for p in files('tools', ('.py', '.js')) if not p.endswith('depmap.py')]

# ---------- config properties ----------
cs_text = read(config_cs)
props = {}  # name -> (type, default)
for m in re.finditer(r'public (\w+\??) (\w+) \{ get; set; \}(?: = ([^;]+);)?', cs_text):
    props[m.group(2)] = (m.group(1), (m.group(3) or '').strip() or ('false' if m.group(1) == 'bool' else '0' if m.group(1) in ('int', 'double') else '""'))
page_text = read(page)
ep_fields = {}
for m in re.finditer(r"\n\s*([A-Za-z0-9_]+): \{ type: '([a-z]+)', def: ([^,]+), tab: '([a-z]+)' \}", page_text):
    ep_fields[m.group(1)] = (m.group(2), m.group(3).strip(), m.group(4))

# EP_TREE nodes: id, when-fields, targets
tree_src = page_text[page_text.index('var EP_TREE'):page_text.index('var EP_TREE') + 200000]
nodes = []
for m in re.finditer(r"\{\s*id: '([a-z0-9_]+)'(.*?)children: \[", tree_src, re.S):
    body = m.group(2)
    when_fields = set(re.findall(r"'([A-Za-z0-9_]+)'", body[body.find('when:'):] if 'when:' in body else ''))
    targets = set(re.findall(r"'([A-Za-z0-9_]+)'", body[body.find('target:'):body.find('when:')] if 'target:' in body and 'when:' in body else ''))
    header = set(re.findall(r"headerTarget: \[([^\]]*)\]", body))
    nodes.append((m.group(1), when_fields, targets))
field_nodes = defaultdict(set)
for nid, whens, targets in nodes:
    for f in whens:
        if f in props:
            field_nodes[f].add('when:' + nid)
    for t in targets:
        base = t[:-3] if t.endswith('Row') else t
        if base in props:
            field_nodes[base].add('target:' + nid)

# server readers per property
server_readers = defaultdict(set)
for f in controllers + helpers:
    t = read(f)
    for name in props:
        if re.search(r'\.' + name + r'\b', t):
            server_readers[name].add(rel(f))
# reflection readers
if re.search(r'"LibraryAlsoOn" \+ sub', read(os.path.join(ROOT, 'Controllers', 'ExtraposterController.cs'))):
    for name in props:
        if 'LibraryAlsoOn' in name:
            server_readers[name].add('Controllers/ExtraposterController.cs (reflection: AlsoOnAllowed)')

# DTO fields with the same name as a property (client sees them indirectly)
dto_names = set()
for f in controllers:
    for m in re.finditer(r'public (?:\w+\??) (\w+) \{ get; set; \}', read(f)):
        dto_names.add(m.group(1))

# ---------- endpoints ----------
endpoints = []
for f in controllers:
    t = read(f)
    route = re.search(r'\[Route\("([^"]+)"\)\]', t)
    if not route:
        continue
    prefix = route.group(1)
    class_anon = bool(re.search(r'\[AllowAnonymous\]\s*\n(?:\[[^\]]*\]\s*\n)*public class', t))
    lines = t.split('\n')
    for i, line in enumerate(lines):
        m = re.match(r'\s*\[Http(Get|Post|Put|Delete)\("?([^"\)]*)"?\)\]', line)
        if not m:
            continue
        # attributes around the method (3 lines up/down)
        window = '\n'.join(lines[max(0, i - 3):i + 4])
        auth = 'anonymous' if ('[AllowAnonymous]' in window or class_anon) else ('authorize' if '[Authorize' in window else 'attribute-less (anonymous by Jellyfin default)')
        if '[Authorize' in window and '[AllowAnonymous]' not in window:
            pol = re.search(r'\[Authorize\(Policy = ([^)]*)\)\]', window)
            auth = 'authorize' + (' ' + pol.group(1) if pol else '')
        template = m.group(2)
        full = '/' + prefix + ('/' + template if template else '')
        endpoints.append((full, m.group(1).upper(), auth, rel(f), i + 1, prefix))

config_reads_per_controller = {}
for f in controllers:
    t = read(f)
    config_reads_per_controller[rel(f)] = sorted(n for n in props if re.search(r'\.' + n + r'\b', t))


def call_sites(prefix, template):
    """Client / page / tool lines that mention the endpoint path."""
    key = '/' + prefix + '/'
    seg = template.split('/')[0].split('{')[0].strip()
    hits = []
    for f in scripts + [page] + tools + tests:
        for i, line in enumerate(read(f).split('\n')):
            if key in line and (not seg or seg in line):
                hits.append(rel(f) + ':' + str(i + 1))
            elif ("'" + prefix + "/") in line and (not seg or seg in line):  # ApiClient.getUrl('LogoArt/...')
                hits.append(rel(f) + ':' + str(i + 1))
    return sorted(set(hits))


# ---------- scripts ----------
script_rows = []
for f in scripts:
    t = read(f)
    eps = sorted(set(re.findall(r"'/(\w+)/", t)) & set(e[5] for e in endpoints))
    sels = sorted(set(re.findall(r"(?:querySelector(?:All)?|closest|matches)\('([^']*)'", t)))
    counts = {k: len(re.findall(k + r'\(', t)) for k in ('setInterval', 'setTimeout', 'requestAnimationFrame', 'new MutationObserver', 'new IntersectionObserver', 'new ResizeObserver', 'addEventListener', 'removeEventListener', 'fetch')}
    core_uses = sorted(set(re.findall(r'\bCore\.(\w+)', t))) if 'Core-v1' not in f else []
    script_rows.append((rel(f), eps, sels, counts, core_uses))

# ---------- tests ----------
source_names = [rel(f) for f in controllers + helpers + scripts + [page, config_cs]]
test_rows = []
for f in tests:
    t = read(f)
    reads = sorted(s for s in source_names if os.path.basename(s) in t or os.path.basename(s).replace('.js', '') in t)
    test_rows.append((rel(f), reads))

# ---------- write ----------
L = []
L.append('# ArtworkPlus dependency map (generated by `tools/depmap.py` - do not edit)')
L.append('')
L.append('Regenerate after every change and diff: `python tools/depmap.py && git diff docs/artworkplus-dependency-map.md`.')
L.append('')
L.append('## 1. Endpoints (%d)' % len(endpoints))
L.append('')
L.append('| route | verb | auth | controller | client / page / tool / test call sites |')
L.append('|---|---|---|---|---|')
for full, verb, auth, f, line, prefix in sorted(endpoints):
    template = full[len('/' + prefix) + 1:]
    sites = call_sites(prefix, template)
    L.append('| `%s` | %s | %s | `%s:%d` | %s |' % (full, verb, auth, f, line, ', '.join('`%s`' % s for s in sites) if sites else '-'))
L.append('')
L.append('### Config properties read per controller')
L.append('')
for c, reads in sorted(config_reads_per_controller.items()):
    L.append('- `%s` (%d): %s' % (c, len(reads), ', '.join(reads)))
L.append('')
L.append('## 2. Config properties (%d in C#, %d in EP_FIELDS)' % (len(props), len(ep_fields)))
L.append('')
L.append('| property | C# | C# default | EP_FIELDS default (tab) | EP_TREE nodes | server readers | DTO twin |')
L.append('|---|---|---|---|---|---|---|')
for name in sorted(props):
    typ, dflt = props[name]
    ep = ep_fields.get(name)
    epc = ('%s (%s)' % (ep[1], ep[2])) if ep else '- (server-only / composed)'
    L.append('| `%s` | %s | `%s` | %s | %s | %s | %s |' % (name, typ, dflt.replace('|', '\\|'), epc, ', '.join(sorted(field_nodes.get(name, []))) or '-', ', '.join(sorted(server_readers.get(name, []))) or '- (UNREAD)', 'yes' if name in dto_names else '-'))
L.append('')
unread = sorted(n for n in props if not server_readers.get(n))
L.append('Properties no server file reads (%d): %s' % (len(unread), ', '.join('`%s`' % n for n in unread) or '-'))
L.append('')
L.append('## 3. Scripts')
L.append('')
for f, eps, sels, counts, core_uses in script_rows:
    L.append('### `%s`' % f)
    L.append('')
    L.append('- endpoints called: %s' % (', '.join('`/%s/`' % e for e in eps) or '-'))
    L.append('- Jellyfin / own selectors: %s' % ', '.join('`%s`' % s for s in sels))
    L.append('- standing constructs: %s' % ', '.join('%s %d' % (k, v) for k, v in counts.items()))
    if core_uses:
        L.append('- Core exports used: %s' % ', '.join('`%s`' % c for c in core_uses))
    L.append('')
L.append('## 4. Tests and the sources they read')
L.append('')
L.append('| test | sources |')
L.append('|---|---|')
for f, reads in test_rows:
    L.append('| `%s` | %s |' % (f, ', '.join('`%s`' % r for r in reads) or '-'))
L.append('')
open(OUT, 'w', encoding='utf-8', newline='\n').write('\n'.join(L) + '\n')
print('written', rel(OUT), '| endpoints', len(endpoints), '| properties', len(props), '| unread', len(unread), '| scripts', len(script_rows), '| tests', len(test_rows))
