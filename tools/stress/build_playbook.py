"""Stress test, step 3: the 30-minute navigation programme - one fixed script
(seeded) so both runs (vanilla / plugin) walk exactly the same path with
the same dwell times. Phases alternate between slow browsing (long dwells,
rotations visible, scrolling on library pages) and fast switching (2-3 s
per page, teardown/build stress). Writes tools/stress/playbook.json and
prints the totals.

    python tools/stress/build_playbook.py
"""
import json
import os
import random

D = os.path.dirname(__file__)
SERVER = '2204935da6dd468ea22bcdb66c12a43f'
LIB = {'movies': 'f137a2dd21bbc1b99aa5c0f6bf02a805', 'tv': '767bffe4f11c93ef34b805451a696a4e', 'collections': '9d7ad6afe9afa2dab1a2f6e00ad28fa6'}
GENRES = {'Abenteuer': '4dbf3d7f9153d351e9969c2c073264cc', 'Action': 'ce06903d834d2c3417e0889dd4049f3b'}
STUDIOS = {'20th Century Fox': 'da8c4e8ad6d11fba2241aebbf643bed7'}
TAG = 'Character Art'

tokens = open(os.path.join(D, 'fixtures_compact.txt'), encoding='utf-8').read().split()
movies, sets, persons, series = [], [], [], []
cur = None
for t in tokens:
    k, v = t[0], t[1:]
    if k == 'M':
        movies.append(v)
    elif k == 'B':
        sets.append(v)
    elif k == 'P':
        persons.append(v)
    elif k == 'S':
        cur = {'id': v, 'seasons': []}
        series.append(cur)
    elif k == 's':
        cur['seasons'].append({'id': v, 'eps': []})
    elif k == 'e':
        cur['seasons'][-1]['eps'].append(v)

rnd = random.Random(20260921)


def det(id_, kind):
    return {'k': kind, 'u': f'#/details?id={id_}&serverId={SERVER}'}


HOME = {'k': 'home', 'u': '#/home.html'}
FAV = {'k': 'favorites', 'u': '#/home.html?tab=1'}
MOVLIB = {'k': 'lib-movies', 'u': f'#/movies.html?topParentId={LIB["movies"]}&collectionType=movies', 'scroll': 1}
TVLIB = {'k': 'lib-tv', 'u': f'#/tv.html?topParentId={LIB["tv"]}&collectionType=tvshows', 'scroll': 1}
COLLIB = {'k': 'lib-collections', 'u': f'#/list.html?parentId={LIB["collections"]}&serverId={SERVER}', 'scroll': 1}


def genre(name):
    return {'k': 'genre', 'u': f'#/list.html?genreId={GENRES[name]}&serverId={SERVER}', 'scroll': 1}


def studio(name):
    return {'k': 'studio', 'u': f'#/list.html?studioId={STUDIOS[name]}&serverId={SERVER}', 'scroll': 1}


TAGPAGE = {'k': 'tag', 'u': f'#/list.html?type=tag&tag={TAG.replace(" ", "%20")}&serverId={SERVER}', 'scroll': 1}


def person_list(pid, kind='Movie'):
    return {'k': 'person-list', 'u': f'#/list.html?type={kind}&personId={pid}&serverId={SERVER}', 'scroll': 1}


steps = []


def add(step, dwell, phase):
    s = dict(step)
    s['d'] = int(dwell * 1000)
    s['p'] = phase
    steps.append(s)


mv = movies[:]
rnd.shuffle(mv)
pp = persons[:]
rnd.shuffle(pp)

# 1. slow start: home, movies library, three movies with a person detour each (~4 min)
add(HOME, 10, 'slow-start')
add(MOVLIB, 25, 'slow-start')
for i in range(3):
    add(det(mv[i], 'movie'), 22, 'slow-start')
    add(det(pp[i], 'person'), 14, 'slow-start')
    add(HOME, 6, 'slow-start')
    add(MOVLIB, 12, 'slow-start')
# 2. fast movie burst (~45 s)
for i in range(3, 15):
    add(det(mv[i], 'movie'), rnd.uniform(2.2, 3.2), 'fast-movies')
add(MOVLIB, 8, 'fast-movies')
add(HOME, 6, 'fast-movies')
# 3. slow TV (~5 min)
add(TVLIB, 22, 'slow-tv')
for s in series[:4]:
    add(det(s['id'], 'series'), 20, 'slow-tv')
    for se in s['seasons'][:1]:
        add(det(se['id'], 'season'), 12, 'slow-tv')
        for e in se['eps'][:2]:
            add(det(e, 'episode'), 10, 'slow-tv')
    add(TVLIB, 8, 'slow-tv')
# 4. fast TV burst (~70 s)
for s in series[4:12]:
    add(det(s['id'], 'series'), rnd.uniform(2.2, 3.0), 'fast-tv')
    se = s['seasons'][0] if s['seasons'] else None
    if se:
        add(det(se['id'], 'season'), rnd.uniform(2.0, 2.8), 'fast-tv')
        if se['eps']:
            add(det(se['eps'][0], 'episode'), rnd.uniform(2.0, 2.8), 'fast-tv')
add(HOME, 6, 'fast-tv')
# 5. people (~3.5 min): detail + filmography, cached and uncached mixed
for i in range(3, 11):
    add(det(pp[i], 'person'), 15, 'people')
    if i % 2 == 0:
        add(person_list(pp[i]), 9, 'people')
# 6. library pages with scrolling (~3 min)
add(COLLIB, 18, 'lists')
add(det(sets[0], 'set'), 16, 'lists')
add(det(sets[1], 'set'), 12, 'lists')
add(genre('Abenteuer'), 18, 'lists')
add(genre('Action'), 14, 'lists')
add(studio('20th Century Fox'), 16, 'lists')
add(TAGPAGE, 18, 'lists')
add(FAV, 14, 'lists')
add(HOME, 8, 'lists')
# 7. medium mix (~4 min)
mix = [det(m, 'movie') for m in mv[15:24]] + [det(s['id'], 'series') for s in series[:3]] + [det(p, 'person') for p in pp[:3]] + [MOVLIB, TVLIB, HOME]
rnd.shuffle(mix)
for st in mix:
    add(st, rnd.uniform(5, 9), 'medium-mix')
# 8. long dwell on three movies (rotations, backdrops) (~2 min)
for m in mv[:5]:
    add(det(m, 'movie'), 32, 'long-dwell')
    add(MOVLIB, 6, 'long-dwell')
# 8b. second slow TV round with seasons/episodes (~2.5 min)
for s in series[4:7]:
    add(det(s['id'], 'series'), 18, 'slow-tv-2')
    if s['seasons']:
        add(det(s['seasons'][-1]['id'], 'season'), 12, 'slow-tv-2')
        for e in s['seasons'][-1]['eps'][:2]:
            add(det(e, 'episode'), 9, 'slow-tv-2')
# 8c. more people (~1.5 min)
for i in range(11, 13):
    add(det(pp[i], 'person'), 15, 'people-2')
    add(person_list(pp[i], 'Series'), 9, 'people-2')
for i in range(0, 2):
    add(det(pp[i], 'person'), 12, 'people-2')
# 9. rapid random (~90 s)
pool = [det(m, 'movie') for m in mv] + [det(s['id'], 'series') for s in series] + [det(p, 'person') for p in pp] + [MOVLIB, TVLIB, HOME, COLLIB]
for i in range(40):
    add(rnd.choice(pool), rnd.uniform(1.8, 2.8), 'rapid-random')
# 10. cool-down (~1.5 min)
add(HOME, 12, 'cool-down')
add(MOVLIB, 20, 'cool-down')
add(det(mv[0], 'movie'), 30, 'cool-down')
add(HOME, 20, 'cool-down')

total = sum(s['d'] for s in steps) / 1000
json.dump({'server': SERVER, 'steps': steps}, open(os.path.join(D, 'playbook.json'), 'w', encoding='utf-8'), indent=0)
from collections import Counter
print(len(steps), 'steps,', round(total / 60, 1), 'minutes')
print('by phase (steps, s):', {p: (sum(1 for s in steps if s['p'] == p), round(sum(s['d'] for s in steps if s['p'] == p) / 1000)) for p in dict.fromkeys(s['p'] for s in steps)})
print('by page kind:', Counter(s['k'] for s in steps))
