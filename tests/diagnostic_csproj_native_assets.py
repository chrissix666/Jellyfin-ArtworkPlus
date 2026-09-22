"""Audit S4-03 (Session 138): the host ships SkiaSharp and its native libraries;
the plugin must reference SkiaSharp compile-only AND without native assets,
otherwise 39 MB of libSkiaSharp.* land in the build output (and in any zip
made from it - the "native DLL loaded as managed -> Malfunctioned" class)."""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
csproj = open(os.path.join(ROOT, 'ArtworkPlus.csproj'), encoding='utf-8').read()
fails = []
m = re.search(r'<PackageReference Include="SkiaSharp"[^>]*ExcludeAssets="([^"]*)"', csproj)
if not m or 'runtime' not in m.group(1) or 'native' not in m.group(1):
    fails.append('SkiaSharp reference must carry ExcludeAssets="runtime;native"')
out = os.path.join(ROOT, 'bin', 'Release', 'net8.0')
if os.path.isdir(out) and os.path.isdir(os.path.join(out, 'runtimes')):
    fails.append('bin/Release/net8.0/runtimes exists - native assets are being copied again')
deps = os.path.join(out, 'Jellyfin.Plugin.ArtworkPlus.deps.json')
if os.path.isfile(deps) and 'libSkiaSharp' in open(deps, encoding='utf-8').read():
    fails.append('deps.json references libSkiaSharp natives')
for f in fails:
    print('FAIL', f)
print('RESULT ' + ('OK' if not fails else 'FAILED'))
sys.exit(0 if not fails else 1)
