/*
 * Seek — the release card, the default result presentation.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * docs/PRODUCT.md §4. The unit a DJ downloads is a folder, not a file, so the
 * folder is the object on screen. The card carries everything needed to answer
 * "is this the right copy, and can I get it fast?" without expanding anything:
 * artist, release, year, format summary, track count, total size, source count,
 * the recommended source inline, and the worst quality state in the folder.
 *
 * Artwork is a later phase, but its box is reserved at full size NOW, because
 * the performance budget says zero layout shift on artwork load and the only
 * way to guarantee that is to never let the layout depend on it.
 */

import type { Release, SourceFile } from '../domain/types.ts';
import { audioSpec, count, duration, fileSize, speed } from '../domain/format.ts';
import { worstAssessment } from '../domain/assessment.ts';
import { QualityIndicator } from './QualityIndicator.tsx';
import { hitTarget } from './controls.tsx';
import { PeerHistory } from './PeerHistory.tsx';
import { Flag } from './Flag.tsx';
import type { PeerLookup } from './PeerHistory.tsx';
import { AdvertisedSpeed, FormatBadge, Meta, QueueButton } from './rows.tsx';
import type { ArtState } from '../data/artworkStore.ts';
import type { QueueBadge } from '../data/transferStore.ts';
import { IconChevronDown, IconRelease, IconUsers } from '../icons/index.tsx';

/**
 * A deterministic two-tone mark derived from the release name. Flat, no letters,
 * no gradients — it should look intentional rather than broken, because for most
 * underground releases no artwork will ever be found.
 */
export function Placeholder({ seed }: { seed: string }) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const variant = h % 4;
  return (
    <svg viewBox="0 0 48 48" aria-hidden className="art__mark" style={{ '--h': hue } as React.CSSProperties}>
      <rect width="48" height="48" fill="var(--art-bg)" />
      {variant === 0 && <circle cx="24" cy="24" r="11" fill="var(--art-fg)" />}
      {variant === 1 && <rect x="13" y="13" width="22" height="22" fill="var(--art-fg)" />}
      {variant === 2 && <path d="M24 11 L37 35 L11 35 Z" fill="var(--art-fg)" />}
      {variant === 3 && (
        <>
          <rect x="9" y="9" width="14" height="14" fill="var(--art-fg)" />
          <rect x="25" y="25" width="14" height="14" fill="var(--art-fg)" />
        </>
      )}
    </svg>
  );
}

function recommended(files: SourceFile[]): SourceFile {
  let best = files[0];
  for (const f of files) if (f.score > best.score) best = f;
  return best;
}

export function ReleaseCard({
  art,
  owned,
  release, expanded, onToggle, onQueue, density, peers, copyCount = 1, onCompare,
  queueBadge = 'idle',
}: {
  /** Cover state for this release, if one has been asked for. */
  art?: ArtState;
  /** Already on disk. The single most useful thing to know about a result. */
  owned?: boolean;
  release: Release;
  expanded: boolean;
  onToggle(): void;
  onQueue(): void;
  density: 'comfortable' | 'compact' | 'table';
  /** The folder's live transfer badge, so Get reflects what happened. */
  queueBadge?: QueueBadge;
  /** How this peer has actually treated you. Absent means never met. */
  peers?: PeerLookup;
  /** How many copies of this record are in the results, this one included. */
  copyCount?: number;
  /** Open the comparison. Absent, or a lone copy, and no action is offered. */
  onCompare?(): void;
}) {
  const rec = recommended(release.files);
  const spec = audioSpec(rec.sampleRate, rec.bitDepth);
  const assessment = worstAssessment(release.files);
  const label = `${release.artist ? `${release.artist}, ` : ''}${release.title}`
    + `${release.year ? `, ${release.year}` : ''}. `
    + `${release.dominantLabel}, ${count(release.trackCount, 'track')}, ${fileSize(release.totalSize)}. `
    + `Quality: ${assessment.label}.`;

  const compare = onCompare && copyCount > 1 ? (
    <button
      type="button"
      className="copies pressable"
      /* Identifies WHICH release this node currently shows. The list is
         virtualised, so this same DOM node is recycled to other releases as the
         user scrolls — the sheet reads this before handing focus back, or it
         would return a keyboard user to a record they never opened. */
      data-release={release.id}
      /* Nested inside the row's own hit region, so both events have to be
         stopped or opening the comparison also collapses the row underneath it.
         `preventDefault` suppresses the focus the browser would otherwise give
         this button on mousedown, which arrives after the sheet has mounted and
         steals focus back out of the dialog. */
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onCompare();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        onCompare();
      }}
      aria-label={`Compare ${copyCount} copies of ${release.title}`}
      title={`${copyCount} people have this record — compare the copies`}
    >
      <IconUsers size={12} painted={1.5} />
      <span className="tnum">{copyCount}</span>
      {/* The word is dropped in a table row, where it shares the name's cell
          and every letter of it is a letter of the title cropped. */}
      {density !== 'table' && <span>copies</span>}
    </button>
  ) : null;

  /* TABLE density is a row of the shared column grid, not a flattened card: a
   * card's facts are a flex line packed to the right, which is why they never
   * sat under the column headers. Every value here is a `Meta` cell naming its
   * column, so it lands on that column's grid line whatever the user chose. */
  if (density === 'table') {
    const total = release.files.reduce((n, f) => n + (f.duration ?? 0), 0);
    return (
      <div className="row row--release" data-expanded={expanded ? 'true' : undefined}>
        <div
          className="row__hit"
          {...hitTarget(onToggle)}
          onPointerDown={(e) => { if (e.button === 0) onToggle(); }}
          aria-expanded={expanded}
          aria-label={label}
        >
          <span className="row__main">
            <span className="row__title">
              {release.artist && (
                <>
                  <span className="row__artist">{release.artist}</span>
                  <span className="row__dash" aria-hidden> — </span>
                </>
              )}
              <span className="row__name">{release.title}</span>
              {owned && (
                <span className="row__owned" title="You already have this release on disk">
                  in library
                </span>
              )}
              {release.files.some((f) => f.private) && (
                <span
                  className="row__private"
                  title="Only this peer's buddies can download this. Requesting it is refused unless they have added you."
                >
                  buddies only
                </span>
              )}
              {compare}
            </span>
            <span className="meta">
              <Meta col="format">
                <FormatBadge label={release.dominantLabel} tier={release.dominantTier} />
              </Meta>
              <Meta col="spec" dim>{spec ?? ''}</Meta>
              <Meta col="time">{total > 0 ? <span className="tnum">{duration(total)}</span> : ''}</Meta>
              <Meta col="size"><span className="tnum">{fileSize(release.totalSize)}</span></Meta>
              <AdvertisedSpeed bytesPerSec={release.peer.advertisedSpeed} />
              <Meta col="queue" dim={release.peer.queueLength === 0}>
                <span className="tnum">{release.peer.queueLength}</span> queued
              </Meta>
              <Meta col="check"><QualityIndicator assessment={assessment} /></Meta>
              <Meta col="user" dim>
                <Flag code={rec.peer.country} />
                {release.user}
              </Meta>
              <Meta col="bitrate" dim>
                {rec.bitrate ? <span className="tnum">{rec.bitrate} kbps</span> : ''}
              </Meta>
              <Meta col="year" dim>{release.year ? <span className="tnum">{release.year}</span> : ''}</Meta>
              <Meta col="files"><span className="tnum">{release.trackCount}</span> tracks</Meta>
              <Meta col="country"><Flag code={rec.peer.country} /></Meta>
              <Meta col="folder" dim title={release.folderPath}>{release.folder}</Meta>
            </span>
          </span>
        </div>
        <span className="row__actions">
          <QueueButton
            badge={queueBadge}
            onQueue={onQueue}
            label={`all ${release.trackCount} tracks of ${release.title} from ${release.user}`}
          />
        </span>
      </div>
    );
  }

  return (
    <article className="card" data-density={density} data-expanded={expanded ? 'true' : undefined}>
      {/* A div with role="button", not a <button>: this region contains the
          quality indicator, which is itself a button. See `hitTarget`. */}
      <div
        className="card__hit"
        {...hitTarget(onToggle)}
        onPointerDown={(e) => { if (e.button === 0) onToggle(); }}
        aria-expanded={expanded}
        aria-label={label}
      >
        {/* The placeholder always renders and always occupies the space, so a
            cover arriving later fades in over it and nothing shifts. */}
        <span className="art art--card" aria-hidden>
          <Placeholder seed={`${release.artist ?? ''}${release.title}`} />
          <IconRelease size={14} painted={1.3} className="art__fallback" />
          {art?.state === 'ready' && (
            <img className="art__img" src={art.dataUri} alt="" loading="lazy" />
          )}
        </span>

        {/* Completeness. Only shown when MusicBrainz actually knew the release
            — a missing count is silence, never "0 of 0". A short folder is the
            single most common disappointment in a Soulseek download. */}
        {art?.state === 'ready' && art.trackCount > 0
          && release.trackCount < art.trackCount && (
          <span
            className="partial"
            title={`MusicBrainz lists ${art.trackCount} tracks for this release; this folder has ${release.trackCount}.`}
          >
            <span className="tnum">{release.trackCount}</span> of{' '}
            <span className="tnum">{art.trackCount}</span>
          </span>
        )}

        {owned && (
          <span className="owned" title="You already have this release on disk">
            In library
          </span>
        )}

        {/* The default grouping is RELEASE, so a mark that only existed on the
            track and source rows was a mark nobody saw. Any file in the folder
            being buddy-only makes the whole folder undownloadable in practice,
            which is why this tests `some` rather than `every`. */}
        {release.files.some((f) => f.private) && (
          <span
            className="buddyonly"
            title="Only this peer's buddies can download this. Requesting it is refused unless they have added you."
          >
            Buddies only
          </span>
        )}

        <span className="card__body">
          <span className="card__heading">
            {release.artist && <span className="card__artist">{release.artist}</span>}
            <span className="card__title">{release.title}</span>
            <span className="card__sub">
              {release.year && <span className="tnum">{release.year}</span>}
              {release.year && release.catalogue && <span aria-hidden> · </span>}
              {release.catalogue && <span>{release.catalogue}</span>}
              {!release.year && !release.catalogue && (
                <span className="card__sub-dim">{release.user}</span>
              )}
            </span>
          </span>

          <span className="card__facts">
            <FormatBadge label={release.dominantLabel} tier={release.dominantTier} />
            {spec && <span className="card__fact tnum">{spec}</span>}
            <span className="card__fact tnum">{fileSize(release.totalSize)}</span>
            <span className="card__sep" aria-hidden>·</span>
            <span className="card__fact"><span className="tnum">{release.trackCount}</span> tracks</span>
            <QualityIndicator assessment={assessment} showLabel={density !== 'compact'} />
            {compare}
          </span>

          {density === 'comfortable' && (
            <span className="card__rec">
              <span className="card__rec-dot" aria-hidden />
              <span className="card__rec-label">Recommended source</span>
              <span className="card__rec-user">
                <Flag code={rec.peer.country} />
                {rec.user}
              </span>
              <span className="card__rec-sep" aria-hidden>·</span>
              <span
                className="card__rec-speed tnum"
                title="Speed advertised by the peer. A claim, not a measurement."
              >
                ≈ {speed(rec.peer.advertisedSpeed)}
              </span>
              <PeerHistory username={rec.user} peers={peers} />
              {rec.peer.freeSlots ? (
                <span className="card__rec-free">slot free</span>
              ) : (
                <span className="card__rec-queue">
                  <span className="tnum">{rec.peer.queueLength}</span> queued
                </span>
              )}
            </span>
          )}
        </span>

        <span className="card__tail">
          <span className="card__sources">
            <span className="tnum">{release.files.length}</span>
            <span> files</span>
            <IconChevronDown size={14} painted={1.5} className="card__chev" />
          </span>
        </span>
      </div>

      <span className="card__actions">
        <QueueButton
          badge={queueBadge}
          onQueue={onQueue}
          label={`all ${release.trackCount} tracks of ${release.title} from ${release.user}`}
          className="action action--primary pressable qbtn"
          withText
        />
      </span>
    </article>
  );
}
