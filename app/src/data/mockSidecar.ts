/*
 * Seek — replay a recorded search session at realistic timings.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This is what lets the motion be tuned without a network. It replays core's
 * `fixtures/search-burial.ndjson` at the recorded offsets: front-loaded, then
 * trailing for thirty-five seconds, exactly like the real protocol.
 *
 * It deliberately does NOT batch. Batching is a rendering concern and lives in
 * the store, because the real sidecar will not batch for us either.
 */

import type { WireFrame, WireSearchClosedData, WireSearchResultData } from './adapt.ts';
import { recordSession } from './fixture.ts';

export interface RecordedLine {
  offsetMs: number;
  frame: WireFrame;
}

export interface SidecarHandlers {
  onResult(data: WireSearchResultData): void;
  onClosed(data: WireSearchClosedData): void;
  onStarted?(query: string): void;
}

export interface Sidecar {
  start(query: string, handlers: SidecarHandlers): void;
  stop(): void;
  /** Replay faster or slower. 1 = as recorded. */
  setRate(rate: number): void;
  readonly running: boolean;
}

/* -------------------------------------------------------------- the fixture */

let cached: RecordedLine[] | null = null;

/**
 * Core's fixture is the source of truth. It is loaded as a raw string through
 * Vite's `?raw` import so there is no build step and no copy — the file on disk
 * is the file replayed.
 */
async function loadRecording(): Promise<RecordedLine[]> {
  if (cached) return cached;

  // Dev harness: `?scale=5000` replaces core's recording with a synthetic
  // session of that many files, so the 5,000-result performance budget can be
  // exercised. The real fixture is 995 audio files, which is a realistic search
  // but not a stress test.
  const scale = Number(new URLSearchParams(window.location.search).get('scale') ?? 0);
  if (scale > 0) {
    cached = synthesise(scale);
    return cached;
  }
  try {
    const mod = await import('../../../fixtures/search-burial.ndjson?raw');
    const text = (mod as { default: string }).default;
    const lines: RecordedLine[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        lines.push(JSON.parse(t) as RecordedLine);
      } catch {
        // A malformed line is core's to fix, not ours to paper over. Skip it and
        // keep going so one bad record cannot blank the whole session.
      }
    }
    if (lines.length > 0) {
      cached = lines;
      return lines;
    }
  } catch {
    // Fixture not present or not readable — fall through to the local generator.
  }
  cached = synthesise();
  return cached;
}

/** Fallback used when core's fixture cannot be read, and by the scale harness. */
function synthesise(targetFiles = 1100): RecordedLine[] {
  const session = recordSession('burial', { targetFiles });
  const lines: RecordedLine[] = [
    { offsetMs: 0, frame: { ev: 'search.started', data: { searchId: 1, query: session.query } } },
  ];
  for (const r of session.responses) {
    lines.push({
      offsetMs: r.at,
      frame: {
        ev: 'search.result',
        data: {
          searchId: 1,
          peer: {
            username: r.response.user,
            freeSlots: r.response.userStats.freeSlots,
            advertisedSpeed: r.response.userStats.advertisedSpeed,
            queueLength: r.response.userStats.queueLength,
          },
          files: r.response.files.map((f) => ({
            path: f.path,
            size: f.size,
            bitrate: f.bitrate,
            duration: f.duration,
            sampleRate: f.sampleRate,
            bitDepth: f.bitDepth,
            isVbr: f.isVbr,
          })),
        },
      },
    });
  }
  return lines;
}

/** How many files a recording contains, for the perf harness. */
export async function recordingSize(): Promise<number> {
  const lines = await loadRecording();
  let n = 0;
  for (const l of lines) {
    if (l.frame.ev === 'search.result') n += (l.frame.data as WireSearchResultData).files.length;
  }
  return n;
}

/* --------------------------------------------------------------- the replay */

export function createMockSidecar(): Sidecar {
  let timers: number[] = [];
  let running = false;
  let rate = 1;
  /* Generation token. `loadRecording()` is async, so a start/stop/start cycle —
   * which React StrictMode performs on every mount — could otherwise let a
   * SUPERSEDED load resolve after the restart and schedule a second full set of
   * timers against a live session. That ingests the whole recording twice. The
   * boolean `running` flag cannot catch it, because by then it is true again. */
  let generation = 0;

  function clear(): void {
    for (const t of timers) window.clearTimeout(t);
    timers = [];
  }

  return {
    get running() {
      return running;
    },
    setRate(r: number) {
      rate = Math.max(0.05, r);
    },
    start(query: string, handlers: SidecarHandlers) {
      clear();
      running = true;
      const gen = ++generation;
      handlers.onStarted?.(query);

      void loadRecording().then((lines) => {
        if (!running || gen !== generation) return;
        let lastOffset = 0;
        let sawClosed = false;

        for (const line of lines) {
          const delay = line.offsetMs / rate;
          lastOffset = Math.max(lastOffset, delay);
          const ev = line.frame.ev;
          if (ev === 'search.result') {
            timers.push(
              window.setTimeout(() => {
                if (running && gen === generation) {
                  handlers.onResult(line.frame.data as WireSearchResultData);
                }
              }, delay),
            );
          } else if (ev === 'search.closed') {
            sawClosed = true;
            timers.push(
              window.setTimeout(() => {
                if (running && gen === generation) {
                  running = false;
                  handlers.onClosed(line.frame.data as WireSearchClosedData);
                }
              }, delay),
            );
          }
        }

        // There is no completion signal on the network (RECON.md §3), so if the
        // recording carries none either, the client decides when it has stopped
        // listening. Never render this as "this is everything".
        if (!sawClosed) {
          timers.push(
            window.setTimeout(() => {
              if (running && gen === generation) {
                running = false;
                handlers.onClosed({
                  searchId: 0, reason: 'timeout', resultCount: 0, peerCount: 0,
                });
              }
            }, lastOffset + 1500 / rate),
          );
        }
      });
    },
    stop() {
      clear();
      running = false;
      generation++;
    },
  };
}
