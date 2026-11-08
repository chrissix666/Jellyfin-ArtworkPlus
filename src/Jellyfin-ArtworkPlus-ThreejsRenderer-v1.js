/*!
 * ArtworkPlus - Three.js Case renderer
 * --------------------------------------------------
 * PORTED CODE. Everything below the prologue is copied verbatim from the
 * core of the standalone Three.js case renderer ("upstream" in these
 * comments) - not retyped, not re-derived, so an upstream change comes
 * over as a plain diff.
 *
 * What this file is NOT: the decision whether a page gets a case (that lives
 * in Posters-v1.js next to the poster arbiter) and the canvas plumbing. This
 * is the geometry alone.
 *
 * The prologue supplies what the upstream PAGE supplies around the core:
 * the state variables its controls write, and stubs for the three places
 * where it writes status text into its toolbar. The geometry never READS a
 * control, which is what makes a copy like this possible at all.
 */
(function () {
    'use strict';

    // The engine must already be there: module-level constants below evaluate
    // THREE.Color at LOAD time (BODY_COL, FINISH, LOGO_C). Posters-v1.js loads
    // three.js before this file for exactly that reason; init() can still
    // replace it afterwards.
    var THREE = window.THREE || null;
    var MESH = null;

    // ---- what the upstream page's controls write ---------------------------
    // Values, not widgets. Set through configure() before a model is built.
    var openAngle = 0, spineShare = 0.5, lidFirst = false, aspectMode = 'fitb';
    var posterAspect = 2 / 3, logoScale = 1.0, logoMode = '3d', hingeOut = 1.0;
    var blackCase = false, onlyBack = false, caseColMode = 'model';
    // discSize is set per model in build() (as upstream's model switch does);
    // DISC_OFF is upstream's, taken verbatim next to DISC_SIZE, so the disc and
    // the hub button sit at upstream's fitted place.
    var discOn = true, discSize = 1.0, currentDisc = null;
    var HUB_OFF = { x: 0, y: 0 };
    var furnOn = true, furnConcept = 'A', bookletOn = false, furnY = 0;
    // `plastic` and `entry` are upstream's own const arrows inside the ported
    // core; as null placeholders they would throw inside pickColour.
    // 'finish' is an INDEX into FINISH = [0.5, 0.62, 0.74, 0.86, 1.0], not a
    // name; upstream's default is 1, satin. A name would make FINISH[name]
    // undefined, and an undefined roughness reaches the shader as NaN: six
    // materials (matCaseIn, matCaseInBL, matInner, matLidIn, matFurn, matHub)
    // then light as NaN and flare WHITE at grazing angles along the case's
    // notches.
    var FURN_Y = 0, finish = 1;
    var intR = 0, intL = 0;   // indices into the sets above, not names
    var studioOn = true, formatOn = true, tmdbOn = true, badgeColMode = 'auto', currentStudio = null;
    var currentTmdb = null, currentPoster = null;
    var M = null, models = {};

    // ---- what upstream's build bakes into the page --------------------------
    // Everything here is a BUILD PLACEHOLDER upstream, resolved by its
    // build.py. There is no build step here, so the values live here, derived
    // from upstream's source wherever a derivation exists - none of these
    // numbers is guessed.
    //
    // HUB_GEOM sounds like a texture and is geometry: it decides where disc,
    // hub and the tray's 3D boss sit. size = the hub decal square,
    // 2*(HUB_R 82 + HUB_PAD 8)*SCALE 3; px = HUB_CENTRE*SCALE, the fitted hub
    // reference.
    var HUB_GEOM = { size: 540, px: [650.3, 1113.5] };

    // The texture sets. Blank: the case renders in its shell colour with the
    // printed wrap on top. The interior maps, lid maps and hub decals are
    // generated artefacts of upstream's build.
    // Opaque WHITE, never transparent: a texture map is multiplied with the
    // material colour, so white is the neutral element. A transparent stub
    // would make every textured surface of the case vanish.
    var PNG_BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=';
    var TEX = { bluray: PNG_BLANK, dvd: PNG_BLANK, dvdgen: PNG_BLANK };
    var BOOKLET_TEX = { bluray: PNG_BLANK, dvd: PNG_BLANK, dvdgen: PNG_BLANK };
    // The real interior maps, derived from upstream's PNGs and served by the
    // plugin (~63 KB). INTERIOR_PNG stays blank on purpose: upstream loads it
    // into interiorTex and never uses it again - about 1 MB of dead weight.
    var TEXTURE_URL = '/ThreejsCase/lib/texture/';
    var PROC_PNG = TEXTURE_URL + 'frame_plain.png', INTERIOR_PNG = PNG_BLANK;
    var templateBooklet = {};   // upstream declares this next to BOOKLET_TEX, which is a placeholder
    // One variant each - upstream's defaults (intR 4 -> R5, intL 8 -> L9,
    // H follows intR). setTex() indexes these arrays, so intR/intL are 0 here.
    var INTERIOR_SET = [TEXTURE_URL + 'R5.webp'];
    var LID_SET = [TEXTURE_URL + 'L9.webp'];
    var HUB_SET = [TEXTURE_URL + 'H5.webp'];
    var INTERIOR_NAMES = ['R5'], LID_NAMES = ['L9'];
    // BOOKLET, ANIM, BACK and DEBUG are NOT placeholders - they are real
    // upstream constants and are extracted with the rest. Stubbing BOOKLET as
    // {on:false} would replace its geometry and produce NaN inside a curve,
    // surfacing as a three.js error far from the cause.
    var currentBack = null, DIAG_SHELL = false;
    // What the HOST put on the case. Upstream keeps the studio and the code in
    // variables of its own and re-places them on every fit; the spine logo it
    // does not, because upstream's page never re-fits on its own. Here
    // something does - the format mark is a real URL, and its onload re-runs
    // the whole fit chain - so the logo has to be remembered too.
    var currentSpineLogo = null;
    // Upstream's names for the two images its booklet painter reads. The
    // clearlogo is the same picture the spine wears; the poster is the cover
    // painted anyway. Only the booklet asks for them by these names.
    var currentPoster = null, currentLogo = null;
    // 'model' = no derived colour at all (our "Standard"); any other value is
    // one of upstream's seven blends. onlyBack is the second axis: with it the
    // plastic keeps the model colour and only the back paper and the spine
    // take the derived one (our "Back Spine"), without it every plastic part
    // takes it (our "Full Shell"). Read from upstream's applyCaseColour.
    var caseColMode = 'model', onlyBack = false;
    // The Color Thief palette AND its 48x48 sample, filled by analysePoster.
    // pickColour() gives up on its first line when either is missing, and
    // every colour mode then returns the shell colour.
    var posterPalette = [], posterSample = null;

    // The one upstream function deliberately NOT taken, for the same reason
    // as backAssets and loadBack: it is a seam to the host. Upstream's
    // paintCover draws its printed TEMPLATE under the artwork, and that PSD is
    // not shipped - taken verbatim it would fill the wrap with upstream's
    // fallback grey. So this is a bridge to the host's own wrap painter, which
    // fills with the case colour instead. Everything else about the chain -
    // when it is called, with which hex - stays upstream's.
    var onRepaintWrap = null;
    function paintCover(img, hex) {
        if (onRepaintWrap) { onRepaintWrap(img, hex); }
    }

    // Upstream's swatch strip is page furniture. analysePoster calls it at the
    // end, so without a stub the whole analysis throws and leaves an empty
    // palette.
    function renderSwatches() { /* upstream UI, not needed here */ }
    // Upstream's slider for how wide the spine logo may get. It is a CONTROL
    // there, so it is not part of the ported core; setSpineLogo() reads it, and
    // without a definition the whole mount would die on a ReferenceError.
    // Per SHELL, from upstream's own table (bluray is 1.5 - a flat 1.0 limits
    // the logo by height a third too early). The value is read on every
    // setSpineLogo, so it follows a model switch.
    var spineLogoScale = 1.0;
    function spineLogoScaleFor(name) {
        return (typeof SPINE_LOGO_SCALE !== 'undefined' && SPINE_LOGO_SCALE[name]) || 1.0;
    }
    // The spine-foot marks. Empty maps, not null: the badge code looks up by
    // model name, and a missing entry means "no badge", while null throws.
    var tmdbImg = {}, formatImg = {};
    // The spine foot marks, from the studio pack we already ship. Keyed by
    // MODEL name, which is what formatImage() looks up - the server's own
    // answer (SpineFormatMark) names the same two files, and the two agree
    // because both come from one chart: a 4K disc is a Blu-ray and wears the
    // Blu-ray mark.
    var ASSET_URL = '/ThreejsCase/asset/';
    var SPINE_MARK = {
        bluray: ASSET_URL + 'studio-logos/Blu-Ray.png',
        dvd: ASSET_URL + 'studio-logos/DVD.png',
        dvdgen: ASSET_URL + 'studio-logos/DVD.png',
        // upstream's __BADGE_UHD__ (build.py: resources/studio-logos/4K-Ultra-HD.png), shipped in the same pack
        uhd: ASSET_URL + 'studio-logos/4K-Ultra-HD.png'
    };
    var procTex = null;   // templateTex comes over with texCache from upstream

    // The engine objects the upstream page owns. Posters-v1.js owns them here
    // and hands them over in init(); the ported code only ever reads them.
    var renderer = null, scene = null, camera = null, perspCam = null, orthoCam = null;
    var orbit = { theta: 0.55, phi: 1.35, dist: 100, target: null };

    // Upstream also writes through the IMPLICIT globals a browser creates for
    // an element id (`dims.textContent`, not document.getElementById('dims')),
    // which is why the redirect above cannot see them. Both are status text,
    // like the rest: the fitted cover dimensions and the hinge angle.
    var dims = null, dims2 = null;   // assigned below, once statusEl exists

    // ---- colour ---------------------------------------------------------------
    // applyCaseColour() is upstream's own, extracted with the core: it derives
    // the colour from the poster palette and tints eleven materials across two
    // groups. Its writes into upstream's toolbar land in the status sinks below.
    var onCaseHex = null;        // the host hears every derived hex


    // ---- the three status-text sinks (upstream writes into its toolbar) ----
    // The core's ONLY DOM touches are these three, and all three write
    // outwards. The port rewrites the lookups to statusEl(), so the numbers
    // land here instead of throwing on an element that does not exist in
    // Jellyfin. They stay readable through state().status - the hub reference
    // pixel and the fitted cover dimensions are worth having when something
    // looks wrong.
    var statusSink = {};
    function statusEl(id) {
        var box = statusSink[id] || (statusSink[id] = {});
        return {
            set textContent(v) { box.textContent = v; },
            get textContent() { return box.textContent || ''; },
            set value(v) { box.value = v; },
            get value() { return box.value; },
            set checked(v) { box.checked = v; },
            get checked() { return !!box.checked; },
            // Upstream's applyCaseColour ends by painting the derived colour into
            // its own little swatch label - lab.style.background. Without `style`
            // that last line would throw, and because it sits at the END of
            // applyCaseColour it would take the whole fit chain with it. A sink for
            // writes, like the rest.
            get style() { return box.style || (box.style = {}); }
        };
    }

    dims = statusEl('dims');
    dims2 = statusEl('dims2');

    // ==================== PORTED CORE BELOW ====================

const BADGE = {
  opacity: 0.88,                                                  // print, never pure white
  bluray: {studio: {yFrac: 0.07, hFrac: 0.07, wFrac: 0.55, size: 1.10, dy: 1.0}, format: {onLip: true, hFrac: 0.80, wFrac: 0.45, size: 1.10, dy: 3.0}, tmdb: {hFrac: 0.020, wFrac: 0.40, size: 1.10, dy: 0}},   // fitted placement
  dvd:    {studio: {yFrac: 0.10, hFrac: 0.07, wFrac: 0.55, size: 1.10, dy: -0.5}, format: {onLip: false, yFrac: 0.035, hFrac: 0.045, wFrac: 0.45, size: 1.40, dy: 0}, tmdb: {hFrac: 0.020, wFrac: 0.40, size: 1.10, dy: 0}},   // fitted DVD placement
  dvdgen: {studio: {yFrac: 0.10, hFrac: 0.07, wFrac: 0.55, size: 1.10, dy: -0.5}, format: {onLip: false, yFrac: 0.035, hFrac: 0.045, wFrac: 0.45, size: 1.40, dy: 0}, tmdb: {hFrac: 0.020, wFrac: 0.40, size: 1.10, dy: 0}},   // fitted DVD placement
};

const BOOKLET = {ground: 'bw', W: 900, key: null};

const ANIM = {on: true, mode: 'seq', max: 120, openMs: 900, pauseMs: 1000, spinMs: 1500, closeMs: 900, turns: 1,
              driving: false, state: null, move: null, spin: null};

const MODELS = {
  bluray: {label:'Blu-ray Case', FC:{x0:-25.752, x1:22.958, y0:1.737, y1:55.782}, OUT:{x0:-27.462, x1:24.668, y0:0.005, y1:62.583},
           Z:{min:-1.701, max:3.203}, hingeZ:{a:-0.30, b:1.80}, shell:0x003986, logoZ:0,
           uvFront:{u0:0.5332,u1:0.9510,v0:0.0299,v1:0.4936}, uvBack:{u0:0.0469,u1:0.4648,v0:0.0299,v1:0.4936}},
  dvd:    {label:'DVD Case',     zScale: 14/19, FC:{x0:-19.684, x1:29.252, y0:1.442, y1:72.248}, OUT:{x0:-22.020, x1:31.385, y0:0.005, y1:73.685},
           Z:{min:-3.163, max:4.188}, hingeZ:{a:-2.32, b:3.35}, shell:0x1c1c1e, logoZ:4.188-3.203,
           uvFront:{u0:0.5445,u1:0.9583,v0:0.0544,v1:0.6531}, uvBack:{u0:0.0419,u1:0.4557,v0:0.0544,v1:0.6531}},
  // Generated DVD shell - the JFX DVD stays as "DVD (JFX)".
  // Generated double-walled from the measured DVD dimensions; runs through the Blu-ray code path.
  // z is final here (the JFX depth correction 14/19 is already in the numbers).
  dvdgen: {label:'DVD Case', FC:{x0:-19.684, x1:29.252, y0:1.442, y1:72.248}, OUT:{x0:-22.020, x1:31.385, y0:0.005, y1:73.685},
           Z:{min:-2.196, max:3.221}, hingeZ:{a:-2.196+0.62, b:3.221-0.62}, shell:0x1c1c1e, logoZ:3.221-3.203,
           uvFront:{u0:0.5445,u1:0.9583,v0:0.0544,v1:0.6531}, uvBack:{u0:0.0419,u1:0.4557,v0:0.0544,v1:0.6531},
           doubleWall:true, rx:0.84,
           gen:{rEdgeN:0.84, rEdgeD:0.62, rCorner:0.84, wall:0.31, paperIn:0.28, floorIn:0.53, paperSpineIn:0.14, paperPanelIn:0.56, paperRz:0.55, clamp:0.6}},
};

const LOGO_C = {x:(-5.0932+2.4746)/2, y:(56.5302+60.5226)/2, h:(60.5226-56.5302)};

const SPINE_T = 0.4;

function geo(g){
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(g.p,3));
  bg.setAttribute('normal',   new THREE.Float32BufferAttribute(g.n,3));
  bg.setAttribute('uv',       new THREE.Float32BufferAttribute(g.t,2));
  return bg;
}

function splitByZ(g, zFront, zBack){          // shell -> front lid / back lid / rest
  const P=g.p, N=g.n, T=g.t, parts={lid:{p:[],n:[],t:[]}, back:{p:[],n:[],t:[]}, rest:{p:[],n:[],t:[]}};
  for (let i=0;i<P.length;i+=9){
    let f=true, b=true;
    if (T[i/9*6] < -0.5 || T[i/9*6+2] < -0.5 || T[i/9*6+4] < -0.5){ f=false; b=false; }   // any marked vertex -> the triangle stays in `rest` (frames get planar UVs later, which would erase the marks)
    for (let k=0;k<9;k+=3){ if (!(P[i+k+2] > zFront && N[i+k+2] >  0.05)) f=false;
                            if (!(P[i+k+2] < zBack  && N[i+k+2] < -0.05)) b=false; }
    const dst = f ? parts.lid : b ? parts.back : parts.rest;
    for (let k=0;k<9;k++){ dst.p.push(P[i+k]); dst.n.push(N[i+k]); }
    for (let k=0;k<6;k++) dst.t.push(T[i/9*6+k]);
  }
  return parts;
}

const PNG = {"w": 1472, "h": 2348, "px": [48, 84, 1388, 1424], "py": [2300, 2263, 307, 48], "logoFrac": 0.5};

const loadTex = u => { const t = new THREE.TextureLoader().load(u); t.encoding = THREE.sRGBEncoding; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t; };

const texCache = {}, templateTex = {};

const setTex = (set, i) => texCache[set+i] || (texCache[set+i] = loadTex((set==='R' ? INTERIOR_SET : set==='H' ? HUB_SET : LID_SET)[i]));

const srgb = hex => new THREE.Color().setHex(hex).convertSRGBToLinear();

const FURN = {
  clipY: [0.16, 0.84], clipX0: 0.0, clipX1: 0.17, clipH: 0.09,    // fractions of the inner rect
  strapMM: 0.2, ramp: 0.30,                                        // strap thickness in MM, ramp share of length
  frameW: 0.36, wireR: 0.15,                                       // frame wall of clip style B / wire radius of style C - their own dimensions, NOT the plate thickness
  stopW: 0.45,                                                     // width of a stop ridge (model units)
  bookletMM: 1.0,                                                  // booklet thickness in MM
  bookY: [0.072, 0.928], bookX0: 0.94, bookX1: 0.02,               // slab rect: fractions of the inner rect / from its outer edge
  sink: 0.02,                                                      // the slab lies this far below the lid floor (no z-fighting with the lid map)
  clipClear: 0.12, stopGap: 0.15, stopRise: 0.15,                  // clearance under the strap, stop-to-slab gap, how far a stop rises above the slab
};

function bookletSlab(D){
  const X0 = D.FC.x0, X1 = D.FC.x1 - 0.05, Y0 = D.FC.y0, Y1 = D.FC.y1, W = X1 - X0, Hh = Y1 - Y0;
  return {x0: X1 - FURN.bookX0*W, x1: X1 - FURN.bookX1*W, y0: Y0 + FURN.bookY[0]*Hh, y1: Y0 + FURN.bookY[1]*Hh, t: FURN.bookletMM/D.mmU};
}

function threeToArrays(geoms){                     // merge THREE geometries -> {p,n,t} non-indexed
  const o = {p:[],n:[],t:[]};
  for (const g of geoms){
    const ng = g.index ? g.toNonIndexed() : g;
    ng.computeVertexNormals();
    const P = ng.attributes.position.array, N = ng.attributes.normal.array;
    for (let i=0;i<P.length;i++){ o.p.push(P[i]); o.n.push(N[i]); }
    for (let i=0;i<P.length/3*2;i++) o.t.push(0);
  }
  return o;
}

function roundedRect(x0, x1, y0, y1, rl, rr){
  const s = new THREE.Shape();
  s.moveTo(x0+rl, y0); s.lineTo(x1-rr, y0); if (rr) s.absarc(x1-rr, y0+rr, rr, -Math.PI/2, 0, false); else s.lineTo(x1, y0);
  s.lineTo(x1, y1-rr); if (rr) s.absarc(x1-rr, y1-rr, rr, 0, Math.PI/2, false); else s.lineTo(x1, y1);
  s.lineTo(x0+rl, y1); if (rl) s.absarc(x0+rl, y1-rl, rl, Math.PI/2, Math.PI, false); else s.lineTo(x0, y1);
  s.lineTo(x0, y0+rl); if (rl) s.absarc(x0+rl, y0+rl, rl, Math.PI, Math.PI*1.5, false); else s.lineTo(x0, y0);
  return s;
}

function strip(shape, t, zSurf, s, xRoot, rampLen, lift, bevel){
  // The bevel adds `bevel` at BOTH faces, so extrude that much shorter and shift back - the
  // plate is then exactly t thick.
  const ex = new THREE.ExtrudeGeometry(shape, {depth: Math.max(1e-4, t - 2*bevel), bevelEnabled: !!bevel, bevelSize: bevel||0, bevelThickness: bevel||0, bevelSegments: 2, curveSegments: 12});
  // ExtrudeGeometry has no x-subdivision: split long edges by re-tessellating along x
  const g = subdivideX(ex.toNonIndexed(), Math.max(0.15, rampLen/8), xRoot - rampLen, xRoot + rampLen);
  const P = g.attributes.position.array;
  for (let i=0;i<P.length;i+=3){
    const u = Math.min(1, Math.abs(P[i]-xRoot)/rampLen), e = u*u*(3-2*u);       // smoothstep, either side of the root
    P[i+2] = zSurf + s*(lift*e + P[i+2] + bevel);      // extrude runs 0..t in +z -> mirrored onto the surface side
  }
  g.computeVertexNormals();
  return g;
}

function subdivideX(g, step, xa, xb){
  let P = Array.from(g.attributes.position.array);
  for (let pass=0; pass<12; pass++){
    const out = []; let split = 0;
    for (let i=0;i<P.length;i+=9){
      const xs = [P[i],P[i+3],P[i+6]], mn = Math.min(...xs), mx = Math.max(...xs);
      if (mx-mn > step && mx > xa-1e-6 && mn < xb+1e-6){
        // split the longest edge in x
        let best=0, bl=-1; for (let k=0;k<3;k++){ const l=Math.abs(xs[k]-xs[(k+1)%3]); if (l>bl){bl=l;best=k;} }
        const A=i+best*3, B=i+((best+1)%3)*3, C=i+((best+2)%3)*3;
        const m=[(P[A]+P[B])/2,(P[A+1]+P[B+1])/2,(P[A+2]+P[B+2])/2];
        out.push(P[A],P[A+1],P[A+2], m[0],m[1],m[2], P[C],P[C+1],P[C+2]);
        out.push(m[0],m[1],m[2], P[B],P[B+1],P[B+2], P[C],P[C+1],P[C+2]);
        split++;
      } else out.push(...P.slice(i,i+9));
    }
    P = out; if (!split) break;
  }
  const ng = new THREE.BufferGeometry(); ng.setAttribute('position', new THREE.Float32BufferAttribute(P,3)); return ng;
}

function lidFurniture(D, zSurf, part){           // part: 'stops' or a clip concept 'A' | 'B' | 'C'
  // inner rectangle of the lid: x from the flat panel start (spine side) to the inner face of the
  // outer rim wall (= flat cover edge), y = the window
  const X0 = D.FC.x0, X1 = D.FC.x1 - 0.05, Y0 = D.FC.y0, Y1 = D.FC.y1, W = X1-X0, Hh = Y1-Y0;
  const s = -1;                                    // furniture grows INTO the case (-z for the lid)
  const geoms = [];
  const box = (cx, cy, cz, sx, sy, sz) => { const b = new THREE.BoxGeometry(sx, sy, sz); b.translate(cx, cy, cz); return b; };
  // stops: low ridges with rounded ends, one on each long edge of the booklet slab - same
  // length as the slab, a hair's clearance beside it, and tall enough to stand over its thickness.
  // Derived from bookletSlab(), so they are symmetric about the slab's centre by construction.
  if (part === 'stops'){ const B = bookletSlab(D), hw = FURN.stopW/2, h = B.t + FURN.stopRise;
    for (const y of [B.y0 - FURN.stopGap - hw, B.y1 + FURN.stopGap + hw]){
      const sh = roundedRect(B.x0, B.x1, y-hw, y+hw, hw*0.9, hw*0.9);
      const bv = 0.05;   // the bevel adds bv at BOTH ends -> extrude bv shorter and shift by bv, so the ridge really spans zSurf .. zSurf-h
      const ex = new THREE.ExtrudeGeometry(sh, {depth: h - 2*bv, bevelEnabled: true, bevelSize: bv, bevelThickness: bv, bevelSegments: 2, curveSegments: 8});
      ex.translate(0, 0, s > 0 ? zSurf : zSurf - h + bv);   // extrude goes +z; lid grows -z
      geoms.push(ex);
    }
  }
  // clips: rooted at the OUTER (open) edge of the panel, free end pointing towards the spine -
  // exactly as in the photos (Wii / Amaray: clips sit at the far edge of the lid half)
  else for (const fy of FURN.clipY){
    const concept = part;
    const yc = Y0 + fy*Hh, xr = X1 - FURN.clipX0*W, xf = X1 - FURN.clipX1*W, hh = FURN.clipH*Hh/2;
    const B = bookletSlab(D), t = FURN.strapMM/D.mmU, bev = Math.min(0.04, t*0.25);   // bevel must stay under half the plate, or the strip degenerates
    const lift = FURN.sink + B.t + FURN.clipClear;                // the strap clears a booklet of the real thickness
    // ... and it must have FINISHED climbing where the booklet begins: the slab reaches to within
    // ~2.7 mm of the rim, so a long cosmetic ramp would cut straight through it. The riser ends at
    // the slab edge - which is what a real clip does: steep at the root, flat over the booklet.
    const L = xr-xf, rampLen = Math.max(0.35, Math.min(FURN.ramp*L, xr - B.x1 - 0.1));
    if (concept === 'A'){                        // tongue: flat strip, square root, fully rounded free end
      geoms.push(strip(roundedRect(xf, xr, yc-hh, yc+hh, hh, 0.15), t, zSurf, s, xr, rampLen, lift, bev));
    } else if (concept === 'B'){                 // flat hollow frame + three comb ribs at the root
      const cr = hh*0.8, w = FURN.frameW;
      const sh = roundedRect(xf, xr, yc-hh, yc+hh, cr, 0.2);
      sh.holes.push(roundedRect(xf+w, xr-w*1.6, yc-hh+w, yc+hh-w, Math.max(cr-w, 0.05), 0.1));
      geoms.push(strip(sh, t, zSurf, s, xr, rampLen, lift, bev));
      // the comb ribs belong on the strip of floor between the slab edge and the rim, outside the
      // booklet
      const rl = Math.max(0.4, xr - B.x1);
      for (const k of [-1, 0, 1]) geoms.push(box(xr - rl/2, yc + k*hh*0.55, zSurf + s*0.12, rl, 0.12, 0.24));
    } else if (concept === 'C'){                 // round staple: wire loop on two posts at the root
      const r = FURN.wireR, cr = Math.min(hh, L/2)*0.6, zTop = zSurf + s*(lift + r);
      const pts = roundedRect(xf, xr, yc-hh, yc+hh, cr, cr).getPoints(48).map(p => new THREE.Vector3(p.x, p.y, zTop));
      geoms.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 96, r, 10, true));
      for (const y of [yc-hh+cr, yc+hh-cr]) geoms.push(box(xr, y, zSurf + s*(lift+r)/2, 2*r, 2*r, lift+r));
    }
  }
  return threeToArrays(geoms);
}

function bookletUVs(g){                          // planar UVs on the booklet slab; -z face mirrored so it reads
  const P = g.p, N = g.n, T = g.t; let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
  for (let i=0;i<P.length;i+=3){ x0=Math.min(x0,P[i]); x1=Math.max(x1,P[i]); y0=Math.min(y0,P[i+1]); y1=Math.max(y1,P[i+1]); }
  for (let i=0, j=0; i<P.length; i+=3, j+=2){ const u=(P[i]-x0)/(x1-x0); T[j] = N[i+2] < 0 ? 1-u : u; T[j+1]=(P[i+1]-y0)/(y1-y0); }
  return g;
}

function uhdQuad(x0, x1, y0, y1, z){
  const V = [[x0,y1,0,1],[x0,y0,0,0],[x1,y0,1,0],[x1,y1,1,1]], g = {p:[],n:[],t:[]};   // TL, BL, BR, TR
  for (const k of [0,1,2, 0,2,3]){ const [x,y,u,v] = V[k]; g.p.push(x, y, z); g.n.push(0, 0, 1); g.t.push(u, v); }
  return g;
}

function spineLogoQuad(D, w, h, uv = {u0:0, u1:1, v0:0, v1:1}){   // uv = visible part of the logo PNG (alpha trim)
  const x = D.OUT.x0 - 0.03, yc = (D.OUT.y0 + D.OUT.y1)/2, zc = (D.hingeZ.a + D.hingeZ.b)/2;
  const y0 = yc - w/2, y1 = yc + w/2, z0 = zc - h/2, z1 = zc + h/2;
  const {u0,u1,v0,v1} = uv;
  const V = [[y1,z1,u0,v1],[y0,z1,u1,v1],[y0,z0,u1,v0],[y1,z0,u0,v0]];  // y, z, u, v
  const tri = [0,2,1, 0,3,2], g = {p:[],n:[],t:[]};          // winding so the FRONT face looks towards -x (outside); FrontSide culls the inside view
  for (const k of tri){ const [y,z,u,v] = V[k]; g.p.push(x, y, z); g.n.push(-1, 0, 0); g.t.push(u, v); }
  return g;
}

function badgeQuad(D, w, h, yC, uv = {u0:0, u1:1, v0:0, v1:1}){
  const x = D.OUT.x0 - 0.03, zc = (D.hingeZ.a + D.hingeZ.b)/2, zL = zc - w/2, zR = zc + w/2, y0 = yC - h/2, y1 = yC + h/2;   // screen-left = -z (verified in the side render)
  const {u0,u1,v0,v1} = uv;
  const V = [[y1,zL,u0,v1],[y0,zL,u0,v0],[y0,zR,u1,v0],[y1,zR,u1,v1]];   // TL, BL, BR, TR (screen space from -x)
  const tri = [0,1,2, 0,2,3], g = {p:[],n:[],t:[]};                    // winding gives the -x front face (FrontSide culls the inside view)
  for (const k of tri){ const [y,z,u,v] = V[k]; g.p.push(x, y, z); g.n.push(-1, 0, 0); g.t.push(u, v); }
  return g;
}

function lidBooklet(D, zSurf){
  // booklet lies under the clips against the outer rim wall, between the two stops
  const B = bookletSlab(D);
  const b = new THREE.BoxGeometry(B.x1-B.x0, B.y1-B.y0, B.t); b.translate((B.x0+B.x1)/2, (B.y0+B.y1)/2, zSurf - B.t/2 - FURN.sink);
  return bookletUVs(threeToArrays([b]));
}

function buildModel(name){
  const D = MODELS[name], src = MESH[name], M = {name, D, meshes:{}, orig:{}, fitted:{}};
  if (D.zScale && D.zScale !== 1 && !D._zScaled){
    // depth correction: the JFX DVD shell is 19 mm thick at 190 mm height, a real Amaray
    // keep case is 14 mm -> squeeze every z about the depth centre. Mesh (case + cover), depth
    // extents and hinge-wall extents are all scaled, so roundings, hinges, spine, interior quads,
    // furniture and the spine decal derive consistently from the new depth. Done once per model.
    const zc = (D.Z.min + D.Z.max)/2, k = D.zScale, sz = z => zc + (z - zc)*k;
    for (const g of [src.case, src.cover]) for (let i=2;i<g.p.length;i+=3) g.p[i] = sz(g.p[i]);
    D.Z = {min: sz(D.Z.min), max: sz(D.Z.max)}; D.hingeZ = {a: sz(D.hingeZ.a), b: sz(D.hingeZ.b)};
    if (D.logoZ !== undefined) D.logoZ = D.Z.max - 3.203;      // logo offset = new front face vs. the Blu-ray front (z 3.203)
    // (logoZ is only used by the Blu-ray logo; recomputed below from the scaled depth)
    D._zScaled = true;
  }
  M.group = new THREE.Group();
  M.matCover = new THREE.MeshStandardMaterial({map:(templateTex[name] = templateTex[name] || loadTex(TEX[name])), roughness:0.6, metalness:0.0,
    polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2});   // FrontSide; wins every coplanar fight with the shell (JFX wrap is coplanar with it)
  M.matCase  = new THREE.MeshStandardMaterial({color:srgb(D.shell), roughness:0.45, metalness:0.0, side:THREE.DoubleSide});
  // lids: procedural frame texture (white frame, open window) tinted with the shell colour
  M.matFront = new THREE.MeshStandardMaterial({map:procTex, color:srgb(D.shell), transparent:true, roughness:0.45, metalness:0.0, side:THREE.DoubleSide});
  M.matBack  = new THREE.MeshStandardMaterial({map:procTex, color:srgb(D.shell), transparent:true, roughness:0.45, metalness:0.0, side:THREE.DoubleSide});
  M.matLogo  = new THREE.MeshStandardMaterial({color:0xdfe6f2, roughness:0.4, metalness:0.2});
  M.matInner = new THREE.MeshStandardMaterial({map:setTex('R', intR), color:srgb(D.shell), roughness:0.5, metalness:0.0, side:THREE.DoubleSide});
  M.matCaseIn = M.matCase.clone(); M.matCaseIn.roughness = 0.5;      // inward-facing shell faces (follow 'Inside finish')
  M.matLidIn = new THREE.MeshStandardMaterial({map:setTex('L', intL), color:srgb(D.shell), roughness:0.5, metalness:0.0, side:THREE.DoubleSide});
  const zMid = (D.Z.min+D.Z.max)/2, half = (D.Z.max-D.Z.min)/2;
  { // The JFX spine wall carries a tiny groove along its middle (z 0.72..0.78), cut through the
    // double wall. Its floor/side faces span from the outer to the inner skin and would stand as
    // a thin fin down the spine's inside once the roundings are gone. -> drop those faces and
    // close the slit in each skin (z -> zMid, x untouched). Only within the spine wall
    // (x < x0+0.3) - the interior clips further inside are not touched.
    const P = src.case.p, N = src.case.n, U = src.case.t, o = {p:[],n:[],t:[]};
    M.grooveFaces = {p:[],n:[],t:[]};                                        // kept for the shut case only
    const inGroove = (i) => P[i] < D.OUT.x0 + 0.3 && Math.abs(P[i+2] - zMid) < 0.08;
    for (let i=0;i<P.length;i+=9){
      if (inGroove(i) && inGroove(i+3) && inGroove(i+6)){                    // groove floor / side face
        for (let k=0;k<9;k++){ M.grooveFaces.p.push(P[i+k]); M.grooveFaces.n.push(N[i+k]); } for (let k=0;k<6;k++) M.grooveFaces.t.push(U[i/9*6+k]);
        continue; }
      for (let k=0;k<9;k++){ o.p.push(P[i+k]); o.n.push(N[i+k]); } for (let k=0;k<6;k++) o.t.push(U[i/9*6+k]);
    }
    for (let i=0;i<o.p.length;i+=3) if (o.p[i] < D.OUT.x0 + 0.3 && Math.abs(o.p[i+2] - zMid) < 0.08) o.p[i+2] = zMid;
    src.case = o;
  }
  const parts = splitByZ(src.case, zMid + 0.5*half, zMid - 0.5*half);
  // interior of the back half (faces looking into the case, +z) -> Vortex interior texture
  const inner = {p:[],n:[],t:[]}; let rest = {p:[],n:[],t:[]};
  { const P=parts.rest.p, N=parts.rest.n, T=parts.rest.t;
    for (let i=0;i<P.length;i+=9){
      const cz=(P[i+2]+P[i+5]+P[i+8])/3, nz=(N[i+2]+N[i+5]+N[i+8])/3;
      const dst = (cz < zMid && nz > 0.5 && T[i/9*6] >= -0.5 && T[i/9*6+2] >= -0.5 && T[i/9*6+4] >= -0.5) ? inner : rest;   // marked triangles are not interior
      for (let k=0;k<9;k++){ dst.p.push(P[i+k]); dst.n.push(N[i+k]); }
      for (let k=0;k<6;k++) dst.t.push(T[i/9*6+k]);
    } }
  // split every corner triangle (reaching left of the flat panel start) that crosses the
  // window's top or bottom edge into pieces, so that band/lip parts and window parts are
  // separate triangles (the JFX corner triangles are as tall as the whole case)
  const splitAtY = (g, yCut, all = false) => {
    const P=g.p, N=g.n, U=g.t, o={p:[],n:[],t:[]};
    const push = (v) => { o.p.push(v[0],v[1],v[2]); o.n.push(v[3],v[4],v[5]); o.t.push(v[6],v[7]); };
    const lerp = (a,b,s) => a.map((x,k)=>x+(b[k]-x)*s);
    for (let i=0;i<P.length;i+=9){
      const V=[0,1,2].map(k=>[P[i+3*k],P[i+3*k+1],P[i+3*k+2],N[i+3*k],N[i+3*k+1],N[i+3*k+2],U[i/9*6+2*k],U[i/9*6+2*k+1]]);
      const cx=(V[0][0]+V[1][0]+V[2][0])/3, side=V.map(v=>v[1]>yCut);
      if ((!all && cx >= D.FC.x0 - 0.02) || side.every(s=>s===side[0])){ V.forEach(push); continue; }
      const one = side.filter(s=>s).length===1 ? true : false;       // one vertex above
      const a = V.findIndex(v => (v[1]>yCut)===one), b=(a+1)%3, c=(a+2)%3;   // a = lone vertex
      const ab = lerp(V[a],V[b],(yCut-V[a][1])/(V[b][1]-V[a][1])), ac = lerp(V[a],V[c],(yCut-V[a][1])/(V[c][1]-V[a][1]));
      [V[a],ab,ac].forEach(push);  [ab,V[b],V[c]].forEach(push);  [ab,V[c],ac].forEach(push);
    }
    return o;
  };
  const splitWin = g => splitAtY(splitAtY(g, D.FC.y1), D.FC.y0);
  parts.lid = splitWin(parts.lid); parts.back = splitWin(parts.back);
  { const s = splitWin(inner); inner.p=s.p; inner.n=s.n; inner.t=s.t; }
  rest = splitWin(rest);
  // interior of the lid half (faces looking into the case, -z) -> plain lid shading map
  const lidIn = {p:[],n:[],t:[]};
  { const P=rest.p, N=rest.n, T=rest.t, o={p:[],n:[],t:[]};       // they sit in `rest` (like the back interior), not in parts.lid
    for (let i=0;i<P.length;i+=9){
      const nz=(N[i+2]+N[i+5]+N[i+8])/3, cx=(P[i]+P[i+3]+P[i+6])/3, cz=(P[i+2]+P[i+5]+P[i+8])/3;
      const dst = (nz < -0.5 && cz > zMid && cx > D.OUT.x0 + 0.5 && T[i/9*6] >= -0.5 && T[i/9*6+2] >= -0.5 && T[i/9*6+4] >= -0.5) ? lidIn : o;
      for (let k=0;k<9;k++){ dst.p.push(P[i+k]); dst.n.push(N[i+k]); }
      for (let k=0;k<6;k++) dst.t.push(T[i/9*6+k]);
    }
    if (lidIn.p.length/9 > 20) rest = o; else { lidIn.p.length = 0; } }
  const add = (n, g, mat, order) => { const m = new THREE.Mesh(geo(g), mat); m.renderOrder = order; M.meshes[n] = m; M.group.add(m); };
  // Spine end caps (photo of a real open case): the flat spine wall is SHORTER than the
  // panels - it ends below the band and above the bottom lip; the panels' band/lip ends close
  // the spine as caps that meet in the middle when shut and swing apart with their panel.
  // -> drop the wall triangles in those two zones, add one cap quad per panel and zone.
  const capZones = [[D.FC.y1, Infinity], [-Infinity, D.FC.y0]];
  const spineEnds = {p:[],n:[],t:[]};   // original spine geometry above/below the window: shown only when shut
  { const P=rest.p, N=rest.n, T=rest.t, keep={p:[],n:[],t:[]}; let yMax=-Infinity, yMin=Infinity;
    for (let i=0;i<P.length;i+=9){
      const cx=(P[i]+P[i+3]+P[i+6])/3, cy=(P[i+1]+P[i+4]+P[i+7])/3;
      // band zone (top): also the triangles that tie the wall to the roundings (centroid up to
      // x0+0.15) go, so that nothing blue bridges the two panels above the spine
      const wall = !D.gen && cx < D.OUT.x0 + 0.15;   // the generated shell has no shut-only head - its plates carry their head halves (JFX heuristic only)
      // spine-top / spine-bottom caps (JFX DVD: the single skin closes the spine head with plates
      // that reach from the wall to the panel start and span the flat spine depth) - they only
      // exist while shut too, otherwise their rigid halves stick out of the open plates
      const xs3 = [P[i],P[i+3],P[i+6]], zs3 = [P[i+2],P[i+5],P[i+8]];
      const singleSkin = !D.doubleWall && inner.p.length/9 <= 100;    // DVD only - the Blu-ray band ends stay as they are
      const cap = singleSkin && Math.max(...xs3) < D.FC.x0 + 0.5 && Math.min(...zs3) > D.hingeZ.a - 0.12 && Math.max(...zs3) < D.hingeZ.b + 0.12 && Math.abs(P[i+1]-P[i+4]) < 0.3 && Math.abs(P[i+1]-P[i+7]) < 0.3;
      // ... and generally everything in the band / lip zones that the hinge model would assign to
      // the SPINE body (centre of the corner roundings): it has no plate to belong to and would
      // flap out when the case opens (DVD top corners). Same ellipse test as bodyAt().
      const cz3 = (P[i+2]+P[i+5]+P[i+8])/3;
      const spineBody = singleSkin && (() => { const x0 = D.OUT.x0, xf = D.FC.x0, rx = xf - x0, hz = D.hingeZ, Z = D.Z, rzA = hz.a - Z.min, rzB = Z.max - hz.b;
        if (cx >= xf) return false;
        if (cz3 <= hz.a){ return Math.atan2((xf - cx)/rx, (Z.min + rzA - cz3)/rzA) >= Math.PI/4; }
        if (cz3 >= hz.b){ return Math.atan2((xf - cx)/rx, (cz3 - (Z.max - rzB))/rzB) >= Math.PI/4; }
        return true; })();
      const inZone = capZones.some(([a,b]) => cy > a && cy < b);
      if ((wall || cap || spineBody) && inZone){ for (let k=1;k<9;k+=3){ yMax=Math.max(yMax,P[i+k]); yMin=Math.min(yMin,P[i+k]); }
        for (let k=0;k<9;k++){ spineEnds.p.push(P[i+k]); spineEnds.n.push(N[i+k]); } for (let k=0;k<6;k++) spineEnds.t.push(T[i/9*6+k]);
        continue; }
      for (let k=0;k<9;k++){ keep.p.push(P[i+k]); keep.n.push(N[i+k]); }
      for (let k=0;k<6;k++) keep.t.push(T[i/9*6+k]);
    }
    rest = keep; M.wallY = {min:yMin, max:yMax};
  }
  if (D.gen){ // the generated spine's inner face (uv mark -4) -> own mesh with the lid interior map
    const P=rest.p, N=rest.n, T=rest.t, o={p:[],n:[],t:[]}, sp={p:[],n:[],t:[]};
    for (let i=0;i<P.length;i+=9){ const dst = (T[i/9*6] < -3.5 && T[i/9*6] > -4.5) ? sp : o; for (let k=0;k<9;k++){ dst.p.push(P[i+k]); dst.n.push(N[i+k]); } for (let k=0;k<6;k++) dst.t.push(T[i/9*6+k]); }
    rest = o; if (sp.p.length) add('spineIn', sp, M.matLidIn, 2); }
  // inward-facing shell faces near the outline (spine inner wall + inner rounding halves, inside of
  // the rim walls) -> own mesh with the inside material, so 'Inside finish' covers them too.
  // Geometry untouched, only the material assignment. Interior features (hub, ring) stay in `case`.
  const caseIn = {p:[],n:[],t:[]};
  { const P=rest.p, N=rest.n, T=rest.t, o={p:[],n:[],t:[]}, FC=D.FC;
    const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
    for (let i=0;i<P.length;i+=9){
      const cx=(P[i]+P[i+3]+P[i+6])/3, cy=(P[i+1]+P[i+4]+P[i+7])/3, cz=(P[i+2]+P[i+5]+P[i+8])/3;
      const nx=(N[i]+N[i+3]+N[i+6])/3, ny=(N[i+1]+N[i+4]+N[i+7])/3, nz=(N[i+2]+N[i+5]+N[i+8])/3;
      const nearRim = cx < FC.x0 + 0.5 || cx > FC.x1 - 0.5 || cy < FC.y0 + 0.5 || cy > FC.y1 - 0.5;
      const px = clamp(cx, FC.x0, FC.x1) - cx, py = clamp(cy, FC.y0, FC.y1) - cy, pz = zMid - cz;
      const pl = Math.hypot(px, py, pz) || 1;
      const inward = nearRim && (nx*px + ny*py + nz*pz)/pl > 0.15;
      const dst = inward ? caseIn : o;
      for (let k=0;k<9;k++){ dst.p.push(P[i+k]); dst.n.push(N[i+k]); }
      for (let k=0;k<6;k++) dst.t.push(T[i/9*6+k]);
    }
    rest = o; }
  // band / lip zones of the shell (top and bottom walls, the rim walls' band and lip parts, their
  // inner faces) -> own meshes, so "Band + lip original" covers them too. Tall wall triangles are
  // first cut at the window edges (splitAtY with all = true) so the zone border is exact.
  const splitBL = g => { const P=g.p, N=g.n, T=g.t, a={p:[],n:[],t:[]}, b={p:[],n:[],t:[]};
    for (let i=0;i<P.length;i+=9){ const cy=(P[i+1]+P[i+4]+P[i+7])/3; const dst = (cy > D.FC.y1 || cy < D.FC.y0) ? b : a;
      for (let k=0;k<9;k++){ dst.p.push(P[i+k]); dst.n.push(N[i+k]); } for (let k=0;k<6;k++) dst.t.push(T[i/9*6+k]); }
    return [a, b]; };
  const cutBL = g => splitAtY(splitAtY(g, D.FC.y1, true), D.FC.y0, true);
  const [caseF, caseBLg] = splitBL(cutBL(rest)), [caseInF, caseInBLg] = splitBL(cutBL(caseIn));
  M.matCaseBL = M.matCase.clone(); M.matCaseInBL = M.matCaseIn.clone();
  add('case',     caseF,     M.matCase, 2);
  add('caseBL',   caseBLg,   M.matCaseBL, 2);
  add('caseIn',   caseInF,   M.matCaseIn, 2);
  add('caseInBL', caseInBLg, M.matCaseInBL, 2);
  // The spine's band/lip-zone plastic exists only in the shut case (there it closes the spine
  // top like the JFX original); as soon as the case opens it is hidden - the panels swing away
  // and nothing blue must remain between them above/below the paper spine.
  for (let k=0;k<M.grooveFaces.p.length;k++) spineEnds.p.push(M.grooveFaces.p[k]);
  for (let k=0;k<M.grooveFaces.n.length;k++) spineEnds.n.push(M.grooveFaces.n[k]);
  for (let k=0;k<M.grooveFaces.t.length;k++) spineEnds.t.push(M.grooveFaces.t[k]);
  if (!D.doubleWall && inner.p.length/9 <= 100){
    // The frames' rounding rest beyond the hinge apex in the band / lip zones is spine-half
    // geometry (dome and curl, x < apex) that would hang rigidly on the plate and stick out as a
    // dark block beside the open spine. Same rule as for the shell: shut-only.
    // Apex from the measured rounding: the flat skin (z = Z.min / Z.max) ends at xr.
    let xr = Infinity; { const P = M.meshes.case.geometry.attributes.position.array; for (let i=0;i<P.length;i+=3) if (P[i] < D.FC.x0 && P[i+1] > D.FC.y0 && P[i+1] < D.FC.y1 && (Math.abs(P[i+2]-D.Z.min) < 0.01 || Math.abs(P[i+2]-D.Z.max) < 0.01)) xr = Math.min(xr, P[i]); }   // the shell skin (the frames have no window-zone skin at the spine)
    if (isFinite(xr)){ const rxR = xr - D.OUT.x0, apexX = D.OUT.x0 + rxR*(1 - Math.SQRT1_2); M.frameApexX = apexX;
      for (const part of [parts.lid, parts.back]){ const P=part.p, N=part.n, T=part.t, keep={p:[],n:[],t:[]};
        for (let i=0;i<P.length;i+=9){ const cx=(P[i]+P[i+3]+P[i+6])/3, cy=(P[i+1]+P[i+4]+P[i+7])/3;
          const inZone = capZones.some(([a,b]) => cy > a && cy < b), dst = (inZone && cx < apexX + 0.01) ? spineEnds : keep;
          for (let k=0;k<9;k++){ dst.p.push(P[i+k]); dst.n.push(N[i+k]); } for (let k=0;k<6;k++) dst.t.push(T[i/9*6+k]); }
        part.p = keep.p; part.n = keep.n; part.t = keep.t; } } }
  add('spineEnds', spineEnds, M.matCaseBL, 2);   // lives only in the band / lip zones -> follows 'Band + lip original' (= everything that exists only while shut, 0 deg)
  M.matCase.side = THREE.DoubleSide;
  { // spine plate thickness: the flat wall is a single skin in the OBJ; a real spine is a plate
    // as thick as the panels. Inner face = the wall copied SPINE_T inwards with flipped normals,
    // closed at top/bottom by two small quads.
    // single-walled shell (DVD): the spine wall in the window zone is gone (only the paper
    // spine connects) and the paper is FrontSide -> from inside the spine would be a black hole.
    // A plate just inside the paper over the flat spine depth and the window height closes it;
    // body 1 (rigidNames), lid shading map (UVs over z, set in applyAspect).
    // The plate must sit INSIDE the paper spine: the paper's spine panel lies at x = -21.88 (the
    // JFX paper sits under a clear sleeve), and a plate outside it hides the outer spine texture.
    // Measured from the cover geometry: its smallest x is the spine panel; the plate goes 0.05
    // further in.
    const paperX = Math.min(...src.cover.p.filter((v,i)=>i%3===0));
    const {a, b} = D.hingeZ, xp = M.spinePlateX = Math.max(D.OUT.x0 + 0.06, paperX + 0.05), yq0 = D.FC.y0, yq1 = D.FC.y1;
    const sp = {p:[],n:[],t:[]};
    for (const [y,z] of [[yq0,a],[yq0,b],[yq1,b],[yq0,a],[yq1,b],[yq1,a]]){ sp.p.push(xp, y, z); sp.n.push(1,0,0); sp.t.push(0,0); }
    if (!D.doubleWall && inner.p.length/9 <= 100) add('spineIn', sp, M.matLidIn, 2);   // single-walled shells only
  }
  { const zm = (D.Z.min+D.Z.max)/2, x = D.OUT.x0, {a, b} = D.hingeZ;
    const capQuad = (z0, z1, y0, y1) => { const c=[[y0,z0],[y1,z0],[y1,z1],[y0,z0],[y1,z1],[y0,z1]];
      return {p:c.flatMap(([y,z])=>[x,y,z]), n:c.flatMap(()=>[-1,0,0]), t:c.flatMap(()=>[0,0])}; };
    const join = (q1,q2) => ({p:q1.p.concat(q2.p), n:q1.n.concat(q2.n), t:q1.t.concat(q2.t)});
    // top: no connector at all - the panels' own rounded band ends are complete, nothing joins
    // them above the spine; bottom: lip caps as before
    // no caps at all: between the two complete panels only the paper spine remains
  }

  console.log(name, 'inner-facing back tris', inner.p.length/9);
  if (D.doubleWall || inner.p.length/9 > 100){             // double-walled shell (Blu-ray, generated DVD)
    add('inner', inner, M.matInner, 2);
    if (lidIn.p.length) add('lidInner', lidIn, M.matLidIn, 2);
  } else {
    // The JFX DVD shell has NO panels at all (only rims; the paper wrap is the panel), so the
    // interior gets two procedural quads over the outline: the back one with the interior
    // texture, the lid one blank, each 0.25 inside the paper.
    for (let k=0;k<inner.p.length;k++) caseF.p.push(inner.p[k]);      // into the rim mesh (not `rest`: that would re-add the band/lip faces)
    for (let k=0;k<inner.n.length;k++) caseF.n.push(inner.n[k]);
    for (let k=0;k<inner.t.length;k++) caseF.t.push(inner.t[k]);
    M.meshes.case.geometry = geo(caseF);
    const cz = src.cover.p.filter((v,i)=>i%3===2), zBack = Math.min(...cz) + 0.25, zFront = Math.max(...cz) - 0.25;
    const quad = (z, nz) => { const {x1,y0,y1} = D.OUT, x0 = D.FC.x0 - 0.05, c=[[x0,y0],[x1,y0],[x1,y1],[x0,y0],[x1,y1],[x0,y1]];   // from the panel start: the spine zone belongs to the spine plate (starting further out would lay a rigid lid strip over the spine)
      return {p:c.flatMap(([x,y])=>[x,y,z]), n:c.flatMap(()=>[0,0,nz]), t:c.flatMap(([x,y])=>[(x-x0)/(x1-x0),(y-y0)/(y1-y0)])}; };
    add('inner',    quad(zBack,  1), M.matInner, 2);
    add('lidInner', quad(zFront, -1), M.matLidIn, 2);
    // webs: the inner skin of the spine roundings between the spine plate edge (body 1) and the
    // panel quad edge (body 2 / 0). Per-vertex bodies (special case in the body loop), so the web
    // stretches between the two edges while the case opens - closes the black gaps seen from
    // inside (the JFX DVD has no shell skin there, only the FrontSide paper)
    const xp = M.spinePlateX, xq = D.FC.x0 - 0.05, {a: za, b: zb} = D.hingeZ, {y0: wy0, y1: wy1} = D.OUT;   // same x as the spine plate (inside the paper)
    // The web follows the PAPER's own rounding (its ring of x/z stations in the corner zone),
    // 0.05 inside it, then ramps to the panel quad. A straight plate from the spine plate edge
    // to the quad edge would cut through the paper's ramp when open (web z -2.19 vs paper -1.91 at
    // x = -21, 180 deg) and show from outside as a dark stripe beside the spine. Per-vertex bodies
    // -> it bends exactly like the paper and stays just inside it at every angle.
    const paperRing = (side) => { const pts = new Map();
      for (let i=0;i<src.cover.p.length;i+=3){ const x = src.cover.p[i], z = src.cover.p[i+2]; if (x >= xq || (side < 0 ? z > 0 : z < 0)) continue; pts.set(x.toFixed(3)+'|'+z.toFixed(3), [x, z]); }
      let ring = [...pts.values()]; const zEdge = side < 0 ? Math.min(...ring.map(q=>q[1])) : Math.max(...ring.map(q=>q[1]));
      ring = ring.filter(q => Math.abs(q[1] - zEdge) < 1.0).sort((u,v) => u[0]-v[0]);            // spine side first (smallest x)
      const c = [ring[ring.length-1][0], ring[0][1]];                                             // rounding centre: panel-start x, spine-start z
      return ring.map(([x,z]) => { const dx = c[0]-x, dz = c[1]-z, l = Math.hypot(dx,dz)||1; return [x + 0.05*dx/l, z + 0.05*dz/l]; }); };
    const web = (zPlate, zQuad, nz, side) => { const ring = paperRing(side).filter(q => q[0] > xp + 0.01);
      const line = [[xp, zPlate], ...ring, [xq, zQuad]], g = {p:[], n:[], t:[]};
      for (let k=0;k<line.length-1;k++){ const [x0,z0] = line[k], [x1,z1] = line[k+1];
        const c=[[x0,wy0,z0],[x1,wy0,z1],[x1,wy1,z1],[x0,wy0,z0],[x1,wy1,z1],[x0,wy1,z0]]; if (nz < 0) c.reverse();
        const dx = x1-x0, dz = z1-z0, l = Math.hypot(dx,dz)||1, nn = nz > 0 ? [-dz/l, 0, dx/l] : [dz/l, 0, -dx/l];   // normal of the strip, facing the interior
        for (const [x,y,z] of c){ g.p.push(x,y,z); g.n.push(...nn); g.t.push((x-xp)/(xq-xp)*0.05, (y-wy0)/(wy1-wy0)); } }
      return g; };
    add('backWeb', web(za, zBack,  1, -1), M.matInner, 2);
    add('lidWeb',  web(zb, zFront, -1, 1), M.matLidIn, 2);
    M.quadInterior = true;
  }
  // band (above the window) and lip (below) of each frame go into their own meshes so the
  // "Band + lip original" switch can keep them in the model colour while the rest follows the poster
  const [lidF, lidBL] = splitBL(parts.lid), [backF, backBL] = splitBL(parts.back);
  M.matFrontBL = M.matFront.clone(); M.matBackBL = M.matBack.clone();
  console.log(name, 'drawn: lid', lidF.p.length/9, 'lidBL', lidBL.p.length/9,
              'back', backF.p.length/9, 'backBL', backBL.p.length/9, 'tris');
  add('lid',    lidF,   M.matFront, 3);
  add('lidBL',  lidBL,  M.matFrontBL, 3);
  add('back',   backF,  M.matBack, 3);
  add('backBL', backBL, M.matBackBL, 3);
  add('cover', src.cover,  M.matCover, 1);
  { // the wrap's spine panel is coplanar with the shell's spine wall in the OBJ; push it a hair
    // The JFX wrap runs from its spine strip (x0, z 0.72..0.76) straight to the first rounding
    // ring (x0+0.08, z 2.23), i.e. up to 0.06 INSIDE the flat plastic wall between z 0.76 and
    // 1.8 - the blue wall showed through as a straight band along the spine. Pull the strip and
    // that first ring a hair outside the wall plane; the polygon offset handles the rest.
    // (normals stay the smooth JFX ones - overriding them drew a shading stripe down the middle)
    const a = M.meshes.cover.geometry.attributes.position.array;
    for (let i=0;i<a.length;i+=3) if (a[i] < D.OUT.x0 + 0.1) a[i] = D.OUT.x0 - 0.015;
    // same for the shell's flat wall (incl. the collapsed groove): one normal, one flat shade
    for (const mn of ['case', 'caseBL']){ const cp = M.meshes[mn].geometry.attributes.position.array, cn = M.meshes[mn].geometry.attributes.normal.array;
      for (let i=0;i<cp.length;i+=3) if (cp[i] < D.OUT.x0 + 0.02 && cp[i+2] > D.hingeZ.a - 0.01 && cp[i+2] < D.hingeZ.b + 0.01){ cn[i] = -1; cn[i+1] = 0; cn[i+2] = 0; } }
  }
  add('logo',  MESH.bluray.logo, M.matLogo, 4);            // shared embossed logo
  M.matUhd = new THREE.MeshStandardMaterial({transparent:true, alphaTest:0.02, roughness:0.45, metalness:0.0, polygonOffset:true, polygonOffsetFactor:-4, polygonOffsetUnits:-4, side:THREE.FrontSide});   // own colours (silver / black), never tinted
  add('uhdLogo', uhdQuad(-1, 1, -1, 1, D.Z.max), M.matUhd, 5); M.meshes.uhdLogo.visible = false;
  { // lid inside furniture: clips + stops (+ booklet). Inner surface: Blu-ray lid inner wall
    // z = 2.97 (measured), DVD = its procedural lidInner quad (paper front - 0.25)
    const zSurf = D.gen ? D.Z.max - D.gen.floorIn - 0.01 : M.quadInterior ? Math.max(...src.cover.p.filter((v,i)=>i%3===2)) - 0.25 - 0.01 : D.Z.max - 0.23;   // generated shell -> its lid floor (at Z.max - 0.23 the furniture poked through the paper)
    M.zLidIn = zSurf;
    // clips + stops share the lid's shading map (same material, planar UVs like the lid inside)
    M.matFurn = M.matLidIn.clone(); M.matFurn.side = THREE.FrontSide;
    add('stops', lidFurniture(D, zSurf, 'stops'), M.matFurn, 3);
    for (const c of ['A','B','C']) add('clip'+c, lidFurniture(D, zSurf, c), M.matFurn, 3);
    // booklet = 1:1 the cover's material and template look (grey 128, same lettering), no extra switch
    templateBooklet[name] = templateBooklet[name] || loadTex(BOOKLET_TEX[name]);
    M.matBooklet = new THREE.MeshStandardMaterial({map:templateBooklet[name], roughness:0.6, metalness:0.0});
    add('booklet', lidBooklet(D, zSurf), M.matBooklet, 3);
    // clearlogo decal on the paper spine: a quad just outside the wrap, on the flat spine part
    // (hingeZ a..b), with the logo PNG as its own texture -> full resolution instead of the ~60 px
    // the 2048^2 wrap canvas could give it. Size is set per logo in setSpineLogo(); body 1 (spine).
    M.matSpineLogo = new THREE.MeshStandardMaterial({transparent:true, alphaTest:0.02, roughness:0.6, metalness:0.0, polygonOffset:true, polygonOffsetFactor:-4, polygonOffsetUnits:-4, side:THREE.FrontSide});   // FrontSide: outside only, never seen from inside the open case
    add('spineLogo', spineLogoQuad(D, 1, 1), M.matSpineLogo, 5);
    M.meshes.spineLogo.visible = false;
    // studio logo + format mark at the spine foot, same decal technique; tint = the badge colour
    for (const n of ['spineStudio', 'spineFormat', 'spineTmdb']){
      M['mat' + n] = new THREE.MeshStandardMaterial({transparent:true, alphaTest:0.02, opacity:BADGE.opacity, roughness:0.6, metalness:0.0, polygonOffset:true, polygonOffsetFactor:-4, polygonOffsetUnits:-4, side:THREE.FrontSide});
      add(n, spineLogoQuad(D, 1, 1), M['mat' + n], 5); M.meshes[n].visible = false;
    }
  }
  M.norm0 = {};
  for (const [n,m] of Object.entries(M.meshes)){
    M.orig[n] = m.geometry.attributes.position.array.slice(); M.norm0[n] = m.geometry.attributes.normal.array.slice();
  }
  M.zMid = zMid;
  // SAY WHICH 'lid' THIS IS. parts.lid is the whole front half of the shell
  // BEFORE splitBL takes the band and the lip out of it; the mesh that ends up
  // being drawn under the name 'lid' is lidF, a different, far smaller thing.
  // A line reading 'lid 246' next to a drawn lid of 8 triangles is easily
  // read as the drawn count.
  console.log(name, 'pre-split parts:', 'lid', parts.lid.p.length/9,
              'back', parts.back.p.length/9, 'rest', parts.rest.p.length/9, 'tris',
              '(drawn later as lidF/backF, see the add() lines)');
  return M;
}

function genDvdShell(D){
  const G = D.gen, {x0, x1, y0, y1} = D.OUT, FC = D.FC, zT = D.Z.min, zL = D.Z.max, zMid = (zT + zL)/2, half = zMid - zT;
  const R = G.rCorner, xCut = x0 + G.rCorner - G.rCorner*Math.SQRT1_2;          // hinge line = apex x of the spine rounding (rx = rCorner)
  const out = {case:{p:[],n:[],t:[]}, cover:{p:[],n:[],t:[]}};
  // every generated face is emitted with the winding that makes its front side face the given
  // normal (three.js flips the shading normal on back faces of DoubleSide materials: a face wound
  // the wrong way renders dark)
  const tri = (g, A, B, C, nA, nB, nC, uvs) => {
    const gx = (B[1]-A[1])*(C[2]-A[2]) - (B[2]-A[2])*(C[1]-A[1]), gy = (B[2]-A[2])*(C[0]-A[0]) - (B[0]-A[0])*(C[2]-A[2]), gz = (B[0]-A[0])*(C[1]-A[1]) - (B[1]-A[1])*(C[0]-A[0]);
    const nm = [nA[0]+nB[0]+nC[0], nA[1]+nB[1]+nC[1], nA[2]+nB[2]+nC[2]];
    const order = (gx*nm[0] + gy*nm[1] + gz*nm[2] >= 0) ? [[A,nA,0],[B,nB,1],[C,nC,2]] : [[A,nA,0],[C,nC,2],[B,nB,1]];
    const u = uvs || [[0,0],[0,0],[0,0]];
    for (const [P,N,k] of order){ g.p.push(P[0],P[1],P[2]); g.n.push(N[0],N[1],N[2]); g.t.push(u[k][0], u[k][1]); } };
  const quad = (g, A, B, C, Dd, nA, nB, nC, nD, uvs) => { const u = uvs || [[0,0],[0,0],[0,0],[0,0]];
    tri(g, A, B, C, nA, nB, nC, [u[0],u[1],u[2]]); tri(g, A, C, Dd, nA, nC, nD, [u[0],u[2],u[3]]); };
  const norm = v => { const l = Math.hypot(v[0],v[1],v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
  // ---- plates -------------------------------------------------------------------------------------
  for (const side of [-1, 1]){                                                     // -1 tray (z from zT inward), +1 lid (from zL inward)
    const zs = side < 0 ? zT : zL, dz = d => side < 0 ? zT + d : zL - d, nzS = side;   // nzS: outward depth direction sign
    // outline stations {p:[x,y], n:[nx,ny]} (outward normal), counter-clockwise, spine-side cuts at both ends
    // The plate as ONE hood along a closed path:
    // outline of the half box with all four corners R; on the spine side the outline is the spine
    // wall plane x = x0. The rim profile is swept along the whole outline EXCEPT the window height
    // of the spine side, where the same edge arc is the bending rounding skin (per-vertex bodies)
    // and the roof plane is the paper's spine. So each plate carries its half of the head (band and
    // lip zone up to the wall plane) exactly like the JFX / the Blu-ray band caps, shut = closed
    // box corner, open = the halves travel with their plate. The hood's two open ends at the window
    // edges are closed by the shelf faces (the JFX 'case' ring at y = FC.y1 / FC.y0).
    const S = [], arc = (cx, cy, a0, a1, k) => { for (let i=0;i<=k;i++){ const a = a0 + (a1-a0)*i/k; S.push({p:[cx + R*Math.cos(a), cy + R*Math.sin(a)], n:[Math.cos(a), Math.sin(a)]}); } };
    S.push({p:[x0, FC.y1], n:[-1, 0]});                                            // spine wall plane, up from the window edge
    S.push({p:[x0, y1 - R], n:[-1, 0]});
    arc(x0+R, y1-R, Math.PI, Math.PI/2, 6);                                          // top spine corner
    arc(x1-R, y1-R, Math.PI/2, 0, 6);                                                // top outer corner
    arc(x1-R, y0+R, 0, -Math.PI/2, 6);                                               // bottom outer corner
    arc(x0+R, y0+R, -Math.PI/2, -Math.PI, 6);                                        // bottom spine corner
    S.push({p:[x0, y0 + R], n:[-1, 0]});
    S.push({p:[x0, FC.y0], n:[-1, 0]});                                            // down to the window edge
    // rim profile (n = offset along the outward normal, 0 at the outline; d = depth from the skin)
    const P = [], K = 6;
    for (let i=0;i<=K;i++){ const t = Math.PI/2*i/K; P.push([-G.rEdgeN + G.rEdgeN*Math.sin(t), G.rEdgeD*(1 - Math.cos(t))]); }   // edge arc: skin end -> roof
    // hard edges (roof -> lip, lip -> underside) get duplicated points so each face keeps its own
    // flat normal; the arc points share smooth normals (a wide roof quad with interpolated
    // normals shows as a dark band from above)
    // like the JFX section (x = -18) the hood has NO underside - skin, arc, roof, lip edge; below
    // the lip it is open down to the floor (the 0.31 is the lip edge's height, not a wall thickness;
    // an underside swept round the head reads as a dark wedge from inside)
    const iRoofEnd = P.length; P.push([0, half - G.wall*0.13]);                    // roof end (roof normal)
    P.push([0, half - G.wall*0.13]);                                                 // same point, lip normal
    P.push([-G.wall, half]);                                                         // lip edge at the closing line
    const segN = k => { const a = P[k], b = P[k+1], vx = b[0]-a[0], vy = b[1]-a[1], l = Math.hypot(vx,vy)||1; return l < 1e-9 ? null : [vy/l, -vx/l]; };
    const PN = P.map((q,k) => { const a = k>0 ? segN(k-1) : null, b = k<P.length-1 ? segN(k) : null; const v = a && b ? [a[0]+b[0], a[1]+b[1]] : (a || b), l = Math.hypot(v[0],v[1])||1; return [v[0]/l, v[1]/l]; });
    PN[iRoofEnd] = [1, 0]; PN[iRoofEnd+1] = [0, 1]; PN[iRoofEnd+2] = [0, 1];   // roof | lip edge (faces the other plate)
    const V = (k, st) => [st.p[0] + st.n[0]*P[k][0], st.p[1] + st.n[1]*P[k][0], dz(P[k][1])];
    const NV = (k, st) => norm([st.n[0]*PN[k][0], st.n[1]*PN[k][0], -nzS*PN[k][1]]);
    const dup = k => Math.hypot(P[k][0]-P[k+1][0], P[k][1]-P[k+1][1]) < 1e-9;      // duplicated hard-edge points span no face
    for (let si=0; si<S.length-1; si++) for (let k=0; k<P.length-1; k++){ if (dup(k)) continue;
      const A = V(k,S[si]), B = V(k,S[si+1]), C = V(k+1,S[si+1]), Dd = V(k+1,S[si]);
      const nA = NV(k,S[si]), nB = NV(k,S[si+1]), nC = NV(k+1,S[si+1]), nD = NV(k+1,S[si]);
      if (side < 0) quad(out.case, A, B, C, Dd, nA, nB, nC, nD); else quad(out.case, A, Dd, C, B, nA, nD, nC, nB); }
    // shelf faces: the hood's cross-section at the two window edges (x = x0 - n), facing the window.
    // Like the JFX shelf ring the end face closes only the SLAB (skin to paper plane) and the
    // edge arc - the hood tube itself stays open at its end and lies in shadow. A face down to the
    // floor level would fill the whole tube end and show as a bright wedge from inside.
    // Polygon: skin end -> arc -> roof start -> down the wall to the paper plane -> back to the
    // skin end at paper depth; fan from that last point (star-shaped region).
    for (const [st, ny] of [[S[0], -1], [S[S.length-1], 1]]){
      const arcPts = P.slice(0, K+1).map(q => [st.p[0] - q[0], dz(q[1])]);
      const poly = [[st.p[0] + G.rEdgeN, dz(G.paperIn)], ...arcPts, [st.p[0], dz(G.paperIn)]];
      const N = [0, ny, 0], y = st.p[1], m5 = [[-5,-5],[-5,-5],[-5,-5]];        // exactly on the window edge; body by mark -5 (plate), no zone offset
      for (let k=1;k<poly.length-1;k++) tri(out.case, [poly[0][0], y, poly[0][1]], [poly[k][0], y, poly[k][1]], [poly[k+1][0], y, poly[k+1][1]], N, N, N, m5); }
    // window rebate: the frame's inner edge from the skin (d 0) to the paper plane (d paperIn)
    // along the top, bottom and outer window edges - the JFX 'case' ring; the spine side has no
    // frame (paper margin). Faces point into the window.
    { const dP = dz(G.paperIn), z0 = zs, xa = x0 + R;
      quad(out.case, [xa, FC.y1, z0], [FC.x1, FC.y1, z0], [FC.x1, FC.y1, dP], [xa, FC.y1, dP], [0,-1,0],[0,-1,0],[0,-1,0],[0,-1,0]);
      quad(out.case, [xa, FC.y0, z0], [FC.x1, FC.y0, z0], [FC.x1, FC.y0, dP], [xa, FC.y0, dP], [0,1,0],[0,1,0],[0,1,0],[0,1,0]);
      quad(out.case, [FC.x1, FC.y0, z0], [FC.x1, FC.y1, z0], [FC.x1, FC.y1, dP], [FC.x1, FC.y0, dP], [-1,0,0],[-1,0,0],[-1,0,0],[-1,0,0]); }
    // spine-side rounding skin (window height) = the profile's edge arc continued between the two
    // shelves: skin end (x0+R, d 0) -> wall plane (x0, d rEdgeD), apex vertex exactly at 45 deg,
    // bodies per vertex (bodyAt) -> it bends between plate and spine. Case colour like the JFX.
    // Built in three rows and CLAMPED at both ends - the vertices on the window edges carry
    // uv mark -5 = "plate body", so the skin stays with the rigid head above / lip below and twists
    // over the first 0.6 into the bending zone, like a living hinge that is fixed at its ends. No
    // tear at the head -> no fillet strips needed (JFX-path fillets are vertical strips whose ends
    // stick out of the corners as bright tabs).
    const rows = [[FC.y0, FC.y0 + G.clamp], [FC.y0 + G.clamp, FC.y1 - G.clamp], [FC.y1 - G.clamp, FC.y1]];
    const clampUV = (y, base) => (Math.abs(y - FC.y0) < 1e-6 || Math.abs(y - FC.y1) < 1e-6) ? [-5, -5] : base;
    { const cx = x0 + R, k = K; const pts = []; for (let i=0;i<=k;i++){ const a = Math.PI/2*i/k; pts.push({p:[cx - R*Math.sin(a), G.rEdgeD*(1-Math.cos(a))], n:[-Math.sin(a), -Math.cos(a)]}); }
      for (const [ya, yb] of rows) for (let i=0;i<k;i++){ const a = pts[i], b = pts[i+1];
        const A = [a.p[0], ya, dz(a.p[1])], B = [b.p[0], ya, dz(b.p[1])], C = [b.p[0], yb, dz(b.p[1])], Dd = [a.p[0], yb, dz(a.p[1])];
        const nA = norm([a.n[0], 0, -side*a.n[1]]), nB = norm([b.n[0], 0, -side*b.n[1]]);
        const uv = [clampUV(ya, [0,0]), clampUV(ya, [0,0]), clampUV(yb, [0,0]), clampUV(yb, [0,0])];
        quad(out.case, A, B, C, Dd, nA, nB, nB, nA, uv); } }
    // skin ring: the frame around the window at d = 0 - top and bottom strips from the spine-side
    // arc start to the outer arc start, the outer side strip; no strip on the spine side (the JFX
    // shows the paper there, the rounding skin above closes the slab)
    { const xa = x0 + R, xb = x1 - R, ya = y0 + R, yb = y1 - R, z = zs, N = [0, 0, side < 0 ? -1 : 1];
      // top and bottom strips end VERTICALLY at the rounding start (x0+R) - a trapezoid running
      // diagonally to the window corner would leave a triangle over the paper margin open (the floor
      // shows through from outside)
      const ring = [[[xa,ya],[xb,ya],[FC.x1,FC.y0],[xa,FC.y0]], [[xb,ya],[xb,yb],[FC.x1,FC.y1],[FC.x1,FC.y0]], [[xb,yb],[xa,yb],[xa,FC.y1],[FC.x1,FC.y1]]];
      for (const q of ring){ const Q = q.map(([x,y]) => [x,y,z]); if (side < 0) quad(out.case, Q[0], Q[3], Q[2], Q[1], N,N,N,N); else quad(out.case, Q[0], Q[1], Q[2], Q[3], N,N,N,N); } }
    // floor: [x0+R, x1-wall] x [y0+wall, y1-wall] at d = floorIn, normal into the case
    { const z = dz(G.floorIn), N = [0, 0, side < 0 ? 1 : -1], xa = x0 + R, xb = x1 - G.wall, ya = y0 + G.wall, yb = y1 - G.wall;
      const nx = 6, ny = 8;                                                         // cells: the fit stretches the window zone, the band / lip zones stay
      for (let i=0;i<nx;i++) for (let j=0;j<ny;j++){ const xA = xa + (xb-xa)*i/nx, xB = xa + (xb-xa)*(i+1)/nx, yA = ya + (yb-ya)*j/ny, yB = ya + (yb-ya)*(j+1)/ny;
        const Q = [[xA,yA,z],[xB,yA,z],[xB,yB,z],[xA,yB,z]]; if (side < 0) quad(out.case, Q[0],Q[1],Q[2],Q[3], N,N,N,N); else quad(out.case, Q[0],Q[3],Q[2],Q[1], N,N,N,N); } }
    // inner rounding (window height): floor edge (x0+R, floorIn) -> spine inner face (x0+floorIn,
    // rEdgeD), faces into the case, bends per vertex (mark -2: interior structure, not a floor)
    // k = 2: segments of 0.16 - the JFX-path 'hairline' rule (< 0.12 wide, > 2 tall) would make narrower strips rigid and tear them from their per-vertex neighbours
    { const a = [x0 + R, G.floorIn], b = [x0 + G.floorIn, G.rEdgeD], k = 2; const pts = []; for (let i=0;i<=k;i++){ const t = i/k; pts.push([a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t]); }
      for (const [ya, yb] of rows) for (let i=0;i<k;i++){ const q = pts[i], r = pts[i+1], vx = r[0]-q[0], vd = r[1]-q[1], l = Math.hypot(vx,vd)||1, N = norm([vd/l, 0, nzS*(vx/l)]);
        const A = [q[0], ya, dz(q[1])], B = [r[0], ya, dz(r[1])], C = [r[0], yb, dz(r[1])], Dd = [q[0], yb, dz(q[1])];
        const uv = [clampUV(ya, [-2,-2]), clampUV(ya, [-2,-2]), clampUV(yb, [-2,-2]), clampUV(yb, [-2,-2])];   // -2: interior structure, -5: clamped
        quad(out.case, A, B, C, Dd, N,N,N,N, uv); } }
  }
  // ---- spine (window height): the paper is its outer surface (JFX: clear sleeve), the inner face
  // is a plate at x0 + floorIn between the inner roundings (mark -4 -> mesh 'spineIn', lid map, body 1)
  { const za = zT + G.rEdgeD, zb = zL - G.rEdgeD, Ni = [1,0,0], xi = x0 + G.floorIn, m4 = [[-4,-4],[-4,-4],[-4,-4],[-4,-4]];
    quad(out.case, [xi,FC.y0,zb],[xi,FC.y0,za],[xi,FC.y1,za],[xi,FC.y1,zb], Ni,Ni,Ni,Ni, m4); }
  // ---- paper: one sheet -----------------------------------------------------------------------------
  { const uB = D.uvBack, uF = D.uvFront, k = (uB.u1 - uB.u0)/(FC.x1 - FC.x0), v = y => uB.v0 + (y - FC.y0)/(FC.y1 - FC.y0)*(uB.v1 - uB.v0);
    const xP = x0 + G.paperPanelIn, xS = x0 + G.paperSpineIn;                       // panel start / spine plane
    const stations = [];                                                            // [x, z] along the wrap, back panel -> spine -> front panel
    stations.push([FC.x1, zT + G.paperIn]); stations.push([xP, zT + G.paperIn]);
    const ring = (sideSign) => { const cz = sideSign < 0 ? zT + G.paperIn + G.paperRz : zL - G.paperIn - G.paperRz, rx = xP - xS, rz = G.paperRz, o = [];
      for (let i=1;i<=4;i++){ const a = Math.PI/2*i/4; o.push([xP - rx*Math.sin(a), cz + sideSign*rz*Math.cos(a)]); } return o; };
    for (const q of ring(-1)) stations.push(q);                                     // back rounding, ends on the spine plane
    for (const q of ring(1).reverse()) stations.push(q);                            // front rounding, starts on the spine plane
    stations.push([xP, zL - G.paperIn]); stations.push([FC.x1, zL - G.paperIn]);
    // u by arc length, pinned to the JFX layout at the panel starts
    const len = []; let acc = 0; for (let i=0;i<stations.length;i++){ if (i) acc += Math.hypot(stations[i][0]-stations[i-1][0], stations[i][1]-stations[i-1][1]); len.push(acc); }
    const uBackStart = uB.u0 + (FC.x1 - xP)*k, uFrontStart = uF.u0 + (xP - FC.x0)*k;   // JFX: 0.4707 / 0.5295 (the sign keeps the rounding off the poster)
    const u = i => i <= 1 ? uB.u0 + (FC.x1 - stations[i][0])*k : i >= stations.length-2 ? uF.u0 + (stations[i][0] - FC.x0)*k : uBackStart + (len[i]-len[1])/(len[stations.length-2]-len[1])*(uFrontStart - uBackStart);
    for (let i=0;i<stations.length-1;i++){ const a = stations[i], b = stations[i+1], vx = b[0]-a[0], vz = b[1]-a[1], l = Math.hypot(vx,vz)||1;
      let N = [-vz/l, 0, vx/l]; if (i <= 0) N = [0,0,-1]; else if (i >= stations.length-2) N = [0,0,1];   // outward (paper faces out of the case)
      if (i > 0 && i < stations.length-2){ const mx = (a[0]+b[0])/2, mz = (a[1]+b[1])/2; const outv = [mx - (xP + 0.3), mz - zMid]; if (N[0]*outv[0] + N[2]*outv[1] < 0) N = [-N[0], 0, -N[2]]; }
      // the spine is cut like the Blu-ray's - paper over the window height only,
      // nothing above or below; the plates' rim ends stand alone there.
      const A = [a[0], FC.y0, a[1]], B = [b[0], FC.y0, b[1]], C = [b[0], FC.y1, b[1]], Dd = [a[0], FC.y1, a[1]];
      const uv = [[u(i), v(FC.y0)], [u(i+1), v(FC.y0)], [u(i+1), v(FC.y1)], [u(i), v(FC.y1)]];
      // winding: FrontSide paper must face outward (N) -> choose order by the geometric normal
      const g1 = [(B[1]-A[1])*(C[2]-A[2]) - (B[2]-A[2])*(C[1]-A[1]), (B[2]-A[2])*(C[0]-A[0]) - (B[0]-A[0])*(C[2]-A[2]), (B[0]-A[0])*(C[1]-A[1]) - (B[1]-A[1])*(C[0]-A[0])];
      if (g1[0]*N[0] + g1[1]*N[1] + g1[2]*N[2] >= 0) quad(out.cover, A, B, C, Dd, N,N,N,N, uv); else quad(out.cover, A, Dd, C, B, N,N,N,N, [uv[0],uv[3],uv[2],uv[1]]); }
  }
  console.log('genDvdShell: case tris', out.case.p.length/9, 'cover tris', out.cover.p.length/9, 'xCut', xCut.toFixed(3));
  return out;
}

const INTERIOR = {aspect: 1365/2208, ringU: HUB_GEOM.px[0]/1365, ringV: 1 - HUB_GEOM.px[1]/2208, q: 1};

const DISC = {u: HUB_GEOM.px[0]/1365, v: 0.5, mm: {bluray: 171.5/62.578, dvd: 190/73.68, dvdgen: 190/73.68}, dMM: 120, holeMM: 15, tMM: 1.2, lift: 0.05};

// The disc is 1.5 mm smaller in diameter than upstream on both cases (Blu-ray 119.28 ->
// 117.78 mm, DVD 120.72 -> 119.22 mm). The factor scales the hole with it, and the hub button
// follows the hole (layoutBoss: button radius = hole radius less clearance), so it changes by
// the same factor.
const DISC_SIZE = {bluray: 117.78/120, dvd: 119.22/120, dvdgen: 119.22/120};

const DISC_OFF = {bluray:{x:0, y:0.2}, dvd:{x:0, y:0.2}, dvdgen:{x:0, y:0.2}};

function ensureDisc(){
  if (M.disc) return M.disc;
  const g = new THREE.Group(); g.name = 'disc';
  const top = new THREE.Mesh(new THREE.RingGeometry(1, 1, 96, 1), new THREE.MeshStandardMaterial({transparent:true, roughness:0.35, metalness:0.25, side:THREE.FrontSide}));
  const bot = new THREE.Mesh(new THREE.RingGeometry(1, 1, 96, 1), new THREE.MeshStandardMaterial({color:0xd8dde6, roughness:0.3, metalness:0.7, side:THREE.FrontSide}));
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 96, 1, true), new THREE.MeshStandardMaterial({color:0xd8dde6, roughness:0.3, metalness:0.7, side:THREE.DoubleSide}));
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 48, 1, true), new THREE.MeshStandardMaterial({color:0xd8dde6, roughness:0.3, metalness:0.7, side:THREE.DoubleSide}));
  top.name = 'top'; bot.name = 'bot'; rim.name = 'rim'; hole.name = 'hole';
  g.add(top, bot, rim, hole); g.renderOrder = 5; g.visible = false; M.group.add(g); M.disc = g; return g;
}

function floorExtent(a, xs){
  if (!a) return {x0: xs[0], x1: xs[3]};
  let zmin = Infinity; for (let i = 2; i < a.length; i += 3) zmin = Math.min(zmin, a[i]);
  let x0 = Infinity, x1 = -Infinity; for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i+2] - zmin) < 0.03){ x0 = Math.min(x0, a[i]); x1 = Math.max(x1, a[i]); }
  return isFinite(x0) && x1 - x0 > 10 ? {x0, x1} : {x0: xs[0], x1: xs[3]};
}

function hubCentre(xs, ys){
  const fl = M.floorX || floorExtent(M.fitted.inner, xs), Wf = fl.x1 - fl.x0, k = Wf/1365;   // same frame as the tray map
  return {x: fl.x0 + DISC.u*Wf + HUB_OFF.x*k, y: ys[0] + DISC.v*(ys[3]-ys[0]) + HUB_OFF.y*k, k};
}

function ensureHub(){
  if (M.hub) return M.hub;
  const mat = new THREE.MeshStandardMaterial({map: setTex('H', intR), transparent: true, roughness: 0.5, metalness: 0.0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat); m.name = 'hub'; m.renderOrder = 4; M.group.add(m); M.hub = m; M.matHub = mat; return m;
}

function layoutHub(xs, ys, zf){
  const m = ensureHub(), c = hubCentre(xs, ys), w = HUB_GEOM.size*c.k;
  m.scale.set(w, w, 1); m.position.set(c.x, c.y, zf + 0.01);
  if (M.matHub.map !== setTex('H', intR)){ M.matHub.map = setTex('H', intR); M.matHub.needsUpdate = true; }
  M.matHub.color.copy(M.matInner.color); M.matHub.roughness = M.matInner.roughness;
  const px = HUB_GEOM.px[0] + HUB_OFF.x, py = HUB_GEOM.px[1] - HUB_OFF.y;
  statusEl('hubref').textContent = px.toFixed(1) + '/' + py.toFixed(1);
}

const BOSS = {clearMM: 0.06, crownMM: 0.8, overMM: 0.5};

function ensureBoss(){
  if (M.boss) return M.boss;
  const mat = new THREE.MeshStandardMaterial({roughness: 0.5, metalness: 0.0, side: THREE.FrontSide});
  const m = new THREE.Mesh(new THREE.BufferGeometry(), mat); m.name = 'boss'; m.renderOrder = 4; M.group.add(m); M.boss = m; M.matBoss = mat; return m;
}

function layoutBoss(cx, cy, zf, hub, discT, holeR){
  const m = ensureBoss(), mm = M.D.mmU;
  const r = holeR - BOSS.clearMM/mm;                              // = the disc hole as it lies, less clearance
  const h = DISC.lift + discT + BOSS.overMM/mm;                   // floor -> BOSS.overMM above the seated disc
  const cr = Math.min(BOSS.crownMM/mm, r*0.35, h*0.45);           // crown radius (edge break)
  const pts = [new THREE.Vector2(r, 0), new THREE.Vector2(r, h - cr)];
  for (let i = 1; i <= 8; i++){ const a = i/8*Math.PI/2; pts.push(new THREE.Vector2(r - cr + cr*Math.cos(a), h - cr + cr*Math.sin(a))); }
  pts.push(new THREE.Vector2(0, h));
  m.geometry.dispose(); const g = new THREE.LatheGeometry(pts, 96); g.rotateX(Math.PI/2);   // lathe axis Y -> the case's +z
  { // UVs from the hub decal's plane: u,v of the point of the FLOOR that this vertex was pushed out of
    const P = g.attributes.position.array, w = HUB_GEOM.size*hub.k, uv = new Float32Array(P.length/3*2);
    for (let i = 0, j = 0; i < P.length; i += 3, j += 2){
      uv[j]   = 0.5 + (cx + P[i]   - hub.x)/w;
      uv[j+1] = 0.5 + (cy + P[i+1] - hub.y)/w;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  m.geometry = g; m.position.set(cx, cy, zf);
  if (m.material.map !== setTex('H', intR)){ m.material.map = setTex('H', intR); }
  m.material.color.copy(M.matInner.color); m.material.roughness = M.matInner.roughness; m.material.needsUpdate = true;
}

function showHubOff(){ statusEl('hubx').value = HUB_OFF.x; statusEl('huby').value = HUB_OFF.y; }

function layoutDisc(xs, ys){
  const g = ensureDisc(), mm = DISC.mm[M.name] || 2.6, r = DISC.dMM/2/mm*discSize, rh = DISC.holeMM/2/mm*discSize, t = DISC.tMM/mm*discSize;
  const inner = M.fitted.inner; let zf = null; if (inner) for (let i=2;i<inner.length;i+=3) zf = zf === null ? inner[i] : Math.min(zf, inner[i]);
  if (zf === null) zf = M.D.Z.min + 0.53;
  layoutHub(xs, ys, zf);
  const off = DISC_OFF[M.name] || {x:0, y:0}, hc = hubCentre(xs, ys);
  const cx = hc.x + off.x, cy = hc.y + off.y, z0 = zf + DISC.lift;   // the disc sits on the hub (+ its own fine offset)
  layoutBoss(cx, cy, zf, hc, t, rh);                                     // the button IS the disc hole - same centre, same diameter (part of the tray, independent of the disc switch)
  const top = g.getObjectByName('top'), bot = g.getObjectByName('bot'), rim = g.getObjectByName('rim'), hole = g.getObjectByName('hole');
  top.geometry.dispose(); top.geometry = new THREE.RingGeometry(rh, r, 96, 1); top.position.set(0, 0, t);
  bot.geometry.dispose(); bot.geometry = new THREE.RingGeometry(rh, r, 96, 1); bot.rotation.set(Math.PI, 0, 0); bot.position.set(0, 0, 0);
  rim.geometry.dispose(); rim.geometry = new THREE.CylinderGeometry(r, r, t, 96, 1, true); rim.rotation.set(Math.PI/2, 0, 0); rim.position.set(0, 0, t/2);
  hole.geometry.dispose(); hole.geometry = new THREE.CylinderGeometry(rh, rh, t, 48, 1, true); hole.rotation.set(Math.PI/2, 0, 0); hole.position.set(0, 0, t/2);
  g.position.set(cx, cy, z0);
  if (top.material.map !== discTexture()){ top.material.map = discTexture(); top.material.needsUpdate = true; }
  g.visible = discOn && !!currentDisc;
}

function discTexture(){                                   // one texture per discart image, shared by all models' discs
  if (!currentDisc) return null;
  if (!DISC.tex || DISC.tex.image !== currentDisc){ if (DISC.tex) DISC.tex.dispose(); const tx = new THREE.Texture(currentDisc); tx.encoding = THREE.sRGBEncoding; tx.anisotropy = renderer.capabilities.getMaxAnisotropy(); tx.needsUpdate = true; DISC.tex = tx; }
  return DISC.tex;
}

function setDisc(di){
  currentDisc = di; const g = ensureDisc(), top = g.getObjectByName('top');
  top.material.map = discTexture(); top.material.needsUpdate = true; g.visible = discOn && !!di;
}

function showDiscOff(){ const o = DISC_OFF[M.name] || {x:0, y:0}; statusEl('discx').value = o.x.toFixed(2); statusEl('discy').value = o.y.toFixed(2); }

function pl(v, xs, ys){                       // piecewise-linear map through (xs[i],ys[i])
  if (v<=xs[0]) return ys[0] + (v-xs[0])*(ys[1]-ys[0])/(xs[1]-xs[0]);
  for (let i=1;i<xs.length;i++) if (v<=xs[i]) return ys[i-1] + (v-xs[i-1])*(ys[i]-ys[i-1])/(xs[i]-xs[i-1]);
  const n=xs.length-1; return ys[n] + (v-xs[n])*(ys[n]-ys[n-1])/(xs[n]-xs[n-1]);
}

const lowZone  = (v,outer,inner,d) => d>=0 ? (v<(outer+inner)/2 ? v-d : v)
                                           : (v<inner ? inner + (v-inner)*((inner-outer)+d)/(inner-outer) : v);

const highZone = (v,inner,outer,d) => d>=0 ? (v>(inner+outer)/2 ? v+d : v)
                                           : (v>inner ? inner + (v-inner)*((outer-inner)+d)/(outer-inner) : v);

const UHD = {w: 0.44, body: 1935/2000, size: 1.10, dy: -0.80}, uhdImg = new Image();
// Port note: upstream's M is a model from the start (`let M = models.bluray`), here it is null until build() - the
// mark can finish loading before that, so `M &&` is added; otherwise verbatim.
uhdImg.onload = () => { if (typeof M !== 'undefined' && M && M.D) applyAspect(aspectMode); }; uhdImg.src = (SPINE_MARK.uhd);

function applyAspect(mode){
  aspectMode = mode;
  for (const n of ['endCaps','headInR','headInL']) if (M.meshes[n]){ M.group.remove(M.meshes[n]); M.meshes[n].geometry.dispose(); delete M.meshes[n]; delete M.orig[n]; delete M.fitted[n]; delete M.norm0[n]; delete M.body[n]; }   // rebuilt below from the fitted pose
  const {FC, OUT} = M.D, FW = FC.x1-FC.x0, FH = FC.y1-FC.y0, XM=(FC.x0+FC.x1)/2;
  const fit = mode==='fit' || mode==='fitb';
  const H  = fit ? FW / posterAspect : FH;                          // window height for the poster
  const dy = H - FH, dx = 0;
  // 'fit': band/rims/bottom take the texture's real-Blu-ray proportions (the DVD thereby
  // GETS a band); 'fitb' and 'orig': band, rims and bottom stay as modelled by JFX
  const sx = FW/(PNG.px[2]-PNG.px[1]), sy = H/(PNG.py[1]-PNG.py[2]);
  const follow = mode==='fit';
  const dxRim  = follow ? (PNG.px[1]-PNG.px[0])*sx - (FC.x0-OUT.x0) : 0;
  const dyBand = follow ? (PNG.py[2]-PNG.py[3])*sy - (OUT.y1-FC.y1) : 0;
  const dyBot  = follow ? (PNG.py[0]-PNG.py[1])*sy - (FC.y0-OUT.y0) : 0;
  const winY = y => y >= FC.y1-0.01 ? y+dy : (y > FC.y0 ? FC.y0 + (y-FC.y0)*H/FH : y);
  const bandH = (OUT.y1-FC.y1) + dyBand, bandBottom = FC.y1 + dy;
  const caseCx = (OUT.x0 - dxRim + OUT.x1 + dx + dxRim)/2;
  layoutBadges();                                                   // badge quads in original coordinates, fitted below
  for (const [n,m] of Object.entries(M.meshes)){
    const a = m.geometry.attributes.position.array, o = M.orig[n];
    if (n==='logo'){                                               // shared logo: centred in the band
      for (let i=0;i<a.length;i+=3){
        a[i]   = caseCx + (o[i]-LOGO_C.x)*logoScale;
        a[i+1] = bandBottom + bandH*PNG.logoFrac + (o[i+1]-LOGO_C.y)*logoScale;
        a[i+2] = o[i+2] + M.D.logoZ;
      }
    } else if (n==='uhdLogo'){                                      // 4K mark on the band: UHD.w of the front width (body, TM extra), centred on the case, band centre + dy
      const ar = uhdImg.naturalWidth ? uhdImg.naturalWidth/uhdImg.naturalHeight : 2000/232;
      const w = FW*UHD.w*UHD.size/UHD.body, h = w/ar, yc = bandBottom + bandH/2 + UHD.dy;
      a.set(uhdQuad(caseCx - w/2, caseCx + w/2, yc - h/2, yc + h/2, M.D.Z.max + 0.03).p); M.uhdH = h;
    } else if (n==='spineLogo'){                                    // spine decal: stays centred on the FITTED case height, size unchanged
      const yc0 = (OUT.y0 + OUT.y1)/2, ycF = ((OUT.y0 - dyBot) + (OUT.y1 + dy + dyBand))/2;   // = (ys[0]+ys[3])/2, ys is built after this loop
      for (let i=0;i<a.length;i+=3){ a[i] = lowZone(o[i], OUT.x0, FC.x0, dxRim); a[i+1] = ycF + (o[i+1] - yc0); a[i+2] = o[i+2]; }
    } else if (n==='spineStudio' || n==='spineFormat'){             // spine foot decals: size unchanged, centre follows the fitted paper foot
      let yc0 = 0; for (let i=1;i<o.length;i+=3) yc0 += o[i]; yc0 /= o.length/3;
      let ycF = winY(yc0); ycF = lowZone(ycF, OUT.y0, FC.y0, dyBot); ycF = highZone(ycF, FC.y1+dy, OUT.y1+dy, dyBand);
      for (let i=0;i<a.length;i+=3){ a[i] = lowZone(o[i], OUT.x0, FC.x0, dxRim); a[i+1] = ycF + (o[i+1] - yc0); a[i+2] = o[i+2]; }
    } else {
      for (let i=0;i<a.length;i+=3){
        let x=o[i], y=o[i+1];
        x = x>XM ? x+dx : x; x = lowZone(x, OUT.x0, FC.x0, dxRim); x = highZone(x, FC.x1+dx, OUT.x1+dx, dxRim);
        y = winY(y); y = lowZone(y, OUT.y0, FC.y0, dyBot); y = highZone(y, FC.y1+dy, OUT.y1+dy, dyBand);
        a[i]=x; a[i+1]=y; a[i+2]=o[i+2];        // z from the ORIGINAL too - the array still holds the last opening rotation (z would drift after repeated re-fits while open)
      }
    }
    M.fitted[n] = a.slice();                                       // pose before opening
  }
  // planar UVs for both lids: window -> cover window, outline -> texture outline
  const xs=[OUT.x0-dxRim, FC.x0, FC.x1+dx, OUT.x1+dx+dxRim], ys=[OUT.y0-dyBot, FC.y0, FC.y1+dy, OUT.y1+dy+dyBand];
  // Two living hinges on the flat spine wall (x = outline): A = back/spine edge, B = spine/lid
  // edge. Body per vertex: SPINE = the flat wall itself, LID = in front of the middle plane,
  // BACK = the rest; the rounded edges belong to the panels (as on a real case: the hinge is
  // where the flat strip ends). The embossed logo is LID.
  // ---- three rigid bodies, hinged at the apex of the shells' roundings ----------------------
  // BACK (panel + the panel-side half of rounding A) | SPINE (inner half of A + flat wall +
  // inner half of B, one rigid flat plate) | LID (inner... panel-side half of B + panel).
  // Hinge A = apex (45 deg point) of rounding A, hinge B = apex of rounding B: both on the outer
  // skin, same height, exact mirror images. The spine rotates about A, the lid about B (which
  // travels with the spine). Closed = the untouched JFX geometry.
  const Z = M.D.Z, hz = M.D.hingeZ, x0 = xs[0], xf = FC.x0;
  // The rounding's x radius. The corner-zone width (window edge - spine wall, 2.34 on the DVD)
  // is right for the Blu-ray's big rounding, but the DVD shell rounds over 0.84 only: with the
  // zone width the hinge sits 0.43 too far inside and the whole spine unit lands 0.5 below the
  // plates when open. Single-skin shells measure it: the flat outer skin (z = Z.min / Z.max)
  // ends where the rounding starts.
  let rx = M.D.rx || (xf - x0);
  if (!M.D.rx && M.quadInterior){ let xr = Infinity; for (const mn of ['case','back','lid','caseBL']){ const f = M.fitted[mn]; if (!f) continue;
      for (let i=0;i<f.length;i+=3) if (f[i] < xf && f[i+1] > FC.y0 && f[i+1] < FC.y1 && (Math.abs(f[i+2]-Z.min) < 0.01 || Math.abs(f[i+2]-Z.max) < 0.01)) xr = Math.min(xr, f[i]); }
    if (isFinite(xr) && xr - x0 > 0.2) rx = xr - x0; console.log('rounding rx', rx.toFixed(3), 'apex x', (x0 + rx - rx*Math.SQRT1_2).toFixed(3)); }
  const rzA = hz.a - Z.min, rzB = Z.max - hz.b, s45 = Math.SQRT1_2;
  const CA = {x: x0 + rx, z: Z.min + rzA}, CB = {x: x0 + rx, z: Z.max - rzB};
  M.hingeA = {x: CA.x - rx*s45, z: CA.z - rzA*s45};            // apex of rounding A (outer skin)
  M.hingeB = {x: CB.x - rx*s45, z: CB.z + rzB*s45};            // apex of rounding B
  M.win = {y0: FC.y0, y1: FC.y1 + dy};
  const rigidNames = M.quadInterior ? {logo:2, uhdLogo:2, inner:0, lidInner:2, spineEnds:1, spineIn:1, spineLogo:1, spineStudio:1, spineFormat:1, stops:2, clipA:2, clipB:2, clipC:2, booklet:2} : {logo:2, uhdLogo:2, lidInner:2, spineEnds:1, spineLogo:1, spineStudio:1, spineFormat:1, stops:2, clipA:2, clipB:2, clipC:2, booklet:2};
  M.body = {};                                                  // 0 back, 1 spine, 2 lid (per triangle)
  // The paper first - the DVD webs copy the body of their nearest paper vertex, so they bend
  // exactly like the paper they line (bodyAt alone would put the panel-start column on the spine
  // body and the web would ramp across the paper when open)
  const order = Object.entries(M.meshes).sort((u,v) => (u[0]==='cover' ? -1 : 0) - (v[0]==='cover' ? -1 : 0));
  const paperBody = (x, z) => { const c = M.fitted.cover, cb = M.body.cover; if (!c || !cb) return null; let best = null, bd = Infinity;
    for (let i=0;i<c.length;i+=3){ if ((c[i+2] < 0) !== (z < 0)) continue; const d = Math.hypot(c[i]-x, c[i+2]-z); if (d < bd){ bd = d; best = cb[i/3]; } } return best; };
  // The DVD paper's own rounding (0.42 wide) is far smaller than the shell ellipse bodyAt()
  // was built for (rx 2.34): bodyAt would put the paper's panel-start column on the spine body
  // while the panel triangles (rigid, by centroid) keep their copy on the plate -> the paper
  // would TEAR along that column when open. Measured per side: panel start = largest x of the
  // corner-zone paper vertices, spine start = the spine-most vertex's z; a vertex belongs to the
  // spine once its angle about that centre passes 45 deg.
  const paperRound = {};
  if (M.quadInterior && M.fitted.cover){ const c = M.fitted.cover;
    for (const side of [-1, 1]){ let xPanel = -Infinity, xMin = Infinity; const pts = [];
      for (let i=0;i<c.length;i+=3){ if (c[i] >= xf - 0.02 || (side < 0 ? c[i+2] >= 0 : c[i+2] <= 0)) continue; pts.push([c[i], c[i+2]]); xPanel = Math.max(xPanel, c[i]); xMin = Math.min(xMin, c[i]); }
      const spineV = pts.filter(q => Math.abs(q[0]-xMin) < 1e-3).sort((u,v) => Math.abs(v[1]) - Math.abs(u[1]))[0];
      if (pts.length && spineV) paperRound[side] = {xPanel, zSpine: spineV[1]}; } }
  const paperBodyAt = (x, z) => { const side = z < 0 ? -1 : 1, r = paperRound[side]; if (!r) return bodyAtShell(x, z);
    if (x >= r.xPanel - 1e-3) return side < 0 ? 0 : 2;
    const tt = Math.atan2(r.xPanel - x, side < 0 ? r.zSpine - z : z - r.zSpine); return tt < Math.PI/4 ? (side < 0 ? 0 : 2) : 1; };
  const bodyAtShell = (x, z) => { if (z <= hz.a){ const tt = Math.atan2((CA.x - x)/rx, (CA.z - z)/rzA); return tt < Math.PI/4 ? 0 : 1; }
    if (z >= hz.b){ const tt = Math.atan2((CB.x - x)/rx, (z - CB.z)/rzB); return tt < Math.PI/4 ? 2 : 1; } return 1; };
  for (const [n,m] of order){
    const f = M.fitted[n], body = new Uint8Array(f.length/3);
    if (n === 'cover' && M.quadInterior){ for (let i=0;i<f.length;i+=3) body[i/3] = paperBodyAt(f[i], f[i+2]); M.body[n] = body; continue; }
    const bodyAt = (x, z) => {                                  // body of a point in the corner zone
      if (z <= hz.a){ const tt = Math.atan2((CA.x - x)/rx, (CA.z - z)/rzA); return tt < Math.PI/4 ? 0 : 1; }
      if (z >= hz.b){ const tt = Math.atan2((CB.x - x)/rx, (z - CB.z)/rzB); return tt < Math.PI/4 ? 2 : 1; }
      return 1;
    };
    const uvA = m.geometry.attributes.uv ? m.geometry.attributes.uv.array : null;
    for (let i=0;i<f.length;i+=9){
      const cx=(f[i]+f[i+3]+f[i+6])/3, cy=(f[i+1]+f[i+4]+f[i+7])/3, cz=(f[i+2]+f[i+5]+f[i+8])/3;
      const mx = Math.max(f[i], f[i+3], f[i+6]);
      if (n in rigidNames){ body.fill(rigidNames[n], i/3, i/3+3); continue; }
      if (uvA && uvA[i/9*6] < -2.5 && uvA[i/9*6] > -4.5){ body.fill(1, i/3, i/3+3); continue; }   // generated spine structure (uv marks -3 / -4) = spine body by construction
      if (n==='lidWeb' || n==='backWeb'){ for (let k=0;k<3;k++){ const pb = paperBody(f[i+3*k], f[i+3*k+2]); body[i/3+k] = pb===null ? bodyAt(f[i+3*k], f[i+3*k+2]) : pb; } continue; }   // DVD interior webs: bend like the paper they line
      // horizontal end faces of the spine wall / spine plate at the window edges (all three vertices
      // on one y, spanning the flat spine depth, spine-side of the panel): they belong to the SPINE
      // body - by position they would fall to the lid/back and stick out as fins (DVD)
      { const ys3=[f[i+1],f[i+4],f[i+7]], zs3=[f[i+2],f[i+5],f[i+8]];
        if (cy >= FC.y0 - 0.05 && cy <= FC.y1 + dy + 0.05 && Math.max(...ys3)-Math.min(...ys3) < 0.3 && mx < xf - 0.05 && Math.min(...zs3) > hz.a - 0.12 && Math.max(...zs3) < hz.b + 0.12 && Math.max(...zs3)-Math.min(...zs3) > 0.5){ body.fill(1, i/3, i/3+3); continue; } }   // only AT the window edges - the Blu-ray band-top caps (y 62.3..62.5) must stay with their plate
      if (cx >= xf - 0.02 || cy > FC.y1 + dy || cy < FC.y0){ body.fill(cz > M.zMid ? 2 : 0, i/3, i/3+3); continue; }   // panels, band, lip
      const hy = Math.max(f[i+1], f[i+4], f[i+7]) - Math.min(f[i+1], f[i+4], f[i+7]);
      const wxz = Math.hypot(Math.max(f[i],f[i+3],f[i+6]) - Math.min(f[i],f[i+3],f[i+6]), Math.max(f[i+2],f[i+5],f[i+8]) - Math.min(f[i+2],f[i+5],f[i+8]));
      // reaches the panel, or is one of the JFX's full-height HAIRLINE strips (tall but only a few
      // hundredths wide): rigid as a whole - mixed vertex bodies would drag it into a needle.
      // Ordinary tall corner triangles (paper wrap, shell rings) stay per-vertex, so the skin
      // bends across the apex and stays connected.
      if (mx >= xf - 0.02 || (hy > 2 && wxz < 0.12)){ body.fill(bodyAt(cx, cz), i/3, i/3+3); continue; }
      // small triangles entirely inside the corner (shell roundings, paper): body PER VERTEX, so
      // that shared ring vertices stay together and the triangles across the apex bend like the
      // real skin - no slit opens at the hinge
      for (let k=0;k<3;k++) body[i/3+k] = bodyAt(f[i+3*k], f[i+3*k+2]);
      if (uvA) for (let k=0;k<3;k++) if (uvA[(i/3+k)*2] < -4.5) body[i/3+k] = f[i+3*k+2] > M.zMid ? 2 : 0;   // clamped vertices (uv -5) stay with their plate
    }
    M.body[n] = body;
  }
  // Hinge fillets: every shell vertex line that the body split duplicates near a hinge (the inner
  // skin of each rounding, the inner-wall junction) tears open into a slit when the bodies rotate
  // apart - the outer apex is the only point both bodies share. Bridge each such line with a
  // strip between its two rotated copies; when shut the strips are degenerate.
  M.fillets = [];
  { if (!M.quadInterior && !M.D.gen) for (const [h, lo, hi] of [[M.hingeA, 0, 1], [M.hingeB, 1, 2]]){   // the generated shell has no slits (clamped roundings) - the JFX fillet scan keys by (x,z) only and would bridge the clamp rows with vertical strips
      const seen = {};
      for (const mn of ['case', 'caseIn', 'caseBL', 'caseInBL']){                     // the inner skins live in caseIn
        const f = M.fitted[mn], b = M.body[mn]; if (!f) continue;
        for (let i=0;i<f.length;i+=3){
          // only vertices on the straight spine rounding (inside the window height): the corner tori
          // at top/bottom also have dual-body vertices near the hinge in x/z, and a full-height strip
          // for those fans out at the DVD's top corners
          if (f[i+1] < FC.y0 - 0.05 || f[i+1] > FC.y1 + dy + 0.05) continue;   // window edges INCLUDED: the Blu-ray's split vertices sit exactly on FC.y0 / FC.y1 (a 1.0 margin would drop all Blu-ray fillets)
          const dx = f[i]-h.x, dz = f[i+2]-h.z; if (Math.hypot(dx, dz) > 0.9) continue;
          const k = dx.toFixed(2)+'|'+dz.toFixed(2); (seen[k] = seen[k] || new Set()).add(b[i/3]);
        }
      }
      for (const [k, set] of Object.entries(seen)) if (set.has(lo) && set.has(hi)){
        const [dx, dz] = k.split('|').map(Number); if (Math.hypot(dx, dz) > 0.02) M.fillets.push({h, dx, dz, lo, hi});
      }
    }
    if (M.fillet && M.fillet.geometry.attributes.position.count < M.fillets.length*6){ M.group.remove(M.fillet); M.fillet.geometry.dispose(); M.fillet = null; }
    if (!M.fillet){
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(Math.max(1, M.fillets.length)*18), 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(Math.max(1, M.fillets.length)*18), 3));
      M.fillet = new THREE.Mesh(g, M.matCaseIn); M.fillet.renderOrder = 2; M.group.add(M.fillet);
    }
  }
  buildEndCaps();
  // Centre once on the closed pose, so opening does not make the case jump - and on the BODY only.
  // The embossed Blu-ray logo reaches to y 73.9 while the case ends at 72.7, so including the
  // decals would pull the centre 0.64 units (1.75 mm) up and the camera would orbit slightly
  // above the middle of the case. Shell plus paper wrap define the body; logo, spine marks,
  // clips, stops and the booklet ride on it and must not move its centre.
  { const BODY = ['case','caseBL','caseIn','caseInBL','cover','lid','lidBL','back','backBL','inner','lidInner','spineIn','spineEnds'];
    const b = new THREE.Box3();
    for (const n of BODY){ const f = M.fitted[n]; if (!f) continue; for (let i=0;i<f.length;i+=3) b.expandByPoint(new THREE.Vector3(f[i],f[i+1],f[i+2])); }
    if (b.isEmpty()) for (const f of Object.values(M.fitted)) for (let i=0;i<f.length;i+=3) b.expandByPoint(new THREE.Vector3(f[i],f[i+1],f[i+2]));
    M.centre = b.getCenter(new THREE.Vector3()); }
  { // interior of the back half: the whole outline maps onto the interior image
    // Interior maps are placed SCALE-TRUE: the disc recess must stay round while the case follows
    // the poster aspect. u still spans the full outline width (nothing is cut left / right); v
    // uses the SAME model-units-per-pixel scale as u, corrected by the map's own residual
    // ellipticity INTERIOR.q (calibrated in the render), and is anchored so the map's recess
    // centre (INTERIOR.ringV, bottom-up) sits on the tray's vertical centre. Rows beyond the map's
    // top / bottom clamp to the edge row (ClampToEdge) - the overhang is cut or extended there,
    // never at the sides. The lid map gets the same scale, anchored at its centre.
    const Wc = xs[3]-xs[0], yc = (ys[0]+ys[3])/2, Hmap = Wc/INTERIOR.aspect/INTERIOR.q;   // map height in model units at width-fit scale (lid map)
    const vMap = (y, anchor) => anchor + (y - yc)/Hmap;
    // The TRAY map spans the flat floor, not the outline, so nothing of it is lost at the sides -
    // the Blu-ray's raised rim (1.73 u per side) and the DVD's roundings would swallow the map's
    // outer 3 % on the walls, and the recess ring sits only 3 % from the map's left edge. Rim /
    // wall faces beyond the floor clamp to the edge column. Hub and disc use the same frame.
    const fl = M.floorX = floorExtent(M.fitted.inner, xs), Wf = fl.x1 - fl.x0, HmapF = Wf/INTERIOR.aspect/INTERIOR.q;
    const vMapF = (y, anchor) => anchor + (y - yc)/HmapF;
    for (const n of ['inner','headInR']){ if (!M.meshes[n]) continue;
      const a = M.meshes[n].geometry.attributes.position.array, uv = M.meshes[n].geometry.attributes.uv.array;
      for (let i=0, j=0; i<a.length; i+=3, j+=2){ uv[j]=(a[i]-fl.x0)/Wf; uv[j+1]=vMapF(a[i+1], INTERIOR.ringV); }
      M.meshes[n].geometry.attributes.uv.needsUpdate = true; }
    for (const n of ['lidInner','stops','clipA','clipB','clipC','spineIn','headInL']){   // lid inside + its furniture (+ DVD spine plate): one continuous map
      if (!M.meshes[n]) continue;
      const a = M.meshes[n].geometry.attributes.position.array, uv = M.meshes[n].geometry.attributes.uv.array;
      const Z = M.D.Z;   // spineIn is a vertical plate at constant x: sample the map across its depth instead
      for (let i=0, j=0; i<a.length; i+=3, j+=2){ uv[j] = n==='spineIn' ? (a[i+2]-Z.min)/Wc : (a[i]-xs[0])/Wc; uv[j+1] = vMap(a[i+1], 0.5); }
      M.meshes[n].geometry.attributes.uv.needsUpdate = true;
    }
  }
  const us=PNG.px.map(p=>p/PNG.w), vs=PNG.py.map(p=>1-p/PNG.h);
  for (const [n,mirror] of [['lid',false],['lidBL',false],['back',true],['backBL',true]]){
    const a = M.meshes[n].geometry.attributes.position.array, uv = M.meshes[n].geometry.attributes.uv.array;
    for (let i=0, j=0; i<a.length; i+=3, j+=2){ const u=pl(a[i],xs,us); uv[j]=mirror?1-u:u; uv[j+1]=pl(a[i+1],ys,vs); }
    M.meshes[n].geometry.attributes.uv.needsUpdate = true;
  }
  layoutDisc(xs, ys);                                              // the disc follows the fitted outline like the interior map
  // the embossed logo only when the band can hold it (DVD 'original band' has a 1.4 rim)
  // Blu-ray only: a DVD case carries no embossed logo
  M.logoFits = M.name==='bluray' && bandH >= LOGO_C.h*logoScale*1.15;
  M.uhdFits = M.name==='bluray' && bandH >= (M.uhdH || 0)*1.15;   // same rule for the 4K mark
  applyLogo();
  const w=FW+dx, h=H;
  dims.textContent = `Front cover ${w.toFixed(1)} × ${h.toFixed(1)} (aspect ${(w/h).toFixed(3)}) · case ${(xs[3]-xs[0]).toFixed(1)} × ${(ys[3]-ys[0]).toFixed(1)} · band ${bandH.toFixed(1)}`
    + (((logoMode==='3d' && !M.logoFits) || (logoMode==='uhd' && !M.uhdFits)) && M.name==='bluray' ? ' · logo hidden (band too small)' : '');
  applyOpen();
  if (typeof paintBooklet === 'function') paintBooklet();   // a refit changes the slab's aspect - the texture has to follow (cheap: BOOKLET.key stops it unless the aspect really moved)
}

function buildEndCaps(){
  if (!M.quadInterior) return;                                  // Blu-ray: JFX has its own band end caps
  const w = M.win, g = {p:[],n:[],t:[]}, bodies = [], log = [];
  const tri = (A,B,C,nrm,body) => {                           // winding follows the wanted normal
    const ux=B[0]-A[0], uy=B[1]-A[1], uz=B[2]-A[2], vx=C[0]-A[0], vy=C[1]-A[1], vz=C[2]-A[2];
    const gx=uy*vz-uz*vy, gy=uz*vx-ux*vz, gz=ux*vy-uy*vx; const P = (gx*nrm[0]+gy*nrm[1]+gz*nrm[2] >= 0) ? [A,B,C] : [A,C,B];
    for (const Q of P){ g.p.push(Q[0],Q[1],Q[2]); g.n.push(nrm[0],nrm[1],nrm[2]); g.t.push(0,0); bodies.push(body); } };
  const faceN = (f,i) => { const ax=f[i+3]-f[i], ay=f[i+4]-f[i+1], az=f[i+5]-f[i+2], bx=f[i+6]-f[i], by=f[i+7]-f[i+1], bz=f[i+8]-f[i+2];
    const n=[ay*bz-az*by, az*bx-ax*bz, ax*by-ay*bx], l=Math.hypot(...n)||1; return n.map(v=>v/l); };
  // plane x = xs through the plate's own rim -> chained (y,z) polyline of the roof + lip skins
  const sliceProfile = (body, inZone, xs) => {
    const segs = [];
    for (const n of ['caseBL','case','caseIn']){ const f = M.fitted[n], b = M.body[n]; if (!f) continue;
      for (let i=0;i<f.length;i+=9){ if (b[i/3]!==body || b[i/3+1]!==body || b[i/3+2]!==body) continue;
        const pts = []; for (let k=0;k<3;k++){ const a=i+3*k, c=i+3*((k+1)%3), sa=f[a]-xs, sc=f[c]-xs; if ((sa<0)!==(sc<0)){ const t=sa/(sa-sc); pts.push([f[a+1]+t*(f[c+1]-f[a+1]), f[a+2]+t*(f[c+2]-f[a+2])]); } }
        if (pts.length===2 && inZone(pts[0][0]) && inZone(pts[1][0]) && Math.hypot(pts[0][0]-pts[1][0], pts[0][1]-pts[1][1]) > 0.003) segs.push(pts); } }
    const key = q => q[0].toFixed(2)+'|'+q[1].toFixed(2), adj = new Map();
    for (const [a,c] of segs){ for (const [q,r] of [[a,c],[c,a]]){ const k=key(q); if (!adj.has(k)) adj.set(k,{q,nb:[]}); adj.get(k).nb.push(key(r)); } }
    const ends = [...adj.values()].filter(v=>v.nb.length===1); if (!ends.length) return null;
    let cur = ends.reduce((m,v)=> (body===0 ? v.q[1] < m.q[1] : v.q[1] > m.q[1]) ? v : m, ends[0]);   // start at the apex side (tray: smallest z, lid: largest)
    const chain = [cur.q], seen = new Set([key(cur.q)]);
    for (let guard=0; guard<200; guard++){ const nxt = cur.nb.map(k=>adj.get(k)).find(v=>v && !seen.has(key(v.q))); if (!nxt) break; chain.push(nxt.q); seen.add(key(nxt.q)); cur = nxt; }
    return chain; };
  const frames = {0:'backBL', 2:'lidBL'};
  for (const body of [0,2]) for (const zone of ['top','bottom']){
    const sgn = zone==='top' ? 1 : -1, yWin = zone==='top' ? w.y1 : w.y0;
    const inZone = y => sgn*(y - yWin) > 0.02;
    // 1. the plate's own roof (caseBL, |ny| ~ 1): height and where it ends towards the spine
    const f = M.fitted.caseBL, b = M.body.caseBL; let yT = null, xHead = Infinity;
    for (let i=0;i<f.length;i+=9){ if (b[i/3]!==body || b[i/3+1]!==body) continue; const cy=(f[i+1]+f[i+4]+f[i+7])/3; if (!inZone(cy) || Math.abs(faceN(f,i)[1]) < 0.9) continue;
      for (let k=0;k<3;k++){ const y=f[i+3*k+1]; yT = yT===null ? y : (sgn*(y-yT) > 0 ? y : yT); xHead = Math.min(xHead, f[i+3*k]); } }
    if (yT===null) continue;
    // 2. the frame's corner: plate edge x0 and the dome start xDome (frame vertices at roof height)
    const fr = M.fitted[frames[body]], fb = M.body[frames[body]]; let x0 = Infinity, xDome = Infinity;
    for (let i=0;i<fr.length;i+=3){ if (fb[i/3]!==body || !inZone(fr[i+1])) continue; x0 = Math.min(x0, fr[i]); if (Math.abs(fr[i+1]-yT) < 0.03) xDome = Math.min(xDome, fr[i]); }
    const R = xDome - x0; if (!isFinite(R) || R < 0.05 || xHead < xDome) continue;
    // The plate ends where the spine begins = the hinge line (apex of the rounding), not the
    // spine wall plane: the straight run down and the cut sit at x = hinge.x (a sweep beyond it
    // would overhang the fold as a block). The quarter circle keeps the frame radius and is
    // trimmed at that x.
    const xCut = Math.max(x0, M.hingeA.x);
    // 3. the profile: slice the intact rim 1.5 units before the roof end; keep roof + lip (the part
    //    that is NOT frame), as offsets d (along the path normal, 0 = roof) and z
    const prof = sliceProfile(body, inZone, xHead + 1.5); if (!prof || prof.length < 2) continue;
    const P = prof.map(([y,z]) => ({d: sgn*(y - yT), z}));
    // 4. the path: straight (roof end -> dome start), quarter circle (frame corner radius), straight down to the window edge
    const C = [xDome, yT - sgn*R], S = [{p:[xHead, yT], n:[0, sgn]}, {p:[xDome, yT], n:[0, sgn]}];
    const N = 12, aMax = Math.acos(Math.max(-1, (xCut - C[0])/R));          // arc angle where x reaches the cut plane
    for (let k=1;k<=N;k++){ const a = Math.PI/2 + k*(aMax - Math.PI/2)/N; S.push({p:[C[0] + R*Math.cos(a), C[1] + sgn*R*Math.sin(a)], n:[Math.cos(a), sgn*Math.sin(a)]}); }
    S.push({p:[xCut, yWin], n:[-1, 0]});
    const V = (k, s) => { const d = s === S.length-1 ? 0 : P[k].d;   // the lip edge does not run down the cut (it would make a small flange there)
      return [S[s].p[0] + S[s].n[0]*d, S[s].p[1] + S[s].n[1]*d, P[k].z]; };
    const zOut = body===0 ? 1 : -1;                                  // lip edge faces the other plate
    for (let s=0;s<S.length-1;s++) for (let k=0;k<P.length-1;k++){
      const roof = Math.abs(P[k].d) < 0.01 && Math.abs(P[k+1].d) < 0.01;
      const nrm = roof ? [(S[s].n[0]+S[s+1].n[0])/2, (S[s].n[1]+S[s+1].n[1])/2, 0] : [0, 0, zOut];
      tri(V(k,s), V(k+1,s), V(k+1,s+1), nrm, body); tri(V(k,s), V(k+1,s+1), V(k,s+1), nrm, body); }
    // 5. the cut: flat cap at the window edge over the rim's cross-section there (sector between the
    //    frame's rounding ring and its centre; the JFX shelf ring covers the skin thickness itself)
    { let ring = []; const seen = new Set();
      for (let i=0;i<fr.length;i+=3){ if (fb[i/3]!==body || fr[i] > xHead || Math.abs(fr[i+1]-yWin) > 0.05) continue; const k = fr[i].toFixed(2)+'|'+fr[i+2].toFixed(2); if (seen.has(k)) continue; seen.add(k); ring.push([fr[i], fr[i+2]]); }
      ring.sort((a,c) => c[0]-a[0]); const zC0 = ring.length ? ring[ring.length-1][1] : 0; ring = ring.filter(q => q[0] >= xCut - 1e-3);   // the cap ends at the hinge too
      if (ring.length >= 3){ const zC = zC0, yF = yWin + sgn*0.01, ctr = [xDome, zC];
        for (let k=0;k<ring.length-1;k++) tri([ctr[0],yF,ctr[1]],[ring[k][0],yF,ring[k][1]],[ring[k+1][0],yF,ring[k+1][1]],[0,-sgn,0],body); } }
    log.push(`${body===0?'tray':'lid'}/${zone}: roof y=${yT.toFixed(2)} roofEnd x=${xHead.toFixed(2)} dome x=${xDome.toFixed(2)} edge x=${x0.toFixed(2)} R=${R.toFixed(2)} profile ${P.map(q=>'('+q.d.toFixed(2)+','+q.z.toFixed(2)+')').join(' ')}`);
  }
  console.log('rim sweep:', log.join(' | '));
  if (!g.p.length) return;
  const m = new THREE.Mesh(geo(g), M.matCaseBL); m.renderOrder = 2; m.visible = openAngle >= 0.5; M.meshes.endCaps = m; M.group.add(m);
  M.orig.endCaps = Float32Array.from(g.p); M.fitted.endCaps = Float32Array.from(g.p); M.norm0.endCaps = Float32Array.from(g.n);
  M.body.endCaps = Uint8Array.from(bodies);
}

function orthoTotal(dir, opts = {}){
  const pad = opts.pad || 1.08, box = new THREE.Box3();
  for (const m of Object.values(M.meshes)) if (m.visible){ m.updateWorldMatrix(true, false); box.expandByObject(m); }
  const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
  const W = renderer.domElement.width, H = renderer.domElement.height, asp = W/H;
  let w, h, pos, up;
  if (dir === 'front'){ w = size.x; h = size.y; pos = new THREE.Vector3(ctr.x, ctr.y, ctr.z + 300); up = new THREE.Vector3(0,1,0); }
  else if (dir === 'back'){ w = size.x; h = size.y; pos = new THREE.Vector3(ctr.x, ctr.y, ctr.z - 300); up = new THREE.Vector3(0,1,0); }
  else if (dir === 'side'){ w = size.z; h = size.y; pos = new THREE.Vector3(ctr.x - 300, ctr.y, ctr.z); up = new THREE.Vector3(0,1,0); }
  else { w = size.x; h = size.z; pos = new THREE.Vector3(ctr.x, ctr.y + 300, ctr.z); up = new THREE.Vector3(0,0,-1); }
  let hw = w/2*pad, hh = h/2*pad; if (hw/hh > asp) hh = hw/asp; else hw = hh*asp;
  const cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 1, 1000); cam.position.copy(pos); cam.up.copy(up); cam.lookAt(ctr); cam.updateProjectionMatrix();
  const grey = srgb(0x8a8a8a), saved = [];
  if (opts.grey !== false) for (const mat of [M.matCase, M.matCaseIn, M.matCaseBL, M.matCaseInBL, M.matInner, M.matLidIn, M.matFurn, M.matFront, M.matBack, M.matFrontBL, M.matBackBL, M.matHub]) if (mat){ saved.push([mat, mat.color.clone()]); mat.color.copy(grey); }
  const oldBg = scene.background; scene.background = new THREE.Color(0xdcdcdc);
  renderer.render(scene, cam); const url = renderer.domElement.toDataURL('image/jpeg', 0.9);
  scene.background = oldBg; for (const [mat, c] of saved) mat.color.copy(c);
  return url;
}

const DEBUG = {bodies:false, edges:false, wire:false, lines:null, savedMats:null};

const BODY_COL = [new THREE.Color(0xff3b3b), new THREE.Color(0x3bff6a), new THREE.Color(0x3b8bff)];

function caseDiag(angle, verbose, withPositions){
  const prev = openAngle; openAngle = angle; applyOpen();
  const q = v => Math.round(v*100)/100, K = (a,b) => a<b ? a+'|'+b : b+'|'+a;
  const edges = new Map();                       // key (fitted) -> [{mesh, i(vertex a), j(vertex b)}]
  for (const n of DIAG_SHELL){ const m = M.meshes[n]; if (!m) continue; const f = M.fitted[n];
    for (let i=0;i<f.length;i+=9){ const V=[0,1,2].map(k=>q(f[i+3*k])+','+q(f[i+3*k+1])+','+q(f[i+3*k+2]));
      for (let k=0;k<3;k++){ const kk=K(V[k],V[(k+1)%3]); if (!edges.has(kk)) edges.set(kk,[]); edges.get(kk).push({mesh:n, a:i+3*k, b:i+3*((k+1)%3)}); } } }
  const A=M.hingeA, B=M.hingeB, FC=M.D.FC, w=M.win, xf=FC.x0;
  const spineEndsKeys = new Set(); for (const [k,u] of edges) if (u.some(e=>e.mesh==='spineEnds')) spineEndsKeys.add(k);
  const res = {angle, open0:0, shared:0, tears:{hinge:0, closing:0, filleted:0, shutOnly:0, bandEnd:0, defect:0}, defects:[], defectLen:0, edgeList:[]};
  const livePos = (e) => { const P=M.meshes[e.mesh].geometry.attributes.position.array; return [[P[e.a],P[e.a+1],P[e.a+2]],[P[e.b],P[e.b+1],P[e.b+2]]]; };
  const note = (cls, uses) => { if (withPositions) for (const e of uses) if (e.mesh !== 'spineEnds' || angle < 0.5) res.edgeList.push({cls, pts: livePos(e)}); };
  for (const [k,uses] of edges){
    const live = uses.filter(e => e.mesh !== 'spineEnds' || angle < 0.5);
    if (uses.length === 1){ res.open0++; note('open0', uses); continue; }
    if (live.length < 2){ res.tears.shutOnly++; note('shutOnly', live); continue; }         // partner was spineEnds (hidden now)
    res.shared++;
    // do the live copies still coincide?
    const p = live.map(e => { const P=M.meshes[e.mesh].geometry.attributes.position.array; return [P[e.a],P[e.a+1],P[e.a+2],P[e.b],P[e.b+1],P[e.b+2]]; });
    let torn = false; for (let u=1; u<p.length && !torn; u++){ const d1 = Math.hypot(p[0][0]-p[u][0], p[0][1]-p[u][1], p[0][2]-p[u][2]), d2 = Math.hypot(p[0][3]-p[u][3], p[0][4]-p[u][4], p[0][5]-p[u][5]); const d1x = Math.hypot(p[0][0]-p[u][3], p[0][1]-p[u][4], p[0][2]-p[u][5]), d2x = Math.hypot(p[0][3]-p[u][0], p[0][4]-p[u][1], p[0][5]-p[u][2]); torn = Math.min(d1+d2, d1x+d2x) > 0.02; }
    if (!torn) continue;
    const [pa, pb] = k.split('|').map(s => s.split(',').map(Number)); const mx=(pa[0]+pb[0])/2, my=(pa[1]+pb[1])/2, mz=(pa[2]+pb[2])/2;
    const dA = Math.hypot(mx-A.x, mz-A.z), dB = Math.hypot(mx-B.x, mz-B.z);
    if (Math.min(dA,dB) < 0.25){ res.tears.hinge++; note('hinge', live); }
    else if (Math.abs(mz - M.zMid) < 0.12 && mx > xf){ res.tears.closing++; note('closing', live); }     // rim meeting line: lid rim and tray rim part when the case opens (designed)
    else if (M.fillets.some(fl => Math.hypot(mx - (fl.h.x+fl.dx), mz - (fl.h.z+fl.dz)) < 0.06)){ res.tears.filleted++; note('filleted', live); }   // bridged by a fillet strip
    else if ((my > w.y1 - 0.05 || my < w.y0 + 0.05) && mx < xf + 0.5){ res.tears.bandEnd++; note('bandEnd', live); }
    else if (spineEndsKeys.has(k)){ res.tears.shutOnly++; note('shutOnly', live); }
    else { res.tears.defect++; note('defect', live); res.defectLen += Math.hypot(pa[0]-pb[0],pa[1]-pb[1],pa[2]-pb[2]); if (verbose || res.defects.length < 60) res.defects.push({mesh:uses.map(e=>e.mesh).join('+'), at:[mx,my,mz].map(v=>+v.toFixed(2)), len:+Math.hypot(pa[0]-pb[0],pa[1]-pb[1],pa[2]-pb[2]).toFixed(2)}); }
  }
  res.defectLen = +res.defectLen.toFixed(1);
  openAngle = prev; applyOpen();
  return res;
}

function applyOpen(){
  const th = openAngle*Math.PI/180;
  const share = lidFirst ? spineShare * (openAngle/180) : spineShare;
  const thA = th*share, thB = th - thA;
  const cA=Math.cos(thA), sA=Math.sin(thA), cB=Math.cos(thB), sB=Math.sin(thB);
  const A = M.hingeA, B = M.hingeB;
  const rot = (x, z, hx, hz, c, s) => [hx + (x-hx)*c - (z-hz)*s, hz + (x-hx)*s + (z-hz)*c];
  const rotN = (nx, nz, c, s) => [nx*c - nz*s, nx*s + nz*c];
  for (const [n,m] of Object.entries(M.meshes)){
    const a = m.geometry.attributes.position.array, nn = m.geometry.attributes.normal.array;
    const f = M.fitted[n], n0 = M.norm0[n], body = M.body[n];
    for (let i=0;i<a.length;i+=3){
      let x=f[i], z=f[i+2], nx=n0[i], nz=n0[i+2];
      const b = body[i/3];
      if (b===2){ [x,z] = rot(x,z,B.x,B.z,cB,sB); [nx,nz] = rotN(nx,nz,cB,sB); }   // lid about B ...
      if (b>=1){ [x,z] = rot(x,z,A.x,A.z,cA,sA); [nx,nz] = rotN(nx,nz,cA,sA); }   // ... then with the spine about A
      a[i]=x; a[i+1]=f[i+1]; a[i+2]=z; nn[i]=nx; nn[i+1]=n0[i+1]; nn[i+2]=nz;
    }
    m.geometry.attributes.position.needsUpdate = true; m.geometry.attributes.normal.needsUpdate = true; m.geometry.computeBoundingSphere();
  }
  M.meshes.spineEnds.visible = openAngle < 0.5;
  if (M.meshes.endCaps) M.meshes.endCaps.visible = openAngle >= 0.5;   // the plates' swept rim ends replace the JFX head while open
  { // hinge fillet strips (see applyAspect): body lo copy -> body hi copy, over the spine strip height
    const place = (x, z, b) => { if (b===2) [x,z] = rot(x,z,B.x,B.z,cB,sB); if (b>=1) [x,z] = rot(x,z,A.x,A.z,cA,sA); return [x,z]; };
    const P = M.fillet.geometry.attributes.position.array, N = M.fillet.geometry.attributes.normal.array;
    const y0 = M.win.y0 + 0.01, y1 = M.win.y1 - 0.01;
    P.fill(0);
    M.fillets.forEach((fl, k) => {
      const [x1,z1] = place(fl.h.x+fl.dx, fl.h.z+fl.dz, fl.lo), [x2,z2] = place(fl.h.x+fl.dx, fl.h.z+fl.dz, fl.hi);
      const q = [[x1,y0,z1],[x2,y0,z2],[x2,y1,z2],[x1,y0,z1],[x2,y1,z2],[x1,y1,z1]];
      const nx = (z2-z1), nz = -(x2-x1), nl = Math.hypot(nx, nz) || 1;
      q.forEach((v, j) => { P[k*18+j*3]=v[0]; P[k*18+j*3+1]=v[1]; P[k*18+j*3+2]=v[2]; N[k*18+j*3]=nx/nl; N[k*18+j*3+1]=0; N[k*18+j*3+2]=nz/nl; });
    });
    M.fillet.geometry.attributes.position.needsUpdate = true; M.fillet.geometry.attributes.normal.needsUpdate = true;
    M.fillet.geometry.computeBoundingSphere(); M.fillet.visible = openAngle > 0.5 && M.fillets.length > 0;
  }
  // The pivot is the centre of the BODY IN THE CLOSED POSE, in all three axes, and it never
  // moves again. Opening changes the case and nothing else - not the pivot, not the camera. A
  // pivot that rides the open case ends up in the air between the two halves, i.e. at the edge
  // of each of them.
  M.group.position.copy(M.centre).negate();
  dims2.textContent = openAngle ? `open ${openAngle.toFixed(0)}° = hinge A ${(thA*180/Math.PI).toFixed(0)}° + hinge B ${(thB*180/Math.PI).toFixed(0)}°` : '';
}

const FINISH = [0.5, 0.62, 0.74, 0.86, 1.0];

function applyInterior(){
  for (const mat of [M.matInner, M.matLidIn, M.matFurn, M.matCaseIn, M.matCaseInBL]) if (mat){ mat.roughness = FINISH[finish]; mat.needsUpdate = true; }
  M.matInner.map = setTex('R', intR); M.matInner.needsUpdate = true;
  if (M.matHub){ M.matHub.map = setTex('H', intR); M.matHub.roughness = FINISH[finish]; M.matHub.needsUpdate = true; }
  M.matLidIn.map = setTex('L', intL); M.matLidIn.needsUpdate = true;
  M.matFurn.map = M.matLidIn.map; M.matFurn.needsUpdate = true;
}

const FORMAT_ICON = {bluray: (SPINE_MARK.bluray), dvd: (SPINE_MARK.dvd), dvdgen: (SPINE_MARK.dvd)};

const CASE_BLACK = 0x1c1c1e;
const shellHex = () => (blackCase && M.name === 'bluray') ? CASE_BLACK : M.D.shell;

const SPINE_LOGO_SCALE = {bluray: 1.5, dvd: 1.0, dvdgen: 1.0};

const rgb2hsl = ([r,g,b]) => { r/=255; g/=255; b/=255; const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2; let h=0, sat=0;
  if (mx!==mn){ const d=mx-mn; sat = l>0.5 ? d/(2-mx-mn) : d/(mx+mn); h = mx===r ? (g-b)/d + (g<b?6:0) : mx===g ? (b-r)/d + 2 : (r-g)/d + 4; h/=6; } return [h, sat, l]; };

const srgb2lin = v => { v/=255; return v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };

function rgb2oklch([r,g,b]){ r=srgb2lin(r); g=srgb2lin(g); b=srgb2lin(b);
  const l=Math.cbrt(0.4122214708*r+0.5363325363*g+0.0514459929*b), m=Math.cbrt(0.2119034982*r+0.6806995451*g+0.1073969566*b), s2=Math.cbrt(0.0883024619*r+0.2817188376*g+0.6299787005*b);
  const L=0.2104542553*l+0.7936177850*m-0.0040720468*s2, A=1.9779984951*l-2.4285922050*m+0.4505937099*s2, B=0.0259040371*l+0.7827717662*m-0.8086757660*s2;
  return {L, C: Math.hypot(A,B), h: (Math.atan2(B,A)*180/Math.PI+360)%360}; }

const hsl2rgb = (h,s,l) => { const f = n => { const k=(n+h*12)%12, a=s*Math.min(l,1-l); return l - a*Math.max(-1, Math.min(k-3, 9-k, 1)); }; return [f(0),f(8),f(4)].map(v=>Math.round(v*255)); };

function analysePoster(img){
  if (typeof ColorThief === 'undefined'){ posterPalette = []; posterSample = null; return; }
  const pal = new ColorThief().getPalette(img, 8, 5) || [];
  // 48x48 sample of the poster: populations (nearest palette colour), regions, hue histogram, average
  const S = 48, cv = document.createElement('canvas'); cv.width = cv.height = S; const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, S, S);
  const px = cx.getImageData(0, 0, S, S).data, idx = new Uint8Array(S*S), cnt = new Array(pal.length).fill(0);
  for (let i=0, q=0;i<px.length;i+=4, q++){ let best=0, bd=1e9; for (let k=0;k<pal.length;k++){ const d=(px[i]-pal[k][0])**2+(px[i+1]-pal[k][1])**2+(px[i+2]-pal[k][2])**2; if (d<bd){bd=d;best=k;} } idx[q]=best; cnt[best]++; }
  posterPalette = pal.map((rgb, k) => { const [h,s,l] = rgb2hsl(rgb); return {rgb, pop: cnt[k]/(S*S), h, s, l, skin: isSkin(rgb)}; });
  posterSample = {px, w:S, h:S, idx};
  renderSwatches();
}

const isSkin = ([r,g,b]) => r > 95 && g > 40 && b > 20 && r > g && r > b && (Math.max(r,g,b) - Math.min(r,g,b)) > 15 && Math.abs(r-g) > 15 && (r-g) < 110 && b > 0.45*g;

const entry = rgb => { const [h,s,l] = rgb2hsl(rgb); return {rgb, pop: 1, h, s, l}; };

function regionDominant(inRegion){
  const {w, h, idx} = posterSample, cnt = new Array(posterPalette.length).fill(0); let n = 0;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) if (inRegion(x/w, y/h)){ cnt[idx[y*w+x]]++; n++; }
  const cand = posterPalette.map((c, k) => ({...c, pop: cnt[k]/n})).filter(c => c.s >= 0.15 || c.l < 0.10);
  return (cand.length ? cand : posterPalette).reduce((a,b) => b.pop > a.pop ? b : a);
}

function pickColour(mode){
  if (!posterPalette.length || !posterSample) return null;
  const colourfulAll = posterPalette.filter(c => c.s >= 0.15 && c.l >= 0.10 && c.l <= 0.90);
  const colourful = colourfulAll.filter(c => !c.skin);
  const pool = colourful.length ? colourful : (colourfulAll.length ? colourfulAll : posterPalette);
  const withDark = posterPalette.filter(c => c.s >= 0.15 || c.l < 0.10);
  const fit = (v, target, range) => Math.max(0, 1 - Math.abs(v - target)/range);
  const score = (c, lT, sT, sR) => 0.52*fit(c.l, lT, 0.5) + 0.24*fit(c.s, sT, sR) + 0.24*c.pop;
  const best = (arr, f) => arr.reduce((a,b) => f(b) > f(a) ? b : a);
  switch (mode){
    case 'dominant_dark': return best(withDark.length ? withDark : posterPalette, c => c.pop);
    case 'dominant':      return best(pool, c => c.pop);
    case 'vibrant':      return best(pool, c => score(c, 0.50, 1.0, 0.65));
    case 'deep':         return best(pool, c => c.pop);                   // Adobe 'Deep' mood: the dominant colourful cluster, but rendered dark (lightness cap 0.32 in applyCaseColour)
    case 'accent': {     // second-largest colourful cluster with a clearly different hue than the largest -> the poster's contrast colour
      if (pool.length < 2) return best(pool, c => c.pop);
      const main = best(pool, c => c.pop), hd = c => { const d = Math.abs(c.h - main.h); return Math.min(d, 1 - d); };
      const rest = pool.filter(c => c !== main && hd(c) > 0.08 && c.pop >= 0.02);
      return rest.length ? best(rest, c => c.pop) : main; }
    case 'material': {   // Material You 'Score' (material-color-utilities): hue-proportion 70 % + chroma 30 %, chroma >= 15 (HCT ~ OKLCH C*400)
      const {px} = posterSample, hueProp = new Float32Array(360); let tot = 0;
      for (let i=0;i<px.length;i+=4){ const o = rgb2oklch([px[i],px[i+1],px[i+2]]); if (o.C*400 < 15) continue; hueProp[Math.round(o.h)%360] += 1; tot++; }
      if (!tot) return best(posterPalette, c => c.pop);
      const cand = posterPalette.map(c => { const o = rgb2oklch(c.rgb), ch = o.C*400; let ex = 0; for (let d=-14; d<=14; d++) ex += hueProp[(Math.round(o.h)+d+360)%360]; ex /= tot;
        return {c, ch, ex, score: 70*ex + (ch - 48)*(ch < 48 ? 0.1 : 0.3)}; }).filter(x => x.ch >= 15 && x.ex >= 0.01);
      return cand.length ? cand.reduce((a,b) => b.score > a.score ? b : a).c : best(posterPalette, c => c.pop); }
    case 'top':          return regionDominant((u, v) => v < 0.30);
    case 'edge':         return regionDominant((u, v) => u < 0.12 || u > 0.88 || v < 0.12 || v > 0.88);
    case 'average': {    const {px} = posterSample; let r=0,g=0,b=0, n=px.length/4; for (let i=0;i<px.length;i+=4){ r+=px[i]; g+=px[i+1]; b+=px[i+2]; } return entry([r/n, g/n, b/n].map(Math.round)); }
  }
  if (mode.startsWith('swatch:')) return posterPalette[+mode.slice(7)] || null;
  return null;
}

const plastic = (c, lMax = 0.60) => { const l = Math.max(0.25, Math.min(lMax, c.l)); const sat = c.l < 0.25 ? Math.max(c.s, 0.25) : c.s; return hsl2rgb(c.h, sat, l); };

function applyCaseColour(){
  const c = caseColMode === 'model' ? null : pickColour(caseColMode);
  const rgb = c ? plastic(c, caseColMode === 'deep' ? 0.32 : caseColMode === 'vibrant' ? 0.45 : 0.60) : null;   // Vibrant: saturated picks are always bright -> cap lower
  const hex = rgb ? (rgb[0]<<16 | rgb[1]<<8 | rgb[2]) : shellHex();
  const col = srgb(hex); M.caseHex = hex; if (typeof tintBadges === 'function') tintBadges();
  const ob = onlyBack && M.name === 'bluray', colP = ob ? srgb(shellHex()) : col;   // 'Only back': every plastic part keeps the model colour
  for (const mat of [M.matCase, M.matCaseIn, M.matInner, M.matLidIn, M.matFurn, M.matFront, M.matBack, M.matHub]) if (mat){ mat.color.copy(colP); mat.needsUpdate = true; }
  const colBL = colP;   // head band and bottom lip: same as the rest of the plastic (the old 'Band + lip original' is now part of 'Only back')
  for (const mat of [M.matFrontBL, M.matBackBL, M.matCaseBL, M.matCaseInBL]) if (mat){ mat.color.copy(colBL); mat.needsUpdate = true; }
  if (typeof scene !== 'undefined' && typeof camera !== 'undefined') renderer.render(scene, camera);   // immediate, also while rAF is throttled
  M.caseHex = hex;
  if (currentPoster) paintCover(currentPoster, hex);          // back + spine carry the case colour
  document.querySelectorAll('#swatches i').forEach((el, i) => el.classList.toggle('sel', caseColMode === 'swatch:'+i));
  const lab = statusEl('casecolval'); if (lab){ lab.textContent = c ? '#'+hex.toString(16).padStart(6,'0') : (posterPalette.length ? 'model' : 'no poster'); lab.style.background = c ? '#'+hex.toString(16).padStart(6,'0') : 'transparent'; lab.style.padding = '1px 6px'; lab.style.borderRadius = '3px'; }
}

function applyFurniture(){
  for (const c of ['A','B','C']){ const m = M.meshes['clip'+c]; m.visible = furnOn && (furnConcept === c); m.position.y = furnY; }
  M.meshes.stops.visible = furnOn; M.meshes.stops.position.y = furnY;
  M.meshes.booklet.visible = furnOn && bookletOn; M.meshes.booklet.position.y = furnY;
  statusEl('fy').value = furnY; statusEl('fy_val').textContent = (furnY>=0?'+':'')+furnY.toFixed(1);
}

function applyLogo(){
  applyFurniture(); applyInterior();
  M.meshes.logo.visible = logoMode==='3d' && M.logoFits;
  const uhdOn = logoMode==='uhd' && M.uhdFits && uhdImg.naturalWidth > 0;   // 4K mark
  if (uhdOn && (!M.matUhd.map || M.matUhd.map.image !== uhdImg)){ const t = new THREE.Texture(uhdImg); t.encoding = THREE.sRGBEncoding; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.needsUpdate = true; M.matUhd.map = t; M.matUhd.needsUpdate = true; }
  M.meshes.uhdLogo.visible = uhdOn;
  M.matFront.map = M.matFrontBL.map = procTex;                     // procedural frame only
  M.matBack.map  = M.matBackBL.map  = procTex;
  applyCaseColour();          // LAST: sets the case colour on lid/back frames too (the shell reset above would overwrite it)
}

function updateCamera(){
  const s = Math.sin(orbit.phi);
  camera.position.set(orbit.dist*s*Math.sin(orbit.theta), orbit.dist*Math.cos(orbit.phi), orbit.dist*s*Math.cos(orbit.theta)).add(orbit.target);
  // looking straight down / up the y axis: the world up vector is degenerate, use -z / +z (screen up = away from the viewer's front)
  camera.up.set(0, 1, 0); if (s < 1e-6) camera.up.set(0, 0, -Math.sign(Math.cos(orbit.phi)));
  camera.lookAt(orbit.target);
  if (camera === orthoCam){                                      // frame like the perspective camera would at this distance
    const hh = orbit.dist*Math.tan(perspCam.fov/2*Math.PI/180), hw = hh*innerWidth/innerHeight;
    if (orthoCam.top !== hh || orthoCam.right !== hw){ orthoCam.left=-hw; orthoCam.right=hw; orthoCam.top=hh; orthoCam.bottom=-hh; orthoCam.updateProjectionMatrix(); }
  }
}

function setOrtho(on){ camera = on ? orthoCam : perspCam; statusEl('ortho').checked = on; updateCamera(); }

function bookletAccent(){                                   // [h, s] from posterPalette (Color Thief), non-dominant, most saturated
  const cands = posterPalette.slice(1).filter(p => !p.skin); const pool = cands.length ? cands : posterPalette;
  if (!pool.length) return [0, 0];
  const best = pool.reduce((a, p) => (p.s * (0.3 + Math.sqrt(p.pop)) > a.s * (0.3 + Math.sqrt(a.pop)) ? p : a), pool[0]); return [best.h, best.s];
}

function bookletGround(ctx, W, H, kind){
  const fan = currentBack && currentBack.img && (currentBack.img.fanart || currentBack.img.fanart1);
  const coverDraw = (img) => { const sc = Math.max(W / img.width, H / img.height), dw = img.width * sc, dh = img.height * sc; ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh); };
  ctx.fillStyle = '#0c0c0e'; ctx.fillRect(0, 0, W, H);
  if ((kind === 'blur' || kind === 'bw') && fan){
    ctx.save(); ctx.filter = kind === 'blur' ? 'blur(' + (W / 28) + 'px) saturate(1.1)' : 'grayscale(1) contrast(1.15) brightness(0.42)'; coverDraw(fan); ctx.restore();
    if (kind === 'blur'){ ctx.fillStyle = 'rgba(0,0,0,0.69)'; ctx.fillRect(0, 0, W, H); }
    else { const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.85); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.7)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
    return;
  }
  if (kind === 'accent' || kind === 'gradient' || kind === 'grain'){
    const [h, s] = bookletAccent(); const sat = Math.min(kind === 'gradient' ? 0.5 : 0.45, Math.max(kind === 'grain' ? 0.2 : 0.25, s));
    if (kind === 'gradient'){ const g = ctx.createLinearGradient(0, 0, 0, H); const top = hsl2rgb(h, sat, 0.16); g.addColorStop(0, 'rgb(' + top.join(',') + ')'); g.addColorStop(1, 'rgb(10,10,10)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); return; }
    const base = hsl2rgb(h, sat, kind === 'grain' ? 0.13 : 0.11); ctx.fillStyle = 'rgb(' + base.join(',') + ')'; ctx.fillRect(0, 0, W, H);
    if (kind === 'grain'){ const id = ctx.getImageData(0, 0, W, H), d = id.data; let seed = 7; for (let i = 0; i < d.length; i += 4){ seed = (seed * 1103515245 + 12345) & 0x7fffffff; const n = ((seed >> 8) % 29) - 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; } ctx.putImageData(id, 0, 0); }
  }
}

function bookletCredits(side){
  const parts = [];
  if (side.director && side.director.length) parts.push('Director: ' + side.director.slice(0, 2).join(', '));   // English label
  if (side.year) parts.push(String(side.year));
  if (side.runtime) parts.push(String(side.runtime));
  if (side.genre && side.genre.length) parts.push(side.genre.slice(0, 3).join(' / '));
  return parts.join('   \u00b7   ');
}

function paintBooklet(){
  if (!M.matBooklet || !M.meshes.booklet) return;
  if (!currentPoster){ if (M.matBooklet.map !== templateBooklet[M.name]){ const old = M.matBooklet.map; M.matBooklet.map = templateBooklet[M.name]; M.matBooklet.needsUpdate = true; if (old) old.dispose(); } BOOKLET.key = null; return; }
  const side = currentBack ? currentBack.side : {}, stem = statusEl('postersel').value;
  // The slab's proportions come from `M.fitted.booklet` - the fitted but UNFOLDED geometry. The
  // live geometry has been through applyOpen(), where the lid is rotated: its x extent then
  // measures 0.381 instead of 0.752 at 60-120 deg open, and the cover would be painted onto a
  // canvas half as wide. The case can sit open when this runs (a double-click leaves it open).
  const aspect = (() => {
    const f = M.fitted.booklet;
    if (f){ let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < f.length; i += 3){ x0 = Math.min(x0, f[i]); x1 = Math.max(x1, f[i]); y0 = Math.min(y0, f[i+1]); y1 = Math.max(y1, f[i+1]); }
      if (x1 > x0 && y1 > y0) return (x1 - x0)/(y1 - y0); }
    M.meshes.booklet.geometry.computeBoundingBox(); const bb = M.meshes.booklet.geometry.boundingBox;
    return (bb.max.x - bb.min.x)/(bb.max.y - bb.min.y);
  })();
  const key = [stem, BOOKLET.ground, M.name, aspect.toFixed(3), !!currentLogo, !!currentStudio].join('|'); if (key === BOOKLET.key) return; BOOKLET.key = key;
  const W = BOOKLET.W, H = Math.round(W / aspect), cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  bookletGround(ctx, W, H, BOOKLET.ground);
  const fam = '"Arial Narrow", Arial, sans-serif', lines = [];              // {kind, h, draw}
  const fitBox = (img, bw, bh) => { const sc = Math.min(bw / img.width, bh / img.height); return [img.width * sc, img.height * sc]; };
  // Every text line is wrapped to at most `maxLines`, then shrunk in 6 % steps until it fits,
  // and as a last resort squeezed horizontally on the way out - so nothing can leave the page,
  // whatever the .nfo contains (e.g. a long tagline).
  const textLine = (text, fs0, maxLines, colour, weight) => {
    const words = String(text).split(/\s+/).filter(Boolean), maxW = W*0.86, font = f => (weight ? weight + ' ' : '') + f + 'px ' + fam;
    const wrap = () => { const out = []; let cur = '';
      for (const w of words){ const t = cur ? cur + ' ' + w : w; if (cur && ctx.measureText(t).width > maxW){ out.push(cur); cur = w; } else cur = t; }
      if (cur) out.push(cur); return out; };
    let fs = fs0, ls = [];
    for (let k = 0; k < 24; k++){ ctx.font = font(fs); ls = wrap();
      if (ls.length <= maxLines && ls.every(l => ctx.measureText(l).width <= maxW)) break;
      fs *= 0.94; }
    const lead = fs*1.22, h = ls.length ? (ls.length-1)*lead + fs : 0;
    return {kind: 'text', h, draw: y => { ctx.font = font(fs); ctx.fillStyle = colour; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ls.forEach((l, i) => { const w = ctx.measureText(l).width;
        if (w > maxW){ ctx.save(); ctx.translate(W/2, y + i*lead); ctx.scale(maxW/w, 1); ctx.fillText(l, 0, 0); ctx.restore(); }   // hard clamp
        else ctx.fillText(l, W/2, y + i*lead); }); }};
  };
  if (currentLogo){ const [lw, lh] = fitBox(currentLogo, W * 0.78, H * 0.26); lines.push({kind: 'logo', h: lh, draw: y => ctx.drawImage(currentLogo, (W - lw) / 2, y, lw, lh)}); }
  else lines.push(textLine((side.title || stem.replace(/-postercase\.[^.]+$/i, '')).toUpperCase(), H*0.05, 2, '#f0f0f0', 'bold'));
  if (side.tagline) lines.push(textLine(side.tagline.toUpperCase(), H*0.022, 2, '#cdcdcd'));
  if (currentStudio){ const [sw, sh] = fitBox(currentStudio, W * 0.16, H * 0.06); lines.push({kind: 'img', h: sh, draw: y => { ctx.save(); ctx.globalAlpha = 0.9; ctx.drawImage(currentStudio, (W - sw) / 2, y, sw, sh); ctx.restore(); }}); }
  const cl = bookletCredits(side); if (cl) lines.push(textLine(cl, H*0.019, 2, '#a0a0a6'));
  const gap = {logo: H * 0.06, text: H * 0.025, img: H * 0.035};
  const total = lines.reduce((a, l, i) => a + l.h + (i < lines.length - 1 ? gap[l.kind] : 0), 0); let y = (H - total) / 2;
  lines.forEach((l, i) => { l.draw(y); if (l.kind === 'logo' && lines.length > 1){ ctx.strokeStyle = 'rgba(120,120,126,0.55)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(W * 0.2, y + l.h + gap.logo / 2); ctx.lineTo(W * 0.8, y + l.h + gap.logo / 2); ctx.stroke(); } y += l.h + (i < lines.length - 1 ? gap[l.kind] : 0); });
  const t = new THREE.CanvasTexture(cv); t.encoding = THREE.sRGBEncoding; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const old = M.matBooklet.map; M.matBooklet.map = t; M.matBooklet.needsUpdate = true; if (old && old !== templateBooklet[M.name]) old.dispose();
}

function logoBounds(li){
  if (li._bounds) return li._bounds;
  const S = 160, sc = Math.min(1, S/Math.max(li.naturalWidth, li.naturalHeight)), w = Math.max(1, Math.round(li.naturalWidth*sc)), h = Math.max(1, Math.round(li.naturalHeight*sc));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const cx = cv.getContext('2d'); cx.drawImage(li, 0, 0, w, h);
  const a = cx.getImageData(0, 0, w, h).data; let x0=w, x1=-1, y0=h, y1=-1;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) if (a[(y*w+x)*4+3] > 20){ if (x<x0) x0=x; if (x>x1) x1=x; if (y<y0) y0=y; if (y>y1) y1=y; }
  const b = x1 < 0 ? {u0:0,u1:1,v0:0,v1:1,w:li.naturalWidth,h:li.naturalHeight}
                   : {u0:x0/w, u1:(x1+1)/w, v0:1-(y1+1)/h, v1:1-y0/h, w:(x1+1-x0)/sc, h:(y1+1-y0)/sc};   // v is bottom-up (flipY)
  return (li._bounds = b);
}

function tmdbImage(id){
  if (tmdbImg[id]) return tmdbImg[id];
  const fs = 64, fam = '"Arial Narrow", Arial Narrow, Arial, sans-serif';
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = fs + 'px ' + fam;
  // The canvas IS the ink box, and its height comes from the digit metrics, not from the string:
  // every id is then exactly as tall as every other. `_bounds` is set by hand so logoBounds() does
  // not re-trim on a 160 px thumbnail - that quantisation alone moves the cap height by 3 %.
  const d = probe.measureText('0'), asc = Math.ceil(d.actualBoundingBoxAscent), desc = Math.ceil(d.actualBoundingBoxDescent);
  const w = Math.max(1, Math.ceil(probe.measureText(id).width)), h = Math.max(1, asc + desc);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.font = fs + 'px ' + fam; c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.fillText(id, w/2, asc);
  cv.naturalWidth = w; cv.naturalHeight = h;     // placeBadge() reads these
  cv._bounds = {u0: 0, u1: 1, v0: 0, v1: 1, w: w, h: h};
  return (tmdbImg[id] = cv);
}

function currentTmdbImage(){
  let id = null;
  try { id = currentBack && currentBack.side && currentBack.side.tmdb; }   // layoutBadges runs inside buildModel, before `let currentBack` - temporal dead zone
  catch (e) { return null; }
  return id ? tmdbImage(String(id)) : null;
}

function formatImage(name){
  if (!formatImg[name]){ const im = new Image(); im.src = FORMAT_ICON[name]; formatImg[name] = im; im.onload = () => applyAspect(aspectMode); }
  return formatImg[name].complete && formatImg[name].naturalWidth ? formatImg[name] : null;
}

function badgeTint(surfaceHex){
  if (badgeColMode === 'white') return 0xffffff;
  if (badgeColMode === 'black') return 0x000000;
  const c = new THREE.Color().setHex(surfaceHex).convertSRGBToLinear();
  const L = 0.2126*c.r + 0.7152*c.g + 0.0722*c.b;
  return (1.05/(L + 0.05) >= (L + 0.05)/0.05) ? 0xffffff : 0x000000;
}

function placeBadge(n, img, spec, yCentre, hMax, wMax, ref){
  const m = M.meshes[n], D = M.D, mat = M['mat' + n];
  if (!img || !spec){ if (m) m.visible = false; return; }
  const b = logoBounds(img), r = ref ? logoBounds(ref) : b;
  const sc = Math.min(hMax*spec.size/r.h, wMax*spec.size/r.w);   // size factor scales both limits
  const q = badgeQuad(D, b.w*sc, b.h*sc, yCentre + spec.dy, b);
  M.orig[n] = Float32Array.from(q.p); M.norm0[n] = Float32Array.from(q.n);
  m.geometry.attributes.position.array.set(q.p); m.geometry.attributes.uv.array.set(q.t); m.geometry.attributes.uv.needsUpdate = true;
  if (mat.map && mat.map.image !== img) mat.map.dispose();
  if (!mat.map || mat.map.image !== img){ const t = new THREE.Texture(img); t.encoding = THREE.sRGBEncoding; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.needsUpdate = true; mat.map = t; mat.needsUpdate = true; }
  m.visible = true;
}

function layoutBadges(){
  const D = M.D, B = BADGE[M.name]; if (!B || !M.meshes.spineStudio) return;
  const H = D.FC.y1 - D.FC.y0, depth = D.Z.max - D.Z.min;   // width limits as a fraction of the case depth (the flat spine part is only 5.7 mm on the Blu-ray)
  placeBadge('spineStudio', studioOn ? currentStudio : null, B.studio, D.FC.y0 + B.studio.yFrac*H, B.studio.hFrac*H, depth*B.studio.wFrac);
  const lipH = D.FC.y0 - D.OUT.y0, F = B.format;
  const yF = F.onLip ? (D.OUT.y0 + D.FC.y0)/2 : D.FC.y0 + F.yFrac*H, hF = F.onLip ? F.hFrac*lipH : F.hFrac*H;
  placeBadge('spineFormat', formatOn ? formatImage(M.name) : null, F, yF, hF, depth*F.wFrac);
  // The TMDB number sits ABOVE the studio logo, mirroring the gap the format mark keeps below
  // it - measured per model, so it follows every fit and every Y set for the other two.
  const yS = D.FC.y0 + B.studio.yFrac*H + B.studio.dy, T = B.tmdb;
  const tImg = tmdbOn ? currentTmdbImage() : null;                 // null while the sidecar is not loaded yet - the reference is only built once there is something to draw
  placeBadge('spineTmdb', tImg, T, yS + (yS - (yF + F.dy)) - T.dy, T.hFrac*H, depth*T.wFrac, tImg && tmdbImage('000000'));   // six digits = the fixed glyph size for every film
  tintBadges();
}

function tintBadges(){
  if (!M.matspineStudio) return;
  const paper = M.caseHex !== undefined ? M.caseHex : shellHex();      // the spine paper is painted in the case colour
  const tint = badgeTint(paper);                                      // both marks follow the paper, also the Blu-ray mark on an original-colour lip
  M.matspineStudio.color.setHex(tint); M.matspineStudio.needsUpdate = true;
  M.matspineFormat.color.setHex(tint); M.matspineFormat.needsUpdate = true;
  if (M.matspineTmdb){ M.matspineTmdb.color.setHex(tint); M.matspineTmdb.needsUpdate = true; }
}

function setStudio(img){ currentStudio = img; }

function setSpineLogo(li){
  const m = M.meshes.spineLogo, D = M.D;
  if (!li){ m.visible = false; return; }
  const b = logoBounds(li);
  const flat = D.hingeZ.b - D.hingeZ.a, hMax = flat*0.85*spineLogoScale, wMax = (D.FC.y1 - D.FC.y0)*0.95;   // slider 'Spine logo' scales the flat-width limit (1.0 = 85 % of the flat spine)
  const sc = Math.min(hMax/b.h, wMax/b.w);                          // by the VISIBLE size
  const q = spineLogoQuad(D, b.w*sc, b.h*sc, b);
  M.orig.spineLogo = Float32Array.from(q.p); M.norm0.spineLogo = Float32Array.from(q.n);
  m.geometry.attributes.position.array.set(q.p); m.geometry.attributes.uv.array.set(q.t); m.geometry.attributes.uv.needsUpdate = true;
  if (M.matSpineLogo.map && M.matSpineLogo.map.image !== li) M.matSpineLogo.map.dispose();
  if (!M.matSpineLogo.map || M.matSpineLogo.map.image !== li){ const t = new THREE.Texture(li); t.encoding = THREE.sRGBEncoding; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.needsUpdate = true; M.matSpineLogo.map = t; M.matSpineLogo.needsUpdate = true; }
  m.visible = true;
}

const ROW = {mode: 'centered', margin: 12};

const FILL = {mode: 'AD', footer: 9};

const PRINT = {sdh: {cx: 196, cy: 453, h: 26}, nocopy: {cx: 246, cy: 453, h: 24}};

const BACK = {S: 5, W: 354, H: 476, on: true, plot: true, stretch: true, assets: null, font: null, layout: 'p1', cut: 2, pad: 6};

function drawMasked(ctx, img, x, y, w, h, mode, ax, ay, alpha, mask){
  if (!img || !img.width) return;
  const sc = mode === 'scale' ? Math.max(w / img.width, h / img.height) : Math.min(w / img.width, h / img.height);
  const dw = img.width * sc, dh = img.height * sc;
  const dx = ax === 'left' ? 0 : ax === 'right' ? w - dw : (w - dw) / 2, dy = ay === 'top' ? 0 : ay === 'bottom' ? h - dh : (h - dh) / 2;
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w)); cv.height = Math.max(1, Math.round(h)); const c = cv.getContext('2d');
  c.drawImage(img, dx, dy, dw, dh);
  if (mask){ c.globalCompositeOperation = 'destination-in'; c.drawImage(mask, 0, 0, cv.width, cv.height); }   // Kodi diffuse: scaled to the control (scalediffuse default)
  ctx.globalAlpha = alpha; ctx.drawImage(cv, x, y); ctx.globalAlpha = 1;
}

function composeBackSheetKodi(back, A){
  const S = BACK.S, W = BACK.W * S, H = BACK.H * S, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  const K = v => v * S, side = back.side, img = back.img, M3 = A.mask;
  const hasPlot = BACK.plot && !!(side.plot && side.plot.trim());
  ctx.drawImage(A.blank, 0, 0, W, H);                                                           // 1 sheet
  // 2 fanart 354x225 @0,-15 keep centre/top (clipped to the sheet) - fallback generic_fanart
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  drawMasked(ctx, img.fanart || A.fanart, 0, K(-15), K(354), K(225), 'keep', 'center', 'top', 1, M3);
  ctx.restore();
  drawMasked(ctx, img.fanart1, K(224), K(124), K(141), K(82), 'scale', 'center', 'center', 1, M3);          // 3 thumb 1 (no fallback in Kodi)
  drawMasked(ctx, img.fanart2 || A.thumbfall, K(10), K(192), K(160), K(70), 'scale', 'center', 'center', 1, M3);   // 4 thumb 2
  drawMasked(ctx, img.banner || A.fallban, K(6), K(266), K(334), K(120), 'keep', 'left', 'top', 0xC9/255, M3);     // 5 banner
  // 6 template: back_black (plot) / back (no plot); stretched like Kodi or uniform (top-centred)
  const tpl = hasPlot ? A.info : A.blank;
  if (BACK.stretch) ctx.drawImage(tpl, 0, 0, W, H);
  else { const sc = Math.min(W / tpl.width, H / tpl.height); ctx.drawImage(tpl, (W - tpl.width*sc)/2, 0, tpl.width*sc, tpl.height*sc); }
  // 7 plot 217x63 @8,127: justified, vertically centred, white, Backplot 7.5 px, line spacing 0.8
  if (hasPlot){
    const fs = 7.5 * S, lh = fs * 0.8 * 1.25, maxw = K(217); ctx.font = fs + 'px ' + (BACK.font ? 'Backplot' : 'Arial Narrow, Arial'); ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
    const words = side.plot.replace(/\s+/g, ' ').trim().split(' '), lines = []; let cur = '';
    for (const w of words){ const t = (cur + ' ' + w).trim(); if (ctx.measureText(t).width <= maxw) cur = t; else { if (cur) lines.push(cur); cur = w; } }
    if (cur) lines.push(cur);
    const nmax = Math.max(1, Math.floor(K(63) / lh)), shown = lines.slice(0, nmax), y0 = K(127) + (K(63) - shown.length * lh) / 2;
    shown.forEach((ln, i) => {
      const ws = ln.split(' ');
      if (i < shown.length - 1 && ws.length > 1){ const gap = (maxw - ws.reduce((a, w) => a + ctx.measureText(w).width, 0)) / (ws.length - 1); let x = K(8); for (const w of ws){ ctx.fillText(w, x, y0 + i*lh); x += ctx.measureText(w).width + gap; } }
      else ctx.fillText(ln, K(8), y0 + i*lh);
    });
  }
  drawMasked(ctx, img.clearart || currentLogo || A.falllog, K(195), K(195), K(142), K(64), 'keep', 'left', 'top', 0xC9/255, M3);   // 8 clearart else clearlogo else falllog
  // 9 media flags (keep, 79 %; fallback flag_default like Kodi)
  const boxes = [[6, 433, 40, 40], [64, 433, 40, 40], [118, 438, 50, 30], [272, 434, 40, 40]];
  back.flags.forEach((f, i) => { const [x, y, w, h] = boxes[i]; drawMasked(ctx, f || A.flagdef, K(x), K(y), K(w), K(h), 'keep', 'center', 'center', 0xC9/255, null); });
  return cv;
}

const HYPH = {map: null, maxLen: 0, ready: false};

function hyphPrepare(lang){
  if (!lang || !lang.patterns) return false;
  const map = new Map(); let maxLen = 0;
  for (const size of Object.keys(lang.patterns)){ const str = lang.patterns[size], n = +size;
    for (let i = 0; i + n <= str.length; i += n){ const chunk = str.substr(i, n); let letters = '', pts = [0];
      for (const ch of chunk){ if (ch >= '0' && ch <= '9') pts[pts.length - 1] = +ch; else { letters += ch; pts.push(0); } }
      map.set(letters, pts); if (letters.length > maxLen) maxLen = letters.length; } }
  HYPH.map = map; HYPH.maxLen = maxLen; HYPH.ready = true; return true;
}

function hyphenateWord(word, o){
  o = o || {}; const leftmin = o.leftmin || 2, rightmin = o.rightmin || 3, minWord = o.minWord || 5;
  const out = [];
  // an existing hyphen is a free break (the hyphen stays with the left part); handle each alphabetic segment
  let base = 0; const segs = word.split('-');
  segs.forEach((seg, si) => {
    if (si > 0){ out.push({pos: base, kind: 'dash'}); }         // break right after the existing hyphen
    if (o.patterns !== false && HYPH.ready && /^[A-Za-zÄÖÜäöüß]+$/.test(seg) && seg.length >= minWord){
      const w = '.' + seg.toLowerCase() + '.', pts = new Array(w.length + 1).fill(0);
      for (let i = 0; i < w.length; i++) for (let n = 1; n <= HYPH.maxLen && i + n <= w.length; n++){ const p = HYPH.map.get(w.substr(i, n)); if (!p) continue;
        for (let k = 0; k < p.length; k++) if (p[k] > pts[i + k]) pts[i + k] = p[k]; }
      for (let k = 1; k < seg.length; k++){ if (pts[k + 1] % 2 === 1 && k >= leftmin && seg.length - k >= rightmin) out.push({pos: base + k, kind: 'hyph'}); }
    }
    base += seg.length + 1;                                     // + the hyphen
  });
  return out;
}

const PLOTFIT = {cap: 9.5, min: 5.5, step: 0.1, hyphenate: 'never',   // 'never' (hyphens look sloppy) | 'emergency' (only when a plot would otherwise leave tier 1) | 'always'
  glueStretch: 0.5, glueShrink: 0.2,            // word space may grow to 1.5 x and shrink to 0.8 x at |r| = 1
  expand: 0.03,                                  // glyph expansion per line, +-3 % (InDesign 97..103 %; pdfTeX default 2 %) - without hyphenation the composer needs it
  tiers: [1.0, 1.6, 2.4], window: 0.6, sizeDrop: 0.8,   // r limits per tier (gap <= 1.5 / 1.8 / 2.2 x); quality window; px a tier may cost before the next one is taken
  linePenalty: 10, hyphenPenalty: 50, doubleHyphen: 10000, finalHyphen: 5000, adjDemerits: 10000, orphan: 3000, river: 2000,
  leftmin: 2, rightmin: 3, minWord: 5, maxLadder: 2,
  leadingMin: 1.0, leadingMax: 1.15};

function plotNodes(text, size, ctx, family, hyph){                          // size in sheet px; the canvas is BACK.S x
  ctx.font = (size * BACK.S) + 'px ' + family;
  const cache = new Map(), mw = str => { let v = cache.get(str); if (v === undefined){ v = ctx.measureText(str).width; cache.set(str, v); } return v; };
  const sp = mw(' '), hy = mw('-'), items = [], words = text.replace(/\s+/g, ' ').trim().split(' ');
  words.forEach((word, wi) => {
    if (wi) items.push({t: 'glue', w: sp, y: sp * PLOTFIT.glueStretch, z: sp * PLOTFIT.glueShrink});
    // An existing hyphen (e.g. Science-Fiction) is always a break point - it adds no glyph;
    // pattern hyphenation only when the mode asks for it
    const breaks = hyphenateWord(word, Object.assign({}, PLOTFIT, {patterns: !!hyph}));
    let prev = 0;
    for (const b of breaks){ const part = word.slice(prev, b.pos); if (!part) continue; items.push({t: 'box', w: mw(part), txt: part});
      if (b.kind === 'dash') items.push({t: 'pen', w: 0, p: PLOTFIT.hyphenPenalty, flag: true, txt: ''});        // the hyphen is part of the box already
      else items.push({t: 'pen', w: hy, p: PLOTFIT.hyphenPenalty, flag: true, txt: '-'}); prev = b.pos; }
    const rest = word.slice(prev); if (rest) items.push({t: 'box', w: mw(rest), txt: rest});
  });
  items.push({t: 'glue', w: 0, y: 1e9, z: 0}); items.push({t: 'pen', w: 0, p: -Infinity, flag: false, txt: ''});
  return {items, sp, hy};
}

function knuthPlass(items, measure, tol){
  const n = items.length, P = PLOTFIT;
  const W = [0], Y = [0], Z = [0];                                                   // prefix sums (penalty widths not included)
  for (const it of items){ W.push(W[W.length - 1] + (it.t === 'pen' ? 0 : it.w)); Y.push(Y[Y.length - 1] + (it.t === 'glue' ? it.y : 0)); Z.push(Z[Z.length - 1] + (it.t === 'glue' ? it.z : 0)); }
  let active = [{pos: 0, demerits: 0, fitness: 1, flagged: false, prev: null, r: 0, ladder: 0, gaps: null, lines: 0}];
  const best = new Array(n + 1).fill(null);
  for (let b = 1; b <= n; b++){
    const it = items[b - 1];
    const legal = (it.t === 'glue' && b >= 2 && items[b - 2].t === 'box') || (it.t === 'pen' && it.p < Infinity);
    if (!legal) continue;
    const forced = it.t === 'pen' && it.p === -Infinity;
    let cand = null; const survivors = [];
    for (const a of active){
      const s = a.pos;
      let lw = W[b - 1] - W[s], ly = Y[b - 1] - Y[s], lz = Z[b - 1] - Z[s];
      if (s < n && items[s].t === 'glue'){ lw -= items[s].w; ly -= items[s].y; lz -= items[s].z; }   // a line never starts with glue
      if (it.t === 'pen') lw += it.w;                                                   // hyphen width at the break
      // expansion is capped at +-expand (reached at |r| = 1); beyond that only the word spaces stretch
      const E = P.expand * lw, diff = measure - lw;
      let r;
      if (diff >= 0){ if (ly + E <= 0) r = diff === 0 ? 0 : Infinity; else if (diff <= ly + E) r = diff / (ly + E); else r = ly > 0 ? 1 + (diff - ly - E) / ly : Infinity; }
      else { const shrink = lz + E; r = shrink > 0 ? diff / shrink : -Infinity; }
      if (r < -1){ continue; }                                                          // too long even fully shrunk: this active node is dead for all later b
      survivors.push(a);
      if (r > tol && !forced) continue;
      const rEff = forced ? Math.min(r, 0) : r;                                        // the last line does not pay for its slack
      const bad = Math.min(10000, 100 * Math.pow(Math.abs(rEff), 3));
      const fit = rEff < -0.5 ? 0 : rEff <= 0.5 ? 1 : rEff < 1 ? 2 : 3;
      let d = (P.linePenalty + bad) * (P.linePenalty + bad);
      if (it.t === 'pen' && isFinite(it.p)) d += it.p >= 0 ? it.p * it.p : -it.p * it.p;
      if (Math.abs(fit - a.fitness) > 1) d += P.adjDemerits;
      const flagged = it.t === 'pen' && it.flag;
      if (flagged && a.flagged) d += P.doubleHyphen;
      if (flagged && a.ladder + 1 > P.maxLadder) d += 1e7;                             // hard: at most maxLadder hyphenated lines in a row
      if (forced && a.flagged) d += P.finalHyphen;
      if (forced){ const nWords = countWords(items, s, b - 1); if (nWords < 2 && lw < measure / 3) d += P.orphan; }
      const gaps = (!forced && r > 0.3) ? gapPositions(items, s, b - 1, r) : null;    // rivers: wide gaps aligned with the previous line's
      if (gaps && a.gaps){ for (const g of gaps){ let hit = false; for (const h of a.gaps) if (Math.abs(g - h) < 2.5){ hit = true; break; } if (hit){ d += P.river; break; } } }
      d += a.demerits;
      if (!cand || d < cand.demerits) cand = {pos: b, demerits: d, fitness: fit, flagged, prev: a, r: rEff, ladder: flagged ? a.ladder + 1 : 0, gaps, lines: a.lines + 1};
    }
    active = survivors;
    if (cand){ best[b] = cand; active.push(cand); }
    if (!active.length) return null;
  }
  const end = best[n]; if (!end) return null;
  const lines = []; for (let nd = end; nd.prev; nd = nd.prev) lines.push({from: nd.prev.pos, to: nd.pos, r: nd.r, hyph: nd.flagged});
  return {lines: lines.reverse(), demerits: end.demerits};
}

function countWords(items, s, e){ let n = 0; for (let i = s; i < e; i++) if (items[i].t === 'glue') n++; return n + 1; }

function gapPositions(items, s, e, r){ // x of each glue centre in the line at ratio r (px), for the river check
  const out = []; let x = 0, first = true;
  for (let i = s; i < e; i++){ const it = items[i]; if (it.t === 'glue'){ if (first){ first = false; continue; } const g = it.w + (r >= 0 ? r * it.y : r * it.z); out.push(x + g / 2); x += g; } else if (it.t === 'box'){ x += it.w; first = false; } }
  return out;
}

function composePlot(text, ctx, family, boxW, boxH){
  const P = PLOTFIT, nodeCache = new Map();
  const nodes = (size, hyph) => { const k = size + (hyph ? 'h' : ''); let v = nodeCache.get(k); if (!v){ v = plotNodes(text, size, ctx, family, hyph && HYPH.ready); nodeCache.set(k, v); } return v; };
  const tryAt = (size, tol, hyph) => { const {items, sp} = nodes(size, hyph); const comp = knuthPlass(items, boxW, tol); if (!comp || comp.lines.length * size * BACK.S * P.leadingMin > boxH) return null;
    let worst = 0; for (const ln of comp.lines.slice(0, -1)) worst = Math.max(worst, Math.abs(ln.r)); return {size, items, comp, sp, worst, hyph, score: comp.demerits / comp.lines.length}; };
  const largestAt = (tol, hyph) => { for (let size = P.cap; size >= P.min - 1e-6; size = Math.round((size - P.step) * 10) / 10){ const c = tryAt(size, tol, hyph); if (c) return c; } return null; };
  const refine = (first, tol) => { let best = first;                                           // the quality window below the first feasible size
    for (let s2 = first.size - P.step; s2 >= Math.max(P.min, first.size - P.window) - 1e-6; s2 = Math.round((s2 - P.step) * 10) / 10){ const c = tryAt(s2, tol, first.hyph); if (c && c.worst < best.worst - 0.1) best = c; }
    return best; };
  // tier 1 (gap <= 1.5 x) unless it costs more than `sizeDrop` px against the next tier: without hyphenation a 15-letter
  // word can make whole size ranges infeasible, and 5.7 px text at half the box is worse than one 1.7 x gap
  // passes: [tol, hyphenation] - 'always' hyphenates in every pass, 'emergency' only in a second tier-1 pass that runs
  // when the plain pass would lose more than sizeDrop px against the looser tiers, 'never' not at all
  const passes = P.hyphenate === 'always' ? P.tiers.map(t => [t, true]) : P.tiers.map(t => [t, false]);
  if (P.hyphenate === 'emergency') passes.splice(1, 0, [P.tiers[0], true]);
  let chosen = null;
  passes.forEach(([tol, hy], pi) => {
    const c = largestAt(tol, hy); if (!c) return;
    if (!chosen || c.size - chosen.size > P.sizeDrop){ chosen = c; chosen.pass = pi + 1; chosen.tol = tol; }
  });
  if (!chosen) return null;
  const r = refine(chosen, chosen.tol); r.pass = chosen.pass; r.tol = chosen.tol; return r;
}

function fitPlot(ctx, text, x, y, w, h, family){
  const P = PLOTFIT;
  const best = composePlot(text, ctx, family, w, h);
  if (!best) return fillText(ctx, text, x, y, w, h, family);                          // nothing feasible even at the minimum: the plain filler (ellipsis)
  const {size, items, comp} = best, n = comp.lines.length, px = size * BACK.S;
  const leading = Math.min(P.leadingMax, Math.max(P.leadingMin, h / (n * px))), step = px * leading;
  const y0 = y + (h - n * step) / 2 + (step - px) / 2;                                  // centre the block; glyphs sit mid-leading
  ctx.font = px + 'px ' + family; ctx.textBaseline = 'top'; ctx.fillStyle = '#fff';
  const stats = {size, lines: n, leading: +leading.toFixed(3), pass: best.pass, maxGap: 0, expansions: [], hyphens: 0, gaps: [], widths: []};
  comp.lines.forEach((ln, li) => {
    let s = ln.from; if (s < items.length && items[s].t === 'glue') s++;
    const last = li === n - 1, endPen = items[ln.to - 1].t === 'pen' ? items[ln.to - 1] : null;
    // The last line is never stretched, but it IS shrunk when the composer broke it with r < 0 - rendered at
    // its natural width the final word would protrude into the still (e.g. 29 px over the measure)
    const r = last ? Math.min(0, ln.r) : ln.r;
    let e = 1 + Math.max(-1, Math.min(1, r)) * P.expand;                                 // expansion factor for the line, capped at +-expand
    let boxes = 0, glue = 0; for (let i = s; i < ln.to - 1; i++){ const it = items[i]; if (it.t === 'box') boxes += it.w; else if (it.t === 'glue') glue += it.w; }
    if (endPen) boxes += endPen.w;
    // exact justification: the word gaps take whatever the expanded boxes leave of the measure (the composer's r is the
    // first-order estimate; solving here removes the r^2 cross term). Last line: natural gaps, shrunk only if needed.
    let gapMul;
    if (!last) gapMul = glue > 0 ? (w / e - boxes) / glue : 1;
    else { gapMul = 1 + r * P.glueShrink; if (glue > 0 && boxes + glue * gapMul > w / e) gapMul = Math.max(1 - P.glueShrink, (w / e - boxes) / glue); }
    // hard invariant: a line never exceeds the measure (compress the whole line if the arithmetic still leaves it over)
    const width = e * (boxes + glue * gapMul);
    if (width > w + 0.01){ e = w / (boxes + glue * gapMul); stats.clamped = (stats.clamped || 0) + 1; }
    stats.widths.push(+((e * (boxes + glue * gapMul)) / w).toFixed(4));
    stats.expansions.push(+e.toFixed(4)); if (ln.hyph) stats.hyphens++;
    ctx.save(); ctx.translate(x, y0 + li * step); ctx.scale(e, 1);
    let cx = 0;
    for (let i = s; i < ln.to - 1; i++){ const it = items[i]; if (it.t === 'box'){ ctx.fillText(it.txt, cx, 0); cx += it.w; } else if (it.t === 'glue'){ const g = it.w * gapMul; if (!last) stats.gaps.push(+(g / it.w).toFixed(3)); cx += g; } }
    if (endPen && endPen.txt) ctx.fillText(endPen.txt, cx, 0);
    ctx.restore();
  });
  stats.maxGap = stats.gaps.length ? Math.max(...stats.gaps) : 1; BACK.lastFit = stats;
  return stats;
}

function fillText(ctx, txt, x, y, w, h, family){
  const words = txt.replace(/\s+/g, ' ').trim().split(' ');
  const wrap = () => { const lines = []; let cur = ''; for (const wd of words){ const t = (cur + ' ' + wd).trim(); if (ctx.measureText(t).width <= w) cur = t; else { if (cur) lines.push(cur); cur = wd; } } if (cur) lines.push(cur); return lines; };
  let size = 12.0, lines = null;
  for (; size >= 5.5 - 1e-6; size = Math.round((size - 0.1) * 10) / 10){ ctx.font = (size * BACK.S) + 'px ' + family; lines = wrap(); if (lines.length * size * BACK.S * 0.98 <= h) break; }
  let cut = false;
  if (size < 5.5){ size = 5.5; ctx.font = (size * BACK.S) + 'px ' + family; lines = wrap(); const n = Math.max(1, Math.floor(h / (size * BACK.S * 0.98))); if (lines.length > n){ lines = lines.slice(0, n); lines[n - 1] = lines[n - 1].replace(/[.,;:]$/, '') + ' …'; cut = true; } }
  const lh = Math.min(1.18, Math.max(0.98, h / (lines.length * size * BACK.S))), step = size * BACK.S * lh;
  ctx.textBaseline = 'top'; ctx.fillStyle = '#fff';
  lines.forEach((ln, i) => { const ws = ln.split(' '), yy = y + i * step;
    if (i < lines.length - 1 && ws.length > 1){ const gap = (w - ws.reduce((a, t) => a + ctx.measureText(t).width, 0)) / (ws.length - 1); let xx = x; for (const t of ws){ ctx.fillText(t, xx, yy); xx += ctx.measureText(t).width + gap; } }
    else ctx.fillText(ln, x, yy); });
  return {size, lh, lines: lines.length, cut};
}

function drawCover(ctx, img, x, y, w, h, alpha){
  if (!img || !img.width) return;
  const sc = Math.max(w / img.width, h / img.height), dw = img.width * sc, dh = img.height * sc;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.globalAlpha = alpha || 1; ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore();
}

function composeBackSheetP1(back, A){
  // Bottom gap: the case window is 7:10 (1.4286 W), the Kodi sheet 1.345 W -> ~30 sheet px stay black below the
  // sheet (paintBack passes them as BACK.extra). FILL.mode decides what happens with them:
  //   none - the sheet stays 476 tall (Kodi); A - fanart grows by the gap (overscan crop), everything moves down;
  //   B - the gap is split over fanart / still row / banner (0.6 / 0.2 / 0.2); C - the flags row is centred in the rest;
  //   D - a legal footer line (year, studio, catalogue = barcode) at the bottom edge; AD / BD - A or B with the footer;
  //   P - the gap goes to the plot / still row (more text room); F - fanart and banner share it 50/50;
  //   E - A with a studio block (spine-badge studio logo + catalogue number) right of the footer line.
  const E = Math.max(0, BACK.extra || 0), mode = FILL.mode, foot = /D|E/.test(mode) ? FILL.footer : 0, F = Math.max(0, E - foot);
  const S = BACK.S, W = BACK.W * S, H = (BACK.H + E) * S, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  const K = v => v * S, side = back.side, img = back.img, cut = BACK.cut, pad = BACK.pad;
  const gF = /A|E/.test(mode) ? F : /B/.test(mode) ? F * 0.6 : /F/.test(mode) ? F * 0.5 : 0, gS = /B/.test(mode) ? F * 0.2 : /P/.test(mode) ? F : 0, gB = /B/.test(mode) ? F - gF - gS : /F/.test(mode) ? F - gF : 0;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  drawCover(ctx, img.fanart || A.fanart, 0, 0, K(354), K(172 + gF));
  drawBarcode(ctx, K(292), K(10), K(56), K(26), barcodeFor(side), A);                          // procedural UPC-A / EAN-13 (template code when no language)
  const y1 = 172 + gF, y2 = y1 + cut + 94 + gS + cut;
  if (BACK.plot && side.plot && side.plot.trim()) fitPlot(ctx, side.plot, K(pad), K(y1 + pad), K(226 - 2 * pad), K(y2 - y1 - 2 * pad), BACK.font ? 'Backplot' : 'Arial Narrow, Arial');   // PlotFit
  drawCover(ctx, img.fanart1 || A.thumbfall, K(226), K(y1 + cut), K(128), K(94 + gS));
  drawCover(ctx, img.banner || A.fallban, 0, K(y2), K(354), K(66 + gB), 0xC9 / 255);
  const py = y2 + 66 + gB + 2, ph = 116 * (476 / 600), dy = py - 340;                          // template rows 432..547 -> Kodi's vertical stretch; dy = shift of the print vs the 476 sheet
  // the print block rebuilt as text (8x) - falls back to the template rows when the texture is missing
  if (A.block && A.block.width) ctx.drawImage(A.block, 0, K(py), K(354), K(ph)); else ctx.drawImage(A.info, 0, 432, 474, 116, 0, K(py), K(354), K(ph));
  // the recycled-content sign by studio - Warner's WB-shield sign only for Warner releases, the universal
  // Moebius arrows for everyone else (template symbol box cols 18..34, rows 436..451 -> sheet via 354/474 x 476/600)
  { const mk = isWarner(side.studio) ? A.recycleWb : A.recycleGen, sx = 354 / 474, sy = 476 / 600;
    if (mk && mk.width) ctx.drawImage(mk, K(18 * sx), K(py + (436 - 432) * sy), K(17 * sx), K(16 * sy)); }
  // flags row: with the sheet at 476 the row (boxes 433..473) ends 3 px above the edge; a taller sheet keeps that
  // 3 px in A / B / D, or centres the row in the remaining space in C
  let rowDy = dy; if (mode === 'C'){ const rowTop = py + ph, free = (BACK.H + E - foot) - rowTop; rowDy = rowTop + (free - 40) / 2 - 433; }
  drawFlagsRow(ctx, back, A, rowDy);
  if (foot) drawFooter(ctx, side, K(pad), K(BACK.H + E - foot), K(354 - 2 * pad), K(foot), mode === 'E' ? currentStudio : null);
  return cv;
}

function drawFooter(ctx, side, x, y, w, h, studioImg){
  // the line is parsed from the sidecar: "(c) <year> <studio>. All Rights Reserved. ..." - year only / studio only when one
  // is missing, and a generic line without the (c) owner when the sidecar has neither
  const S = BACK.S, fs = 3.6 * S, year = String(side.year || '').trim(), studio = String(side.studio || '').trim();
  const owner = [year, studio].filter(Boolean).join(' ');
  const left = (owner ? '© ' + owner + '. All Rights Reserved. ' : 'All Rights Reserved. ') + 'Licensed for private home use only. Unauthorized duplication, public performance or broadcast is prohibited.';
  ctx.save(); ctx.fillStyle = 'rgb(218,216,217)'; ctx.font = fs + 'px "Arial Narrow", Arial, sans-serif'; ctx.textBaseline = 'middle';
  const yy = y + h / 2, right = '#' + barcodeFor(side);
  let rw;
  if (studioImg && studioImg.width){                                                        // E: studio logo (spine badge pack) above the catalogue number, right
    const lh = h * 1.6, lw = lh * studioImg.width / studioImg.height; ctx.save(); ctx.globalAlpha = 0.9; ctx.drawImage(studioImg, x + w - lw, y - lh - 1 * S, lw, lh); ctx.restore();
    ctx.textAlign = 'right'; ctx.fillText(right, x + w, yy); rw = Math.max(lw, ctx.measureText(right).width) + 3 * S; }
  else { ctx.textAlign = 'right'; ctx.fillText(right, x + w, yy); rw = ctx.measureText(right).width + 3 * S; }
  ctx.textAlign = 'left'; let t = left; while (ctx.measureText(t).width > w - rw && t.length > 10) t = t.replace(/\s+\S*$/, ''); ctx.fillText(t, x, yy);
  ctx.restore();
}

function drawFlagsRow(ctx, back, A, dy){
  dy = dy || 0;
  const S = BACK.S, K = v => v * S, SW = BACK.W;
  const measure = cv => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let x0 = cv.width, x1 = -1;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3] > 20){ if (x < x0) x0 = x; if (x > x1) x1 = x; }
    return x1 < 0 ? null : [x0 / S, (x1 + 1) / S]; };
  const items = [], boxes = [[6, 433, 40, 40], [64, 433, 40, 40], [118, 438, 50, 30], [272, 434, 40, 40]];
  boxes.forEach((b, i) => { const [x, y, w, h] = b, cv = document.createElement('canvas'); cv.width = K(w); cv.height = K(h);
    drawMasked(cv.getContext('2d'), back.flags[i] || A.flagdef, 0, 0, K(w), K(h), 'keep', 'center', 'center', 0xC9 / 255, null); items.push({cv, x, y, w, bb: measure(cv)}); });
  for (const k of ['sdh', 'nocopy']){ const pr = PRINT[k], im = A[k]; if (!im || !im.width) continue; const h = pr.h, w = h * im.width / im.height, cv = document.createElement('canvas');
    cv.width = Math.ceil(K(w)); cv.height = Math.ceil(K(h)); const c = cv.getContext('2d'); c.globalAlpha = 0xC9 / 255; c.drawImage(im, 0, 0, K(w), K(h)); items.push({cv, x: pr.cx - w / 2, y: pr.cy - h / 2, w, bb: measure(cv)}); }
  items.sort((a, b) => a.x - b.x);
  const vis = items.filter(it => it.bb);
  if (vis.length){
    if (ROW.mode === 'centered'){
      // An icon the metadata does not supply must not leave a HOLE. The row keeps the Kodi
      // layout's own (uneven) spacing between the icons that remain; where an icon drops out, the
      // two gaps around it are merged into ONE of their average size, and the whole run is centred.
      // With all six present this reproduces the design exactly (the same positions and shift as a
      // plain `(R - L) / 2`).
      const ed = it => [it.x + it.bb[0], it.x + it.bb[1]];       // content edges; only ever asked of a VISIBLE item
      const wide = it => ed(it)[1] - ed(it)[0], at = it => items.indexOf(it);
      // the design's own gaps, but only where both neighbours are actually drawn - a missing icon has
      // no ink, so its slot box would make the gaps around it look far tighter than they are
      const adj = []; for (let i = 1; i < items.length; i++) if (items[i].bb && items[i - 1].bb) adj.push(ed(items[i])[0] - ed(items[i - 1])[1]);
      const typical = adj.length ? adj.reduce((a, b) => a + b, 0)/adj.length : 20;
      const pos = [0];
      for (let k = 1; k < vis.length; k++){
        const adjacent = at(vis[k]) === at(vis[k - 1]) + 1;        // nothing dropped out between them -> keep the designed gap
        const gap = adjacent ? ed(vis[k])[0] - ed(vis[k - 1])[1] : typical;
        pos.push(pos[k - 1] + wide(vis[k - 1]) + gap);
      }
      const run = pos[pos.length - 1] + wide(vis[vis.length - 1]), start = (SW - run) / 2;
      vis.forEach((it, k) => { it.nx = start + pos[k] - it.bb[0]; });
    }
    else { const widths = vis.map(it => it.bb[1] - it.bb[0]), gap = (SW - 2 * ROW.margin - widths.reduce((a, b) => a + b, 0)) / Math.max(1, vis.length - 1);
      let x = ROW.margin; vis.forEach((it, i) => { it.nx = x - it.bb[0]; x += widths[i] + gap; }); }
  }
  vis.forEach(it => ctx.drawImage(it.cv, K(it.nx), K(it.y + dy)));
}

const EAN = {
  L: ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'],
  parity: ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'],
  G: d => EAN.L[d].split('').reverse().join(''),
  R: d => EAN.L[d].replace(/[01]/g, c => c === '0' ? '1' : '0'),
  check: data => { let sum = 0; for (let i = 0; i < data.length; i++) sum += (+data[i]) * ((data.length - 1 - i) % 2 === 0 ? 3 : 1); return (10 - sum % 10) % 10; },
  modules: code13 => { const d = code13.split('').map(Number), pat = EAN.parity[d[0]]; let m = '101';
    for (let i = 1; i <= 6; i++) m += pat[i - 1] === 'L' ? EAN.L[d[i]] : EAN.G(d[i]); m += '01010';
    for (let i = 7; i <= 12; i++) m += EAN.R(d[i]); return m + '101'; }
};

const GS1 = {ger: [400, 440], deu: [400, 440], fra: [300, 379], fre: [300, 379], ita: [800, 839], spa: [840, 849], por: [560, 560],
             nld: [870, 879], dut: [870, 879], swe: [730, 739], dan: [570, 579], nor: [700, 709], fin: [640, 649], pol: [590, 590],
             ces: [859, 859], cze: [859, 859], hun: [599, 599], rus: [460, 469], kor: [880, 880], zho: [690, 699], chi: [690, 699],
             jpn: [450, 459], hin: [890, 890], tur: [868, 869], gre: [520, 521], ell: [520, 521], tha: [885, 885]};

const TEMPLATE_UPC = '883929244577';

const isWarner = studio => /warner|\bwb\b/i.test(String(studio || ''));

function fnv(str){ let h = 0x811c9dc5; for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }

function barcodeFor(side){                                  // stable per film: title + year seed the company / item digits
  const lang = ((side.media || {}).audio || [])[0] && side.media.audio[0].lang; if (!lang) return TEMPLATE_UPC;
  const seed = fnv((side.title || side.stem || '') + '|' + (side.year || '')), digits = n => String(seed % Math.pow(10, n)).padStart(n, '0');
  if (lang === 'eng'){ const data = (seed % 2 ? '8' : '0') + digits(5) + String(fnv('item' + seed) % 100000).padStart(5, '0'); return data + EAN.check(data); }
  const r = GS1[lang]; if (!r) return TEMPLATE_UPC;
  const prefix = String(r[0] + seed % (r[1] - r[0] + 1)).padStart(3, '0'), data = prefix + digits(4) + String(fnv('item' + seed) % 100000).padStart(5, '0');
  return data + EAN.check(data);
}

function drawBarcode(ctx, x, y, w, h, code, A){
  if (!/^\d{12,13}$/.test(code)){ ctx.drawImage(A.info, 346, 100, 89, 42, x, y, w, h); return; }
  const upc = code.length === 12, code13 = upc ? '0' + code : code, mods = EAN.modules(code13);
  ctx.save(); ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
  const mw = w / 113, x0 = x + 9 * mw, top = y + h * 0.08, digitH = h * 0.20, barH = h * 0.64, longH = barH + h * 0.09;
  ctx.fillStyle = '#111';
  for (let i = 0; i < 95; i++){ if (mods[i] !== '1') continue;
    const guard = i < 3 || (i >= 45 && i < 50) || i >= 92 || (upc && (i < 10 || i >= 85));          // UPC-A draws the outer digit bars long too
    ctx.fillRect(x0 + i * mw, top, mw * 1.02, guard ? longH : barH); }
  const fontFor = k => (digitH * k) + 'px OCR-B, Consolas, "Courier New", monospace';
  ctx.font = fontFor(1); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
  const ty = y + h * 0.93, cell = (ch, m) => ctx.fillText(ch, x0 + (m + 3.5) * mw, ty);     // digit centred in its 7-module cell starting at module m
  for (let i = 0; i < 6; i++){ if (upc && i === 0) continue; cell(code13[1 + i], 3 + 7 * i); }
  for (let i = 0; i < 6; i++){ if (upc && i === 5) continue; cell(code13[7 + i], 50 + 7 * i); }
  if (upc){ ctx.font = fontFor(0.75); ctx.fillText(code[0], x0 - 4.5 * mw, ty); ctx.fillText(code[11], x0 + 99.5 * mw, ty); }
  else ctx.fillText(code13[0], x0 - 4.5 * mw, ty);
  ctx.restore();
}

function composeBackSheet(back, A){
  const cv = BACK.layout === 'kodi' ? composeBackSheetKodi(back, A) : composeBackSheetP1(back, A);
  const ctx = cv.getContext('2d'), px = [0.25, 0.5, 0.75].map(f => ctx.getImageData(Math.round(cv.width * f), cv.height - 2, 1, 1).data);
  const med = i => px.map(d => d[i]).sort((a, b) => a - b)[1];
  cv.ground = 'rgb(' + med(0) + ',' + med(1) + ',' + med(2) + ')';
  return cv;
}

function paintBack(ctx, bx, by, bw, bh, A){
  const {FC} = M.D, FW = FC.x1 - FC.x0, fitH = (aspectMode === 'fit' || aspectMode === 'fitb') ? FW / posterAspect : (FC.y1 - FC.y0);
  const sheetH0 = bh * (BACK.H / BACK.W) / (fitH / FW);           // 476-sheet height in rect px: 1.345 W of a window that is fitH/FW W tall
  BACK.extra = Math.max(0, (bh - sheetH0) / sheetH0 * BACK.H);      // the gap below the Kodi sheet in sheet px (~30)
  const sheet = composeBackSheet(currentBack, A), mirror = false, sheetH = sheetH0 * sheet.height / (BACK.H * BACK.S);   // the back UV mirror in applyAspect (['back', true]) already makes the canvas read correctly from behind - pre-mirroring would give mirrored text
  ctx.save(); ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
  ctx.fillStyle = sheet.ground || '#0b0b0d'; ctx.fillRect(bx, by, bw, bh);                       // same ground as the sheet -> no step at the sheet's bottom edge
  if (mirror){ ctx.translate(bx + bw, by); ctx.scale(-1, 1); ctx.drawImage(sheet, 0, 0, bw, sheetH); }
  else ctx.drawImage(sheet, bx, by, bw, sheetH);
  ctx.restore();
}

    // ==================== PORTED CORE ABOVE ====================

    // applyAspect IS the fit chain, and several things call it on their own -
    // the format mark's onload among them. Whatever the host set that upstream
    // does not keep in a variable of its own is dropped by such a refit (the
    // spine logo would be placed, then a texture finishes loading and it is
    // gone). Wrapping the chain once here is the only place that catches every
    // caller, including the ones inside the ported code.
    // The spine logo is placed BEFORE the fit, the way upstream's setPoster
    // does it. The order matters: applyAspect treats the logo as a RIGID decal
    // and keeps it undistorted while it reshapes the case to the poster. A logo
    // placed afterwards never gets that treatment, and it is built against M.D,
    // the UNFITTED model - so it would come out distorted in a fitted case.
    var __applyAspectInner = applyAspect;
    applyAspect = function (mode) {
        // Guarded: a badge that cannot be placed must cost its own badge, not
        // the whole case. This runs inside mount(), where an exception would take
        // the entire case off the page.
        try {
            if (currentSpineLogo && M && M.meshes && M.meshes.spineLogo) {
                spineLogoScale = spineLogoScaleFor(M.name);
                setSpineLogo(currentSpineLogo);
            }
        } catch (e) {
            currentSpineLogo = null;
            if (M && M.meshes && M.meshes.spineLogo) { M.meshes.spineLogo.visible = false; }
        }
        __applyAspectInner(mode);
    };

    var booted = false;
    function bootOnce() {
        if (booted) { return; }
        booted = true;
        for (const [n, D] of Object.entries(MODELS)) D.mmU = (n === 'bluray' ? 171.5 : 190)/(D.OUT.y1 - D.OUT.y0);   // mm per model unit (real case heights: Blu-ray 171.5, DVD 190) - furniture that has a real size is written in mm and divided by this
        MESH.dvdgen = genDvdShell(MODELS.dvdgen); TEX.dvdgen = TEX.dvd; BOOKLET_TEX.dvdgen = BOOKLET_TEX.dvd;   // dvdgen shares the DVD booklet map (without one its slab renders black, no text)
    }

    // Renderer settings and lights, copied from upstream rather than invented.
    // Leaving out the sRGB output encoding alone makes the whole case render
    // noticeably darker, and upstream's four lights (hemisphere, key, fill,
    // rim) are what the material roughness values were tuned against.
    function setupScene() {
        if (!renderer || !scene) { return; }
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        const hemi = new THREE.HemisphereLight(0xffffff, 0x334, 0.7); scene.add(hemi);
        const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(60,80,120); scene.add(key);
        const fill = new THREE.DirectionalLight(0x9fb8ff, 0.5); fill.position.set(-80,20,-60); scene.add(fill);
        const rim = new THREE.DirectionalLight(0xffffff, 0.6); rim.position.set(0,-40,-120); scene.add(rim);
        LIGHTS = { key: key, hemi: hemi, fill: fill, rim: rim };
        lightTestFromStorage();
    }

    // Diagnostic mode for the lighting: the four lights are switched off one
    // at a time for a few seconds each (all on -> front off -> ambient off ->
    // fill off -> rim off, round and round), with an indicator in the top left
    // corner saying which one is off.
    // OFF unless the browser asks for it:
    //   localStorage.setItem('ArtworkPlusLightTest', '3'); location.reload();   // 3 s per phase
    //   localStorage.removeItem('ArtworkPlusLightTest'); location.reload();     // off again
    // or ArtworkPlusThreejsRenderer.lightTest(3) / lightTest(0) without a reload.
    // The module draws on demand, so every switch draws one frame itself.
    var LIGHTS = null, lightTimer = null, lightPhase = 0;
    var LIGHT_PHASES = [null, 'key', 'hemi', 'fill', 'rim'];
    var LIGHT_LABELS = { key: 'Front (Key)', hemi: 'Ambient (Hemisphere)', fill: 'Back left (Fill)', rim: 'Back bottom (Rim)' };

    function lightTestIndicator(text) {
        var el = document.getElementById('artworkplus-lighttest');
        if (text === null) { if (el) { el.remove(); } return; }
        if (!el) {
            el = document.createElement('div');
            el.id = 'artworkplus-lighttest';
            el.style.cssText = 'position:fixed;top:72px;left:12px;z-index:99999;pointer-events:none;background:rgba(0,0,0,.75);color:#fff;'
                + 'font:600 15px/1.4 sans-serif;padding:6px 12px;border-radius:6px;border:1px solid rgba(255,255,255,.35)';
            document.body.appendChild(el);
        }
        el.textContent = text;
    }

    function lightTestApply() {
        if (!LIGHTS) { return; }
        var off = LIGHT_PHASES[lightPhase];
        Object.keys(LIGHTS).forEach(function (k) { LIGHTS[k].visible = k !== off; });
        lightTestIndicator('Light test: ' + (off ? 'OFF = ' + LIGHT_LABELS[off] : 'all 4 on'));
        try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { /* the page draws the next frame itself */ }
    }

    function lightTest(seconds) {
        if (lightTimer) { clearInterval(lightTimer); lightTimer = null; }
        if (!seconds || seconds <= 0) {
            lightPhase = 0;
            if (LIGHTS) { Object.keys(LIGHTS).forEach(function (k) { LIGHTS[k].visible = true; }); }
            lightTestIndicator(null);
            try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { /* ignore */ }
            return;
        }
        lightPhase = 0;
        lightTestApply();
        lightTimer = setInterval(function () { lightPhase = (lightPhase + 1) % LIGHT_PHASES.length; lightTestApply(); }, seconds * 1000);
    }

    // Diagnostic mode for the rim light, which can light the flanks of the
    // grooves (a V-groove flank faces down and the rim comes from behind AND
    // below; there are no shadows, so the case does not block it). Walks the
    // rim through elevations, straight from behind: upstream's -18.4 deg
    // (0,-40,-120), -35, 0, +18.4, +35 deg, then off - indicator top left.
    // Same switches as above:
    //   localStorage.setItem('ArtworkPlusRimTest', '5'); location.reload();   or   ArtworkPlusThreejsRenderer.rimTest(5) / rimTest(0)
    var rimTimer = null, rimPhase = 0;
    var RIM_PHASES = [
        { deg: Math.atan2(-40, 120) * 180 / Math.PI, label: 'Original: 18° from below' },
        { deg: -35, label: '35° from below' },
        { deg: 0, label: 'level (0°)' },
        { deg: 18.4, label: '18° from above' },
        { deg: 35, label: '35° from above' },
        { deg: null, label: 'AUS' }
    ];

    function rimTestApply() {
        if (!LIGHTS) { return; }
        var ph = RIM_PHASES[rimPhase], rim = LIGHTS.rim;
        if (ph.deg === null) { rim.visible = false; }
        else { rim.visible = true; rim.position.set(0, 120 * Math.tan(ph.deg * Math.PI / 180), -120); }
        lightTestIndicator('Rim-Test: ' + ph.label);
        try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { /* the page draws the next frame itself */ }
    }

    function rimTest(seconds) {
        if (rimTimer) { clearInterval(rimTimer); rimTimer = null; }
        if (!seconds || seconds <= 0) {
            rimPhase = 0;
            if (LIGHTS) { LIGHTS.rim.visible = true; LIGHTS.rim.position.set(0, -40, -120); }
            lightTestIndicator(null);
            try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { /* ignore */ }
            return;
        }
        rimPhase = 0;
        rimTestApply();
        rimTimer = setInterval(function () { rimPhase = (rimPhase + 1) % RIM_PHASES.length; rimTestApply(); }, seconds * 1000);
    }

    // The groove fix ("rowuv": 0 white / 0 dark lines over 96 measured views,
    // against 19 / 54 without it) as a LIVE toggle, lights at upstream's
    // angles. Blu-ray only (the DVD has no groove). The groove triangles of
    // lidBL / backBL (the band bottom and lip top V-grooves) take the normal of
    // the nearest vertex of the adjacent non-groove row (band row above / lip
    // row below, nearest in x), and their UV v is set to a band / lip row -
    // the geometry stays JFX-original.
    //   localStorage.setItem('ArtworkPlusGrooveTest', '5'); location.reload();   or   ArtworkPlusThreejsRenderer.grooveTest(5) / grooveTest(0)
    var grooveTimer = null;

    // mode 0 = off, 1 = rowuv as measured (|ny| > 0.5, neighbour nearest in x, z weighted 0.3),
    // 2 = fine: EVERY triangle inside the groove windows (the groove floor and the rounded corners
    // included) and the neighbour by its true x/z distance (z weighted 1) - for the rounded ends.
    function groovePrep() {
        if (!M || !M.orig || !M.orig.lidBL || !M.orig.backBL || !M.norm0 || !M.norm0.lidBL) { return null; }
        if (M.__groove) { return M.__groove; }
        var D = M.D, G = {}, GF = {}, GM = {}, N0 = {}, P0 = {};
        GROOVE_ALL.filter(function (n) { return M.orig[n] && M.norm0[n]; }).forEach(function (n) {
            var P = M.orig[n], N = M.norm0[n], idx = [], fine = [], max = [];
            for (var t = 0; t < P.length / 9; t++) {
                var ok = true, okW = true, ny = 0;
                for (var k = 0; k < 3; k++) {
                    var i = (t * 3 + k) * 3, y = P[i + 1]; ny += N[i + 1] / 3;
                    var inTop = y > D.FC.y1 - 0.02 && y < D.FC.y1 + 0.1, inBot = y > D.FC.y0 - 0.06 && y < D.FC.y0 + 0.02;
                    if (!(inTop || inBot)) { ok = false; }
                    // mode 3: a wider window - the triangles right beside the groove as well
                    var inTopW = y > D.FC.y1 - 0.05 && y < D.FC.y1 + 0.14, inBotW = y > D.FC.y0 - 0.1 && y < D.FC.y0 + 0.05;
                    if (!(inTopW || inBotW)) { okW = false; }
                }
                if (ok && Math.abs(ny) > 0.5) { idx.push(t); }
                if (ok) { fine.push(t); }
                if (okW) { max.push(t); }
            }
            G[n] = idx; GF[n] = fine; GM[n] = max; N0[n] = N.slice(); P0[n] = P.slice();
        });
        M.__groove = { G: G, GF: GF, GM: GM, N0: N0, P0: P0, rows: {} };
        return M.__groove;
    }

    // rowuv at 80 % is the DEFAULT on every Blu-ray case and runs always, not
    // only in the test mode (100 % flattens the relief completely, 0-50 % does
    // too little).
    // weight w (0..1): how far the groove normals turn toward the neighbour row and the groove UV v
    // moves toward the band / lip row - 1 = rowuv in full, 0.8 = the relief kept as a faint shimmer.
    // applyAspect rebuilds the geometry from M.norm0 and resets the planar UVs every time, so the
    // normals are set BEFORE it and the UVs AFTER it, through a wrapper - upstream's body is untouched.
    var GROOVE_DEFAULT = { mode: 1, w: 0.8 };
    var grooveState = { mode: GROOVE_DEFAULT.mode, w: GROOVE_DEFAULT.w };
    // The same white line appears on the SPINE, where the head band meets the
    // body. That groove belongs to the shell's band part caseBL (caseInBL
    // inside); GROOVE_SPINE.on adds them. The groove runs along z there, so
    // the neighbour is found by the true x/z distance. Measured: caseBL 76
    // groove triangles, caseInBL none. ON by default, same 80 %.
    // The spine face itself (the side with the spine logo) is a third place:
    // upstream moves the spine's groove faces (M.grooveFaces) into spineEnds,
    // the shut-only band / lip plastic of the spine - 28 up/down-facing
    // triangles at the head band edge and 24 at the lip there, none in case /
    // caseBL. GROOVE_SPINE.ends adds spineEnds (52 triangles) - ON by default,
    // same 80 %.
    var GROOVE_ALL = ['lidBL', 'backBL', 'caseBL', 'caseInBL', 'spineEnds'];
    var GROOVE_SPINE_DEFAULT = true, GROOVE_ENDS_DEFAULT = true;
    var GROOVE_SPINE = { on: GROOVE_SPINE_DEFAULT, ends: GROOVE_ENDS_DEFAULT };
    function grooveNames() {
        var n = ['lidBL', 'backBL'];
        if (GROOVE_SPINE.on) { n = n.concat(['caseBL', 'caseInBL']); }
        if (GROOVE_SPINE.ends) { n = n.concat(['spineEnds']); }
        return n;
    }

    function grooveParams(mode) {
        var g = M.__groove;
        return { SET: mode === 3 ? g.GM : mode === 2 ? g.GF : g.G, ZW: mode >= 2 ? 1 : 0.3, AVG: mode === 3 ? 3 : 1, UVOFF: mode === 3 ? 18 : 4 };
    }

    function grooveNormals(mode, w) {
        var g = groovePrep();
        if (!g) { return null; }
        var key = mode + ':' + w + (GROOVE_SPINE.on ? ':spine' : '') + (GROOVE_SPINE.ends ? ':ends' : '');
        if (g.appliedN === key) { return g; }
        var D = M.D, on = mode > 0 && w > 0, pr = grooveParams(mode), SET = pr.SET, AVG = pr.AVG;
        Object.keys(g.N0).forEach(function (n) { M.norm0[n].set(g.N0[n]); });
        if (on) {
            grooveNames().filter(function (n) { return SET[n]; }).forEach(function (n) {
                var N = M.norm0[n], P = M.orig[n], P0 = g.P0[n], N0 = g.N0[n];
                var ZW = n === 'lidBL' || n === 'backBL' ? pr.ZW : 1;
                SET[n].forEach(function (t) {
                    for (var k = 0; k < 3; k++) {
                        var i = (t * 3 + k) * 3, y = P[i + 1], top = y > (D.FC.y0 + D.FC.y1) / 2, key = n + (top ? 't' : 'b') + mode;
                        if (!g.rows[key]) {
                            var inG = new Set();
                            SET[n].forEach(function (tt) { for (var kk = 0; kk < 3; kk++) { inG.add(tt * 3 + kk); } });
                            var yEdge = top ? 1e9 : -1e9, vi, yy;
                            for (vi = 0; vi < P0.length / 3; vi++) {
                                if (inG.has(vi)) { continue; }
                                yy = P0[vi * 3 + 1];
                                if (top && yy > D.FC.y1 + 0.085 && yy < yEdge) { yEdge = yy; }
                                if (!top && yy < D.FC.y0 - 0.03 && yy > yEdge) { yEdge = yy; }
                            }
                            var c = [];
                            for (vi = 0; vi < P0.length / 3; vi++) { if (!inG.has(vi) && Math.abs(P0[vi * 3 + 1] - yEdge) < 1e-3) { c.push(vi); } }
                            g.rows[key] = { yEdge: yEdge, c: c };
                        }
                        var R = g.rows[key];
                        var near = R.c.map(function (vi2) { return [Math.abs(P0[vi2 * 3] - P[i]) + ZW * Math.abs(P0[vi2 * 3 + 2] - P[i + 2]), vi2]; })
                            .sort(function (a, b) { return a[0] - b[0]; }).slice(0, AVG);
                        if (near.length) {
                            var sx = 0, sy = 0, sz = 0;
                            near.forEach(function (e) { sx += N0[e[1] * 3]; sy += N0[e[1] * 3 + 1]; sz += N0[e[1] * 3 + 2]; });
                            var l = Math.hypot(sx, sy, sz) || 1;
                            var tx = (1 - w) * N0[i] + w * sx / l, ty = (1 - w) * N0[i + 1] + w * sy / l, tz = (1 - w) * N0[i + 2] + w * sz / l;
                            var l2 = Math.hypot(tx, ty, tz) || 1;
                            N[i] = tx / l2; N[i + 1] = ty / l2; N[i + 2] = tz / l2;
                        }
                    }
                });
            });
        }
        g.appliedN = key;
        return g;
    }

    function grooveUV(mode, w) {
        var g = M && M.__groove;
        if (!g || !M.meshes || !M.meshes.lidBL) { return; }
        var D = M.D, on = mode > 0 && w > 0, pr = grooveParams(mode), SET = pr.SET, UVOFF = pr.UVOFF;
        if (on) {
            var vTop = 1 - (PNG.py[2] - UVOFF) / PNG.h, vBot = 1 - (PNG.py[1] + UVOFF) / PNG.h, mid = (D.FC.y0 + D.FC.y1) / 2;
            ['lidBL', 'backBL'].forEach(function (n) {
                var U = M.meshes[n].geometry.attributes.uv.array, P = M.orig[n];
                SET[n].forEach(function (t) { for (var k = 0; k < 3; k++) { var j = t * 3 + k, vT = P[j * 3 + 1] > mid ? vTop : vBot; U[j * 2 + 1] = (1 - w) * U[j * 2 + 1] + w * vT; } });
                M.meshes[n].geometry.attributes.uv.needsUpdate = true;
            });
        }
    }

    var applyAspectUpstream = applyAspect;
    applyAspect = function (mode) {
        try { grooveNormals(grooveState.mode, grooveState.w); } catch (e) { /* the case matters more than the groove */ }
        applyAspectUpstream(mode);
        try { grooveUV(grooveState.mode, grooveState.w); } catch (e) { /* ditto */ }
    };

    // the test mode: sets the state and runs the whole chain once, like the host's fit()
    function grooveApply(mode, w) {
        if (w === undefined) { w = 1; }
        if (!groovePrep()) { lightTestIndicator('Groove test: no Blu-ray case on this page'); return; }
        grooveState = { mode: mode, w: w };
        applyAspect(aspectMode);
        var on = mode > 0 && w > 0, SET = grooveParams(mode).SET;
        lightTestIndicator('Groove test: ' + (on && w < 1 ? 'rowuv ' + Math.round(w * 100) + ' %'
            : ['AUS', 'rowuv 100 % (wie gemessen)', 'rowuv FEIN', 'rowuv MAXIMAL'][mode])
            + (on ? ' \u2013 ' + (SET.lidBL.length + SET.backBL.length) + ' groove triangles' : '')
            + (mode === GROOVE_DEFAULT.mode && w === GROOVE_DEFAULT.w ? ' (Standard)' : ''));
        try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { /* the page draws the next frame itself */ }
    }

    function grooveTest(seconds) {
        if (grooveTimer) { clearInterval(grooveTimer); grooveTimer = null; }
        if (!seconds || seconds <= 0) {                          // back to the default, not to "off"
            try { if (groovePrep()) { grooveState = { mode: GROOVE_DEFAULT.mode, w: GROOVE_DEFAULT.w }; applyAspect(aspectMode); } } catch (e) { /* ignore */ }
            lightTestIndicator(null);
            try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { /* ignore */ }
            return;
        }
        var step = 0;
        var tick = function () {
            if (!M || !M.meshes || !M.meshes.lidBL) { lightTestIndicator('Groove test: waiting for a Blu-ray case'); return; }
            // strengths of the measured variant, between 75 and 100 (100 itself excluded): 75 / 80 / 85 / 90 / 95 %
            var W = [0.75, 0.8, 0.85, 0.9, 0.95][step % 5];
            try { grooveApply(W > 0 ? 1 : 0, W); } catch (e) { lightTestIndicator('Groove test: error ' + e.message); }
            step++;
        };
        tick();
        grooveTimer = setInterval(tick, seconds * 1000);
    }

    // The spine test - the default (rowuv 80 % on lid, back and the opening side caseBL) against
    // the same 80 % also on the spine face (spineEnds), alternating every `seconds`.
    //   ArtworkPlusThreejsRenderer.spineTest(5) / spineTest(0)
    var spineTimer = null;
    function spineTest(seconds) {
        if (spineTimer) { clearInterval(spineTimer); spineTimer = null; }
        if (!seconds || seconds <= 0) {                          // back to the default
            GROOVE_SPINE.on = GROOVE_SPINE_DEFAULT;
            GROOVE_SPINE.ends = GROOVE_ENDS_DEFAULT;
            try { if (groovePrep()) { grooveState = { mode: GROOVE_DEFAULT.mode, w: GROOVE_DEFAULT.w }; applyAspect(aspectMode); } } catch (e) { /* ignore */ }
            lightTestIndicator(null);
            try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { /* ignore */ }
            return;
        }
        var step = 0;
        var tick = function () {
            if (!M || !M.meshes || !M.meshes.lidBL) { lightTestIndicator('Spine test: waiting for a Blu-ray case'); return; }
            try {
                GROOVE_SPINE.on = true;
                GROOVE_SPINE.ends = step % 2 === 1;
                grooveApply(GROOVE_DEFAULT.mode, GROOVE_DEFAULT.w);
                var S = grooveParams(GROOVE_DEFAULT.mode).SET;
                lightTestIndicator('Spine test: ' + (GROOVE_SPINE.ends
                    ? 'rowuv 80 % also on the logo spine (' + (S.spineEnds || []).length + ' groove triangles added)'
                    : 'current (logo spine uncorrected)'));
            } catch (e) { lightTestIndicator('Spine test: error ' + e.message); }
            step++;
        };
        tick();
        spineTimer = setInterval(tick, seconds * 1000);
    }

    // Antialiasing test. MSAA only smooths triangle EDGES; "light stairs" on
    // rounded edges a few pixels wide are shading aliasing (light computed
    // once per pixel). Modes: default (device pixel ratio, max 2) /
    // supersampling 3x / supersampling 4x (the browser scales the canvas down)
    // / default + softer gloss (case roughness +0.10). Countdown in the
    // indicator, Alt+Shift+A jumps to the next mode. Re-applied every second,
    // because the host sets the pixel ratio again on every layout.
    //   localStorage.setItem('ArtworkPlusAaTest', '600'); location.reload();   or   ArtworkPlusThreejsRenderer.aaTest(600) / aaTest(0)
    var aaTimer = null, aaMode = 0, aaNext = 0, aaSeconds = 0, aaRough = null, aaKeyBound = false;
    var AA_MODES = [
        { label: 'current (2× pixel density)', pr: 0, rough: 0 },
        { label: 'Supersampling 3×', pr: 3, rough: 0 },
        { label: 'Supersampling 4×', pr: 4, rough: 0 },
        { label: 'current + softer gloss (roughness +0.10)', pr: 0, rough: 0.10 }
    ];

    function aaMaterials() {
        return M ? ['matCase', 'matFront', 'matBack', 'matInner', 'matLidIn'].map(function (k) { return M[k]; }).filter(Boolean) : [];
    }

    function aaApply() {
        if (!renderer) { return; }
        var m = AA_MODES[aaMode], want = m.pr || Math.min(window.devicePixelRatio || 1, 2);
        var size = new THREE.Vector2(); renderer.getSize(size);
        if (Math.max(size.x, size.y) * want > 4608) { want = 4608 / Math.max(size.x, size.y); }   // the host's buffer cap
        if (Math.abs(renderer.getPixelRatio() - want) > 0.01) { renderer.setPixelRatio(want); renderer.setSize(size.x, size.y, false); }
        var mats = aaMaterials();
        if (!aaRough) { aaRough = new Map(); }
        mats.forEach(function (mt) {
            if (!aaRough.has(mt)) { aaRough.set(mt, mt.roughness); }
            var r = aaRough.get(mt) + m.rough;
            if (mt.roughness !== r) { mt.roughness = r; mt.needsUpdate = true; }
        });
        var left = Math.max(0, Math.round((aaNext - Date.now()) / 1000));
        lightTestIndicator('AA-Test: ' + (aaMode + 1) + '/4 ' + m.label + ' – buffer ' + Math.round(size.x * want) + ' px – next in '
            + Math.floor(left / 60) + ':' + ('0' + left % 60).slice(-2) + ' (Alt+Shift+A = next)');
        try { if (scene && camera) { renderer.render(scene, camera); } } catch (e) { /* the page draws the next frame itself */ }
    }

    function aaTest(seconds) {
        if (aaTimer) { clearInterval(aaTimer); aaTimer = null; }
        if (!seconds || seconds <= 0) {
            aaMode = 0;
            if (renderer) { var s0 = new THREE.Vector2(); renderer.getSize(s0); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(s0.x, s0.y, false); }
            if (aaRough) { aaRough.forEach(function (r, mt) { mt.roughness = r; mt.needsUpdate = true; }); aaRough = null; }
            lightTestIndicator(null);
            try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { /* ignore */ }
            return;
        }
        aaSeconds = seconds; aaMode = 0; aaNext = Date.now() + seconds * 1000;
        if (!aaKeyBound) {
            aaKeyBound = true;
            document.addEventListener('keydown', function (e) {
                if (aaTimer && e.altKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) { aaMode = (aaMode + 1) % AA_MODES.length; aaNext = Date.now() + aaSeconds * 1000; aaApply(); }
            });
        }
        aaApply();
        aaTimer = setInterval(function () {
            if (Date.now() >= aaNext) { aaMode = (aaMode + 1) % AA_MODES.length; aaNext = Date.now() + aaSeconds * 1000; }
            aaApply();
        }, 1000);
    }

    // "Light stairs" on the case ends / edges under back light are shading
    // FACETS, not pixel aliasing: the JFX shell carries split normals at 914 of
    // 1214 Blu-ray positions, 506 of them 5-20 deg (the tiles of a rounding).
    // A smoothing test: at every position the normals of all meshes whose
    // angle to this one is below the threshold are averaged (a crease angle);
    // real edges above it stay sharp. Geometry untouched. The groove fix
    // (80 %) is re-applied on top.
    // original / 20 / 30 / 45 / 60 / 75 / 90 / 100 deg - above ~45 deg real edges get softened (how it
    // should NOT look).
    //   localStorage.setItem('ArtworkPlusSmoothTest', '10'); location.reload();   or   ArtworkPlusThreejsRenderer.smoothTest(10) / smoothTest(0)
    var smoothTimer = null, smoothStep = 0;
    var SMOOTH_STEPS = [0, 20, 30, 45, 60, 75, 90, 100];

    function smoothBase() {
        if (!M || !M.norm0 || !M.orig) { return null; }
        if (M.__smoothBase) { return M.__smoothBase; }
        var B = {};
        Object.keys(M.norm0).forEach(function (n) {
            if (!M.orig[n]) { return; }
            B[n] = (M.__groove && M.__groove.N0[n]) ? M.__groove.N0[n].slice() : M.norm0[n].slice();   // the true originals
        });
        M.__smoothBase = B;
        return B;
    }

    function smoothApply(deg) {
        var B = smoothBase();
        if (!B) { return; }
        var names = Object.keys(B), cosT = Math.cos(deg * Math.PI / 180), map = new Map();
        names.forEach(function (n) {
            M.norm0[n].set(B[n]);
            if (deg <= 0) { return; }
            var P = M.orig[n];
            for (var v = 0; v < P.length / 3; v++) {
                var key = Math.round(P[v * 3] * 1e4) + ',' + Math.round(P[v * 3 + 1] * 1e4) + ',' + Math.round(P[v * 3 + 2] * 1e4);
                var list = map.get(key); if (!list) { list = []; map.set(key, list); }
                list.push([n, v]);
            }
        });
        if (deg > 0) {
            map.forEach(function (list) {
                if (list.length < 2) { return; }
                list.forEach(function (a) {
                    var Na = B[a[0]], i = a[1] * 3, sx = 0, sy = 0, sz = 0;
                    list.forEach(function (b) {
                        var Nb = B[b[0]], j = b[1] * 3;
                        if (Na[i] * Nb[j] + Na[i + 1] * Nb[j + 1] + Na[i + 2] * Nb[j + 2] >= cosT) { sx += Nb[j]; sy += Nb[j + 1]; sz += Nb[j + 2]; }
                    });
                    var l = Math.hypot(sx, sy, sz) || 1, T = M.norm0[a[0]];
                    T[i] = sx / l; T[i + 1] = sy / l; T[i + 2] = sz / l;
                });
            });
        }
        delete M.__groove;                        // the groove fix re-reads its originals from the smoothed normals
        applyAspect(aspectMode);
        lightTestIndicator('Smoothing: ' + (deg > 0 ? 'creases up to ' + deg + '° smooth' + (deg > 45 ? ' (too soft)' : '') : 'original') + ' – grooves 80 %');
        try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { /* the page draws the next frame itself */ }
    }

    function smoothTest(seconds) {
        if (smoothTimer) { clearInterval(smoothTimer); smoothTimer = null; }
        if (!seconds || seconds <= 0) {
            try { if (M && M.__smoothBase) { smoothApply(0); delete M.__smoothBase; } } catch (e) { /* ignore */ }
            lightTestIndicator(null);
            return;
        }
        smoothStep = 0;
        var tick = function () {
            if (!M || !M.meshes || !M.meshes.lidBL) { lightTestIndicator('Smoothing: waiting for a Blu-ray case'); return; }
            try { smoothApply(SMOOTH_STEPS[smoothStep % SMOOTH_STEPS.length]); } catch (e) { lightTestIndicator('Smoothing: error ' + e.message); }
            smoothStep++;
        };
        tick();
        smoothTimer = setInterval(tick, seconds * 1000);
    }

    // A pixelated white line along the case's bottom edge = a lit surface
    // seen almost edge-on, thinner than a pixel (the underside / bottom bevel
    // under the rim light). Moving the light only moves the line to another
    // angle, so this tests two remedies and their combination:
    //   grazing fade - direct light on a surface fades out as the view grazes it (|n.v| < 0.25),
    //                  ambient stays; injected into the case materials, geometry untouched
    //   MSAA         - the frame is drawn into a multisample target with as many samples as the GPU
    //                  offers (max 16, the canvas' own MSAA is usually 4) and copied to the canvas
    //   localStorage.setItem('ArtworkPlusEdgeTest', '10'); location.reload();   or   ArtworkPlusThreejsRenderer.edgeTest(10) / edgeTest(0)
    var edgeTimer = null, edgeStep = 0;
    // GRAZE: fade width (0 = off); GRAZE_HARD: 1 = edge light OFF below the threshold (a 0.05 wide step)
    var GRAZE = { value: 0 }, GRAZE_HARD = { value: 0 };
    var EDGE = { mode: null, samples: 0, orig: null, msaaRT: null, acc: [null, null], accIdx: 0, k: 0, N: 32,
                 lastHost: 0, sc: null, cam: null, raf: 0, qScene: null, qCam: null, copyMat: null, mixMat: null };
    var EDGE_MODES = [
        { label: 'current (canvas, usually 4 samples)', msaa: false, acc: false, graze: 0, hard: 0 },
        { label: 'Antialiasing maximum', msaa: true, acc: false, graze: 0, hard: 0 },
        { label: 'Maximum + edge light dimmed', msaa: true, acc: false, graze: 0.25, hard: 0 },
        { label: 'Maximum + edge light off', msaa: true, acc: false, graze: 0.3, hard: 1 },
        { label: 'Accumulation (32 frames when still)', msaa: true, acc: true, graze: 0, hard: 0 },
        { label: 'Accumulation + edge light dimmed', msaa: true, acc: true, graze: 0.25, hard: 0 },
        { label: 'Accumulation + edge light off', msaa: true, acc: true, graze: 0.3, hard: 1 },
        { label: 'Accumulation corrected (sRGB, 24-bit depth)', msaa: true, acc: true, lite: true, graze: 0, hard: 0 }
    ];
    var edgeList = null;       // optional subset of EDGE_MODES indices for the timer

    function grazePatch(mat) {
        if (!mat || !mat.isMeshStandardMaterial || mat.__grazePatched2) { return; }
        mat.__grazePatched2 = true;
        mat.onBeforeCompile = function (shader) {
            shader.uniforms.uGrazeFade = GRAZE;
            shader.uniforms.uGrazeHard = GRAZE_HARD;
            shader.fragmentShader = 'uniform float uGrazeFade;\nuniform float uGrazeHard;\n' + shader.fragmentShader.replace('#include <lights_fragment_end>',
                '#include <lights_fragment_end>\n  if (uGrazeFade > 0.0) { float grazeV = abs(dot(normal, normalize(vViewPosition)));'
                + ' float grazeF = uGrazeHard > 0.5 ? smoothstep(uGrazeFade - 0.05, uGrazeFade, grazeV) : smoothstep(0.0, uGrazeFade, grazeV);'
                + ' reflectedLight.directDiffuse *= grazeF; reflectedLight.directSpecular *= grazeF; }');
        };
        mat.needsUpdate = true;
    }

    function edgeTarget(w, h, multisample) {
        var rt = multisample ? new THREE.WebGLMultisampleRenderTarget(w, h, { format: THREE.RGBAFormat, type: THREE.HalfFloatType })
                             : new THREE.WebGLRenderTarget(w, h, { format: THREE.RGBAFormat, type: THREE.HalfFloatType, depthBuffer: false });
        if (multisample) { rt.samples = EDGE.samples; }
        return rt;
    }

    // Halton (2,3) sub-pixel offsets in [-0.5, 0.5)
    function halton(i, b) { var f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

    function edgeInstall() {
        if (EDGE.orig || !renderer || !THREE.WebGLMultisampleRenderTarget) { return; }
        EDGE.samples = Math.min(renderer.capabilities.maxSamples || 0, 16);
        var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); quad.frustumCulled = false; quad.position.z = -0.5;
        EDGE.copyMat = new THREE.MeshBasicMaterial({ toneMapped: false, blending: THREE.NoBlending, depthTest: false, depthWrite: false });
        EDGE.mixMat = new THREE.ShaderMaterial({
            uniforms: { tAcc: { value: null }, tCur: { value: null }, uW: { value: 1 } },
            vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: 'uniform sampler2D tAcc; uniform sampler2D tCur; uniform float uW; varying vec2 vUv;'
                + ' void main(){ gl_FragColor = mix(texture2D(tAcc, vUv), texture2D(tCur, vUv), uW); }',
            blending: THREE.NoBlending, depthTest: false, depthWrite: false
        });
        EDGE.quad = quad;
        EDGE.qScene = new THREE.Scene(); EDGE.qScene.add(quad);
        EDGE.qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        EDGE.orig = renderer.render.bind(renderer);
        renderer.render = function (sc, cam) {
            var m = EDGE.mode;
            if (m && m.lite && sc !== EDGE.qScene && renderer.getRenderTarget() === null) {
                // motion = the plain canvas path unchanged; the accumulation starts once the host is still
                EDGE.sc = sc; EDGE.cam = cam; EDGE.lastHost = performance.now(); EDGE.k = 0;
                EDGE.orig(sc, cam);
                edgeAccumulate();
                return;
            }
            if (!m || !m.msaa || EDGE.samples < 2 || sc === EDGE.qScene || renderer.getRenderTarget() !== null) { return EDGE.orig(sc, cam); }
            EDGE.sc = sc; EDGE.cam = cam; EDGE.lastHost = performance.now(); EDGE.k = 0;
            edgeFrame(false);
            if (m.acc) { edgeAccumulate(); }
        };
    }

    function edgeSize() {
        var sz = new THREE.Vector2(); renderer.getDrawingBufferSize(sz);
        if (!EDGE.msaaRT || EDGE.msaaRT.width !== sz.x || EDGE.msaaRT.height !== sz.y) {
            [EDGE.msaaRT, EDGE.acc[0], EDGE.acc[1]].forEach(function (t) { if (t) { t.dispose(); } });
            EDGE.msaaRT = edgeTarget(sz.x, sz.y, true);
            EDGE.acc = [edgeTarget(sz.x, sz.y, false), edgeTarget(sz.x, sz.y, false)];
        }
        return sz;
    }

    // one frame: scene -> MSAA target (optionally jittered); jitter + accumulation when asked; target -> canvas
    function edgeFrame(jitter) {
        var sz = edgeSize(), cam = EDGE.cam;
        if (jitter && cam.setViewOffset) {
            var i = EDGE.k + 1, jx = halton(i, 2) - 0.5, jy = halton(i, 3) - 0.5;
            cam.setViewOffset(sz.x, sz.y, jx, jy, sz.x, sz.y);
        }
        renderer.setRenderTarget(EDGE.msaaRT);
        EDGE.orig(EDGE.sc, cam);
        if (jitter && cam.clearViewOffset) { cam.clearViewOffset(); }
        var show = EDGE.msaaRT.texture;
        if (EDGE.mode && EDGE.mode.acc) {
            var src = EDGE.acc[EDGE.accIdx], dst = EDGE.acc[1 - EDGE.accIdx];
            EDGE.mixMat.uniforms.tAcc.value = src.texture;
            EDGE.mixMat.uniforms.tCur.value = EDGE.msaaRT.texture;
            EDGE.mixMat.uniforms.uW.value = 1 / (EDGE.k + 1);          // running mean; k = 0 restarts it
            EDGE.quad.material = EDGE.mixMat;
            renderer.setRenderTarget(dst);
            EDGE.orig(EDGE.qScene, EDGE.qCam);
            EDGE.accIdx = 1 - EDGE.accIdx;
            show = dst.texture;
            EDGE.k++;
        }
        EDGE.copyMat.map = show; EDGE.copyMat.needsUpdate = true;
        EDGE.quad.material = EDGE.copyMat;
        renderer.setRenderTarget(null);
        EDGE.orig(EDGE.qScene, EDGE.qCam);
    }

    // Accumulation AA: 1 sample per frame into an sRGB-encoded RGBA8 target
    // with 24-bit depth + stencil, each frame added at 1/N into one RGBA16F
    // accumulator, shown from k >= 8 scaled by N/k. Blending happens on the
    // encoded values like the canvas' own MSAA resolve.
    // Test only: whole frame instead of the case's screen box, own rAF chain instead of the host's.
    function liteSize() {
        var sz = new THREE.Vector2(); renderer.getDrawingBufferSize(sz);
        if (!EDGE.lf || EDGE.lf.width !== sz.x || EDGE.lf.height !== sz.y) {
            [EDGE.lf, EDGE.la].forEach(function (t) { if (t) { t.dispose(); } });
            EDGE.lf = new THREE.WebGLRenderTarget(sz.x, sz.y, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
                encoding: THREE.sRGBEncoding, depthBuffer: true, stencilBuffer: true,
                minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
            EDGE.la = new THREE.WebGLRenderTarget(sz.x, sz.y, { format: THREE.RGBAFormat, type: THREE.HalfFloatType,
                depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        }
        if (!EDGE.addMat) {
            var vs = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
            EDGE.addMat = new THREE.ShaderMaterial({
                uniforms: { tCur: { value: null }, uW: { value: 1 } }, vertexShader: vs,
                fragmentShader: 'uniform sampler2D tCur; uniform float uW; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tCur, vUv) * uW; }',
                blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
                depthTest: false, depthWrite: false
            });
            EDGE.showMat = new THREE.ShaderMaterial({
                uniforms: { tAcc: { value: null }, uS: { value: 1 } }, vertexShader: vs,
                fragmentShader: 'uniform sampler2D tAcc; uniform float uS; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tAcc, vUv) * uS; }',
                blending: THREE.NoBlending, depthTest: false, depthWrite: false
            });
        }
        return sz;
    }

    function liteFrame() {
        var sz = liteSize(), cam = EDGE.cam, i = EDGE.k + 1, autoClear = renderer.autoClear;
        try {
            if (cam.setViewOffset) { cam.setViewOffset(sz.x, sz.y, halton(i, 2) - 0.5, halton(i, 3) - 0.5, sz.x, sz.y); }
            renderer.setRenderTarget(EDGE.lf);
            EDGE.orig(EDGE.sc, cam);
        } finally {
            if (cam.clearViewOffset) { cam.clearViewOffset(); }
        }
        try {
            renderer.setRenderTarget(EDGE.la);
            if (EDGE.k === 0) {
                var cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
                renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false); renderer.setClearColor(cc, ca);
            }
            renderer.autoClear = false;
            EDGE.addMat.uniforms.tCur.value = EDGE.lf.texture; EDGE.addMat.uniforms.uW.value = 1 / EDGE.N;
            EDGE.quad.material = EDGE.addMat;
            EDGE.orig(EDGE.qScene, EDGE.qCam);
        } finally {
            renderer.autoClear = autoClear;
        }
        EDGE.k++;
        if (EDGE.k >= 8) {
            EDGE.showMat.uniforms.tAcc.value = EDGE.la.texture; EDGE.showMat.uniforms.uS.value = EDGE.N / EDGE.k;
            EDGE.quad.material = EDGE.showMat;
            renderer.setRenderTarget(null);
            EDGE.orig(EDGE.qScene, EDGE.qCam);
        }
        renderer.setRenderTarget(null);
    }

    // after the host stops drawing for 150 ms: up to N jittered frames, 2 per animation frame
    function edgeAccumulate() {
        if (EDGE.raf) { return; }
        var step = function () {
            EDGE.raf = 0;
            var m = EDGE.mode;
            if (!m || !m.acc || !EDGE.sc) { return; }
            if (performance.now() - EDGE.lastHost < 150) { EDGE.raf = requestAnimationFrame(step); return; }
            for (var n = 0; n < 2 && EDGE.k < EDGE.N; n++) { if (m.lite) { liteFrame(); } else { edgeFrame(true); } }
            if (EDGE.k < EDGE.N) { EDGE.raf = requestAnimationFrame(step); }
        };
        EDGE.raf = requestAnimationFrame(step);
    }

    function edgeApply() {
        var n = edgeList ? edgeList.length : EDGE_MODES.length, pos = edgeStep % n;
        var m = EDGE_MODES[edgeList ? edgeList[pos] : pos];
        if (M) { Object.keys(M).forEach(function (k) { if (k.indexOf('mat') === 0) { grazePatch(M[k]); } }); }
        GRAZE.value = m.graze; GRAZE_HARD.value = m.hard;
        edgeInstall();
        EDGE.mode = m; EDGE.k = 0;
        lightTestIndicator('Edge test ' + (pos + 1) + '/' + n + ': ' + m.label
            + (m.lite ? ' \u2013 1 Sample \u00d7 ' + EDGE.N + ' frames'
                : m.msaa ? ' \u2013 ' + EDGE.samples + ' Samples' + (m.acc ? ' \u00d7 ' + EDGE.N + ' frames' : '') : ''));
        try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { lightTestIndicator('Edge test: error ' + e.message); }
    }

    function edgeTest(seconds, list) {
        if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; }
        edgeList = Array.isArray(list) && list.length ? list : null;
        if (!seconds || seconds <= 0) {
            GRAZE.value = 0; GRAZE_HARD.value = 0; EDGE.mode = null;
            lightTestIndicator(null);
            try { if (renderer && scene && camera) { renderer.render(scene, camera); } } catch (e) { /* ignore */ }
            return;
        }
        edgeStep = 0;
        var tick = function () {
            if (!M || !M.meshes) { lightTestIndicator('Edge test: waiting for a case'); return; }
            try { edgeApply(); } catch (e) { lightTestIndicator('Edge test: error ' + e.message); }
            edgeStep++;
        };
        tick();
        edgeTimer = setInterval(tick, seconds * 1000);
    }

    function lightTestFromStorage() {
        var s = 0, r = 0, gr = 0;
        try {
            s = parseFloat(localStorage.getItem('ArtworkPlusLightTest')) || 0;
            r = parseFloat(localStorage.getItem('ArtworkPlusRimTest')) || 0;
            gr = parseFloat(localStorage.getItem('ArtworkPlusGrooveTest')) || 0;
        } catch (e) { /* no storage */ }
        var aa = 0; try { aa = parseFloat(localStorage.getItem('ArtworkPlusAaTest')) || 0; } catch (e) { /* no storage */ }
        var sm = 0; try { sm = parseFloat(localStorage.getItem('ArtworkPlusSmoothTest')) || 0; } catch (e) { /* no storage */ }
        var ed = 0; try { ed = parseFloat(localStorage.getItem('ArtworkPlusEdgeTest')) || 0; } catch (e) { /* no storage */ }
        if (s > 0) { lightTest(s); } else if (r > 0) { rimTest(r); } else if (gr > 0) { grooveTest(gr); } else if (aa > 0) { aaTest(aa); } else if (sm > 0) { smoothTest(sm); } else if (ed > 0) { edgeTest(ed); }
    }

    window.ArtworkPlusThreejsRenderer = {
        /// The lighting test mode (seconds per phase; 0 = off) - see lightTest above.
        lightTest: lightTest,
        /// The rim light elevation test (seconds per phase; 0 = off).
        rimTest: rimTest,
        /// The groove normals fix (rowuv) toggled live (seconds per phase; 0 = off).
        grooveTest: grooveTest,
        /// The antialiasing test (seconds per mode; 0 = off).
        aaTest: aaTest,
        /// The normal smoothing test (seconds per step; 0 = off).
        smoothTest: smoothTest,
        /// The thin-edge test - grazing fade / multisample AA (seconds per mode; 0 = off).
        edgeTest: edgeTest,
        /// One edge-test mode directly (0 default, 1 grazing fade, 2 MSAA, 3 both), no timer.
        edgeMode: function (i) { if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; } edgeList = null; edgeStep = i; edgeApply(); },
        /// Which groove state is active and whether it reached the current model.
        /// rowuv 80 % on lid + back vs. also on the spine band, alternating (seconds; 0 = off).
        spineTest: spineTest,
        /// Groove triangles per part (rowuv set, the fine set) - which parts HAVE the groove.
        grooveParts: function () {
            var g = groovePrep(); if (!g) { return null; }
            var out = {}; Object.keys(g.G).forEach(function (n) { out[n] = { rowuv: g.G[n].length, fine: g.GF[n].length }; });
            return { parts: out, spineOn: GROOVE_SPINE.on, applied: g.appliedN || null };
        },
        /// Diagnostic: per part, the triangles at the SPINE (x near D.OUT.x0) inside the head /
        /// foot band windows, split by facing up/down (|ny| > 0.5) - which layer can light the spine band edge.
        spineProbe: function (xw) {
            if (!M || !M.orig || !M.D) { return null; }
            var D = M.D, out = {}, X = D.OUT.x0 + (xw || 0.3);
            Object.keys(M.orig).forEach(function (n) {
                var P = M.orig[n], N = M.norm0[n]; if (!P || !N) { return; }
                var r = { all: 0, updown: 0, top: 0, bottom: 0, visible: !!(M.meshes[n] && M.meshes[n].visible) };
                for (var t = 0; t < P.length / 9; t++) {
                    var cx = 0, cy = 0, ny = 0;
                    for (var k = 0; k < 3; k++) { var i = (t * 3 + k) * 3; cx += P[i] / 3; cy += P[i + 1] / 3; ny += N[i + 1] / 3; }
                    if (cx > X) { continue; }
                    var top = cy > D.FC.y1 - 0.1 && cy < D.FC.y1 + 0.2, bot = cy > D.FC.y0 - 0.2 && cy < D.FC.y0 + 0.1;
                    if (!top && !bot) { continue; }
                    r.all++; if (Math.abs(ny) > 0.5) { r.updown++; if (top) { r.top++; } else { r.bottom++; } }
                }
                if (r.all) { out[n] = r; }
            });
            return { spineX: D.OUT.x0, band: [D.FC.y0, D.FC.y1], parts: out };
        },
        grooveInfo: function () { return { state: grooveState, applied: M && M.__groove ? M.__groove.appliedN || null : null, triangles: M && M.__groove ? M.__groove.G.lidBL.length + M.__groove.G.backBL.length : 0 }; },
        /// Hands the module the engine and the parsed meshes, once per page.
        init: function (three, mesh, engine) {
            THREE = three;
            MESH = mesh;
            engine = engine || {};
            if (engine.renderer) { renderer = engine.renderer; }
            if (engine.scene) { scene = engine.scene; }
            if (engine.camera) { camera = perspCam = orthoCam = engine.camera; }
            if (!orbit.target && THREE) { orbit.target = new THREE.Vector3(); }
            bootOnce();
            setupScene();
            procTex = procTex || (THREE ? new THREE.TextureLoader().load(PROC_PNG) : null);
        },
        /// Sets the state the upstream controls write. Values only - the
        /// geometry never reads a control, which is what makes the port
        /// possible in the first place.
        set: function (state) {
            state = state || {};
            if (state.openAngle !== undefined) { openAngle = state.openAngle; }
            if (state.aspectMode !== undefined) { aspectMode = state.aspectMode; }
            if (state.posterAspect !== undefined) { posterAspect = state.posterAspect; }
            if (state.logoMode !== undefined) { logoMode = state.logoMode; }
            if (state.blackCase !== undefined) { blackCase = state.blackCase; }
            if (state.onlyBack !== undefined) { onlyBack = state.onlyBack; }
            if (state.caseColMode !== undefined) { caseColMode = state.caseColMode; }
            if (state.discOn !== undefined) { discOn = state.discOn; }
            if (state.furnOn !== undefined) { furnOn = state.furnOn; }
            if (state.spineShare !== undefined) { spineShare = state.spineShare; }
            if (state.lidFirst !== undefined) { lidFirst = state.lidFirst; }
            if (state.studioOn !== undefined) { studioOn = state.studioOn; }
            if (state.formatOn !== undefined) { formatOn = state.formatOn; }
            if (state.tmdbOn !== undefined) { tmdbOn = state.tmdbOn; }
        },
        /// Builds one shell, cached per name. The depth correction inside is
        /// destructive on the mesh and guarded by a flag upstream, so building
        /// the same shell twice is safe - but it is cached anyway, because a
        /// detail page is rebuilt on every navigation.
        build: function (name, state) {
            this.set(state);
            M = models[name] || (models[name] = buildModel(name));
            discSize = DISC_SIZE[name] !== undefined ? DISC_SIZE[name] : 1.0;   // per-model disc size (upstream's model switch, without its input field)
            return M;
        },
        /// The chain upstream says to take whole: applyAspect ends with
        /// applyLogo (which calls applyFurniture and applyInterior) and with
        /// applyOpen. Calling only parts of it leaves the model in the wrong
        /// place WITHOUT an error, which is why there is no finer-grained
        /// entry point here on purpose.
        fit: function (state) {
            this.set(state);
            applyAspect(aspectMode);
            return M;
        },
        /// The opening angle alone, for the animation - applyOpen is the one
        /// place that may be driven on its own.
        open: function (deg) { openAngle = deg; applyOpen(); return M; },
        /// Called with the case colour whenever it changes, so the host can
        /// repaint the printed wrap (back and spine carry the case colour).
        onCaseColor: function (fn) { onCaseHex = fn; },
        /// The printed pieces the HOST resolves, because only it knows the
        /// item: the studio logo, the movie's clearlogo, and the id the spine
        /// code is drawn from. Each takes null for "there is none", which is a
        /// normal state - the badge column closes the gap where it would have
        /// stood, it does not leave a hole.
        /// Each one re-runs the fit, because that is the chain upstream says
        /// to take whole (applyAspect -> applyLogo -> applyFurniture): placing
        /// a badge on its own leaves the rest of the model where it was.
        setPrint: function (print) {
            print = print || {};
            if (print.studio !== undefined) { setStudio(print.studio); }
            // setDisc keeps the image in currentDisc itself and layoutDisc
            // reads it on every fit, so unlike the spine logo this one needs
            // no help to survive a refit.
            if (print.disc !== undefined) { setDisc(print.disc || null); }
            // The whole back object when there is one: the booklet's ground
            // reads its fanart, and the spine code its tmdb id. A stripped
            // stand-in would have left the booklet on plain black without ever
            // saying why.
            if (print.back !== undefined) { currentBack = print.back || null; }
            else if (print.tmdb !== undefined) {
                currentBack = print.tmdb ? { side: { tmdb: print.tmdb } } : null;
            }
            if (print.poster !== undefined) { currentPoster = print.poster || null; }
            if (print.logo !== undefined) { currentLogo = print.logo || null; }
            if (print.bookletGround !== undefined) { BOOKLET.ground = print.bookletGround; }
            if (print.booklet !== undefined) { bookletOn = !!print.booklet; }
            // Upstream's key guards against repainting an unchanged booklet, and it
            // ends with the value of upstream's poster dropdown. The shim gives that
            // slot the item id, so two films never share a cached booklet.
            if (print.stem !== undefined) { statusEl('postersel').value = print.stem || ''; }
            applyAspect(aspectMode);
            // After the fit, not before: setSpineLogo measures against the
            // FITTED case height, and a logo placed first is placed against
            // the old one.
            if (print.logo !== undefined) { currentSpineLogo = print.logo || null; }
            if (M && M.meshes && M.meshes.spineLogo) { setSpineLogo(currentSpineLogo); }
            // Guarded like the spine logo: a booklet that cannot be painted
            // costs the booklet, never the case.
            try { if (typeof paintBooklet === 'function') { paintBooklet(); } }
            catch (e) { if (M && M.meshes && M.meshes.booklet) { M.meshes.booklet.visible = false; } }
            return M;
        },
        /// The host's wrap painter, which stands in for upstream's paintCover.
        /// applyCaseColour calls it with the hex it just derived, because the
        /// back sheet and the spine strip carry the case colour and live in
        /// that texture - a colour change that repaints only the materials
        /// leaves those two behind.
        onWrap: function (fn) { onRepaintWrap = fn; },
        /// The poster, in upstream's order: analyse, place the logo, colour,
        /// fit, booklet. The order is load-bearing at three of those five steps.
        applyPoster: function (img, state) {
            state = state || {};
            if (state.caseColMode !== undefined) { caseColMode = state.caseColMode; }
            if (state.onlyBack !== undefined) { onlyBack = !!state.onlyBack; }
            currentPoster = img || null;
            if (img && img.naturalWidth) { posterAspect = img.naturalWidth / img.naturalHeight; }
            // keepColour: the artwork changes, the case colour does not.
            // Needed by the host for Extraposter, where the cover cycles
            // through several pictures but the colour must come ONCE from the
            // poster that would have won without it - otherwise the case
            // changes colour with every picture, and disagrees with what the
            // flat card shows during Extraposter's own delay. Everything else
            // here still runs: the aspect, the spine badge and the booklet all
            // belong to the picture that is actually on the cover.
            if (!state.keepColour) {
                try { analysePoster(img); } catch (e) { posterPalette = []; posterSample = null; }
            }
            if (M && M.meshes && M.meshes.spineLogo) {
                spineLogoScale = spineLogoScaleFor(M.name);
                try { setSpineLogo(currentSpineLogo); } catch (e) { /* a badge, not the case */ }
            }
            if (!state.keepColour) {
                try { applyCaseColour(); } catch (e) { /* colour is not worth the case */ }
            }
            applyAspect(aspectMode);
            try { if (typeof paintBooklet === 'function') { paintBooklet(); } } catch (e) { /* ditto */ }
            return M;
        },
        /// What the palette actually produced, so "the colours do not work" can
        /// be answered with a number instead of a look.
        palette: function () {
            return { colours: posterPalette.length, sample: !!posterSample, mode: caseColMode,
                     onlyBack: onlyBack, hex: M ? M.caseHex : null };
        },
        /// The back cover, painted straight into the host's wrap canvas by
        /// upstream's own function. It takes the context as its first argument,
        /// so nothing here has to be adapted: it computes BACK.extra from the
        /// fitted window, has the sheet RECOMPOSED to that height, and draws it
        /// so the bottom edge lands on the rectangle's bottom edge. The clip
        /// inside is a safety net, not the fit.
        /// Scaling a finished sheet by width and clipping the overhang instead
        /// would cut the sheet on one shell, leave a gap on the other, and stretch
        /// it, because the back FACE is fitted while its uv rectangle is not.
        paintBack: function (ctx, bx, by, bw, bh, assets) {
            if (!ctx || !assets || !currentBack || !M || !M.D) { return false; }
            if (assets.font) { BACK.font = assets.font; }
            try { paintBack(ctx, bx, by, bw, bh, assets); return true; }
            catch (e) { return false; }   // a back that cannot be painted costs the back, not the case
        },
        /// What the fit computed, for comparing against upstream by number
        /// rather than by picture: BACK.extra is the whole fit question.
        backFit: function () { return { extra: BACK.extra, S: BACK.S, W: BACK.W, H: BACK.H }; },
        /// The back cover, as a finished canvas the host draws into its wrap.
        /// Upstream paints it into its own cover canvas; here the wrap is
        /// painted on the host's side, so the sheet is handed over instead.
        /// `back` is the sidecar shape the painter expects ({side, img}),
        /// `assets` the bundle of plates.
        backSheet: function (back, assets) {
            if (!back || !assets) { return null; }
            // The typesetter asks BACK.font whether it may use upstream's text face.
            // It is set here rather than by the host poking at a constant.
            if (assets.font) { BACK.font = assets.font; }
            try { return composeBackSheet(back, assets); }
            catch (e) { return null; }   // a back that cannot be painted costs the back, not the case
        },
        /// The model's OWN uv rectangles for front and back, taken from the
        /// model so they follow every fit instead of describing the unfitted
        /// shape.
        uvRects: function () { return M && M.D ? { front: M.D.uvFront, back: M.D.uvBack } : null; },
        state: function () { return { M: M, models: models, status: statusSink, openAngle: openAngle }; }
    };
}());
