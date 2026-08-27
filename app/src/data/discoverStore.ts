/*
 * Seek — the Dig Bar's URL lookup.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * One preview at a time, because there is one search field. Pasting a second
 * URL replaces the first rather than queueing it, and a reply for a request the
 * user has already moved past is dropped on arrival — the alternative is a card
 * that fills itself in with the answer to a question nobody is asking any more.
 *
 * The lookup is never on the critical path. `discover.parseUrl` replies with a
 * request id immediately and the answer arrives as an event, so the card shows
 * a skeleton from the first keystroke after the paste.
 *
 * WHERE THE PARSING HAPPENS. The sidecar sends raw provider facts. For Bandcamp
 * and Discogs that already includes artist and title; for YouTube it is one
 * free-text string, and `parseTitle` turns it into a suggestion here. That split
 * is the seam (AGENTS.md), and it is why `confidence` is computed in this file
 * rather than arriving on the wire.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import { guessUrl } from '../domain/discoverUrl.ts';
import type { UrlProvider } from '../domain/discoverUrl.ts';
import { playlistEntries } from '../domain/playlistImport.ts';
import type { PlaylistEntry } from '../domain/playlistImport.ts';
import type { DiscogsWant } from '../domain/wantlistImport.ts';
import { parseTitle, searchQuery } from '../domain/parseTitle.ts';
import type { TitleSource } from '../domain/parseTitle.ts';

export type DiscoverKind = 'track' | 'release' | 'artist' | 'label';

/** What the sidecar sends. Mirrors DiscoverParsed in shared/schema.py. */
export interface WireParsed {
  requestId: string;
  url: string;
  sourceKind: string;
  kind: DiscoverKind;
  rawTitle: string;
  channel: string;
  artist: string;
  title: string;
  album: string | null;
  year: number | null;
  label: string | null;
  catalogNumber: string | null;
  artworkUri: string | null;
  duration: number | null;
  genres: string[];
  tracklist: Array<{ position: number; title: string; artist: string; duration: number | null }>;
  providerUrl: string | null;
}

export interface DiscoverPreview {
  url: string;
  provider: UrlProvider | null;
  kind: DiscoverKind;
  /** The provider's own title, shown when the parse is not trustworthy. */
  rawTitle: string;
  /** Editable. Seeded from the provider or from the parse. */
  artist: string;
  title: string;
  album: string | null;
  year: number | null;
  label: string | null;
  catalogNumber: string | null;
  artworkUri: string | null;
  genres: string[];
  trackCount: number;
  /** 1 when the provider stated the fields outright; a parse score otherwise. */
  confidence: number;
  /** Null when nothing was parsed — the provider simply told us. */
  parsedFrom: TitleSource | null;
  /** True while waiting for the sidecar. Everything above is empty until then. */
  loading: boolean;
  /** Set when the lookup failed. The card offers a plain search instead. */
  error: string | null;
  /** An AppSettings field the user must fill in, e.g. 'discogsToken'. */
  needs: string;
}

/** A tracklist line, with `parseTitle` already applied to its text. */
export interface TracklistTrack {
  position: number;
  offsetSeconds: number;
  /** The line exactly as the uploader typed it. */
  text: string;
  artist: string;
  title: string;
  confidence: number;
}

export interface TracklistState {
  url: string;
  videoTitle: string;
  loading: boolean;
  /** Empty once loaded means the description had no tracklist — the ordinary
   *  outcome, and not an error. */
  tracks: TracklistTrack[];
  done: boolean;
}

/** A YouTube playlist being imported into the want list. */
export interface PlaylistState {
  playlistId: string;
  loading: boolean;
  done: boolean;
  /** Parsed rows, ready for the want list. Empty while loading. */
  entries: PlaylistEntry[];
  /** What YouTube says the playlist holds — may exceed `entries`. */
  total: number;
  /** False when the sidecar stopped paginating before the end. */
  complete: boolean;
  error: string;
  /** The setting that would fix it, e.g. `youtubeApiKey`. */
  needs: string;
}

export interface DiscoverSession {
  preview: DiscoverPreview | null;
  /** Detects a URL and starts a lookup. Returns false for ordinary queries. */
  inspect(text: string): boolean;
  /** User edits on the card. */
  edit(patch: { artist?: string; title?: string }): void;
  dismiss(): void;
  /** The Soulseek query the card would run. Empty when there is nothing to run. */
  query(): string;
  /** Try to read a DJ set's tracklist out of the video description. */
  tracklist: TracklistState | null;
  findTracklist(): void;
  /** Identify a local audio file by its sound. Shows in the preview card. */
  identify(path: string): void;
  /** The playlist behind the previewed link, once asked for. */
  playlist: PlaylistState | null;
  /** Read the playlist the previewed URL names. Adds nothing by itself. */
  importPlaylist(): void;
  /** The playlist id the previewed URL names, or '' when it names none. */
  playlistId: string;
  /** The Discogs wantlist, once asked for. */
  wantlist: WantlistState | null;
  /** Fetch the signed-in Discogs user's wantlist. Adds nothing by itself. */
  fetchWantlist(): void;
  /** Forget the fetched wantlist, after importing it or on dismissal. */
  clearWantlist(): void;
  enabled: boolean;
}

/**
 * A fetched Discogs wantlist, before anything is added.
 *
 * Two-step on purpose, exactly like the playlist import: reading someone's
 * wantlist and adding a few hundred entries to their want list are different
 * decisions, and the second one should be made looking at the first one's
 * result.
 */
export interface WantlistState {
  loading: boolean;
  done: boolean;
  username: string;
  items: DiscogsWant[];
  /** What Discogs says the wantlist holds — may exceed `items` when capped. */
  total: number;
  complete: boolean;
  error: string;
  /** An AppSettings key the user must supply, when that is the problem. */
  needs: string;
}

function skeleton(url: string, provider: UrlProvider | null): DiscoverPreview {
  return {
    url, provider, kind: 'track', rawTitle: '', artist: '', title: '',
    album: null, year: null, label: null, catalogNumber: null,
    artworkUri: null, genres: [], trackCount: 0,
    confidence: 0, parsedFrom: null, loading: true, error: null, needs: '',
  };
}

/**
 * Wire payload to card state. The only real logic in this store, and pure so it
 * can be tested without mounting React.
 *
 * The decision it encodes: Bandcamp and Discogs STATE artist and title as
 * fields, so they are used as given and the card claims full confidence.
 * YouTube states neither, so `parseTitle` produces a suggestion and the card
 * shows how it got there. Reporting a Discogs artist as "60% confident" would
 * be inventing doubt about a database record; reporting a parsed YouTube title
 * as certain would be inventing certainty. Neither is acceptable.
 */
/**
 * Which kind of failure a `discover.parseFailed` describes.
 *
 * Three outcomes the code sees identically and a person does not:
 *
 *   needs-setting    the provider works; you have not given it a token
 *   unreachable      we never got an answer — DNS, TLS, a timeout
 *   <fallback>       the provider answered, and the answer was no
 *
 * The order is the priority. A missing token is checked first, being the most
 * specific and the most fixable; `unreachable` beats the fallback because a
 * link that could not be looked up is not a link known to be bad.
 *
 * The fallback differs by surface: a URL nobody recognises can still be searched
 * for as text ('not-recognised'), while a playlist that would not load has no
 * such consolation ('failed').
 *
 * `reason` stays developer-facing, per its contract — this reads the machine
 * fields only. It lived inline in three branches and shipped in 0.2.0
 * collapsing everything to 'not-recognised', so a TLS error told people their
 * link was unrecognised. One function now, so the three cannot drift apart.
 */
export function classifyFailure(
  d: { needs?: string; unreachable?: boolean; unauthorised?: boolean },
  fallback: 'not-recognised' | 'failed',
): string {
  // BEFORE `needs`, deliberately. A refused credential also carries `needs`,
  // because the UI still has to know WHICH field — but "add a Discogs token"
  // is the wrong sentence for someone who added one and had it rejected. That
  // was 0.2.2's answer, and from the outside it is indistinguishable from the
  // app simply not working.
  if (d.unauthorised) return 'unauthorised';
  if (d.needs) return 'needs-setting';
  if (d.unreachable) return 'unreachable';
  return fallback;
}

export function previewFromWire(d: WireParsed): DiscoverPreview {
  const stated = Boolean(d.artist || d.title);
  const enforced = hostOf(d.url) === 'music.youtube.com';
  const parsed = stated
    ? null
    : parseTitle(d.rawTitle, { channel: d.channel, enforced });

  return {
    url: d.url,
    provider: asProvider(d.sourceKind),
    kind: d.kind,
    rawTitle: d.rawTitle,
    artist: stated ? d.artist : (parsed?.artist ?? ''),
    title: stated ? d.title : (parsed?.title ?? d.rawTitle),
    album: d.album,
    year: d.year,
    // A label parsed out of `[Brackets]` is a guess; one from Discogs is a
    // fact. Prefer the provider's and fall back to the parse.
    label: d.label ?? parsed?.label ?? null,
    catalogNumber: d.catalogNumber,
    artworkUri: d.artworkUri,
    genres: d.genres ?? [],
    trackCount: (d.tracklist ?? []).length,
    confidence: stated ? 1 : (parsed?.confidence ?? 0),
    parsedFrom: stated ? null : (parsed?.from ?? null),
    loading: false,
    error: null,
    needs: '',
  };
}

/**
 * The Soulseek query a preview implies.
 *
 * An album URL searches for the release, because the unit a DJ downloads is a
 * folder (docs/PRODUCT.md §4). A label or artist page has no track to search
 * for at all, so its own name is the best available query.
 */
export function previewQuery(preview: DiscoverPreview | null): string {
  if (!preview) return '';
  if (preview.kind === 'release' && preview.album) {
    return searchQuery({ artist: preview.artist, title: preview.album });
  }
  return searchQuery({ artist: preview.artist, title: preview.title });
}

export function useDiscover(client: SidecarClient | null): DiscoverSession {
  const [preview, setPreview] = useState<DiscoverPreview | null>(null);
  const [tracklist, setTracklist] = useState<TracklistState | null>(null);
  const [playlist, setPlaylist] = useState<PlaylistState | null>(null);
  const [wantlist, setWantlist] = useState<WantlistState | null>(null);
  const [playlistId, setPlaylistId] = useState('');
  /** The playlist whose reply we are still waiting for. */
  const activePlaylist = useRef('');
  const activeWantlist = useRef('');
  /* Correlation is by URL, not by request id.
   *
   * The id would work — it comes back on the reply — but only if the reply is
   * always processed before the event it names, and nothing in the protocol
   * promises that. The URL is known the instant the user pastes, so there is no
   * window where an answer can arrive that we cannot place. The sidecar's ids
   * are a deterministic hash of the URL anyway, so the two agree by
   * construction. */
  const active = useRef<string | null>(null);

  useEffect(() => {
    if (!client) return;

    const offParsed = client.on('discover.parsed', (data) => {
      const d = data as WireParsed;
      if (d.url !== active.current) return;
      setPreview(previewFromWire(d));
    });

    const offFailed = client.on('discover.parseFailed', (data) => {
      const d = data as {
        requestId: string; url: string; reason: string; needs: string;
        unreachable: boolean; unauthorised: boolean;
      };
      /* A failed wantlist read arrives here too, and it is matched on
       * `requestId` rather than `url` because the wantlist command HAS no url
       * — the username comes from the token. The playlist branch below keys on
       * `url`, so without this first the empty string would fall through to
       * the preview branch and blank the card the user was looking at. */
      if (d.requestId && d.requestId === activeWantlist.current) {
        setWantlist((prev) => (prev ? {
          ...prev,
          loading: false,
          done: true,
          error: classifyFailure(d, 'failed'),
          needs: d.needs ?? '',
        } : prev));
        return;
      }
      /* A failed playlist read comes back on this same event, carrying the
       * playlist id where a URL would be. Without this branch the failure is
       * swallowed and the import spins for ever — including the one failure
       * the user can actually fix, a missing API key. */
      if (d.url && d.url === activePlaylist.current) {
        setPlaylist((prev) => (prev ? {
          ...prev,
          loading: false,
          done: true,
          error: classifyFailure(d, 'failed'),
          needs: d.needs ?? '',
        } : prev));
        return;
      }
      if (d.url !== active.current) return;
      setPreview((prev) => (prev ? {
        ...prev,
        loading: false,
        error: classifyFailure(d, 'not-recognised'),
        needs: d.needs ?? '',
      } : prev));
    });

    const offIdentified = client.on('discover.identified', (data) => {
      const d = data as {
        path: string; matched: boolean; artist: string; title: string;
        album: string | null; year: number | null; score: number;
      };
      if (d.path !== active.current) return;
      setPreview({
        url: d.path,
        provider: null,
        kind: 'track',
        rawTitle: d.matched ? `${d.artist} — ${d.title}` : '',
        artist: d.artist,
        title: d.title,
        album: d.album,
        year: d.year,
        label: null,
        catalogNumber: null,
        artworkUri: null,
        genres: [],
        trackCount: 0,
        /* AcoustID's own score, passed through rather than reinterpreted. It
         * is confidence that the FINGERPRINT matched, which is a different
         * claim from "this metadata is right" — the card words it that way. */
        confidence: d.matched ? d.score : 0,
        parsedFrom: null,
        loading: false,
        error: d.matched ? null : 'not-recognised',
        needs: '',
      });
    });

    const offWantlist = client.on('discover.wantlistItems', (data) => {
      const d = data as {
        requestId: string; username: string; total: number;
        complete: boolean; items: DiscogsWant[];
      };
      if (d.requestId !== activeWantlist.current) return;
      setWantlist({
        loading: false, done: true,
        username: d.username ?? '',
        items: d.items ?? [],
        total: d.total ?? 0,
        complete: d.complete !== false,
        error: '', needs: '',
      });
    });

    const offPlaylist = client.on('discover.playlistItems', (data) => {
      const d = data as {
        playlistId: string; total: number; complete: boolean;
        items: Parameters<typeof playlistEntries>[0];
      };
      if (d.playlistId !== activePlaylist.current) return;
      setPlaylist({
        playlistId: d.playlistId,
        loading: false,
        done: true,
        /* Parsed HERE, by the same function that reads a video title, rather
         * than by a second splitter in Python that would be differently
         * wrong. */
        entries: playlistEntries(d.items ?? []),
        total: d.total ?? 0,
        complete: d.complete !== false,
        error: '',
        needs: '',
      });
    });

    const offTracklist = client.on('discover.tracklistParsed', (data) => {
      const d = data as {
        url: string; videoTitle: string;
        lines: Array<{ position: number; offsetSeconds: number; text: string }>;
      };
      if (d.url !== active.current) return;
      setTracklist({
        url: d.url,
        videoTitle: d.videoTitle,
        loading: false,
        done: true,
        /* Each line is parsed HERE, by the same function that reads a video
         * title — forty test cases deep — rather than by a second splitter in
         * Python that would be differently wrong. */
        tracks: (d.lines ?? []).map((line) => {
          const parsed = parseTitle(line.text);
          return {
            position: line.position,
            offsetSeconds: line.offsetSeconds,
            text: line.text,
            artist: parsed.artist,
            title: parsed.title,
            confidence: parsed.confidence,
          };
        }),
      });
    });

    return () => {
      offParsed(); offFailed(); offPlaylist(); offWantlist();
      offTracklist(); offIdentified();
    };
  }, [client]);

  const identify = useCallback((path: string) => {
    if (!client || !path) return;
    active.current = path;
    setTracklist(null);
    setPreview({ ...skeleton(path, null), kind: 'track' });
    void client.request('discover.fingerprint', { path, durationLimit: null })
      .catch(() => {
        if (active.current !== path) return;
        setPreview((prev) => (prev ? {
          ...prev, loading: false, error: 'not-recognised', needs: '',
        } : prev));
      });
  }, [client]);

  const findTracklist = useCallback(() => {
    const url = preview?.url;
    if (!client || !url) return;
    setTracklist({ url, videoTitle: '', loading: true, tracks: [], done: false });
    void client.request('discover.parseTracklist', { url }).catch(() => {
      setTracklist({ url, videoTitle: '', loading: false, tracks: [], done: true });
    });
  }, [client, preview?.url]);

  const importPlaylist = useCallback(() => {
    if (!client || !playlistId) return;
    activePlaylist.current = playlistId;
    setPlaylist({
      playlistId, loading: true, done: false, entries: [],
      total: 0, complete: true, error: '', needs: '',
    });
    void client.request('discover.playlist', { playlistId }).catch((error: unknown) => {
      setPlaylist({
        playlistId, loading: false, done: true, entries: [], total: 0,
        complete: true, error: String(error), needs: '',
      });
    });
  }, [client, playlistId]);

  const fetchWantlist = useCallback(() => {
    if (!client) return;
    setWantlist({
      loading: true, done: false, username: '', items: [],
      total: 0, complete: true, error: '', needs: '',
    });
    void client.request<{ requestId: string }>('discover.wantlist')
      .then((r) => { activeWantlist.current = r.requestId; })
      .catch((error: unknown) => {
        setWantlist({
          loading: false, done: true, username: '', items: [],
          total: 0, complete: true, error: String(error), needs: '',
        });
      });
  }, [client]);

  const clearWantlist = useCallback(() => {
    activeWantlist.current = '';
    setWantlist(null);
  }, []);

  const inspect = useCallback((text: string): boolean => {
    const guess = guessUrl(text);
    if (!guess) return false;
    // No sidecar means no lookup — the fixture replay has no provider to ask.
    if (!client) return false;

    active.current = guess.url;
    setTracklist(null);
    // A new link means any previous playlist is no longer the one on screen.
    setPlaylist(null);
    activePlaylist.current = '';
    setPlaylistId(guess.playlistId);
    setPreview(skeleton(guess.url, guess.provider));
    void client.request('discover.parseUrl', { url: guess.url }).catch(() => {
      // The command itself was refused — external lookups switched off, or the
      // socket went away. Either way no event is coming.
      if (active.current !== guess.url) return;
      setPreview((prev) => (prev ? {
        ...prev, loading: false, error: 'not-recognised', needs: '',
      } : prev));
    });
    return true;
  }, [client]);

  const edit = useCallback((patch: { artist?: string; title?: string }) => {
    setPreview((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const dismiss = useCallback(() => {
    setPlaylist(null);
    activePlaylist.current = '';
    setPlaylistId('');
    active.current = null;
    setPreview(null);
    setTracklist(null);
  }, []);

  const query = useCallback(() => previewQuery(preview), [preview]);

  return {
    preview, inspect, edit, dismiss, query,
    tracklist, findTracklist, identify,
    playlist, importPlaylist, playlistId,
    wantlist, fetchWantlist, clearWantlist,
    enabled: Boolean(client),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** WantSource is wider than the three the Dig Bar can reach. */
function asProvider(kind: string): UrlProvider | null {
  return kind === 'youtube' || kind === 'bandcamp' || kind === 'discogs' ? kind : null;
}
