/*
 * Seek — read the Figma comments, so a pin on a screen is a work item.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * WHY THIS IS A SEPARATE DOOR. The Plugin API has no comment surface — none,
 * not read and not write — so the bridge cannot see them however long it runs.
 * Comments exist only in Figma's REST API, which is a different service with a
 * different auth model and, usefully, a different rate limit: per-minute and
 * generous, with no relation to the MCP server's twenty-a-month.
 *
 * So: the plugin writes the design, and this reads the feedback on it.
 *
 * THE TOKEN IS NEVER WRITTEN INTO THIS REPO. It is read from the environment or
 * from a file under ~/.config, and it is never printed, not even partially —
 * the same rule the project already applies to the Discogs and AcoustID keys.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILE_KEY = process.env.SEEK_FIGMA_FILE || 'tpr9AojmFNylgqgyImp32O';
const TOKEN_PATH = join(homedir(), '.config', 'seek', 'figma-token');

async function token() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim();
  try {
    return (await readFile(TOKEN_PATH, 'utf8')).trim();
  } catch {
    console.error(`No Figma token found.

Make one at  Figma → your avatar → Settings → Security → Personal access tokens
(scope: File content — read only is enough), then either:

  export FIGMA_TOKEN=figd_...

or, to keep it out of your shell history and out of this repo:

  mkdir -p ~/.config/seek && printf '%s' 'figd_...' > ${TOKEN_PATH}
  chmod 600 ${TOKEN_PATH}
`);
    process.exit(1);
  }
}

const api = async (path, tok) => {
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { 'X-Figma-Token': tok },
  });
  if (!res.ok) {
    // Never echo the token, and never echo a header dump that might carry it.
    throw new Error(`Figma REST ${res.status} ${res.statusText} on ${path}`);
  }
  return res.json();
};

const tok = await token();
/* The FULL file, not `depth=1`. A comment anchors to whatever was clicked —
   usually a leaf, several levels down — so a shallow fetch resolves it to
   nothing and prints a bare node id, which tells a reader precisely as much as
   not printing it. The whole tree costs one request and makes every anchor
   resolvable. */
const [{ comments }, file] = await Promise.all([
  api(`/files/${FILE_KEY}/comments`, tok),
  api(`/files/${FILE_KEY}`, tok),
]);

const names = new Map();
const parent = new Map();
const screenOf = new Map();   // node id -> the top-level frame it sits in

const walk = (n, top) => {
  names.set(n.id, n.name);
  if (top) screenOf.set(n.id, top);
  for (const kid of n.children || []) {
    parent.set(kid.id, n.id);
    // A page's direct children ARE the screens, so that is where `top` starts.
    walk(kid, top || (n.type === 'CANVAS' ? n.name && kid.name : null) || null);
  }
};
for (const page of file.document.children || []) {
  names.set(page.id, page.name);
  for (const frame of page.children || []) {
    parent.set(frame.id, page.id);
    walk(frame, frame.name);
  }
}

/** Breadcrumb from the screen down to the thing that was actually clicked. */
function trail(id) {
  const chain = [];
  let cur = id;
  while (cur && names.has(cur) && chain.length < 12) {
    chain.unshift(names.get(cur));
    cur = parent.get(cur);
    if (cur && !parent.has(cur)) break;   // stop at the page
  }
  return chain;
}

const wantOpen = !process.argv.includes('--all');
const open = comments
  .filter((c) => (wantOpen ? !c.resolved_at : true))
  .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

if (open.length === 0) {
  console.log(wantOpen ? 'No open comments.' : 'No comments at all.');
  process.exit(0);
}

/* Threads: a reply carries parent_id, and reading a reply without the thing it
   replies to is how you act on the opposite of what was asked. */
const roots = open.filter((c) => !c.parent_id);
const repliesOf = (id) => open.filter((c) => c.parent_id === id);

const where = (c) => {
  const m = c.client_meta || {};
  const id = m.node_id || (m.stickyAnchor && m.stickyAnchor.node_id);
  if (!id) return 'the canvas';
  if (!names.has(id)) return `node ${id} (not on the page any more)`;
  const screen = screenOf.get(id);
  const path = trail(id);
  const rest = path.slice(1).join(' › ');
  // Screen first, because that is what decides which builder to open — but a
  // comment pinned to the screen itself is just the screen, not "X › X".
  if (!screen) return path.join(' › ');
  return rest ? `${screen}  ›  ${rest}` : screen;
};

for (const c of roots) {
  const when = new Date(c.created_at).toLocaleString();
  console.log(`\n── ${where(c)} ${c.resolved_at ? '(resolved)' : ''}`);
  console.log(`   ${c.user.handle} · ${when}`);
  console.log(`   ${c.message.replace(/\n/g, '\n   ')}`);
  for (const r of repliesOf(c.id)) {
    console.log(`     ↳ ${r.user.handle}: ${r.message.replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\n${roots.length} open thread${roots.length === 1 ? '' : 's'}.`);
