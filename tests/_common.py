"""
Shared paths and browser stubs for every script in tests/.

All scripts used to hard-code the original sandbox location
(/home/.../work/ArtworkPlus/...) and each carried its own copy of the
ApiClient/Dashboard stub. Everything is resolved relative to this file now,
so the suite runs from any checkout location.
"""
import os

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(TESTS_DIR, '..'))

CONFIG_PAGE = os.path.join(ROOT, 'Configuration', 'configPage.html')
PLUGIN_CONFIG_CS = os.path.join(ROOT, 'Configuration', 'PluginConfiguration.cs')
POSTERS_JS = os.path.join(ROOT, 'Jellyfin-ArtworkPlus-Posters-v1.js')
CORE_JS = os.path.join(ROOT, 'EmbeddedScripts', 'Jellyfin-ArtworkPlus-Core-v1.js')
CASE_TEXTURES = os.path.join(ROOT, 'CaseTextures')


def file_url(path):
    """file:// URL for Playwright's page.goto(), works on Windows and POSIX."""
    return 'file:///' + os.path.abspath(path).replace('\\', '/').lstrip('/')


# Minimal stand-in for the two Jellyfin dashboard globals configPage.html
# touches at load time. getPluginConfiguration returns {} so every field
# falls back to its EP_FIELDS default.
STUBS = """
window.ApiClient = {
    getPluginConfiguration: function () { return Promise.resolve({}); },
    updatePluginConfiguration: function () { return Promise.resolve({}); }
};
window.Dashboard = {
    showLoadingMsg: function () {},
    hideLoadingMsg: function () {},
    processPluginConfigurationUpdateResult: function () {}
};
"""
