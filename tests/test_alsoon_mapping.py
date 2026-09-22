"""Session 140 (Sessions 136-139 before): the "Show also on" contract between the
three layers (docs/artworkplus-alsoon-concept.md).

Static checks, no browser:
  1. every page class the client can produce (pageClassOf in Posters-v1.js)
     is mapped by Helpers/AlsoOn.AreaOf or one of the fixed classes
     (library / dashboard / other), and every mapped class is producible;
  2. the C# properties are exactly the concept's menus: per feature and block
     one set per item kind - Movies (11 areas), Sets (5), Shows (10) - 156 in
     total, all default off; the helper builds names with that pattern;
  3. every property has one checkbox on the page and an EP_FIELDS entry
     with def: false; the page's menus hold exactly the concept's areas;
  4. the gate sites: Extra filters the cached answer on the way out with the
     helper (grid switch or box), Custom / Animated pass the page into the
     resolver, the flags count the boxes, the client sends page= per batch.
"""
import re
import sys

from _common import CONFIG_PAGE, PLUGIN_CONFIG_CS, POSTERS_JS, ROOT

controller = open(ROOT + '/Controllers/ExtraposterController.cs', encoding='utf-8').read()
helper = open(ROOT + '/Helpers/AlsoOn.cs', encoding='utf-8').read()
custom = open(ROOT + '/Controllers/CustomPosterController.cs', encoding='utf-8').read()
animated = open(ROOT + '/Controllers/AnimatedPosterController.cs', encoding='utf-8').read()
registrar = open(ROOT + '/FileTransformation/FileTransformationRegistrar.cs', encoding='utf-8').read()
config = open(PLUGIN_CONFIG_CS, encoding='utf-8').read()
page = open(CONFIG_PAGE, encoding='utf-8').read()
posters = open(POSTERS_JS, encoding='utf-8').read()

fails = []


def check(name, cond, detail=''):
    print(('ok   ' if cond else 'FAIL ') + name + ('' if cond else '  -> ' + detail))
    if not cond:
        fails.append(name)


FEATURES = ('Extraposter', 'Extrakeyart', 'Postercase', 'Keyart', 'AnimatedPoster', 'AnimatedKeyart')
ALL_AREAS = ['Favorites', 'Search', 'HomeRecentlyAdded', 'HomeContinueWatching', 'ListsGenre', 'ListsStudio', 'ListsTag', 'ListsFolderMore', 'DetailMoreLikeThis', 'DetailSetMembers', 'DetailPeoplePages']
# concept Part A: where each item kind appears
AREAS = {
    'Movies': ALL_AREAS,
    'Sets': ['Favorites', 'Search', 'ListsStudio', 'ListsTag', 'ListsFolderMore'],
    'Shows': [a for a in ALL_AREAS if a != 'HomeContinueWatching'],
}
MENUS = {'Movies': ['Movies', 'Sets'], 'TvShows': ['Shows']}

# 1. client page classes vs the helper's area map
client_fn = posters[posters.index('function pageClassOf'):posters.index('window.__artworkPlusExtraPageOf')]
client_classes = set(re.findall(r"return '([a-z-]+)';", client_fn))
area_fn = helper[helper.index('public static string? AreaOf'):helper.index('public static bool Allowed')]
server_classes = set(re.findall(r'"([a-z-]+)" =>', area_fn))
server_areas = set(re.findall(r'=> "(\w+)"', area_fn))
fixed = {'library', 'dashboard', 'other'}
check('every client page class is mapped by the helper or fixed', client_classes <= server_classes | fixed, str(client_classes - server_classes - fixed))
check('every helper page class is producible by the client', server_classes <= client_classes, str(server_classes - client_classes))
check('the helper maps the 11 concept areas and nothing else', server_areas == set(ALL_AREAS), str(server_areas ^ set(ALL_AREAS)))
allowed_fn = helper[helper.index('public static bool Allowed'):helper.index('public static bool AnyBox')]
check('the fixed classes: library / empty -> the grid switch, dashboard -> never, unknown -> never',
      'page == "library"' in allowed_fn and '"LibraryEnabled"' in allowed_fn and 'page == "dashboard"' in allowed_fn and 'if (area is null) { return false; }' in allowed_fn)

# 2. properties = the concept's menus
expected = set()
for feature in FEATURES:
    for kind, items in MENUS.items():
        for item in items:
            for area in AREAS[item]:
                expected.add(feature + kind + 'LibraryAlsoOn' + item + area)
present = set(re.findall(r'public bool (\w+LibraryAlsoOn\w+) \{ get; set; \}', config))
check('156 LibraryAlsoOn properties in C# (6 features x (11 Movies + 5 Sets + 10 Shows)), all default off', len(present) == 156 and not re.search(r'LibraryAlsoOn\w+ \{ get; set; \} = true', config), str(len(present)))
check('the properties are exactly the concept menus (Sets: Favorites, Search, Studio, Tag, Folder & More; Shows: no Continue Watching)', expected == present, 'missing: %s | extra: %s' % (sorted(expected - present)[:4], sorted(present - expected)[:4]))
check('the helper builds the names with the feature + kind + "LibraryAlsoOn" + item + area pattern', 'feature + kind + "LibraryAlsoOn" + item + area' in allowed_fn and '"Series" ? "Shows" : itemKind == "BoxSet" ? "Sets" : "Movies"' in allowed_fn)

# 3. page wiring
for name in sorted(present):
    if page.count('id="' + name + '"') != 1 or not re.search(name + r": \{ type: 'checkbox', def: false", page):
        fails.append(name)
        print('FAIL page wiring of ' + name)
check('every property has one checkbox and an EP_FIELDS entry with def: false', not [f for f in fails if f.startswith(FEATURES)])
menus = re.findall(r'data-collapse="(\w+?)(Movies|TvShows)AlsoOn(Movies|Sets|Shows)"', page)
check('18 menus on the page: two per Movies block (Movies, Sets), one per TV block (Shows)',
      len(menus) == 18 and all((k == 'Movies') == (i in ('Movies', 'Sets')) for _f, k, i in menus), str(len(menus)))
# every menu body holds exactly its item's boxes, in the concept order
bad = []
for keyp, kind, item in menus:
    seg = page[page.index('data-collapsebody="' + keyp + kind + 'AlsoOn' + item + '"'):]
    nxt = min([x for x in (seg.find('data-collapse=', 20), seg.find('LibraryFields">'), seg.find('epCollapseHeader', 20), seg.find('DependentFields">')) if x != -1] + [len(seg)])
    ids = [i for i in re.findall(r'id="(\w+LibraryAlsoOn\w+)"', seg[:nxt]) if not i.endswith('Row')]
    got = [i[i.index('LibraryAlsoOn') + len('LibraryAlsoOn'):] for i in ids]
    want = [item + a for a in AREAS[item]]
    if got != want:
        bad.append((keyp + kind + item, got))
check('every menu body holds exactly its item kind\'s areas in the concept order', not bad, str(bad[:2]))

# 4. gate sites
check('Extra filters the cached answer on the way out with the helper (page or grid switch)', 'AlsoOnAllowed(config, pageClass, cachedResult)' in controller and 'Helpers.AlsoOn.Allowed(config, page, result.ResolvedType == "extrakeyart" ? "Extrakeyart" : "Extraposter", result.ItemKind)' in controller)
check('Extra\'s cached library resolution no longer reads the view Enable (the gate moved out)', not re.search(r'isLibraryScope \? config\.Extra\w+LibraryEnabled', controller) and controller.count('(isLibraryScope ? true : config.') == 6)
check('Custom and Animated pass the page into the resolver and read the helper for the library scope',
      all('isLibraryScope ? pageClass : null' in c and c.count('Helpers.AlsoOn.Allowed(config, page, "') == 6 for c in (custom, animated)))
check('the tile flags expect a participant when a grid switch OR any box is on', registrar.count('Helpers.AlsoOn.AnyBox(config, "') == 12)
check('the client sends the page class with every batch and caches per class',
      "'&scope=library&page=' + encodeURIComponent(page)" in posters and "options.batchUrl(chunk) + '&page=' + encodeURIComponent(page)" in posters and "resultCache[page + '|' + id.replace(/-/g, '')] = items[id]" in posters)

print('RESULT ' + ('OK' if not fails else 'FAILED') + ' (%d failure(s))' % len(fails))
sys.exit(0 if not fails else 1)
