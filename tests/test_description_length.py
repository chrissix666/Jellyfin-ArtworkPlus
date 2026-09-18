"""Rule 27 (Session 117, top-priority user rule): every field description in
the admin page is ONE line - no wrap at the reference width, and at most
DESC_MAX_CHARS characters as the writing guideline.

Measured live in the user's Chrome (1920x911, Jellyfin's Noto Sans 10.5px):
the description column is 804 px (794 px inside nested subs) which fits
about 108 average characters; the guideline is 105. The real gate is the
render: the preview is opened at the reference viewport, every tab and every
collapse is expanded, and a description that occupies more than one line
fails the test. Tab intro paragraphs (`.epTabDescArea`, `white-space:normal`)
are deliberately multi-line and excluded.

    python tests/test_description_length.py
"""
import os
import sys
from playwright.sync_api import sync_playwright
from _common import ROOT, file_url

DESC_MAX_CHARS = 105
VIEWPORT = {"width": 1920, "height": 911}
PREVIEW = os.path.join(ROOT, "preview", "configPage-preview.html")

PROBE = """
() => {
  const out = { total: 0, wraps: [], long: [] };
  const lineCount = (el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; };
  for (const b of document.querySelectorAll('button[data-tab], .epTabBtn[data-tab]')) {
    if (!b.dataset.tab) continue;
    b.click();
    document.querySelectorAll('.epCollapseHeader').forEach(h => { const body = document.querySelector('.epCollapseBody[data-collapsebody="' + h.dataset.collapse + '"]'); if (body && getComputedStyle(body).display === 'none') h.click(); });
    for (const d of document.querySelectorAll('.epDesc, .epDescInline')) {
      if (d.offsetParent === null) continue;
      if (d.closest('.epTabDescArea') || (d.getAttribute('style') || '').includes('white-space:normal')) continue;
      out.total++;
      const text = d.textContent.trim();
      const row = d.closest('.epRow');
      const label = row ? ((row.querySelector('label:not(.emby-checkbox-label), .epRowLabelSpan') || {}).textContent || '').trim() : '';
      const lines = lineCount(d);
      if (lines > 1) out.wraps.push({ tab: b.dataset.tab, label, lines, chars: text.length, text });
      if (text.length > %d) out.long.push({ tab: b.dataset.tab, label, chars: text.length, text });
    }
  }
  return out;
}
""" % DESC_MAX_CHARS


def main():
    if not os.path.exists(PREVIEW):
        print("preview missing - run build_preview.py first"); sys.exit(2)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport=VIEWPORT)
        page.goto(file_url(PREVIEW)); page.wait_for_timeout(800)
        page.click('#epRestoreAllBtn'); page.wait_for_timeout(200)
        r = page.evaluate(PROBE)
        browser.close()
    print(f"descriptions checked: {r['total']} at {VIEWPORT['width']}px")
    for w in r["wraps"]:
        print(f"WRAP {w['tab']:14s} {w['label'][:24]:24s} {w['lines']} lines, {w['chars']} chars: {w['text'][:110]}")
    for l in r["long"]:
        print(f"LONG {l['tab']:14s} {l['label'][:24]:24s} {l['chars']} chars > {DESC_MAX_CHARS}: {l['text'][:110]}")
    fails = len(r["wraps"]) + len(r["long"])
    print("RESULT", "FAILED" if fails else "OK", f"(wraps={len(r['wraps'])}, over-{DESC_MAX_CHARS}={len(r['long'])})")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
