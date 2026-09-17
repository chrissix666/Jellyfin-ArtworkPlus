"""Deploy ArtworkPlus into the local Jellyfin 10.10.7 (Windows, tray app).

    python tools/deploy.py scripts   copy the three feature scripts into the
                                     plugin's data folder (server keeps running,
                                     the controllers read them per request)
    python tools/deploy.py full      after the server was shut down through the
                                     API: wait for the process to exit, copy
                                     DLL/pdb/deps/logo/meta/CaseTextures into the
                                     plugin folder, copy the scripts, start the
                                     server via the tray menu, wait for the API,
                                     grep today's log

The API shutdown itself is not done here (it needs the user's session token,
which is never stored) - it is triggered from the logged-in browser tab.
"""
import filecmp
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "bin" / "Release" / "net8.0"
SERVER = Path(r"C:\ProgramData\Jellyfin\Server")
PLUGIN_DIR = SERVER / "plugins" / "ArtworkPlus_1.0.0.0"
DATA_DIR = SERVER / "plugins" / "Jellyfin.Plugin.ArtworkPlus"   # Plugin.Instance.DataFolderPath
LOG = SERVER / "log" / f"log_{date.today():%Y%m%d}.log"
BASE = "http://localhost:8096"

SCRIPTS = {
    "Jellyfin-ArtworkPlus-Posters-v1.js": "/PostersPlus/script.js",
    "Jellyfin-ArtworkPlus-RenderArt-v1.js": "/RenderArt/script.js",
    "Jellyfin-ArtworkPlus-Backdrops-v1.js": "/Backdrops/script.js",
}
PLUGIN_FILES = [
    OUT / "Jellyfin.Plugin.ArtworkPlus.dll",
    OUT / "Jellyfin.Plugin.ArtworkPlus.pdb",
    OUT / "Jellyfin.Plugin.ArtworkPlus.deps.json",
    OUT / "logo.png",
    ROOT / "meta.json",
]


def say(msg):
    print(f"[deploy] {msg}", flush=True)


def jellyfin_running():
    # bytes, not text: tasklist prints localized (cp850) messages
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq jellyfin.exe", "/NH"], capture_output=True)
    return b"jellyfin.exe" in r.stdout


def http(path, timeout=3):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception:
        return None, b""


def deploy_scripts():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ok = True
    for name, url in SCRIPTS.items():
        src, dst = ROOT / name, DATA_DIR / name
        shutil.copy2(src, dst)
        same = filecmp.cmp(src, dst, shallow=False)
        status, body = http(url)
        served = status == 200 and body == src.read_bytes()
        ok &= same and served
        say(f"{name}: copied={same} served@{url}={status} identical={served}")
    return ok


def deploy_plugin():
    for src in PLUGIN_FILES:
        shutil.copy2(src, PLUGIN_DIR / src.name)
        if not filecmp.cmp(src, PLUGIN_DIR / src.name, shallow=False):
            raise SystemExit(f"copy mismatch: {src.name}")
    shutil.copytree(OUT / "CaseTextures", PLUGIN_DIR / "CaseTextures", dirs_exist_ok=True)
    d = filecmp.dircmp(OUT / "CaseTextures", PLUGIN_DIR / "CaseTextures")
    extra = d.right_only
    say(f"plugin files copied and verified ({len(PLUGIN_FILES)} files + CaseTextures"
        + (f", stale in target: {extra}" if extra else "") + ")")


def wait(cond, secs, what):
    for i in range(secs):
        if cond():
            say(f"{what} after {i}s")
            return True
        time.sleep(1)
    say(f"TIMEOUT waiting for {what}")
    return False


def tray_start():
    from pywinauto import Desktop, mouse
    d = Desktop(backend="uia")
    tb = d.window(class_name="Shell_TrayWnd")
    btn = tb.child_window(title=" Jellyfin", control_type="Button").wrapper_object()
    p = btn.rectangle().mid_point()
    mouse.right_click(coords=(p.x, p.y))
    time.sleep(0.8)
    menu = d.window(class_name_re="WindowsForms10.Window.*")
    item = menu.child_window(title="Start Jellyfin", control_type="MenuItem").wrapper_object()
    q = item.rectangle().mid_point()
    mouse.click(coords=(q.x, q.y))
    say("tray menu: Start Jellyfin clicked")


def log_check():
    text = LOG.read_text(encoding="utf-8", errors="replace")
    tail = text[text.rfind("Loaded plugin: \"ArtworkPlus\"") - 2000:] if "Loaded plugin: \"ArtworkPlus\"" in text else text[-20000:]
    loaded = 'Loaded plugin: "ArtworkPlus"' in tail
    reg = "FileTransformation registration COMPLETED SUCCESSFULLY" in tail
    bad = [l for l in tail.splitlines() if "ArtworkPlus" in l and ("[ERR]" in l or "Malfunction" in l or "Exception" in l)]
    say(f"log: loaded={loaded} registration={reg} errors={len(bad)}")
    for l in bad[:10]:
        print("   ", l[:200])
    return loaded and reg and not bad


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "scripts"
    if mode == "scripts":
        sys.exit(0 if deploy_scripts() else 1)
    if mode != "full":
        raise SystemExit(__doc__)
    import threading
    threading.Thread(target=lambda: __import__("pywinauto"), daemon=True).start()  # overlap the ~3 s import with the shutdown wait
    # May be started before the API shutdown is even sent (the caller
    # fires it from the browser in parallel): wait for the process to go.
    if not wait(lambda: not jellyfin_running(), 120, "jellyfin.exe exited"):
        sys.exit(1)
    deploy_plugin()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for name in SCRIPTS:
        shutil.copy2(ROOT / name, DATA_DIR / name)
    tray_start()
    if not wait(jellyfin_running, 15, "jellyfin.exe running"):
        sys.exit(1)
    if not wait(lambda: http("/System/Info/Public")[0] == 200, 90, "API up"):
        sys.exit(1)
    wait(lambda: 'Loaded plugin: "ArtworkPlus"' in LOG.read_text(encoding="utf-8", errors="replace")[-200000:], 20, "plugin load line in log")
    ok = log_check()
    ok &= deploy_scripts()
    core = http("/ArtworkPlusCore/script.js")[0]
    say(f"core script: HTTP {core}")
    say("RESULT " + ("OK" if ok and core == 200 else "FAILED"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
