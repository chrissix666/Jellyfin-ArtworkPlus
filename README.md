[Jellyfin Projects](https://linktr.ee/JellyfinProjects) | [Kodi Projects](https://linktr.ee/KodiProjects)

---

<img src="logo.png" width="100%">

*Not affiliated with or endorsed by Jellyfin.*

---

Before Jellyfin, I spent years in the Kodi community, starting and helping out with artwork projects: actress PNGs, characterart, character poster sets and animated posters. You can find them all under [Kodi Projects](https://linktr.ee/KodiProjects). And I loved the Kodi skins that turned a plain poster into a case that opens up and spins its disc.

When I moved to Jellyfin, I missed all of it. So I built ArtworkPlus. It brings that world to Jellyfin Web, plus a lot of things Kodi never had.

I have developed many Jellyfin Web script mods over the years, but besides this one, only two other true plugins: [Cinema Project](https://github.com/chrissix666/Jellyfin-Cinema-Project), a virtual cinema environment based on three.js that gives your movies an ambient feel, and [VideoOSD Tweaks and Candy](https://github.com/chrissix666/Jellyfin-VideoOSD-Tweaks-Candy), which puts you in full control of the Jellyfin video player OSD.

---

# Jellyfin ArtworkPlus

- [What This Is](#what-this-is)
- [What This Is Not](#what-this-is-not)
- [Kodi Roots](#kodi-roots)
- [Under the Hood](#under-the-hood)
  - [Architecture](#architecture)
  - [One Poster Slot, Several Candidates](#one-poster-slot-several-candidates)
  - [No Flashing](#no-flashing)
  - [Naming Modes](#naming-modes)
  - [Detail Page, Library Views and Show Also On](#detail-page-library-views-and-show-also-on)
  - [Slideshows](#slideshows)
- [General](#general)
- [Case](#case)
  - [Poster Size](#poster-size)
  - [Cases](#cases)
  - [Three.js Case](#threejs-case)
  - [Case Mix](#case-mix)
- [Animated Poster](#animated-poster)
  - [Animated Poster](#animated-poster-1)
  - [Animated Keyart](#animated-keyart)
- [Custom Poster](#custom-poster)
  - [Postercase](#postercase)
  - [Keyart](#keyart)
  - [Keyart + Logo](#keyart--logo)
- [Extraposter aka Character Poster (Sets)](#extraposter-aka-character-poster-sets)
  - [Extraposter](#extraposter)
  - [Extrakeyart](#extrakeyart)
  - [Extrakeyart + Logo](#extrakeyart--logo)
- [LogoArt](#logoart)
  - [Logos / Clearart / Characterart for Movies and Sets](#logos--clearart--characterart-for-movies-and-sets)
  - [Logos / Clearart / Characterart for TV Shows](#logos--clearart--characterart-for-tv-shows)
  - [Logos for Videos](#logos-for-videos)
  - [Logos for Music](#logos-for-music)
  - [Logos for Books](#logos-for-books)
  - [Logos for Persons](#logos-for-persons)
- [CharacterArt](#characterart)
  - [Characterart for Movies](#characterart-for-movies)
  - [Characterart for TV Shows](#characterart-for-tv-shows)
  - [Positions](#positions)
- [Red Carpet](#red-carpet)
- [Backdrops](#backdrops)
  - [Listener](#listener)
  - [Detail View Backdrops](#detail-view-backdrops)
  - [Library View Backdrops](#library-view-backdrops)
  - [People Backdrops](#people-backdrops)
  - [Genre Backdrops](#genre-backdrops)
  - [Studio Backdrops](#studio-backdrops)
  - [Tag Backdrops](#tag-backdrops)
  - [Favorites Backdrops](#favorites-backdrops)
- [Installation](#installation)
- [Settings Management](#settings-management)
- [Settings Not Applying?](#settings-not-applying)
- [Developed For & Tested On](#developed-for--tested-on)
- [Credits](#credits)
- [License](#license)

---

**ArtworkPlus shows the artwork Jellyfin leaves unused. Cases that open and spin their disc, a real 3D case, animated posters, keyart, poster slideshows, character art, actor art, name logos and backdrops on almost every page.**

---

## What This Is

A Jellyfin Web plugin for poster, logo, character art and backdrop customization. Nine tabs, one plugin.

Jellyfin shows you a poster, a logo and a backdrop. That's it.

Many of us have much more in our folders: keyart, postercases, extra posters, character art, clearart, animated posters. Jellyfin simply ignores it. And whole pages, like genres, studios, tags or your favourites, stay plain.

This plugin changes that. Your poster sits in a Blu-ray case that opens and spins its disc. Or in a real 3D case you can grab, turn and zoom, printed front, spine and back from the movie's own artwork. The detail page cycles through alternative posters. Characters stand next to the title. Actresses stand at the bottom of their person page. People get their own name logo. And almost every page gets backdrops of its own, with a slow Ken Burns zoom and pan.

Fully configurable down to the smallest detail.

---

## What This Is Not

ArtworkPlus is not a skin, not a theme, not a replacement for Jellyfin Web, not a frontend of its own, and not an artwork scraper.

It does not download artwork for your library. It shows what you already have. The one exception: backdrops on person pages can come from Wallpapers.com, see [People Backdrops](#people-backdrops).

It sits on top of vanilla Jellyfin Web and builds on it. Anything you switch off goes back to exactly how Jellyfin shows it.

---

## Kodi Roots

Many features of ArtworkPlus started out in Kodi. Artwork like keyart, clearart, characterart, discart and animated posters has been part of the Kodi world for years, created and collected by the Kodi community. Jellyfin only supports a few of them. ArtworkPlus closes that gap.

- **Case** brings back the cases of the classic Aeon MQ skins and Aeon Tajo, including the way they open and spin the disc, with the same timing and movement as in Kodi.
- **Animated Poster** shows the artwork of the Kodi community's [Animated Poster Project](https://forum.kodi.tv/showthread.php?tid=215727).
- **Extraposter** is the Jellyfin home of the Kodi community's [Character Poster Sets](https://linktr.ee/CharacterPosterSets), carried on for years by @Konon.
- **CharacterArt** builds on the Kodi community's [Characterart PNG's for Movies/Moviesets](https://forum.kodi.tv/showthread.php?tid=342468).
- **Red Carpet** is named after [Red Carpet](https://kodi.tv/addons/omega/resource.images.actorart/), a Kodi community addon with more than 500 actress PNGs.
- **Backdrops** use the same slow zoom and pan as the Aeon MQ7 home screen, and can read Kodi-style fanart names, so you don't have to copy anything.

If your library was ever set up for Kodi, chances are ArtworkPlus finds your artwork right away.

Everything else, like the Three.js Case, Case Mix, LogoArt, the person logos and most of the backdrop pages, was made for Jellyfin from scratch.

---

## Under the Hood

### Architecture

ArtworkPlus is not a single script thrown at a page. It is a proper multi-layer Jellyfin plugin.

The core is written in **C#** and runs server-side as a native Jellyfin plugin. It stores all settings in the Jellyfin backend, finds your artwork files on disk, and decides which image shows up where.

On top of that, **JavaScript** feature scripts draw everything in the browser: posters, cases, logos, overlays and backdrops. The 3D engine for the Three.js Case is only loaded when a 3D case is actually shown.

Targeted **CSS** is injected into Jellyfin Web via the File Transformation plugin, so everything fits cleanly into the native pages without looking bolted on.

### One Poster Slot, Several Candidates

Custom Poster, Animated Poster and Extraposter all want the same spot: the poster on the detail page and on library tiles. ArtworkPlus picks one in this order:

1. Extraposter / Extrakeyart
2. Animated Poster / Animated Keyart
3. Custom Poster (Postercase / Keyart)
4. The normal Jellyfin poster

If a file is broken or missing, the next one takes over. The case from the Case tab is not part of this race. It simply wraps whatever poster won.

### No Flashing

Normally you would see the vanilla poster, logo or backdrop pop up for a split second before it gets replaced. It looks rough.

ArtworkPlus holds them back before the first frame is drawn, and only lets them go once it knows what to show. No vanilla poster flashing up before your keyart, no logo jumping, no backdrop swap. And if something goes wrong, Jellyfin's own artwork comes back, so a page is never left empty.

### Naming Modes

ArtworkPlus finds your artwork by its file name, in the folder of the movie or TV show. Most features let you choose between three naming modes:

- **Prefixed:** the name of the movie's folder, a dash, then the type name. `Movie (2013)/Movie (2013)-keyart.jpg`. This is the name of the **folder**, not of the video file, so every movie needs its own folder.
- **Standalone:** just the type name. `Movie (2013)/keyart.jpg`
- **Folder:** a subfolder with the type name inside the movie folder. `Movie (2013)/keyart/`, with any file names inside.

A few rules that apply everywhere:

- **TV shows** have no Prefixed mode. A show's folder belongs to the show anyway, so it is always Standalone or Folder. Files always come from the show's main folder.
- **Sets** (collections) have no media folder of their own. Their files go into the folder Jellyfin keeps for each collection, and they always use Standalone.
- Every **type name** and **folder name** can be changed freely. There is no fixed convention.
- Every artwork tab (Animated Poster, Custom Poster, Extraposter, CharacterArt, Red Carpet, Backdrops) has its own **allowed image formats**. Tick the formats your files use.

Numbered posters, keyart and characterart, like `poster1.jpg`, `poster2.jpg`, can go up to 50. Start with 1, 2 or 3, after that gaps are fine. Numbered backdrops go up to 20.

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
  Movie (2013)-characterart2.png
```

### Detail Page, Library Views and Show Also On

Every poster feature (Animated Poster, Custom Poster, Extraposter) can be switched on separately for the **detail page** and for **library views**, the tiles on the library grid page.

Beyond the library grid, you decide exactly where else the tiles change, in the **Show also on** menus.

**For Movies show also on**

- **Favorites & Search:** the Movies rows of the Favorites tab and the search page
- **Home:** Recently added, and Continue Watching for a movie without thumb or backdrop
- **Lists:** Genre, Studio, Tag, and Folder & More (folder views and every "More" list)
- **Detail pages:** More like this, Set members, People pages

**For Sets show also on**

- **Favorites & Search:** the Sets rows of the Favorites tab and the search page
- **Lists:** Studio, Tag, and Folder & More (the Sets folder and its "More" lists)

**For TV shows show also on**

- **Favorites & Search:** the Shows rows of the Favorites tab and the search page
- **Home:** Recently added (Continue Watching shows episodes, never a series card)
- **Lists:** Genre, Studio, Tag, and Folder & More
- **Detail pages:** More like this, Set members, People pages

### Slideshows

Extraposter, Extrakeyart, CharacterArt and characterart in the LogoArt slot share the same slideshow controls. LogoArt has no delay, and backdrops have their own controls, see [Backdrops](#backdrops).

- **Order:** Sequential (in order), Shuffle (no repeats per round) or Random (repeats OK)
- **Playback:** Loop (runs forever) or Play once (fades back to the original after one pass)
- **Random start position:** Sequential and Loop only. Starts at a random image and continues in order, as if the show had been running all along.
- **Display duration:** how long each image stays
- **Transition duration:** how long the fade takes, 0 switches instantly
- **Delay before first shown:** waits before the slideshow starts, 0 turns it off

---

## General

The General tab is the main switchboard. Every feature tab can be turned on or off here as a whole:

- Case Mod
- Animated Poster
- Custom Poster
- Extraposter
- LogoArt
- CharacterArt
- Red Carpet
- Backdrops

The General tab also holds **Restore all tabs** and the **Backup / restore via code**, see [Settings Management](#settings-management).

---

## Case

Put your posters into cases, on the detail pages of movies, sets and TV shows.

The case matches your file on its own. A 4K movie gets a 4K case, a 1080p movie a 1080p case, and so on through 720p, 576p, 540p and 480p. 3D movies get a 3D case. Movies without resolution info, like ISO files, get a plain case. TV shows get a TV series case. Sets get a plain case, and the Viva Elite 3D Case even has a special one for them.

The Case tab has four sections.

---

### Poster Size

Make the detail page poster bigger or smaller, and pin it wherever you like. With or without a case, both case kinds follow it.

**Settings**

- **Settings:** General (one size for everything) or Individual (each kind sets its own)
- **Size per kind:** All, or Movies, Sets, Series, Seasons, Episodes and Videos (every kind not named before) separately. 10 to 200 percent, 100 is how Jellyfin draws it.
- **Anchor per kind:** Default, Top left, Top center, Top right, Center left, Center, Center right, Bottom left, Bottom center, Bottom right

---

### Cases

The classic 2D cases, straight from the old Aeon MQ skins and Aeon Tajo.

The case can **open** and show the disc, and the disc can **spin**, with the same timing and movement as in Kodi. For that, the movie, show or set needs a disc image in Jellyfin. Without one, the case stays closed.

**Settings**

- **Show Cases on:** Movies, Sets, TV shows. Unchecking all three turns cases off entirely.
- **Case type:**
  - Clear Case
  - Vortex Case
  - Viva Elite Case
  - Viva Elite 3D Case, slightly turned to the side, with its own inside
- **Case color:** Original keeps the case as it is, Full shell tints its plastic to match the cover
- **Case color blend:** which color the cover gives the case. Dominant dark, Dominant colorful, Deep, Material You, Accent, Top region, Vibrant. The same seven the Three.js Case offers.
- **Case angle:** the tilt of the Viva Elite 3D Case, 0 to 10°

**Open Case**

- **Automatic:** the whole sequence plays on its own when you visit the page
- **On click automatic:** the whole sequence plays when you click
- **On click:** click to open, click again to close
- **Delay:** before the case opens automatically
- **Open angle:** how far the front cover swings open, 0 to 180°

**Spinning Disc**

- **Automatic** and **On click automatic:** the disc spins as part of that sequence
- **On click:** click the disc itself
- **Direction:** Left or Right

**Developer Settings**

For fine-tuning and testing:

- Hide front case, hide poster, hide disc, hide hub
- Position and size of the case, the inner case, the hub and the disc, saved per case type, plus a separate case width for sets on the Viva Elite 3D Case

---

### Three.js Case

*Movies only, experimental.*

This one is special. A real 3D keep case, rendered live in your browser. It replaces the case type above for movies. You can grab it and turn it around, zoom in with the mouse wheel, and look at the back.

It picks its shell on its own:

- **DVD** for DVD discs, ISO files up to 10 GB and files up to 576p
- **Blu-ray** for Blu-ray discs, ISO files over 10 GB and files up to 1440p. A file without resolution info counts by size: over 10 GB is Blu-ray, otherwise DVD.
- **4K** for everything above 1440p, in black with a UHD mark on the band

And it is printed from your movie's own artwork and metadata:

- **Front:** the poster that won, including custom, animated and extra posters. Extraposter slides crossfade on the cover, animated GIFs animate.
- **Spine:** movie logo, studio logo, DVD or Blu-ray mark and a code
- **Back:** fanart, the plot and tagline, a second backdrop, director, runtime, genre and studio, flags for age rating, resolution, aspect ratio and video codec, a barcode and the usual small print
- **Inside:** the disc, and a booklet in the lid

**Settings**

- **Case layer:** In front, or Behind the text, which lets it pass under titles and details
- **Case size:** 1 to 200 percent of the poster box, plus the same nine anchors as Poster Size
- **Case turn:** how far the case is turned when the page opens, 0 to 360°
- **Case tilt:** how far it leans back, or forward with a minus, -90 to 90°
- **Zoom:** the mouse wheel resizes the case while the pointer is over it
- **Zoom range:** how far the wheel may go either way, 0 to 99 percent
- **Auto rotate:** Off, Left or Right. Turns on its own until you drag it.
- **Rotate speed:** Very slow, Slow, Medium, Fast, Very fast. That is 0.5 to 4 turns per minute.
- **Reset on double click:** puts pose, size and rotation back. Off, a single click opens the case without delay.
- **DVD case color:** Original (black) or Full shell
- **Blu-ray case color:** Original (blue), Full shell or Back spine
- **4K case color:** Original (black), Full shell or Back spine
- **Case color blend:** the same seven blends as the 2D cases
- **Back cover:** prints the back with plot, images, media flags and small print
- **Booklet:** Off, Black, B/W fanart or Blurred fanart. Without fanart it falls back to Black.
- **Spine:** Movie logo, Studio logo, Format mark, Code
- **Open case:** Automatic, On click automatic, On click. Delay up to one minute, open angle 0 to 180°.
- **Spinning disc:** Automatic, On click automatic, On click, direction Left or Right

It needs a browser with 3D support (WebGL). It works in desktop browsers and in Jellyfin Media Player. TV apps get the normal 2D case instead.

---

### Case Mix

Can't decide on one case? Let ArtworkPlus decide. Every movie, set and TV show gets a random case, and a random color, from the pools you pick.

Case Mix has its own **Restore defaults** button, and a **Randomize** button (only while Case Mix is on) that rolls the pools, poster chains, colors and blends at random, just for fun or to discover combinations. New draw after and the No case size settings stay as they are. Like Restore, it only fills in the fields, click **Save** to keep them.

**Settings**

- **New draw after:** Every visit, 30 seconds, 1 minute, 5 minutes, 1 hour or 1 day
- **Mix pool Movies:** Clear, Vortex, Viva Elite, Viva Elite 3D, Three.js, No case
- **Mix pool Sets:** Clear, Vortex, Viva Elite, Viva Elite 3D, No case
- **Mix pool TV shows:** Clear, Vortex, Viva Elite, Viva Elite 3D, No case
- **Poster chain Cases:** which of Custom Poster, Animated Poster and Extraposter a drawn case may show. Unticked ones yield to the next in the chain.
- **Poster chain No case:** the same for No case. The plain poster always ends the chain.
- **No case size on:** Movies, Sets, TV shows. Where a drawn No case shows the poster larger, to match the size a case would have.
- **No case poster size:** 50 to 150 percent, plus an anchor

"No case" always needs a case type next to it in the pool. An empty pool leaves the normal case settings in charge.

**Color pools**

Each case type gets its own color pool. Tick the ones that should be drawn, and a blend for the tinted ones. At least one color always stays ticked per case type:

- Clear, Vortex, Viva Elite, Viva Elite 3D: Original, Full shell, plus a color blend each
- Three.js DVD: Original, Full shell
- Three.js Blu-ray and 4K: Original, Full shell, Back spine
- Three.js: one color blend for all three

---

## Animated Poster

Animated posters never found their way into any artwork database or API. They remained a fan project. Most of them can be found on the Kodi community's [Animated Poster Project](https://forum.kodi.tv/showthread.php?tid=215727) page. @moulfo was the main artist of the project, producing the highest-quality posters in the community. He sadly passed away in 2020. All credit for this art style goes to him.

**Settings (tab-wide)**

- **Allowed animated formats:** GIF, APNG, Animated WEBP. Shared by both subs, empty disables both.
- **Priority when both exist:** Animated Poster or Animated Keyart

---

### Animated Poster

Replaces the poster with an animated one, on detail pages and library tiles.

**Settings**

- **Show on:** Movies, Sets, TV shows. Sets use the Movies settings, but always Standalone.

**Movies**

- **Naming mode:** Prefixed or Standalone. `Movie (2013)-animatedposter.gif` or `animatedposter.gif`
- **Type name:** `animatedposter`
- **Enable on detail page**
- **Enable for library views**
- **For Movies show also on** and **For Sets show also on**, see [Show Also On](#detail-page-library-views-and-show-also-on)

**TV Shows**

- **Type name:** `animatedposter`. Main show page only, always Standalone.
- **Enable on detail page**
- **Enable for library views**
- **Show also on**

---

### Animated Keyart

The same for keyart: a textless animated poster.

Everything works like Animated Poster above, with the type name `animatedkeyart`. On top of that, Jellyfin's own logo can be laid over the keyart:

**Logo Overlay**

Separately for the **detail page** and for **library views**:

- **Enable logo overlay:** only shown when Jellyfin has a logo for the title
- **Vertical position:** from the top of the poster, 0 to 100 percent. Horizontally it is always centered.
- **Logo size:** width in percent of the poster

---

## Custom Poster

An alternative base poster: Postercase or Keyart. On detail pages and library tiles.

**Settings (tab-wide)**

- **Allowed image formats:** .jpg, .jpeg, .png, .webp, .gif, .tbn, .svg. Shared by both subs.
- **Priority when both exist:** Postercase or Keyart

---

### Postercase

A retouched poster with no lettering.

**Settings**

- **Show on:** Movies, Sets, TV shows. Sets use the Movies settings, but always Standalone.

**Movies**

- **Naming mode:** Prefixed, Standalone or Folder. In Folder mode, only the first file (alphabetical) is used.
- **Folder name:** `postercase`
- **Type name:** `postercase`
- **Enable on detail page**
- **Enable for library views**
- **For Movies show also on** and **For Sets show also on**

**TV Shows**

- **Naming mode:** Standalone or Folder
- **Folder name** and **Type name:** `postercase`. Main show page only.
- **Enable on detail page**
- **Enable for library views**
- **Show also on**

---

### Keyart

A textless poster.

Everything works like Postercase above, with `keyart` as type and folder name.

---

### Keyart + Logo

Keyart has no title on it. So Jellyfin's own logo can be laid over it, turning a textless poster back into a complete one, with the logo exactly where and as big as you want it.

Separately for the **detail page** and for **library views**:

- **Enable logo overlay:** only shown when Jellyfin has a logo for the title
- **Vertical position:** from the top of the poster, 0 to 100 percent. Horizontally it is always centered.
- **Logo size:** width in percent of the poster, the height follows automatically

---

## Extraposter aka Character Poster (Sets)

A niche but delightful multi-image feature. Got more than one poster for a movie? Extraposter shows them all, one after the other, with a soft fade in between. On the detail page and on library tiles.

The idea comes from the Kodi community's [Character Poster Sets](https://linktr.ee/CharacterPosterSets): a set of posters per movie, each one showing a different character. The project was later handed over to @Konon, who has since created countless high-quality, polished, hand-crafted sets. Naming and sorting follow character prominence, based on TMDB or general poster chronology. See the full collection on [DeviantArt](https://www.deviantart.com/konon-cat).

**Settings (tab-wide)**

- **Allowed image formats:** .jpg, .jpeg, .png, .webp, .gif, .tbn, .svg. Shared by both subs.
- **Priority when both exist:** Extraposter or Extrakeyart

---

### Extraposter

A poster slideshow.

**Where the Posters Come From**

- **Movies:** Prefixed `Movie (2013)-poster1.jpg`, Standalone `poster1.jpg`, or Folder: everything inside `extraposter/`.
- **TV shows:** Standalone `poster1.jpg`, or Folder: everything inside `extraposter/`. On top of that, their **season posters**.
- **Sets:** their own files, always Standalone, and on top of that, the **posters of the movies inside**.

**Movies and Sets**

Separately for the **detail page** and for **library views**:

- **Enable** and **Show on:** Movies, Sets
- **Set priority:** Files first, Files only, Set movie posters first, Set movie posters only. "First" uses the other source when this one has nothing.
- **Set order:** Release date ascending, Release date descending, Shuffle, Random
- **Random start position** for the set order
- **Set image:** which image each movie in the set shows. Poster, Postercase, Keyart, Animated Poster or Animated Keyart, named as in the Custom and Animated tabs.
- **Set fallback** and **Set second fallback:** used for a movie without that file. None skips the movie.
- **Set Keyart logo overlay:** the movie's own logo on its keyart, with position and size
- **Files order**, **Playback**, **Random start position**, **Display duration**, **Transition duration**, **Delay before first shown**, see [Slideshows](#slideshows)

**TV Shows**

Separately for the **detail page** and for **library views**:

- **Enable** and **Show on:** TV shows
- **Season priority:** Files first, Files only, Season posters first, Season posters only
- **Season order:** Ascending, Descending, Shuffle, Random, by season number
- **Random start position** for the season order
- **Include specials:** Season 0 is included and always shown first
- **Skip single-season series:** a series with only one season poster gets no season slideshow
- **Files order**, **Playback**, **Random start position**, **Display duration**, **Transition duration**, **Delay before first shown**

**Library Views Only**

- **Show also on** menus for Movies, Sets and TV shows
- **Tile seamless loading:** On is nicer to look at with a slightly longer wait. Off is quicker, the original poster peeks through first.
- **Tile synchronization:** tiles with the same display duration change together. A tile whose image is late joins the next beat.

---

### Extrakeyart

The multi-image, textless variant of Keyart.

Everything works like Extraposter above, with keyart instead: `Movie (2013)-keyart1.jpg`, `keyart1.jpg`, or everything inside `keyart/`, for movies and TV shows alike. One extra:

- **Unnumbered file:** Ignored, or Counts as #1. Whether a plain `keyart.jpg` is picked up as the first image.

Sets and TV shows use their own files only, there are no set or season posters for Extrakeyart.

---

### Extrakeyart + Logo

Just like [Keyart + Logo](#keyart--logo), for the whole slideshow: every keyart gets Jellyfin's own logo on top, in the same spot, so the logo stays put while the images change underneath.

Separately for the **detail page** and for **library views**, for movies and TV shows:

- **Enable logo overlay:** only shown when Jellyfin has a logo for the title
- **Vertical position:** from the top of the poster, 0 to 100 percent. Horizontally it is always centered.
- **Logo size:** width in percent of the poster, the height follows automatically

---

## LogoArt

A logo and art customizer for detail pages. For every item type, you decide what goes into the logo slot, how big it is and where it sits. Or whether there is a logo at all.

And something new: person pages get a logo too. From the person's folder, or their name in one of 120 bundled fonts.

Item types you leave untouched stay exactly as vanilla Jellyfin shows them.

**Sources**

- **clearlogo:** Jellyfin's own logo, the vanilla setting
- **clearart:** Jellyfin's clearart, shown in a 16:9 box on the logo line
- **characterart:** the same characterart files the [CharacterArt](#characterart) tab uses
- **Hide:** the slot stays empty

Every type except Persons has a **Source**, a **Fallback** and a **Second fallback**. If the source has no image, the fallback is tried, then the second one. None leaves the slot empty.

---

### Logos / Clearart / Characterart for Movies and Sets

**Movies**

- **Source:** clearlogo, clearart, characterart, Hide
- **Fallback**, **Second fallback**
- **Source mode:** Default (the item first, then its parents, like Jellyfin), Item only, Parent folder, Grandparent folder
- **Logo:** size in percent of the vanilla slot, horizontal offset, vertical offset
- **clearart:** size (100 = 25 percent of the screen width), horizontal offset, vertical offset
- **characterart:** scale by Height or Width, height and max width or width and max height, align (Centered, Left, Right), offset
- **Image mode:** Single image or Multi image. Multi: the plain file first, then the numbered ones.
- **Order**, **Playback**, **Random start position**, **Display duration**, **Transition duration**
- **If only 1 image is found:** stay static, or still fade out after one display duration

**Sets**

- **Settings:** Take over Movies or Individual. Individual gives sets the same options as movies, except Source mode.

---

### Logos / Clearart / Characterart for TV Shows

Series, season and episode pages, each with its own source.

- **Series:** the same options as movies, except Source mode
- **Season:** Take over Series or Individual. Source mode: Default, Season only, Series.
- **Episode:** Take over Series or Individual. Source mode: Default, Season, Series.

---

### Logos for Videos

Home video and music video pages. A folder logo is inherited like in Jellyfin.

- **Video** and **Music video**, each with:
  - **Source:** clearlogo, clearart, Hide
  - **Fallback**, **Second fallback**
  - **Source mode:** Default, Item only, Parent folder, Grandparent folder
  - **Logo** and **clearart** size and offsets

---

### Logos for Music

Album and artist pages. An album without a logo shows the artist's.

- **Album:** clearlogo, clearart, Hide. Source mode: Default, Album only, Artist. Logo and clearart size and offsets.
- **Artist:** clearlogo, clearart, Hide. Logo and clearart size and offsets.

---

### Logos for Books

Book and audiobook pages.

- **Source:** clearlogo, clearart, Hide
- **Fallback**, **Second fallback**
- **Logo** and **clearart** size and offsets

---

### Logos for Persons

Person pages, where Jellyfin shows no logo at all.

**Sources**

- **Off:** no logo, like Jellyfin
- **Folder logo:** a file in the person's own Jellyfin folder, `clearlogo.png`, `.webp` or `.jpg`
- **Text:** the person's name, drawn live in one of the bundled fonts, fitted to the slot

**Fonts**

120 fonts come with the plugin:

- **Signature:** 60 handwriting fonts
- **Title:** 60 headline fonts
- **Both:** all 120

Open the font list to tick the ones you like, and hover one for a preview with your own preview names. One font ticked: everyone gets that font. Several ticked: each person gets one of them, and always the same one.

If a font has no accented letters, the name is written without accents.

**Create Logos**

The **Create logos** button writes a real `clearlogo.png` for every person into their Jellyfin folder, in the fonts you picked. Update writes only the missing ones, Replace writes all of them. After that, Folder logo shows them without any live drawing.

**Settings**

- **Source:** Off, Folder logo, Text
- **Fallback:** None, Folder logo, Text
- **Base name:** `clearlogo`
- **Font pool:** Signature, Title, Both
- **Fonts:** check all, uncheck all, or pick single ones
- **Preview names:** comma-separated names for the hover preview
- **Text stroke:** thickens the white letters, in percent of the text size
- **Outline:** black rim around the letters, in percent of the text size, 1 is a fine line
- **Uppercase:** title fonts only, signature fonts keep their case
- **Create logos:** Update or Replace
- **Size**, **Offset**, **Vertical offset**

---

## CharacterArt

Characters from the movie or show, cut out and placed on the detail page. Next to the title logo in the top left or top right, or in a bottom corner of the screen.

TV show characterart has official support on [fanart.tv](https://fanart.tv/tv-fanart/#characterart). Movie characterart unfortunately has no database or API support, only fan projects like the Kodi community's [Characterart PNG's for Movies/Moviesets](https://forum.kodi.tv/showthread.php?tid=342468). Many more can be found on DeviantArt.

**Settings (tab-wide)**

- **Allowed image formats:** .jpg, .jpeg, .png, .webp, .gif, .tbn, .svg. Empty disables CharacterArt.
- **Show on:** Movies, Sets, TV shows, Seasons, Episodes. Season and episode pages always show the parent show's characterart.

---

### Characterart for Movies

- **Naming mode:** Prefixed, Standalone or Folder. `Movie (2013)-characterart.png`, `characterart.png`, or everything inside `characterart/`. Sets always use Standalone.
- **Type name** and **Folder name:** `characterart`
- **Image mode:** Single image (`characterart.png`, no number) or Multi image: the plain file first, then `characterart1.png`, `characterart2.png` and so on
- **Order**, **Playback**, **Random start position**, **Display duration**, **Transition duration**, **Delay before first shown**
- **If only 1 image is found:** stay static, or still fade out after one display duration
- **Position:** Top left, Top right, Bottom left, Bottom right

---

### Characterart for TV Shows

The same set of options, always read from the show's main folder, whichever page is open.

- **Naming mode:** Standalone or Folder
- **Type name** and **Folder name:** `characterart`
- Image mode, slideshow and position as above

---

### Positions

- **Top left** and **Top right:** next to the logo, scrolls with the page. Hidden in narrow windows, just like Jellyfin's own logo.
- **Bottom left** and **Bottom right:** glued to the window, does not scroll

Each of the four positions has its own settings:

- **Scale by:** Height or Width, the other follows automatically
- **Height / max width** or **Width / max height:** 0 as max means auto, following the image
- **Align:** Centered, Left or Right, once a max value is set
- **Offset:** shifts the whole box left or right
- **Fullscreen offset:** an extra shift only while the browser is in fullscreen

---

## Red Carpet

Full-figure actress art on person pages, pinned to the bottom left or bottom right corner.

Originally a project by the Kodi community. Download the addon from the [Kodi addon page](https://kodi.tv/addons/omega/resource.images.actorart/), and copy the PNGs from inside it into a folder called `Red Carpet` in your Jellyfin metadata folder. Each file is named exactly like the person in Jellyfin:

```
/config/metadata/Red Carpet/Scarlett Johansson.png
```

For more information, visit the [Red Carpet](https://linktr.ee/RedCarpetCandy) project page.

**Settings**

- **Allowed image formats:** .jpg, .jpeg, .png, .webp, .gif, .tbn, .svg. Empty disables Red Carpet.
- **Show on:** Person's own page, Movie filmography, TV show filmography, Episode filmography
- **Folder name:** `Red Carpet`
- **Position:** Bottom left or Bottom right. Glued to the window, does not scroll.
- **Per position:** scale by, height / max width, width / max height, align, offset, fullscreen offset, see [Positions](#positions)

---

## Backdrops

Various backdrop extensions beyond vanilla Jellyfin. Seven categories, each with its own section and its own Restore defaults button.

Backdrops change with a soft fade and move slowly with a Ken Burns zoom and pan, with the same values as the Aeon MQ7 home screen. They stop while a video is playing.

**Shared Settings**

Every category has:

- **Cycle time:** how long each backdrop stays (no upper limit)
- **Ken Burns effect:** slow zoom and pan instead of a plain fade
- **Zoom speed:** one zoom direction
- **Pan speed:** one pan direction
- **Order** and **Random start position**

The pages built from other titles (People, Genre, Studio, Tag, Favorites) also have:

- **Backdrops per item:** Main Backdrop (only the item's first backdrop) or All Backdrops (a random one per item)
- **Order:** Shuffle, Random, Name, Sort name, Date added, Premiere date, Production year, Start date, Community rating, Critic rating, Parental rating, Runtime, Play count, Date played, Video bit rate, Played, Unplayed, Favorite, Studio
- **Traversal:** Ascending or Descending

Favorites has its own, shorter lists, see [Favorites Backdrops](#favorites-backdrops). People and Studio use these only with the Appearances source.

---

### Listener

Where the backdrops of your titles come from, on every backdrop page. This applies to the whole tab.

- **Native**: Jellyfin's own backdrops, the fastest way
- **Custom:** reads your folders directly, for example Kodi-style names, without duplicating any files. It picks up `fanart`, `background` and `art` (numbered, or with the video name in front) and everything inside `extrafanart/`. Your own **base name** (for example `fanart`) takes the place of Jellyfin's `backdrop`: `fanart1.jpg`, `Movie (2013)-fanart1.jpg` and so on, up to 20.

**Allowed image formats:** .jpg, .jpeg, .png, .webp, .gif, .tbn, .svg. People backdrops from Wallpapers.com are not affected.

---

### Detail View Backdrops

The item's own backdrops behind its detail page, with your rules. This replaces Jellyfin's own **Details Banner** display setting.

**Settings**

- **Enable native Backdrops override**
- **Show on:** Movies, Sets, TV shows, Seasons, Episodes, Videos. Each one on its own, unchecked ones stay vanilla.
- **Cycle time**, **Ken Burns effect**, **Zoom speed**, **Pan speed**
- **Order:** Sequential (Jellyfin's order), Shuffle, Random
- **Random start position**

**Episode Backdrops**

Own backdrop files per episode. Without files, the season and then the show backdrops are used.

- **Base name:** `backdrop`. The episode file name always goes in front: `Episode.mkv` gets `Episode-backdrop.jpg`
- **Backdrop files:** Single (`Episode-backdrop.jpg`) or Multiple: `Episode-backdrop1.jpg`, `Episode-backdrop2.jpg` and so on, up to 20
- **Order:** Sequential, Shuffle, Random
- **Random start position**

Like vanilla, detail page backdrops are off on the mobile layout and in very narrow windows.

---

### Library View Backdrops

Random backdrops behind the Home, library and search pages. This replaces Jellyfin's own **Backdrops** display setting, and goes further.

**Settings**

- **Enable native Backdrops override**
- **Show on (vanilla):** Home (including Favourites), Movies, TV shows, Music. The pages Jellyfin's own setting covers.
- **Show on (custom):** Sets, Search, User settings. Pages Jellyfin never gives a backdrop.
- **Home rating cap:** PG-13 or Off. On Home, Favourites, Search and User settings, vanilla only shows titles up to PG-13. Off shows every rating.
- **Cycle time**, **Ken Burns effect**, **Zoom speed**, **Pan speed**
- **Order:** Sequential, Shuffle, Random
- **Random start position**

A new random pool is drawn on every visit.

---

### People Backdrops

Backdrops on person pages. From their own movies and shows, from a folder, or from the web.

**Sources**

- **Appearances:** the backdrops of the person's own movies and shows
- **Folder:** backdrop files in the person's own Jellyfin folder
- **Wallpapers.com**: wallpapers of the person from [Wallpapers.com](https://wallpapers.com/). Your server looks up the person's name there, so it needs internet access. Only widescreen images are used, and the images themselves load straight from Wallpapers.com.

**Settings**

- **Enable**
- **Show on:** Person's own page, Movie filmography, TV show filmography, Episode filmography
- **Cycle time**, **Ken Burns effect**, **Zoom speed**, **Pan speed**
- **Source:** Appearances, Folder, Wallpapers.com
- **Wipe cache:** forgets every Wallpapers.com result, so they are looked up again

**Appearances**

- **Appearances filter:** Movies and shows, Movies only, Shows only
- **Backdrops per item:** Main Backdrop or All Backdrops
- **Order:** Shuffle and the full list of sort fields
- **Traversal:** Ascending or Descending
- **Random start position**

**Folder**

- **Base name:** `backdrop`
- **Backdrop files:** Single (`backdrop.jpg`) or Multiple (`backdrop1.jpg`, `backdrop2.jpg` and so on)
- **Order:** Sequential, Shuffle, Random
- **Random start position**

**Wallpapers.com**

- **API Key:** optional, with a **Test API Key** button. Without a key you get about 30 lookups a minute, with a free key 60.
- **Order:** Sequential, Shuffle, Random
- **Random start position**
- **Max images per person:** 1 to 10. The actual count can be lower after filtering.
- **Enable text filter:** skips images with text on them. It is not a text recognition engine, so some images with text may still slip through.

---

### Genre Backdrops

Backdrops on genre pages, from the titles of that genre.

**Settings**

- **Enable**
- **Apply to:** Global Genres, Movie Genres, TV show Genres
- **Backdrops per item:** Main Backdrop or All Backdrops
- **Cycle time**, **Ken Burns effect**, **Zoom speed**, **Pan speed**
- **Order**, **Traversal**, **Random start position**

---

### Studio Backdrops

Backdrops on studio pages, from the studio's own image or from the studio's titles.

**Sources**

- **Studio image**: the studio's own `landscape.jpg` from Jellyfin's metadata folder, `metadata/Studio/<Name>/landscape.jpg`
- **Appearances:** the backdrops of the studio's titles

**Settings**

- **Enable**
- **Apply to:** Global Studios, TV show Studios
- **Source:** Appearances or Studio image
- **Backdrops per item:** Main Backdrop or All Backdrops
- **Cycle time**, **Ken Burns effect**, **Zoom speed**, **Pan speed**
- **Order**, **Traversal**, **Random start position**

---

### Tag Backdrops

Backdrops on tag pages, from the titles carrying that tag.

**Settings**

- **Enable**
- **Backdrops per item:** Main Backdrop or All Backdrops
- **Cycle time**, **Ken Burns effect**, **Zoom speed**, **Pan speed**
- **Order**, **Traversal**, **Random start position**

---

### Favorites Backdrops

Backdrops on the full list of each Favorites section, from your favourite titles and people.

**Settings**

- **Enable**
- **Backdrops per item:** Main Backdrop or All Backdrops
- **Cycle time**, **Ken Burns effect**, **Zoom speed**, **Pan speed**
- **Manage:** General, one order for every type, or Individual, each type sets its own
- **General order:** Shuffle, Random, Name, Date added. Only fields every type supports.
- **Traversal**, **Random start position**

**Types**

Eleven types, each with its own Enable. With Manage set to Individual, each also gets its own Sort, Traversal and Random start position. The sort lists differ by type: Playlists and Artists only offer Shuffle, Random and Name, Shows add Date episode added, Songs add Album, Album artist and Artist, Albums add Album artist.

- Movies
- Shows
- Episodes
- Videos
- Collections
- Playlists
- People
- Artists
- Albums
- Songs
- Books

**People** have their own source: Appearances, Folder or Wallpapers.com. Appearances has its own filter, backdrops per item, order, traversal and random start. Folder has its own backdrop files, order and random start, and uses the base name from [People Backdrops](#people-backdrops). Wallpapers.com uses the People Backdrops settings: API key, order, max images and text filter.

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

3. Go to the Catalog tab, find ArtworkPlus (category: Experimental), and install it
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

Every settings tab has its own **Restore defaults** button in the top right corner. It resets only the settings of that tab to their default values, everything else stays untouched. Many sections inside a tab have their own button too, like Case Mix, Postercase, Keyart, Extraposter, Extrakeyart and every backdrop category. Click **Save** afterwards to keep them.

### Restore Defaults (All)

The General tab has an additional **Restore all tabs** button. This resets every setting across all tabs back to their defaults in one go. Click **Save** afterwards. This also clears your Wallpapers.com API key.

### Backup and Restore (All)

The General tab also includes a code-based backup system. **Generate** creates a compact code that represents your complete current settings, **Copy to clipboard** copies it. Store it somewhere safe. **Import** lets you paste that code back at any time to restore your full configuration, for example after a reinstall or when moving to a new server. After importing, click **Save all settings**. Your Wallpapers.com API key is not part of the code.

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
- Animated Poster Project, Character Poster Sets, Characterart PNG's and Red Carpet: the Kodi community
- Animated Poster Project: above all @moulfo, its main artist, who sadly passed away in 2020. All credit for this art style goes to him.
- Character Poster Sets: @Konon, see the full collection on [DeviantArt](https://www.deviantart.com/konon-cat)
- Characterart for TV shows: [fanart.tv](https://fanart.tv)
- The Three.js Case runs on [three.js](https://threejs.org). Its model is based on the JFX DVD/Blu-ray case package (2009), heavily reworked.
- Case colors from the poster: [Color Thief](https://lokeshdhakar.com/projects/color-thief/)
- Title fonts and the back cover font (Red Hat Display) from Google Fonts, license files included
- German hyphenation patterns from [hyphenation-patterns](https://github.com/bramstein/hyphenation-patterns) (LGPL)
- Studio logos and rating marks belong to their respective owners

---

## License

MIT License

Forking and further development strongly encouraged.
Feedback and bug reports welcome, feel free to open an issue.

---
