"""Stress fixtures, step 2: pick the candidate folders / persons and write
fixture_request.json (folders + names) - the ids are resolved in the browser."""
import json
import os

D = os.path.dirname(__file__)
d = json.load(open(os.path.join(D, 'candidates.json'), encoding='utf-8'))
p = json.load(open(os.path.join(D, 'candidates_people.json'), encoding='utf-8'))
movies = [k.replace('\\', '/') for k in d['movies']]
series_full = [k.replace('\\', '/') for k in d['series']]
partial = sorted(d['series_partial'].items(), key=lambda kv: -(kv[1]['characterart'] + kv[1]['extraposter']))
series_more = [k.replace('\\', '/') for k, v in partial if k.replace('\\', '/') not in series_full][:9]
persons = p['cached'][:8] + p['nocache'][:8]
req = {'movies': movies[:24], 'series': series_full + series_more, 'persons': persons}
json.dump(req, open(os.path.join(D, 'fixture_request.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print(len(req['movies']), 'movies,', len(req['series']), 'series,', len(req['persons']), 'persons')
print(json.dumps(req, ensure_ascii=False))
