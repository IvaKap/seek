/*
 * Seek — the Want List.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * DISCOVERY.md's bar for this screen: it should feel like a personal notebook,
 * not an inbox. So entries are grouped by where they stand in the loop rather
 * than sorted by a column, artwork is allowed to take space, and where each
 * one came from is on the row — a link you saved in October is only useful if
 * you can still tell why you saved it.
 *
 * What it deliberately does NOT do is search on its own. Every search here is
 * one the user asked for, one at a time: Soulseek throttles clients that search
 * faster than the server allows, and a "Search all" that fired twenty queries
 * at once is exactly how an account gets rate-limited.
 */

import { useMemo, useState } from 'react';
import type { WantEntry, WantSession, WantStatus } from '../data/wantStore.ts';
import type { WantlistState } from '../data/discoverStore.ts';
import { wantlistEntries } from '../domain/wantlistImport.ts';
import { since } from '../domain/format.ts';
import { PROVIDER_LABEL } from '../domain/discoverUrl.ts';
import type { UrlProvider } from '../domain/discoverUrl.ts';
import {
  IconBandcamp, IconClose, IconDiscogs, IconEmpty, IconLink, IconRelease,
  IconSearch, IconYouTube,
} from '../icons/index.tsx';

/** Groups, in loop order. A status with no entries renders nothing at all. */
const GROUPS: Array<{ status: WantStatus; label: string; hint: string }> = [
  { status: 'pending', label: 'To find', hint: 'Not looked for yet' },
  { status: 'searching', label: 'Searching', hint: '' },
  { status: 'found', label: 'Found on Soulseek', hint: 'Search again to download' },
  { status: 'downloaded', label: 'Downloaded', hint: '' },
  { status: 'not_found', label: 'Nothing found yet', hint: 'Worth retrying another day' },
];

function SourceIcon({ kind }: { kind: WantEntry['sourceKind'] }) {
  const props = { size: 14, painted: 1.5 } as const;
  if (kind === 'youtube') return <IconYouTube {...props} />;
  if (kind === 'bandcamp') return <IconBandcamp {...props} />;
  if (kind === 'discogs') return <IconDiscogs {...props} />;
  return <IconLink {...props} />;
}

function Row({
  entry, want, onSearch, busy,
}: {
  entry: WantEntry;
  want: WantSession;
  onSearch(entry: WantEntry): void;
  busy: boolean;
}) {
  const source = entry.sourceKind === 'manual' || entry.sourceKind === 'fingerprint'
    ? null
    : PROVIDER_LABEL[entry.sourceKind as UrlProvider];

  return (
    <li className="want" data-status={entry.status}>
      <span className="want__art" aria-hidden>
        {entry.artworkUri
          ? <img className="want__img" src={entry.artworkUri} alt="" />
          : <IconRelease size={16} painted={1.3} />}
      </span>

      <span className="want__body">
        <span className="want__line">
          {entry.artist && <span className="want__artist">{entry.artist}</span>}
          <span className="want__title">{entry.album ?? entry.title}</span>
        </span>
        <span className="want__meta">
          <SourceIcon kind={entry.sourceKind} />
          <span>{source ? `From ${source}` : 'Added by hand'}</span>
          <span>·</span>
          <span>{since(entry.addedAt)}</span>
          {entry.label && <><span>·</span><span>{entry.label}</span></>}
          {entry.year !== null && <><span>·</span><span className="tnum">{entry.year}</span></>}
          {entry.tracklist.length > 0 && (
            <><span>·</span><span className="tnum">{entry.tracklist.length} tracks</span></>
          )}
        </span>
      </span>

      <span className="want__actions">
        <button
          type="button"
          className="btn pressable"
          disabled={busy}
          title={busy ? 'Another want list search is running' : 'Search Soulseek for this'}
          onPointerDown={() => !busy && onSearch(entry)}
        >
          {entry.status === 'not_found' ? 'Retry' : 'Search'}
        </button>
        {entry.sourceUrl && (
          <a
            className="verify pressable want__link"
            href={entry.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            title={entry.sourceUrl}
          >
            Open link
          </a>
        )}
        <button
          type="button"
          className="want__remove pressable"
          aria-label={`Remove ${entry.title} from the want list`}
          onPointerDown={() => want.remove([entry.id])}
        >
          <IconClose size={13} painted={1.5} />
        </button>
      </span>
    </li>
  );
}

/**
 * The grouped rows, on their own so a digging session can show its own
 * entries in exactly the same shape. A session is a lens onto the want list,
 * not a second list, and rendering it with a second component is how the two
 * drift apart.
 */
export function WantRows({
  entries, want, onSearch, searchingId,
}: {
  entries: WantEntry[];
  want: WantSession;
  onSearch(entry: WantEntry): void;
  searchingId: string | null;
}) {
  const grouped = useMemo(
    () => GROUPS
      .map((g) => ({ ...g, items: entries.filter((e) => e.status === g.status) }))
      .filter((g) => g.items.length > 0),
    [entries],
  );

  return (
    <>
      {grouped.map((g) => (
        <section className="wants__group" key={g.status}>
          <h2 className="wants__head">
            <span>{g.label}</span>
            <span className="wants__count tnum">{g.items.length}</span>
            {g.hint && <span className="wants__hint">{g.hint}</span>}
          </h2>
          <ul className="wants__list">
            {g.items.map((entry) => (
              <Row
                key={entry.id}
                entry={entry}
                want={want}
                onSearch={onSearch}
                busy={searchingId !== null && searchingId !== entry.id}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/**
 * The Discogs wantlist import.
 *
 * Two steps, deliberately, exactly like the playlist import: reading someone's
 * wantlist and adding several hundred rows to their want list are different
 * decisions, and the second should be made looking at the first one's result.
 *
 * The count of what is ALREADY here is the point of the middle step. A
 * collector who imports twice wants to know the second run added four things,
 * not that it "imported 312 releases" again.
 */
function DiscogsImport({
  want, wantlist, onFetch, onClear, onOpenSettings,
}: {
  want: WantSession;
  wantlist: WantlistState | null;
  onFetch(): void;
  onClear(): void;
  onOpenSettings?(): void;
}) {
  const mapped = useMemo(
    () => (wantlist ? wantlistEntries(wantlist.items) : []),
    [wantlist],
  );

  /* Matched on the same artist+title key the importer dedups with, so the
   * number shown is the number that will actually land. */
  const already = useMemo(() => {
    const here = new Set(want.entries.map(
      (e) => `${e.artist} ${e.title}`.trim().toLowerCase(),
    ));
    return mapped.filter((e) => here.has(`${e.artist} ${e.title}`.trim().toLowerCase())).length;
  }, [want.entries, mapped]);

  const fresh = mapped.length - already;

  if (!wantlist) {
    return (
      <button type="button" className="btn pressable" onPointerDown={onFetch}>
        <IconDiscogs size={14} painted={1.5} />
        <span>Import your Discogs wantlist</span>
      </button>
    );
  }

  if (wantlist.loading) {
    return <p className="wants__import-note">Reading your Discogs wantlist…</p>;
  }

  if (wantlist.error) {
    return (
      <div className="wants__import">
        <p className="wants__import-note" role="alert">
          {wantlist.needs === 'discogsToken'
            ? 'Seek needs a Discogs personal access token to read your wantlist.'
            : 'Could not read your Discogs wantlist.'}
        </p>
        <div className="wants__import-actions">
          {wantlist.needs === 'discogsToken' && onOpenSettings && (
            <button type="button" className="btn btn--primary pressable" onPointerDown={onOpenSettings}>
              Open Settings
            </button>
          )}
          <button type="button" className="btn pressable" onPointerDown={onClear}>Dismiss</button>
        </div>
      </div>
    );
  }

  return (
    <div className="wants__import">
      <p className="wants__import-note">
        <strong className="tnum">{wantlist.total}</strong>
        {wantlist.total === 1 ? ' release on ' : ' releases on '}
        {wantlist.username ? `${wantlist.username}'s ` : 'your '}
        Discogs wantlist.
        {already > 0 && (
          <>
            {' '}
            <span className="tnum">{already}</span>
            {already === 1 ? ' is' : ' are'} already here.
          </>
        )}
        {/* Same contract as the catalogue and the playlist: a truncated list
            that claims to be whole is worse than one that admits it. */}
        {!wantlist.complete && (
          <> Only the first <span className="tnum">{mapped.length}</span> were read.</>
        )}
      </p>
      <div className="wants__import-actions">
        {fresh > 0 ? (
          <button
            type="button"
            className="btn btn--primary pressable"
            onPointerDown={() => { void want.add(mapped); onClear(); }}
          >
            Add {fresh} to the want list
          </button>
        ) : (
          <span className="wants__import-note">Nothing new to add.</span>
        )}
        <button type="button" className="btn pressable" onPointerDown={onClear}>Cancel</button>
      </div>
    </div>
  );
}

export function WantListView({
  want, onSearch, searchingId, wantlist, onFetchWantlist, onClearWantlist, onOpenSettings,
}: {
  want: WantSession;
  /** Runs the search in the Search view and reports the outcome back. */
  onSearch(entry: WantEntry): void;
  /** The entry whose search is in flight, if any. One at a time, on purpose. */
  searchingId: string | null;
  /** The fetched Discogs wantlist, before anything is added. */
  wantlist?: WantlistState | null;
  onFetchWantlist?(): void;
  onClearWantlist?(): void;
  onOpenSettings?(): void;
}) {
  const [filter, setFilter] = useState('');

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return want.entries;
    return want.entries.filter((e) => (
      `${e.artist} ${e.title} ${e.album ?? ''} ${e.label ?? ''}`
        .toLowerCase().includes(needle)
    ));
  }, [want.entries, filter]);

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Want List</h1>
        <p className="pane__subtitle">
          Music you meant to look for. Nothing here searches on its own —
          that is what the Wishlist does.
        </p>
        <div className="wants__tools">
          {want.entries.length > 0 && (
            <input
              className="settings__input"
              value={filter}
              placeholder="Filter the want list…"
              aria-label="Filter the want list"
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {onFetchWantlist && onClearWantlist && (
            <DiscogsImport
              want={want}
              wantlist={wantlist ?? null}
              onFetch={onFetchWantlist}
              onClear={onClearWantlist}
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>
      </header>

      <div className="pane__scroll">
        {want.entries.length === 0 ? (
          <div className="empty empty--section">
            <span className="empty__icon"><IconEmpty size={28} painted={1.3} /></span>
            <p className="empty__title">Nothing on the list</p>
            <p className="empty__body">
              Paste a YouTube, Bandcamp or Discogs link into the search field and
              press ⌥↵ to keep it for later instead of searching straight away.
            </p>
          </div>
        ) : matching.length === 0 ? (
          <div className="empty empty--section">
            <span className="empty__icon"><IconSearch size={28} painted={1.3} /></span>
            <p className="empty__title">Nothing matches that</p>
            <p className="empty__body">
              {want.entries.length} {want.entries.length === 1 ? 'entry is' : 'entries are'} on
              the list — the filter is hiding {want.entries.length === 1 ? 'it' : 'them all'}.
            </p>
          </div>
        ) : (
          <div className="wants">
            <WantRows
              entries={matching}
              want={want}
              onSearch={onSearch}
              searchingId={searchingId}
            />
          </div>
        )}
      </div>
    </>
  );
}
