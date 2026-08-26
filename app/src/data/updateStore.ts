/*
 * Seek — checking whether a newer build exists, and installing it on request.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * WHY THIS EXISTS AT ALL, given the app could just tell people to download the
 * new zip: because macOS records the "Open Anyway" approval inside the
 * quarantine attribute of ONE SPECIFIC BUNDLE. Replace the bundle by hand and
 * the replacement arrives with a fresh quarantine record, so the whole
 * System Settings dance repeats on every single update.
 *
 * A file the app downloads itself is never quarantined — quarantine is applied
 * by the DOWNLOADING program, and only browsers, Mail and AirDrop opt into it.
 * Measured: a curl download carries `com.apple.provenance` and nothing else.
 * So a self-update sidesteps Gatekeeper entirely, and after one manual install
 * nobody ever has to think about it again.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is install anything on its own. The
 * signature is verified by the plugin before a byte is written, but *whether*
 * to restart in the middle of a queue of downloads is not the app's call. It
 * asks, once, and then stays out of the way.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from './sidecarClient.ts';

export type UpdatePhase =
  /** Nothing known yet, or nothing to report. */
  | 'idle'
  /** A newer version exists and the user has not answered. */
  | 'available'
  /** Fetching it. `progress` is 0–1 when the server states a length. */
  | 'downloading'
  /** On disk and verified. The next launch is the new version. */
  | 'ready'
  /** The check or the download failed. `error` says how. */
  | 'failed';

export interface UpdateState {
  phase: UpdatePhase;
  /** The version being offered, e.g. "0.2.2". Empty until one is. */
  version: string;
  /** Release notes, when the manifest carries them. */
  notes: string;
  /** 0–1, or null when the download length is unknown. */
  progress: number | null;
  error: string;
}

const IDLE: UpdateState = {
  phase: 'idle', version: '', notes: '', progress: null, error: '',
};

/**
 * How long to wait after launch before asking.
 *
 * Not zero. The first seconds after launch are spent starting the engine,
 * signing in and restoring transfers, and a network call competing with that
 * makes the app feel slower for a message that is almost always "you are up to
 * date". Nothing here is urgent.
 */
const CHECK_DELAY_MS = 8000;

export function useUpdates(): UpdateState & {
  install: () => void;
  dismiss: () => void;
} {
  const [state, setState] = useState<UpdateState>(IDLE);
  /* The plugin's Update handle. Held rather than re-fetched, because
   * downloadAndInstall() must be called on the same object check() returned. */
  const handle = useRef<unknown>(null);
  const busy = useRef(false);

  useEffect(() => {
    // A browser tab has no bundle to replace. The dev recipe in CLAUDE.md runs
    // this exact frontend with no Tauri shell under it, so this is a real case
    // rather than defensive habit.
    if (!isTauri()) return undefined;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { check } = await import('@tauri-apps/plugin-updater');
          const update = await check();
          if (cancelled || !update) return;
          handle.current = update;
          setState({
            phase: 'available',
            version: update.version ?? '',
            notes: update.body ?? '',
            progress: null,
            error: '',
          });
        } catch (e) {
          // Being unable to reach GitHub is the ordinary case on a flaky
          // connection and is not worth a banner — the app works fine without
          // updating. Recorded in state so Settings can say so if it ever asks,
          // but the banner below only renders for 'available' and later.
          if (cancelled) return;
          setState({
            ...IDLE, phase: 'failed', error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
    }, CHECK_DELAY_MS);

    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const install = useCallback(() => {
    const update = handle.current as {
      downloadAndInstall: (cb: (e: DownloadEvent) => void) => Promise<void>;
    } | null;
    if (!update || busy.current) return;
    busy.current = true;

    void (async () => {
      let total = 0;
      let got = 0;
      try {
        setState((p) => ({ ...p, phase: 'downloading', progress: null, error: '' }));
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? 0;
            got = 0;
          } else if (event.event === 'Progress') {
            got += event.data.chunkLength ?? 0;
            // A server that states no length is not an error; it just means no
            // bar. Reporting a made-up percentage would be worse than none.
            setState((p) => ({ ...p, progress: total > 0 ? got / total : null }));
          }
        });
        setState((p) => ({ ...p, phase: 'ready', progress: 1 }));

        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      } catch (e) {
        busy.current = false;
        setState((p) => ({
          ...p, phase: 'failed', error: e instanceof Error ? e.message : String(e),
        }));
      }
    })();
  }, []);

  const dismiss = useCallback(() => {
    // Only for this run. The offer returns next launch, which is the right
    // cadence: persisting a "no" risks someone never being told again about a
    // build that fixes the thing they are about to hit.
    setState(IDLE);
    handle.current = null;
  }, []);

  return { ...state, install, dismiss };
}

/** The shape the plugin reports download progress in. */
type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength?: number } }
  | { event: 'Finished'; data?: unknown };
