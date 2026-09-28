[Jellyfin Projects](https://linktr.ee/JellyfinProjects) | [Kodi Projects](https://linktr.ee/KodiProjects)

---

<img src="logo.png" width="100%">

*Not affiliated with or endorsed by Jellyfin.*

---

Before Jellyfin, I spent years in the Kodi community, starting and helping out with artwork projects: actress PNGs, characterart, character poster sets and animated posters. You can find them all under [Kodi Projects](https://linktr.ee/KodiProjects). And I loved the Kodi skins that turned a plain poster into a case that opens up and spins its disc.

When I moved to Jellyfin, I missed all of it. So I built ArtworkPlus. It brings that world to Jellyfin Web, plus a lot of things Kodi never had.

It is my third true plugin, next to [Cinema Project](https://github.com/chrissix666/Jellyfin-Cinema-Project), a virtual cinema environment based on three.js, and [VideoOSD Tweaks and Candy](https://github.com/chrissix666/Jellyfin-VideoOSD-Tweaks-Candy), which puts you in full control of the video player OSD.

---

# ArtworkPlus

- [What This Is](#what-this-is)
- [What This Is Not](#what-this-is-not)
- [Kodi Roots](#kodi-roots)
- [How It Works](#how-it-works)
- [Case Mod](#case-mod)
- [Three.js Case](#threejs-case)
- [Case Mix](#case-mix)
- [Animated Poster](#animated-poster)
- [Custom Poster](#custom-poster)
- [Extraposter](#extraposter)
- [LogoArt](#logoart)
- [CharacterArt](#characterart)
- [Red Carpet](#red-carpet)
- [Backdrops](#backdrops)
- [Naming Your Files](#naming-your-files)
- [Installation](#installation)
- [Settings Management](#settings-management)
- [Settings Not Applying?](#settings-not-applying)
- [Developed For & Tested On](#developed-for--tested-on)
- [Credits](#credits)
- [License](#license)

---

**ArtworkPlus shows the artwork Jellyfin leaves unused. Cases, keyart, animated posters, poster slideshows, character art, actor art, name logos and backdrops on almost every page, mostly from artwork you already have.**

---

## What This Is

Jellyfin shows you a poster, a logo and a backdrop. That's it.

Many of us have much more in our folders: keyart, postercases, extra posters, character art, clearart, animated posters. Jellyfin simply ignores it.

ArtworkPlus puts it on screen. Your poster sits in a Blu-ray case that opens and spins its disc. Or in a real 3D case you can grab and turn. The detail page cycles through alternative posters. Characters stand next to the title. People get their own name logo. And the pages Jellyfin leaves plain, like genres, studios or your favourites, finally get backdrops of their own.

Nine tabs, one plugin. Everything is adjustable, down to the smallest detail.

---

## What This Is Not

ArtworkPlus is not a skin, not a theme, not a replacement for Jellyfin Web, and not an artwork downloader.

It does not fetch artwork for your library. It shows what you already have. The one exception: by default, backdrops on person pages come from Wallpapers.com. Your server looks up the person's name there. You can switch this to the person's own movies and shows, or to a local folder.

It sits on top of vanilla Jellyfin. Most features are switched on right after installing, so every movie gets a case straight away. Anything you switch off goes back to exactly how Jellyfin shows it.

---

## Kodi Roots

Many features of ArtworkPlus started out in Kodi. Artwork like keyart, clearart, characterart, discart and animated posters has been part of the Kodi world for years, created and collected by the Kodi community. Jellyfin only supports a few of them. ArtworkPlus closes that gap.

- **Case Mod** brings back the cases of the classic Aeon MQ skins and Aeon Tajo, including the way they open and spin the disc, with the same timing and movement as in Kodi.
- **Red Carpet** is named after [Red Carpet](https://kodi.tv/addons/omega/resource.images.actorart/), a Kodi community addon with more than 500 actress PNGs.
- **CharacterArt** builds on the Kodi community's [Characterart PNG's for Movies/Moviesets](https://forum.kodi.tv/showthread.php?tid=342468).
- **Extraposter** is the Jellyfin home of the Kodi community's [Character Poster Sets](https://linktr.ee/CharacterPosterSets), carried on for years by @Konon.
- **Animated Poster** shows the artwork of the Kodi community's [Animated Poster Project](https://forum.kodi.tv/showthread.php?tid=215727).
- **Backdrops** use the same slow zoom and pan as the Aeon MQ7 home screen, and can read Kodi-style fanart names, so you don't have to copy anything.

If your library was ever set up for Kodi, chances are ArtworkPlus finds your artwork right away.

Everything else, like the Three.js Case, LogoArt, Case Mix and most of the backdrop pages, was made for Jellyfin from scratch.

---

## How It Works

You put your artwork files next to your media, the same way you already do with posters and fanart. ArtworkPlus finds them by their name. See [Naming Your Files](#naming-your-files).

Then you decide in the settings what should show up and where. Every feature has its own tab and can be switched off completely. One thing to know: the settings call collections **Sets**.

**One poster, several candidates.** Custom posters, animated posters and extra posters all want the same spot on the detail page. ArtworkPlus picks one in this order:

1. Extraposter
2. Animated Poster
3. Custom Poster
4. The normal Jellyfin poster

If a file is broken or missing, the next one takes over. The case from Case Mod is not part of this race, it simply wraps whatever poster won.

**No flashing.** Jellyfin's own poster, logo and backdrop are held back until ArtworkPlus knows what to show. You don't see the normal poster pop up for a second and then get replaced. And if something goes wrong, Jellyfin's own artwork comes back, so a page is never left empty.

---

## Case Mod

Put your posters into cases, on the detail page of movies, collections and TV shows. This is on by default.

There are four case styles:

- **Viva Elite** (default)
- **Clear**
- **Vortex**
- **Viva Elite 3D**, slightly turned to the side, with its own inside

The case matches your movie on its own. A 4K movie gets a 4K case, a 720p movie a 720p case, a 3D movie a 3D case. TV shows get a TV series case. Collections get a plain case, and Viva Elite 3D even has a special one for them.

The case can **open** and show the disc, and the disc can **spin**. Automatically after a few seconds, or when you click on it. For that, the movie, show or collection needs a disc image in Jellyfin. Without one, the case stays closed.

The case colour can stay original, or take its colour from the poster.

**Poster Size**

You can also make the poster bigger or smaller, from 10 to 200 percent, and pin it to a corner, an edge or the centre. That works with or without a case, on every detail page, including seasons, episodes and videos. It is off by default.

**Settings**

- Show on Movies, Collections, TV Shows
- Case style
- Colour: original, or taken from the poster in seven different ways
- Case angle (Viva Elite 3D)
- Open case: automatic, on click, or play the whole sequence on click, plus delay and angle
- Spinning disc: automatic, on click, or on click automatic, plus direction
- Poster size and position

---

## Three.js Case

*Movies only, experimental, off by default.*

This one is special. A real 3D case, live in your browser. You can grab it and turn it around, zoom in, and look at the back.

It is DVD, Blu-ray or 4K, depending on your file, and it is printed from your movie's own artwork:

- **Front:** the poster, including custom, animated and extra posters
- **Spine:** studio logo, movie logo, DVD or Blu-ray logo
- **Back:** fanart, the plot and tagline, a second backdrop, director, runtime and genre, flags for age rating, resolution, aspect ratio and video codec, even a barcode
- **Inside:** the disc, and if you want, a little booklet

Like the other cases, it can open and spin its disc. It can also rotate on its own. A double click puts it back where it was.

**Settings**

- Size, position, angle, in front of or behind the text
- Zoom, auto-rotate, rotation speed
- Colour per case type (DVD, Blu-ray, 4K)
- Back cover, booklet, spine
- Open case and spinning disc

It needs a browser with 3D support (WebGL). It also works in Jellyfin Media Player. On TV apps, the normal case is shown instead.

---

## Case Mix

Can't decide on one case style? Let ArtworkPlus decide. Every movie, collection and TV show gets a random case, and a random colour, from the styles you pick. "No case" can be part of the mix, and for movies the Three.js Case too.

A new pick comes on every visit, or every 30 seconds, minute, 5 minutes, hour or day. Off by default.

---

## Animated Poster

Animated posters and animated keyart, on the detail page and in your library. GIF out of the box, APNG and animated WEBP can be switched on.

Most animated posters out there come from the Kodi community's [Animated Poster Project](https://forum.kodi.tv/showthread.php?tid=215727).

**Settings**

- Show on Movies, Collections, TV Shows
- Detail page and library separately
- Which one wins if you have both, poster or keyart
- File name and format
- Movie logo on top of animated keyart

---

## Custom Poster

Use a different poster than Jellyfin's, on the detail page and in your library.

- **Postercase:** a retouched poster with no lettering
- **Keyart:** a poster without any text. ArtworkPlus can put the movie logo on top, at the height and size you want

**Settings**

- Show on Movies, Collections, TV Shows
- Detail page and library separately
- Which one wins if you have both, postercase or keyart
- File name, folder, format
- Movie logo on top of keyart: on or off, position and size

---

## Extraposter

Also known as Character Poster Sets.

Got more than one poster for a movie? Extraposter shows them all, one after the other, with a soft fade in between. Up to 50 per movie. Extrakeyart does the same with keyart.

It works on the detail page and in your library. You can choose where exactly: library, home screen, continue watching, favourites, search, genre and studio pages, and more.

Collections can also show the posters of the movies inside them. TV shows can show their season posters.

**Settings**

- Order: in a row, shuffled or random
- Loop or play once, start at a random poster
- How long each poster stays, how long the fade takes, delay before it starts
- Library: all tiles change at the same moment, or each on its own
- Movie logo on top of extrakeyart

---

## LogoArt

Decide what goes into the logo spot on the detail page, for each type separately: movies, TV shows, seasons, episodes, collections, videos, music videos, albums, artists and books.

You can use the normal **logo**, a **clearart**, or **nothing**. Movies, collections, TV shows, seasons and episodes can also use a **characterart**. If the first choice is missing, ArtworkPlus tries a second and a third one. Seasons and episodes can use the logo of their show.

**Logos for People**

People have no logo in Jellyfin. ArtworkPlus can give them one: their name, written in one of 120 fonts that come with the plugin, 60 handwritten and 60 headline fonts. Either drawn right in the page, or saved once as a real `clearlogo.png` in each person's Jellyfin folder with the **Create logos** button, for the missing ones only or for everyone. This is off by default.

**Settings**

- First, second and third choice per type
- Size and position
- For people: fonts, outline, upper case

---

## CharacterArt

Characters from the movie or show, cut out and placed on the detail page. Next to the title logo in the top left or top right, or in a bottom corner of the screen.

Got several? They take turns, with a soft fade in between.

**Settings**

- Show on Movies, Collections, TV Shows, Seasons, Episodes
- One image or several taking turns
- Position, size, spacing, also for fullscreen

---

## Red Carpet

Full-figure actress art on the person page and on their lists of movies, TV shows and episodes. Bottom left or bottom right.

Originally a project by the Kodi community. Download the addon from the [Kodi addon page](https://kodi.tv/addons/omega/resource.images.actorart/), copy the PNGs from inside it into a folder called `Red Carpet` in your Jellyfin metadata folder. Each file is named exactly like the person in Jellyfin, for example `Emma Stone.png`.

**Settings**

- Show on the person page, and on their lists of movies, TV shows and episodes
- Folder name
- Position and size

---

## Backdrops

Jellyfin shows backdrops on some pages and leaves the rest plain. ArtworkPlus gives almost every page a backdrop, and a better one on the pages that already have one.

Backdrops change with a soft fade and move slowly with a Ken Burns zoom and pan. They stop while a video is playing.

- **Detail pages:** movies, collections, TV shows, seasons, episodes and videos, even with backdrops per episode
- **Library pages:** home screen, movies, TV shows, music, collections, search, user settings
- **People:** from Wallpapers.com (default), from their movies and shows, or from a folder
- **Genre** and **Tag:** backdrops of the titles inside
- **Studio:** the studio's own landscape image from Jellyfin, or backdrops of its titles
- **Favourites:** all eleven types

While on, ArtworkPlus takes over from Jellyfin's own **Backdrops** and **Details Banner** display settings.

**Wallpapers.com**

People backdrops from Wallpapers.com need your server to be online. An API key is optional: without one you get about 30 lookups a minute, with a free key 60.

**Settings**

- On or off per page type
- How long each backdrop stays, in order or shuffled
- Ken Burns on or off, and how fast
- Use Jellyfin's own backdrops, or read Kodi-style fanart names from your folders

---

## Naming Your Files

ArtworkPlus looks for artwork in the folder of the movie or show. There are three ways to name your files, and you can choose per feature:

- **With the folder name in front** (default for movies): `Movie (2013)-keyart.jpg`. This is the name of the movie's folder, not of the video file. So each movie needs its own folder.
- **Just the type:** `keyart.jpg`. TV shows always use this or a subfolder, since a show's folder belongs to the show anyway.
- **In a subfolder:** everything inside a folder called `keyart`, for example. Animated posters have no subfolder option.

A movie folder could look like this:

```
Movie (2013)/
  Movie (2013).mkv
  Movie (2013)-postercase.jpg
  Movie (2013)-keyart.jpg
  Movie (2013)-animatedposter.gif
  Movie (2013)-animatedkeyart.gif
  Movie (2013)-poster1.jpg
  Movie (2013)-poster2.jpg
  Movie (2013)-keyart1.jpg
  Movie (2013)-keyart2.jpg
  Movie (2013)-characterart.png
  Movie (2013)-characterart1.png
```

Extra posters, extra keyart and characterart can be numbered from 1 to 50. Start with 1, 2 or 3, after that gaps are fine.

**Collections** have no media folder of their own. Their artwork goes into the folder Jellyfin keeps for each collection, named by type only, for example `keyart.jpg`.

**Episodes** get their backdrops next to the episode file: `Episode.mkv` gets `Episode-backdrop.jpg`, `Episode-backdrop1.jpg` and so on.

**File formats:** out of the box, posters, keyart and backdrops are read as `.jpg`, characterart and Red Carpet as `.png`, and animated posters as `.gif`. If your files use other formats, tick them in the matching tab.

All names and file formats can be changed in the settings.

---

## Installation

Requires the [File Transformation Plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) to be installed first.

**Via Plugin Catalog (recommended)**

1. In Jellyfin, go to Dashboard > Plugins > Repositories
2. Add a new repository:
   - **Name:** anything you like, for example `ArtworkPlus`
   - **URL:**

```
https://raw.githubusercontent.com/chrissix666/Jellyfin-ArtworkPlus/main/manifest.json
```

3. Go to the Catalog tab, find ArtworkPlus under Experimental, and install it
4. Restart Jellyfin
5. Configure the plugin under Dashboard > Plugins > ArtworkPlus

**Manual Installation**

1. Download the latest release ZIP from the [Releases page](https://github.com/chrissix666/Jellyfin-ArtworkPlus/releases)
2. Extract the whole ZIP, including the `CaseTextures` and `Fonts` folders, into its own folder inside your Jellyfin plugins folder, for example `plugins/ArtworkPlus`
3. Restart Jellyfin
4. Configure the plugin under Dashboard > Plugins > ArtworkPlus

---

## Settings Management

### Restore Defaults (Tab)

Every settings tab has its own **Restore defaults** button. It resets only the settings of that tab to their default values, everything else stays untouched. Click **Save** afterwards to keep them.

### Restore Defaults (All)

The General tab has an additional **Restore all tabs** button. This resets every setting across all tabs back to their defaults in one go. Click **Save** afterwards. This also clears your Wallpapers.com API key.

### Backup and Restore (All)

The General tab also includes a code-based backup system. **Generate** creates a compact code that represents your complete current settings. Copy it and store it somewhere safe. **Import** lets you paste that code back at any time to restore your full configuration, for example after a reinstall or when moving to a new server. After importing, click **Save all settings**. Your Wallpapers.com API key is not part of the code.

---

## Settings Not Applying?

Every once in a while, a saved setting doesn't seem to take effect right away, even after saving and reloading. To be explicit about this: **this is not a bug in ArtworkPlus**, it's normal browser caching behavior. Your browser can hang onto an old cached copy of the page or script instead of fetching the new one, and this same thing can happen with other Jellyfin plugins and addons too, not just this one; it's just how browsers work, not something specific to this plugin.

If that happens: open your browser's DevTools (right-click anywhere, **Inspect**), go to the **Network** tab, and check **Disable cache**. Leave DevTools open, don't close it, then refresh the page and open the plugin settings again. With DevTools open and that box checked, the browser is forced to fetch everything fresh instead of reusing anything cached.

**Fixing settings that aren't applying: disable cache workaround**

<img src="https://raw.githubusercontent.com/chrissix666/Jellyfin-Cinema-Project/main/screenshots/settings-cache-workaround.png" width="700" alt="Settings not applying, disable cache workaround">

---

## Developed For & Tested On

- Designed and written for Jellyfin Web 10.10.7
- Google Chrome
- Windows 11

Other versions may work but are not tested and could lead to unexpected behavior.

---

## Credits

- The cases and their effects come from the classic Aeon MQ skins and Aeon Tajo
- Red Carpet, Characterart PNG's, Character Poster Sets and the Animated Poster Project: the Kodi community
- Animated Poster Project: above all @moulfo, its main artist, who sadly passed away in 2020. All credit for this art style goes to him
- Character Poster Sets: @Konon, see the full collection on [DeviantArt](https://www.deviantart.com/konon-cat)
- Characterart for TV shows: [fanart.tv](https://fanart.tv)
- The 3D case runs on [three.js](https://threejs.org), its model is based on the JFX DVD/Blu-ray case package (2009), heavily reworked
- Case colours from the poster: [Color Thief](https://lokeshdhakar.com/projects/color-thief/)
- Title fonts and the back cover font (Red Hat Display) from Google Fonts, license files included
- German hyphenation patterns from [hyphenation-patterns](https://github.com/bramstein/hyphenation-patterns) (LGPL)
- Studio logos and rating marks belong to their respective owners

---

## License

MIT License

Forking and further development strongly encouraged.
Feedback and bug reports welcome, feel free to open an issue.

---
