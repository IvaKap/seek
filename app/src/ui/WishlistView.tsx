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
import type { Filters, WishFilters } from '../domain/types.ts';
import { describeFilters } from '../domain/wishFilters.ts';
import { IconClose, IconEmpty, IconSearch } from '../icons/index.tsx';
import { readUntilAnswered, reportFailure } from '../data/failures.ts';

interface Wish { query: string; filters: WishFilters | null; auto: boolean }
interface WishlistState { items: Wish[]; intervalSeconds: number }

function span(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  const m = Math.round(seconds / 60);
  if (m < 120) return `${m} minutes`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
}

/**
 * How often a wish actually runs. Upstream searches ONE wish per interval, in
 * turn (search.py `_do_next_wishlist_search`), so with 35 wishes each one comes
 * round every 35 intervals — saying "every 12 minutes" promised far more.
 */
export function wishCadence(intervalSeconds: number, count: number): string {
  if (intervalSeconds <= 0) return 'Searched automatically once the server says how often, whenever Seek is running.';
  if (count <= 1) return `Searched automatically every ${span(intervalSeconds)}, whenever Seek is running.`;
  return `One wish is searched every ${span(intervalSeconds)}, in turn, so each comes round about every `
    + `${span(intervalSeconds * count)} while Seek is running.`;
}

export function WishlistView({
  client, signedIn, onSearch, onOpenHits, hits, currentFilters,
}: {
  client: SidecarClient | null;
  signedIn: boolean;
  /** Run one now, by hand, without waiting for the timer. */
  onSearch(query: string): void;
  /** Show what the wish already found, without searching again. */
  onOpenHits(query: string): void;
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
    const stop = readUntilAnswered<WishlistState>(client, 'wishlist.list', undefined, setState);
    return () => { off(); stop(); };
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
      .catch((e) => reportFailure(`Remove "${query}"`, e));
  }, [client]);

  const setFilters = useCallback((query: string, filters: WishFilters | null) => {
    if (!client) return;
    void client.request<WishlistState>('wishlist.filters', { query, filters })
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, [client]);

  const setAuto = useCallback((query: string, auto: boolean) => {
    if (!client) return;
    void client.request<WishlistState>('wishlist.auto', { query, auto })
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, [client]);

  return (
    <>
      <header data-tauri-drag-region="deep" className="header header--plain">
        <h1 className="pane__title">Wishlist</h1>
        <p className="pane__subtitle">
          {signedIn
            ? wishCadence(state.intervalSeconds, state.items.length)
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
              const fresh = hit?.fresh.length ?? 0;
              return (
                <li key={wish.query} className="wish__row" data-unseen={hit?.unseen ? 'true' : undefined}>
                  <span className="wish__q">{wish.query}</span>

                  {/* A COUNT, and only once there is one. A wish that has never
                      hit says nothing rather than "0 found", which reads as a
                      verdict on the wish instead of an absence of news.

                      NEW, not total. Upstream re-runs this query forever and
                      most of what comes back is what came back last time, so a
                      number that counts the repeats says the same thing every
                      twelve minutes and stops being worth reading. Once you
                      have seen them the button keeps the total, quietly — the
                      files are still there, they are just no longer news. */}
                  {found > 0 && (
                    <button
                      type="button"
                      className={fresh > 0 ? 'wish__found wish__found--new pressable' : 'wish__found pressable'}
                      title={fresh > 0
                        ? `${fresh} you have not seen, of ${found} files from `
                          + `${hit?.peerCount ?? 0} people. Shows them.`
                        : `${found} files from ${hit?.peerCount ?? 0} people, all of which `
                          + 'this wish has shown you before. Shows them.'}
                      // The wish's OWN results. This used to start a fresh
                      // search, which could easily miss exactly what the badge
                      // announced: the person who had it ten minutes ago may
                      // be offline now. "Now" beside it is the live search.
                      onClick={() => { hits?.markSeen(wish.query); onOpenHits(wish.query); }}
                    >
                      <span className="tnum">{fresh > 0 ? fresh : found}</span>
                      {fresh > 0 ? ' new' : ' found'}
                    </button>
                  )}

                  {wish.filters && (
                    <span className="wish__filters" title={describeFilters(wish.filters)}>
                      {describeFilters(wish.filters)}
                    </span>
                  )}

                  {/* Auto-download. onClick, not onPointerDown, because it is a
                      persisted setting and must answer to the keyboard.
                      aria-pressed carries the state; the label stays put so the
                      control does not jump under the pointer. */}
                  <button
                    type="button"
                    className={`verify pressable wish__auto${wish.auto ? ' wish__auto--on' : ''}`}
                    aria-pressed={wish.auto}
                    title={wish.auto
                      ? 'Auto-download is on. Seek grabs a qualifying match and holds it for '
                        + 'your review. It runs only while Seek is open.'
                      : 'Automatically download this wish when a match meets your quality '
                        + 'filters, and hold it for review. Runs only while Seek is open.'}
                    onClick={() => setAuto(wish.query, !wish.auto)}
                  >
                    Auto{wish.auto ? ' · on' : ''}
                  </button>

                  <button
                    type="button"
                    className="verify pressable"
                    onClick={() => onSearch(wish.query)}
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
                      onClick={() => setFilters(wish.query, toWire(currentFilters))}
                    >
                      Use current filters
                    </button>
                  )}
                  {wish.filters && (
                    <button
                      type="button"
                      className="verify pressable"
                      title="Stop filtering this wish"
                      onClick={() => setFilters(wish.query, null)}
                    >
                      <IconClose size={11} painted={1.7} /> Filters
                    </button>
                  )}

                  <button
                    type="button"
                    className="verify pressable"
                    onClick={() => remove(wish.query)}
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
