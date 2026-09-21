"""
Session 134: the bundled LogoArt font pools (Fonts/fonts.json + files).
Gates: every manifest entry exists as a file and vice versa, 60 + 60,
punctuation complete in every font (concept D4), the csproj ships the
folder, the licence texts are present for the Google fonts, and the
Persons defaults in the C# config / EP_FIELDS name a pool that exists.
"""
import json
import os
import re
import sys

from _common import ROOT, CONFIG_PAGE, PLUGIN_CONFIG_CS

FONTS = os.path.join(ROOT, 'Fonts')
results = []


def check(name, cond, detail=''):
    results.append(('PASS' if cond else 'FAIL', name, detail))


manifest = json.load(open(os.path.join(FONTS, 'fonts.json'), encoding='utf-8'))
by_group = {}
for m in manifest:
    by_group.setdefault(m['group'], []).append(m)
check('manifest: 60 signature + 60 title', len(by_group.get('signature', [])) == 60 and len(by_group.get('title', [])) == 60,
      str({k: len(v) for k, v in by_group.items()}))
missing = [m['file'] for m in manifest if not os.path.isfile(os.path.join(FONTS, m['file'].replace('/', os.sep)))]
check('manifest: every listed file exists', not missing, str(missing[:5]))
on_disk = set()
for group in ('Signature', 'Title'):
    for f in os.listdir(os.path.join(FONTS, group)):
        on_disk.add(group + '/' + f)
listed = set(m['file'] for m in manifest)
check('manifest: no font file outside the manifest', on_disk == listed, str(sorted(on_disk ^ listed)[:5]))
check('manifest: one extension (.otf) for the whole pool', all(f.endswith('.otf') for f in on_disk), str([f for f in on_disk if not f.endswith('.otf')][:5]))
check('manifest: punctuation complete in every font', all(m['punctuation'] for m in manifest), str([m['family'] for m in manifest if not m['punctuation']]))
check('manifest: unique families', len(set(m['family'].lower() for m in manifest)) == len(manifest))
check('manifest: every entry names a licence', all(m.get('licence') for m in manifest))
check('licence texts shipped for the Google fonts', os.path.isfile(os.path.join(FONTS, 'LICENSE-OFL.txt')) and os.path.isfile(os.path.join(FONTS, 'LICENSE-Apache.txt')))
lic = set(m['licence'] for m in manifest)
check('licences are OFL / Apache / user decision only', lic <= {'SIL OFL 1.1', 'Apache 2.0', 'no licence stated (user decision 2026-09-20)'}, str(lic))

csproj = open(os.path.join(ROOT, 'ArtworkPlus.csproj'), encoding='utf-8').read()
check('csproj ships Fonts\\**\\*.otf + fonts.json + licences next to the DLL',
      'Fonts\\**\\*.otf' in csproj and 'Fonts\\fonts.json' in csproj and 'Fonts\\LICENSE-*.txt' in csproj)
check('csproj references SkiaSharp 2.88.9 without runtime assets', re.search(r'Include="SkiaSharp" Version="2\.88\.9" ExcludeAssets="runtime"', csproj) is not None)

cs = open(PLUGIN_CONFIG_CS, encoding='utf-8').read()
page = open(CONFIG_PAGE, encoding='utf-8').read()
pool_cs = re.search(r'LogoArtPersonsFontPool \{ get; set; \} = "(\w+)"', cs)
pool_js = re.search(r"LogoArtPersonsFontPool: \{ type: 'select', def: '(\w+)'", page)
check('Persons default pool exists in the manifest (C# and EP_FIELDS agree)',
      pool_cs and pool_js and pool_cs.group(1) == pool_js.group(1) and pool_cs.group(1).lower() in by_group,
      str((pool_cs and pool_cs.group(1), pool_js and pool_js.group(1))))
check('Persons default fonts = "*" (every font of the pool)', 'LogoArtPersonsFonts { get; set; } = "*"' in cs and "LogoArtPersonsFonts: { type: 'text', def: '*'" in page)
check('font endpoint whitelists through the manifest', 'Manifest().Any(f => string.Equals(f.File, rel' in open(os.path.join(ROOT, 'Controllers', 'LogoArtController.cs'), encoding='utf-8').read())

for status, name, detail in results:
    print(f"[{status}] {name}" + (f"  ({detail})" if detail and status == 'FAIL' else ''))
passed = sum(1 for r in results if r[0] == 'PASS')
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
