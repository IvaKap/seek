/*
 * Seek — browsing a peer's whole share.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Iva's vision note §12: "this is a huge part of why Soulseek is interesting" —
 * finding someone whose taste you trust and going through everything they have.
 * The GTK client exposes it as a raw folder tree; the point here is to make it
 * feel like looking through someone's shelves.
 *
 * A share list arrives as one enormous event — tens of thousands of files is
 * ordinary — so everything derived from it is memoised, and the folder list is
 * filtered rather than re-fetched.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { overlapWith } from '../domain/overlap.ts';
import type { Overlap } from '../domain/overlap.ts';
import type { SidecarClient } from './sidecarClient.ts';
import { parsePath } from '../domain/parsePath.ts';

export interface BrowseFile { path: string; size: number }
export interface BrowseFolder { path: string; files: BrowseFile[]; private: boolean }

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

const AUDIO = /\.(flac|wav|aiff?|alac|ape|wv|mp3|m4a|aac|ogg|opus|wma)$/i;

function lastSegment(path: string): string {
  const parts = path.replace(/\//g, '\\').split('\\').filter(Boolean);
  return parts[parts.length - 1] ?? path;
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
}

export function useBrowse(
  client: SidecarClient | null, owned?: Set<string>,
): BrowseSession {
  const [current, setCurrent] = useState<BrowseState | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!client) return;
    const offResult = client.on('user.browse.result', (data) => {
      const d = data as {
        username: string; folders: BrowseFolder[]; fileCount: number; totalSize: number;
      };
      setCurrent((cur) => (
        // A late result for someone we are no longer looking at must not
        // replace the person we are.
        cur && cur.username !== d.username ? cur : {
          username: d.username,
          state: 'ready',
          folders: d.folders ?? [],
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
    return () => { offResult(); offFailed(); };
  }, [client]);

  const browse = useCallback((username: string) => {
    if (!client || !username) return;
    setFilter('');
    setCurrent({
      username, state: 'loading', folders: [], fileCount: 0, totalSize: 0,
    });
    void client.request('user.browse', { username }).catch((e: Error) => {
      setCurrent({
        username, state: 'failed', folders: [], fileCount: 0, totalSize: 0,
        reason: e.message,
      });
    });
  }, [client]);

  // Shelves are derived from a list that can be tens of thousands of files —
  // recomputing them per keystroke of the filter would be the whole cost again.
  const allShelves = useMemo(
    () => (current?.state === 'ready' ? toShelves(current.folders) : []),
    [current],
  );

  const shelves = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allShelves;
    return allShelves.filter((s) => (
      s.name.toLowerCase().includes(q)
      || (s.artist ?? '').toLowerCase().includes(q)
      || s.path.toLowerCase().includes(q)
    ));
  }, [allShelves, filter]);

  /* Computed once per browse rather than per render: a 9,000-file share is a
   * lot of path parsing, and it does not change while you look at it. */
  const overlap = useMemo(() => {
    if (!current || !owned || owned.size === 0) return { count: 0, examples: [] };
    return overlapWith(
      current.folders.flatMap((f) => f.files.map((file) => file.path)),
      owned,
    );
  }, [current, owned]);

  return {
    current, overlap, shelves, filter, setFilter, browse,
    close: () => setCurrent(null),
  };
}
