# configPage.html regression suite, started in Session 18 (admin-menu
# rework) and extended in every gate-system session since:
# the page loads without JS errors, removed fields (the case adjustment
# tool from an earlier session, the "Enable Open Case" master switch, the
# disc tuning tool with its bridge fields) are really gone, the declarative
# gate system implements the user's complete 9-field cascade correctly,
# the General<->Case tab dependency is provably ONE-WAY (settings inside
# the Case tab NEVER affect the General switch, only the other way round),
# and the Save/Load/Restore paths run without errors.
import sys
from playwright.sync_api import sync_playwright

from _common import CONFIG_PAGE as PAGE_PATH, STUBS, file_url


results = []
ok_all = True


def check(name, cond, detail=''):
    global ok_all
    results.append(('PASS' if cond else 'FAIL', name, detail))
    if not cond:
        ok_all = False


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(STUBS)
    page.goto(file_url(PAGE_PATH))
    page.wait_for_timeout(300)

    check('Page loads without JS errors', not errors, str(errors[:3]))

    # ═══ Older session: the case-box adjustment tool (Top/Left/Width/
    # Height, per-type hidden fields) stays removed - still valid,
    # nothing in this session touches it. ═══
    gone = page.evaluate("""() => ({
        vis: ['CaseModTopPercent','CaseModLeftPercent','CaseModWidthVw','CaseModHeightVw']
            .map(id => !!document.getElementById(id)),
        hidden: ['CaseModColorTopPercent','CaseModClearWidthVw','CaseModSteelHeightVw']
            .map(id => !!document.getElementById(id)),
        rows: ['CaseModTopRow','CaseModLeftRow','CaseModWidthRow','CaseModHeightRow']
            .map(id => !!document.getElementById(id))
    })""")
    check('Visible box-tool fields removed', not any(gone['vis']), str(gone['vis']))
    check('Hidden per-type box fields removed', not any(gone['hidden']), str(gone['hidden']))
    check('Box-tool rows removed', not any(gone['rows']), str(gone['rows']))

    # ═══ Session 18: every field removed since is really gone ═══
    removed = page.evaluate("""() => ['CaseModOpenCaseEnabled', 'CaseModDiscTuningModeEnabled',
        'CaseModDiscTopPercent', 'CaseModDiscLeftPercent', 'CaseModDiscSizeVw',
        'CaseModColorDiscTopPercent', 'CaseModColorDiscLeftPercent', 'CaseModColorDiscSizeVw',
        'CaseModClearDiscTopPercent', 'CaseModClearDiscLeftPercent', 'CaseModClearDiscSizeVw',
        'CaseModSteelDiscTopPercent', 'CaseModSteelDiscLeftPercent', 'CaseModSteelDiscSizeVw',
        'CaseModHideFrontCaseEnabled', 'CaseModDiscTuningModeRow', 'CaseModDiscTopRow',
        'CaseModDiscLeftRow', 'CaseModDiscSizeRow']
        .map(id => !!document.getElementById(id))""")
    check('Session 18: Enable-Open-Case/disc-tuning/disc-geometry fields removed',
          not any(removed), str(removed))

    # ═══ Session 18: all final fields + their rows present (Session 37: CaseModCaseEnabled removed) ═══
    present = page.evaluate("""() => ({
        fields: ['CaseModShowOnMovies', 'CaseModShowOnSets', 'CaseModShowOnTvShows',
            'CaseModType', 'CaseModOpenCaseDelayEnabled', 'CaseModOpenCaseDelayMs',
            'CaseModOpenCaseOnClickEnabled', 'CaseModOpenAngleDegrees', 'CaseModSpinningDiscEnabled',
            'CaseModSpinningDirection'].map(id => !!document.getElementById(id)),
        rows: ['CaseModShowOnRow', 'CaseModTypeRow', 'CaseModOpenCaseRow',
            'CaseModOpenCaseDelayMsRow', 'CaseModOpenCaseOnClickRow', 'CaseModOpenAngleRow',
            'CaseModSpinningDiscRow', 'CaseModSpinningDirectionRow'].map(id => !!document.getElementById(id))
    })""")
    check('Session 18: all fields present', all(present['fields']), str(present['fields']))
    check('Session 18: all rows present', all(present['rows']), str(present['rows']))

    check('Session 37: CaseModCaseEnabled field and row were removed completely',
          page.evaluate("() => !document.getElementById('CaseModCaseEnabled') && !document.getElementById('CaseModCaseEnabledRow')"),
          "neither should exist any more")

    # ═══ Session 18: renames ═══
    labels = page.evaluate("""() => ({
        steelOption: document.querySelector('#CaseModType option[value="vortexcases"]').textContent.trim(),
        openCaseLabel: document.querySelector('label[for="CaseModOpenCaseDelayEnabled"]').textContent.trim(),
        openAngleLabel: document.querySelector('label[for="CaseModOpenAngleDegrees"]').textContent.trim()
    })""")
    check('Session 39: case-type option "Steel Case" renamed to "Vortex Case"',
          labels['steelOption'] == 'Vortex Case', str(labels))
    check('Session 18: "Open Case delay" renamed to "Open Case"',
          labels['openCaseLabel'] == 'Open Case', str(labels))
    check('Session 18: "Open angle" renamed to "Open Case angle"',
          labels['openAngleLabel'] == 'Open Case angle', str(labels))

    # ═══ Session 18: exact description texts (1:1 as specified by the user) ═══
    descs = page.evaluate("""() => ({
        showOnDesc: document.querySelector('#CaseModShowOnRow .epDesc').textContent.trim(),
        typeDesc: document.querySelector('#CaseModTypeRow .epDesc').textContent.trim(),
        openCaseDesc: document.querySelector('#CaseModOpenCaseRow .epDescInline').textContent.trim(),
        delayDesc: document.querySelector('#CaseModOpenCaseDelayMsRow .epDesc').textContent.trim(),
        onClickDesc: document.querySelector('#CaseModOpenCaseOnClickRow .epDescInline').textContent.trim(),
        angleDesc: document.querySelector('#CaseModOpenAngleRow .epDesc').textContent.trim(),
        spinDesc: document.querySelector('#CaseModSpinningDiscRow .epDescInline').textContent.trim(),
        directionDesc: document.querySelector('#CaseModSpinningDirectionRow .epDesc').textContent.trim()
    })""")
    # 'Description "Case"' no longer applies - CaseModCaseEnabled was removed in Session 37
    check('Description "Show on"', descs['showOnDesc'] == 'Unchecking all three also turns Case off entirely.', str(descs))
    check('Description "Case type"', descs['typeDesc'] == 'Choose between 3 different case types.', str(descs))
    check('Description "Open Case"', descs['openCaseDesc'] == 'Case opens automatically in Detail View.', str(descs))
    check('Description "Delay"', descs['delayDesc'] == 'Delay before the case opens automatically.', str(descs))
    check('Description "Open Case on click"', descs['onClickDesc'] == 'Case opens when the poster itself is clicked.', str(descs))
    check('Description "Open Case angle"', descs['angleDesc'] == 'How far the front cover swings open (1-180).', str(descs))
    check('Description "Spinning Disc"', descs['spinDesc'] == 'Disc rotates once the case is open.', str(descs))
    check('Description "Spinning direction"', descs['directionDesc'] == 'Direction the disc should spin in.', str(descs))

    # ═══ Session 18: defaults ═══
    # IMPORTANT: do not test this through an empty mock config {} - that
    # would be unrealistic (the real Jellyfin server ALWAYS delivers the
    # complete configuration filled with the C# property defaults, never an
    # empty object) and would only show what the field looks like WITHOUT
    # any config, not what actually counts as the default.
    # EP_FIELDS[id].def is the authoritative source used by "Restore
    # Defaults" - checked directly.
    defaults = page.evaluate("""() => ({
        delayMs: EP_FIELDS.CaseModOpenCaseDelayMs.def,
        onClick: EP_FIELDS.CaseModOpenCaseOnClickEnabled.def,
        angle: EP_FIELDS.CaseModOpenAngleDegrees.def,
        spinning: EP_FIELDS.CaseModSpinningDiscEnabled.def,
        direction: EP_FIELDS.CaseModSpinningDirection.def
    })""")
    check('Default Delay = 5000', defaults['delayMs'] == 5000, str(defaults))
    check('Default Open Case on click = on', defaults['onClick'] is True, str(defaults))
    check('Default Open Case angle = 90', defaults['angle'] == 90, str(defaults))
    check('Default Spinning Disc = on', defaults['spinning'] is True, str(defaults))
    check('Default Spinning direction = Left', defaults['direction'] == 'Left', str(defaults))

    # Additionally: "Restore Defaults" for the Case tab really applies these
    # values to the actual fields (end-to-end, not just the registry read).
    page.evaluate("""() => { document.querySelector('[data-restore-tab="casemod"]').click(); }""")
    after_restore = page.evaluate("""() => ({
        delayMs: document.getElementById('CaseModOpenCaseDelayMs').value,
        onClick: document.getElementById('CaseModOpenCaseOnClickEnabled').checked,
        angle: document.getElementById('CaseModOpenAngleDegrees').value,
        spinning: document.getElementById('CaseModSpinningDiscEnabled').checked,
        direction: document.getElementById('CaseModSpinningDirection').value
    })""")
    check('Restore Defaults (Case tab) sets Delay to 5000', after_restore['delayMs'] == '5000', str(after_restore))
    check('Restore Defaults (Case tab) sets Open Case on click to on', after_restore['onClick'] is True, str(after_restore))
    check('Restore Defaults (Case tab) sets Open Case angle to 90', after_restore['angle'] == '90', str(after_restore))
    check('Restore Defaults (Case tab) sets Spinning Disc to on', after_restore['spinning'] is True, str(after_restore))
    check('Restore Defaults (Case tab) sets Spinning direction to Left', after_restore['direction'] == 'Left', str(after_restore))
    check('Defaults: no JS errors', not errors, str(errors[:3]))

    # Switching the case type must not throw any more
    page.evaluate("""() => {
        var t = document.getElementById('CaseModType');
        t.value = 'vortexcases';
        t.dispatchEvent(new Event('change', { bubbles: true }));
        t.value = 'vivaelitecases';
        t.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    check('Case-type switch error-free', not errors, str(errors[:3]))

    # ═══ General<->Case tab lock: ONE-WAY, explicit user requirement ═══
    # "stelle sicher, die settings im Case tab keine auswirkungen auf
    # den general switch im general tab haben. der general tab
    # hingegen wirkt sich sehr wohl auf den tab aus und graut ihn
    # komplett aus. es ist einweg. so machen wir auch kein deadlock"
    # (make sure Case-tab settings never affect the General switch; the
    # General tab does grey the whole Case tab out; one-way, no deadlock)
    oneway = page.evaluate("""() => {
        function locked() {
            var pg = document.querySelector('.epTabPage[data-tabpage="casemod"]');
            return pg.classList.contains('epTabLocked');
        }
        function buttonGreyed() {
            var btn = document.querySelector('.epTabBtn[data-tab="casemod"]');
            return btn.classList.contains('epTabGreyed');
        }
        function rowGreyed(id) {
            var row = document.getElementById(id);
            return row.classList.contains('epFieldDisabled');
        }
        function set(id, v) {
            var el = document.getElementById(id);
            el.checked = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        var out = {};
        set('CaseModEnabled', true);
        set('CaseModShowOnMovies', true); set('CaseModShowOnSets', true); set('CaseModShowOnTvShows', true);
        out.bothOn = locked();                                  // expected false

        // Changes INSIDE the Case tab (emptying all Show-on boxes) must
        // NEVER touch the General switch - that is the core of the
        // one-way rule (rule 0). Session 24: the tab BUTTON may
        // additionally mark itself grey when all of its children are
        // ineffective - but the PAGE itself must NEVER be locked (no
        // epTabLocked/pointer-events:none), otherwise "Show on" would no
        // longer be clickable - a new deadlock. Session 37:
        // CaseModCaseEnabled removed - the only remaining way to make
        // Case "ineffective" is emptying all three Show-on boxes.
        var generalBefore = document.getElementById('CaseModEnabled').checked;
        set('CaseModShowOnMovies', false);
        set('CaseModShowOnSets', false);
        set('CaseModShowOnTvShows', false);
        out.showOnEmptyLocksPage = locked();                    // expected false (page stays clickable!)
        out.showOnEmptyGreysButton = buttonGreyed();            // expected true (Session 24: tab button still reacts, even without CaseModCaseEnabled)
        out.generalUntouchedByShowOnEmpty = document.getElementById('CaseModEnabled').checked === generalBefore;
        set('CaseModShowOnMovies', true);
        set('CaseModShowOnSets', true);
        set('CaseModShowOnTvShows', true);

        // General OFF must lock the tab...
        set('CaseModEnabled', false);
        out.masterOffLocksTab = locked();                       // expected true
        // ...and General back ON must release it again (no deadlock).
        set('CaseModEnabled', true);
        out.masterBackUnlocksTab = locked();                    // expected false
        return out;
    }""")
    check('One-way test: General on + Show-on on -> tab free', oneway['bothOn'] is False, str(oneway))
    check('Session 37: all Show-on empty -> tab button still greys (even without CaseModCaseEnabled), page stays clickable (no new deadlock)',
          oneway['showOnEmptyLocksPage'] is False and oneway['showOnEmptyGreysButton'] is True, str(oneway))
    check('One-way test: General switch stays UNCHANGED when all Show-on boxes in the tab are emptied',
          oneway['generalUntouchedByShowOnEmpty'] is True, str(oneway))
    check('One-way test: General OFF locks the Case tab',
          oneway['masterOffLocksTab'] is True, str(oneway))
    check('One-way test: General back ON releases the tab again (no deadlock)',
          oneway['masterBackUnlocksTab'] is False, str(oneway))

    # Restore paths (tab + global) and pageshow load without the removed calls
    page.evaluate("""() => {
        document.querySelector('[data-restore-tab="casemod"]')?.click();
        document.getElementById('epRestoreAllBtn').click();
        document.querySelector('#ArtworkPlusConfigPage')
            .dispatchEvent(new Event('pageshow'));
    }""")
    page.wait_for_timeout(200)
    check('Restore (tab + all) and pageshow load error-free', not errors, str(errors[:3]))

    # Save/submit path
    page.evaluate("""() => {
        var form = document.querySelector('#ArtworkPlusConfigPage form')
            || document.querySelector('form');
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }""")
    page.wait_for_timeout(200)
    check('Save submit error-free', not errors, str(errors[:3]))

    # ═══ Session 18: the complete 9-field cascade, every row individually ═══
    # Fresh page so earlier manipulations (Show-on emptied etc.) cannot
    # influence this block.
    cpage = browser.new_page()
    cerrors = []
    cpage.on('pageerror', lambda e: cerrors.append(str(e)))
    cpage.add_init_script(STUBS)
    cpage.goto(file_url(PAGE_PATH))
    cpage.wait_for_timeout(300)

    def cset(id_, v):
        cpage.evaluate("""([id, v]) => {
            var el = document.getElementById(id);
            if (el.tagName === 'SELECT') { el.value = v; } else { el.checked = v; }
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }""", [id_, v])

    def cdisabled(id_):
        return cpage.evaluate("(id) => document.getElementById(id).disabled", id_)

    # Starting point: everything on, as the user defined the defaults.
    cset('CaseModEnabled', True)
    cset('CaseModShowOnMovies', True)
    cset('CaseModOpenCaseDelayEnabled', True)
    cset('CaseModOpenCaseOnClickEnabled', True)
    cset('CaseModSpinningDiscEnabled', True)

    # Session 37: the old "row 1 (Case) unchecked" cascade no longer exists -
    # CaseModCaseEnabled was removed, Show-on is now the top level of this
    # cascade.

    # --- Show on all unchecked -> Type/OpenCase/etc. greyed ---
    cset('CaseModShowOnMovies', False)
    cset('CaseModShowOnSets', False)
    cset('CaseModShowOnTvShows', False)
    row2_off = {
        'type': cdisabled('CaseModType'),
        'openCase': cdisabled('CaseModOpenCaseDelayEnabled'),
        'delay': cdisabled('CaseModOpenCaseDelayMs'),
        'onClick': cdisabled('CaseModOpenCaseOnClickEnabled'),
        'angle': cdisabled('CaseModOpenAngleDegrees'),
        'spin': cdisabled('CaseModSpinningDiscEnabled'),
        'direction': cdisabled('CaseModSpinningDirection'),
    }
    check('Cascade: Show on all unchecked -> Type/OpenCase/Delay/OnClick/Angle/Spin/Direction all greyed',
          all(row2_off.values()), str(row2_off))
    cset('CaseModShowOnMovies', True)

    # --- Row 4 (Open Case) unchecked -> ONLY 5 greyed (6,7,8,9 independent) ---
    cset('CaseModOpenCaseOnClickEnabled', True)  # 6 stays on so 7/8/9 are NOT greyed via the 4-AND-6 condition
    cset('CaseModOpenCaseDelayEnabled', False)
    row4_off = {
        'delay': cdisabled('CaseModOpenCaseDelayMs'),
        'onClick': cdisabled('CaseModOpenCaseOnClickEnabled'),
        'angle': cdisabled('CaseModOpenAngleDegrees'),
        'spin': cdisabled('CaseModSpinningDiscEnabled'),
    }
    check('Cascade: 4 (Open Case) unchecked, 6 stays on -> ONLY 5 greyed, 6/7/8 stay usable',
          row4_off['delay'] and not row4_off['onClick'] and not row4_off['angle'] and not row4_off['spin'],
          str(row4_off))

    # --- Rows 7+8 (Open Case angle / Spinning Disc): greyed only when 4 AND 6 are BOTH unchecked ---
    cset('CaseModOpenCaseOnClickEnabled', False)  # now 4 AND 6 are both off
    row78_off = {
        'angle': cdisabled('CaseModOpenAngleDegrees'),
        'spin': cdisabled('CaseModSpinningDiscEnabled'),
    }
    check('Cascade: 4 AND 6 both unchecked -> 7 (Open Case angle) AND 8 (Spinning Disc) greyed',
          row78_off['angle'] and row78_off['spin'], str(row78_off))

    cset('CaseModOpenCaseOnClickEnabled', True)  # only ONE of the two back on
    row78_on = {
        'angle': cdisabled('CaseModOpenAngleDegrees'),
        'spin': cdisabled('CaseModSpinningDiscEnabled'),
    }
    check('Cascade: only ONE of 4/6 on (6) -> 7 and 8 usable again (OR condition, not AND)',
          not row78_on['angle'] and not row78_on['spin'], str(row78_on))

    # --- Row 9 (Spinning direction): greyed when 8 unchecked, OR when 4-AND-6 both unchecked ---
    cset('CaseModSpinningDiscEnabled', True)
    row9_on = cdisabled('CaseModSpinningDirection')
    check('Cascade: 9 (Spinning direction) usable when 8 is on and at least one trigger is on',
          not row9_on, str(row9_on))

    cset('CaseModSpinningDiscEnabled', False)
    row9_off_via8 = cdisabled('CaseModSpinningDirection')
    check('Cascade: 9 (Spinning direction) greyed when 8 (Spinning Disc) unchecked',
          row9_off_via8, str(row9_off_via8))

    cset('CaseModSpinningDiscEnabled', True)
    cset('CaseModOpenCaseDelayEnabled', False)
    cset('CaseModOpenCaseOnClickEnabled', False)
    row9_off_via46 = cdisabled('CaseModSpinningDirection')
    check('Cascade: 9 (Spinning direction) also greyed when 4 AND 6 both unchecked (although 8 itself is on)',
          row9_off_via46, str(row9_off_via46))

    # ═══ "greyed out" is purely visual - the stored value is kept ═══
    # Explicit user confirmation: "ja es soll ein indikator sein... es
    # behaelt natuerlich seinen wert" (it is an indicator, the value stays).
    # Sets SpinningDiscEnabled to true, greys it via Case=off, and checks
    # that the CHECKED value stays true (not reset to false).
    cset('CaseModSpinningDiscEnabled', True)
    cset('CaseModOpenCaseDelayEnabled', True)
    cset('CaseModShowOnMovies', False)
    cset('CaseModShowOnSets', False)
    cset('CaseModShowOnTvShows', False)  # greys everything (only remaining path since Session 37)
    value_preserved = cpage.evaluate("""() => ({
        spinChecked: document.getElementById('CaseModSpinningDiscEnabled').checked,
        delayChecked: document.getElementById('CaseModOpenCaseDelayEnabled').checked
    })""")
    check('Value kept: SpinningDiscEnabled stays stored as "true" although its row is greyed',
          value_preserved['spinChecked'] is True, str(value_preserved))
    check('Value kept: OpenCaseDelayEnabled stays stored as "true" although its row is greyed',
          value_preserved['delayChecked'] is True, str(value_preserved))

    check('Cascade: no JS errors', not cerrors, str(cerrors[:3]))
    cpage.close()

    # ═══ Session 22: migration to all 8 tabs - new, separate test round ═══
    apage = browser.new_page()
    aerrors = []
    apage.on('pageerror', lambda e: aerrors.append(str(e)))
    apage.add_init_script(STUBS)
    apage.goto(file_url(PAGE_PATH))
    apage.wait_for_timeout(300)
    # The empty stub config ({}) leaves ALL checkboxes unchecked on load
    # (pageshow expects real loaded values, not the EP_FIELDS defaults) -
    # "Restore all tabs" brings every field to its real, sensible default
    # (mostly on), a realistic starting point for the tests below.
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(100)

    def aset(id_, v):
        apage.evaluate("""([id, v]) => {
            var el = document.getElementById(id);
            el.checked = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }""", [id_, v])

    def agreyed(id_):
        return apage.evaluate("""(id) => {
            var header = document.querySelector('.epCollapseHeader[data-collapse="' + id + '"]');
            var body = document.querySelector('.epCollapseBody[data-collapsebody="' + id + '"]');
            // Session 25: header and body are deliberately handled
            // separately (headerTarget vs. target) - for the question
            // "does this collapse area look disabled" both count equally.
            // Session 28: an element WITHOUT its own epFieldDisabled class
            // can still be visually greyed when an ANCESTOR already carries
            // the class (real CSS inheritance of opacity) - that is now
            // intentional, to avoid doubling (see epShouldSkipEl). An
            // element therefore also counts as "greyed" when any ancestor is.
            function greyedOrInheritsGreyed(el) {
                if (!el) { return false; }
                var node = el;
                while (node) {
                    if (node.classList && node.classList.contains('epFieldDisabled')) { return true; }
                    node = node.parentElement;
                }
                return false;
            }
            if (header) { return greyedOrInheritsGreyed(header); }
            if (body) { return greyedOrInheritsGreyed(body); }
            var el = document.getElementById(id);
            if (!el) { return null; }
            return greyedOrInheritsGreyed(el);
        }""", id_)

    # ─── Smoke test: click all 8 tabs, no JS errors ───
    for tab in ['general', 'casemod', 'animatedposter', 'customposter', 'extraposter', 'characterart', 'redcarpet', 'backdrops']:
        apage.evaluate("""(tab) => {
            var btn = document.querySelector('.epTabBtn[data-tab="' + tab + '"]');
            if (btn) { btn.click(); }
        }""", tab)
    check('Smoke test: all 8 tabs clickable, no JS errors', not aerrors, str(aerrors[:3]))

    # ─── BUG-ORPHANED-CHECKBOXES: Genre/Studio/Tag Backdrops now really save ───
    saved_config = {}
    apage.evaluate("""(cfg) => {
        window.__capturedSave = null;
        window.ApiClient.updatePluginConfiguration = function (id, config) {
            window.__capturedSave = config;
            return Promise.resolve({});
        };
    }""", saved_config)
    aset('BackdropsGenreEnabled', True)
    aset('BackdropsStudioEnabled', True)
    aset('BackdropsTagEnabled', True)
    apage.evaluate("""() => { document.querySelector('#ArtworkPlusConfigForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }""")
    apage.wait_for_timeout(150)
    captured = apage.evaluate("() => window.__capturedSave")
    check('BUG-ORPHANED-CHECKBOXES: BackdropsGenreEnabled is sent on save',
          captured is not None and captured.get('BackdropsGenreEnabled') is True, str(captured))
    check('BUG-ORPHANED-CHECKBOXES: BackdropsStudioEnabled is sent on save',
          captured is not None and captured.get('BackdropsStudioEnabled') is True, str(captured))
    check('BUG-ORPHANED-CHECKBOXES: BackdropsTagEnabled is sent on save',
          captured is not None and captured.get('BackdropsTagEnabled') is True, str(captured))

    # ─── BUG-RESTORE-001: Restore on the Backdrops tab now also resets People Backdrops ───
    aset('PeopleBackdropsMaxImages', False)  # no-op on the checkbox setter, the real change follows
    apage.evaluate("""() => { document.getElementById('PeopleBackdropsMaxImages').value = '9'; }""")
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="backdrops"]').click(); }""")
    apage.evaluate("""() => { document.querySelector('[data-restore-tab="backdrops"]').click(); }""")
    apage.wait_for_timeout(100)
    restored_value = apage.evaluate("() => document.getElementById('PeopleBackdropsMaxImages').value")
    check('BUG-RESTORE-001: Restore defaults on the Backdrops tab resets People Backdrops fields',
          restored_value == '10', f"restored_value={restored_value!r} (expected default 10)")

    # ─── BUG-KENBURNS-001: PeopleBackdropsKenBurnsEnabled now greys its Zoom/Pan rows ───
    aset('PeopleBackdropsKenBurnsEnabled', True)
    kb_on = agreyed('PeopleBackdropsKenBurnsZoomRow')
    aset('PeopleBackdropsKenBurnsEnabled', False)
    kb_off = agreyed('PeopleBackdropsKenBurnsZoomRow')
    check('BUG-KENBURNS-001: Zoom row grey when PeopleBackdropsKenBurnsEnabled is off',
          kb_on is False and kb_off is True, f"on={kb_on} off={kb_off}")

    # ─── Value mutation removed: emptying the format list no longer changes the Enable VALUE ───
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="customposter"]').click(); }""")
    aset('PostercaseEnabled', True)
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('CpFormat_' + fmt + '_chk', False)
    postercase_after_format_empty = apage.evaluate("() => document.getElementById('PostercaseEnabled').checked")
    postercase_greyed = agreyed('customposterPostercase')
    check('Value mutation removed: PostercaseEnabled stays checked although the format list is empty',
          postercase_after_format_empty is True, str(postercase_after_format_empty))
    check('Still correctly greyed: Postercase collapse grey when the format list is empty',
          postercase_greyed is True, str(postercase_greyed))
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('CpFormat_' + fmt + '_chk', fmt == 'jpg')

    # ─── Session 29 (deliberate course correction): emptying Show-on
    # completely SHOULD change the Enable VALUE again - an explicit, later
    # user decision, see the MUTATION-CASCADE tests further down for the
    # complete, deadlock-safe chain. ───
    # Session 87: PostercaseShowOnSets was added as the third Show-on box
    # (Sets extension) - must be set to False here too, otherwise "Show-on
    # completely empty" is never reached.
    aset('PostercaseShowOnMovies', False)
    aset('PostercaseShowOnSets', False)
    aset('PostercaseShowOnTvShows', False)
    postercase_after_showon_empty = apage.evaluate("() => document.getElementById('PostercaseEnabled').checked")
    check('MUTATION (Session 29): PostercaseEnabled now deliberately switches off with it when Show-on is completely empty',
          postercase_after_showon_empty is False, str(postercase_after_showon_empty))
    aset('PostercaseShowOnMovies', True)
    aset('PostercaseEnabled', True)

    # ─── Characterart: the Movies collapse depends on TWO boxes (AnyChecked), not just one ───
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="characterart"]').click(); }""")
    aset('CharacterartShowOnMovies', False)
    aset('CharacterartShowOnSets', True)
    ca_movies_any_true = agreyed('characterartMovies')
    aset('CharacterartShowOnSets', False)
    ca_movies_any_false = agreyed('characterartMovies')
    check('Characterart: Movies collapse stays active when only ShowOnSets is on (AnyChecked, not just ShowOnMovies)',
          ca_movies_any_true is False, str(ca_movies_any_true))
    check('Characterart: Movies collapse grey when ShowOnMovies AND ShowOnSets are both off',
          ca_movies_any_false is True, str(ca_movies_any_false))
    aset('CharacterartShowOnMovies', True)

    # ─── Position/ScaleMode migration: Red Carpet ───
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="redcarpet"]').click(); }""")
    apage.evaluate("""() => {
        var sel = document.getElementById('RedCarpetPosition');
        sel.value = 'BottomLeft';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    pos_state = apage.evaluate("""() => ({
        leftActive: !document.getElementById('RedCarpetBottomLeftPosRow').classList.contains('epFieldDisabled'),
        rightGreyed: document.getElementById('RedCarpetBottomRightPosRow').classList.contains('epFieldDisabled')
    })""")
    check('Position migration: BottomLeft selected -> BottomLeftPosRow active, BottomRightPosRow grey',
          pos_state['leftActive'] and pos_state['rightGreyed'], str(pos_state))
    apage.evaluate("""() => {
        var sel = document.getElementById('RedCarpetBottomLeftScaleMode');
        sel.value = 'Height';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    scale_state = apage.evaluate("""() => ({
        heightActive: !document.getElementById('RedCarpetBottomLeftHeightRow').classList.contains('epFieldDisabled'),
        widthGreyed: document.getElementById('RedCarpetBottomLeftWidthRow').classList.contains('epFieldDisabled')
    })""")
    check('ScaleMode migration: Height selected -> HeightRow active, WidthRow grey',
          scale_state['heightActive'] and scale_state['widthGreyed'], str(scale_state))

    # ═══ Session 24: user-found bugs + new function ═══

    # ─── BUG: Keyart/Extrakeyart collapse headers did not grey along ───
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="customposter"]').click(); }""")
    aset('KeyartEnabled', True)
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('CpFormat_' + fmt + '_chk', False)
    keyart_collapse_greyed = agreyed('customposterKeyart')
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('CpFormat_' + fmt + '_chk', fmt == 'jpg')

    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="extraposter"]').click(); }""")
    aset('ExtrakeyartEnabled', True)
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('Format_' + fmt + '_chk', False)
    extrakeyart_collapse_greyed = agreyed('extraposterExtrakeyart')
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('Format_' + fmt + '_chk', fmt == 'jpg')

    check('BUG-KEYART-COLLAPSE: customposterKeyart collapse now greys along when the format list is empty',
          keyart_collapse_greyed is True, str(keyart_collapse_greyed))
    check('BUG-EXTRAKEYART-COLLAPSE: extraposterExtrakeyart collapse now greys along when the format list is empty',
          extrakeyart_collapse_greyed is True, str(extrakeyart_collapse_greyed))

    # ─── BUG: RedCarpet/Backdrops Show-on row sat outside the container ───
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="redcarpet"]').click(); }""")
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('RcFormat_' + fmt + '_chk', False)
    rc_showon_greyed = agreyed('RedCarpetShowOnRow')
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('RcFormat_' + fmt + '_chk', fmt == 'png')

    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="backdrops"]').click(); }""")
    aset('BackdropsEnabled', True)
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('BdFormat_' + fmt + '_chk', False)
    bd_showon_greyed = agreyed('BackdropsShowOnRow')
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('BdFormat_' + fmt + '_chk', fmt == 'jpg')

    check('BUG-REDCARPET-SHOWON: RedCarpetShowOnRow now greys along when the format list is empty',
          rc_showon_greyed is True, str(rc_showon_greyed))
    check('BUG-BACKDROPS-SHOWON: BackdropsShowOnRow now greys along when the format list is empty',
          bd_showon_greyed is True, str(bd_showon_greyed))

    # ─── NEW FUNCTION: tab button greys when all children are ineffective ───
    def button_greyed(tab):
        return apage.evaluate("""(tab) => document.querySelector('.epTabBtn[data-tab="' + tab + '"]').classList.contains('epTabGreyed')""", tab)
    def page_locked(tab):
        return apage.evaluate("""(tab) => document.querySelector('.epTabPage[data-tabpage="' + tab + '"]').classList.contains('epTabLocked')""", tab)

    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="customposter"]').click(); }""")
    aset('CustomPosterEnabled', True)
    aset('PostercaseEnabled', False)
    aset('KeyartEnabled', False)
    cp_button_greyed_both_off = button_greyed('customposter')
    cp_page_locked_both_off = page_locked('customposter')
    aset('PostercaseEnabled', True)
    cp_button_greyed_one_on = button_greyed('customposter')

    check('NEW: Custom Poster tab button greys when Postercase AND Keyart are both off',
          cp_button_greyed_both_off is True, str(cp_button_greyed_both_off))
    check('NEW (deadlock safety): page stays clickable meanwhile, PostercaseEnabled itself can be re-checked',
          cp_page_locked_both_off is False, str(cp_page_locked_both_off))
    check('NEW: button returns to normal as soon as at least one sub (Postercase) is on again',
          cp_button_greyed_one_on is False, str(cp_button_greyed_one_on))
    aset('KeyartEnabled', True)

    # ═══ Session 25: explicit deadlock regression tests for the four cases
    # the user reported concretely. For each: empty all of its own
    # condition checkboxes, then verify that EXACTLY THESE checkboxes stay
    # usable (not disabled) - the direct, functional deadlock probe, not
    # just the structural DOM check from test_tree_self_containment.py. ═══
    def not_disabled(id_):
        return apage.evaluate("(id) => !document.getElementById(id).disabled", id_)

    # Case 1: People Backdrops Show-on (4 boxes)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="backdrops"]').click(); }""")
    for id_ in ['PeopleBackdropsShowOnInfoPage', 'PeopleBackdropsShowOnMovies', 'PeopleBackdropsShowOnTvShows', 'PeopleBackdropsShowOnEpisodes']:
        aset(id_, False)
    pb_showon_still_usable = all(not_disabled(id_) for id_ in
        ['PeopleBackdropsShowOnInfoPage', 'PeopleBackdropsShowOnMovies', 'PeopleBackdropsShowOnTvShows', 'PeopleBackdropsShowOnEpisodes'])
    check('DEADLOCK-FIX 1: People Backdrops Show-on boxes all stay usable after being emptied completely',
          pb_showon_still_usable, str(pb_showon_still_usable))
    aset('PeopleBackdropsShowOnInfoPage', True)

    # Case 2: "Enable native Backdrops override" (BackdropsEnabled)
    aset('BackdropsEnabled', False)
    bd_enable_still_usable = not_disabled('BackdropsEnabled')
    check('DEADLOCK-FIX 2: "Enable native Backdrops override" stays usable itself after switching off',
          bd_enable_still_usable, str(bd_enable_still_usable))
    aset('BackdropsEnabled', True)

    # Case 3: Keyart
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="customposter"]').click(); }""")
    aset('KeyartEnabled', False)
    keyart_still_usable = not_disabled('KeyartEnabled')
    check('DEADLOCK-FIX 3: Keyart Enable stays usable itself after switching off',
          keyart_still_usable, str(keyart_still_usable))
    aset('KeyartEnabled', True)

    # Case 4: Extrakeyart
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="extraposter"]').click(); }""")
    aset('ExtrakeyartEnabled', False)
    extrakeyart_still_usable = not_disabled('ExtrakeyartEnabled')
    check('DEADLOCK-FIX 4: Extrakeyart Enable stays usable itself after switching off',
          extrakeyart_still_usable, str(extrakeyart_still_usable))
    aset('ExtrakeyartEnabled', True)

    # ═══ Session 25: three new bugs the user reported concretely ═══

    # Case 1: Animated Poster - nested targets must not double each other
    # (0.35 x 0.35 = much darker than the rest)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="animatedposter"]').click(); }""")
    for fmt in ['gif', 'apng', 'webp']:
        aset('ApFormat_' + fmt + '_chk', False)
    ap_row_own_class = apage.evaluate("""() => document.getElementById('AnimatedPosterMoviesDetailEnabledRow').classList.contains('epFieldDisabled')""")
    ap_row_inputs_disabled = apage.evaluate("""() => [...document.getElementById('AnimatedPosterMoviesDetailEnabledRow').querySelectorAll('input,select')].every(e => e.disabled)""")
    check('OPACITY-FIX: Animated Poster Detail row no longer gets its OWN epFieldDisabled class (no doubling with the container)',
          ap_row_own_class is False, str(ap_row_own_class))
    check('OPACITY-FIX: Animated Poster Detail row still stays functionally disabled (inherited from the container)',
          ap_row_inputs_disabled is True, str(ap_row_inputs_disabled))
    for fmt in ['gif', 'apng', 'webp']:
        aset('ApFormat_' + fmt + '_chk', fmt == 'gif')

    # Case 2: Extraposter - Movies/TV shows headers did not grey along
    # although their content was already correctly disabled
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="extraposter"]').click(); }""")
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('Format_' + fmt + '_chk', False)
    ep_movies_header = agreyed('extraposterMovies')
    ep_tv_header = agreyed('extraposterTvShows')
    check('HEADER-FIX: Extraposter Movies header greys along when the format list is empty',
          ep_movies_header is True, str(ep_movies_header))
    check('HEADER-FIX: Extraposter TV shows header greys along when the format list is empty',
          ep_tv_header is True, str(ep_tv_header))
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('Format_' + fmt + '_chk', fmt == 'jpg')

    # Case 3: Genre/Studio/Tag Backdrops - format AND their own Enable switch
    # should grey the collapse header without blocking the checkbox itself
    # (no deadlock despite the new condition)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="backdrops"]').click(); }""")
    aset('BackdropsGenreEnabled', True)
    genre_header_on = agreyed('backdropsGenre')
    aset('BackdropsGenreEnabled', False)
    genre_header_off = agreyed('backdropsGenre')
    genre_still_usable = not_disabled('BackdropsGenreEnabled')
    check('GENRE-WIRING: backdropsGenre header NOT grey when Enable is on',
          genre_header_on is False, str(genre_header_on))
    check('GENRE-WIRING: backdropsGenre header grey when Enable is off',
          genre_header_off is True, str(genre_header_off))
    check('GENRE-WIRING (deadlock safety): BackdropsGenreEnabled still stays usable',
          genre_still_usable is True, str(genre_still_usable))
    aset('BackdropsGenreEnabled', True)

    # ═══ Session 28: four points reported by the user ═══

    # Point 1 (part 2): the header itself must not be darkened twice either,
    # not just the Detail/Library rows below it
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="animatedposter"]').click(); }""")
    for fmt in ['gif', 'apng', 'webp']:
        aset('ApFormat_' + fmt + '_chk', False)
    ap_header_own_class = apage.evaluate(
        """() => document.querySelector('.epCollapseHeader[data-collapse="animatedposterMovies"]').classList.contains('epFieldDisabled')""")
    check('OPACITY-FIX 2: Animated Poster Movies HEADER also no longer gets its own epFieldDisabled class (doubling avoided here too)',
          ap_header_own_class is False, str(ap_header_own_class))
    for fmt in ['gif', 'apng', 'webp']:
        aset('ApFormat_' + fmt + '_chk', fmt == 'gif')

    # Point 2 (DEFAULT-FIX: CaseModCaseEnabled default) no longer applies -
    # the field was removed completely in Session 37.

    # Point 3: no more placeholder text at Genre/Studio/Tag Backdrops
    placeholder_gone = apage.evaluate(
        """() => !document.body.textContent.includes('Not implemented yet - placeholder for a future session')""")
    check('TEXT-FIX: "Not implemented yet" placeholder text is completely removed',
          placeholder_gone is True, str(placeholder_gone))

    # Point 5: the tab button also greys when "Show on" is completely empty,
    # even if an intermediate node (e.g. postercase) would formally still be
    # active (format + Enable on) - recursive check through the WHOLE
    # subtree, not just direct children
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="customposter"]').click(); }""")
    for id_ in ['PostercaseShowOnMovies', 'PostercaseShowOnSets', 'PostercaseShowOnTvShows', 'KeyartShowOnMovies', 'KeyartShowOnSets', 'KeyartShowOnTvShows']:
        aset(id_, False)
    cp_all_showon_empty_greyed = button_greyed('customposter')
    # Session 29: since then "all Show-on boxes empty" ADDITIONALLY triggers
    # the automatic switch-off of PostercaseEnabled/KeyartEnabled via the
    # new, explicitly requested mutation - the mutation deliberately runs
    # one-way only (never automatically back), so re-checking ONE Show-on
    # box alone is no longer enough to restore the effect; Enable now has
    # to be re-checked by hand as well.
    aset('PostercaseShowOnMovies', True)
    cp_still_greyed_without_enable = button_greyed('customposter')
    aset('PostercaseEnabled', True)
    cp_recovers = not button_greyed('customposter')
    check('TAB-BUTTON-DEPTH: Custom Poster button greys when ALL Show-on boxes of both subs are empty (even with format + Enable still on)',
          cp_all_showon_empty_greyed is True, str(cp_all_showon_empty_greyed))
    check('TAB-BUTTON-DEPTH (Session 29): button stays grey when only Show-on is back on but PostercaseEnabled is still off (via the new mutation)',
          cp_still_greyed_without_enable is True, str(cp_still_greyed_without_enable))
    check('TAB-BUTTON-DEPTH: Custom Poster button only normalizes once Enable is on again as well',
          cp_recovers is True, str(cp_recovers))

    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="characterart"]').click(); }""")
    for id_ in ['CharacterartShowOnMovies', 'CharacterartShowOnSets', 'CharacterartShowOnTvShows', 'CharacterartShowOnSeasons', 'CharacterartShowOnEpisodes']:
        aset(id_, False)
    ca_all_showon_empty_greyed = button_greyed('characterart')
    aset('CharacterartShowOnMovies', True)
    check('TAB-BUTTON-DEPTH: Characterart button greys when ALL Show-on boxes are empty',
          ca_all_showon_empty_greyed is True, str(ca_all_showon_empty_greyed))

    # ═══ Session 29/30: the new, explicitly requested mutation chain
    # Detail/Library -> ShowOn -> Enable. Session 30 corrects the deadlock
    # understanding: NOT every level stays clickable - only the TRIGGERING
    # level (Detail/Library for ShowOn, ShowOn for Enable) must. Enable
    # itself (the top level) is never greyed - it is the only escape route. ═══
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="customposter"]').click(); }""")
    aset('PostercaseMoviesDetailEnabled', False)
    aset('PostercaseMoviesLibraryEnabled', False)
    step1 = not apage.evaluate("() => document.getElementById('PostercaseShowOnMovies').checked")
    aset('PostercaseTvShowsDetailEnabled', False)
    aset('PostercaseTvShowsLibraryEnabled', False)
    step2 = not apage.evaluate("() => document.getElementById('PostercaseShowOnTvShows').checked")
    step3 = not apage.evaluate("() => document.getElementById('PostercaseEnabled').checked")
    # Session 30: Show-on MAY now turn grey (Enable is off) - the escape
    # route is Enable itself, not Show-on.
    showon_now_greyed = apage.evaluate(
        "() => document.getElementById('PostercaseShowOnMovies').closest('.epRow').classList.contains('epFieldDisabled')")
    deadlock_enable = not_disabled('PostercaseEnabled')
    check('MUTATION-CASCADE: Detail + Library both off -> ShowOnMovies switches off automatically',
          step1, str(step1))
    check('MUTATION-CASCADE: after both content types -> ShowOnTvShows also off automatically',
          step2, str(step2))
    check('MUTATION-CASCADE: once ALL Show-on boxes are empty -> PostercaseEnabled switches off automatically',
          step3, str(step3))
    check('MUTATION-CASCADE (Session 30): Show-on row now greys because Enable is off (Enable is the escape route, not Show-on)',
          showon_now_greyed, str(showon_now_greyed))
    check('MUTATION-CASCADE (deadlock safety): PostercaseEnabled stays usable despite the cascade',
          deadlock_enable, str(deadlock_enable))
    aset('PostercaseMoviesDetailEnabled', True)
    aset('PostercaseTvShowsDetailEnabled', True)
    aset('PostercaseEnabled', True)

    # Red Carpet: Show-on now wired, tab button reacts
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="redcarpet"]').click(); }""")
    for id_ in ['RedCarpetShowOnInfoPage', 'RedCarpetShowOnMovies', 'RedCarpetShowOnTvShows', 'RedCarpetShowOnEpisodes']:
        aset(id_, False)
    rc_greyed = button_greyed('redcarpet')
    aset('RedCarpetShowOnMovies', True)
    rc_recovers = not button_greyed('redcarpet')
    check('RED-CARPET-WIRING: tab button greys when all four Show-on boxes are empty',
          rc_greyed is True, str(rc_greyed))
    check('RED-CARPET-WIRING: button normalizes as soon as one box is on again',
          rc_recovers is True, str(rc_recovers))

    # Genre/Studio/Tag Backdrops: default now on
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    genre_default = apage.evaluate("() => document.getElementById('BackdropsGenreEnabled').checked")
    studio_default = apage.evaluate("() => document.getElementById('BackdropsStudioEnabled').checked")
    tag_default = apage.evaluate("() => document.getElementById('BackdropsTagEnabled').checked")
    check('DEFAULT-FIX 2: Genre/Studio/Tag Backdrops are on after Restore-All',
          genre_default and studio_default and tag_default, str((genre_default, studio_default, tag_default)))

    # Session 31 (user-reported): the Height/Width rows of the NOT selected
    # position stayed visually visible (opacity 1) although their sibling
    # rows (PosRow/OffsetRow/FullscreenOffsetRow) were correctly grey -
    # functionally disabled but "partly visible". Cause: ancestor targets
    # were propagated even when the ancestor itself was NOT grey at the time.
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="redcarpet"]').click(); }""")
    apage.evaluate("""() => {
        var sel = document.getElementById('RedCarpetPosition');
        sel.value = 'BottomLeft';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    rc_position_consistency = apage.evaluate("""() => {
        var rows = ['RedCarpetBottomRightPosRow','RedCarpetBottomRightHeightRow','RedCarpetBottomRightWidthRow','RedCarpetBottomRightOffsetRow','RedCarpetBottomRightFullscreenOffsetRow'];
        return rows.every(id => document.getElementById(id).classList.contains('epFieldDisabled'));
    }""")
    check('POSITION-FIX: all five rows of the deselected Red Carpet position are uniformly grey (not just partly)',
          rc_position_consistency is True, str(rc_position_consistency))

    # Session 32 (user-reported): the Align field was never coupled to the
    # position selection, in all 10 groups - Red Carpet AND one Characterart
    # group checked here as representatives.
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="redcarpet"]').click(); }""")
    apage.evaluate("""() => { var s=document.getElementById('RedCarpetPosition'); s.value='BottomLeft'; s.dispatchEvent(new Event('change',{bubbles:true})); }""")
    align_fix_rc = apage.evaluate("""() => ({
        selected: document.getElementById('RedCarpetBottomLeftHorizontalAlign').disabled,
        deselected: document.getElementById('RedCarpetBottomRightHorizontalAlign').disabled
    })""")
    check('ALIGN-FIX: Red Carpet - Align of the selected position usable, of the deselected one locked',
          align_fix_rc['selected'] is False and align_fix_rc['deselected'] is True, str(align_fix_rc))

    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="characterart"]').click(); }""")
    apage.evaluate("""() => { var s=document.getElementById('CharacterartMoviesPosition'); s.value='TopLeft'; s.dispatchEvent(new Event('change',{bubbles:true})); }""")
    align_fix_ca = apage.evaluate("""() => ({
        selected: document.getElementById('CharacterartMoviesTopLeftHorizontalAlign').disabled,
        deselected: document.getElementById('CharacterartMoviesTopRightHorizontalAlign').disabled
    })""")
    check('ALIGN-FIX: Characterart - Align of the selected position usable, of the deselected one locked',
          align_fix_ca['selected'] is False and align_fix_ca['deselected'] is True, str(align_fix_ca))

    # Session 33 (user-reported regression): "Priority when both exist" must
    # be greyed when NOT both subs are enabled - had never been wired into
    # its own when-condition since the Session 22/23 refactor, although the
    # code comment explicitly claimed it.
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="customposter"]').click(); }""")
    aset('KeyartEnabled', False)
    cp_priority = apage.evaluate("""() => ({
        disabled: document.getElementById('CustomPosterPriority').disabled,
        value: document.getElementById('CustomPosterPriority').value
    })""")
    check('PRIORITY-FIX: Custom Poster - Priority greys when only one sub is active, value set to the remaining sub',
          cp_priority['disabled'] is True and cp_priority['value'] == 'Postercase', str(cp_priority))
    aset('KeyartEnabled', True)

    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="extraposter"]').click(); }""")
    aset('ExtrakeyartEnabled', False)
    ep_priority = apage.evaluate("""() => ({
        disabled: document.getElementById('ExtraposterPriority').disabled,
        value: document.getElementById('ExtraposterPriority').value
    })""")
    check('PRIORITY-FIX: Extraposter - Priority greys when only one sub is active, value set to the remaining sub',
          ep_priority['disabled'] is True and ep_priority['value'] == 'Extraposter', str(ep_priority))
    aset('ExtrakeyartEnabled', True)

    # Session 34 had wired CaseModCaseEnabled here as the sixth Enable +
    # Show-on pair - Session 37 removed that sub-Enable completely
    # (user-identified inconsistency: Case was the only single-feature tab
    # with an additional, redundant sub-Enable). The old CASE-MUTATION-FIX
    # test is therefore obsolete - replaced by a test confirming that
    # Show-on now works WITHOUT any mutation and reacts to "all empty"
    # exclusively via the tab button (independent of General).
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="casemod"]').click(); }""")
    aset('CaseModShowOnMovies', False)
    aset('CaseModShowOnSets', False)
    aset('CaseModShowOnTvShows', False)
    case_no_mutation = apage.evaluate("""() => ({
        caseModEnabledUntouched: document.getElementById('CaseModEnabled').checked,
        tabButtonGreyed: document.querySelector('.epTabBtn[data-tab="casemod"]').classList.contains('epTabGreyed')
    })""")
    check('Session 37: all Show-on empty -> NO mutation any more (CaseModEnabled unchanged), tab button still greys',
          case_no_mutation['caseModEnabledUntouched'] is True and case_no_mutation['tabButtonGreyed'] is True,
          str(case_no_mutation))

    # Session 35 (user-reported): Case must no longer be an exception to the
    # general tab lock - an outdated, pre-EP_TREE CSS rule had kept the Case
    # row and the Show-on row looking normal (opacity 1, pointer-events
    # auto) despite the locked tab, although the checkboxes below were
    # already correctly disabled - "half greyed". Session 37:
    # CaseModCaseEnabledRow no longer exists, the Show-on row stays as the
    # comparison point.
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(50)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="general"]').click(); }""")
    aset('CaseModEnabled', False)
    case_lock_consistency = apage.evaluate("""() => ({
        showOnRowOpacity: getComputedStyle(document.getElementById('CaseModShowOnRow')).opacity,
        otherRowOpacity: getComputedStyle(document.getElementById('CaseModOpenCaseOnClickRow')).opacity
    })""")
    check('CASE-TAB-LOCK-FIX: Show-on row greys exactly like every other row when the tab is locked',
          case_lock_consistency['showOnRowOpacity'] == case_lock_consistency['otherRowOpacity'] == '0.35',
          str(case_lock_consistency))
    aset('CaseModEnabled', True)

    # Session 36 (user-reported, systematic sweep): four side functions only
    # ran on interaction, never on load - exactly the bug class Session 32
    # had already found for Align. All four checked through a real pageshow
    # with a realistic configuration.
    apage2 = browser.new_page()
    aerrors2 = []
    apage2.on('pageerror', lambda e: aerrors2.append(str(e)))
    apage2.add_init_script("""
        window.ApiClient = {
            getPluginConfiguration: function () { return Promise.resolve({
                ExtraposterMoviesDetailDelayEnabled: false, ExtraposterMoviesDetailSinglePass: true, RedCarpetFolderName: 'MeinOrdner',
                PeopleBackdropsApiKey: 'echterSchluessel'
            }); },
            updatePluginConfiguration: function () { return Promise.resolve({}); }
        };
        window.Dashboard = { showLoadingMsg(){}, hideLoadingMsg(){}, processPluginConfigurationUpdateResult(){} };
    """)
    apage2.goto(file_url(PAGE_PATH))
    apage2.wait_for_timeout(300)
    apage2.evaluate("() => document.getElementById('ArtworkPlusConfigPage').dispatchEvent(new Event('pageshow'))")
    apage2.wait_for_timeout(150)

    session36 = apage2.evaluate("""() => ({
        delayMsDisabled: document.getElementById('ExtraposterMoviesDetailDelayMs').disabled,
        singlePassSelectValue: document.getElementById('ExtraposterMoviesDetailSinglePassSelect').value,
        redCarpetDescHasFolder: document.getElementById('RedCarpetFolderNameDesc').textContent.includes('MeinOrdner'),
        peopleBackdropsBtnDisabled: document.getElementById('PeopleBackdropsTestApiKeyBtn').disabled
    })""")
    check('LOAD-FIX: DelayMs correctly disabled with loaded DelayEnabled=false, without interaction',
          session36['delayMsDisabled'] is True, str(session36))
    check('LOAD-FIX: SinglePassSelect shows the loaded value, not the default',
          session36['singlePassSelectValue'] == 'true', str(session36))
    check('LOAD-FIX: RedCarpetFolderNameDesc shows the loaded folder name',
          session36['redCarpetDescHasFolder'] is True, str(session36))
    check('LOAD-FIX: People Backdrops test button usable with a loaded API key',
          session36['peopleBackdropsBtnDisabled'] is False, str(session36))
    apage2.close()

    # ─── Session 123: Extraposter/Extrakeyart split into Movies/TV shows x Detail page/Library views ───
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(150)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="extraposter"]').click(); }""")
    for fmt in ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tbn', 'svg']:
        aset('Format_' + fmt + '_chk', fmt == 'jpg')
    for feature in ['Extraposter', 'Extrakeyart']:
        for typ in ['Movies', 'TvShows']:
            for view in ['Detail', 'Library']:
                p_ = feature + typ + view
                key = feature.lower() + typ + view
                # view enable off -> its own fields + header grey, the enable row itself stays usable
                aset(p_ + 'Enabled', False)
                check(f'SPLIT: {p_} off greys its fields', agreyed(p_ + 'Fields') is True)
                check(f'SPLIT: {p_} off greys its header', agreyed(key) is True)
                own = apage.evaluate("(id) => document.getElementById(id).disabled", p_ + 'Enabled')
                check(f'SPLIT: {p_}Enabled stays clickable while off', own is False, str(own))
                aset(p_ + 'Enabled', True)
                check(f'SPLIT: {p_} on un-greys its fields', agreyed(p_ + 'Fields') is False)
                # Delay switch greys the Delay field (EP_DELAY_DEPENDENCY_PAIRS)
                aset(p_ + 'DelayEnabled', False)
                d = apage.evaluate("(id) => document.getElementById(id).disabled", p_ + 'DelayMs')
                check(f'SPLIT: {p_}DelayMs disabled while its switch is off', d is True, str(d))
                aset(p_ + 'DelayEnabled', True)
                d = apage.evaluate("(id) => document.getElementById(id).disabled", p_ + 'DelayMs')
                check(f'SPLIT: {p_}DelayMs enabled with its switch on', d is False, str(d))
                aset(p_ + 'DelayEnabled', False)
                if feature == 'Extrakeyart':
                    aset(p_ + 'LogoEnabled', False)
                    check(f'SPLIT: {p_} logo rows grey while the logo is off', agreyed(p_ + 'LogoVerticalPositionRow') is True and agreyed(p_ + 'LogoSizeRow') is True)
                    aset(p_ + 'LogoEnabled', True)
                    check(f'SPLIT: {p_} logo rows active with the logo on', agreyed(p_ + 'LogoVerticalPositionRow') is False)
                    aset(p_ + 'LogoEnabled', False)
        # Session 124: Show-on lives per view. Empty Show-on of a view -> its Fields grey (the Show-on row
        # itself stays usable), the OTHER view of the same type is untouched, and the one-way sync switches
        # that view's Enable off.
        p_ = feature + 'MoviesDetail'
        aset(p_ + 'ShowOnMovies', False); aset(p_ + 'ShowOnSets', False)
        check(f'SPLIT: {p_} Show-on empty greys its fields', agreyed(p_ + 'Fields') is True)
        check(f'SPLIT: {p_} Show-on empty leaves the Library block alone', agreyed(feature + 'MoviesLibraryFields') is False)
        en = apage.evaluate("(id) => document.getElementById(id).checked", p_ + 'Enabled')
        check(f'SPLIT: {p_} empty Show-on switches the view Enable off (one-way sync)', en is False, str(en))
        # the escape route is the view's own Enable row (outside the greyed target, like every feature Enable)
        en_dis = apage.evaluate("(id) => document.getElementById(id).disabled", p_ + 'Enabled')
        check(f'SPLIT: {p_} Enable stays clickable as the way back', en_dis is False, str(en_dis))
        aset(p_ + 'ShowOnMovies', True); aset(p_ + 'ShowOnSets', True); aset(p_ + 'Enabled', True)
        check(f'SPLIT: {p_} Show-on back on (and Enable re-checked) un-greys its fields', agreyed(p_ + 'Fields') is False)
        p_ = feature + 'TvShowsLibrary'
        aset(p_ + 'ShowOnTvShows', False)
        check(f'SPLIT: {p_} Show-on off greys its fields', agreyed(p_ + 'Fields') is True)
        aset(p_ + 'ShowOnTvShows', True); aset(p_ + 'Enabled', True)
        # rule 14: a greyed view block carries its own class exactly once, never a doubled ancestor
        aset(feature + 'MoviesDetailEnabled', False)
        movies_body_cls = apage.evaluate("""(k) => document.querySelector('.epCollapseBody[data-collapsebody="' + k + '"]').classList.contains('epFieldDisabled')""", feature.lower() + 'Movies')
        check(f'SPLIT: {feature} Movies body is NOT greyed itself when only one view is off (rule 14)', movies_body_cls is False, str(movies_body_cls))
        aset(feature + 'MoviesDetailEnabled', True)
    # both views of both types off -> the feature produces nothing -> tab button greys (rule 12: view nodes are co-requirements)
    for feature in ['Extraposter', 'Extrakeyart']:
        for typ in ['Movies', 'TvShows']:
            for view in ['Detail', 'Library']:
                aset(feature + typ + view + 'Enabled', False)
    tab_grey = apage.evaluate("""() => document.querySelector('.epTabBtn[data-tab="extraposter"]').classList.contains('epTabGreyed')""")
    check('SPLIT: Extraposter tab button greys when every view of every type is off', tab_grey is True, str(tab_grey))
    # no cascade from the view enables upwards any more (Session 124: the feature Enable is the user's own switch)
    en = apage.evaluate("() => document.getElementById('ExtraposterEnabled').checked")
    check('SPLIT: view enables off leave the feature Enable alone', en is True, str(en))
    aset('ExtrakeyartTvShowsLibraryEnabled', True)
    tab_grey = apage.evaluate("""() => document.querySelector('.epTabBtn[data-tab="extraposter"]').classList.contains('epTabGreyed')""")
    check('SPLIT: one view back on un-greys the tab button', tab_grey is False, str(tab_grey))
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(150)
    # ─── Session 125 (final model): Set priority / Season priority with four values, no Sources row ───
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(150)
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="extraposter"]').click(); }""")
    def sel(id_, value):
        apage.evaluate("(a) => { var e = document.getElementById(a[0]); e.value = a[1]; e.dispatchEvent(new Event('change', { bubbles: true })); }", [id_, value])
    for view in ['Detail', 'Library']:
        p_ = 'ExtraposterMovies' + view
        gone = apage.evaluate("(p) => !document.getElementById(p + 'SourcesRow') && !document.getElementById(p + 'SourceFiles')", p_)
        check(f'PRIO: {p_} has no Sources row', gone is True)
        val = apage.evaluate("(id) => document.getElementById(id).value", p_ + 'SourcePriority')
        check(f'PRIO: {p_} default Files only', val == 'FilesOnly', val)
        check(f'PRIO: {p_} Files only greys the Set rows', agreyed(p_ + 'SetOrderRow') is True and agreyed(p_ + 'SetImageRow') is True and agreyed(p_ + 'SetFallbackRow') is True and agreyed(p_ + 'SetKeyartLogoRow') is True)
        check(f'PRIO: {p_} Files order never greys in the Movies block', agreyed(p_ + 'OrderRow') is False)
        for v_ in ['FilesFirst', 'SetPostersFirst', 'SetPostersOnly']:
            sel(p_ + 'SourcePriority', v_)
            check(f'PRIO: {p_} {v_} activates the Set rows', agreyed(p_ + 'SetOrderRow') is False and agreyed(p_ + 'OrderRow') is False, v_)
        # Set Keyart logo rows: Keyart + switch
        sel(p_ + 'SetImage', 'Keyart')
        check(f'PRIO: {p_} Set Keyart logo switch active with Keyart', agreyed(p_ + 'SetKeyartLogoRow') is False)
        check(f'PRIO: {p_} logo geometry grey while the switch is off', agreyed(p_ + 'SetKeyartLogoSizeRow') is True)
        aset(p_ + 'SetKeyartLogoEnabled', True)
        check(f'PRIO: {p_} logo geometry active with the switch on', agreyed(p_ + 'SetKeyartLogoVerticalPositionRow') is False)
        # rule 14: each Set row greyed by exactly one node when Sets are off
        aset(p_ + 'ShowOnSets', False)
        chain = apage.evaluate("(p) => { var ids = [p + 'SourcePriorityRow', p + 'SetOrderRow', p + 'SetKeyartLogoRow', p + 'SetKeyartLogoSizeRow']; var bad = 0; ids.forEach(function (id) { var el = document.getElementById(id); var k = 0; while (el) { if (el.classList && el.classList.contains('epFieldDisabled')) { k++; } el = el.parentElement; } if (k !== 1) { bad++; } }); return bad; }", p_)
        check(f'PRIO: {p_} Sets off greys every Set row exactly once (rule 14)', chain == 0, str(chain))
        aset(p_ + 'ShowOnSets', True); aset(p_ + 'SetKeyartLogoEnabled', False)
        # Set fallback: "None (Skip)" text, chosen image disabled
        txt = apage.evaluate("(id) => document.getElementById(id).options[0].text", p_ + 'SetFallback')
        check(f'PRIO: {p_} fallback first option reads None (Skip)', txt == 'None (Skip)', txt)
        sel(p_ + 'SetImage', 'Poster'); sel(p_ + 'SetFallback', 'Keyart'); sel(p_ + 'SetImage', 'Keyart')
        fb = apage.evaluate("(id) => { var e = document.getElementById(id); return { value: e.value, disabled: Array.prototype.map.call(e.options, function (o) { return o.value + ':' + o.disabled; }) }; }", p_ + 'SetFallback')
        check(f'PRIO: {p_} Set fallback drops to None and disables the chosen image', fb['value'] == 'None' and 'Keyart:true' in fb['disabled'] and 'Poster:false' in fb['disabled'], str(fb))
        col = apage.evaluate("() => { for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) { if (r.selectorText && r.selectorText.indexOf('option:disabled') !== -1 && r.style.color) { return true; } } } catch (e) {} } return false; }")
        check(f'PRIO: {p_} a stylesheet rule greys disabled options', col is True, str(col))
        # Session 126: five types, second fallback chain, live option texts
        vals = apage.evaluate("(id) => Array.prototype.map.call(document.getElementById(id).options, function (o) { return o.value; })", p_ + 'SetImage')
        check(f'S126: {p_} Set image offers five types', vals == ['Poster', 'Postercase', 'Keyart', 'AnimatedPoster', 'AnimatedKeyart'], str(vals))
        sel(p_ + 'SourcePriority', 'SetPostersFirst')
        check(f'S126: {p_} second fallback row greyed while the first fallback is None', agreyed(p_ + 'SetFallback2Row') is True)
        sel(p_ + 'SetImage', 'Keyart'); sel(p_ + 'SetFallback', 'AnimatedKeyart')
        check(f'S126: {p_} second fallback row active once the first fallback is set', agreyed(p_ + 'SetFallback2Row') is False)
        fb2 = apage.evaluate("(id) => { var e = document.getElementById(id); return Array.prototype.map.call(e.options, function (o) { return o.value + ':' + o.disabled; }); }", p_ + 'SetFallback2')
        check(f'S126: {p_} second fallback disables both earlier stages', 'Keyart:true' in fb2 and 'AnimatedKeyart:true' in fb2 and 'Poster:false' in fb2 and 'None:false' in fb2, str(fb2))
        sel(p_ + 'SetFallback2', 'Poster'); sel(p_ + 'SetFallback', 'Poster')
        v2 = apage.evaluate("(id) => document.getElementById(id).value", p_ + 'SetFallback2')
        check(f'S126: {p_} second fallback drops to None when the first takes its value', v2 == 'None', v2)
        sel(p_ + 'SetFallback', 'None')
        check(f'S126: {p_} None in the first fallback greys the second again', agreyed(p_ + 'SetFallback2Row') is True and apage.evaluate("(id) => document.getElementById(id).disabled", p_ + 'SetFallback2') is True)
        sel(p_ + 'SetFallback', 'AnimatedPoster'); sel(p_ + 'SourcePriority', 'FilesOnly')
        chain = apage.evaluate("(id) => { var n = document.getElementById(id), c = 0; while (n) { if (n.classList && n.classList.contains('epFieldDisabled')) { c++; } n = n.parentElement; } return c; }", p_ + 'SetFallback2Row')
        check(f'S126: {p_} Files only greys the second fallback exactly once (rule 14)', chain == 1, str(chain))
        sel(p_ + 'SourcePriority', 'SetPostersFirst')
        check(f'S126: {p_} Sets back on: second fallback active again (first fallback set)', agreyed(p_ + 'SetFallback2Row') is False)
        # Set Keyart logo row follows every stage (Keyart / Animated Keyart anywhere in the chain)
        sel(p_ + 'SetImage', 'Poster'); sel(p_ + 'SetFallback', 'Postercase'); sel(p_ + 'SetFallback2', 'None')
        check(f'S126: {p_} logo row grey without a keyart-type stage', agreyed(p_ + 'SetKeyartLogoRow') is True)
        sel(p_ + 'SetFallback2', 'AnimatedKeyart')
        check(f'S126: {p_} logo row active with Animated Keyart as second fallback', agreyed(p_ + 'SetKeyartLogoRow') is False)
        sel(p_ + 'SetFallback2', 'None'); sel(p_ + 'SetFallback', 'Keyart')
        check(f'S126: {p_} logo row active with Keyart as first fallback', agreyed(p_ + 'SetKeyartLogoRow') is False)
        sel(p_ + 'SetFallback', 'AnimatedPoster')
        # option texts follow the Custom tab's type names
        apage.evaluate("() => { var e = document.getElementById('KeyartMoviesTypeName'); e.value = 'artwork'; e.dispatchEvent(new Event('input', { bubbles: true })); }")
        txt = apage.evaluate("(id) => Array.prototype.map.call(document.getElementById(id).options, function (o) { return o.value + '=' + o.text; })", p_ + 'SetImage')
        check(f'S126: {p_} Keyart option reads the Custom type name upper-cased', 'Keyart=Artwork' in txt, str(txt))
        apage.evaluate("() => { var e = document.getElementById('KeyartMoviesTypeName'); e.value = 'poster'; e.dispatchEvent(new Event('input', { bubbles: true })); }")
        txt = apage.evaluate("(id) => Array.prototype.map.call(document.getElementById(id).options, function (o) { return o.value + '=' + o.text; })", p_ + 'SetImage')
        check(f'S126: {p_} twin texts get the feature in brackets', 'Poster=Poster (Jellyfin)' in txt and 'Keyart=Poster (Keyart)' in txt, str(txt))
        apage.evaluate("() => { var e = document.getElementById('KeyartMoviesTypeName'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }")
        txt = apage.evaluate("(id) => Array.prototype.map.call(document.getElementById(id).options, function (o) { return o.value + '=' + o.text; })", p_ + 'SetImage')
        check(f'S126: {p_} empty type name falls back to the fixed word', 'Keyart=Keyart' in txt and 'Poster=Poster' in txt and 'AnimatedKeyart=Animated Keyart' in txt, str(txt))
        apage.evaluate("() => { var e = document.getElementById('KeyartMoviesTypeName'); e.value = 'keyart'; e.dispatchEvent(new Event('input', { bubbles: true })); }")
        if view == 'Library':
            lbl = apage.evaluate("(p) => [document.querySelector('label[for=' + JSON.stringify(p + 'SeamlessEnabled') + ']').textContent.trim(), document.querySelector('label[for=' + JSON.stringify(p + 'SyncEnabled') + ']').textContent.trim()]", p_)
            check(f'S126: {p_} labels Tile seamless loading / Tile synchronization', lbl == ['Tile seamless loading', 'Tile synchronization'], str(lbl))
        sel(p_ + 'SetImage', 'Poster'); sel(p_ + 'SetFallback', 'None'); sel(p_ + 'SetFallback2', 'None'); sel(p_ + 'SourcePriority', 'FilesOnly')
    for view in ['Detail', 'Library']:
        p_ = 'ExtrakeyartMovies' + view
        gone = apage.evaluate("(p) => !document.getElementById(p + 'SourceFiles') && !document.getElementById(p + 'SetOrderRow') && !document.getElementById(p + 'SourcePriority')", p_)
        check(f'PRIO: {p_} has no source rows (Extrakeyart = files only)', gone is True)
        un = apage.evaluate("(id) => !!document.getElementById(id)", p_ + 'UnnumberedMode')
        check(f'PRIO: {p_} has its own Unnumbered file field', un is True)
    for view in ['Detail', 'Library']:
        p_ = 'ExtraposterTvShows' + view
        val = apage.evaluate("(id) => document.getElementById(id).value", p_ + 'SourcePriority')
        check(f'PRIO: {p_} default Files only', val == 'FilesOnly', val)
        check(f'PRIO: {p_} Files only greys the season rows, Files order active', agreyed(p_ + 'SeasonOrderRow') is True and agreyed(p_ + 'SkipSingleSeasonRow') is True and agreyed(p_ + 'OrderRow') is False)
        sel(p_ + 'SourcePriority', 'SeasonPostersOnly')
        check(f'PRIO: {p_} Season posters only greys Files order, season rows active', agreyed(p_ + 'OrderRow') is True and agreyed(p_ + 'IncludeSpecialsRow') is False)
        sel(p_ + 'SourcePriority', 'SeasonPostersFirst')
        check(f'PRIO: {p_} Season posters first: nothing greyed', agreyed(p_ + 'OrderRow') is False and agreyed(p_ + 'SeasonOrderRow') is False)
        sel(p_ + 'SourcePriority', 'FilesOnly')
    no_tv_keyart = apage.evaluate("() => !document.getElementById('ExtrakeyartTvShowsDetailSourcePriority') && !document.getElementById('ExtrakeyartUnnumberedMode')")
    check('SRC: Extrakeyart TV blocks have no season sources; feature-level Unnumbered field is gone', no_tv_keyart is True)
    apage.evaluate("""() => { document.getElementById('epRestoreAllBtn').click(); }""")
    apage.wait_for_timeout(150)

    # Keyart (Custom Poster): logo per view
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="customposter"]').click(); }""")
    for view in ['Detail', 'Library']:
        aset('Keyart' + view + 'LogoEnabled', False)
        check(f'SPLIT: Keyart {view} logo rows grey while off', agreyed('Keyart' + view + 'LogoVerticalPositionRow') is True)
        aset('Keyart' + view + 'LogoEnabled', True)
        check(f'SPLIT: Keyart {view} logo rows active while on', agreyed('Keyart' + view + 'LogoSizeRow') is False)
        aset('Keyart' + view + 'LogoEnabled', False)
    # Session 127: Movies/TV shows container header dims when both views are off, body untouched
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="extraposter"]').click(); }""")
    for key, pre in [('extraposterMovies', 'ExtraposterMovies'), ('extraposterTvShows', 'ExtraposterTvShows'), ('extrakeyartMovies', 'ExtrakeyartMovies'), ('extrakeyartTvShows', 'ExtrakeyartTvShows')]:
        def hdr_state(k=key, p=pre):
            return apage.evaluate("(a) => { var h = document.querySelector('.epCollapseHeader[data-collapse=\"' + a[0] + '\"]'); var b = document.querySelector('.epCollapseBody[data-collapsebody=\"' + a[0] + '\"]'); return { hdr: h.classList.contains('epFieldDisabled'), body: b.classList.contains('epFieldDisabled'), naming: document.getElementById(a[1] + 'NamingMode').disabled, enable: document.getElementById(a[1] + 'DetailEnabled').disabled }; }", [k, p])
        aset(pre + 'DetailEnabled', False)
        st = hdr_state()
        check(f'S127: {key} header normal with one view still on', st['hdr'] is False, str(st))
        aset(pre + 'LibraryEnabled', False)
        st = hdr_state()
        check(f'S127: {key} header dims with both views off, body / Naming mode / Enable rows untouched', st['hdr'] is True and st['body'] is False and st['naming'] is False and st['enable'] is False, str(st))
        aset(pre + 'LibraryEnabled', True)
        st = hdr_state()
        check(f'S127: {key} header back to normal when a view returns', st['hdr'] is False, str(st))
        aset(pre + 'DetailEnabled', True)
    # Animated Keyart: logo per view (Session 126), mirrors the Keyart tab
    apage.evaluate("""() => { document.querySelector('.epTabBtn[data-tab="animatedposter"]').click(); }""")
    for view, size in [('Detail', '60'), ('Library', '80')]:
        aset('AnimatedKeyart' + view + 'LogoEnabled', False)
        check(f'S126: Animated Keyart {view} logo rows grey while off', agreyed('AnimatedKeyart' + view + 'LogoVerticalPositionRow') is True)
        aset('AnimatedKeyart' + view + 'LogoEnabled', True)
        check(f'S126: Animated Keyart {view} logo rows active while on', agreyed('AnimatedKeyart' + view + 'LogoSizeRow') is False)
        aset('AnimatedKeyart' + view + 'LogoEnabled', False)
        d = apage.evaluate("(id) => document.getElementById(id).value", 'AnimatedKeyart' + view + 'LogoSizePercent')
        check(f'S126: Animated Keyart {view} logo size default {size}', d == size, d)

    check('Session 22 tabs: no JS errors across all 8 tabs', not aerrors, str(aerrors[:3]))
    apage.close()

    browser.close()

for status, name, detail in results:
    print(f"[{status}] {name}" + (f"  ({detail})" if detail and status == 'FAIL' else ''))
print(f"\n{sum(1 for r in results if r[0]=='PASS')}/{len(results)} passed")
sys.exit(0 if ok_all else 1)
