# ArtworkPlus

A Jellyfin 10.10 web plugin that customises posters, logos, character art and
backdrops on the detail pages and library views - nine admin tabs, one plugin.

## Features

- **Case Mod** - the main poster as a 2D or 3D disc case (Viva Elite, Clear,
  Vortex, Viva Elite 3D with an opening front and a spinning disc).
- **Animated Poster / Keyart** - animated GIF/APNG/WebP posters on detail
  pages and library tiles.
- **Custom Poster / Keyart** - alternative poster files per item.
- **Extraposter / Extrakeyart** - character-poster slideshows on detail pages
  and library tiles, per Movies / TV shows and per view, with optional
  "Also on" areas (Home, Favorites, lists, search, detail-page rows).
- **LogoArt** - the logo slot per item type: clearlogo, clearart or character
  art in a chain with inheritance levels; person pages get a logo from the
  person folder or the name rendered in one of 120 bundled fonts (bulk
  creator included).
- **CharacterArt** - up to four positioned art overlays per detail page.
- **Red Carpet** - actor art on person pages.
- **Backdrops** - seven categories: detail pages, people (Appearances,
  folder, Wallpapers.com), library views, genre, studio, tag, favourites;
  transitions, Ken Burns, random start, custom backdrop files.

## Install

1. Install the **File Transformation** plugin (the script tags are injected
   into `index.html` through it).
2. Copy the release files into `plugins/ArtworkPlus_1.0.0.0/`:
   `Jellyfin.Plugin.ArtworkPlus.dll`, `SixLabors.ImageSharp.dll`,
   `meta.json`, `logo.png`, `CaseTextures/`, `Fonts/`.
3. Copy the three feature scripts into the plugin's data folder
   `plugins/Jellyfin.Plugin.ArtworkPlus/` (the server log prints the path on
   first start): `Jellyfin-ArtworkPlus-Posters-v1.js`,
   `Jellyfin-ArtworkPlus-RenderArt-v1.js`, `Jellyfin-ArtworkPlus-Backdrops-v1.js`.
4. Start Jellyfin, open Dashboard -> My Plugins -> ArtworkPlus, switch on the
   features you want, save, reload the web app.

Build from source: .NET SDK 8, `dotnet build -c Release`; the output folder
holds everything of step 2. `tools/deploy.py` does the local deploy.

## Documentation

`docs/artworkplus-feature-map.md` is the one-page map of every feature with
its script, controller, endpoints and settings; the gate-system rules are in
`docs/artworkplus-gate-system-fibel.md`, the Backdrops and LogoArt designs in
their concept files. Tests: `cd tests && python run_checks.py --all`
(Python 3.11 with Playwright, Node, .NET SDK 8).

## Licence

MIT. Bundled fonts: SIL OFL and Apache 2.0 (`Fonts/LICENSE-*.txt`).
