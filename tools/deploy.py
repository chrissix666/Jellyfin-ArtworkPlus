"""Deploy ArtworkPlus into the local Jellyfin 10.10.7 (Windows, tray app).

    python tools/deploy.py scripts   copy the three feature scripts into the
                                     plugin's data folder (server keeps running,
                                     the controllers read them per request)
    python tools/deploy.py full      after the server was shut down through the
                                     API: wait for the process to exit, copy
                                     DLL/pdb/deps/logo/meta/CaseTextures/Fonts into the
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
    OUT / "SixLabors.ImageSharp.dll",  # Session 138 (audit S4-01): the plugin's own dependency was never in the copy set - the server kept 3.1.7
    OUT / "logo.png",
    ROOT / "meta.json",
]


def say(msg):
    print(f"[deploy] {msg}", flush=True)


def jellyfin_running():
    # bytes, not text: tasklist prints localized (cp850) messages
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq jellyfin.exe", "/NH"], capture_output=True)
    return b"jellyfin.exe" in r.stdout


def tray_running():
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Jellyfin.Windows.Tray.exe", "/NH"], capture_output=True)
    return b"Jellyfin.Windows.Tray.exe" in r.stdout


TRAY_EXE = Path(r"C:\Program Files\Jellyfin\Server\jellyfin-windows-tray\Jellyfin.Windows.Tray.exe")


def tray_relaunch():
    """Deploys #61/#64/#66 (2026-09-21): after the copy step the tray app itself
    was gone three times (cause unknown - it vanished right after the first
    right-click on its icon). Hunting the icon is pointless then; launching the
    tray app starts the server on its own (verified by hand twice)."""
    if not TRAY_EXE.exists():
        say(f"tray app not found at {TRAY_EXE}")
        return False
    subprocess.Popen([str(TRAY_EXE)], cwd=str(TRAY_EXE.parent), creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
    say("tray app relaunched (it starts the server itself)")
    return wait(jellyfin_running, 20, "jellyfin.exe running")


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
    # Session 134: Fonts (LogoArt pools + manifest + licences) travel next to the DLL like CaseTextures.
    stale = []
    for folder in ("CaseTextures", "Fonts"):
        shutil.copytree(OUT / folder, PLUGIN_DIR / folder, dirs_exist_ok=True)
        d = filecmp.dircmp(OUT / folder, PLUGIN_DIR / folder)
        stale += [folder + "/" + x for x in d.right_only]
    say(f"plugin files copied and verified ({len(PLUGIN_FILES)} files + CaseTextures + Fonts"
        + (f", stale in target: {stale}" if stale else "") + ")")


def fail(reason):
    """Every exit path prints a RESULT line - a caller waiting for it must never hang."""
    say("RESULT FAILED - " + reason)
    sys.exit(1)


def wait(cond, secs, what):
    for i in range(secs):
        if cond():
            say(f"{what} after {i}s")
            return True
        time.sleep(1)
    say(f"TIMEOUT waiting for {what}")
    return False


def _find_tray_button(d):
    """The Jellyfin tray icon - in the visible tray, or behind the overflow
    chevron ("Ausgeblendete Symbole einblenden"), which is opened on demand."""
    tb = d.window(class_name="Shell_TrayWnd")
    for b in tb.descendants(control_type="Button"):
        if b.window_text().strip() == "Jellyfin":
            return b
    for b in tb.descendants(control_type="Button"):
        if "Ausgeblendete Symbole" in b.window_text() or "hidden icons" in b.window_text().lower():
            b.click_input()
            time.sleep(0.8)
            break
    for w in d.windows():
        for b in w.descendants(control_type="Button"):
            if b.window_text().strip() == "Jellyfin":
                return b
    raise LookupError("Jellyfin tray icon not found (visible tray or overflow)")


def tray_start():
    """Deploy #30: the click raised ElementNotFoundError twice in a row and
    the run died without a RESULT line. Now: the icon is looked up freshly
    each time (overflow included), the menu item is searched across all
    windows, and the whole thing is retried a few times quickly."""
    from pywinauto import Desktop, mouse
    d = Desktop(backend="uia")
    last = None
    for attempt in range(1, 5):
        try:
            btn = _find_tray_button(d)
            p = btn.rectangle().mid_point()
            mouse.right_click(coords=(p.x, p.y))
            item = None
            # The context menu needs a moment to exist (deploy #31: the first
            # two lookups came too early) - poll for it up to 3 s.
            for _ in range(15):
                time.sleep(0.2)
                for w in d.windows():
                    try:
                        cands = w.descendants(control_type="MenuItem", title="Start Jellyfin")
                    except Exception:  # noqa: BLE001
                        cands = []
                    if cands:
                        item = cands[0]
                        break
                if item is not None:
                    break
            if item is None:
                mouse.press(coords=(1, 1)); mouse.release(coords=(1, 1))  # close a stray menu
                raise LookupError("menu item 'Start Jellyfin' not found")
            q = item.rectangle().mid_point()
            mouse.click(coords=(q.x, q.y))
            say(f"tray menu: Start Jellyfin clicked (attempt {attempt})")
            if wait(jellyfin_running, 12, "jellyfin.exe running"):
                return True
            last = "clicked, but the process did not appear"
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            say(f"tray attempt {attempt} failed - {last}")
            time.sleep(2)
        if jellyfin_running():
            return True
    say(f"tray start gave up after 4 attempts ({last})")
    return False


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
        fail("jellyfin.exe did not exit within 120 s (was the API shutdown sent?)")
    deploy_plugin()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for name in SCRIPTS:
        shutil.copy2(ROOT / name, DATA_DIR / name)
    started = tray_start() if tray_running() else tray_relaunch()
    if not started and not jellyfin_running():
        # the tray app may have died during the menu attempts - one relaunch before giving up
        started = tray_relaunch()
    if not started:
        fail("server not started - start Jellyfin from the tray by hand, the files are deployed")
    if not wait(lambda: http("/System/Info/Public")[0] == 200, 90, "API up"):
        fail("API did not come up within 90 s")
    wait(lambda: 'Loaded plugin: "ArtworkPlus"' in LOG.read_text(encoding="utf-8", errors="replace")[-200000:], 20, "plugin load line in log")
    ok = log_check()
    ok &= deploy_scripts()
    core = http("/ArtworkPlusCore/script.js")[0]
    say(f"core script: HTTP {core}")
    say("RESULT " + ("OK" if ok and core == 200 else "FAILED"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
