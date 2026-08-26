/*
 * Seek — the want list.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A record of intent, not a download queue. Nothing here starts a transfer,
 * and nothing here searches on a timer: automatic searching already exists as
 * the wishlist, where upstream owns the schedule and the SERVER dictates the
 * interval. This is the list you keep so that a link you saw at 2am is still
 * there on Saturday.
 *
 * WHO DECIDES "FOUND". This side does. The sidecar stores a status and never
 * interprets one, because deciding that a search result IS the thing you
 * wanted is fuzzy matching over parsed paths — `parsePath.ts` and `text.ts`
 * already do that job for the search list, and teaching Python a second,
 * differently-wrong copy of it is exactly what the seam exists to prevent.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import { fuzzyKey } from '../domain/text.ts';

export type WantStatus = 'pending' | 'searching' | 'found' | 'downloaded' | 'not_found';
export type WantSource = 'youtube' | 'bandcamp' | 'discogs' | 'manual' | 'fingerprint';

export interface WantEntry {
  id: string;
  artist: string;
  title: string;
  album: string | null;
  year: number | null;
  label: string | null;
  catalogNumber: string | null;
  sourceKind: WantSource;
  sourceUrl: string | null;
  sourceTitle: string | null;
  artworkUri: string | null;
  status: WantStatus;
  addedAt: number;
  searchedAt: number | null;
  notes: string | null;
  duration: number | null;
  tracklist: Array<{ position: number; title: string; artist: string; duration: number | null }>;
  /** The digging session this was saved during, if any. */
  sessionId: string | null;
}

/** What a caller must supply to add one. The sidecar fills in the rest. */
export type NewWantEntry = Partial<WantEntry> & { artist: string; title: string };

export interface WantSession {
  entries: WantEntry[];
  /** Entries still waiting to be looked for. Drives the sidebar badge. */
  pendingCount: number;
  add(entries: NewWantEntry[]): Promise<void>;
  remove(ids: string[]): void;
  update(id: string, patch: Partial<Pick<WantEntry,
    'artist' | 'title' | 'album' | 'status' | 'notes'>>): void;
  /** The Soulseek query an entry implies. */
  queryFor(entry: WantEntry): string;
  enabled: boolean;
}

const BLANK: Omit<WantEntry, 'artist' | 'title'> = {
  id: '', album: null, year: null, label: null, catalogNumber: null,
  sourceKind: 'manual', sourceUrl: null, sourceTitle: null, artworkUri: null,
  status: 'pending', addedAt: 0, searchedAt: null, notes: null,
  duration: null, tracklist: [], sessionId: null,
};

/**
 * The wire rejects a missing key outright, so every field has to be present
 * even though the sidecar overwrites `id` and `addedAt`.
 */
function complete(entry: NewWantEntry): WantEntry {
  return { ...BLANK, ...entry };
}

export function queryForEntry(entry: Pick<WantEntry, 'artist' | 'title' | 'album'>): string {
  // A release searches for the album: the unit a DJ downloads is a folder
  // (docs/PRODUCT.md §4).
  const what = entry.album ?? entry.title;
  return `${entry.artist} ${what}`.replace(/\s+/g, ' ').trim();
}

/**
 * Did this search actually turn up the thing that was wanted?
 *
 * Deliberately strict about the TITLE and forgiving about the artist: a result
 * whose folder is "Burial - Untrue (2007) [FLAC]" matches an entry for
 * Archangel only if the track name is in there somewhere, and plenty of
 * correct results credit the artist differently or not at all. Being wrong in
 * the generous direction would mark everything 'found' the moment any peer
 * answered, which is what makes a status column worthless.
 */
export function resultsMatch(
  entry: Pick<WantEntry, 'artist' | 'title' | 'album'>,
  candidates: string[],
): boolean {
  const target = fuzzyKey(entry.album ?? entry.title);
  if (!target) return false;
  const artist = fuzzyKey(entry.artist);
  return candidates.some((candidate) => {
    const key = fuzzyKey(candidate);
    if (!key.includes(target)) return false;
    return !artist || key.includes(artist);
  });
}

export function useWant(client: SidecarClient | null): WantSession {
  const [entries, setEntries] = useState<WantEntry[]>([]);

  useEffect(() => {
    if (!client) return;
    const off = client.on('want.changed', (data) => {
      setEntries((data as { entries: WantEntry[] }).entries ?? []);
    });
    void client.request<{ entries: WantEntry[] }>('want.list')
      .then((r) => setEntries(r.entries ?? []))
      .catch(() => {});
    return off;
  }, [client]);

  const add = useCallback(async (incoming: NewWantEntry[]) => {
    if (!client || incoming.length === 0) return;
    const result = await client.request<{ entries: WantEntry[] }>('want.add', {
      entries: incoming.map(complete),
    });
    setEntries(result.entries ?? []);
  }, [client]);

  const remove = useCallback((ids: string[]) => {
    if (!client || ids.length === 0) return;
    void client.request<{ entries: WantEntry[] }>('want.remove', { ids })
      .then((r) => setEntries(r.entries ?? []))
      .catch(() => {});
  }, [client]);

  const update = useCallback((id: string, patch: Partial<Pick<WantEntry,
    'artist' | 'title' | 'album' | 'status' | 'notes'>>) => {
    if (!client) return;
    void client.request<{ entries: WantEntry[] }>('want.update', {
      id,
      artist: patch.artist ?? null,
      title: patch.title ?? null,
      album: patch.album ?? null,
      status: patch.status ?? null,
      notes: patch.notes ?? null,
    }).then((r) => setEntries(r.entries ?? [])).catch(() => {});
  }, [client]);

  const pendingCount = useMemo(
    () => entries.filter((e) => e.status === 'pending').length,
    [entries],
  );

  return {
    entries,
    pendingCount,
    add,
    remove,
    update,
    queryFor: queryForEntry,
    enabled: Boolean(client),
  };
}
