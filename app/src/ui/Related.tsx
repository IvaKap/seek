/*
 * Seek — the Related panel.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Two questions, answered separately: what else did this artist make, and what
 * else is on this label. `DISCOVERY.md` is right that they must not be merged
 * into one "similar" list — they are different reasons to be interested, and a
 * mixed list answers neither.
 *
 * It renders NOTHING when there is nothing to show. No empty state, no "no
 * related music found" — a section that appears only when it has something is
 * a section you learn to trust, and one that always appears is furniture you
 * learn to skip. `DISCOVERY.md` asks for this explicitly and it is right.
 */

import type { CatalogEntry } from '../data/catalogStore.ts';
import type { RelatedResult } from '../data/relatedStore.ts';
import { Placeholder } from './ReleaseCard.tsx';
import { IconRelease, IconSearch } from '../icons/index.tsx';

function Tile({
  entry, owned, onSearch, onWant, wanted,
}: {
  entry: CatalogEntry;
  owned: boolean;
  onSearch(): void;
  onWant(): void;
  wanted: boolean;
}) {
  const detail = [entry.year ? String(entry.year) : '', entry.catno]
    .filter(Boolean).join(' · ');

  return (
    <li className="rel__tile" data-owned={owned ? 'true' : undefined}>
      <span className="rel__art" aria-hidden>
        <Placeholder seed={`${entry.artist}${entry.title}`} />
        <IconRelease size={12} painted={1.3} className="art__fallback" />
      </span>
      <span className="rel__text">
        <span className="rel__title" title={`${entry.artist} — ${entry.title}`}>
          {entry.title}
        </span>
        <span className="rel__artist">{entry.artist}</span>
        {detail && <span className="rel__detail tnum">{detail}</span>}
      </span>
      <span className="rel__actions">
        {owned ? (
          <span className="rel__owned">In library</span>
        ) : (
          <>
            <button
              type="button" className="rel__act pressable"
              title="Search Soulseek for this" onPointerDown={onSearch}
            >
              <IconSearch size={11} painted={1.5} />
            </button>
            <button
              type="button" className="rel__act pressable"
              disabled={wanted}
              title={wanted ? 'Already on your want list' : 'Keep it for later'}
              onPointerDown={onWant}
            >
              {wanted ? '✓' : '+'}
            </button>
          </>
        )}
      </span>
    </li>
  );
}

function Shelf({
  heading, entries, ...rest
}: {
  heading: string;
  entries: CatalogEntry[];
  isOwned(entry: CatalogEntry): boolean;
  onSearch(entry: CatalogEntry): void;
  onWant(entry: CatalogEntry): void;
  isWanted(entry: CatalogEntry): boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="rel__shelf">
      <h3 className="rel__heading">{heading}</h3>
      {/* Horizontal scroll rather than a wrapping grid: a shelf says "there is
          more this way" in a way a truncated grid does not. */}
      <ul className="rel__row">
        {entries.map((entry) => (
          <Tile
            key={entry.url || `${entry.artist}-${entry.title}`}
            entry={entry}
            owned={rest.isOwned(entry)}
            wanted={rest.isWanted(entry)}
            onSearch={() => rest.onSearch(entry)}
            onWant={() => rest.onWant(entry)}
          />
        ))}
      </ul>
    </section>
  );
}

export function Related({
  result, artist, isOwned, isWanted, onSearch, onWant,
}: {
  result: RelatedResult | undefined;
  /** The artist this was asked about, for the heading. */
  artist: string;
  isOwned(entry: CatalogEntry): boolean;
  isWanted(entry: CatalogEntry): boolean;
  onSearch(entry: CatalogEntry): void;
  onWant(entry: CatalogEntry): void;
}) {
  if (!result) return null;

  if (result.state === 'looking') {
    return <p className="rel__status">Looking for related releases…</p>;
  }

  if (result.state === 'failed') {
    // Only worth saying anything when it is fixable. A lookup that simply
    // found nothing is silence, not an error message.
    return result.needs === 'discogsToken' ? (
      <p className="rel__status">
        Related releases come from Discogs — add a personal access token in
        Settings.
      </p>
    ) : null;
  }

  if (result.byArtist.length === 0 && result.byLabel.length === 0) return null;

  return (
    <div className="rel">
      <Shelf
        heading={artist ? `More by ${artist}` : 'More by this artist'}
        entries={result.byArtist}
        isOwned={isOwned} isWanted={isWanted} onSearch={onSearch} onWant={onWant}
      />
      <Shelf
        heading={result.labelName ? `More on ${result.labelName}` : 'More on this label'}
        entries={result.byLabel}
        isOwned={isOwned} isWanted={isWanted} onSearch={onSearch} onWant={onWant}
      />
    </div>
  );
}
