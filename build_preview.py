"""
Builds a standalone, browser-openable preview copy of the real
Configuration/configPage.html - WITHOUT touching the real file.

Two fixes are ALWAYS required; both were forgotten once in the project's
history (see the gate-system Fibel, Part A, rule 20):
1. ApiClient/Dashboard stub (otherwise the page does not load at all)
2. html { background-color: #101010 } (otherwise a white frame appears at
   the top - Session 75 in the old Backdrops sandbox, Session 94 here again)

Usage:  python build_preview.py
Output: preview/configPage-preview.html (folder is created, git-ignored)
"""
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SOURCE_PATH = os.path.join(ROOT, 'Configuration', 'configPage.html')
OUTPUT_DIR = os.path.join(ROOT, 'preview')
OUTPUT_PATH = os.path.join(OUTPUT_DIR, 'configPage-preview.html')

STUB = '''<body>
<!-- ═══════════════════════════════════════════════════════════════════
     Inserted ONLY into this preview copy - NOT part of the real plugin
     file. See build_preview.py's own docstring for the two fixes this
     block provides.
     ═══════════════════════════════════════════════════════════════════ -->
<script>
(function () {
    // Fix 1 (Session 94, Fibel rule 20): the html background colour is
    // missing outside a real Jellyfin server (theme.css is never loaded)
    // - white frame at the top otherwise. Only the affected rule, taken
    // 1:1 from jellyfin-web's src/themes/dark/theme.css.
    var style = document.createElement('style');
    style.textContent = 'html { background-color: #101010; color: rgba(255,255,255,0.8); }';
    document.head.appendChild(style);
})();
</script>
<script>
(function () {
    // Fix 2: ApiClient/Dashboard stub so the page loads without a real
    // server. Config lives in memory only (no localStorage) - a reload
    // resets everything to the real C# defaults. "Save" is simulated and
    // never writes anywhere.
    var memConfig = {};
    window.ArtworkPlusConfig = window.ArtworkPlusConfig || { pluginUniqueId: 'preview' };
    window.ApiClient = {
        getPluginConfiguration: function () { return Promise.resolve(JSON.parse(JSON.stringify(memConfig))); },
        updatePluginConfiguration: function (id, cfg) { memConfig = JSON.parse(JSON.stringify(cfg)); return Promise.resolve({}); },
        getCurrentUserId: function () { return null; },
        getUrl: function (path) { return '#preview-stub/' + path; },
        ajax: function (opts) {
            console.log('[preview stub] ApiClient.ajax called (no real server):', opts && opts.url);
            if (opts && typeof opts.error === 'function') { opts.error(new Error('Preview stub: no real server connected.')); }
            return Promise.reject(new Error('Preview stub'));
        }
    };
    window.Dashboard = {
        showLoadingMsg: function () {},
        hideLoadingMsg: function () {},
        processPluginConfigurationUpdateResult: function () { console.log('[preview stub] save simulated (not real).'); },
        alert: function (msg) { console.log('[preview stub] Dashboard.alert:', msg); }
    };
})();
</script>
'''

if __name__ == '__main__':
    content = open(SOURCE_PATH, encoding='utf-8').read()
    content = content.replace('<body>', STUB, 1)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    open(OUTPUT_PATH, 'w', encoding='utf-8').write(content)
    print(f"Preview written: {OUTPUT_PATH}")
