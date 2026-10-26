/*
 * Seek — Search · Simple's list: every version of what you searched for.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Below the best picks, one row per version: a track in one format and one
 * size, however many people share it, or a record in one format. The row says
 * what it is in plain words (format, length, size, the size check's verdict
 * as a phrase) and how many copies there are; Get takes the copy the row
 * shows, which is the best-ranked one, and the copies open beneath it (a
 * record's open as the comparison) for anyone who wants a particular person's.
 *
 * The copy a row shows HOLDS STILL while the pointer or focus is on it. A
 * better copy can arrive on any tick, and it must not swap what Get takes
 * between reading the row and pressing it (BestPicks.tsx has the same rule).
 *
 * Grouping lives in domain/group.ts (`versions`) and domain/bestSources.ts
 * (`releaseVersions`). These rows render in ResultList's virtualiser like any
 * other, so the list-animation rules there hold here too.
 */

import { useEffect, useRef, useState } from 'react';
import type { Row } from '../data/searchStore.ts';
import type { ArtState } from '../data/artworkStore.ts';
import type { QueueBadge, TransferState } from '../data/transferStore.ts';
import { closedLabel } from '../data/searchStore.ts';
import { WISHLIST_REASON } from '../data/searchTabs.ts';
import { queueBadge, transferKey } from '../data/transferStore.ts';
import type { Release, SortKey, SourceFile, TrackCluster } from '../domain/types.ts';
import { assess, worstAssessment } from '../domain/assessment.ts';
import { count, duration, fileSize, integer, slotWords } from '../domain/format.ts';
import { IconChevronDown } from '../icons/index.tsx';
import { QualityIndicator } from './QualityIndicator.tsx';
import { FormatBadge, QueueButton, TitleLine } from './rows.tsx';
import { Placeholder } from './ReleaseCard.tsx';
import { Select, hitTarget } from './controls.tsx';

/* --------------------------------------------------------- the status line */

/** Who has answered, in place of a file count: the number that grows. */
export function Answered({ running, people, closedReason }: {
  running: boolean;
  people: number;
  closedReason: string | null;
}) {
  const who = `${integer(people)} ${people === 1 ? 'person' : 'people'}`;
  if (running) {
    return (
      <p className="answered tnum" data-live="true">
        {people === 0
          ? 'Asking the network…'
          : `${who} ${people === 1 ? 'has' : 'have'} answered so far. Seek keeps listening for more.`}
      </p>
    );
  }
  if (!closedReason) return null;
  if (closedReason === WISHLIST_REASON) {
    return <p className="answered tnum">What your wishlist found when it last ran. Press Return to search again now.</p>;
  }
  const closed = closedLabel(closedReason);
  return (
    <p className="answered tnum" title={closed.title}>
      {people > 0 && `${who} answered. `}
      {closedReason === 'disconnected' ? 'Signed out.' : `Seek ${closed.text}.`}
    </p>
  );
}

/* ------------------------------------------------------------- the heading */

const SORT_WORDS: Array<{ value: SortKey; label: string }> = [
  { value: 'best', label: 'Best first' },
  { value: 'quality', label: 'Best quality first' },
  { value: 'speed', label: 'Fastest first' },
  { value: 'queue', label: 'Shortest queue first' },
  { value: 'size', label: 'Largest first' },
  { value: 'name', label: 'By name' },
];

export function CopiesHeading({ rows, sort, onSort }: {
  rows: Row[];
  sort: SortKey;
  onSort(s: SortKey): void;
}) {
  let versions = 0;
  let copies = 0;
  for (const r of rows) {
    if (r.kind === 'track') { versions += 1; copies += r.track.sources.length; }
    if (r.kind === 'release') { versions += 1; copies += r.copies?.length ?? 1; }
  }
  return (
    <div className="copies-head">
      <h2 className="copies-head__title">
        All copies
        <span className="copies-head__count tnum">{count(versions, 'version')} · {count(copies, 'copy', 'copies')}</span>
      </h2>
      <Select label="Sort copies" value={sort} onChange={onSort} options={SORT_WORDS} />
    </div>
  );
}

/* ----------------------------------------------------------------- the rows */

function Cover({ seed, art }: { seed: string; art?: ArtState }) {
  return (
    <span className="art simple__art" aria-hidden>
      <Placeholder seed={seed} />
      {art?.state === 'ready' && <img className="art__img" src={art.dataUri} alt="" loading="lazy" />}
    </span>
  );
}

const UNRECOGNISED = 'Seek could not read an artist and title from this file name, so it is shown exactly as the peer sent it.';

/** The copy to show: the best one, or while the row is held, the one it showed. */
function useHeld<T extends { id: string }>(copies: T[]) {
  const [holding, setHolding] = useState(false);
  const last = useRef(copies[0]);
  const shown = (holding && copies.find((c) => c.id === last.current.id)) || copies[0];
  useEffect(() => { last.current = shown; });
  const hold = {
    onPointerEnter: () => setHolding(true),
    onPointerLeave: () => setHolding(false),
    onFocus: () => setHolding(true),
    onBlur: (e: React.FocusEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHolding(false);
    },
  };
  return [shown, hold] as const;
}

/** One version of a track. Its copies open beneath it. */
export function SimpleTrackRow({ track, folder, art, expanded, onToggle, onQueue, queueStates }: {
  track: TrackCluster;
  /** The folder the shown copy sits in, for its cover. */
  folder?: Release | null;
  art?: ArtState;
  expanded: boolean;
  onToggle(): void;
  /** Queue exactly this copy. */
  onQueue(copy: SourceFile): void;
  queueStates?: Map<string, TransferState>;
}) {
  const [best, hold] = useHeld(track.sources);
  const copies = track.sources.length;
  const assessment = assess(best);
  // The version is what you took, so a copy queued from beneath counts too.
  const state = track.sources.map((s) => queueStates?.get(transferKey(s.user, s.path))).find(Boolean);
  return (
    <div className="row row--simple" data-expanded={expanded ? 'true' : undefined} {...hold}>
      <div
        className="row__hit"
        {...hitTarget(() => { if (copies > 1) onToggle(); })}
        onPointerDown={(e) => { if (e.button === 0 && copies > 1) onToggle(); }}
        aria-expanded={copies > 1 ? expanded : undefined}
        aria-label={`${track.displayArtist ? `${track.displayArtist}, ` : ''}${track.displayTitle}. ${best.quality.label}, ${fileSize(best.size)}. ${assessment.short}. ${count(copies, 'copy', 'copies')}.`}
      >
        <Cover seed={folder ? `${folder.artist ?? ''}${folder.title}` : `${track.displayArtist ?? ''}${track.displayTitle}`} art={art} />
        <span className="row__main">
          <TitleLine of={track} unparsed={UNRECOGNISED} word="name not recognised" />
          <span className="simple__facts tnum">
            <FormatBadge label={best.quality.label} tier={best.quality.tier} title={best.quality.description} />
            <span>{track.duration === null ? 'length unknown' : duration(track.duration)}</span>
            <span>{fileSize(best.size)}</span>
            <span title={`From ${best.user}`}>{slotWords(best.peer)}</span>
            <QualityIndicator assessment={assessment} text={assessment.short} />
          </span>
        </span>
        <span className="simple__copies tnum">
          {count(copies, 'copy', 'copies')}
          {copies > 1 && <IconChevronDown size={13} painted={1.5} className="row__chev" />}
        </span>
      </div>
      <span className="row__actions">
        <QueueButton
          badge={queueBadge(state)}
          onQueue={() => onQueue(best)}
          label={`${track.displayTitle} from ${best.user}`}
          className="action action--primary pressable qbtn"
          withText
        />
      </span>
    </div>
  );
}

/** One record in one format. Its tracks open beneath it; its copies, as the comparison. */
export function SimpleReleaseRow({ copies, art, expanded, onToggle, onQueue, badge, onCompare }: {
  /** Best first. The first is the one the row shows, unless it is held. */
  copies: Release[];
  art?: ArtState;
  expanded: boolean;
  onToggle(): void;
  /** Queue exactly this folder. */
  onQueue(copy: Release): void;
  badge: QueueBadge;
  /** Open the comparison, marking the copy the row shows as the one clicked. */
  onCompare?(shown: Release): void;
}) {
  const [release, hold] = useHeld(copies);
  const assessment = worstAssessment(release.files);
  const many = copies.length > 1;
  return (
    <div className="row row--simple" data-expanded={expanded ? 'true' : undefined} {...hold}>
      <div
        className="row__hit"
        {...hitTarget(onToggle)}
        onPointerDown={(e) => { if (e.button === 0) onToggle(); }}
        aria-expanded={expanded}
        aria-label={`${release.artist ? `${release.artist}, ` : ''}${release.title}, ${count(release.trackCount, 'track')}. ${release.dominantLabel}, ${fileSize(release.totalSize)}. ${assessment.short}. ${count(copies.length, 'copy', 'copies')}.`}
      >
        <Cover seed={`${release.artist ?? ''}${release.title}`} art={art} />
        <span className="row__main">
          <span className="row__title">
            {release.artist && (
              <>
                <span className="row__artist">{release.artist}</span>
                <span className="row__dash" aria-hidden> — </span>
              </>
            )}
            <span className="row__name">{release.title}</span>
            <span className="row__tag">release</span>
          </span>
          <span className="simple__facts tnum">
            <FormatBadge label={release.dominantLabel} tier={release.dominantTier} />
            <span>{count(release.trackCount, 'track')}</span>
            <span>{fileSize(release.totalSize)}</span>
            <span title={`From ${release.user}`}>{slotWords(release.peer)}</span>
            <QualityIndicator assessment={assessment} text={assessment.short} />
          </span>
        </span>
        {many && onCompare ? (
          <button
            type="button"
            className="simple__copies simple__compare tnum"
            title="Compare every copy, and pick whose to download"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onCompare(release); }}
          >
            {count(copies.length, 'copy', 'copies')}
          </button>
        ) : (
          <span className="simple__copies tnum">{count(copies.length, 'copy', 'copies')}</span>
        )}
      </div>
      <span className="row__actions">
        <QueueButton
          badge={badge}
          onQueue={() => onQueue(release)}
          label={`all ${release.trackCount} tracks of ${release.title} from ${release.user}`}
          className="action action--primary pressable qbtn"
          withText
        />
      </span>
    </div>
  );
}
