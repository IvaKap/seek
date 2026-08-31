/*
 * Seek — the wishlist.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * For the track you cannot find today. Upstream keeps the list and re-runs each
 * query automatically on an interval the SERVER dictates, so Seek registers the
 * wish and then gets out of the way. It deliberately does NOT poll: running
 * wishlist searches faster than the server's interval is what gets a client
 * throttled, and the interval is not ours to choose.
 *
 * Results arrive through the ordinary search channel, so a wish that hits looks
 * exactly like a search you ran yourself.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SidecarClient } from '../data/sidecarClient.ts';
import type { WishHits } from '../data/wishHits.ts';
import type { Filters } from '../domain/types.ts';
import { describeFilters } from '../domain/wishFilters.ts';
import { IconClose, IconEmpty, IconSearch } from '../icons/index.tsx';

/** Mirrors `WishFilters` on the wire — see shared/schema.py for why it is
 *  Seek's own shape rather than upstream's slots. */
export interface WishFilters {
  formats: string[];
  losslessOnly: boolean;
  minBitrate: number | null;
  durationMin: number | null;
  durationMax: number | null;
  sizeMin: number | null;
  sizeMax: number | null;
  excludeTranscodes: boolean;
  freeSlotsOnly: boolean;
  minSpeed: number | null;
  maxQueue: number | null;
  include: string;
  exclude: string;
  hidePrivate: boolean;
}

interface Wish { query: string; filters: WishFilters | null }
interface WishlistState { items: Wish[]; intervalSeconds: number }

function interval(seconds: number): string {
  if (seconds <= 0) return 'once the server says how often';
  if (seconds < 120) return `every ${seconds} seconds`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `every ${m} minutes` : `every ${Math.round(m / 60)} hours`;
}

export function WishlistView({
  client, signedIn, onSearch, hits, currentFilters,
}: {
  client: SidecarClient | null;
  signedIn: boolean;
  /** Run one now, by hand, without waiting for the timer. */
  onSearch(query: string): void;
  /** What the automatic runs have turned up, waiting to be looked at. */
  hits?: WishHits;
  /** The filters currently set on the search screen, offered as a starting
   *  point — copying what you can see beats retyping it into a second form. */
  currentFilters?: Filters;
}) {
  const [state, setState] = useState<WishlistState>({ items: [], intervalSeconds: 0 });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    const off = client.on('wishlist.state', (d) => setState(d as WishlistState));
    void client.request<WishlistState>('wishlist.list').then(setState).catch(() => {});
    return off;
  }, [client]);

  const add = useCallback(async () => {
    const q = draft.trim();
    if (!q || !client) return;
    setError(null);
    try {
      setState(await client.request<WishlistState>('wishlist.add', { query: q }));
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client, draft]);

  const remove = useCallback((query: string) => {
    if (!client) return;
    void client.request<WishlistState>('wishlist.remove', { query })
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, [client]);

  const setFilters = useCallback((query: string, filters: WishFilters | null) => {
    if (!client) return;
    void client.request<WishlistState>('wishlist.filters', { query, filters })
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, [client]);

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Wishlist</h1>
        <p className="pane__subtitle">
          {signedIn
            ? `Searched automatically ${interval(state.intervalSeconds)}, whenever Seek is running.`
            : 'Sign in and these run automatically in the background.'}
        </p>
        <form
          className="browse__form"
          onSubmit={(e) => { e.preventDefault(); void add(); }}
        >
          <input
            className="settings__input"
            value={draft}
            placeholder="Track or release you can't find…"
            aria-label="Add to wishlist"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
        {error && <p className="signin__error" role="alert">{error}</p>}
      </header>

      <div className="pane__scroll">
        {state.items.length === 0 ? (
          <div className="empty empty--section">
            <span className="empty__icon"><IconEmpty size={28} painted={1.3} /></span>
            <p className="empty__title">Nothing on the wishlist</p>
            <p className="empty__body">
              Add something you can't find right now. Soulseek is a network of people, not a
              catalogue — the person holding it may simply be offline today, so Seek keeps
              asking on your behalf.
            </p>
          </div>
        ) : (
          <ul className="wish">
            {state.items.map((wish) => {
              const hit = hits?.byQuery[wish.query];
              const found = hit?.sources.length ?? 0;
              return (
                <li key={wish.query} className="wish__row" data-unseen={hit?.unseen ? 'true' : undefined}>
                  <span className="wish__q">{wish.query}</span>

                  {/* A COUNT, and only once there is one. A wish that has never
                      hit says nothing rather than "0 found", which reads as a
                      verdict on the wish instead of an absence of news. */}
                  {found > 0 && (
                    <button
                      type="button"
                      className={hit?.unseen ? 'wish__found wish__found--new pressable' : 'wish__found pressable'}
                      title={`${found} files from ${hit?.peerCount ?? 0} people. Opens as a search.`}
                      onPointerDown={() => { hits?.markSeen(wish.query); onSearch(wish.query); }}
                    >
                      <span className="tnum">{found}</span> found
                    </button>
                  )}

                  {wish.filters && (
                    <span className="wish__filters" title={describeFilters(wish.filters)}>
                      {describeFilters(wish.filters)}
                    </span>
                  )}

                  <button
                    type="button"
                    className="verify pressable"
                    onPointerDown={() => onSearch(wish.query)}
                    title="Search for this now instead of waiting"
                  >
                    <IconSearch size={12} painted={1.5} /> Now
                  </button>

                  {/* Copying the filters you can already see beats a second
                      form that says the same things in a smaller space. */}
                  {currentFilters && !wish.filters && (
                    <button
                      type="button"
                      className="verify pressable"
                      title="Judge this wish by the filters currently set on the search screen"
                      onPointerDown={() => setFilters(wish.query, toWire(currentFilters))}
                    >
                      Use current filters
                    </button>
                  )}
                  {wish.filters && (
                    <button
                      type="button"
                      className="verify pressable"
                      title="Stop filtering this wish"
                      onPointerDown={() => setFilters(wish.query, null)}
                    >
                      <IconClose size={11} painted={1.7} /> Filters
                    </button>
                  )}

                  <button
                    type="button"
                    className="verify pressable"
                    onPointerDown={() => remove(wish.query)}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/** `Filters` is UI-shaped and holds a Set; the wire cannot. */
function toWire(f: Filters): WishFilters {
  return { ...f, formats: [...f.formats] };
}
