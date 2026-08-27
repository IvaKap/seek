/*
 * Seek — transfers, both directions.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ONE STREAM, TWO LISTS. Downloads and uploads arrive on the same
 * `transfer.*` events carrying a `direction`, because they are the same kind
 * of thing and group the same way — a peer fetching a whole folder from you is
 * a release just as much as one you are fetching. They are split here rather
 * than in the sidecar, and the id carries the direction so the two can never
 * collide (`registries.transfer_key`).
 *
 * `groups`, `all` and `activeCount` are the DOWNLOAD half, because every
 * existing caller means downloads by them — the sidebar badge, the notifier,
 * the command palette. Uploads are `uploadGroups` and `uploadCount`.
 *
 * docs/PRODUCT.md §7: a download is a RELEASE, not a row per file. The sidecar
 * emits one Transfer per file because that is what the protocol does; grouping
 * them back into releases is this file's job, and it is the same discipline as
 * everywhere else — Python emits raw facts, TypeScript decides how they read.
 *
 * Grouping key is the remote parent folder, which is also what the peer used to
 * organise them, so it survives paths that carry no usable metadata.
 *
 * `transfer.updated` arrives roughly once a second per active transfer, so
 * state is held in a ref and published on a throttled tick. Re-rendering the
 * whole list per packet is exactly the jitter the brief forbids.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';

export type TransferState =
  | 'queued' | 'getting_status' | 'transferring' | 'paused' | 'cancelled'
  | 'filtered' | 'finished' | 'user_logged_off' | 'connection_closed'
  | 'connection_timeout' | 'download_folder_error' | 'local_file_error'
  | 'unknown';

export type TransferDirection = 'download' | 'upload';

export interface Transfer {
  id: string;
  /** Which way it is going. Downloads and uploads share this one type. */
  direction: TransferDirection;
  username: string;
  path: string;
  localFolder: string | null;
  size: number;
  bytesDone: number;
  state: TransferState;
  speed: number;
  averageSpeed: number;
  queuePosition: number | null;
  secondsLeft: number | null;
  secondsElapsed: number;
  stalled: boolean;
  /** Seconds since bytesDone last moved, AS OF WHEN THE SIDECAR SENT THIS. */
  secondsSinceProgress: number;
  /** Epoch seconds this first read finished, null while it has not. */
  finishedAt: number | null;
  error: string | null;

  /* Frontend-only, not on the wire. `secondsSinceProgress` is a snapshot, and a
   * transfer that has gone quiet sends nothing more by definition — that is what
   * being quiet means — so the snapshot is the last thing we will ever hear.
   * Stamping arrival is what lets `silenceSeconds` keep counting afterwards
   * instead of freezing at whatever the last event happened to say. */
  seenAt?: number;
}

/**
 * How long this transfer has been silent, right now.
 *
 * The sidecar's number plus however long we have held it. Not `secondsElapsed`,
 * which counts from the START of the transfer and keeps rising for one that is
 * downloading perfectly well.
 */
export function silenceSeconds(t: Transfer, now: number): number {
  return t.secondsSinceProgress + Math.max(0, (now - (t.seenAt ?? now)) / 1000);
}

export interface TransferGroup {
  key: string;
  username: string;
  /** Remote parent folder, and the closest thing to a release name we have. */
  folder: string;
  title: string;
  transfers: Transfer[];
  size: number;
  bytesDone: number;
  speed: number;
  active: number;
  finished: number;
  failed: number;
  stalled: boolean;
  /** Silence of the LIVELIEST unfinished file, in seconds. See `group`. */
  quietFor: number;
  state: 'active' | 'finished' | 'failed' | 'paused' | 'queued' | 'cancelled' | 'stalled';
}

const ACTIVE: TransferState[] = ['queued', 'getting_status', 'transferring'];
const FAILED: TransferState[] = [
  'user_logged_off', 'connection_closed', 'connection_timeout',
  'download_folder_error', 'local_file_error',
];

export const isActive = (s: TransferState) => ACTIVE.includes(s);
export const isFailed = (s: TransferState) => FAILED.includes(s);
/* `cancelled` and `filtered` are terminal but not failures. They previously
 * matched none of the buckets below and fell through to 'queued', so a
 * cancelled download sat in Downloads looking exactly as it had before —
 * which is why Cancel appeared to do nothing at all. */
export const isCancelled = (s: TransferState) => s === 'cancelled' || s === 'filtered';

/** Nothing more will happen to it: finished, failed, or given up on by someone.
 *  Used to decide which files can be "quiet" — a finished file is silent
 *  forever, and counting it would sweep every completed release into Failed. */
export const isTerminal = (s: TransferState) => (
  s === 'finished' || isFailed(s) || isCancelled(s)
);

/** Split a remote virtual path on the backslash Soulseek actually uses. */
function splitPath(path: string): { folder: string; name: string } {
  const norm = path.replace(/\//g, '\\');
  const i = norm.lastIndexOf('\\');
  return i < 0
    ? { folder: '', name: norm }
    : { folder: norm.slice(0, i), name: norm.slice(i + 1) };
}

export function fileName(path: string): string {
  return splitPath(path).name;
}

function groupOf(t: Transfer): string {
  return `${t.username}\0${splitPath(t.path).folder}`;
}

/**
 * Group into releases, and decide which have gone quiet.
 *
 * `quietSeconds` is the give-up threshold, 0 for never. A group crosses it only
 * when EVERY unfinished file in it has been silent that long: one file still
 * moving means the release is still arriving, and burying it in Failed because
 * its siblings are queued behind it would hide a working download.
 *
 * This is a DERIVATION, deliberately, and nothing here is remembered. A stalled
 * download keeps its place in the peer's queue and very often resumes hours
 * later; the moment a byte moves, `secondsSinceProgress` resets at the source
 * and the group reappears in Downloads on its own. A stored "gave up" flag
 * could not do that — it would have to be cleared by something, and nothing
 * would be watching.
 */
export function group(transfers: Transfer[], quietSeconds = 0, now = Date.now()): TransferGroup[] {
  const map = new Map<string, Transfer[]>();
  for (const t of transfers) {
    const k = groupOf(t);
    const list = map.get(k);
    if (list) list.push(t);
    else map.set(k, [t]);
  }

  const out: TransferGroup[] = [];
  for (const [key, list] of map) {
    const [username] = key.split('\0');
    const folder = splitPath(list[0].path).folder;
    const segments = folder.split('\\').filter(Boolean);
    const active = list.filter((t) => isActive(t.state)).length;
    const finished = list.filter((t) => t.state === 'finished').length;
    const failed = list.filter((t) => isFailed(t.state)).length;
    const paused = list.filter((t) => t.state === 'paused').length;
    const cancelled = list.filter((t) => isCancelled(t.state)).length;

    /* Only unfinished files can be quiet — a finished one is silent forever and
     * counting it would drag every completed release into Failed. */
    const unfinished = list.filter((t) => !isTerminal(t.state));
    const quietFor = unfinished.length === 0
      ? 0
      : Math.min(...unfinished.map((t) => silenceSeconds(t, now)));
    const gaveUp = quietSeconds > 0 && unfinished.length > 0 && quietFor >= quietSeconds;

    out.push({
      key,
      username,
      folder,
      title: segments[segments.length - 1] || folder || username,
      transfers: list,
      size: list.reduce((n, t) => n + t.size, 0),
      bytesDone: list.reduce((n, t) => n + t.bytesDone, 0),
      speed: list.reduce((n, t) => n + t.speed, 0),
      active, finished, failed,
      stalled: list.some((t) => t.stalled),
      quietFor,
      /* BEFORE `active`, and that ordering is the whole feature: a transfer
       * that has gone quiet is still `transferring` as far as upstream is
       * concerned, so `active > 0` is true and would win every time. */
      state: gaveUp ? 'stalled'
        : active > 0 ? 'active'
        : failed > 0 ? 'failed'
          : paused > 0 ? 'paused'
            : cancelled > 0 && finished === 0 ? 'cancelled'
              : finished === list.length ? 'finished' : 'queued',
    });
  }

  // Active first — the thing you are waiting on should not be below the
  // hundred files that already finished.
  const rank = {
    active: 0, queued: 1, paused: 2, stalled: 3, failed: 4, cancelled: 5, finished: 6,
  } as const;
  return out.sort((a, b) => rank[a.state] - rank[b.state] || a.title.localeCompare(b.title));
}

const PUBLISH_MS = 400;
/* How often to re-derive when a give-up threshold is set. A minute is far finer
 * than any threshold worth setting (the smallest offered is 5 minutes), and the
 * work is one grouping pass, so there is nothing to gain by tuning it. */
const QUIET_SWEEP_MS = 60_000;

export interface TransferSession {
  /** Downloads, grouped into releases. */
  groups: TransferGroup[];
  /** Every download, ungrouped. */
  all: Transfer[];
  /** Active downloads. Drives the sidebar badge. */
  activeCount: number;
  /** Uploads, grouped the same way — a peer taking a folder is a release too. */
  uploadGroups: TransferGroup[];
  /** Uploads actually running or queued right now. */
  uploadCount: number;
  enqueue(username: string, path: string, size: number): Promise<void>;
  enqueueFolder(username: string, folderPath: string): Promise<void>;
  pause(ids: string[]): void;
  resume(ids: string[]): void;
  cancel(ids: string[]): void;
  retry(ids: string[]): void;
  clear(ids: string[]): void;
  /** Last enqueue failure, for a toast. Cleared on the next attempt. */
  error: string | null;
  /** Something worth saying that is not a failure, e.g. "already queued". */
  note: string | null;
}

export function useTransfers(
  client: SidecarClient | null,
  /** Give-up threshold in seconds; 0 never gives up. From Settings. */
  quietSeconds = 0,
  /** Forget completed records older than this many days; 0 keeps them. */
  clearCompletedDays = 0,
): TransferSession {
  const byId = useRef<Map<string, Transfer>>(new Map());
  const [groups, setGroups] = useState<TransferGroup[]>([]);
  const [uploadGroups, setUploadGroups] = useState<TransferGroup[]>([]);
  const [all, setAll] = useState<Transfer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dirty = useRef(false);
  /* In a ref, not a dep: `publish` is rebuilt by nothing, and threading the
   * threshold through its deps would tear down the event subscriptions every
   * time the setting changed. */
  const quiet = useRef(quietSeconds);
  quiet.current = quietSeconds;
  const clearDays = useRef(clearCompletedDays);
  clearDays.current = clearCompletedDays;

  const publish = useCallback(() => {
    const list = [...byId.current.values()];
    /* Split before grouping. Grouping keys on username + folder, and a peer
     * you are trading with in both directions at once would otherwise land
     * both halves in one release row. */
    const downloads = list.filter((t) => t.direction !== 'upload');
    const uploads = list.filter((t) => t.direction === 'upload');
    const now = Date.now();
    setAll(downloads);
    setGroups(group(downloads, quiet.current, now));
    /* Uploads are never reclassified. A peer who stops taking a file from you
     * is their problem, not a download of yours that needs cleaning up, and
     * `uploads.py` has no paused or stalled state to reason about anyway. */
    setUploadGroups(group(uploads, 0, now));
  }, []);

  useEffect(() => {
    if (!client) return;

    const onAdded = (data: unknown) => {
      const t = data as Transfer;
      byId.current.set(t.id, { ...t, seenAt: Date.now() });
      dirty.current = true;
    };
    const onUpdated = (data: unknown) => {
      const t = data as Transfer;
      byId.current.set(t.id, { ...byId.current.get(t.id), ...t, seenAt: Date.now() });
      dirty.current = true;
    };
    const onRemoved = (data: unknown) => {
      for (const id of (data as { transferIds: string[] }).transferIds ?? []) {
        byId.current.delete(id);
      }
      dirty.current = true;
    };

    const off = [
      client.on('transfer.added', onAdded),
      client.on('transfer.updated', onUpdated),
      client.on('transfer.removed', onRemoved),
    ];

    // Snapshot on connect, so downloads already running in a restarted sidecar
    // appear instead of the list looking empty until something changes.
    void client.request<{ transfers: Transfer[] }>('transfer.list')
      .then((r) => {
        const at = Date.now();
        for (const t of r.transfers ?? []) byId.current.set(t.id, { ...t, seenAt: at });
        publish();
      })
      .catch(() => {});

    // Progress arrives ~1/sec per transfer. Publishing per packet would rerender
    // the list dozens of times a second for no visible gain.
    const timer = window.setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      publish();
    }, PUBLISH_MS);

    /* A transfer that has gone quiet sends NOTHING — that is what quiet means —
     * so `dirty` never gets set and the tick above would never re-derive. The
     * threshold would then be crossed by a clock nobody was reading. This is
     * the clock: cheap, because grouping is a sweep over a few hundred rows,
     * and only running at all when a threshold is set. */
    const sweep = window.setInterval(() => {
      /* Reads the REF, not the parameter. Putting `quietSeconds` in this
       * effect's deps would tear down and rebuild every event subscription each
       * time the setting changed; closing over it without doing so would leave
       * the sweep permanently off for anyone who switched it on after launch. */
      if (quiet.current > 0) publish();

      /* Forgetting old completed downloads. Rides the same tick because it
       * needs the same thing — a clock nobody else is reading — and because a
       * finished transfer, like a quiet one, sends no further events to hang
       * this off.
       *
       * Downloads only. An upload record is the history of someone taking a
       * file from you, and "my Completed list is crowded" is not a reason to
       * discard it. Only rows with a REAL `finishedAt` are eligible: a null
       * means the sidecar never saw it finish, and guessing an age for it is
       * how this would delete something it should not. */
      const days = clearDays.current;
      if (days > 0) {
        const cutoff = Date.now() / 1000 - days * 86_400;
        const stale = [...byId.current.values()]
          .filter((t) => (
            t.direction !== 'upload'
            && t.state === 'finished'
            && t.finishedAt !== null
            && t.finishedAt < cutoff
          ))
          .map((t) => t.id);
        if (stale.length > 0) {
          void client.request('transfer.clear', { transferIds: stale }).catch(() => {});
        }
      }
    }, QUIET_SWEEP_MS);

    return () => {
      for (const fn of off) fn();
      window.clearInterval(timer);
      window.clearInterval(sweep);
    };
  }, [client, publish]);

  const cmd = useCallback((name: string, params: Record<string, unknown>) => {
    void client?.request(name, params).catch((e: Error) => setError(e.message));
  }, [client]);

  const enqueue = useCallback(async (username: string, path: string, size: number) => {
    if (!client) return;
    setError(null);
    try {
      // Every key must be present — `Optional` in the sidecar's schema means
      // nullable, not omittable, and validate_struct rejects both missing and
      // unknown keys. This is the same trap that broke search.start.
      const r = await client.request<{ transferId: string; alreadyQueued: boolean }>(
        'transfer.enqueue',
        { username, path, size, file: null, destination: null, paused: false },
      );
      // Pressing Get on something already queued is upstream's silent no-op —
      // it returns before emitting anything. The row now appears regardless
      // (the sidecar emits it), but saying so is the difference between "the
      // button is broken" and "you already asked for this".
      if (r.alreadyQueued) setNote('Already in your downloads.');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client]);

  const enqueueFolder = useCallback(async (username: string, folderPath: string) => {
    if (!client) return;
    setError(null);
    try {
      await client.request('transfer.enqueueFolder', {
        username, folderPath, recurse: false, destination: null,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client]);

  return {
    groups, all,
    activeCount: all.filter((t) => isActive(t.state)).length,
    uploadGroups,
    /* Counted off the grouped list because `all` is downloads only. Active
     * means running or queued — a finished upload is history, not activity. */
    uploadCount: uploadGroups.reduce((n, g) => n + g.active, 0),
    enqueue, enqueueFolder,
    pause: (ids) => cmd('transfer.pause', { transferIds: ids }),
    resume: (ids) => cmd('transfer.resume', { transferIds: ids }),
    cancel: (ids) => cmd('transfer.cancel', { transferIds: ids }),
    retry: (ids) => cmd('transfer.retry', { transferIds: ids }),
    clear: (ids) => cmd('transfer.clear', { transferIds: ids }),
    error,
    note,
  };
}
