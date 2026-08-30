/*
 * Seek — the label watchlist.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Iva's ask: "save labels and work through their catalogues over time, rather
 * than pasting a link and losing it when the card is dismissed." `catalogStore`
 * holds exactly ONE catalogue, in React state, and browsing a second replaces
 * the first — which is right for the Dig Bar and is precisely the losing this
 * fixes.
 *
 * IT IS NOW ALSO A NEW-RELEASE NOTIFIER, and that reverses an argument this
 * file used to make. Worth recording why, because two of the three original
 * objections were answered and one was simply accepted:
 *
 *   "Discogs is a database, not a release feed, so diffing it reports records
 *   catalogued decades late as new." Answered: a Discogs entry has to be
 *   recent by its own YEAR as well as unseen.
 *
 *   "Bandcamp has no API to poll." Answered, and it turned out to be the
 *   cheaper half — its whole catalogue is one HTML page, newest first.
 *
 *   "A brand-new release is the one thing Soulseek does not have yet, so the
 *   notification's happy path ends in an empty search." NOT answered. This is
 *   still true. Iva asked for the feature knowing it.
 *
 * Back catalogue is still what this is FOR. The notifier is an addition to a
 * bookmark, not a replacement for one.
 *
 * THE COUNTS ARE A SNAPSHOT. `sessionStore` deliberately derives its counts
 * from the want list rather than storing them, because storing a number twice
 * is two places for it to be wrong — but that works only because the frontend
 * holds the whole want list. A catalogue is persisted nowhere, and recounting
 * one costs several rate-limited HTTP requests per label, so these are stored
 * with the time they were taken and must always be rendered as "when you last
 * looked". `describeProgress` in `domain/labels.ts` is the only thing allowed
 * to word them.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import type { UrlProvider } from '../domain/discoverUrl.ts';

/** Providers that actually have a catalogue. `discover.browse` serves these
 *  two and refuses the rest, so nothing else can be watched. */
export type CatalogProvider = Extract<UrlProvider, 'discogs' | 'bandcamp'>;

export interface WatchedLabel {
  id: string;
  sourceKind: CatalogProvider;
  kind: 'label' | 'artist';
  name: string;
  /** The catalogue page. Empty when it was found by name. */
  url: string;
  /** The provider's numeric id, when known. Skips the fuzzy name search. */
  entityId: number | null;
  addedAt: number;
  /** When the catalogue was last actually read. Null until the first read. */
  lastSeenAt: number | null;
  releaseCount: number | null;
  ownedCount: number | null;
  wantedCount: number | null;
  note: string;
  /** The logo or photo, inlined by the sidecar. Null until first read. */
  imageUri: string | null;
  /** When it was last checked FOR NEW RELEASES — not the same as read. */
  lastCheckedAt: number | null;
  /** Unseen releases found at the last check. Cleared by opening it. */
  newCount: number;
  /** What the last check saw, so "new" means new SINCE we looked. */
  knownIds: string[];
}

export interface WatchRequest {
  sourceKind: CatalogProvider;
  kind: 'label' | 'artist';
  name: string;
  url?: string | null;
  entityId?: number | null;
}

export interface LabelsSession {
  labels: WatchedLabel[];
  watch(request: WatchRequest): void;
  unwatch(id: string): void;
  note(id: string, note: string): void;
  /** Record what a catalogue read found, with the time. Clears `newCount`. */
  seen(id: string, counts: { releaseCount: number; ownedCount: number; wantedCount: number }): void;
  /**
   * Look for releases added since the last check.
   *
   * Never called on mount. A Discogs catalogue is up to seven sequentially
   * rate-limited requests, so a dozen watched entries checked the moment this
   * screen appeared would be a minute and a half of someone else's API budget,
   * spent without being asked. The user presses this.
   */
  check(ids?: string[]): void;
  /** True while a check is in flight, so the button can say so. */
  checking: boolean;
  /** The watched entry matching a catalogue, or null. */
  find(request: Partial<WatchRequest>): WatchedLabel | null;
  /** Why the last command failed, for the one-line notice. Null when fine. */
  error: string | null;
  enabled: boolean;
}

/**
 * Whether a watched row and a catalogue are the same thing.
 *
 * Mirrors `_label_identity` in the sidecar, and has to: the UI decides whether
 * to show "Watch" or "Watching", and the sidecar decides whether a watch adds
 * a row. If the two disagree, pressing Watch on something already watched
 * silently does nothing and the button never changes.
 *
 * The id first, because a label can be renamed on Discogs and a URL can be
 * written several ways; then the URL; then, weakest, the name.
 */
export function sameCatalogue(a: Partial<WatchRequest>, b: WatchedLabel): boolean {
  if (a.sourceKind !== b.sourceKind || a.kind !== b.kind) return false;
  if (a.entityId && b.entityId) return a.entityId === b.entityId;
  if (a.entityId || b.entityId) return false;
  const au = (a.url ?? '').replace(/\/+$/, '').toLowerCase();
  const bu = (b.url ?? '').replace(/\/+$/, '').toLowerCase();
  if (au || bu) return au === bu;
  return (a.name ?? '').trim().toLowerCase() === b.name.trim().toLowerCase();
}

export function useLabels(client: SidecarClient | null): LabelsSession {
  const [labels, setLabels] = useState<WatchedLabel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!client) {
      setLabels([]);
      return;
    }
    const off = client.on('labels.changed', (data) => {
      setLabels((data as { labels: WatchedLabel[] }).labels ?? []);
    });
    void client.request<{ labels: WatchedLabel[] }>('labels.list')
      .then((r) => setLabels(r.labels ?? []))
      .catch(() => {});
    return off;
  }, [client]);

  const send = useCallback((cmd: string, params: Record<string, unknown>) => {
    if (!client) return;
    setError(null);
    void client.request<{ labels: WatchedLabel[] }>(cmd, params)
      .then((r) => setLabels(r.labels ?? []))
      /* Surfaced rather than swallowed: the two ways `labels.watch` refuses —
       * a provider with no catalogue, and a Bandcamp page with no URL — are
       * both things the user did, and a button that silently does nothing is
       * the worst possible answer to either. */
      .catch((e: Error) => setError(e.message.replace(/^[a-z_]+: /, '')));
  }, [client]);

  return {
    labels,
    watch: useCallback((request: WatchRequest) => send('labels.watch', {
      sourceKind: request.sourceKind,
      kind: request.kind,
      name: request.name,
      url: request.url ?? null,
      entityId: request.entityId ?? null,
    }), [send]),
    unwatch: useCallback((id: string) => send('labels.unwatch', { id }), [send]),
    checking,
    /* The command returns immediately and the WORK happens on the sidecar's
     * discovery pool, arriving later as `labels.changed`. So `checking` is
     * cleared on the acknowledgement rather than on a result: it says "the
     * request got through", which is all the button can honestly promise. A
     * spinner that waited for every catalogue would sit there for a minute. */
    check: useCallback((ids?: string[]) => {
      if (!client) return;
      setChecking(true);
      setError(null);
      void client.request<{ labels: WatchedLabel[] }>('labels.check', { ids: ids ?? [] })
        .then((r) => setLabels(r.labels ?? []))
        .catch((e: Error) => setError(e.message.replace(/^[a-z_]+: /, '')))
        .finally(() => setChecking(false));
    }, [client]),
    note: useCallback((id: string, note: string) => send('labels.note', { id, note }), [send]),
    seen: useCallback((id, counts) => send('labels.seen', { id, ...counts }), [send]),
    find: useCallback(
      (request) => labels.find((l) => sameCatalogue(request, l)) ?? null,
      [labels],
    ),
    error,
    enabled: Boolean(client),
  };
}
