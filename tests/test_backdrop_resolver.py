"""BackdropFileResolver (Session 118) against a temporary folder tree.

Expected orders are derived from Jellyfin 10.10.7's
LocalImageProvider.PopulateBackdrops: stage 1 "<file>-fanart", stages 2-4
fanart/background/art (+ "-N"), stage 5 extrafanart\\, stage 6 the base
name (+ "N" without dash) - each with the "<file>-" prefix and, when not in
a mixed folder, without it. Three misses in a row stop a numbered run.
Extension preference png > jpg > jpeg > webp > tbn > gif > svg.

Key assertion: with base name "backdrop" the resolver's list equals the
list Jellyfin itself would store (case A), so Listener=Custom with the
default word cannot differ from Native. Drives the small console harness in
tests/resolver_harness (built on first run).

    python tests/test_backdrop_resolver.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
from _common import ROOT

HARNESS_DIR = os.path.join(ROOT, "tests", "resolver_harness")
HARNESS = os.path.join(HARNESS_DIR, "bin", "Release", "net8.0", "resolver_harness.exe")


def build_harness():
    if os.path.exists(HARNESS):
        return
    r = subprocess.run(["dotnet", "build", "-c", "Release"], cwd=HARNESS_DIR, capture_output=True, text=True)
    if not os.path.exists(HARNESS):
        print(r.stdout[-2000:]); sys.exit(2)


def run(*args):
    r = subprocess.run([HARNESS, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return [l.strip().replace("\\", "/") for l in r.stdout.splitlines() if l.strip()]


def touch(folder, *names):
    for n in names:
        p = os.path.join(folder, n)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(b"x")


def case(name, got, expected):
    ok = got == expected
    print(("ok   " if ok else "FAIL ") + name)
    if not ok:
        print("      got:     ", got)
        print("      expected:", expected)
    return ok


def main():
    build_harness()
    fails = 0
    tmp = tempfile.mkdtemp(prefix="apres_")
    try:
        # ---- A: a movie in its own folder, every stage present, base name backdrop == Jellyfin
        a = os.path.join(tmp, "A"); os.makedirs(a)
        touch(a, "Movie (2020)-fanart.jpg", "fanart.jpg", "fanart-1.jpg", "fanart-2.jpg", "background.jpg", "art.png",
              "extrafanart/x1.jpg", "extrafanart/x2.jpg", "backdrop.jpg", "backdrop1.jpg", "backdrop2.jpg", "backdrop3.jpg",
              "Movie (2020)-backdrop.jpg", "Movie (2020)-backdrop1.jpg", "poster.jpg", "notes.txt")
        exp = ["Movie (2020)-fanart.jpg", "fanart.jpg", "fanart-1.jpg", "fanart-2.jpg", "background.jpg", "art.png",
               "extrafanart/x1.jpg", "extrafanart/x2.jpg", "Movie (2020)-backdrop.jpg", "Movie (2020)-backdrop1.jpg",
               "backdrop.jpg", "backdrop1.jpg", "backdrop2.jpg", "backdrop3.jpg"]
        fails += not case("A own folder, base backdrop = Jellyfin order", run("jellyfin", a, "Movie (2020)", "0", "backdrop"), exp)

        # ---- B: same folder, base name fanart -> stage 6 finds fanart/fanart1.. ; fanart.jpg deduped (already stage 2); backdrop* ignored
        touch(a, "fanart1.jpg", "fanart2.jpg", "Movie (2020)-fanart1.jpg")
        exp_b = ["Movie (2020)-fanart.jpg", "fanart.jpg", "fanart-1.jpg", "fanart-2.jpg", "background.jpg", "art.png",
                 "extrafanart/x1.jpg", "extrafanart/x2.jpg", "Movie (2020)-fanart1.jpg", "fanart1.jpg", "fanart2.jpg"]
        fails += not case("B base fanart: stage 6 renamed, deduped, backdrop* ignored", run("jellyfin", a, "Movie (2020)", "0", "fanart"), exp_b)

        # ---- C: mixed folder -> only prefixed variants count
        c = os.path.join(tmp, "C"); os.makedirs(c)
        touch(c, "Film-backdrop.jpg", "Film-backdrop1.jpg", "backdrop.jpg", "fanart.jpg", "Film-fanart.jpg")
        fails += not case("C mixed folder: unprefixed ignored", run("jellyfin", c, "Film", "1", "backdrop"), ["Film-fanart.jpg", "Film-backdrop.jpg", "Film-backdrop1.jpg"])

        # ---- D: three-miss rule and extension preference
        d = os.path.join(tmp, "D"); os.makedirs(d)
        touch(d, "backdrop.jpg", "backdrop.png", "backdrop1.jpg", "backdrop2.jpg", "backdrop6.jpg", "backdrop7.jpg")
        fails += not case("D png beats jpg; gap of 3 stops the run", run("jellyfin", d, "-", "0", "backdrop"), ["backdrop.png", "backdrop1.jpg", "backdrop2.jpg"])
        touch(d, "backdrop4.jpg")  # now 3 is the only gap -> 4 continues, 5 gap, 6, 7
        fails += not case("D single gaps do not stop the run", run("jellyfin", d, "-", "0", "backdrop"), ["backdrop.png", "backdrop1.jpg", "backdrop2.jpg", "backdrop4.jpg", "backdrop6.jpg", "backdrop7.jpg"])

        # ---- E: allowed-formats filter
        fails += not case("E allowed formats jpg only", run("jellyfin", d, "-", "0", "backdrop", "jpg"), ["backdrop1.jpg", "backdrop2.jpg", "backdrop4.jpg", "backdrop6.jpg", "backdrop7.jpg"])

        # ---- F: episodes (prefixed), Single vs Multiple, plain file first
        f = os.path.join(tmp, "F"); os.makedirs(f)
        touch(f, "S01E01-backdrop.jpg", "S01E01-backdrop1.jpg", "S01E01-backdrop2.jpg", "S01E02-backdrop.jpg", "backdrop.jpg")
        fails += not case("F episode Single", run("prefixed", f, "S01E01", "backdrop", "0"), ["S01E01-backdrop.jpg"])
        fails += not case("F episode Multiple = plain first + numbered", run("prefixed", f, "S01E01", "backdrop", "1"), ["S01E01-backdrop.jpg", "S01E01-backdrop1.jpg", "S01E01-backdrop2.jpg"])
        fails += not case("F episode without files -> empty", run("prefixed", f, "S01E03", "backdrop", "1"), [])
        fails += not case("F episode custom word", run("prefixed", f, "S01E02", "backdrop", "1"), ["S01E02-backdrop.jpg"])

        # ---- G: people folder (plain), Single vs Multiple
        g = os.path.join(tmp, "G"); os.makedirs(g)
        touch(g, "backdrop.jpg", "backdrop1.jpg", "backdrop2.png", "fanart.jpg")
        fails += not case("G people Single", run("plain", g, "backdrop", "0"), ["backdrop.jpg"])
        fails += not case("G people Multiple", run("plain", g, "backdrop", "1"), ["backdrop.jpg", "backdrop1.jpg", "backdrop2.png"])
        fails += not case("G people custom word", run("plain", g, "fanart", "1"), ["fanart.jpg"])

        # ---- H: empty file (0 bytes) is ignored like in Jellyfin
        h = os.path.join(tmp, "H"); os.makedirs(h)
        open(os.path.join(h, "backdrop.jpg"), "wb").close()
        touch(h, "backdrop1.jpg")
        fails += not case("H zero-byte file ignored", run("jellyfin", h, "-", "0", "backdrop"), ["backdrop1.jpg"])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("RESULT", "FAILED" if fails else "OK", f"({fails} failure(s))")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
