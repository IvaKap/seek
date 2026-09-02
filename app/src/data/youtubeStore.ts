/*
 * Seek — the YouTube sheets, on the app side.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A thin store over the sidecar's `youtube.*` commands and events, shaped like
 * `useLibrary` / `useDiscover`: subscribe to the events, send commands, keep the
 * last state. Two events feed it — `youtube.state` (the whole list, on a
 * structural change) and `youtube.sheet` (one sheet, throttled during a Discogs
 * enrichment pass) — and the second is merged in place so a slow match never
 * re-renders the world.
 *
 * The one derivation the sidecar refuses to do lives here: the artist/title a
 * row is matched by comes from `discogsQuery` (domain), and `enrichPending`
 * turns a sheet's unmatched rows into the queries `youtube.enrich` wants. The
 * sidecar fetches and searches; it never parses a title.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import type {
  YoutubeSheet, YoutubeState, YoutubeQuery,
} from '../../../shared/protocol.ts';
import { discogsQuery } from '../domain/youtubeMatch.ts';

export interface YoutubeSession {
  sheets: YoutubeSheet[];
  available: boolean;
  /** A failed fetch (bad playlist id, missing key), for one message in the UI. */
  error: string | null;
  clearError(): void;
  /** Fetch a public playlist and add it as a sheet. `sourceId` is the id. */
  addSheet(sourceId: string, title?: string): void;
  refresh(sheetId: string): void;
  remove(sheetId: string): void;
  setDownloaded(sheetId: string, videoId: string, value: boolean): void;
  /** Look up Discogs for the rows whose match is still pending. */
  enrichPending(sheet: YoutubeSheet): void;
  /** Redo one row: by re-search, or by a pasted Discogs release URL. */
  rematch(sheetId: string, videoId: string,
          opts: { discogsUrl?: string } | { artist: string; title: string }): void;
}

/** The queries for a sheet's still-unmatched rows. Derivation stays in TS. */
function pendingQueries(sheet: YoutubeSheet): YoutubeQuery[] {
  const out: YoutubeQuery[] = [];
  for (const row of sheet.rows) {
    if (row.match.status !== 'pending') continue;
    const { artist, title } = discogsQuery(row.video.title, row.video.channel);
    out.push({ videoId: row.video.videoId, artist, title });
  }
  return out;
}

export function useYoutube(client: SidecarClient | null): YoutubeSession {
  const [sheets, setSheets] = useState<YoutubeSheet[]>([]);
  const [error, setError] = useState<string | null>(null);

  /* requestId -> what it was, so a discover.parseFailed carrying that id can be
     turned into a message. addSheet/refresh reuse discover.parseFailed for the
     fetch step (see `_youtube_fetch_failed`), so this is how we hear about it. */
  const pending = useRef(new Map<string, string>());

  useEffect(() => {
    if (!client) return;

    const offState = client.on('youtube.state', (d) => {
      setSheets((d as YoutubeState).sheets);
    });

    const offSheet = client.on('youtube.sheet', (d) => {
      const sheet = d as YoutubeSheet;
      setSheets((prev) => {
        const at = prev.findIndex((s) => s.id === sheet.id);
        if (at < 0) return [...prev, sheet];   // shouldn't happen; be safe
        const next = [...prev];
        next[at] = sheet;
        return next;
      });
    });

    const offFailed = client.on('discover.parseFailed', (d) => {
      const f = d as { requestId: string; reason: string; needs?: string };
      const what = pending.current.get(f.requestId);
      if (what === undefined) return;   // not one of ours
      pending.current.delete(f.requestId);
      setError(f.needs === 'youtubeApiKey'
        ? 'Add a YouTube Data API key in Settings to read a playlist.'
        : f.needs === 'discogsToken'
          ? 'Add a Discogs token in Settings to match releases.'
          : `Could not read that playlist: ${f.reason}`);
    });

    void client.request<YoutubeState>('youtube.list').then(
      (s) => setSheets(s.sheets),
    ).catch(() => { /* offline; the fixture replay has no sheets */ });

    return () => { offState(); offSheet(); offFailed(); };
  }, [client]);

  const track = useCallback((cmd: string, params: Record<string, unknown>, label: string) => {
    if (!client) return;
    void client.request<{ requestId: string }>(cmd, params)
      .then((r) => { if (r?.requestId) pending.current.set(r.requestId, label); })
      .catch((e: Error) => setError(e.message));
  }, [client]);

  const addSheet = useCallback((sourceId: string, title?: string) => {
    const id = sourceId.trim();
    if (!id) return;
    // `title: null`, present-not-absent — a nullable field must be on the wire
    // as null, or the sidecar's validator refuses the command.
    track('youtube.addSheet',
          { source: 'playlist', sourceId: id, title: title ?? null }, id);
  }, [track]);

  const refresh = useCallback((sheetId: string) => {
    track('youtube.refreshSheet', { sheetId }, sheetId);
  }, [track]);

  const remove = useCallback((sheetId: string) => {
    if (!client) return;
    void client.request<YoutubeState>('youtube.removeSheet', { sheetId })
      .then((s) => setSheets(s.sheets))
      .catch((e: Error) => setError(e.message));
  }, [client]);

  const setDownloaded = useCallback((sheetId: string, videoId: string, value: boolean) => {
    if (!client) return;
    void client.request<YoutubeState>('youtube.setDownloaded',
                                      { sheetId, videoId, downloaded: value })
      .then((s) => setSheets(s.sheets))
      .catch((e: Error) => setError(e.message));
  }, [client]);

  const enrichPending = useCallback((sheet: YoutubeSheet) => {
    const queries = pendingQueries(sheet);
    if (queries.length === 0) return;
    track('youtube.enrich', { sheetId: sheet.id, queries }, sheet.id);
  }, [track]);

  const rematch = useCallback((sheetId: string, videoId: string,
                               opts: { discogsUrl?: string } | { artist: string; title: string }) => {
    // Every field present, nullable ones as null — the wire rule again.
    const params = {
      sheetId, videoId,
      artist: 'artist' in opts ? opts.artist : null,
      title: 'title' in opts ? opts.title : null,
      discogsUrl: 'discogsUrl' in opts ? opts.discogsUrl ?? null : null,
    };
    track('youtube.rematch', params, sheetId);
  }, [track]);

  return {
    sheets,
    available: Boolean(client),
    error,
    clearError: useCallback(() => setError(null), []),
    addSheet,
    refresh,
    remove,
    setDownloaded,
    enrichPending,
    rematch,
  };
}
