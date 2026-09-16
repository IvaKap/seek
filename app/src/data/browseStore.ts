/*
 * Seek — browsing a peer's whole share, and who they are.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A share list arrives as one enormous event — tens of thousands of files is
 * ordinary — so everything derived from it is memoised, and the folder list is
 * filtered rather than re-fetched.
 *
 * Quality and the transcode check are computed once, here, on arrival — same
 * discipline as `domain/ingest.ts` uses for search results, and the same
 * functions (`classify`/`checkTranscode`), because a file's bytes do not mean
 * something different depending on which screen found it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { overlapWith } from '../domain/overlap.ts';
import type { Overlap } from '../domain/overlap.ts';
import type { SidecarClient } from './sidecarClient.ts';
import type { WireFileRef } from './adapt.ts';
import { parsePath } from '../domain/parsePath.ts';
import { extensionOf } from '../domain/ingest.ts';
import { checkTranscode, classify } from '../domain/quality.ts';
import type { ParsedPath, Quality, TranscodeCheck } from '../domain/types.ts';

export interface BrowseFile {
  path: string;
  size: number;
  bitrate: number | null;
  duration: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  vbr: boolean | null;
  /** Computed once on arrival — see the module comment. */
  quality: Quality;
  transcode: TranscodeCheck;
  parsed: ParsedPath;
}
export interface BrowseFolder { path: string; files: BrowseFile[]; private: boolean }

interface WireBrowseFolder { path: string; files: WireFileRef[]; private: boolean }

export function enrichFile(f: WireFileRef): BrowseFile {
  const facts = {
    extension: extensionOf(f.path),
    size: f.size,
    bitrate: f.bitrate,
    duration: f.duration,
    sampleRate: f.sampleRate,
    bitDepth: f.bitDepth,
    vbr: f.isVbr,
  };
  return {
    path: f.path,
    size: f.size,
    bitrate: f.bitrate,
    duration: f.duration,
    sampleRate: f.sampleRate,
    bitDepth: f.bitDepth,
    vbr: f.isVbr,
    quality: classify(facts),
    transcode: checkTranscode(facts),
    parsed: parsePath(f.path),
  };
}

function enrichFolders(folders: WireBrowseFolder[]): BrowseFolder[] {
  return folders.map((f) => ({ path: f.path, private: f.private, files: f.files.map(enrichFile) }));
}

export interface BrowseState {
  username: string;
  state: 'loading' | 'ready' | 'failed';
  folders: BrowseFolder[];
  fileCount: number;
  totalSize: number;
  reason?: string;
}

/** One shelf: a folder, presented as the release it probably is. */
export interface Shelf {
  path: string;
  name: string;
  artist: string | null;
  year: number | null;
  files: BrowseFile[];
  size: number;
  /** Uppercase extensions present, most common first. */
  formats: string[];
  private: boolean;
}

/**
 * A peer's own server-side facts — the same numbers a search result shows,
 * fetched directly because Browse has no search response to piggyback on.
 * `files`/`folders` are null until the server answers (RECON.md §6: browsing
 * someone already watches them, so after the first answer these keep
 * updating live for free).
 */
export interface PeerFacts {
  freeSlots: boolean;
  advertisedSpeed: number;
  queueLength: number;
  files: number | null;
  folders: number | null;
  country: string | null;
}

/**
 * A peer's own profile, fetched directly from THEM rather than the server.
 * Most peers have set no picture or description at all — that is the common
 * case, not a failure, and is why `pictureUri` is nullable on a `ready` state
 * rather than `ready` requiring one.
 */
export interface PeerProfile {
  state: 'loading' | 'ready' | 'failed';
  description: string;
  pictureUri: string | null;
  uploadSlots: number;
  queueSize: number;
  freeSlots: boolean;
  reason?: string;
}

const AUDIO = /\.(flac|wav|aiff?|alac|ape|wv|mp3|m4a|aac|ogg|opus|wma)$/i;

function lastSegment(path: string): string {
  const parts = path.replace(/\//g, '\\').split('\\').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Shelves matching a query, checked against the shelf's own name/artist/path
 * AND every filename inside it. A compilation or charts folder is named for
 * itself, not for the forty artists in it — filtering on the shelf's own
 * metadata alone missed every one of them, which is most of what a real
 * share looks like.
 */
export function filterShelves(shelves: Shelf[], query: string): Shelf[] {
  const q = query.trim().toLowerCase();
  if (!q) return shelves;
  return shelves.filter((s) => (
    s.name.toLowerCase().includes(q)
    || (s.artist ?? '').toLowerCase().includes(q)
    || s.path.toLowerCase().includes(q)
    || s.files.some((f) => lastSegment(f.path).toLowerCase().includes(q))
  ));
}

export function toShelves(folders: BrowseFolder[]): Shelf[] {
  const out: Shelf[] = [];
  for (const f of folders) {
    const audio = f.files.filter((x) => AUDIO.test(x.path));
    if (audio.length === 0) continue;

    const counts = new Map<string, number>();
    for (const x of audio) {
      const m = /\.([a-z0-9]+)$/i.exec(x.path);
      if (!m) continue;
      const ext = m[1].toUpperCase();
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }

    // The folder name is the only release metadata a share list carries, so
    // parse it the same way search results are parsed rather than inventing a
    // second, weaker guess.
    const probe = parsePath(`${f.path}\\${lastSegment(audio[0].path)}`);

    out.push({
      path: f.path,
      name: lastSegment(f.path),
      artist: probe.artist && probe.artist.confidence > 0.5 ? probe.artist.value : null,
      year: probe.year ? probe.year.value : null,
      files: audio,
      size: audio.reduce((n, x) => n + x.size, 0),
      formats: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e),
      private: f.private,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface BrowseSession {
  current: BrowseState | null;
  /** Releases this peer shares that are already in your library. */
  overlap: Overlap;
  shelves: Shelf[];
  filter: string;
  setFilter(v: string): void;
  browse(username: string): void;
  close(): void;

  /** Null until a `user.stats` answer arrives for the person being browsed. */
  peerFacts: PeerFacts | null;
  peerProfile: PeerProfile | null;
  isBuddy: boolean;
}

export function useBrowse(
  client: SidecarClient | null, owned?: Set<string>,
): BrowseSession {
  const [current, setCurrent] = useState<BrowseState | null>(null);
  const [filter, setFilter] = useState('');
  const [peerFacts, setPeerFacts] = useState<PeerFacts | null>(null);
  const [peerProfile, setPeerProfile] = useState<PeerProfile | null>(null);
  const [buddies, setBuddies] = useState<Set<string>>(new Set());
  // Which username the peer-facts/profile listeners should accept an answer
  // for. A ref, not state: `user.stats`/`user.info.*` are broadcasts, not
  // scoped replies, and a stale closure over `current` would let a slow
  // answer about the PREVIOUS person land on the one now on screen.
  const activeUsername = useRef('');

  useEffect(() => {
    if (!client) return;
    const offResult = client.on('user.browse.result', (data) => {
      const d = data as {
        username: string; folders: WireBrowseFolder[]; fileCount: number; totalSize: number;
      };
      setCurrent((cur) => (
        // A late result for someone we are no longer looking at must not
        // replace the person we are.
        cur && cur.username !== d.username ? cur : {
          username: d.username,
          state: 'ready',
          folders: enrichFolders(d.folders ?? []),
          fileCount: d.fileCount,
          totalSize: d.totalSize,
        }
      ));
    });
    const offFailed = client.on('user.browse.failed', (data) => {
      const d = data as { username: string; reason: string };
      setCurrent((cur) => (cur && cur.username !== d.username ? cur : {
        username: d.username, state: 'failed', folders: [], fileCount: 0,
        totalSize: 0, reason: d.reason,
      }));
    });
    const offStats = client.on('user.stats', (data) => {
      const d = data as {
        username: string; freeSlots: boolean; advertisedSpeed: number;
        queueLength: number; files: number | null; folders: number | null;
        country: string | null;
      };
      if (d.username !== activeUsername.current) return;
      setPeerFacts({
        freeSlots: d.freeSlots, advertisedSpeed: d.advertisedSpeed,
        queueLength: d.queueLength, files: d.files, folders: d.folders,
        country: d.country,
      });
    });
    const offInfo = client.on('user.info.result', (data) => {
      const d = data as {
        username: string; description: string; pictureUri: string | null;
        uploadSlots: number; queueSize: number; freeSlots: boolean;
      };
      if (d.username !== activeUsername.current) return;
      setPeerProfile({
        state: 'ready', description: d.description, pictureUri: d.pictureUri,
        uploadSlots: d.uploadSlots, queueSize: d.queueSize, freeSlots: d.freeSlots,
      });
    });
    const offInfoFailed = client.on('user.info.failed', (data) => {
      const d = data as { username: string; reason: string };
      if (d.username !== activeUsername.current) return;
      setPeerProfile({
        state: 'failed', description: '', pictureUri: null,
        uploadSlots: 0, queueSize: 0, freeSlots: false, reason: d.reason,
      });
    });
    // A local subscription rather than sharing DiscoveryViews.tsx's — there is
    // no store buddies already lives in, and standing one up is a bigger
    // change than "show a badge on the peer you're looking at."
    const offBuddies = client.on('buddies.state', (data) => {
      setBuddies(new Set((data as { items: string[] }).items ?? []));
    });
    void client.request<{ items: string[] }>('buddies.list').catch(() => {});
    return () => {
      offResult(); offFailed(); offStats(); offInfo(); offInfoFailed(); offBuddies();
    };
  }, [client]);

  const browse = useCallback((username: string) => {
    if (!client || !username) return;
    activeUsername.current = username;
    setFilter('');
    setCurrent({
      username, state: 'loading', folders: [], fileCount: 0, totalSize: 0,
    });
    setPeerFacts(null);
    setPeerProfile({
      state: 'loading', description: '', pictureUri: null,
      uploadSlots: 0, queueSize: 0, freeSlots: false,
    });
    void client.request('user.browse', { username }).catch((e: Error) => {
      setCurrent({
        username, state: 'failed', folders: [], fileCount: 0, totalSize: 0,
        reason: e.message,
      });
    });
    // Best-effort. A peer who never answers a direct profile request is
    // ordinary (offline, or their client ignores it) and must not block or
    // discolour the share list itself, which is why these are not awaited
    // alongside `user.browse` above.
    void client.request('user.stats', { username }).catch(() => {});
    void client.request('user.info.get', { username }).catch(() => {
      setPeerProfile((p) => (p?.state === 'loading' ? {
        state: 'failed', description: '', pictureUri: null,
        uploadSlots: 0, queueSize: 0, freeSlots: false, reason: 'failed',
      } : p));
    });
  }, [client]);

  // Shelves are derived from a list that can be tens of thousands of files —
  // recomputing them per keystroke of the filter would be the whole cost again.
  const allShelves = useMemo(
    () => (current?.state === 'ready' ? toShelves(current.folders) : []),
    [current],
  );

  const shelves = useMemo(() => filterShelves(allShelves, filter), [allShelves, filter]);

  /* Computed once per browse rather than per render: a 9,000-file share is a
   * lot of path parsing, and it does not change while you look at it. */
  const overlap = useMemo(() => {
    if (!current || !owned || owned.size === 0) {
      return { count: 0, examples: [], releases: [] };
    }
    return overlapWith(
      current.folders.flatMap((f) => f.files.map((file) => file.path)),
      owned,
    );
  }, [current, owned]);

  return {
    current, overlap, shelves, filter, setFilter, browse,
    close: () => setCurrent(null),
    peerFacts, peerProfile,
    isBuddy: current ? buddies.has(current.username) : false,
  };
}
