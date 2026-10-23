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
import type { FolderContentsEvent, TransferFolderParams } from '../../../shared/protocol.ts';
import type { SidecarClient } from './sidecarClient.ts';
import { readUntilAnswered, reportFailure, showNotice } from './failures.ts';

export type TransferState =
  | 'queued' | 'rejected' | 'getting_status' | 'transferring' | 'paused' | 'cancelled'
  | 'filtered' | 'finished' | 'user_logged_off' | 'connection_closed'
  | 'connection_timeout' | 'download_folder_error' | 'local_file_error'
  | 'unknown';

type TransferDirection = 'download' | 'upload';

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
  // 'rejected' was missing from the type as well as from here, so a download
  // the peer refused ("File not shared.") sat in no lens's idea of failed.
  'rejected',
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

/** A release's first finished file: what Show in Finder and a checksum check start from. */
export const firstFinished = (g: TransferGroup) => g.transfers.find((t) => t.state === 'finished');

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

/* ------------------------------------------------------------- queue badges
 *
 * A search row's Get button reflects what actually happened to the file it
 * queued. The transport keys a transfer on `username + virtual_path`, so the
 * same pair recovered from a search source finds its transfer — if one exists.
 * These derivations are pure so the button's states can be pinned by a test
 * rather than discovered by clicking.
 */

/** What a Get button shows. `idle` = nothing queued (or it was removed). */
export type QueueBadge = 'idle' | 'queued' | 'downloading' | 'paused' | 'done' | 'failed';

/** The stable key for one file: peer + path, on the backslash Soulseek uses. */
export function transferKey(username: string, path: string): string {
  return `${username}\0${path.replace(/\//g, '\\')}`;
}

/** The same key for a whole folder — a release card queues one of these. */
export function folderKey(username: string, folderPath: string): string {
  return `${username}\0${folderPath.replace(/\//g, '\\')}`;
}

/**
 * One file's badge. `cancelled`/`filtered` map to `idle`, not `failed`: a
 * cancel is a stop-and-remove (the row is gone), so the button returns to
 * grabbable rather than claiming a failure that no longer exists.
 */
export function queueBadge(state: TransferState | undefined): QueueBadge {
  if (!state) return 'idle';
  if (state === 'finished') return 'done';
  if (isFailed(state)) return 'failed';
  if (isCancelled(state)) return 'idle';
  if (state === 'paused') return 'paused';
  if (state === 'transferring') return 'downloading';
  return 'queued'; // queued, getting_status
}

/* How badges combine for a folder: the liveliest one wins, so a release with
 * one file still coming down reads "downloading" even as others finish. */
const BADGE_RANK: Record<QueueBadge, number> = {
  downloading: 5, queued: 4, paused: 3, failed: 2, done: 1, idle: 0,
};

interface QueueMaps {
  /** By `transferKey` — one file's exact state, for a track/source/file row. */
  files: Map<string, TransferState>;
  /** By `folderKey` — the liveliest badge across a folder, for a release card. */
  folders: Map<string, QueueBadge>;
}

/**
 * Index every live transfer for O(1) lookup from a search row. Rebuilt each
 * store tick; cheap, because it is one pass over the transfers already in hand.
 */
export function buildQueueMaps(all: Transfer[]): QueueMaps {
  const files = new Map<string, TransferState>();
  const folders = new Map<string, QueueBadge>();
  for (const t of all) {
    files.set(transferKey(t.username, t.path), t.state);
    const fk = groupOf(t);
    const next = queueBadge(t.state);
    const cur = folders.get(fk);
    if (cur === undefined || BADGE_RANK[next] > BADGE_RANK[cur]) folders.set(fk, next);
  }
  return { files, folders };
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

/**
 * The previous objects wherever nothing changed, so React can skip them. A
 * group is the same when its files are the very same objects (the store
 * replaces a transfer's object on every update) and its time-dependent bits
 * agree. Without this every one of 700 finished releases was a new object on
 * every progress tick, and the whole list redrew 2.5 times a second.
 */
export function keepUnchanged(prev: TransferGroup[], next: TransferGroup[]): TransferGroup[] {
  const before = new Map(prev.map((g) => [g.key, g]));
  let same = prev.length === next.length;
  const out = next.map((n, i) => {
    const p = before.get(n.key);
    const kept = p && p.state === n.state && p.quietFor === n.quietFor
      && sameItems(p.transfers, n.transfers) ? p : n;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : out;
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const PUBLISH_MS = 400;
/* How often to re-derive when a give-up threshold is set. A minute is far finer
 * than any threshold worth setting (the smallest offered is 5 minutes), and the
 * work is one grouping pass, so there is nothing to gain by tuning it. It is
 * also the clock the auto-retry below rides, and a minute between re-asks is the
 * point there too — see `autoRetry`. */
const QUIET_SWEEP_MS = 60_000;

/* How many times to auto-retry one file the peer never answered for in time
 * before leaving it for a manual retry. Bounded so a genuinely dead peer is not
 * re-asked forever; the budget refreshes the moment the file actually connects,
 * so this only ever bites a file that keeps timing out without transferring. */
export const MAX_AUTO_RETRIES = 3;

/**
 * Which timed-out downloads to re-ask now, and the retry tallies to carry
 * forward. Pure, so the policy is pinned without timers or a live socket.
 *
 * ONLY `connection_timeout` — pynicotine's "the peer did not answer in time",
 * which is explicitly transient and retryable (see domain/transferStatus.ts).
 * A rejection ("File not shared."), a logged-off peer (which resumes itself)
 * and a dropped connection are all left alone: re-asking them automatically
 * would either be futile or hammer a peer that already said no. Uploads are
 * never touched — a peer giving up on taking a file is not ours to chase.
 *
 * Gentle by construction: this runs on the one-a-minute sweep, so a scatter of
 * timeouts across a big folder is re-asked slowly, never at the fast cadence
 * that gets a client throttled.
 */
export function autoRetry(
  transfers: Transfer[],
  counts: Map<string, number>,
  cap = MAX_AUTO_RETRIES,
): { retry: string[]; counts: Map<string, number> } {
  const next = new Map(counts);
  const retry: string[] = [];
  const present = new Set<string>();

  for (const t of transfers) {
    if (t.direction === 'upload') continue;
    present.add(t.id);
    // The peer answered — the timeout was transient and is resolved, so the
    // budget refreshes for any future, independent timeout on this file.
    if (t.state === 'transferring' || t.state === 'finished') {
      next.delete(t.id);
      continue;
    }
    if (t.state !== 'connection_timeout') continue;
    const n = next.get(t.id) ?? 0;
    if (n >= cap) continue;   // dead peer — leave this one for a manual retry
    next.set(t.id, n + 1);
    retry.push(t.id);
  }

  // Forget tallies for transfers no longer in the list (cleared or removed),
  // so the map cannot grow without bound across a long session.
  for (const id of [...next.keys()]) {
    if (!present.has(id)) next.delete(id);
  }
  return { retry, counts: next };
}

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
  /** `destination` is a folder chosen with Download to…; null is the usual one. */
  enqueue(username: string, path: string, size: number, destination?: string | null): Promise<void>;
  /** `recurse` takes the subfolders too — what a folder whose label counts
   *  everything inside it promises. `count`, when the caller knows it, asks
   *  first past LARGE_FOLDER_FILES: one click should not queue 3,000 files.
   *  A folder that turns out bigger than `count` (a search shows a fraction
   *  of one) is held back by the sidecar and asked about then. */
  enqueueFolder(
    username: string, folderPath: string, recurse?: boolean,
    opts?: { destination?: string | null; count?: number },
  ): Promise<void>;
  /** A folder big enough to ask about first, waiting for an answer. */
  pendingFolder: PendingFolder | null;
  confirmFolder(): void;
  dismissFolder(): void;
  /** Forget finished downloads whose files are gone, except `keep`. */
  forgetMissing(keep: ReadonlySet<string>): void;
  pause(ids: string[]): void;
  resume(ids: string[]): void;
  cancel(ids: string[]): void;
  retry(ids: string[]): void;
  clear(ids: string[]): void;
  /** Last enqueue failure, for a toast. Cleared on the next attempt. */
  error: string | null;
  /** Something worth saying that is not a failure, e.g. "already queued". */
  note: string | null;
  /** Show a finished download in Finder, selected. */
  reveal(id: string): void;
  /** Open a finished download in its default app. */
  open(id: string): void;
  /** Downloads cancelled in the last few seconds, which Undo can ask for again. */
  cancelled: CancelledFile[] | null;
  undoCancel(): void;
}

/** Folders with more files than this ask before queueing — the number
 *  Nicotine+ asks at too (userbrowse.py). */
const LARGE_FOLDER_FILES = 1000;

interface PendingFolder {
  username: string;
  folderPath: string;
  recurse: boolean;
  destination: string | null;
  count: number;
}

/* Questions wait their turn, once per folder. A held folder is announced
   whenever its peer answers, so two can arrive while one is on screen. */
const withQuestion = (q: PendingFolder[], f: PendingFolder) => (
  q.some((x) => x.username === f.username && x.folderPath === f.folderPath) ? q : [...q, f]);

/** Enough of a cancelled download to queue it again. */
interface CancelledFile {
  username: string;
  path: string;
  size: number;
  /** The folder it was going to, so Undo of a Download to… goes there too. */
  destination: string | null;
}

/**
 * How long Undo stays on offer after a Cancel.
 *
 * Cancel stops AND forgets (see `_cmd_transfer_cancel` for why it has to), so
 * one stray press used to throw away a release that had waited hours in a
 * peer's queue. Undo asks for the same files again. It cannot promise the old
 * queue place — that is the peer's to give — but many clients keep a request
 * that comes straight back, and a few seconds is when the mistake is noticed.
 */
const UNDO_MS = 10_000;

/** What each transfer command is called when it fails. */
const ACTION: Record<string, string> = {
  'transfer.pause': 'Pause', 'transfer.resume': 'Resume', 'transfer.retry': 'Retry',
  'transfer.cancel': 'Cancel', 'transfer.clear': 'Clear',
};

export function useTransfers(
  client: SidecarClient | null,
  /** Give-up threshold in seconds; 0 never gives up. From Settings. */
  quietSeconds = 0,
  /** Forget completed records older than this many days; 0 keeps them. */
  clearCompletedDays = 0,
  /** Transfers the retention sweep must never clear: auto-downloads held for
   *  review. A ref, filled in by whoever knows them. */
  keepRef?: { readonly current: ReadonlySet<string> },
): TransferSession {
  const byId = useRef<Map<string, Transfer>>(new Map());
  const [groups, setGroups] = useState<TransferGroup[]>([]);
  const [uploadGroups, setUploadGroups] = useState<TransferGroup[]>([]);
  const [all, setAll] = useState<Transfer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState<CancelledFile[] | null>(null);
  const dirty = useRef(false);
  /* In a ref, not a dep: `publish` is rebuilt by nothing, and threading the
   * threshold through its deps would tear down the event subscriptions every
   * time the setting changed. */
  const quiet = useRef(quietSeconds);
  quiet.current = quietSeconds;
  const clearDays = useRef(clearCompletedDays);
  clearDays.current = clearCompletedDays;
  /** How many times each timed-out file has been auto-retried this session. */
  const autoRetries = useRef<Map<string, number>>(new Map());

  const publish = useCallback(() => {
    const list = [...byId.current.values()];
    /* Split before grouping. Grouping keys on username + folder, and a peer
     * you are trading with in both directions at once would otherwise land
     * both halves in one release row. */
    const downloads = list.filter((t) => t.direction !== 'upload');
    const uploads = list.filter((t) => t.direction === 'upload');
    const now = Date.now();
    setAll((prev) => (sameItems(prev, downloads) ? prev : downloads));
    setGroups((prev) => keepUnchanged(prev, group(downloads, quiet.current, now)));
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

    // A folder Get is two steps — ask the peer what is in it, then queue — and
    // the second could fail or find nothing with no word to anyone. Both now
    // say so, wherever the Get was pressed.
    const onFolderFailed = (data: unknown) => {
      const d = data as { username: string; folderPath: string; reason: string };
      const name = d.folderPath.split('\\').pop() || d.folderPath;
      reportFailure(
        `Download “${name}”`,
        new Error(d.reason === 'offline' ? `${d.username} is offline` : `${d.username} did not send the folder`),
      );
    };
    const onFolder = (data: unknown) => {
      const d = data as FolderContentsEvent;
      if (d.held) {
        // Bigger than the search showed. The sidecar held it back rather than
        // queue it, so ask now, with the real count.
        const held = { username: d.username, folderPath: d.folderPath, ...d.held };
        setQuestions((q) => withQuestion(q, held));
        return;
      }
      if (!d.requestId || d.enqueued !== 0) return;
      const name = d.folderPath.split('\\').pop() || d.folderPath;
      const inSubfolders = (d.folders ?? []).some((f) => f.path !== d.folderPath && f.files.length > 0);
      showNotice(inSubfolders
        ? `Nothing was queued from “${name}” — its files are in subfolders. Browse it and use “Get this folder” to take them too.`
        : `Nothing was queued from “${name}” — the folder came back empty.`);
    };

    const off = [
      client.on('transfer.added', onAdded),
      client.on('transfer.updated', onUpdated),
      client.on('transfer.removed', onRemoved),
      client.on('folder.contents.failed', onFolderFailed),
      client.on('folder.contents', onFolder),
    ];

    // Snapshot on connect, so downloads already running in a restarted sidecar
    // appear instead of the list looking empty until something changes.
    //
    // REPLACE, not merge. A new client is a reconnect or a restarted engine,
    // and a transfer removed while this page was not listening would otherwise
    // stay on screen as a ghost until relaunch. Safe: the engine answers in
    // order, so the snapshot already reflects every event sent before it.
    const stopList = readUntilAnswered<{ transfers: Transfer[] }>(
      client, 'transfer.list', undefined, (r) => {
        const at = Date.now();
        byId.current.clear();
        for (const t of r.transfers ?? []) byId.current.set(t.id, { ...t, seenAt: at });
        publish();
      },
    );

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

      /* Auto-retry files the peer never answered for in time. On a big folder a
       * scatter of these is normal churn — the peer is serving a few files at a
       * time and some connection attempts time out under load — and the state
       * is transient and retryable, so re-asking once a slot frees usually
       * works. Bounded per file (`autoRetry`) so a dead peer is left for a
       * manual retry, and on this one-a-minute clock so it stays gentle. */
      const decision = autoRetry([...byId.current.values()], autoRetries.current);
      autoRetries.current = decision.counts;
      if (decision.retry.length > 0) {
        void client.request('transfer.retry', { transferIds: decision.retry }).catch(() => {});
      }

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
            && !keepRef?.current.has(t.id)
          ))
          .map((t) => t.id);
        if (stale.length > 0) {
          void client.request('transfer.clear', { transferIds: stale }).catch(() => {});
        }
      }
    }, QUIET_SWEEP_MS);

    return () => {
      for (const fn of off) fn();
      stopList();
      window.clearInterval(timer);
      window.clearInterval(sweep);
    };
  }, [client, publish]);

  const cmd = useCallback((name: string, params: Record<string, unknown>) => {
    void client?.request(name, params).catch((e: Error) => {
      setError(e.message);
      reportFailure(ACTION[name] ?? 'That', e);
    });
  }, [client]);

  const enqueue = useCallback(async (
    username: string, path: string, size: number, destination: string | null = null,
  ) => {
    if (!client) return;
    setError(null);
    try {
      // Every key must be present — `Optional` in the sidecar's schema means
      // nullable, not omittable, and validate_struct rejects both missing and
      // unknown keys. This is the same trap that broke search.start.
      const r = await client.request<{ transferId: string; alreadyQueued: boolean }>(
        'transfer.enqueue',
        { username, path, size, file: null, destination, paused: false },
      );
      // Pressing Get on something already queued is upstream's silent no-op —
      // it returns before emitting anything. The row now appears regardless
      // (the sidecar emits it), but saying so is the difference between "the
      // button is broken" and "you already asked for this".
      if (r.alreadyQueued) setNote('Already in your downloads.');
    } catch (e) {
      setError((e as Error).message);
      // Get is pressed in Search and Browse, where the Downloads screen's own
      // error line cannot be seen — so it says so where you are.
      reportFailure('Download', e);
    }
  }, [client]);

  const [questions, setQuestions] = useState<PendingFolder[]>([]);
  const pendingFolder = questions[0] ?? null;

  /* `confirmAbove` lets the sidecar, the only side that sees the real count,
     hold back a folder the caller underestimated: a search shows a fraction
     of one. Null once the person has agreed. */
  const sendFolder = useCallback(async (
    f: Omit<PendingFolder, 'count'>, confirmAbove: number | null,
  ) => {
    if (!client) return;
    setError(null);
    const params = {
      username: f.username, folderPath: f.folderPath, recurse: f.recurse,
      destination: f.destination, confirmAbove,
    } satisfies TransferFolderParams;
    try {
      await client.request('transfer.enqueueFolder', params);
    } catch (e) {
      setError((e as Error).message);
      reportFailure('Download the folder', e);
    }
  }, [client]);

  const enqueueFolder = useCallback(async (
    username: string, folderPath: string, recurse = false,
    opts: { destination?: string | null; count?: number } = {},
  ) => {
    const f = { username, folderPath, recurse, destination: opts.destination ?? null };
    if ((opts.count ?? 0) > LARGE_FOLDER_FILES) {
      const asked = { ...f, count: opts.count ?? 0 };
      setQuestions((q) => withQuestion(q, asked));
      return;
    }
    await sendFolder(f, LARGE_FOLDER_FILES);
  }, [sendFolder]);

  const confirmFolder = useCallback(() => {
    if (pendingFolder) void sendFolder(pendingFolder, null);
    setQuestions((q) => q.slice(1));
  }, [pendingFolder, sendFolder]);
  const dismissFolder = useCallback(() => setQuestions((q) => q.slice(1)), []);

  /* A read first, then an ordinary clear, so anything awaiting review is left
     out: clearing its transfer would leave the review card pointing at nothing. */
  const forgetMissing = useCallback((keep: ReadonlySet<string>) => {
    if (!client) return;
    void client.request<{ transferIds: string[] }>('transfer.findMissing')
      .then(async (r) => {
        const found = r.transferIds ?? [];
        const ids = found.filter((id) => !keep.has(id));
        if (found.length === 0) {
          showNotice('Every finished download is still where it was saved.');
          return;
        }
        if (ids.length === 0) {
          showNotice('The only files missing belong to downloads awaiting your review, so nothing was forgotten.');
          return;
        }
        await client.request('transfer.clear', { transferIds: ids });
        showNotice(`Forgot ${ids.length} download${ids.length === 1 ? '' : 's'} whose files are gone. Nothing was deleted.`);
      })
      .catch((e) => reportFailure('Forget missing files', e));
  }, [client, cmd]);

  // A second Cancel inside the window adds to the batch rather than replacing
  // it, so Undo puts back everything you just took away, not only the last.
  const cancel = useCallback((ids: string[]) => {
    const files = ids
      .map((id) => byId.current.get(id))
      .filter((t): t is Transfer => (
        t !== undefined && t.direction !== 'upload' && t.state !== 'finished'
      ))
      .map((t) => ({ username: t.username, path: t.path, size: t.size, destination: t.localFolder }));
    cmd('transfer.cancel', { transferIds: ids });
    if (files.length > 0) setCancelled((prev) => [...(prev ?? []), ...files]);
  }, [cmd]);

  useEffect(() => {
    if (!cancelled) return undefined;
    const timer = window.setTimeout(() => setCancelled(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [cancelled]);

  const undoCancel = useCallback(() => {
    const files = cancelled;
    if (!files) return;
    setCancelled(null);
    for (const f of files) void enqueue(f.username, f.path, f.size, f.destination);
  }, [cancelled, enqueue]);

  const reveal = useCallback((id: string) => {
    void client?.request('fs.reveal', { transferId: id, path: null })
      .catch((e) => reportFailure('Show in Finder', e));
  }, [client]);

  const open = useCallback((id: string) => {
    void client?.request('fs.open', { transferId: id, path: null })
      .catch((e) => reportFailure('Open the file', e));
  }, [client]);

  return {
    groups, all,
    activeCount: all.filter((t) => isActive(t.state)).length,
    uploadGroups,
    /* Counted off the grouped list because `all` is downloads only. Active
     * means running or queued — a finished upload is history, not activity. */
    uploadCount: uploadGroups.reduce((n, g) => n + g.active, 0),
    enqueue, enqueueFolder,
    pendingFolder, confirmFolder, dismissFolder, forgetMissing,
    pause: (ids) => cmd('transfer.pause', { transferIds: ids }),
    resume: (ids) => cmd('transfer.resume', { transferIds: ids }),
    cancel,
    retry: (ids) => cmd('transfer.retry', { transferIds: ids }),
    clear: (ids) => cmd('transfer.clear', { transferIds: ids }),
    error,
    note,
    cancelled,
    undoCancel,
    reveal,
    open,
  };
}
