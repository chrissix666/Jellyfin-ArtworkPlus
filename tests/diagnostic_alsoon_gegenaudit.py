"""Counter-audit (independent derivation): simulate the server switch for every
page class x (movie | series | boxset) x feature and check that the property it
reads sits in the page row whose GROUP and whose visible CHECKBOX LABEL mean the
same thing as the class. Also: the visible labels of all 20 rows, and that no
page class is served by two checkboxes."""
import os
import re
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
ctrl = open(os.path.join(ROOT, 'Controllers', 'ExtraposterController.cs'), encoding='utf-8').read()
page = open(os.path.join(ROOT, 'Configuration', 'configPage.html'), encoding='utf-8').read()

fn = ctrl[ctrl.index('internal static bool AlsoOnAllowed'):]
fn = fn[:fn.index('return property is not null')]
arms = dict(re.findall(r'"([a-z-]+)" => (.+?),\n', fn))


def sub_for(cls, tv, boxset):
    expr = arms[cls]
    if '?' not in expr:
        return expr.strip('"')
    # tv ? "A" : (boxSet ? "B" : "C")
    m = re.match(r'tv \? "(\w+)" : \(boxSet \? "(\w+)" : "(\w+)"\)', expr)
    return m.group(1) if tv else (m.group(2) if boxset else m.group(3))


# page rows: id -> (group label, [(checkbox id, label)])
rows = {}
for m in re.finditer(r'<div class="epRow epRowMerged" id="(\w+LibraryAlsoOn\w+)Row">(.*?)<div class="epDesc">', page, re.S):
    label = re.search(r'epRowLabelSpan">([^<]+)<', m.group(2)).group(1)
    boxes = re.findall(r'id="(\w+)"[^>]*/> <span class="checkboxLabel">([^<]+)<', m.group(2))
    rows[m.group(1)] = (label, boxes)
print('rows:', len(rows))
for rid, (label, boxes) in rows.items():
    print(' ', rid, '|', label, '|', ', '.join(b[1] for b in boxes))

EXPECT_GROUP = {'home-recent': 'Also on Home', 'home-resume': 'Also on Home', 'favorites': 'Also on Favorites',
                'list-genre': 'Also on Lists', 'list-studio': 'Also on Lists', 'list-tag': 'Also on Lists', 'list-other': 'Also on Lists',
                'search': 'Also on Search', 'detail-similar': 'Also on Detail pages', 'detail-collection': 'Also on Detail pages', 'detail-person': 'Also on Detail pages'}
EXPECT_LABEL = {'home-recent': 'Recently added', 'home-resume': 'Continue Watching', 'list-genre': 'Genre', 'list-studio': 'Studio', 'list-tag': 'Tag',
                'list-other': 'Folder &amp; More', 'detail-similar': 'More like this', 'detail-collection': 'Collection members', 'detail-person': 'Person pages'}
problems = []
used = {}
for feature in ('Extraposter', 'Extrakeyart'):
    for kind_name, tv, boxset in (('movie', False, False), ('series', True, False), ('boxset', False, True)):
        kind = 'TvShows' if tv else 'Movies'
        for cls in arms:
            sub = sub_for(cls, tv, boxset)
            prop = feature + kind + 'LibraryAlsoOn' + sub
            row = next(((rid, r) for rid, r in rows.items() if any(b[0] == prop for b in r[1])), None)
            if not row:
                problems.append(f'{cls} {feature} {kind_name}: property {prop} has no checkbox'); continue
            rid, (glabel, boxes) = row
            blabel = next(b[1] for b in boxes if b[0] == prop)
            if glabel != EXPECT_GROUP[cls]:
                problems.append(f'{cls} {feature} {kind_name}: group {glabel!r} != {EXPECT_GROUP[cls]!r}')
            want = EXPECT_LABEL.get(cls) or ('Shows' if tv else ('Collections' if boxset else 'Movies'))
            if blabel != want:
                problems.append(f'{cls} {feature} {kind_name}: label {blabel!r} != {want!r}')
            if not rid.startswith(feature + kind):
                problems.append(f'{cls} {feature} {kind_name}: row {rid} belongs to another view')
            used.setdefault((feature, kind_name, cls), set()).add(prop)
multi = {k: v for k, v in used.items() if len(v) != 1}
if multi: problems.append(f'classes served by several checkboxes: {multi}')
# every checkbox reachable by at least one (class, kind)
reach = set(p for v in used.values() for p in v)
allboxes = set(b[0] for r in rows.values() for b in r[1])
if allboxes - reach: problems.append(f'unreachable checkboxes: {sorted(allboxes - reach)}')
print('combinations simulated:', len(used), '| checkboxes:', len(allboxes), '| reachable:', len(reach))
print('COUNTER-AUDIT ' + ('OK' if not problems else 'FAILED'))
for p in problems: print('  ', p)
