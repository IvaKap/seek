/*
 * Seek — the presentation pieces both transfer directions share.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Extracted from `DownloadsView` when uploads got a screen. Nothing here is
 * download-specific: a progress bar, a duration, and the release a group of
 * files belongs to are the same question whichever way the bytes are moving.
 *
 * What did NOT come with them is the whole reason uploads have their own view
 * rather than a filter on the downloads one — verify, organise, preview,
 * related, metadata are all things you do to a file you RECEIVED. None of them
 * mean anything about a file of your own that a stranger is fetching.
 */

import { useEffect } from 'react';
import type { TransferGroup } from '../data/transferStore.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import { parsePath } from '../domain/parsePath.ts';
import { duration } from '../domain/format.ts';
import { IconRelease } from '../icons/index.tsx';
import { Placeholder } from './ReleaseCard.tsx';
import { useNearViewport } from './useNearViewport.ts';

export function releaseOf(g: TransferGroup): { artist: string; release: string } {
  const first = g.transfers[0];
  if (!first) return { artist: '', release: g.title };
  const parsed = parsePath(first.path);
  return {
    artist: parsed.artist?.value ?? '',
    // The folder IS the release — the same assumption the whole app makes.
    release: parsed.release?.value ?? g.title,
  };
}

/** Seconds left → `3:07` or `1:02:44`. An em dash where it cannot be known:
 * 0 means no estimate, and `duration` alone would print 0:00. */
export function etaLabel(seconds: number | null): string {
  return duration(seconds || null);
}

/** The longest remaining file decides when the group is done. */
export function groupEta(g: TransferGroup): number | null {
  return g.transfers.reduce<number | null>(
    (max, t) => (t.secondsLeft === null ? max
      : max === null ? t.secondsLeft : Math.max(max, t.secondsLeft)),
    null,
  );
}

/* Spans, not divs, so a bar can sit inside a row's button. */
export function Bar({ done, total, state }: { done: number; total: number; state: string }) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <span className="prog" data-state={state}>
      {/* scaleX, not width — width animates layout every frame. */}
      <span className="prog__fill" style={{ transform: `scaleX(${pct / 100})` }} />
    </span>
  );
}

/**
 * `Artist — Release`, falling back to the folder name.
 *
 * Falls back rather than guessing: `parsePath` reports what it could actually
 * read, and a folder it cannot parse is shown verbatim instead of being
 * rendered as an empty artist and a mangled title. Half a parse looks like a
 * bug; the raw name at least matches what is on disk.
 */
export function ReleaseName({ g }: { g: TransferGroup }) {
  const { artist, release } = releaseOf(g);
  if (!artist) return <>{release || g.title}</>;
  /* Some folders name the artist twice — `Revenge Of The Jaguar - The Aztec
   * Mystic` parses to an artist that is also the start of the release, and
   * rendering both gives "Revenge Of The Jaguar — Revenge Of The Jaguar - …".
   * The release alone is the more complete of the two, so it wins. Observed on
   * real completed downloads, not imagined. */
  if (release.toLowerCase().startsWith(artist.toLowerCase())) {
    return <>{release}</>;
  }
  return (
    <>
      <span className="dl__artist">{artist}</span>
      <span className="dl__dash" aria-hidden> — </span>
      {release}
    </>
  );
}

/**
 * The record's cover, found from the artist and release `releaseOf` reads out
 * of the path, so it costs no new lookup path.
 *
 * Only asked for when NEAR the viewport. These lists are not virtualised, so a
 * Completed section with four hundred releases would otherwise queue four
 * hundred rate-limited MusicBrainz requests the moment it opened.
 */
export function Cover({ g, artwork, size }: {
  g: TransferGroup;
  artwork?: ArtworkSession;
  /** Downloads · Simple's two sizes; the plain one is the Completed row's. */
  size?: 'lead' | 'row';
}) {
  const { artist, release } = releaseOf(g);
  const key = `dl:${g.key}`;
  const [ref, near] = useNearViewport();

  // In an effect, not in render: React double-invokes render in development and
  // a network request is not something to fire while deciding what to draw.
  useEffect(() => {
    if (near) artwork?.want(key, artist, release);
  }, [near, artwork, key, artist, release]);

  const art = artwork?.get(key);
  return (
    <span className={size ? `art art--dl art--${size}` : 'art art--dl'} ref={ref} aria-hidden>
      <Placeholder seed={`${artist}${release}`} />
      <IconRelease size={13} painted={1.3} className="art__fallback" />
      {art?.state === 'ready' && (
        <img className="art__img" src={art.dataUri} alt="" loading="lazy" />
      )}
    </span>
  );
}
