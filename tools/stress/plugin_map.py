"""Generates preview/plugin-map.html - the complete frame of the plugin as a
tree, read from the LIVE admin page (EP_TREE, EP_FIELDS, the DOM labels and
descriptions), not typed by hand: every tab, every collapse, every switch,
select and number with its default and its gate condition, plus the
feature-map facts (script, endpoints, where it renders). The same tree is
the checklist for the stress test's "everything on" profile.

    python tools/stress/plugin_map.py
"""
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'tests'))
from playwright.sync_api import sync_playwright  # noqa: E402
from _common import CONFIG_PAGE, STUBS, file_url, ROOT  # noqa: E402

OUT = os.path.join(ROOT, 'preview', 'plugin-map.html')

EXTRACT = r"""
() => {
  const fields = EP_FIELDS;
  const condText = (c) => {
    if (!c) return '';
    if (c.kind === 'all') return 'all on: ' + c.ids.join(', ');
    if (c.kind === 'any') return 'any on: ' + c.ids.join(', ');
    if (c.kind === 'none') return 'none on: ' + c.ids.join(', ');
    if (c.kind === 'valueIn') return c.id + ' in [' + c.values.join(', ') + ']';
    if (c.kind === 'anyValueIn') return 'any of ' + c.ids.join('|') + ' in [' + c.values.join(', ') + ']';
    return JSON.stringify(c);
  };
  const labelOf = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const row = el.closest('.epRow');
    const lab = row ? (row.querySelector('label, .epRowLabelSpan')) : null;
    const desc = row ? (row.querySelector('.epDesc, .epDescInline')) : null;
    let options = null;
    if (el.tagName === 'SELECT') options = Array.prototype.map.call(el.options, o => o.text + (o.value !== o.text ? ' (' + o.value + ')' : ''));
    return { label: lab ? lab.textContent.trim() : '', desc: desc ? desc.textContent.trim() : '', options, type: el.type || el.tagName.toLowerCase() };
  };
  const collapseTitle = (key) => { const h = document.querySelector('.epCollapseHeader[data-collapse="' + key + '"]'); return h ? h.textContent.replace('▶', '').trim() : null; };
  const walk = (node) => ({
    id: node.id, isTabRoot: !!node.isTabRoot, structural: !!node.structural, terminal: !!node.terminal,
    when: (node.when || []).map(condText),
    targets: (node.target || []).map(t => ({ id: t, collapse: collapseTitle(t) })),
    children: (node.children || []).map(walk)
  });
  const tabs = Array.prototype.map.call(document.querySelectorAll('.epTabBtn'), b => ({ key: b.dataset.tab, title: b.textContent.trim() }));
  const pages = {};
  tabs.forEach(t => {
    const page = document.querySelector('.epTabPage[data-tabpage="' + t.key + '"]');
    const intro = page ? Array.prototype.map.call(page.querySelectorAll('.epTabDescArea .epDesc'), d => d.textContent.trim()).filter(Boolean) : [];
    // field order as it appears on the page
    const ids = page ? Array.prototype.map.call(page.querySelectorAll('input[id], select[id]'), e => e.id).filter(id => fields[id]) : [];
    pages[t.key] = { intro, fieldOrder: ids };
  });
  const generalFields = Object.keys(fields).filter(id => fields[id].tab === 'general');
  const byTab = {};
  Object.keys(fields).forEach(id => { (byTab[fields[id].tab] = byTab[fields[id].tab] || []).push(id); });
  const fieldInfo = {};
  Object.keys(fields).forEach(id => { fieldInfo[id] = Object.assign({ def: fields[id].def, tab: fields[id].tab, kind: fields[id].type }, labelOf(id) || {}); });
  return { tabs, pages, tree: EP_TREE.map(walk), fields: fieldInfo, byTab, generalFields };
}
"""


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.add_init_script(STUBS)
        pg.goto(file_url(CONFIG_PAGE))
        pg.wait_for_timeout(400)
        pg.evaluate("() => document.getElementById('epRestoreAllBtn').click()")
        data = pg.evaluate(EXTRACT)
        b.close()

    fields = data['fields']
    counts = {t: len(v) for t, v in data['byTab'].items()}

    def esc(s):
        return html.escape(str(s))

    def field_row(fid):
        f = fields[fid]
        d = f.get('def')
        dtxt = ('on' if d else 'off') if f['kind'] == 'checkbox' else ('' if d in ('', None) else str(d))
        opts = ''
        if f.get('options'):
            opts = '<div class="opts">' + ' · '.join(esc(o) for o in f['options']) + '</div>'
        return (f'<li class="field {f["kind"]}"><span class="lab">{esc(f.get("label") or fid)}</span> '
                f'<code class="id">{esc(fid)}</code> <span class="def">default: {esc(dtxt)}</span>'
                f'{opts}<div class="desc">{esc(f.get("desc", ""))}</div></li>')

    def node_html(node, depth=0):
        cls = 'tabroot' if node['isTabRoot'] else ('structural' if node['structural'] else 'node')
        title = ', '.join((t['collapse'] or t['id']) for t in node['targets']) or node['id']
        when = ' &amp; '.join(esc(w) for w in node['when']) or 'always'
        kids = ''.join(node_html(c, depth + 1) for c in node['children'])
        return f'<li class="{cls}"><span class="ntitle">{esc(title)}</span> <span class="when">when {when}</span>{"<ul>" + kids + "</ul>" if kids else ""}</li>'

    parts = ['<!doctype html><meta charset="utf-8"><title>ArtworkPlus - plugin map</title>',
             '<style>body{font:13px/1.4 system-ui,sans-serif;background:#141414;color:#ddd;margin:0;padding:20px 28px}h1{font-size:20px}h2{margin:26px 0 6px;font-size:16px;color:#00a4dc}h3{margin:14px 0 4px;font-size:13px;color:#aaa}ul{list-style:none;padding-left:16px;margin:2px 0}li{margin:2px 0}.lab{font-weight:600}.id{color:#8fd;font-size:11px;margin-left:6px}.def{color:#fc8;margin-left:6px;font-size:11px}.desc{color:#888;font-size:11px}.opts{color:#9ad;font-size:11px}.when{color:#9c9;font-size:11px}.ntitle{font-weight:600}.tabroot>.ntitle{color:#00a4dc}.structural>.ntitle{color:#888;font-weight:400}.intro{color:#aaa;font-style:italic}.counts{color:#888}.two{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media(max-width:1100px){.two{grid-template-columns:1fr}}</style>',
             '<h1>ArtworkPlus - the whole frame</h1>',
             f'<p class="counts">Generated from the admin page: {len(fields)} settings in {len(data["tabs"])} tabs. Left: every setting in page order with label, id, default, options and description. Right: the gate tree (EP_TREE) - what is active when.</p>']
    parts.append('<h2>General switches (one per feature)</h2><ul>' + ''.join(field_row(f) for f in data['generalFields']) + '</ul>')
    tree_by_tab = {n['id']: n for n in data['tree'] if n['isTabRoot']}
    for tab in data['tabs']:
        key = tab['key']
        if key == 'general':
            continue
        page = data['pages'].get(key, {})
        parts.append(f'<h2>{esc(tab["title"])} <span class="counts">({counts.get(key, 0)} settings)</span></h2>')
        for line in page.get('intro', []):
            parts.append(f'<div class="intro">{esc(line)}</div>')
        parts.append('<div class="two"><div><h3>Settings (page order)</h3><ul>')
        seen = set()
        for fid in page.get('fieldOrder', []):
            if fid in seen:
                continue
            seen.add(fid)
            parts.append(field_row(fid))
        # fields of this tab that are not visible inputs (hidden proxies etc.)
        rest = [f for f in data['byTab'].get(key, []) if f not in seen]
        if rest:
            parts.append('<li class="counts">hidden/proxy fields: ' + ', '.join(esc(r) for r in rest) + '</li>')
        parts.append('</ul></div><div><h3>Gate tree</h3><ul>')
        roots = [n for n in data['tree'] if n['isTabRoot'] and n['id'] in (key,) or (n['isTabRoot'] and fields.get(n['when'][0].split(': ')[-1], {}).get('tab') == key if n['when'] else False)]
        # tab roots whose sub-roots belong to this tab (e.g. customposter has postercase/keyart roots)
        for n in data['tree']:
            if not n['isTabRoot']:
                continue
            ids = [i for w in n['when'] for i in re.findall(r'[A-Z][A-Za-z0-9_]+', w)]
            tabs_of = {fields[i]['tab'] for i in ids if i in fields}
            if n['id'] == key or (tabs_of and key in tabs_of and key != 'general'):
                parts.append(node_html(n))
            elif n['id'] in ('postercase', 'keyart') and key == 'customposter':
                parts.append(node_html(n))
            elif n['id'] in ('extraposterfeature', 'extrakeyart') and key == 'extraposter':
                parts.append(node_html(n))
            elif n['id'].startswith('backdrops') and key == 'backdrops' and n['id'] != 'backdrops':
                parts.append(node_html(n))
            elif n['id'] == 'peoplebackdrops' and key == 'backdrops':
                parts.append(node_html(n))
        parts.append('</ul></div></div>')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, 'w', encoding='utf-8').write('\n'.join(parts))
    print('written', OUT, '-', len(fields), 'settings', counts)


if __name__ == '__main__':
    main()
