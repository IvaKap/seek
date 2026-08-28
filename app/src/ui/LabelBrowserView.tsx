/*
 * Seek — the catalogue browser.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A label's whole back catalogue, cross-referenced against what you already
 * own. The question this screen answers is not "what did Hyperdub release" —
 * Discogs answers that — it is "what of it am I missing", which needs the
 * library index, and that is why the ownership check happens here rather than
 * on the wire.
 *
 * WHAT IT DOES NOT DO is search Soulseek for the whole catalogue. Three
 * hundred releases is three hundred queries, and CLAUDE.md is explicit that
 * searching faster than the server allows is what gets a client throttled. So
 * each release is searched one at a time, on request — the same rule the want
 * list follows.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog, CatalogEntry } from '../data/catalogStore.ts';
import type { LibrarySession } from '../data/libraryStore.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import { PROVIDER_LABEL } from '../domain/discoverUrl.ts';
import { Chip } from './controls.tsx';
import { Placeholder } from './ReleaseCard.tsx';
import { useNearViewport } from './useNearViewport.ts';
import { IconCheck, IconEmpty, IconRelease, IconSearch } from '../icons/index.tsx';
import { WatchButton } from './LabelsView.tsx';

/** Roles worth separating on an artist discography. */
const MAIN_ROLES = new Set(['Main', 'Producer', 'Remix', 'Co-producer', '']);

/**
 * One catalogue entry.
 *
 * Its cover is requested only once the card is near the screen — see
 * `useNearViewport`, which carries the reasoning: a 500-record catalogue that
 * asked for every cover on mount would be eight minutes of MusicBrainz traffic
 * for a list the user is skimming.
 */
function Card({
  entry, owned, artwork, onSearch, onWant, wanted,
}: {
  entry: CatalogEntry;
  owned: boolean;
  artwork?: ArtworkSession;
  onSearch(): void;
  onWant(): void;
  wanted: boolean;
}) {
  const key = `cat:${entry.discogsId || entry.url}`;
  const [ref, near] = useNearViewport();

  // In an effect, not in render: React calls a render twice in development,
  // and a request is not something to fire while deciding what to draw.
  useEffect(() => {
    if (near) artwork?.want(key, entry.artist, entry.title);
  }, [near, artwork, key, entry.artist, entry.title]);

  const art = artwork?.get(key);

  return (
    <div className="cat" ref={ref} data-owned={owned ? 'true' : undefined}>
      <span className="cat__art" aria-hidden>
        <Placeholder seed={`${entry.artist}${entry.title}`} />
        <IconRelease size={14} painted={1.3} className="art__fallback" />
        {art?.state === 'ready' && (
          <img className="art__img" src={art.dataUri} alt="" loading="lazy" />
        )}
      </span>

      <span className="cat__body">
        <span className="cat__artist">{entry.artist}</span>
        <span className="cat__title">{entry.title}</span>
        <span className="cat__facts tnum">
          {[
            entry.year ? String(entry.year) : '',
            entry.catno,
            entry.format,
            entry.role && !MAIN_ROLES.has(entry.role) ? entry.role : '',
          ].filter(Boolean).join(' · ')}
        </span>
      </span>

      <span className="cat__actions">
        {owned ? (
          <span className="cat__owned" title="Already in your library">
            <IconCheck size={13} painted={1.8} />
            In library
          </span>
        ) : (
          <>
            <button
              type="button"
              className="verify pressable"
              title="Search Soulseek for this release"
              onPointerDown={onSearch}
            >
              <IconSearch size={12} painted={1.5} />
              Search
            </button>
            <button
              type="button"
              className="verify pressable"
              disabled={wanted}
              title={wanted ? 'Already on your want list' : 'Keep it for later'}
              onPointerDown={onWant}
            >
              {wanted ? 'Wanted' : 'Want'}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

export function LabelBrowserView({
  catalog, library, artwork, onSearch, onWant, wantedUrls, onClose,
  watched, onToggleWatch, onSeen,
}: {
  catalog: Catalog;
  library?: LibrarySession;
  artwork?: ArtworkSession;
  onSearch(entry: CatalogEntry): void;
  onWant(entry: CatalogEntry): void;
  /** URLs already on the want list, so the action can say so. */
  wantedUrls: Set<string>;
  onClose(): void;
  /** Whether this catalogue is on the label watchlist. */
  watched?: boolean;
  /** Watch or unwatch, depending on `watched`. Absent for a catalogue that
   *  could never be re-opened, which `labels.watch` refuses anyway. */
  onToggleWatch?(): void;
  /** Report what this reading found, so the watchlist can show progress. */
  onSeen?(counts: { releaseCount: number; ownedCount: number; wantedCount: number }): void;
}) {
  const [hideOwned, setHideOwned] = useState(false);
  const [mainOnly, setMainOnly] = useState(true);
  const [filter, setFilter] = useState('');

  const owned = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const entry of catalog.releases) {
      map.set(entry.url, library?.hasRelease(entry.artist, entry.title) ?? false);
    }
    return map;
  }, [catalog.releases, library]);

  const ownedCount = useMemo(
    () => [...owned.values()].filter(Boolean).length,
    [owned],
  );

  const wantedCount = useMemo(
    () => catalog.releases.filter((r) => wantedUrls.has(r.url)).length,
    [catalog.releases, wantedUrls],
  );

  /* Report the reading once per catalogue load, NOT on every render and not
   * every time the want list changes underneath. `onSeen` writes to disk and
   * broadcasts, and wanting six records in a row while this screen is open
   * would be six writes, each restamping a figure whose whole point is to say
   * when the catalogue was read.
   *
   * Keyed on the catalogue's identity plus its length rather than on the
   * array, because `releases` is a fresh array on every store update.
   *
   * Leaving this screen and coming back DOES report again, because the ref
   * resets with the component. That is acceptable and arguably right: the
   * counts are recomputed against the library and want list as they are at
   * that moment, and the catalogue itself barely moves — a back catalogue not
   * moving is the premise the whole watchlist rests on. */
  const readingKey = catalog.loading || catalog.error
    ? null
    : `${catalog.sourceKind}:${catalog.kind}:${catalog.url ?? catalog.name}:${catalog.releases.length}`;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!readingKey || !onSeen || reported.current === readingKey) return;
    reported.current = readingKey;
    onSeen({
      releaseCount: catalog.releases.length,
      ownedCount,
      wantedCount,
    });
    // ownedCount and wantedCount are read at the moment the key changes, which
    // is the reading. They are deliberately not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingKey, onSeen]);

  /** Only offered on an artist discography, where Discogs annotates the role. */
  const hasRoles = useMemo(
    () => catalog.releases.some((r) => r.role && !MAIN_ROLES.has(r.role)),
    [catalog.releases],
  );

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return catalog.releases.filter((entry) => {
      if (hideOwned && owned.get(entry.url)) return false;
      if (mainOnly && hasRoles && entry.role && !MAIN_ROLES.has(entry.role)) return false;
      if (!needle) return true;
      return `${entry.artist} ${entry.title} ${entry.catno}`.toLowerCase().includes(needle);
    });
  }, [catalog.releases, filter, hideOwned, mainOnly, hasRoles, owned]);

  const provider = catalog.sourceKind ? PROVIDER_LABEL[catalog.sourceKind] : '';

  return (
    <>
      <header className="header header--plain">
        <div className="cat__header-actions">
          <button type="button" className="verify pressable" onPointerDown={onClose}>
            ← Back
          </button>
          {/* Only once the catalogue has actually loaded: watching something
              that failed to read would store a row that cannot be opened. */}
          {onToggleWatch && !catalog.loading && !catalog.error && (
            <WatchButton watched={Boolean(watched)} onToggle={onToggleWatch} />
          )}
        </div>
        <h1 className="pane__title">{catalog.name || 'Catalogue'}</h1>
        <p className="pane__subtitle tnum">
          {catalog.loading
            ? `Reading the ${provider} ${catalog.kind}…`
            : catalog.error
              ? ''
              : (
                <>
                  {catalog.releases.length} {catalog.releases.length === 1 ? 'release' : 'releases'}
                  {library?.available && <> · {ownedCount} in your library</>}
                  {' · '}{provider} {catalog.kind}
                  {/* A truncated list that claims to be whole hides exactly
                      the records you were digging for. */}
                  {!catalog.complete && <> · showing the first {catalog.releases.length}</>}
                </>
              )}
        </p>

        {!catalog.loading && !catalog.error && catalog.releases.length > 0 && (
          <div className="quick">
            <input
              className="settings__input cat__filter"
              value={filter}
              placeholder="Filter this catalogue…"
              aria-label="Filter this catalogue"
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />
            {library?.available && (
              <Chip active={hideOwned} onToggle={() => setHideOwned((v) => !v)}>
                Not in my library
              </Chip>
            )}
            {hasRoles && (
              <Chip active={mainOnly} onToggle={() => setMainOnly((v) => !v)}>
                Their own releases
              </Chip>
            )}
          </div>
        )}
      </header>

      <div className="pane__scroll">
        {catalog.loading ? (
          <div className="empty empty--section">
            <span className="empty__icon"><IconRelease size={28} painted={1.3} /></span>
            <p className="empty__title">Fetching the catalogue</p>
            <p className="empty__body">
              A big label runs to several pages, one request per second.
            </p>
          </div>
        ) : catalog.error ? (
          <div className="empty empty--section">
            <span className="empty__icon"><IconEmpty size={28} painted={1.3} /></span>
            <p className="empty__title">Could not read the catalogue</p>
            <p className="empty__body">
              {catalog.needs === 'discogsToken'
                ? 'Discogs needs a personal access token. Add one in Settings and try again.'
                : catalog.error}
            </p>
          </div>
        ) : shown.length === 0 ? (
          <div className="empty empty--section">
            <span className="empty__icon"><IconCheck size={28} painted={1.3} /></span>
            <p className="empty__title">
              {hideOwned && ownedCount > 0 ? 'You have all of it' : 'Nothing matches'}
            </p>
            <p className="empty__body">
              {hideOwned && ownedCount > 0
                ? `All ${catalog.releases.length} releases are already in your library.`
                : 'The filters are hiding every release in this catalogue.'}
            </p>
          </div>
        ) : (
          <div className="cats">
            {shown.map((entry) => (
              <Card
                key={entry.url || `${entry.artist}-${entry.title}`}
                entry={entry}
                owned={owned.get(entry.url) ?? false}
                artwork={artwork}
                onSearch={() => onSearch(entry)}
                onWant={() => onWant(entry)}
                wanted={wantedUrls.has(entry.url)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
