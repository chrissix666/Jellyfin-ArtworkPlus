"""
Compares EVERY EP_FIELDS default (configPage.html) against the matching
C# property (PluginConfiguration.cs). No Playwright needed, pure text
comparison. Session 28.
"""
import re
import sys

from _common import CONFIG_PAGE as HTML_PATH, PLUGIN_CONFIG_CS as CS_PATH

html = open(HTML_PATH, encoding='utf-8').read()
ep_fields_block = re.search(r'var EP_FIELDS = \{(.*?)\n            \};', html, re.DOTALL).group(1)
js_fields = {}
for m in re.finditer(r"(\w+):\s*\{\s*type:\s*'(\w+)',\s*def:\s*('[^']*'|-?[\d.]+|true|false),", ep_fields_block):
    js_fields[m.group(1)] = (m.group(2), m.group(3))

cs = open(CS_PATH, encoding='utf-8').read()
cs_fields = {}
for m in re.finditer(r"public\s+(bool|int|double|string)\s+(\w+)\s*\{\s*get;\s*set;\s*\}(?:\s*=\s*([^;]+);)?", cs):
    cs_fields[m.group(2)] = (m.group(1), m.group(3).strip() if m.group(3) else None)

mismatches = []
missing_in_cs = []
for name, (ftype, jsdef) in js_fields.items():
    if name not in cs_fields:
        missing_in_cs.append(name)
        continue
    cstype, csdef = cs_fields[name]
    if ftype == 'checkbox':
        js_bool = jsdef == 'true'
        cs_bool = (csdef == 'true') if csdef else False
        if js_bool != cs_bool:
            mismatches.append(f"{name}: JS def={jsdef} vs C# ={csdef!r}")
    elif ftype == 'number':
        js_num = jsdef.strip("'")
        if js_num == '':
            continue
        cs_num = (csdef or '0').rstrip('d ').strip()
        try:
            if float(js_num) != float(cs_num):
                mismatches.append(f"{name}: JS def={js_num} vs C# ={cs_num}")
        except ValueError:
            mismatches.append(f"{name}: JS def={js_num!r} vs C# ={csdef!r} (not numeric)")
    elif ftype in ('text', 'select'):
        js_str = jsdef.strip("'")
        cs_str = (csdef or '').strip('"')
        if cs_str == 'string.Empty':
            cs_str = ''
        if js_str != cs_str:
            mismatches.append(f"{name}: JS def={js_str!r} vs C# ={cs_str!r}")

print(f"JS fields: {len(js_fields)}, C# properties: {len(cs_fields)}")
print(f"Missing C# properties: {len(missing_in_cs)}")
for x in missing_in_cs: print(" ", x)
print(f"Default mismatches: {len(mismatches)}")
for x in mismatches: print(" ", x)

sys.exit(1 if (missing_in_cs or mismatches) else 0)
