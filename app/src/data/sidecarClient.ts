/*
 * Seek — the real sidecar, over a localhost WebSocket.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This implements the same `Sidecar` interface as `mockSidecar.ts`, and that is
 * the whole point of the mock having spoken wire format rather than domain
 * objects: the store, the adapter and every component below it are unchanged.
 *
 * Framing, from `sidecar/seek_sidecar/server.py`:
 *
 *   →  { id, cmd, params }
 *   ←  { id, ok: true,  result }
 *   ←  { id, ok: false, error: { code, message } }
 *   ←  { ev, data }                                  (unsolicited, no id)
 *
 * Auth is a `?token=` query parameter. A browser cannot set request headers on
 * a WebSocket, so `Authorization: Bearer` is unavailable to us — the sidecar
 * accepts both and prefers the header for clients that can send one.
 *
 * The sidecar also refuses any connection carrying an `Origin` header unless
 * that exact origin was passed to `--allow-origin`. Browsers always send one
 * and cannot suppress it, so running the UI from the Vite dev server needs
 * `--allow-origin http://localhost:5273`. A packaged Tauri build sends none and
 * needs nothing.
 */

import type { Sidecar, SidecarHandlers } from './mockSidecar.ts';
import type { WireSearchClosedData, WireSearchResultData } from './adapt.ts';

export interface SidecarEndpoint {
  host: string;
  port: number;
  token: string;
}

export type ConnectionPhase = 'connecting' | 'open' | 'closed';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: number;
}

export interface SidecarClient extends Sidecar {
  /** Send a command and await its reply. Rejects on error frames and timeout. */
  request<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to an event name. Returns an unsubscribe function. */
  on(event: string, fn: (data: unknown) => void): () => void;
  onPhase(fn: (phase: ConnectionPhase) => void): () => void;
  readonly phase: ConnectionPhase;
  /**
   * Connect, or revive a client that was closed. Idempotent.
   *
   * This exists because React StrictMode mounts, unmounts and remounts every
   * component in development. A `close()` that latched permanently would kill
   * the socket on that synthetic unmount and never come back — the connection
   * would work in production and silently fail in dev, which is the worst way
   * round for a bug to be.
   */
  open(): void;
  close(): void;
}

/*
 * How long to wait for a reply before giving up.
 *
 * Every command is queued to pynicotine's SINGLE main thread (`server.py`
 * hands off to an inbox; `core_host._pump_commands` drains it), so a command is
 * not slow because the machine is slow — it is slow because the thread in front
 * of it has not finished. On a first launch that queue can be long: macOS is
 * scanning a freshly downloaded 44 MB bundle, and upstream's share scanner
 * starts with `multiprocessing` *spawn*, which in a frozen build boots a second
 * whole copy of the interpreter.
 *
 * 15 s was a guess, and the first real user proved it wrong in the worst way:
 * `connection.connect` and `app.settings.patch` both "timed out" and BOTH had
 * actually worked — the login held and the token was saved, as a restart
 * showed. The app called them failures anyway.
 *
 * So a write gets far longer than a read. A read that gives up early is a
 * refreshable screen; a write that gives up early tells someone their change
 * was lost while it is in fact being applied, which is the one error a settings
 * screen must never make.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 120_000;

/**
 * The engine is alive but has not got to this command yet.
 *
 * A distinct type rather than a distinguishing string, because the difference
 * decides a SENTENCE a person reads: "could not save that" versus "still
 * saving". Sniffing `message` for a phrase is how those two drift apart the
 * first time someone rewords one of them.
 */
export class EngineBusyError extends Error {
  constructor(cmd: string) {
    super(`the engine has not answered ${cmd} yet`);
    this.name = 'EngineBusyError';
  }
}

/**
 * Commands that CHANGE something, and so must not be declared failed early.
 *
 * Matched on the verb rather than a list of names: a list is a thing to forget
 * to update, and every command in this protocol is `noun.verb`. Anything not
 * recognised is treated as a read, which is the safe default — the worst case
 * is an early give-up on something that had no side effect.
 */
const WRITE_VERBS = new Set([
  'connect', 'disconnect', 'patch', 'set', 'apply', 'add', 'remove', 'update',
  'rescan', 'start', 'stop', 'cancel', 'retry', 'clear', 'pause', 'resume',
  'enqueue', 'enqueueFolder', 'organise', 'save', 'delete', 'reset', 'import',
]);

export function requestBudget(cmd: string): number {
  const verb = cmd.slice(cmd.lastIndexOf('.') + 1);
  return WRITE_VERBS.has(verb) ? WRITE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}
/** Reconnect backoff. Capped so a sidecar that died does not spin the CPU. */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

export function createSidecarClient(endpoint: SidecarEndpoint): SidecarClient {
  const url = `ws://${endpoint.host}:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`;

  let ws: WebSocket | null = null;
  let phase: ConnectionPhase = 'closed';
  let attempts = 0;
  let closedByUs = false;
  let reconnectTimer = 0;
  let nextId = 1;

  const pending = new Map<string, Pending>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const phaseListeners = new Set<(p: ConnectionPhase) => void>();

  /* ---- the active search, if any ---- */
  let searchId: number | null = null;
  let handlers: SidecarHandlers | null = null;
  let running = false;

  /** Local subscribe, used by `whenOpen` before the public object exists. */
  function onPhase(fn: (p: ConnectionPhase) => void): () => void {
    phaseListeners.add(fn);
    fn(phase);
    return () => phaseListeners.delete(fn);
  }

  function setPhase(next: ConnectionPhase): void {
    if (phase === next) return;
    phase = next;
    for (const fn of phaseListeners) fn(next);
  }

  function emit(event: string, data: unknown): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) fn(data);
  }

  function connect(): void {
    if (closedByUs) return;
    setPhase('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      attempts = 0;
      setPhase('open');
      // Identify immediately. The reply carries the core version and the live
      // connection state, which is what the UI needs before it can say anything
      // truthful about whether search will work.
      void request<{
        connection?: unknown;
        sidecarVersion?: string;
        coreVersion?: string;
        logPath?: string;
      }>('hello', {
        protocolVersion: 1, client: 'seek-app',
      }).then((result) => {
        /* The handshake has always carried these three and always thrown them
         * away. They are exactly what a bug report needs, and the log path is
         * otherwise buried inside an .app bundle where nobody would find it. */
        diagnostics = {
          sidecarVersion: result?.sidecarVersion ?? '',
          coreVersion: result?.coreVersion ?? '',
          logPath: result?.logPath ?? '',
        };
        /* Replay the handshake's connection snapshot as if it were an event.
         *
         * HelloResult carries the login state precisely so a client never has
         * to guess after connecting, and it was being dropped: the stores only
         * listened for `connection.state`, which the sidecar emits when the
         * state CHANGES. Connect to an already-signed-in sidecar and no change
         * ever comes, so the sidebar read "Not signed in" — and the search
         * empty state offered to explain how to sign in — while searches were
         * running perfectly well against the live network. */
        if (result?.connection) emit('connection.state', result.connection);
      }).catch(() => {
        /* A failed hello is surfaced through the phase, not thrown at the UI. */
      });
    };

    socket.onmessage = (event) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return; // A malformed frame is the sidecar's bug; do not take the UI down.
      }
      if (typeof frame.ev === 'string') {
        handleEvent(frame.ev, frame.data);
        return;
      }
      const id = typeof frame.id === 'string' ? frame.id : null;
      if (!id) return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      window.clearTimeout(waiter.timer);
      if (frame.ok === true) {
        waiter.resolve(frame.result ?? {});
      } else {
        const err = (frame.error ?? {}) as { code?: string; message?: string };
        waiter.reject(new Error(`${err.code ?? 'error'}: ${err.message ?? 'sidecar error'}`));
      }
    };

    socket.onclose = () => {
      ws = null;
      // Every in-flight request is now unanswerable. Reject rather than leave
      // callers hanging on a promise that can never settle.
      for (const [id, waiter] of pending) {
        window.clearTimeout(waiter.timer);
        waiter.reject(new Error('sidecar connection closed'));
        pending.delete(id);
      }
      // A search cannot survive the socket. Tell the store so it stops showing
      // a spinner for a stream that will never arrive (RECON.md §3: there is no
      // completion signal, so silence is indistinguishable from a dead socket).
      if (running && handlers) {
        running = false;
        handlers.onClosed({
          searchId: searchId ?? 0,
          reason: 'disconnected',
          resultCount: 0,
          peerCount: 0,
        });
      }
      searchId = null;
      setPhase('closed');
      scheduleReconnect();
    };

    socket.onerror = () => {
      /* `onclose` always follows; handle it there so the logic lives once. */
    };
  }

  function scheduleReconnect(): void {
    if (closedByUs || reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
    attempts += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0;
      connect();
    }, delay);
  }

  function handleEvent(name: string, data: unknown): void {
    if (name === 'search.result') {
      const d = data as WireSearchResultData;
      // Results from a superseded search must not leak into the current one.
      if (running && handlers && d.searchId === searchId) handlers.onResult(d);
    } else if (name === 'search.closed') {
      const d = data as WireSearchClosedData;
      if (running && handlers && d.searchId === searchId) {
        running = false;
        handlers.onClosed(d);
      }
    } else if (name === 'search.failed') {
      const d = data as { searchId?: number };
      if (running && handlers && d.searchId === searchId) {
        running = false;
        handlers.onClosed({
          searchId: searchId ?? 0, reason: 'stopped', resultCount: 0, peerCount: 0,
        });
      }
    }
    emit(name, data);
  }

  /**
   * Wait for the socket, up to `ms`. Resolves false if it never opens.
   *
   * This exists because every store fires its initial request the moment the
   * client OBJECT exists, which is before the socket has finished connecting.
   * Rejecting there meant those loads failed silently — the sidecar held a
   * 2,417-release index while the UI showed "Not scanned yet", because one
   * `library.state` on mount lost a race and nothing ever asked again.
   */
  function whenOpen(ms: number): Promise<boolean> {
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
    if (closedByUs) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => { off(); resolve(false); }, ms);
      const off = onPhase((p) => {
        if (p !== 'open') return;
        window.clearTimeout(timer);
        off();
        resolve(true);
      });
    });
  }

  function request<T>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = `r${nextId++}`;
    return new Promise<T>((resolve, reject) => {
      /* The clock starts when the command goes ON THE WIRE, not when it was
       * asked for. Starting it first was a real bug and not a subtle one: the
       * outer timer and `whenOpen`'s were both 15 s and the outer one was
       * registered first, so it always won — `'sidecar not connected'` could
       * never be reported, and a shell with no engine at all said "timed out
       * waiting for connection.connect" instead. One message meant both "the
       * engine is busy" and "there is no engine", which are opposite problems. */
      void whenOpen(REQUEST_TIMEOUT_MS).then((open) => {
        const socket = ws;
        if (!open || !socket || socket.readyState !== WebSocket.OPEN) {
          pending.delete(id);
          reject(new Error('sidecar not connected'));
          return;
        }
        const timer = window.setTimeout(() => {
          pending.delete(id);
          /* Deliberately not "failed". While the socket is open the engine is
           * alive and the command is queued on its main thread, so the honest
           * report is that it has not answered YET. `onclose` is what turns an
           * outstanding request into a real failure. */
          reject(new EngineBusyError(cmd));
        }, requestBudget(cmd));
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        socket.send(JSON.stringify({ id, cmd, params }));
      });
    });
  }

  /* Deliberately NOT connecting here. Construction must have no side effects:
   * React double-invokes `useMemo` factories in development to surface impure
   * ones, so connecting during construction opens a socket for a client that is
   * then discarded, and that orphan reconnects forever. The effect calls
   * `open()`. */

  return {
    get running() {
      return running;
    },
    get phase() {
      return phase;
    },

    setRate() {
      /* Replay rate is a fixture concept. The network sets its own pace. */
    },

    start(query: string, next: SidecarHandlers) {
      handlers = next;
      running = true;
      searchId = null;
      next.onStarted?.(query);

      // Every key must be present. `Optional` in the sidecar's schema means
      // NULLABLE, not omittable — `validate_struct` rejects a missing key even
      // when the field is documented as defaulting. It also rejects unknown
      // keys, so this object must match the struct exactly.
      void request<{ searchId: number }>('search.start', {
        query,
        mode: 'global',
        room: null,
        users: [],
        resultCap: null,
        timeoutSeconds: null,
      })
        .then((result) => {
          if (!running) {
            // Stopped while the command was in flight — cancel it rather than
            // leaving an orphaned search running on the network.
            void request('search.stop', { searchId: result.searchId }).catch(() => {});
            return;
          }
          searchId = result.searchId;
        })
        .catch((error: Error) => {
          running = false;
          handlers?.onClosed({
            searchId: 0,
            reason: error.message.startsWith('not_connected') ? 'disconnected' : 'stopped',
            resultCount: 0,
            peerCount: 0,
          });
        });
    },

    stop() {
      const id = searchId;
      running = false;
      searchId = null;
      if (id !== null) void request('search.stop', { searchId: id }).catch(() => {});
    },

    request,

    on(event, fn) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return () => set?.delete(fn);
    },

    onPhase,

    open() {
      if (!closedByUs && (ws || reconnectTimer)) return;
      closedByUs = false;
      attempts = 0;
      if (!ws) connect();
    },

    close() {
      closedByUs = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = 0;
      const socket = ws;
      ws = null;
      // Drop the handlers first: `onclose` would otherwise fire the reconnect
      // path and the disconnected-search callback for a teardown we asked for.
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
      setPhase('closed');
    },
  };
}

/* ------------------------------------------------------------- endpoint --- */

declare global {
  interface Window {
    /** Injected by the Tauri shell once it has spawned the sidecar. */
    __SEEK_SIDECAR__?: SidecarEndpoint;
  }
}

/**
 * Where the sidecar is, or null if we should stay on mock data.
 *
 * Two sources, in order:
 *   1. `window.__SEEK_SIDECAR__`, injected by the Tauri shell.
 *   2. `?sidecar=host:port&token=…` on the URL — how you drive a manually
 *      started sidecar from the dev server, which is the fastest way to test
 *      against the real network without a Rust build.
 *
 * Returning null is not a failure. It is the documented offline mode, and the
 * sidebar says so plainly rather than pretending to be connected.
 */
export function resolveSidecarEndpoint(): SidecarEndpoint | null {
  if (typeof window === 'undefined') return null;

  const injected = window.__SEEK_SIDECAR__;
  if (injected?.host && injected.port && injected.token) return injected;

  const params = new URLSearchParams(window.location.search);
  const target = params.get('sidecar');
  const token = params.get('token');
  if (!target || !token) return null;

  const [host, portText] = target.split(':');
  const port = Number(portText);
  if (!host || !Number.isFinite(port) || port <= 0) return null;

  return { host, port, token };
}

/** What the sidecar said about itself at handshake time. */
export interface Diagnostics {
  sidecarVersion: string;
  coreVersion: string;
  /** Absolute path to the diagnostic log, or '' when there is none. */
  logPath: string;
}

let diagnostics: Diagnostics = { sidecarVersion: '', coreVersion: '', logPath: '' };

/**
 * The last handshake's diagnostics.
 *
 * A plain module value rather than a store: written once per connection, read
 * by one screen, and unchanged in between.
 */
export function sidecarDiagnostics(): Diagnostics {
  return diagnostics;
}

/** True when running inside the Tauri shell rather than a plain browser tab. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Ask the Tauri shell where it put the sidecar. Returns null outside Tauri, or
 * when the shell could not start one — in which case `sidecarStartupError()`
 * explains why, so the UI can say what went wrong instead of just looking
 * offline.
 */
let invokeFailure: string | null = null;

export async function requestTauriEndpoint(): Promise<SidecarEndpoint | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const endpoint = await invoke<SidecarEndpoint | null>('sidecar_endpoint');
    if (endpoint?.host && endpoint.port && endpoint.token) return endpoint;
  } catch (e) {
    // Do NOT swallow this. A failed invoke looks exactly like "no sidecar",
    // so silently falling back to recorded data hides a broken shell behind a
    // working-looking app. Tauri v2 denies every command unless a capability
    // grants it, and that failure lands here.
    invokeFailure = `The app could not reach its own backend: ${(e as Error).message}`;
    console.error('[seek] sidecar_endpoint invoke failed', e);
  }
  return null;
}

export async function sidecarStartupError(): Promise<string | null> {
  if (!isTauri()) return null;
  if (invokeFailure) return invokeFailure;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('sidecar_error');
  } catch (e) {
    return `The app could not reach its own backend: ${(e as Error).message}`;
  }
}
