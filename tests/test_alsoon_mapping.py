"""Session 136: the "Also on" contract between the three layers.

Static checks, no browser:
  1. every page class the client can produce (libPageOf in Posters-v1.js)
     is either mapped by the server (AlsoOnAllowed in ExtraposterController.cs)
     or one of the fixed classes (library / dashboard / other);
  2. every property name the server's mapping can build (feature x kind x
     sub, BoxSet -> the Collections subs) exists in PluginConfiguration.cs,
     and every LibraryAlsoOn* property there is reachable by the mapping;
  3. every LibraryAlsoOn* property has its checkbox on the page and an
     EP_FIELDS entry with def: false (default off = library view only).
"""
import re
import sys

from _common import CONFIG_PAGE, PLUGIN_CONFIG_CS, POSTERS_JS, ROOT

controller = open(ROOT + '/Controllers/ExtraposterController.cs', encoding='utf-8').read()
config = open(PLUGIN_CONFIG_CS, encoding='utf-8').read()
page = open(CONFIG_PAGE, encoding='utf-8').read()
posters = open(POSTERS_JS, encoding='utf-8').read()

fails = []


def check(name, cond, detail=''):
    print(('ok   ' if cond else 'FAIL ') + name + ('' if cond else '  -> ' + detail))
    if not cond:
        fails.append(name)


# 1. client page classes vs server switch
client_fn = posters[posters.index('function libPageOf'):posters.index('window.__artworkPlusExtraPageOf')]
client_classes = set(re.findall(r"return '([a-z-]+)';", client_fn))
server_fn = controller[controller.index('internal static bool AlsoOnAllowed'):]
server_fn = server_fn[:server_fn.index('return property is not null')]
server_classes = set(re.findall(r'"([a-z-]+)" =>', server_fn))
fixed = {'library', 'dashboard', 'other'}
check('every client page class is mapped by the server or fixed', client_classes <= server_classes | fixed, str(client_classes - server_classes - fixed))
check('every server page class is producible by the client', server_classes <= client_classes, str(server_classes - client_classes))
check('the fixed classes are handled explicitly in the server', all(x in server_fn for x in ['page == "library"', 'page == "dashboard"', '_ => null']))

# 2. server mapping -> property names
subs = re.findall(r'"[a-z-]+" => (.+?),\n', server_fn)
names = set()
for expr in subs:
    for token in re.findall(r'"([A-Za-z]+)"', expr):
        names.add(token)
expected = set()
for feature in ('Extraposter', 'Extrakeyart'):
    for kind in ('Movies', 'TvShows'):
        for sub in names:
            # the kind-specific subs only exist on their kind
            if kind == 'Movies' and sub in ('FavoritesShows', 'SearchShows'):
                continue
            if kind == 'TvShows' and sub in ('FavoritesMovies', 'FavoritesCollections', 'SearchMovies', 'SearchCollections'):
                continue
            expected.add(feature + kind + 'LibraryAlsoOn' + sub)
present = set(re.findall(r'public bool (\w+LibraryAlsoOn\w+) \{ get; set; \}', config))
check('48 LibraryAlsoOn properties in C#, all default off', len(present) == 48 and not re.search(r'LibraryAlsoOn\w+ \{ get; set; \} = true', config), str(len(present)))
check('server mapping builds exactly the C# properties', expected == present, 'missing in C#: %s | unreachable: %s' % (sorted(expected - present)[:5], sorted(present - expected)[:5]))
check('the mapping reads the property by reflection with the same name pattern', 'feature + kind + "LibraryAlsoOn" + sub' in controller)
check('the batch endpoint takes the page parameter and filters after the cache', '[FromQuery] string? page' in controller and 'AlsoOnAllowed(config, pageClass, cachedResult)' in controller)

# 3. page: checkbox + EP_FIELDS def false
for name in sorted(present):
    if page.count('id="' + name + '"') != 1 or not re.search(name + r": \{ type: 'checkbox', def: false", page):
        fails.append(name)
        print('FAIL page wiring of ' + name)
check('every property has one checkbox and an EP_FIELDS entry with def: false', not [f for f in fails if f.startswith(('Extraposter', 'Extrakeyart'))])
check('the client sends the page class with every Extra batch', "'&scope=library&page=' + encodeURIComponent(page)" in posters)

print('RESULT ' + ('OK' if not fails else 'FAILED') + ' (%d failure(s))' % len(fails))
sys.exit(0 if not fails else 1)
