/*
 * Seek — the per-result row.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The brief's specification, and the rules that come with it:
 *
 *   Burial — Archangel
 *   FLAC · 44.1/16 · 6:12 · 48.2 MB · ↓ 2.4 MB/s · 0 queued      ⌄ 12 sources
 *
 *  - tabular numerals on every number, everywhere;
 *  - the format badge is the ONLY colour in a row;
 *  - advertised speed is a promise, not a measurement, so it is rendered
 *    lighter and with a different glyph than a live rate would be;
 *  - the row is one hit target, and hover must not reflow it — the action zone
 *    is always present and always the same width, it only changes opacity.
 *
 * The metadata line is a grid with fixed column starts rather than inline text,
 * so the same field lands at the same x on every row and the eye can scan down
 * a column. Columns drop out at narrow widths instead of scrolling sideways.
 */

import type { ReactNode } from 'react';
import type { Release, SourceFile, TrackCluster, UserGroup } from '../domain/types.ts';
import { audioSpec, count, duration, fileSize, integer, speed } from '../domain/format.ts';
import {
  IconChevronDown, IconDownload, IconRelease, IconUser,
} from '../icons/index.tsx';
import { assess, worstAssessment } from '../domain/assessment.ts';
import { QualityIndicator } from './QualityIndicator.tsx';
import { hitTarget } from './controls.tsx';
import { PeerHistory } from './PeerHistory.tsx';
import { Flag } from './Flag.tsx';
import type { PeerLookup } from './PeerHistory.tsx';

/* ------------------------------------------------------------------ badge */

export function FormatBadge({ label, tier, title }: { label: string; tier: string; title?: string }) {
  return (
    <span className="badge" data-tier={tier} title={title}>
      {label}
    </span>
  );
}

/* ------------------------------------------------------- quality indicator */

/** Five states, shape-first. See domain/assessment.ts for the language rules. */
export function Quality({ file }: { file: SourceFile }) {
  return <QualityIndicator assessment={assess(file)} />;
}

/* ------------------------------------------------------------- meta pieces */

function Meta({ children, dim, title }: { children: ReactNode; dim?: boolean; title?: string }) {
  return (
    <span className="meta__cell" data-dim={dim ? 'true' : undefined} title={title}>
      {children}
    </span>
  );
}

/**
 * The peer's own claim about its speed. Rendered lighter and with a distinct
 * glyph (a chevron, not the download arrow a live transfer uses) so a promise
 * is never mistaken for a measurement.
 */
function AdvertisedSpeed({ bytesPerSec }: { bytesPerSec: number }) {
  return (
    <span
      className="meta__cell meta__speed"
      title="Speed advertised by the peer. This is a claim, not a measurement."
    >
      <span aria-hidden className="meta__speed-glyph">≈</span>
      <span className="tnum">{speed(bytesPerSec)}</span>
    </span>
  );
}

/* ------------------------------------------------------------- track row */

export function TrackRow({
  track, expanded, onToggle, onQueue, selected,
}: {
  track: TrackCluster;
  expanded: boolean;
  onToggle(): void;
  onQueue(): void;
  selected: boolean;
}) {
  const best = track.best;
  const spec = audioSpec(best.sampleRate, best.bitDepth);
  const sources = track.sources.length;

  return (
    <div
      className="row"
      data-selected={selected ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
    >
      {/* role="button", not <button>: these rows contain the quality
          indicator, which is a button itself. See `hitTarget`. */}
      <div
        className="row__hit"
        {...hitTarget(() => { if (sources > 1) onToggle(); })}
        onPointerDown={(e) => {
          if (e.button === 0 && sources > 1) onToggle();
        }}
        aria-expanded={sources > 1 ? expanded : undefined}
        aria-label={`${track.displayArtist ? `${track.displayArtist}, ` : ''}${track.displayTitle}. ${best.quality.description}. ${count(sources, 'source')}.`}
      >
        <span className="row__main">
          <span className="row__title">
            {track.displayArtist && (
              <>
                <span className="row__artist">{track.displayArtist}</span>
                <span className="row__dash" aria-hidden> — </span>
              </>
            )}
            <span className="row__name" data-raw={track.fallback ? 'true' : undefined}>
              {track.displayTitle}
            </span>
            {track.fallback && (
              <span
                className="row__unparsed"
                title="Seek could not read an artist and title from this path, so the filename is shown exactly as the peer sent it."
              >
                unparsed
              </span>
            )}
          </span>

          <span className="meta">
            <Meta>
              <FormatBadge
                label={best.quality.label}
                tier={best.quality.tier}
                title={best.quality.description}
              />
            </Meta>
            <Meta dim>{spec ?? ''}</Meta>
            <Meta><span className="tnum">{duration(track.duration)}</span></Meta>
            <Meta><span className="tnum">{fileSize(best.size)}</span></Meta>
            <AdvertisedSpeed bytesPerSec={best.peer.advertisedSpeed} />
            <Meta dim={best.peer.queueLength === 0}>
              <span className="tnum">{best.peer.queueLength}</span> queued
            </Meta>
            <Quality file={best} />
          </span>
        </span>

        <span className="row__tail">
          {sources > 1 && (
            <span className="row__sources">
              <span className="tnum">{integer(sources)}</span> sources
              <IconChevronDown size={14} painted={1.5} className="row__chev" />
            </span>
          )}
        </span>
      </div>

      <span className="row__actions">
        <button
          type="button"
          className="action pressable"
          onPointerDown={(e) => { e.stopPropagation(); onQueue(); }}
          aria-label={`Queue ${track.displayTitle} from ${best.user}`}
          title="Queue from the best source"
        >
          <IconDownload size={16} painted={1.6} />
        </button>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ release row */

export function ReleaseRow({
  release, expanded, onToggle, onQueue, selected,
}: {
  release: Release;
  expanded: boolean;
  onToggle(): void;
  onQueue(): void;
  selected: boolean;
}) {
  return (
    <div
      className="row row--release"
      data-selected={selected ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
    >
      {/* role="button", not <button>: these rows contain the quality
          indicator, which is a button itself. See `hitTarget`. */}
      <div
        className="row__hit"
        {...hitTarget(onToggle)}
        onPointerDown={(e) => { if (e.button === 0) onToggle(); }}
        aria-expanded={expanded}
        aria-label={`${release.artist ? `${release.artist}, ` : ''}${release.title}. ${count(release.trackCount, 'track')}, ${fileSize(release.totalSize)}, from ${release.user}.`}
      >
        {/* Artwork is a later phase. The space is reserved now so that when art
            arrives it cannot shift the layout by a single pixel. */}
        <span className="art" aria-hidden data-placeholder="true">
          <IconRelease size={16} painted={1.4} />
        </span>

        <span className="row__main">
          <span className="row__title">
            {release.artist && (
              <>
                <span className="row__artist">{release.artist}</span>
                <span className="row__dash" aria-hidden> — </span>
              </>
            )}
            <span className="row__name">{release.title}</span>
            {release.year && <span className="row__year tnum">{release.year}</span>}
          </span>

          <span className="meta">
            <Meta>
              <FormatBadge label={release.dominantLabel} tier={release.dominantTier} />
            </Meta>
            <Meta><span className="tnum">{release.trackCount}</span> tracks</Meta>
            <Meta><span className="tnum">{fileSize(release.totalSize)}</span></Meta>
            <AdvertisedSpeed bytesPerSec={release.peer.advertisedSpeed} />
            <Meta dim>{release.user}</Meta>
            <QualityIndicator assessment={worstAssessment(release.files)} />
          </span>
        </span>

        <span className="row__tail">
          <span className="row__sources">
            open
            <IconChevronDown size={14} painted={1.5} className="row__chev" />
          </span>
        </span>
      </div>

      <span className="row__actions">
        <button
          type="button"
          className="action pressable"
          onPointerDown={(e) => { e.stopPropagation(); onQueue(); }}
          aria-label={`Queue all ${release.trackCount} tracks of ${release.title}`}
          title="Grab the whole folder"
        >
          <IconDownload size={16} painted={1.6} />
        </button>
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- user row */

export function UserRow({
  group, expanded, onToggle, selected, onBrowse,
}: {
  group: UserGroup;
  expanded: boolean;
  onToggle(): void;
  selected: boolean;
  /** Open this peer's whole share — the vision note's "show me everything
   *  this person has", which is the point of grouping by user at all. */
  onBrowse?(username: string): void;
}) {
  const p = group.peer;
  return (
    <div
      className="row row--user"
      data-selected={selected ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
    >
      {/* role="button", not <button>: these rows contain the quality
          indicator, which is a button itself. See `hitTarget`. */}
      <div
        className="row__hit"
        {...hitTarget(onToggle)}
        onPointerDown={(e) => { if (e.button === 0) onToggle(); }}
        aria-expanded={expanded}
        aria-label={`${group.user}. ${count(group.files.length, 'file')}, ${fileSize(group.totalSize)}. ${p.freeSlots ? 'Slot free' : 'No free slot'}, ${p.queueLength} queued.`}
      >
        <span className="art" aria-hidden data-placeholder="true">
          <IconUser size={16} painted={1.4} />
        </span>
        <span className="row__main">
          <span className="row__title">
            <span className="row__name">{group.user}</span>
            {p.freeSlots && <span className="row__free">slot free</span>}
          </span>
          <span className="meta">
            <Meta><FormatBadge label={bestLabel(group)} tier={group.bestTier} /></Meta>
            <Meta><span className="tnum">{group.files.length}</span> files</Meta>
            <Meta><span className="tnum">{fileSize(group.totalSize)}</span></Meta>
            <AdvertisedSpeed bytesPerSec={p.advertisedSpeed} />
            <Meta dim={p.queueLength === 0}>
              <span className="tnum">{p.queueLength}</span> queued
            </Meta>
          </span>
        </span>
        <span className="row__tail">
          <span className="row__sources">
            browse
            <IconChevronDown size={14} painted={1.5} className="row__chev" />
          </span>
        </span>
      </div>
      <span className="row__actions">
        {onBrowse && (
          <button
            type="button"
            className="action pressable"
            aria-label={`Browse everything ${group.user} shares`}
            title={`Browse everything ${group.user} shares`}
            onPointerDown={(e) => { e.stopPropagation(); onBrowse(group.user); }}
          >
            Browse
          </button>
        )}
      </span>
    </div>
  );
}

function bestLabel(group: UserGroup): string {
  let label = '—';
  let best = -1;
  for (const f of group.files) {
    if (f.quality.score > best) {
      best = f.quality.score;
      label = f.quality.label;
    }
  }
  return label;
}

/* ------------------------------------------------------------- source row */

export function SourceRow({
  source, last, onQueue, context = 'peers', peers,
}: {
  source: SourceFile;
  last: boolean;
  onQueue(): void;
  /** What the surrounding list is grouping by. See the Row union's note. */
  context?: 'peers' | 'files';
  /** How this peer has actually treated you. Absent means never met. */
  peers?: PeerLookup;
}) {
  const spec = audioSpec(source.sampleRate, source.bitDepth);
  return (
    <div className="row row--source" data-last={last ? 'true' : undefined}>
      <span className="row__rail" aria-hidden />
      {/* role="button", not <button>: these rows contain the quality
          indicator, which is a button itself. See `hitTarget`. */}
      <div
        className="row__hit"
        {...hitTarget(onQueue)}
        onPointerDown={(e) => { if (e.button === 0) onQueue(); }}
        aria-label={`${context === 'files' ? `${source.parsed.displayTitle}. ` : ''}${source.user}. ${source.quality.description}. ${source.peer.freeSlots ? 'Slot free' : 'No free slot'}, ${source.peer.queueLength} queued.`}
      >
        <span className="row__main">
          {/* Under a release, the track name IS the row's identity — without it
              every file in the album reads as the same anonymous line. */}
          {context === 'files' && (
            <span className="row__title row__title--source" title={source.parsed.filename}>
              {source.parsed.trackNumber && (
                <span className="row__tracknum tnum">
                  {String(source.parsed.trackNumber.value).padStart(2, '0')}
                </span>
              )}
              {source.parsed.displayTitle}
            </span>
          )}
          <span className="meta meta--source">
            <Meta>
              <FormatBadge
                label={source.quality.label}
                tier={source.quality.tier}
                title={source.quality.description}
              />
            </Meta>
            <Meta dim>{spec ?? ''}</Meta>
            <Meta><span className="tnum">{duration(source.duration)}</span></Meta>
            <Meta><span className="tnum">{fileSize(source.size)}</span></Meta>
            <AdvertisedSpeed bytesPerSec={source.peer.advertisedSpeed} />
            <Meta dim={source.peer.queueLength === 0}>
              <span className="tnum">{source.peer.queueLength}</span> queued
            </Meta>
            <Quality file={source} />
            <Meta dim>
              <Flag code={source.peer.country} />
              {source.user}
              {/* Compact here: the cell is already the narrowest in the grid,
                  and "with you" is spelled out on the release card above. */}
              <PeerHistory username={source.user} peers={peers} compact />
            </Meta>
          </span>
        </span>
        <span className="row__tail">
          {source.peer.freeSlots && <span className="row__free">free</span>}
        </span>
      </div>
      <span className="row__actions">
        <button
          type="button"
          className="action pressable"
          onPointerDown={(e) => { e.stopPropagation(); onQueue(); }}
          aria-label={`Queue from ${source.user}`}
          title={`Queue from ${source.user}`}
        >
          <IconDownload size={16} painted={1.6} />
        </button>
      </span>
    </div>
  );
}
