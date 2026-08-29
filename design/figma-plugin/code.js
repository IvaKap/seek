/*
 * Seek — the Figma builder.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Every screen in the app, rebuilt from the same numbers the app renders from.
 * Colours are the dark ramp in app/src/styles/tokens.css, spacing is --sp-*,
 * type is the --fs-* scale, and the icons are Lucide geometry at Seek's own
 * stroke arithmetic. Nothing here is eyeballed from a screenshot; when the app
 * changes, the constants below are what has to change with it.
 *
 * Rebuilding is IDEMPOTENT. Each screen is deleted and rebuilt by name, so this
 * can run a hundred times and the page will hold one of each. That is what
 * makes iteration cheap enough to actually iterate.
 *
 * The two hard-won rules, both of which cost an afternoon:
 *
 *   1. resize() RESETS the auto-layout sizing modes. Set FIXED axes, then
 *      resize, then set the HUG axes — in that order, or rows collapse to
 *      nothing and stack on top of each other.
 *   2. A new frame from createFrame() has an OPAQUE WHITE FILL. On a dark
 *      canvas, every container you forget to clear is a white slab.
 */

// ===========================================================================
// tokens — verbatim from app/src/styles/tokens.css, dark block
// ===========================================================================

/* Figma colour variables carry alpha, so the translucent ramp entries keep
   their real value rather than being flattened against an assumed backdrop. */
const RAMP = {
  'bg/window':           ['202024', 1],
  'bg/sidebar':          ['26262c', 1],
  'bg/header':           ['17171a', 1],
  'bg/content':          ['17171a', 1],
  'bg/raised':           ['212126', 1],
  'bg/sunken':           ['121214', 1],
  'bg/hover':            ['ffffff', 0.045],
  'bg/active':           ['ffffff', 0.075],
  'bg/selected':         ['0a84ff', 0.20],
  'text/primary':        ['f4f4f7', 1],
  'text/secondary':      ['ebebf5', 0.60],
  'text/tertiary':       ['ebebf5', 0.38],
  'text/quaternary':     ['ebebf5', 0.26],
  'accent/base':         ['0a84ff', 1],
  'accent/hover':        ['3d9bff', 1],
  'state/warn':          ['ffb340', 1],
  'state/danger':        ['ff6961', 1],
  'state/success':       ['30d158', 1],
  'line/separator':      ['ffffff', 0.085],
  'line/border-control': ['ffffff', 0.16],
};

const SP = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 };
const RAD = { sm: 6, md: 10, lg: 14, pill: 999 };

/* [size, lineHeight, letterSpacing in em, default weight] */
const TYPE = {
  title:   [26, 1.15, -0.021, 'b'],
  section: [19, 1.26, -0.014, 'sb'],
  bodyLg:  [17, 1.45, -0.006, 'r'],
  body:    [15, 1.40, -0.002, 'r'],
  sec:     [13, 1.35,  0,     'r'],
  cap:     [12, 1.33,  0.004, 'r'],
  micro:   [11, 1.27,  0.008, 'r'],
};


/* Bumped whenever this file changes, so `ping` can say whether Figma is running
   the current builder or a stale copy it loaded before the last edit. Without
   it, "I changed that" and "you are looking at an old build" are the same
   symptom, and there is no way to tell them apart from outside. */
const BUILD = 'b3 — svg export command, for icons added by hand in Figma';

const WIN = { w: 1280, h: 840 };   // tauri.conf.json
const SIDEBAR_W = 220;             // --sidebar-w

// ===========================================================================
// plumbing
// ===========================================================================

const say = (message) => figma.ui.postMessage({ type: 'log', message });

const hex = (h) => ({
  r: parseInt(h.slice(0, 2), 16) / 255,
  g: parseInt(h.slice(2, 4), 16) / 255,
  b: parseInt(h.slice(4, 6), 16) / 255,
});

let VARS = {};    // name -> Variable
let FONT = {};    // 'r' | 'm' | 'sb' | 'b'  ->  FontName

/** The colour variables, created on first run and reused after. */
async function ensureVars() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let col = collections.find((c) => c.name === 'Seek dark');
  if (!col) col = figma.variables.createVariableCollection('Seek dark');
  const mode = col.modes[0].modeId;

  const existing = await figma.variables.getLocalVariablesAsync('COLOR');
  for (const [name, [h, a]] of Object.entries(RAMP)) {
    let v = existing.find((x) => x.name === name && x.variableCollectionId === col.id);
    if (!v) v = figma.variables.createVariable(name, col, 'COLOR');
    v.setValueForMode(mode, { ...hex(h), a });
    VARS[name] = v;
  }
}

/**
 * SF Pro, or the closest thing installed.
 *
 * Seek's --font-ui is the system stack, which on macOS is SF. Falling back
 * silently to whatever Figma defaults to would change every measurement on
 * every screen, so an absent SF is reported rather than absorbed.
 */
async function ensureFonts() {
  const all = await figma.listAvailableFontsAsync();
  const styles = new Set(all.filter((f) => f.fontName.family === 'SF Pro').map((f) => f.fontName.style));
  const family = styles.size ? 'SF Pro' : 'Inter';
  const pick = (wanted, fallback) => wanted.find((s) => styles.has(s)) || fallback;

  FONT = family === 'SF Pro'
    ? {
      r: { family, style: pick(['Regular'], 'Regular') },
      m: { family, style: pick(['Medium'], 'Regular') },
      sb: { family, style: pick(['Semibold', 'Semi Bold'], 'Bold') },
      b: { family, style: pick(['Bold'], 'Bold') },
    }
    : {
      r: { family: 'Inter', style: 'Regular' },
      m: { family: 'Inter', style: 'Medium' },
      sb: { family: 'Inter', style: 'Semi Bold' },
      b: { family: 'Inter', style: 'Bold' },
    };

  const seen = new Set();
  for (const f of Object.values(FONT)) {
    const key = `${f.family}|${f.style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await figma.loadFontAsync(f);
  }
  return family;
}

/** A solid paint bound to one of the ramp variables. */
function paint(name) {
  const v = VARS[name];
  if (!v) throw new Error(`no colour variable named ${name}`);
  return figma.variables.setBoundVariableForPaint(
    { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', v,
  );
}

/**
 * Fix a node's size without losing its layout behaviour.
 *
 * resize() resets primaryAxisSizingMode to FIXED, so the HUG axes are asserted
 * AFTER the resize rather than before it. Doing this the intuitive way round
 * collapsed every result row in the first build of the search screen.
 */
function size(n, w, h) {
  if (w != null) n.layoutSizingHorizontal = 'FIXED';
  if (h != null) n.layoutSizingVertical = 'FIXED';
  n.resize(w != null ? w : n.width, h != null ? h : n.height);
  if (w == null && n.layoutMode !== 'NONE') n.layoutSizingHorizontal = 'HUG';
  if (h == null && n.layoutMode !== 'NONE') n.layoutSizingVertical = 'HUG';
}

/**
 * An auto-layout frame.
 *
 * Children may be given as a bare node or as `{ n, fw, fh, grow }`, which is
 * how a child says "fill this axis" — those flags can only be set once the
 * child has a parent, so they are applied here rather than at the call site.
 */
function F(name, o = {}) {
  const n = figma.createFrame();
  n.name = name;
  n.layoutMode = o.dir === 'h' ? 'HORIZONTAL' : 'VERTICAL';
  n.primaryAxisSizingMode = 'AUTO';
  n.counterAxisSizingMode = 'AUTO';
  n.itemSpacing = o.g || 0;

  const p = o.p == null ? 0 : o.p;
  const pad = Array.isArray(p) ? p : [p, p, p, p];
  n.paddingTop = pad[0]; n.paddingRight = pad[1];
  n.paddingBottom = pad[2]; n.paddingLeft = pad[3];

  // Always explicit: an unset fill is white, not nothing.
  n.fills = o.bg ? [paint(o.bg)] : [];
  if (o.r != null) n.cornerRadius = o.r;
  if (o.clip != null) n.clipsContent = o.clip;
  if (o.align) n.counterAxisAlignItems = o.align;       // MIN | CENTER | MAX
  if (o.just) n.primaryAxisAlignItems = o.just;         // MIN | CENTER | MAX | SPACE_BETWEEN
  if (o.wrap) n.layoutWrap = 'WRAP';

  if (o.st) {
    n.strokes = [paint(o.st)];
    n.strokeWeight = o.sw || 1;
    n.strokeAlign = 'INSIDE';
    if (o.stSides) {
      n.strokeTopWeight = o.stSides[0]; n.strokeRightWeight = o.stSides[1];
      n.strokeBottomWeight = o.stSides[2]; n.strokeLeftWeight = o.stSides[3];
    }
  }

  for (const entry of (o.kids || [])) {
    if (!entry) continue;
    const kid = entry.n || entry;
    n.appendChild(kid);
    if (entry.fw) kid.layoutSizingHorizontal = 'FILL';
    if (entry.fh) kid.layoutSizingVertical = 'FILL';
    if (entry.grow) kid.layoutGrow = 1;
  }

  if (o.w != null || o.h != null) size(n, o.w, o.h);
  if (o.op != null) n.opacity = o.op;
  return n;
}

/** A text node on the app's type scale. */
function T(chars, tok = 'body', o = {}) {
  const [fs, lh, tr, dw] = TYPE[tok];
  const t = figma.createText();
  t.fontName = FONT[o.w || dw];
  t.characters = String(chars);
  t.fontSize = fs;
  t.lineHeight = { unit: 'PERCENT', value: lh * 100 };
  t.letterSpacing = { unit: 'PERCENT', value: tr * 100 };
  t.fills = [paint(o.c || 'text/primary')];
  if (o.width) {
    // A hint is a paragraph, so it needs a measure to wrap against. Figma only
    // wraps text that has a fixed width, and only then does HEIGHT autoresize
    // mean "as tall as the wrapping needs".
    t.textAutoResize = 'HEIGHT';
    t.resize(o.width, t.height);
  } else {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
  if (o.upper) t.textCase = 'UPPER';
  t.name = String(chars).slice(0, 40) || 'text';
  return t;
}

// ===========================================================================
// icons — Lucide geometry, lifted verbatim from the copy in app/node_modules
// ===========================================================================

/*
 * Seek uses Lucide (see app/src/icons/index.tsx for why), so these are the
 * same paths the app paints, not lookalikes.
 *
 * THE STROKE ARITHMETIC, which is the whole reason this is not eyeballed:
 * Lucide's stroke-width is in SVG USER UNITS on a 24-unit grid, so rendered at
 * `px` it paints  width x px / 24  actual pixels. To PAINT a given stroke the
 * relationship inverts —  strokeWidth = painted x 24 / px  — which is exactly
 * what strokeFor() does in the app. Hardcoding one number cannot hold optical
 * weight constant across two sizes; deriving it can.
 */
const PAINTED = 1.6;   // --icon stroke, the app's PAINTED_STROKE

const ICONS = {
  'radio': "<path d=\"M4.9 19.1C1 15.2 1 8.8 4.9 4.9\"/><path d=\"M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><path d=\"M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5\"/><path d=\"M19.1 4.9C23 8.8 23 15.1 19.1 19\"/>",
  'alert-triangle': "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/><path d=\"M12 9v4\"/><path d=\"M12 17h.01\"/>",
  'bookmark': "<path d=\"m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z\"/>",
  'tag': "<path d=\"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>",
  'search': "<circle cx=\"11\" cy=\"11\" r=\"8\"/><path d=\"m21 21-4.3-4.3\"/>",
  'download': "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><polyline points=\"7 10 12 15 17 10\"/><line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\"/>",
  'library': "<path d=\"m16 6 4 14\"/><path d=\"M12 6v14\"/><path d=\"M8 8v12\"/><path d=\"M4 4v16\"/>",
  'folder': "<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>",
  'arrow-up': "<path d=\"m5 12 7-7 7 7\"/><path d=\"M12 19V5\"/>",
  'arrow-down-up': "<path d=\"m3 16 4 4 4-4\"/><path d=\"M7 20V4\"/><path d=\"m21 8-4-4-4 4\"/><path d=\"M17 4v16\"/>",
  'star': "<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\"/>",
  'message-square': "<path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/>",
  'users': "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/>",
  'user': "<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/>",
  'settings': "<path d=\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  'inbox': "<polyline points=\"22 12 16 12 14 15 10 15 8 12 2 12\"/><path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"/>",
  'chevron-down': "<path d=\"m6 9 6 6 6-6\"/>",
  'chevron-right': "<path d=\"m9 18 6-6-6-6\"/>",
  'sliders-horizontal': "<line x1=\"21\" x2=\"14\" y1=\"4\" y2=\"4\"/><line x1=\"10\" x2=\"3\" y1=\"4\" y2=\"4\"/><line x1=\"21\" x2=\"12\" y1=\"12\" y2=\"12\"/><line x1=\"8\" x2=\"3\" y1=\"12\" y2=\"12\"/><line x1=\"21\" x2=\"16\" y1=\"20\" y2=\"20\"/><line x1=\"12\" x2=\"3\" y1=\"20\" y2=\"20\"/><line x1=\"14\" x2=\"14\" y1=\"2\" y2=\"6\"/><line x1=\"8\" x2=\"8\" y1=\"10\" y2=\"14\"/><line x1=\"16\" x2=\"16\" y1=\"18\" y2=\"22\"/>",
  'plus': "<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>",
  'check': "<path d=\"M20 6 9 17l-5-5\"/>",
  'x': "<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>",
  'triangle-alert': "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/><path d=\"M12 9v4\"/><path d=\"M12 17h.01\"/>",
  'zap': "<path d=\"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z\"/>",
  'link-2': "<path d=\"M9 17H7A5 5 0 0 1 7 7h2\"/><path d=\"M15 7h2a5 5 0 1 1 0 10h-2\"/><line x1=\"8\" x2=\"16\" y1=\"12\" y2=\"12\"/>",
  'folder-open': "<path d=\"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2\"/>",
  'trash-2': "<path d=\"M3 6h18\"/><path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/><path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/><line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\"/><line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\"/>",
  'rotate-cw': "<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/>",
  'list-filter': "<path d=\"M3 6h18\"/><path d=\"M7 12h10\"/><path d=\"M10 18h4\"/>",
  'clock': "<circle cx=\"12\" cy=\"12\" r=\"10\"/><polyline points=\"12 6 12 12 16 14\"/>",
  'globe': "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"/><path d=\"M2 12h20\"/>",
  'hard-drive': "<line x1=\"22\" x2=\"2\" y1=\"12\" y2=\"12\"/><path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"/><line x1=\"6\" x2=\"6.01\" y1=\"16\" y2=\"16\"/><line x1=\"10\" x2=\"10.01\" y1=\"16\" y2=\"16\"/>",
  'music-4': "<path d=\"M9 18V5l12-2v13\"/><path d=\"m9 9 12-2\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><circle cx=\"18\" cy=\"16\" r=\"3\"/>",
  'info': "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 16v-4\"/><path d=\"M12 8h.01\"/>",
  'disc-3': "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M6 12c0-1.7.7-3.2 1.8-4.2\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><path d=\"M18 12c0 1.7-.7 3.2-1.8 4.2\"/>",
  'circle': "<circle cx=\"12\" cy=\"12\" r=\"10\"/>",
};

/** One icon, as a frame of vectors at the app's painted stroke weight. */
function I(name, px = 16, colour = 'text/primary', painted = PAINTED) {
  const body = ICONS[name];
  if (!body) throw new Error(`no icon named ${name}`);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px
    + '" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="' + (painted * 24) / px
    + '" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';

  const node = figma.createNodeFromSvg(svg);
  node.name = 'icon/' + name;
  node.fills = [];
  const col = paint(colour);
  for (const v of node.findAll(() => true)) {
    // Lucide is stroke-only; any fill the importer invents would be a blob.
    if ('fills' in v) v.fills = [];
    if ('strokes' in v && v.strokes.length) v.strokes = [col];
  }
  return node;
}

// ===========================================================================
// the sidebar — built once as a component, instanced by every screen
// ===========================================================================

/* Mirrors the `groups` array in app/src/ui/Sidebar.tsx, including which items
   carry a shortcut and which carry a count. The badge numbers are stand-ins,
   but WHICH items can show one is not — a badge appears exactly where the app
   passes one, so the layout is exercised in the right places. */
const NAV = [
  [null, [
    ['Search', 'search', '⌘1', null],
  ]],
  ['Library', [
    ['Downloads', 'download', '⌘2', 3],
    ['Completed', 'library', '⌘3', null],
    ['Failed', 'folder', null, null],
    ['Uploads', 'arrow-up', null, 2],
    ['Statistics', 'arrow-down-up', null, null],
  ]],
  ['Discovery', [
    ['Library', 'library', null, null],
    ['Want List', 'star', '⌘8', 7],
    ['Dig Sessions', 'folder', '⌘9', null],
    ['Labels', 'library', null, null],
    ['Wishlist', 'search', null, null],
    ['Search History', 'search', null, null],
    ['Saved Searches', 'library', null, null],
  ]],
  ['Users', [
    ['Followed', 'users', null, null],
    ['Chat rooms', 'message-square', '⌘5', 4],
    ['Private chats', 'users', '⌘6', 1],
    ['Browse', 'user', null, null],
  ]],
];

const NAV_W = SIDEBAR_W - 20;   // .sidebar__items inside the rail's 10px gutter

/** One nav row. The selected look is applied per instance, never here. */
function navRow(label, iconName, shortcut, badge) {
  const kids = [I(iconName, 16, 'text/primary')];
  kids.push({ n: T(label, 'body'), grow: 1 });
  if (badge != null) {
    kids.push(F(`badge ${badge}`, {
      dir: 'h', p: [1, 5, 1, 5], r: RAD.pill, bg: 'accent/base', align: 'CENTER',
      kids: [T(String(badge), 'micro', { c: 'text/primary' })],
    }));
  } else if (shortcut) {
    kids.push(T(shortcut, 'micro', { c: 'text/quaternary' }));
  }
  return F(`nav: ${label}`, {
    dir: 'h', g: SP[3], p: [0, SP[3], 0, SP[3]], r: RAD.sm,
    align: 'CENTER', w: NAV_W, h: 32, kids,
  });
}

/** The rail, as a reusable component. Nothing in it is selected. */
function buildSidebarComponent() {
  const groups = NAV.map(([title, items]) => F(`group: ${title || 'top'}`, {
    g: 0, w: NAV_W,
    kids: [
      title && F(`section: ${title}`, {
        dir: 'h', g: SP[1], p: [0, SP[3], 0, SP[2]], align: 'CENTER', w: NAV_W, h: 26,
        kids: [
          I('chevron-down', 12, 'text/tertiary', 1.7),
          T(title, 'micro', { c: 'text/tertiary', w: 'm', upper: true }),
        ],
      }),
      ...items.map(([l, i, s, b]) => navRow(l, i, s, b)),
    ],
  }));

  const rail = F('Sidebar', {
    g: 0, w: SIDEBAR_W, h: WIN.h, bg: 'bg/sidebar',
    st: 'line/separator', sw: 0.5, stSides: [0, 0.5, 0, 0],
    p: [SP[6], 10, 0, 10],
    kids: [
      F('brand', {
        p: [SP[2], SP[2], SP[5], SP[2]], w: NAV_W,
        kids: [T('Seek', 'body', { w: 'sb' })],
      }),
      ...groups.flatMap((g, i) => (i === 0 ? [g] : [F('gap', { w: 1, h: SP[3] }), g])),
      // .sidebar__spacer — flex:1, which is layoutGrow here.
      { n: F('spacer', { w: NAV_W, h: 1 }), grow: 1 },
      navRow('Settings', 'settings', '⌘4', null),
      F('status', {
        g: SP[1], w: NAV_W, p: [SP[2], SP[2], SP[3], SP[2]],
        st: 'line/separator', sw: 0.5, stSides: [0.5, 0, 0, 0],
        kids: [
          F('conn', {
            dir: 'h', g: SP[2], align: 'CENTER',
            kids: [dot('state/success'), T('Signed in', 'micro', { c: 'text/tertiary' })],
          }),
          F('rate', {
            dir: 'h', g: SP[3], align: 'CENTER', p: [0, 0, 0, 15],
            kids: [
              T('↓ 4.2 MB/s', 'micro', { c: 'text/tertiary' }),
              T('↑ 180 KB/s', 'micro', { c: 'text/quaternary' }),
            ],
          }),
        ],
      }),
    ],
  });

  const comp = figma.createComponentFromNode(rail);
  comp.name = 'Sidebar';
  comp.description = 'app/src/ui/Sidebar.tsx — one row per Section in `groups`. '
    + 'Select a row on the INSTANCE, not here.';
  // createComponentFromNode preserves the frame's own size, but the sizing
  // modes have to be re-asserted after it or the rail hugs its content.
  size(comp, SIDEBAR_W, WIN.h);
  return comp;
}

/** The 7px connection light. */
function dot(colour) {
  const e = figma.createEllipse();
  e.name = 'status-dot';
  e.resize(7, 7);
  e.fills = [paint(colour)];
  return e;
}

/**
 * Mark one row of a sidebar INSTANCE as the current section.
 *
 * `.nav-item[aria-current='page']` is three changes at once — a selected
 * background, the accent colour, and medium weight — and doing only the first
 * reads as a hover state rather than a location.
 */
function selectNav(instance, label) {
  const row = instance.findOne((n) => n.name === `nav: ${label}`);
  if (!row) { say(`! no nav row called "${label}"`); return; }
  row.fills = [paint('bg/selected')];
  for (const kid of row.children) {
    if (kid.type === 'TEXT' && kid.characters === label) {
      kid.fills = [paint('accent/base')];
      kid.fontName = FONT.m;
    }
    if (kid.name.startsWith('icon/')) {
      for (const v of kid.findAll(() => true)) {
        if ('strokes' in v && v.strokes.length) v.strokes = [paint('accent/base')];
      }
    }
  }
}

// ===========================================================================
// the pieces every screen is made of
// ===========================================================================

/** `.header--plain` — a title, an optional subtitle, and tools on the right. */
function paneHeader(title, subtitle, tools) {
  const heading = F('heading', {
    g: 0, kids: [
      T(title, 'title'),
      subtitle && T(subtitle, 'sec', { c: 'text/secondary' }),
    ],
  });
  return F('Header', {
    dir: 'h', g: SP[4], p: [SP[6], SP[6], SP[4], SP[6]], just: 'SPACE_BETWEEN',
    w: WIN.w - SIDEBAR_W,
    kids: [{ n: heading, grow: 1 }, tools && F('tools', { dir: 'h', g: SP[2], align: 'CENTER', kids: tools })],
  });
}

function btn(label, o = {}) {
  return F(`btn/${label}`, {
    dir: 'h', g: SP[2], p: [0, SP[3], 0, SP[3]], r: RAD.sm, align: 'CENTER', h: 28,
    bg: o.primary ? 'accent/base' : 'bg/raised',
    st: o.primary ? null : 'line/border-control', sw: o.primary ? 0 : 1,
    kids: [
      o.icon && I(o.icon, 14, o.primary ? 'text/primary' : 'text/secondary'),
      T(label, 'sec', { c: o.primary ? 'text/primary' : 'text/primary' }),
    ],
  });
}

function input(placeholder, w = 220) {
  return F(`input/${placeholder}`, {
    dir: 'h', g: SP[2], p: [0, SP[3], 0, SP[3]], r: RAD.sm, align: 'CENTER', h: 28, w,
    bg: 'bg/sunken', st: 'line/border-control', sw: 1,
    kids: [T(placeholder, 'sec', { c: 'text/tertiary' })],
  });
}

/** The segmented control used for grouping and for the settings tabs. */
function segmented(options, activeIndex) {
  return F('segmented', {
    dir: 'h', g: 2, p: 2, r: RAD.sm, bg: 'bg/sunken', align: 'CENTER',
    kids: options.map((label, i) => F(`seg/${label}`, {
      dir: 'h', p: [0, SP[3], 0, SP[3]], r: 4, align: 'CENTER', h: 24,
      bg: i === activeIndex ? 'bg/raised' : null,
      kids: [T(label, 'cap', {
        c: i === activeIndex ? 'text/primary' : 'text/secondary',
        w: i === activeIndex ? 'm' : 'r',
      })],
    })),
  });
}

/** `.empty` — icon, title, one sentence, and sometimes a way out. */
function emptyState(iconName, title, body, action) {
  return F('empty', {
    g: SP[2], p: [SP[12], SP[6], SP[12], SP[6]], align: 'CENTER', w: WIN.w - SIDEBAR_W,
    kids: [
      F('empty__icon', { p: [0, 0, SP[2], 0], kids: [I(iconName, 28, 'text/quaternary', 1.3)] }),
      T(title, 'bodyLg', { c: 'text/secondary', w: 'm' }),
      T(body, 'sec', { c: 'text/tertiary' }),
      action && F('gap', { w: 1, h: SP[2] }),
      action,
    ],
  });
}

/** A square of cover art, or the placeholder that stands in for one. */
function art(px, radius = RAD.sm) {
  return F('art', {
    w: px, h: px, r: radius, bg: 'bg/sunken', align: 'CENTER', just: 'CENTER',
    kids: [I('disc-3', Math.round(px * 0.42), 'text/quaternary', 1.3)],
  });
}

/** A metadata line: caption text separated by the app's middle dots. */
function meta(parts) {
  const kids = [];
  parts.filter(Boolean).forEach((p, i) => {
    if (i > 0) kids.push(T('·', 'cap', { c: 'text/quaternary' }));
    kids.push(typeof p === 'string' ? T(p, 'cap', { c: 'text/secondary' }) : p);
  });
  return F('meta', { dir: 'h', g: SP[2], align: 'CENTER', kids });
}

/**
 * A download, at comfortable density — `.dl` in components.css.
 *
 * PRODUCT.md §7: a download is an object with one progress bar, not a table of
 * transfer rows, so the release is the row and the files are behind expansion.
 */
function dlRow(o) {
  const flags = [];
  if (o.flag) {
    flags.push(T(o.flag, 'cap', { c: o.flagBad ? 'state/danger' : 'text/secondary' }));
  }
  const card = F(`dl/${o.title}`, {
    g: 0, w: (WIN.w - SIDEBAR_W) - SP[4] * 2, r: RAD.md, bg: 'bg/raised',
    st: 'line/separator', sw: 1, clip: true,
    kids: [
      /* FILL, not hug. A hugging row lets its growing child size to content
         instead of to the card, so the metadata line overflowed the card and
         `clip` swallowed the end of it — the speed lost its units and the eta
         vanished entirely. layoutGrow on a child only means anything once its
         parent actually spans the width. */
      { fw: true, n: F('hit', {
        /* Roomier than the other lists on purpose. A download is the one row
           you come back to and watch, so it gets --sp-4 and a larger cover
           where a result row makes do with --sp-3. Asked for on the Figma
           comment "make this row taller". */
        dir: 'h', g: SP[3], p: SP[4], align: 'CENTER',
        kids: [
          art(48),
          {
            n: F('main', {
              g: SP[1],
              kids: [
                T(o.title, 'bodyLg'),
                meta([o.who, o.files, o.size, o.speed, o.eta, ...flags]),
              ],
            }),
            grow: 1,
          },
          T(o.pct == null ? '' : `${o.pct}%`, 'sec', { c: 'text/secondary' }),
          I('chevron-down', 14, 'text/tertiary', 1.5),
        ],
      }) },
    ],
  });

  // The progress rail is full-bleed at the card's foot, so it is a sibling of
  // the hit area rather than something inside its padding.
  const railW = (WIN.w - SIDEBAR_W) - SP[4] * 2;
  const fillW = Math.max(0, Math.min(railW, Math.round((railW * (o.pct || 0)) / 100)));
  const rail = F('prog', {
    dir: 'h', g: 0, w: railW, h: 3, bg: 'bg/sunken',
    kids: [F('prog__fill', { w: fillW, h: 3, bg: o.tone || 'accent/base' })],
  });
  card.appendChild(rail);
  return card;
}

// ===========================================================================
// screen scaffolding
// ===========================================================================

let SIDEBAR = null;   // the component, built once per run

/** A whole app window: the rail on the left, one pane on the right. */
function screen(name, navLabel, kids) {
  const rail = SIDEBAR.createInstance();
  const main = F('Main', {
    g: 0, w: WIN.w - SIDEBAR_W, h: WIN.h, bg: 'bg/content', clip: true, kids,
  });
  const frame = F(name, {
    dir: 'h', g: 0, w: WIN.w, h: WIN.h, bg: 'bg/content', clip: true,
    kids: [rail, main],
  });
  selectNav(rail, navLabel);
  return frame;
}

/** The scrolling body under a header. */
function body(kids, o = {}) {
  return F('Body', {
    g: o.g == null ? SP[3] : o.g, p: o.p == null ? SP[4] : o.p,
    w: WIN.w - SIDEBAR_W, kids,
  });
}

// ===========================================================================
// the screens
// ===========================================================================

/* Placement order on the Screens page. Index decides where a frame lands, so
   a screen keeps its spot whether it is rebuilt alone or with everything. */
const ORDER = [
  'search', 'downloads', 'completed', 'failed',
  'uploads', 'statistics', 'library', 'want',
  'sessions', 'labels', 'wishlist', 'history',
  'saved', 'followed', 'chat', 'messages',
  'browse', 'settings-account', 'settings-folders', 'settings-downloads',
  'settings-network', 'settings-lookups', 'settings-about',
];
const COLS = 4;
const GAP_X = 120;
const GAP_Y = 160;

const SCREENS = {};

/* The frame name each key produces. Needed BEFORE building, to find a screen
   already on the page and check whether it has been touched. */
const SCREEN_NAMES = {
  search: 'Search', downloads: 'Downloads', completed: 'Completed', failed: 'Failed',
  uploads: 'Uploads', statistics: 'Statistics', library: 'Library', want: 'Want List',
  sessions: 'Dig Sessions', labels: 'Labels', wishlist: 'Wishlist',
  history: 'Search History', saved: 'Saved Searches', followed: 'Followed',
  chat: 'Chat rooms', messages: 'Private chats', browse: 'Browse',
  'settings-account': 'Settings — Account', 'settings-folders': 'Settings — Folders',
  'settings-downloads': 'Settings — Downloads', 'settings-network': 'Settings — Network',
  'settings-lookups': 'Settings — Lookups', 'settings-about': 'Settings — About',
};


// --- Downloads -------------------------------------------------------------

SCREENS.downloads = () => screen('Downloads', 'Downloads', [
  paneHeader('Downloads', '6 releases · 74 files · 3.24 GB', [
    input('Filter these…', 200),
    btn('View', { icon: 'sliders-horizontal' }),
  ]),
  body([
    dlRow({
      title: 'Burial — Untrue', who: 'a-peer', files: '8 of 12 files',
      size: '412 MB', speed: '↓ 2.4 MB/s', eta: '3m left', pct: 68,
    }),
    dlRow({
      title: 'Actress — Splazsh', who: 'another-peer', files: '3 of 11 files',
      size: '286 MB', speed: '↓ 840 KB/s', eta: '6m left', pct: 27,
    }),
    dlRow({
      title: 'Shackleton — Blood On My Hands', who: 'a-third-peer',
      files: '0 of 4 files', size: '96 MB', flag: 'queued · place 14', pct: 0,
    }),
    dlRow({
      title: 'DJ Rolando — Knights Of The Jaguar', who: 'someone-else',
      files: '2 of 3 files', size: '54 MB', flag: 'no movement for 34 minutes',
      flagBad: true, pct: 61, tone: 'text/tertiary',
    }),
  ]),
]);

// --- Completed -------------------------------------------------------------

SCREENS.completed = () => screen('Completed', 'Completed', [
  paneHeader('Completed', '24 releases · 291 files · 11.4 GB', [
    input('Filter these…', 200),
    btn('View', { icon: 'sliders-horizontal' }),
  ]),
  body([
    dlRow({ title: 'Basic Channel — BCD', who: 'a-peer', files: '10 files', size: '620 MB', flag: 'lossless · verified', pct: 100, tone: 'state/success' }),
    dlRow({ title: 'Rhythm & Sound — w/ The Artists', who: 'another-peer', files: '12 files', size: '710 MB', flag: 'lossless · verified', pct: 100, tone: 'state/success' }),
    dlRow({ title: 'Theo Parrish — Sound Sculptures Vol. 1', who: 'a-third-peer', files: '9 files', size: '502 MB', flag: 'transcode suspected', flagBad: true, pct: 100, tone: 'state/success' }),
    dlRow({ title: 'Moodymann — Silentintroduction', who: 'someone-else', files: '11 files', size: '588 MB', flag: 'not checked', pct: 100, tone: 'state/success' }),
  ]),
]);

// --- Failed ----------------------------------------------------------------

/**
 * The grid density, which exists for exactly this screen.
 *
 * A failed pile is picked through by eye — you are looking for the record you
 * still want, not reading a progress number — so the cover is the row. While a
 * download is RUNNING the useful facts are speed and progress and a cover says
 * neither, which is why 'active' does not offer this density at all.
 */
function failedCard(title, who, reason, w) {
  return F(`card/${title}`, {
    g: 0, w, r: RAD.md, bg: 'bg/raised', st: 'line/separator', sw: 1, clip: true,
    kids: [
      F('cover', { w, h: w, bg: 'bg/sunken', align: 'CENTER', just: 'CENTER',
        kids: [I('disc-3', Math.round(w * 0.3), 'text/quaternary', 1.3)] }),
      F('foot', {
        g: SP[1], p: SP[3], w,
        kids: [
          T(title, 'sec', { w: 'm' }),
          T(who, 'cap', { c: 'text/secondary' }),
          T(reason, 'cap', { c: 'state/danger' }),
        ],
      }),
    ],
  });
}

SCREENS.failed = () => {
  const inner = (WIN.w - SIDEBAR_W) - SP[4] * 2;
  const cardW = Math.floor((inner - SP[3] * 3) / 4);
  const cards = [
    ['Jai Paul — Leak 04-13', 'a-peer', 'peer went offline'],
    ['Pearson Sound — Untitled', 'another-peer', 'cancelled'],
    ['Peverelist — Jarvik Mindstate', 'a-third-peer', 'no movement for 2 hours'],
    ['Zomby — Where Were U in 92', 'someone-else', 'file not shared any more'],
    ['Kode9 — Memories of the Future', 'a-fifth-peer', 'connection refused'],
    ['Loefah — Mud', 'a-sixth-peer', 'peer went offline'],
  ].map(([t, w, r]) => failedCard(t, w, r, cardW));

  return screen('Failed', 'Failed', [
    paneHeader('Failed', '6 releases · 41 files · 1.8 GB', [
      input('Filter by release or peer…', 220),
      btn('Retry all', { icon: 'rotate-cw' }),
      btn('View', { icon: 'sliders-horizontal' }),
    ]),
    body([F('grid', { dir: 'h', g: SP[3], wrap: true, w: inner, kids: cards })]),
  ]);
};

// --- Uploads ---------------------------------------------------------------

function upCard(who, title, facts, files) {
  const w = (WIN.w - SIDEBAR_W) - SP[4] * 2;
  return F(`up/${title}`, {
    g: SP[2], p: SP[3], w, r: RAD.md, bg: 'bg/raised', st: 'line/separator', sw: 1,
    kids: [
      F('head', {
        dir: 'h', g: SP[2], align: 'CENTER', w: w - SP[3] * 2,
        kids: [
          I('user', 14, 'text/secondary'),
          T(who, 'sec', { w: 'm' }),
          { n: T(title, 'sec', { c: 'text/secondary' }), grow: 1 },
          T(facts, 'cap', { c: 'text/tertiary' }),
        ],
      }),
      ...files.map(([name, sz, state]) => F(`file/${name}`, {
        dir: 'h', g: SP[3], align: 'CENTER', w: w - SP[3] * 2,
        kids: [
          { n: T(name, 'cap', { c: 'text/secondary' }), grow: 1 },
          T(sz, 'cap', { c: 'text/tertiary' }),
          T(state, 'cap', { c: state === 'sent' ? 'state/success' : 'text/tertiary' }),
        ],
      })),
    ],
  });
}

SCREENS.uploads = () => screen('Uploads', 'Uploads', [
  paneHeader('Uploads', '3 peers · 5 files · 214 MB sent', null),
  body([
    upCard('a-peer', 'Basic Channel — BCD', '↑ 1.1 MB/s', [
      ['01 Phylyps Trak.flac', '38 MB', 'sent'],
      ['02 Q 1.1.flac', '41 MB', '62%'],
    ]),
    upCard('another-peer', 'Maurizio — M-Series', '↑ 480 KB/s', [
      ['M4.5.flac', '52 MB', '18%'],
    ]),
    upCard('a-third-peer', 'Various — Chain Reaction', 'queued', [
      ['CR-020.flac', '44 MB', 'queued'],
      ['CR-021.flac', '39 MB', 'queued'],
    ]),
  ]),
]);

// ===========================================================================
// the page, and putting things on it
// ===========================================================================

const PAGE = 'Screens';
/* The canvas behind the frames. Figma's default is a light grey, which fights
   every dark screen sitting on it. */
const CANVAS = { r: 0x0d / 255, g: 0x0d / 255, b: 0x0f / 255 };

async function screensPage() {
  let page = figma.root.children.find((p) => p.name === PAGE);
  if (!page) { page = figma.createPage(); page.name = PAGE; }
  await page.loadAsync();
  page.backgrounds = [{ type: 'SOLID', color: CANVAS }];
  if (figma.currentPage !== page) await figma.setCurrentPageAsync(page);
  return page;
}


/**
 * A cheap fingerprint of everything a rebuild would throw away.
 *
 * WHY: `build` REPLACES a screen. Without this, changing an icon by hand in
 * Figma and then asking for an unrelated rebuild would delete that change with
 * no warning and no way to find out what it had been — the single worst
 * failure this tool could have, because it is silent and it destroys work.
 *
 * Three numbers, because between them they catch the three ways a screen gets
 * edited: node count (something added or deleted), total characters (text
 * rewritten), and total vector path length (an ICON swapped, which changes
 * neither of the other two).
 */
function signature(node) {
  let nodes = 0;
  let chars = 0;
  let paths = 0;
  for (const n of node.findAll(() => true)) {
    nodes += 1;
    if (n.type === 'TEXT') chars += n.characters.length;
    if ('vectorPaths' in n && n.vectorPaths) {
      for (const vp of n.vectorPaths) paths += (vp.data || '').length;
    }
  }
  return `${nodes}:${chars}:${paths}`;
}

/** Where a screen lives, decided by its slot in ORDER rather than by run order. */
function placeAt(frame, key) {
  const i = ORDER.indexOf(key);
  const slot = i < 0 ? ORDER.length : i;
  frame.x = (slot % COLS) * (WIN.w + GAP_X);
  frame.y = Math.floor(slot / COLS) * (WIN.h + GAP_Y);
}

/** The rail component, reused across runs so instances never break. */
async function sidebarComponent(page, fresh) {
  const found = page.children.find((n) => n.type === 'COMPONENT' && n.name === 'Sidebar');
  if (found && !fresh) return found;
  if (found) found.remove();
  const comp = buildSidebarComponent();
  page.appendChild(comp);
  // Parked well clear of the grid: a master sitting on top of a screen is
  // indistinguishable from a stray layer, and gets deleted by accident.
  comp.x = -(SIDEBAR_W + 380);
  comp.y = 0;
  return comp;
}

async function exportPng(node, scale = 0.5) {
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
  return { name: node.name.replace(/[^\w.-]+/g, '-').toLowerCase(), b64: figma.base64Encode(bytes) };
}

// ===========================================================================
// jobs
// ===========================================================================

async function run(job) {
  const family = await ensureFonts();
  await ensureVars();
  const page = await screensPage();

  if (job.cmd === 'ping') {
    return {
      note: `ready — ${Object.keys(SCREENS).length} screens registered, type is ${family}`,
      build: BUILD,
      screens: Object.keys(SCREENS),
      onPage: page.children.map((n) => `${n.name} [${n.id}]`),
    };
  }

  if (job.cmd === 'inspect') {
    const node = await figma.getNodeByIdAsync(job.id);
    if (!node) throw new Error(`no node ${job.id}`);
    const walk = (n, d) => ({
      id: n.id, name: n.name, type: n.type,
      w: Math.round(n.width || 0), h: Math.round(n.height || 0),
      kids: d > 0 && 'children' in n ? n.children.map((c) => walk(c, d - 1)) : undefined,
    });
    return { note: 'inspected', tree: walk(node, job.depth == null ? 2 : job.depth) };
  }

  if (job.cmd === 'svg') {
    /* Pull real geometry back OUT of the file. Icons dropped into Figma by hand
       are the one thing the builder cannot generate from the codebase, so this
       is the return path: export them as SVG, and they can be pasted into the
       ICONS table and rendered like any Lucide glyph. */
    const out = {};
    for (const id of job.ids || []) {
      const n = await figma.getNodeByIdAsync(id);
      if (!n) { out[id] = { error: 'no such node' }; continue; }
      out[id] = {
        name: n.name, type: n.type,
        w: Math.round(n.width), h: Math.round(n.height),
        svg: await n.exportAsync({ format: 'SVG_STRING' }),
      };
    }
    return { note: `exported ${Object.keys(out).length}`, svg: out };
  }

  if (job.cmd === 'shoot') {
    const wanted = job.screens || [];
    const shots = [];
    for (const n of page.children) {
      if (n.type !== 'FRAME') continue;
      if (wanted.length && !wanted.includes(n.name)) continue;
      shots.push(await exportPng(n, job.scale == null ? 0.5 : job.scale));
    }
    return { note: `rendered ${shots.length}`, shots };
  }

  if (job.cmd === 'build') {
    const keys = (job.screens && job.screens.length ? job.screens : Object.keys(SCREENS))
      .filter((k) => {
        if (SCREENS[k]) return true;
        say(`! no screen called "${k}"`);
        return false;
      });
    if (keys.length === 0) throw new Error('nothing to build — known screens: ' + Object.keys(SCREENS).join(', '));

    SIDEBAR = await sidebarComponent(page, job.fresh);

    const built = [];
    const kept = [];
    const shots = [];
    for (const key of keys) {
      /* Look BEFORE building: a screen that has been edited by hand is not
         ours to replace. Skipping it and saying so is the only behaviour that
         does not lose work the user cannot get back. `force` overrides, which
         is what you send once the edit has been folded into the builder. */
      const prior = page.children.find((n) => n.name === SCREEN_NAMES[key]);
      if (prior && !job.force) {
        const stamped = prior.getPluginData('seek-sig');
        const actual = signature(prior);
        if (stamped && stamped !== actual) {
          kept.push(SCREEN_NAMES[key]);
          say(`  ! kept ${SCREEN_NAMES[key]} — edited by hand since it was built`);
          continue;
        }
      }

      const frame = SCREENS[key]();
      /* Rebuild means REPLACE. Removing the old one only after the new one has
         been built means a builder that throws leaves the page as it was,
         rather than deleting a screen and putting nothing in its place. */
      const old = page.children.find((n) => n.name === frame.name && n !== frame);
      if (old) old.remove();
      page.appendChild(frame);
      placeAt(frame, key);
      frame.setPluginData('seek-sig', signature(frame));
      built.push(`${frame.name} [${frame.id}]`);
      say(`  built ${frame.name}`);
      if (job.shoot !== false) shots.push(await exportPng(frame, job.scale == null ? 0.5 : job.scale));
    }
    return {
      note: `built ${built.length}${kept.length ? `, kept ${kept.length} edited by hand` : ''}`,
      built,
      keptByHand: kept,
      hint: kept.length
        ? 'Those were changed in Figma since the builder made them. Tell me what changed so it can go into code.js, or resend with "force": true to overwrite.'
        : undefined,
      shots,
    };
  }

  throw new Error(`unknown command "${job.cmd}"`);
}

figma.showUI(__html__, { width: 340, height: 280, title: 'Seek design sync' });

figma.ui.onmessage = async (msg) => {
  if (!msg || msg.type !== 'job') return;
  let result;
  try {
    result = { ok: true, ...(await run(msg.job)) };
  } catch (err) {
    /* The stack matters more than the message: these builders are 300 lines of
       node construction and "cannot read property x of undefined" without a
       line number is a scavenger hunt. */
    result = { ok: false, error: String((err && err.message) || err), stack: String((err && err.stack) || '') };
  }
  figma.ui.postMessage({ type: 'result', result });
};

// --- Statistics ------------------------------------------------------------

const PANE_W = WIN.w - SIDEBAR_W;
const INNER = PANE_W - SP[4] * 2;

function statTile(label, value, sub) {
  return F(`stat/${label}`, {
    g: SP[1], p: SP[4], r: RAD.md, bg: 'bg/raised', st: 'line/separator', sw: 1,
    w: Math.floor((INNER - SP[3] * 3) / 4),
    kids: [
      T(label, 'cap', { c: 'text/secondary' }),
      T(value, 'title', { w: 'sb' }),
      sub && T(sub, 'cap', { c: 'text/tertiary' }),
    ],
  });
}

/** `.bar` — a name, a proportional track, and the count. */
function bar(name, frac, value, nameW = 80, tone = 'accent/base') {
  const trackW = INNER - nameW - 70 - SP[3] * 2;
  return F(`bar/${name}`, {
    dir: 'h', g: SP[3], align: 'CENTER', w: INNER,
    kids: [
      F('name', { w: nameW, kids: [T(name, 'cap', { c: 'text/secondary' })] }),
      F('track', {
        dir: 'h', g: 0, w: trackW, h: 8, r: RAD.pill, bg: 'bg/sunken', clip: true,
        kids: [F('fill', { w: Math.max(2, Math.round(trackW * frac)), h: 8, r: RAD.pill, bg: tone })],
      }),
      F('value', { w: 70, kids: [T(value, 'cap', { c: 'text/tertiary' })] }),
    ],
  });
}

SCREENS.statistics = () => {
  const years = [3, 5, 4, 9, 14, 22, 31, 28, 19, 24, 33, 41, 37, 29, 22, 26, 18, 12, 9, 6];
  const peak = Math.max(...years);
  return screen('Statistics', 'Statistics', [
    paneHeader('Statistics', 'What the library actually contains.', null),
    body([
      F('tiles', {
        dir: 'h', g: SP[3], w: INNER,
        kids: [
          statTile('Releases', '1,284', '53,116 tracks'),
          statTile('On disk', '2.41 TB', 'across 3 folders'),
          statTile('Lossless', '78%', '1,001 releases'),
          statTile('Median year', '2003', '1978 – 2026'),
        ],
      }),
      F('gap', { w: 1, h: SP[4] }),
      F('block/formats', {
        g: SP[3], w: INNER,
        kids: [
          T('Formats', 'section'),
          bar('FLAC', 0.62, '32,940', 80),
          bar('WAV', 0.14, '7,436', 80),
          bar('AIFF', 0.05, '2,656', 80),
          bar('MP3 320', 0.15, '7,967', 80, 'state/warn'),
          bar('MP3 V0', 0.04, '2,117', 80, 'state/warn'),
        ],
      }),
      F('gap', { w: 1, h: SP[4] }),
      F('block/years', {
        g: SP[3], w: INNER,
        kids: [
          T('Releases by year', 'section'),
          F('hist', {
            dir: 'h', g: 3, align: 'MAX', w: INNER, h: 96,
            kids: years.map((n, i) => F(`y${i}`, {
              w: Math.floor((INNER - 3 * (years.length - 1)) / years.length),
              h: Math.max(3, Math.round((n / peak) * 96)), r: 2, bg: 'accent/base',
            })),
          }),
          T('1978                                                                                                                          2026', 'micro', { c: 'text/quaternary' }),
        ],
      }),
      F('gap', { w: 1, h: SP[4] }),
      F('block/artists', {
        g: SP[3], w: INNER,
        kids: [
          T('Most represented artists', 'section'),
          bar('Various Artists', 1.0, '96', 180),
          bar('Basic Channel', 0.42, '40', 180),
          bar('Theo Parrish', 0.33, '32', 180),
          bar('Moodymann', 0.28, '27', 180),
          bar('Burial', 0.19, '18', 180),
        ],
      }),
    ]),
  ]);
};

// --- Library ---------------------------------------------------------------

/** `.wish__row` — the shape shared by Library, Wishlist, History and Saved. */
function listRow(main, right, o = {}) {
  return F(`row/${typeof main === 'string' ? main : 'row'}`, {
    dir: 'h', g: SP[3], p: [SP[2], SP[3], SP[2], SP[3]], align: 'CENTER',
    w: INNER, r: RAD.sm, bg: o.bg || 'bg/raised', st: 'line/separator', sw: 1,
    kids: [
      o.lead,
      { n: typeof main === 'string' ? T(main, 'sec') : main, grow: 1 },
      ...(right || []),
    ],
  });
}

function releaseName(artist, title) {
  return F('name', {
    dir: 'h', g: SP[1], align: 'CENTER',
    kids: [
      T(artist, 'sec', { c: 'text/secondary' }),
      T('—', 'sec', { c: 'text/quaternary' }),
      T(title, 'sec'),
    ],
  });
}

SCREENS.library = () => screen('Library', 'Library', [
  paneHeader('Library', 'Built by scanning folders you choose. 1,284 releases · 53,116 tracks.', [
    btn('Add a folder', { icon: 'plus', primary: true }),
    btn('Rescan', { icon: 'rotate-cw' }),
  ]),
  body([
    F('tools', {
      dir: 'h', g: SP[3], align: 'CENTER', w: INNER,
      kids: [
        input('Filter releases…', 260),
        { n: F('sp', { w: 1, h: 1 }), grow: 1 },
        T('Read tags — slower, much more accurate', 'cap', { c: 'text/secondary' }),
      ],
    }),
    listRow(releaseName('Basic Channel', 'BCD'), [
      T('10 tracks', 'cap', { c: 'text/tertiary' }),
      T('620 MB', 'cap', { c: 'text/tertiary' }),
      T('matched', 'cap', { c: 'state/success' }),
    ], { lead: I('folder', 14, 'text/tertiary') }),
    listRow(releaseName('Rhythm & Sound', 'w/ The Artists'), [
      T('12 tracks', 'cap', { c: 'text/tertiary' }),
      T('710 MB', 'cap', { c: 'text/tertiary' }),
      T('matched', 'cap', { c: 'state/success' }),
    ], { lead: I('folder', 14, 'text/tertiary') }),
    listRow(releaseName('Theo Parrish', 'Sound Sculptures Vol. 1'), [
      T('9 tracks', 'cap', { c: 'text/tertiary' }),
      T('502 MB', 'cap', { c: 'text/tertiary' }),
      T('2 tracks missing', 'cap', { c: 'state/warn' }),
    ], { lead: I('folder', 14, 'text/tertiary') }),
    listRow(releaseName('Moodymann', 'Silentintroduction'), [
      T('11 tracks', 'cap', { c: 'text/tertiary' }),
      T('588 MB', 'cap', { c: 'text/tertiary' }),
      T('Checking…', 'cap', { c: 'text/secondary' }),
    ], { lead: I('folder', 14, 'text/tertiary') }),
    listRow(releaseName('Various', 'Chain Reaction Compilation'), [
      T('18 tracks', 'cap', { c: 'text/tertiary' }),
      T('1.1 GB', 'cap', { c: 'text/tertiary' }),
      T('no confident match', 'cap', { c: 'text/tertiary' }),
    ], { lead: I('folder', 14, 'text/tertiary') }),
  ]),
]);

// --- Want List -------------------------------------------------------------

function wantRow(artist, title, meta1, status, statusTone) {
  return F(`want/${title}`, {
    dir: 'h', g: SP[3], p: SP[3], align: 'CENTER', w: INNER,
    r: RAD.md, bg: 'bg/raised', st: 'line/separator', sw: 1,
    kids: [
      art(44),
      {
        n: F('body', {
          g: 2,
          kids: [releaseName(artist, title), T(meta1, 'cap', { c: 'text/secondary' })],
        }),
        grow: 1,
      },
      T(status, 'cap', { c: statusTone }),
      btn('Search', { icon: 'search' }),
    ],
  });
}

function groupHead(title, count, hint) {
  return F(`head/${title}`, {
    dir: 'h', g: SP[2], align: 'CENTER', w: INNER, p: [SP[4], 0, SP[1], 0],
    kids: [
      T(title, 'section'),
      F('count', {
        p: [1, 6, 1, 6], r: RAD.pill, bg: 'bg/sunken',
        kids: [T(String(count), 'micro', { c: 'text/secondary' })],
      }),
      hint && T(hint, 'cap', { c: 'text/tertiary' }),
    ],
  });
}

SCREENS.want = () => screen('Want List', 'Want List', [
  paneHeader('Want List', '7 waiting · 2 found · imported from Discogs', [
    btn('Import your Discogs wantlist', { icon: 'link-2' }),
  ]),
  body([
    groupHead('Found', 2, 'on the network right now'),
    wantRow('Jeff Mills', 'Waveform Transmission Vol. 1', 'Tresor · 1992 · 9 tracks', '4 copies', 'state/success'),
    wantRow('Drexciya', 'Neptune’s Lair', 'Tresor · 1999 · 16 tracks', '2 copies', 'state/success'),
    groupHead('Waiting', 5, 'nobody is sharing these'),
    wantRow('Underground Resistance', 'Riot EP', 'UR · 1991 · 4 tracks', 'not seen', 'text/tertiary'),
    wantRow('Robert Hood', 'Minimal Nation', 'Axis · 1994 · 8 tracks', 'not seen', 'text/tertiary'),
    wantRow('Model 500', 'No UFO’s', 'Metroplex · 1985 · 3 tracks', 'not seen', 'text/tertiary'),
  ]),
]);

// --- Dig Sessions ----------------------------------------------------------

SCREENS.sessions = () => screen('Dig Sessions', 'Dig Sessions', [
  paneHeader('Dig Sessions', 'A dig is everything you turned up in one sitting.', [
    btn('Start a session', { icon: 'plus', primary: true }),
  ]),
  body([
    F('sess/live', {
      g: SP[2], p: SP[4], w: INNER, r: RAD.md, bg: 'bg/raised', st: 'accent/base', sw: 1,
      kids: [
        F('head', {
          dir: 'h', g: SP[2], align: 'CENTER', w: INNER - SP[4] * 2,
          kids: [
            { n: T('Thursday night — Detroit', 'section'), grow: 1 },
            F('live', {
              p: [2, 8, 2, 8], r: RAD.pill, bg: 'bg/selected',
              kids: [T('collecting', 'micro', { c: 'accent/base' })],
            }),
          ],
        }),
        T('18 releases · 6 peers · started 40 minutes ago', 'cap', { c: 'text/secondary' }),
        T('Mostly Metroplex and Axis. Three things you already own.', 'cap', { c: 'text/tertiary' }),
      ],
    }),
    F('sess/1', {
      g: SP[2], p: SP[4], w: INNER, r: RAD.md, bg: 'bg/raised', st: 'line/separator', sw: 1,
      kids: [
        T('Sunday — dub techno', 'section'),
        T('34 releases · 11 peers · 2 days ago', 'cap', { c: 'text/secondary' }),
        T('Chain Reaction and everything adjacent to it.', 'cap', { c: 'text/tertiary' }),
      ],
    }),
    F('sess/2', {
      g: SP[2], p: SP[4], w: INNER, r: RAD.md, bg: 'bg/raised', st: 'line/separator', sw: 1,
      kids: [
        T('Late night — UK bass', 'section'),
        T('21 releases · 8 peers · last week', 'cap', { c: 'text/secondary' }),
        T('Hyperdub, Hessle Audio, Tempa.', 'cap', { c: 'text/tertiary' }),
      ],
    }),
  ]),
]);

// --- Labels ----------------------------------------------------------------

function watchRow(name, kind, facts, detail, unread) {
  return F(`watch/${name}`, {
    dir: 'h', g: SP[3], p: SP[3], align: 'CENTER', w: INNER,
    r: RAD.md, bg: 'bg/raised', st: unread ? 'accent/base' : 'line/separator', sw: 1,
    kids: [
      {
        n: F('body', {
          g: 2,
          kids: [
            F('head', {
              dir: 'h', g: SP[2], align: 'CENTER',
              kids: [T(name, 'sec', { w: 'm' }), T(kind, 'micro', { c: 'text/tertiary', upper: true })],
            }),
            T(facts, 'cap', { c: 'text/secondary' }),
            detail && T(detail, 'cap', { c: 'text/tertiary' }),
          ],
        }),
        grow: 1,
      },
      btn('Open', { primary: true }),
    ],
  });
}

SCREENS.labels = () => screen('Labels', 'Labels', [
  paneHeader('Labels', 'Catalogues you are watching, and what has appeared since you last looked.', [
    btn('Watch a label', { icon: 'plus' }),
  ]),
  body([
    watchRow('Metroplex', 'label', '48 in the catalogue · 31 in your library · read 2 days ago', '4 new since you last looked', true),
    watchRow('Chain Reaction', 'label', '62 in the catalogue · 44 in your library · read last week', '2 new since you last looked', true),
    watchRow('Hyperdub', 'label', '210 in the catalogue · 38 in your library · read today', null, false),
    watchRow('Tresor', 'label', '380 in the catalogue · 52 in your library · read 3 weeks ago', 'your library has probably moved on since this reading', false),
  ]),
]);

// --- Wishlist, Search History, Saved Searches ------------------------------

/* Three screens, one shape: a query, and the two things you can do with it.
   They are written as one builder because in the app they ARE one component
   with different data — writing them apart here would let them drift. */
function queryScreen(name, nav, title, subtitle, tools, rows) {
  return screen(name, nav, [
    paneHeader(title, subtitle, tools),
    body(rows.map(([q, right]) => listRow(q, right, { lead: I('search', 14, 'text/tertiary') }))),
  ]);
}

SCREENS.wishlist = () => queryScreen(
  'Wishlist', 'Wishlist', 'Wishlist',
  'Searches that run themselves when you are not looking.',
  [input('Add a search…', 240), btn('Add', { primary: true })],
  [
    ['drexciya neptune lair', [T('checked 12 minutes ago', 'cap', { c: 'text/tertiary' }), T('2 new', 'cap', { c: 'state/success' }), btn('Remove', { icon: 'x' })]],
    ['jeff mills waveform', [T('checked 40 minutes ago', 'cap', { c: 'text/tertiary' }), T('nothing new', 'cap', { c: 'text/tertiary' }), btn('Remove', { icon: 'x' })]],
    ['robert hood minimal nation flac', [T('checked an hour ago', 'cap', { c: 'text/tertiary' }), T('nothing new', 'cap', { c: 'text/tertiary' }), btn('Remove', { icon: 'x' })]],
    ['ur riot ep', [T('checked 3 hours ago', 'cap', { c: 'text/tertiary' }), T('1 new', 'cap', { c: 'state/success' }), btn('Remove', { icon: 'x' })]],
  ],
);

SCREENS.history = () => queryScreen(
  'Search History', 'Search History', 'Search History', null,
  [btn('Clear history', { icon: 'trash-2' })],
  [
    ['burial untrue', [T('4 minutes ago', 'cap', { c: 'text/tertiary' }), btn('Search again', { icon: 'rotate-cw' })]],
    ['basic channel bcd flac', [T('22 minutes ago', 'cap', { c: 'text/tertiary' }), btn('Search again', { icon: 'rotate-cw' })]],
    ['theo parrish sound sculptures', [T('an hour ago', 'cap', { c: 'text/tertiary' }), btn('Search again', { icon: 'rotate-cw' })]],
    ['moodymann silentintroduction', [T('yesterday', 'cap', { c: 'text/tertiary' }), btn('Search again', { icon: 'rotate-cw' })]],
    ['chain reaction compilation', [T('yesterday', 'cap', { c: 'text/tertiary' }), btn('Search again', { icon: 'rotate-cw' })]],
  ],
);

SCREENS.saved = () => queryScreen(
  'Saved Searches', 'Saved Searches', 'Saved Searches',
  'A query and the filters it was run with.', null,
  [
    ['detroit techno 1990s', [T('FLAC · lossless only · free slots', 'cap', { c: 'text/tertiary' }), btn('Run', { primary: true })]],
    ['dub techno', [T('FLAC, WAV · no transcodes', 'cap', { c: 'text/tertiary' }), btn('Run', { primary: true })]],
    ['uk garage 2step', [T('320 · free slots', 'cap', { c: 'text/tertiary' }), btn('Run', { primary: true })]],
  ],
);

// --- Followed --------------------------------------------------------------

function peerRow(who, facts, state, tone) {
  return listRow(
    F('who', {
      g: 2,
      kids: [T(who, 'sec', { w: 'm' }), T(facts, 'cap', { c: 'text/secondary' })],
    }),
    [T(state, 'cap', { c: tone }), btn('Browse', { icon: 'folder-open' }), btn('Unfollow', { icon: 'x' })],
    { lead: I('user', 16, 'text/tertiary') },
  );
}

SCREENS.followed = () => screen('Followed', 'Followed', [
  paneHeader('Followed', 'People whose shelves are worth checking again.', [
    input('Add someone…', 220), btn('Follow', { primary: true }),
  ]),
  body([
    peerRow('a-peer', '12,400 files · 1.8 TB · last seen just now', 'online', 'state/success'),
    peerRow('another-peer', '3,120 files · 480 GB · last seen 20 minutes ago', 'online', 'state/success'),
    peerRow('a-third-peer', '48,900 files · 6.2 TB · last seen yesterday', 'offline', 'text/tertiary'),
    peerRow('someone-else', '860 files · 91 GB · last seen last week', 'offline', 'text/tertiary'),
  ]),
]);

// --- Chat rooms and Private chats ------------------------------------------

const CHAT_RAIL = 240;

function chatScreen(name, nav, title, railTitle, railItems, headline, members, lines, composer) {
  const mainW = PANE_W - CHAT_RAIL;
  const rail = F('chat__rail', {
    g: SP[1], p: SP[3], w: CHAT_RAIL, h: WIN.h, bg: 'bg/window',
    st: 'line/separator', sw: 0.5, stSides: [0, 0.5, 0, 0],
    kids: [
      input('Filter…', CHAT_RAIL - SP[3] * 2),
      F('gap', { w: 1, h: SP[2] }),
      T(railTitle, 'micro', { c: 'text/tertiary', w: 'm', upper: true }),
      ...railItems.map(([label, count, active]) => F(`chat/${label}`, {
        dir: 'h', g: SP[2], p: [0, SP[2], 0, SP[2]], r: RAD.sm, align: 'CENTER',
        w: CHAT_RAIL - SP[3] * 2, h: 28, bg: active ? 'bg/selected' : null,
        kids: [
          { n: T(label, 'sec', { c: active ? 'accent/base' : 'text/primary', w: active ? 'm' : 'r' }), grow: 1 },
          count && F('n', {
            p: [1, 5, 1, 5], r: RAD.pill, bg: typeof count === 'number' ? 'accent/base' : null,
            kids: [T(String(count), 'micro', { c: typeof count === 'number' ? 'text/primary' : 'text/tertiary' })],
          }),
        ],
      })),
    ],
  });

  const main = F('chat__main', {
    g: 0, w: mainW, h: WIN.h, bg: 'bg/content',
    kids: [
      F('chat__head', {
        dir: 'h', g: SP[2], p: [SP[4], SP[5], SP[4], SP[5]], align: 'CENTER', w: mainW,
        st: 'line/separator', sw: 0.5, stSides: [0, 0, 0.5, 0],
        kids: [
          { n: T(headline, 'section'), grow: 1 },
          members && T(members, 'cap', { c: 'text/tertiary' }),
        ],
      }),
      F('chat__scroll', {
        g: SP[2], p: SP[5], w: mainW,
        kids: lines.map(([time, who, text]) => F(`line/${who}`, {
          dir: 'h', g: SP[3], w: mainW - SP[5] * 2, align: 'MIN',
          kids: [
            F('t', { w: 46, kids: [T(time, 'micro', { c: 'text/quaternary' })] }),
            F('w', { w: 108, kids: [T(who, 'cap', { c: 'accent/base' })] }),
            { n: T(text, 'cap', { c: 'text/secondary' }), grow: 1 },
          ],
        })),
      }),
    ],
  });

  const frame = screen(name, nav, []);
  // The pane is two columns rather than a header over a body, so the standard
  // Main is replaced wholesale here.
  frame.children[1].remove();
  const wrap = F('Main', { dir: 'h', g: 0, w: PANE_W, h: WIN.h, bg: 'bg/content', clip: true, kids: [rail, main] });
  frame.appendChild(wrap);
  return frame;
}

SCREENS.chat = () => chatScreen(
  'Chat rooms', 'Chat rooms', 'Chat rooms', 'Rooms',
  [['#techno', 412, true], ['#detroit', 4, false], ['#dubtechno', null, false], ['#vinyl', 96, false], ['#help', null, false]],
  '#techno', '412 here',
  [
    ['21:04', 'a-peer', 'anyone got the Metroplex reissues in lossless'],
    ['21:05', 'another-peer', 'check my shelf, second folder down'],
    ['21:06', 'a-third-peer', 'the 2017 pressing sounds better than the original imo'],
    ['21:08', 'someone-else', 'disagree, the original has more low end'],
    ['21:09', 'a-fifth-peer', 'both are transfers of the same master though'],
  ],
);

SCREENS.messages = () => chatScreen(
  'Private chats', 'Private chats', 'Private chats', 'Open',
  [['a-peer', 1, true], ['another-peer', null, false], ['a-third-peer', null, false]],
  'a-peer', 'online',
  [
    ['20:41', 'a-peer', 'saw you queued the Chain Reaction stuff'],
    ['20:42', 'you', 'yeah, been after CR-020 for years'],
    ['20:43', 'a-peer', 'i have the whole run, give me a minute'],
    ['20:51', 'a-peer', 'ok all shared, folder is called chain-reaction-complete'],
  ],
);

// --- Browse ----------------------------------------------------------------

SCREENS.browse = () => screen('Browse', 'Browse', [
  paneHeader('Browse', null, [input('A username…', 240), btn('Browse', { primary: true })]),
  body([
    F('browse__bar', {
      dir: 'h', g: SP[4], p: [SP[2], SP[3], SP[2], SP[3]], align: 'CENTER', w: INNER,
      r: RAD.sm, bg: 'bg/raised', st: 'line/separator', sw: 1,
      kids: [
        T('a-peer', 'sec', { w: 'm' }),
        T('12,400 files', 'cap', { c: 'text/secondary' }),
        T('1.8 TB', 'cap', { c: 'text/secondary' }),
        T('284 releases', 'cap', { c: 'text/secondary' }),
        { n: F('sp', { w: 1, h: 1 }), grow: 1 },
        T('31 you already have', 'cap', { c: 'state/warn' }),
      ],
    }),
    ...[
      ['Basic Channel', 'BCD', '10 tracks · FLAC · 620 MB', true],
      ['Maurizio', 'M-Series', '8 tracks · FLAC · 502 MB', false],
      ['Various', 'Chain Reaction Compilation', '18 tracks · FLAC · 1.1 GB', false],
      ['Rhythm & Sound', 'w/ The Artists', '12 tracks · FLAC · 710 MB', true],
      ['Porter Ricks', 'Biokinetics', '9 tracks · WAV · 880 MB', false],
    ].map(([artist, title, facts, have]) => F(`shelf/${title}`, {
      dir: 'h', g: SP[3], p: SP[3], align: 'CENTER', w: INNER,
      r: RAD.md, bg: 'bg/raised', st: 'line/separator', sw: 1,
      kids: [
        art(40),
        { n: F('b', { g: 2, kids: [releaseName(artist, title), T(facts, 'cap', { c: 'text/secondary' })] }), grow: 1 },
        have && T('already yours', 'cap', { c: 'state/warn' }),
        btn('Download', { icon: 'download', primary: true }),
      ],
    })),
  ]),
]);

// --- Settings --------------------------------------------------------------

/* The six tabs of app/src/ui/SettingsView.tsx, each as its own frame. Labels
   and hints are the app's own words: settings copy is where this app does most
   of its explaining, and paraphrasing it in the mock would be designing against
   text that does not exist. */

const SET_W = 720;          // the settings column, narrower than the pane
const HINT_W = SET_W - 200;

function toggle(on) {
  return F(`toggle/${on ? 'on' : 'off'}`, {
    dir: 'h', g: 0, w: 38, h: 22, r: RAD.pill, bg: on ? 'accent/base' : 'bg/sunken',
    just: on ? 'MAX' : 'MIN', align: 'CENTER', p: [0, 2, 0, 2],
    kids: [F('knob', { w: 18, h: 18, r: RAD.pill, bg: 'text/primary' })],
  });
}

function field(value, w = 180) {
  return F(`field/${value}`, {
    dir: 'h', g: SP[2], p: [0, SP[3], 0, SP[3]], r: RAD.sm, align: 'CENTER', h: 28, w,
    bg: 'bg/sunken', st: 'line/border-control', sw: 1,
    kids: [T(value, 'sec', { c: 'text/primary' })],
  });
}

/** One setting: what it is, what it means, and the control. */
function settingRow(label, hint, control) {
  return F(`set/${label}`, {
    dir: 'h', g: SP[4], w: SET_W, p: [SP[3], 0, SP[3], 0], align: 'MIN',
    st: 'line/separator', sw: 1, stSides: [0, 0, 1, 0],
    kids: [
      {
        n: F('text', {
          g: SP[1],
          kids: [
            T(label, 'body'),
            hint && T(hint, 'cap', { c: 'text/tertiary', width: HINT_W }),
          ],
        }),
        grow: 1,
      },
      control,
    ],
  });
}

function settingsGroup(title, rows) {
  return F(`group/${title}`, {
    g: 0, w: SET_W, p: [SP[6], 0, 0, 0],
    kids: [T(title, 'section'), ...rows],
  });
}

const SET_TABS = ['Account', 'Folders', 'Downloads', 'Network', 'Lookups', 'About'];

function settingsScreen(tabIndex, groups) {
  return screen(`Settings — ${SET_TABS[tabIndex]}`, 'Settings', [
    F('Header', {
      g: SP[3], p: [SP[6], SP[6], SP[4], SP[6]], w: PANE_W,
      kids: [T('Settings', 'title'), segmented(SET_TABS, tabIndex)],
    }),
    F('Body', { g: 0, p: [0, SP[6], SP[6], SP[6]], w: PANE_W, kids: groups }),
  ]);
}

SCREENS['settings-account'] = () => settingsScreen(0, [
  settingsGroup('Your Soulseek account', [
    settingRow('Username', null, field('your-handle')),
    settingRow('Password', null, field('••••••••••')),
    settingRow('Sign in automatically', null, toggle(true)),
  ]),
  settingsGroup('Privacy', [
    settingRow('Telemetry',
      'There is none, and there is no switch because there is nothing to switch off.',
      T('none', 'sec', { c: 'text/tertiary' })),
  ]),
]);

SCREENS['settings-folders'] = () => settingsScreen(1, [
  settingsGroup('Where files go', [
    settingRow('Downloads', null, btn('Choose…', { icon: 'folder-open' })),
    settingRow('Files in progress',
      'Partial downloads live here until they finish, then move to the downloads folder. Keeping it on the same volume makes that a rename rather than a copy.',
      btn('Choose…', { icon: 'folder-open' })),
  ]),
  settingsGroup('Shared with other people', [
    settingRow('Shared folders', 'Three folders · 53,116 files', btn('Manage…', { icon: 'folder-open' })),
  ]),
]);

SCREENS['settings-downloads'] = () => settingsScreen(2, [
  settingsGroup('Choosing what to take', [
    settingRow('Prefer lossless',
      'When a track has several sources, take the best lossless one instead of the highest overall score — a free fast 320 usually out-scores a queued FLAC.',
      toggle(true)),
    settingRow('Minimum bitrate',
      'Refuse lossy files below this. Never applied to lossless, which advertises no bitrate at all. 0 disables it.',
      field('256 kbps', 120)),
    settingRow('Reject suspected transcodes',
      'Refuse files the physics check flags. The check is a prediction from metadata, so this errs on the side of not downloading.',
      toggle(false)),
  ]),
  settingsGroup('Keeping the list readable', [
    settingRow('Move silent downloads to Failed',
      "A download that has not moved a byte for this long is shown under Failed instead of Downloads. Seek does not cancel it — it keeps its place in the peer's queue, which is often hours long, and it returns here by itself if it starts again. 0 never moves anything.",
      field('30 min', 120)),
    settingRow('Forget completed downloads',
      "Clear finished downloads from the Completed list once they are this old. This forgets Seek's RECORD of the download — the files on disk are never touched. 0 keeps them forever.",
      field('0 days', 120)),
  ]),
  settingsGroup('After downloading', [
    settingRow('Organise completed downloads',
      'Move finished files into Artist/Year - Album/ using the MusicBrainz match. Never overwrites, never leaves the download folder.',
      toggle(false)),
    settingRow('Embed artwork into file tags', 'Writes the fetched cover into the downloaded file.', toggle(true)),
    settingRow('Write cover.jpg into the release folder', null, toggle(true)),
  ]),
]);

SCREENS['settings-network'] = () => settingsScreen(3, [
  settingsGroup('Connection', [
    settingRow('Listening port',
      'Forward this port on your router to be reachable. Changing it takes effect on the next sign-in.',
      field('2234', 120)),
    settingRow('Your address', 'How the Soulseek server sees you. Only known while signed in.',
      T('81.2.69.144', 'sec', { c: 'text/tertiary' })),
  ]),
  settingsGroup('Speed limits', [
    settingRow('Maximum download speed', 'Across all downloads together, not per transfer.', field('unlimited', 140)),
    settingRow('Maximum upload speed', 'Across all uploads together.', field('2 MB/s', 140)),
    settingRow('Upload slots', 'How many people can download from you at once. Everyone else waits in your queue.', field('4', 120)),
  ]),
  settingsGroup('Transfers', [
    settingRow('Call a download stalled after', 'Zero progress for this long while supposedly transferring.', field('45 s', 120)),
  ]),
]);

SCREENS['settings-lookups'] = () => settingsScreen(4, [
  settingsGroup('External lookups', [
    settingRow('Look up artwork and release data',
      'MusicBrainz, Cover Art Archive, and Deezer. Rate-limited and cached.', toggle(true)),
    settingRow('Discogs token',
      'Optional, but Discogs is the one that actually knows underground electronic releases.',
      field('••••••••••••', 200)),
    settingRow('AcoustID application key',
      'Needed to identify a track by its sound. Free from acoustid.org. Drop an audio file on the search field once it is set.',
      field('not set', 200)),
    settingRow('YouTube Data API key', "Needed to read a public playlist's contents.", field('not set', 200)),
  ]),
]);

SCREENS['settings-about'] = () => settingsScreen(5, [
  settingsGroup('About', [
    settingRow('Version', 'Seek 0.2.5 · engine 3.3.10', btn('Check for updates', { icon: 'rotate-cw' })),
    settingRow('Diagnostics', 'Everything the support log would contain, and nothing else.',
      btn('Copy diagnostics', { icon: 'link-2' })),
    settingRow('Licence', 'GPL-3.0-or-later. The engine is pynicotine.', null),
  ]),
]);

// --- Search ----------------------------------------------------------------

/** `.chip` — a filter, on or off. */
function chip(label, active) {
  return F(`chip/${label}`, {
    dir: 'h', g: SP[1], p: [0, SP[3], 0, SP[3]], r: RAD.pill, align: 'CENTER', h: 26,
    bg: active ? 'bg/selected' : 'bg/raised',
    st: active ? null : 'line/border-control', sw: active ? 0 : 1,
    kids: [T(label, 'cap', { c: active ? 'accent/base' : 'text/secondary', w: active ? 'm' : 'r' })],
  });
}

/** The format badge — the only colour in the row, per PRODUCT §6. */
function formatBadge(text, tone) {
  return F(`badge/${text}`, {
    p: [1, 6, 1, 6], r: 4, bg: 'bg/sunken', st: tone, sw: 1,
    kids: [T(text, 'micro', { c: tone, w: 'm' })],
  });
}

/**
 * A search result, grouped by release.
 *
 * The quality verdict sits last because it is the VERDICT — the thing the whole
 * screen exists to deliver — and the format badge sits first because it is the
 * one piece of colour in the line. That order is why the table's columns are
 * droppable by priority and not by position (see domain/searchColumns.ts).
 */
function resultRow(o) {
  return F(`res/${o.title}`, {
    dir: 'h', g: SP[3], p: SP[3], align: 'CENTER', w: INNER,
    r: RAD.md, bg: 'bg/raised', st: 'line/separator', sw: 1,
    kids: [
      art(40),
      {
        n: F('main', {
          g: 2,
          kids: [
            releaseName(o.artist, o.title),
            F('meta', {
              dir: 'h', g: SP[2], align: 'CENTER',
              kids: [
                formatBadge(o.format, o.formatTone),
                T(o.spec, 'cap', { c: 'text/secondary' }),
                T('·', 'cap', { c: 'text/quaternary' }),
                T(o.tracks, 'cap', { c: 'text/secondary' }),
                T('·', 'cap', { c: 'text/quaternary' }),
                T(o.size, 'cap', { c: 'text/secondary' }),
                T('·', 'cap', { c: 'text/quaternary' }),
                T(o.who, 'cap', { c: 'text/secondary' }),
              ],
            }),
          ],
        }),
        grow: 1,
      },
      T(o.copies, 'cap', { c: 'text/tertiary' }),
      F('verdict', {
        dir: 'h', g: SP[1], p: [2, SP[2], 2, SP[2]], r: RAD.pill, align: 'CENTER',
        bg: 'bg/sunken',
        kids: [I(o.ok === 'bad' ? 'triangle-alert' : 'check', 12,
          o.ok === 'bad' ? 'state/danger' : o.ok === 'warn' ? 'state/warn' : 'state/success', 1.8),
        T(o.verdict, 'micro', {
          c: o.ok === 'bad' ? 'state/danger' : o.ok === 'warn' ? 'state/warn' : 'state/success',
        })],
      }),
      I('chevron-down', 14, 'text/tertiary', 1.5),
    ],
  });
}

SCREENS.search = () => screen('Search', 'Search', [
  F('Header', {
    g: SP[3], p: [SP[6], SP[6], SP[4], SP[6]], w: PANE_W,
    kids: [
      F('search-field', {
        dir: 'h', g: SP[3], p: [0, SP[4], 0, SP[4]], r: RAD.md, align: 'CENTER',
        h: 44, w: INNER, bg: 'bg/sunken', st: 'line/border-control', sw: 1,
        kids: [
          I('search', 18, 'text/tertiary'),
          { n: T('burial', 'bodyLg'), grow: 1 },
          T('⌘↵', 'micro', { c: 'text/quaternary' }),
        ],
      }),
      F('filters', {
        dir: 'h', g: SP[2], align: 'CENTER', wrap: true, w: INNER,
        kids: [
          chip('FLAC', true), chip('WAV', false), chip('AIFF', false), chip('320', false),
          chip('Lossless only', true), chip('Free slots', true), chip('No transcodes', false),
          chip('Advanced ⌄', false),
        ],
      }),
      F('results-bar', {
        dir: 'h', g: SP[3], align: 'CENTER', w: INNER,
        kids: [
          { n: T('218 results from 46 peers', 'sec', { c: 'text/secondary' }), grow: 1 },
          segmented(['Release', 'Track', 'Peer'], 0),
          btn('Best ⌄'),
          btn('Save', { icon: 'star' }),
          btn('View', { icon: 'sliders-horizontal' }),
        ],
      }),
    ],
  }),
  body([
    resultRow({ artist: 'Burial', title: 'Rival Dealer', format: 'FLAC', formatTone: 'state/success', spec: '16/44.1', tracks: '3 tracks', size: '286 MB', who: 'a-peer', copies: '6 copies', ok: 'good', verdict: 'lossless' }),
    resultRow({ artist: 'Burial', title: 'Untrue', format: 'FLAC', formatTone: 'state/success', spec: '16/44.1', tracks: '13 tracks', size: '412 MB', who: 'another-peer', copies: '14 copies', ok: 'good', verdict: 'lossless' }),
    resultRow({ artist: 'Burial', title: 'Street Halo', format: 'WAV', formatTone: 'state/success', spec: '16/44.1', tracks: '3 tracks', size: '318 MB', who: 'a-third-peer', copies: '4 copies', ok: 'good', verdict: 'lossless' }),
    resultRow({ artist: 'Burial', title: 'Kindred', format: 'FLAC', formatTone: 'state/success', spec: '16/44.1', tracks: '3 tracks', size: '241 MB', who: 'someone-else', copies: '9 copies', ok: 'warn', verdict: 'not checked' }),
    resultRow({ artist: 'Burial', title: 'Truant / Rough Sleeper', format: '320', formatTone: 'state/warn', spec: '320 kbps', tracks: '2 tracks', size: '58 MB', who: 'a-fifth-peer', copies: '21 copies', ok: 'bad', verdict: 'transcode' }),
    resultRow({ artist: 'Burial & Four Tet', title: 'Nova', format: 'FLAC', formatTone: 'state/success', spec: '24/48', tracks: '1 track', size: '96 MB', who: 'a-sixth-peer', copies: '3 copies', ok: 'good', verdict: 'lossless' }),
  ]),
]);
