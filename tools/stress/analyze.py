"""Stress test, step 5: compare two recorded runs (gzip+base64 exports of the
in-page runner) and write results/report.md + results/report.html.

    python tools/stress/analyze.py results/vanilla.b64 results/plugin.b64

Per page kind and per phase: median / p95 of time-to-image, time-to-backdrop,
time-to-logo, settle; long-task ms, frame gaps, requests / KB, DOM nodes,
leftovers, heap. Delta = plugin - vanilla (absolute and %). The score is a
plain, explained sum: main-thread ms (long tasks) + frame-gap ms per minute of
run time - the two numbers a user feels as "lag".
"""
import base64
import gzip
import json
import os
import statistics
import sys
from collections import defaultdict

D = os.path.dirname(__file__)


def load(path):
    """Accepts the runner's {label, results:[{...}]} JSON, its gzip+base64
    export, or the compact {label, keys, rows:[[...]]} dump that the page
    transport of Session 135 produced (rows are expanded to dicts)."""
    raw = open(path, 'rb').read().strip()
    data = gzip.decompress(base64.b64decode(raw)) if not raw.startswith(b'{') else raw
    obj = json.loads(data)
    if 'rows' in obj and 'results' not in obj:
        keys = obj['keys']
        obj['results'] = [dict(zip(keys, row)) for row in obj['rows']]
    return obj


def med(xs):
    xs = [x for x in xs if x is not None and x >= 0]
    return round(statistics.median(xs)) if xs else None


def p95(xs):
    xs = sorted(x for x in xs if x is not None and x >= 0)
    return xs[min(len(xs) - 1, int(len(xs) * 0.95))] if xs else None


def summarize(results, key):
    groups = defaultdict(list)
    for r in results:
        groups[r[key]].append(r)
    out = {}
    for g, rs in groups.items():
        n = len(rs)
        secs = sum(r['d'] for r in rs) / 1000
        out[g] = {
            'n': n, 'sec': round(secs),
            'tImg': med([r['tImg'] for r in rs]), 'tImg95': p95([r['tImg'] for r in rs]),
            'tBd': med([r['tBd'] for r in rs]), 'tBd95': p95([r['tBd'] for r in rs]),
            'tLogo': med([r['tLogo'] for r in rs]),
            'tSettle': med([r['tSettle'] for r in rs]), 'tSettle95': p95([r['tSettle'] for r in rs]),
            'ltMs': sum(r['ltMs'] for r in rs), 'ltMsPerMin': round(sum(r['ltMs'] for r in rs) / max(secs / 60, 0.01)),
            'ltMax': max(r['ltMax'] for r in rs),
            'gapMs': sum(r['gapMs'] for r in rs), 'gapMsPerMin': round(sum(r['gapMs'] for r in rs) / max(secs / 60, 0.01)),
            'sgapMs': sum(r['sgapMs'] for r in rs),
            'req': round(sum(r['req'] for r in rs) / n, 1), 'kb': round(sum(r['kb'] for r in rs) / n), 'plug': round(sum(r['plug'] for r in rs) / n, 1),
            'nodes': med([r['nodes'] for r in rs]), 'left': sum(r['left'] for r in rs),
            'heapEnd': rs[-1]['heap'], 'err': sum(r['err'] for r in rs),
        }
    return out


def delta(a, b):
    if a is None or b is None:
        return ''
    d = b - a
    pct = (d / a * 100) if a else 0
    return f'{d:+.0f} ({pct:+.0f}%)' if a else f'{d:+.0f}'


def main():
    va = load(sys.argv[1])
    pl = load(sys.argv[2])
    out_dir = os.path.join(D, 'results')
    os.makedirs(out_dir, exist_ok=True)
    va_r, pl_r = va['results'], pl['results']
    n = min(len(va_r), len(pl_r))
    va_r, pl_r = va_r[:n], pl_r[:n]
    lines = ['# ArtworkPlus stress test - vanilla vs plugin (everything on)', '',
             f'Steps compared: {n} (vanilla {len(va["results"])}, plugin {len(pl["results"])}); run time vanilla {round(sum(r["d"] for r in va_r) / 60000, 1)} min, plugin {round(sum(r["d"] for r in pl_r) / 60000, 1)} min.',
             '', 'Score = long-task ms per minute + frame-gap ms per minute (main-thread busy time and dropped-frame time - the two things a person feels as lag). Lower is better.', '']

    def table(title, key):
        sv, sp = summarize(va_r, key), summarize(pl_r, key)
        lines.append(f'## By {title}')
        lines.append('')
        lines.append('| ' + title + ' | n | vanilla score | plugin score | delta | tImg med (v/p) | tBd med (v/p) | tLogo med (v/p) | settle med (v/p) | long tasks ms (v/p) | max task (v/p) | gaps ms (v/p) | scroll gaps ms (v/p) | req/page (v/p) | KB/page (v/p) | plugin req/page | nodes (v/p) | leftovers | heap end MB (v/p) | errors (v/p) |')
        lines.append('|' + '---|' * 20)
        for g in sorted(set(sv) | set(sp), key=lambda x: str(x)):
            a, b = sv.get(g), sp.get(g)
            if not a or not b:
                continue
            sa, sb = a['ltMsPerMin'] + a['gapMsPerMin'], b['ltMsPerMin'] + b['gapMsPerMin']
            lines.append(f"| {g} | {a['n']} | {sa} | {sb} | {delta(sa, sb)} | {a['tImg']}/{b['tImg']} | {a['tBd']}/{b['tBd']} | {a['tLogo']}/{b['tLogo']} | {a['tSettle']}/{b['tSettle']} | {a['ltMs']}/{b['ltMs']} | {a['ltMax']}/{b['ltMax']} | {a['gapMs']}/{b['gapMs']} | {a['sgapMs']}/{b['sgapMs']} | {a['req']}/{b['req']} | {a['kb']}/{b['kb']} | {b['plug']} | {a['nodes']}/{b['nodes']} | {b['left']} | {a['heapEnd']}/{b['heapEnd']} | {a['err']}/{b['err']} |")
        lines.append('')

    table('page kind', 'k')
    table('phase', 'p')
    # totals
    tot_v = {'lt': sum(r['ltMs'] for r in va_r), 'gap': sum(r['gapMs'] for r in va_r), 'req': sum(r['req'] for r in va_r), 'kb': sum(r['kb'] for r in va_r), 'plug': sum(r['plug'] for r in va_r), 'err': sum(r['err'] for r in va_r), 'heap': max(r['heap'] for r in va_r)}
    tot_p = {'lt': sum(r['ltMs'] for r in pl_r), 'gap': sum(r['gapMs'] for r in pl_r), 'req': sum(r['req'] for r in pl_r), 'kb': sum(r['kb'] for r in pl_r), 'plug': sum(r['plug'] for r in pl_r), 'err': sum(r['err'] for r in pl_r), 'heap': max(r['heap'] for r in pl_r)}
    lines.append('## Totals')
    lines.append('')
    lines.append('| | vanilla | plugin | delta |')
    lines.append('|---|---|---|---|')
    for k, label in [('lt', 'long-task ms'), ('gap', 'frame-gap ms'), ('req', 'requests'), ('kb', 'KB transferred'), ('plug', 'plugin endpoint requests'), ('err', 'console errors'), ('heap', 'peak JS heap MB')]:
        lines.append(f'| {label} | {tot_v[k]} | {tot_p[k]} | {delta(tot_v[k], tot_p[k])} |')
    lines.append('')
    # worst steps in the plugin run
    lines.append('## Heaviest plugin steps (long-task ms + gap ms)')
    lines.append('')
    lines.append('| # | kind | phase | long tasks ms | max task | gaps ms | req | KB | plugin req | tImg | tBd | tSettle |')
    lines.append('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for r in sorted(pl_r, key=lambda r: -(r['ltMs'] + r['gapMs']))[:15]:
        lines.append(f"| {r['i']} | {r['k']} | {r['p']} | {r['ltMs']} | {r['ltMax']} | {r['gapMs']} | {r['req']} | {r['kb']} | {r['plug']} | {r['tImg']} | {r['tBd']} | {r['tSettle']} |")
    lines.append('')
    # heap trend
    lines.append('## JS heap over the run (MB, every 10th step)')
    lines.append('')
    lines.append('| step | vanilla | plugin |')
    lines.append('|---|---|---|')
    for i in range(0, n, 10):
        lines.append(f"| {i} | {va_r[i]['heap']} | {pl_r[i]['heap']} |")
    md = '\n'.join(lines)
    open(os.path.join(out_dir, 'report.md'), 'w', encoding='utf-8').write(md)
    json.dump({'vanilla': va_r, 'plugin': pl_r}, open(os.path.join(out_dir, 'runs.json'), 'w', encoding='utf-8'))
    print(md[:3000])
    print('...written', os.path.join(out_dir, 'report.md'))


if __name__ == '__main__':
    main()
