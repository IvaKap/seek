/*
 * Seek — the local Figma bridge.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * WHY THIS EXISTS. Figma's hosted MCP server meters tool calls, and the Starter
 * plan allows twenty A MONTH — roughly two screens. The Plugin API has no such
 * meter, because it runs inside the desktop app rather than on Figma's
 * infrastructure. So the design loop moves local: a plugin does the work, and
 * this process is the only thing standing between it and the agent.
 *
 * The shape is a job queue with exactly one worker.
 *
 *   agent  --POST /job-->  [queue]  --GET /job-->  plugin
 *   agent  <--response---  [queue]  <-POST /result- plugin
 *
 * POST /job BLOCKS until the plugin answers. That is the whole point: one curl
 * is one complete round trip, so the agent gets the result — and any thrown
 * error — in the same breath it asked. A fire-and-forget queue would put the
 * agent back to guessing, which is the thing this replaces.
 *
 * The plugin also returns PNG renders, which are written to shots/. An agent
 * that can look at what it just built stops needing a human to describe it.
 *
 * Zero dependencies and bound to loopback ONLY. This accepts arbitrary build
 * jobs from anything that can reach it, so it must not be reachable.
 */

import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const PORT = Number(process.env.SEEK_FIGMA_PORT || 8787);

/** Jobs waiting for the plugin to pick up. */
const pending = [];
/** Jobs the plugin is working on, by id, holding the HTTP response to finish. */
const inflight = new Map();
/** Plugin long-polls parked here when the queue is empty. */
let waiter = null;
let lastSeen = 0;
let seq = 0;

const now = () => Date.now();

function send(res, code, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    /* The plugin UI is an iframe on a Figma origin, so every request from it is
       cross-origin. Wide-open is fine precisely because we only listen on
       loopback — the origin restriction would be guarding a door in a field. */
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      // A screen render comes back as base64 PNG, so the ceiling is generous —
      // but unbounded would let a stuck plugin exhaust memory.
      if (raw.length > 64 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** Hand the queue's head to a parked plugin, if both exist. */
function pump() {
  if (!waiter || pending.length === 0) return;
  const res = waiter;
  waiter = null;
  const job = pending.shift();
  send(res, 200, job);
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // -- the agent's side -----------------------------------------------------

  if (req.method === 'POST' && url.pathname === '/job') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: String(e) }); }

    const id = `job${++seq}`;
    const job = { id, ...body };
    /* Answering only when the work is done is what makes this usable from a
       shell. The timeout is long because a full rebuild renders 20+ frames. */
    const timer = setTimeout(() => {
      if (!inflight.has(id)) return;
      inflight.delete(id);
      send(res, 504, {
        error: 'the plugin did not answer in time',
        hint: lastSeen === 0
          ? 'no plugin has ever connected — run "Seek design sync" in Figma'
          : `plugin last seen ${Math.round((now() - lastSeen) / 1000)}s ago`,
      });
    }, 180_000);

    inflight.set(id, { res, timer });
    pending.push(job);
    pump();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      pluginConnected: lastSeen > 0 && now() - lastSeen < 60_000,
      lastSeenSecondsAgo: lastSeen ? Math.round((now() - lastSeen) / 1000) : null,
      queued: pending.length,
      inflight: inflight.size,
    });
  }

  // -- the plugin's side ----------------------------------------------------

  if (req.method === 'GET' && url.pathname === '/job') {
    lastSeen = now();
    if (pending.length > 0) return send(res, 200, pending.shift());
    /* Long-poll rather than a tight loop: the plugin parks here for 25s and
       gets the job the instant one arrives, so a build starts immediately
       without the plugin hammering this process once a second all day. */
    if (waiter) send(waiter, 204, '');   // only one plugin; the newest wins
    waiter = res;
    const t = setTimeout(() => { if (waiter === res) { waiter = null; send(res, 204, ''); } }, 25_000);
    res.on('close', () => { clearTimeout(t); if (waiter === res) waiter = null; });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/result') {
    lastSeen = now();
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: String(e) }); }

    const slot = inflight.get(body.id);
    if (!slot) return send(res, 200, { ok: true, note: 'nobody was waiting for that' });
    inflight.delete(body.id);
    clearTimeout(slot.timer);

    /* Renders land on disk and the reply carries their PATHS, not their bytes:
       the agent reads an image by path, and echoing a megabyte of base64 back
       through the shell would cost it a fortune to learn nothing. */
    const written = [];
    for (const shot of body.shots || []) {
      const file = join(SHOTS, `${shot.name}.png`);
      await writeFile(file, Buffer.from(shot.b64, 'base64'));
      written.push(file);
    }
    const { shots, ...rest } = body;
    send(slot.res, 200, { ...rest, shots: written });
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'no such endpoint' });
}

await mkdir(SHOTS, { recursive: true });

/*
 * Loopback ONLY, on both families.
 *
 * Figma's manifest will not accept a bare IP in devAllowedDomains, so the
 * plugin has to ask for `localhost` by name — and `localhost` resolves to ::1
 * before 127.0.0.1 on macOS. Binding one family and hoping the browser falls
 * back to the other is a coin toss, so both are bound explicitly. What is NOT
 * done is `listen(PORT)` with no host: that would bind every interface, and
 * this endpoint runs arbitrary build jobs against a live document.
 */
const bound = [];
const failed = [];
for (const host of ['127.0.0.1', '::1']) {
  await new Promise((resolve) => {
    const s = createServer(handler);
    /* Failing on ONE family is not fatal — a machine with IPv6 off will never
       bind ::1, and it does not need to. Only a clean sweep is an error. */
    s.once('error', (e) => { failed.push(`${host}: ${e.code || e.message}`); resolve(); });
    s.listen(PORT, host, () => { bound.push(host); resolve(); });
  });
}

if (bound.length === 0) {
  console.error(`could not bind port ${PORT} on either loopback address`);
  for (const f of failed) console.error(`  ${f}`);
  if (failed.some((f) => f.includes('EADDRINUSE'))) {
    console.error('a bridge is probably already running — check: lsof -nP -iTCP:%d -sTCP:LISTEN', PORT);
  }
  process.exit(1);
}
for (const f of failed) console.log(`(not listening on ${f})`);
console.log(`Seek figma bridge on http://localhost:${PORT}  (${bound.join(', ')})`);
console.log('Now run "Seek design sync" in the Figma desktop app.');
