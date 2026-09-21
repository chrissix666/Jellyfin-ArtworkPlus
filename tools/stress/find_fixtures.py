"""Stress-test fixtures, step 1: which movie / series folders carry the full
programme (characterart + extraposter + animated poster/keyart files, plus
backdrops)? Scans the library drives one level deep (collections one level
deeper) and writes tools/stress/candidates.json - the item ids are matched
in the browser afterwards (find_fixtures step 2 in the stress runner).

    python tools/stress/find_fixtures.py
"""
import json
import os
import re

ROOTS = ['F:/', 'G:/', 'H:/', 'I:/', 'X:/MEDIA']
TV_ROOTS = ['X:/MEDIA', 'H:/', 'I:/']
OUT = os.path.join(os.path.dirname(__file__), 'candidates.json')
SUF = {
    # the user's library: every artwork file is prefixed "<folder name>-"
    'characterart': re.compile(r'-characterart\d*\.png$', re.I),
    'animated': re.compile(r'-animated(poster|keyart)\.gif$', re.I),
    'extraposter': re.compile(r'-poster\d+\.jpg$', re.I),        # Extraposter Prefixed = "<name>-poster1.jpg", numbered
    'extrakeyart': re.compile(r'-keyart\d+\.jpg$', re.I),
    'postercase': re.compile(r'-postercase\.jpg$', re.I),
    'keyart': re.compile(r'-keyart\.jpg$', re.I),
    'backdrops': re.compile(r'-(backdrop|fanart)\d*\.jpg$', re.I),
    'clearart': re.compile(r'-clearart\.png$', re.I),
    'logo': re.compile(r'-clearlogo\.png$', re.I),
}


def scan(folder):
    try:
        names = os.listdir(folder)
    except Exception:
        return None
    d = {k: 0 for k in SUF}
    d['seasons'] = 0
    for n in names:
        for k, rx in SUF.items():
            if rx.search(n):
                d[k] += 1
        if re.match(r'^(Season|Staffel|Specials) ?\d*', n, re.I):
            d['seasons'] += 1
    return d


def full(d):
    return d and d['characterart'] and d['extraposter'] and d['animated']


movies, series = {}, {}
for r in ROOTS:
    try:
        entries = [e for e in os.scandir(r) if e.is_dir()]
    except Exception as ex:
        print('skip', r, ex)
        continue
    for e in entries:
        d = scan(e.path)
        if not d:
            continue
        if d['seasons']:
            if d['characterart'] and d['extraposter']:
                series[e.path] = d
            continue
        if full(d):
            movies[e.path] = d
        elif 'Filmreihe' in e.name or 'Collection' in e.name:
            try:
                for sub in os.scandir(e.path):
                    if sub.is_dir():
                        dd = scan(sub.path)
                        if full(dd):
                            movies[sub.path] = dd
            except Exception:
                pass
json.dump({'movies': movies, 'series': series}, open(OUT, 'w', encoding='utf-8'), indent=0, ensure_ascii=False)
print(len(movies), 'movie folders with characterart + extraposter + animated;', len(series), 'series folders with characterart + extraposter')
for p, d in list(movies.items())[:8]:
    print(' M', p, {k: v for k, v in d.items() if v})
for p, d in list(series.items())[:8]:
    print(' S', p, {k: v for k, v in d.items() if v})
