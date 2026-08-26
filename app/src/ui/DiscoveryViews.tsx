/*
 * Seek — Search History, Saved Searches, Followed.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Three small screens that were dead nav items. All three persist through the
 * sidecar's `seek-state.json` rather than localStorage — the brief forbids
 * localStorage for app state, and the state file already exists for share
 * consent.
 *
 * Saved searches carry their filter set as an opaque JSON string. The sidecar
 * stores it and never looks inside: filters are a TypeScript concept and
 * teaching Python their shape would put the same knowledge in two places.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SidecarClient } from '../data/sidecarClient.ts';
import type { Filters } from '../domain/types.ts';
import { EMPTY_FILTERS } from '../domain/types.ts';
import { IconEmpty, IconSearch, IconUser, IconUsers } from '../icons/index.tsx';

/* Filters contain a Set, which JSON cannot carry. These two are the only places
 * that know that, so the shape stays in one file. */
export function serialiseFilters(f: Filters): string {
  return JSON.stringify({ ...f, formats: [...f.formats] });
}

export function deserialiseFilters(json: string): Filters {
  if (!json) return EMPTY_FILTERS;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    return {
      ...EMPTY_FILTERS,
      ...raw,
      formats: new Set(Array.isArray(raw.formats) ? (raw.formats as string[]) : []),
    };
  } catch {
    // A corrupt saved filter should not take the screen down with it.
    return EMPTY_FILTERS;
  }
}

function Empty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="empty empty--section">
      <span className="empty__icon">{icon}</span>
      <p className="empty__title">{title}</p>
      <p className="empty__body">{body}</p>
    </div>
  );
}

/* ------------------------------------------------------------- history --- */

export function HistoryView({
  client, onSearch,
}: {
  client: SidecarClient | null;
  onSearch(query: string): void;
}) {
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    if (!client) return;
    void client.request<{ items: string[] }>('history.list')
      .then((r) => setItems(r.items ?? []))
      .catch(() => {});
  }, [client]);

  const clear = useCallback(() => {
    void client?.request<{ items: string[] }>('history.clear')
      .then((r) => setItems(r.items ?? []))
      .catch(() => {});
  }, [client]);

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Search History</h1>
        {items.length > 0 && (
          <div className="browse__form">
            <button type="button" className="btn pressable" onPointerDown={clear}>
              Clear history
            </button>
          </div>
        )}
      </header>
      <div className="pane__scroll">
        {items.length === 0 ? (
          <Empty
            icon={<IconSearch size={28} painted={1.3} />}
            title="No searches yet"
            body="Everything you search for is remembered here, on this machine only. Nothing is sent anywhere."
          />
        ) : (
          <ul className="wish">
            {items.map((q) => (
              <li key={q} className="wish__row">
                <span className="wish__q">{q}</span>
                <button
                  type="button"
                  className="verify pressable"
                  onPointerDown={() => onSearch(q)}
                >
                  Search again
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- saved --- */

interface SavedSearch { query: string; filtersJson: string }

export function SavedView({
  client, onOpen,
}: {
  client: SidecarClient | null;
  onOpen(query: string, filters: Filters): void;
}) {
  const [items, setItems] = useState<SavedSearch[]>([]);

  useEffect(() => {
    if (!client) return;
    void client.request<{ items: SavedSearch[] }>('saved.list')
      .then((r) => setItems(r.items ?? []))
      .catch(() => {});
  }, [client]);

  const remove = useCallback((query: string) => {
    void client?.request<{ items: SavedSearch[] }>('saved.remove', { query })
      .then((r) => setItems(r.items ?? []))
      .catch(() => {});
  }, [client]);

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Saved Searches</h1>
        <p className="pane__subtitle">A query and the filters it was run with.</p>
      </header>
      <div className="pane__scroll">
        {items.length === 0 ? (
          <Empty
            icon={<IconEmpty size={28} painted={1.3} />}
            title="Nothing saved"
            body="Run a search, set the filters you want, then use Save on the results bar. Both come back together."
          />
        ) : (
          <ul className="wish">
            {items.map((s) => (
              <li key={s.query} className="wish__row">
                <span className="wish__q">{s.query}</span>
                <button
                  type="button"
                  className="verify pressable"
                  onPointerDown={() => onOpen(s.query, deserialiseFilters(s.filtersJson))}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="verify pressable"
                  onPointerDown={() => remove(s.query)}
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

/* ------------------------------------------------------------ followed --- */

export function FollowedView({
  client, signedIn, onBrowse,
}: {
  client: SidecarClient | null;
  signedIn: boolean;
  onBrowse(username: string): void;
}) {
  const [items, setItems] = useState<string[]>([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!client) return;
    const off = client.on('buddies.state', (d) => setItems((d as { items: string[] }).items ?? []));
    void client.request<{ items: string[] }>('buddies.list')
      .then((r) => setItems(r.items ?? []))
      .catch(() => {});
    return off;
  }, [client]);

  const add = useCallback(() => {
    const who = draft.trim();
    if (!who || !client) return;
    void client.request<{ items: string[] }>('buddies.add', { username: who })
      .then((r) => { setItems(r.items ?? []); setDraft(''); })
      .catch(() => {});
  }, [client, draft]);

  const remove = useCallback((who: string) => {
    void client?.request<{ items: string[] }>('buddies.remove', { username: who })
      .then((r) => setItems(r.items ?? []))
      .catch(() => {});
  }, [client]);

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Followed</h1>
        <p className="pane__subtitle">
          Peers worth watching. This is upstream's buddy list, so Nicotine+ sees the same people.
        </p>
        <form className="browse__form" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input
            className="settings__input"
            value={draft}
            placeholder="Username to follow…"
            aria-label="Username to follow"
            spellCheck={false}
            autoCapitalize="none"
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      </header>
      <div className="pane__scroll">
        {items.length === 0 ? (
          <Empty
            icon={<IconUsers size={28} painted={1.3} />}
            title="Not following anyone"
            body={signedIn
              ? 'Follow someone whose collection is worth coming back to, then browse their share in one click.'
              : 'Sign in to follow peers.'}
          />
        ) : (
          <ul className="wish">
            {items.map((who) => (
              <li key={who} className="wish__row">
                <span className="wish__q">
                  <IconUser size={13} painted={1.4} /> {who}
                </span>
                <button
                  type="button"
                  className="verify pressable"
                  onPointerDown={() => onBrowse(who)}
                >
                  Browse
                </button>
                <button
                  type="button"
                  className="verify pressable"
                  onPointerDown={() => remove(who)}
                >
                  Unfollow
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
