"""Session 122: every batch endpoint that answers with a Dictionary keyed by
item id must key it with Guid.ToString("N") - the tile's data-id form
(Jellyfin's JsonGuidConverter writes Guids as 32 hex, no dashes, but string
dictionary keys bypass that converter). A dashed key never matched a tile,
which is why no library view ever worked (Sessions 88-121).

Also checks the client: every batch response is read with the keys
normalised (id.replace(/-/g, '')) so an older server build still works.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
errors = []

for cs in (ROOT / 'Controllers').glob('*.cs'):
    text = cs.read_text(encoding='utf-8')
    for m in re.finditer(r'\.Items\[(\w+)\.ToString\((.*?)\)\]', text):
        if m.group(2).strip() != '"N"':
            line = text.count('\n', 0, m.start()) + 1
            errors.append(f'{cs.name}:{line}: batch key uses ToString({m.group(2)}) - must be ToString("N")')

js = (ROOT / 'Jellyfin-ArtworkPlus-Posters-v1.js').read_text(encoding='utf-8')
for m in re.finditer(r'var items = batchResponse\.Items \|\| \{\};', js):
    window = js[m.end():m.end() + 400]
    if "replace(/-/g, '')" not in window:
        line = js.count('\n', 0, m.start()) + 1
        errors.append(f'Posters-v1.js:{line}: batch keys read without dash normalisation')

if errors:
    print('\n'.join(errors)); sys.exit(1)
print('batch key format OK (server "N" keys, client normalised)')
