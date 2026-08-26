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
import { IconEmpty, IconSearch } from '../icons/index.tsx';

interface WishlistState { items: string[]; intervalSeconds: number }

function interval(seconds: number): string {
  if (seconds <= 0) return 'once the server says how often';
  if (seconds < 120) return `every ${seconds} seconds`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `every ${m} minutes` : `every ${Math.round(m / 60)} hours`;
}

export function WishlistView({
  client, signedIn, onSearch,
}: {
  client: SidecarClient | null;
  signedIn: boolean;
  /** Run one now, by hand, without waiting for the timer. */
  onSearch(query: string): void;
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
            {state.items.map((q) => (
              <li key={q} className="wish__row">
                <span className="wish__q">{q}</span>
                <button
                  type="button"
                  className="verify pressable"
                  onPointerDown={() => onSearch(q)}
                  title="Search for this now instead of waiting"
                >
                  <IconSearch size={12} painted={1.5} /> Now
                </button>
                <button
                  type="button"
                  className="verify pressable"
                  onPointerDown={() => remove(q)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
