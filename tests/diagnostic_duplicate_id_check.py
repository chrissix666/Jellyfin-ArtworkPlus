"""
Checks the whole configPage.html for duplicate id attributes.
A duplicate id is almost always a leftover row that was not removed during
a restructure (sub-collapse to feature level etc.) - document.getElementById()
then always returns the FIRST element while the user visually interacts
with the SECOND. Session 95, found at Animated Poster (the Session 90
restructure accidentally left the old Movies/TvShows-specific "Show on"
checkboxes in place when the new feature level got its own "Show on"
multi-checkbox with the same ID).
"""
import re
import sys
from collections import Counter

from _common import CONFIG_PAGE as PAGE_PATH

content = open(PAGE_PATH, encoding='utf-8').read()
ids = re.findall(r'\bid="([A-Za-z][\w]*)"', content)
counts = Counter(ids)
dupes = {k: v for k, v in counts.items() if v > 1}

print(f"id attributes checked: {len(ids)}")
print(f"Duplicate IDs found: {len(dupes)}")
for k, v in sorted(dupes.items()):
    print(f"  {k}: {v}x")
sys.exit(1 if dupes else 0)
