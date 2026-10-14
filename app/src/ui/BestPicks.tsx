/*
 * Seek — best picks: the row of cards that leads Search · Simple, and the
 * line of chips above Collector's results.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Which copies earn a card is domain/bestPicks.ts. This decides what a card
 * says, and when it may change.
 *
 * A CARD NEVER CHANGES UNDER YOU. Results stream in for half a minute and a
 * better copy can arrive on any tick, but the card you are reaching for has to
 * still be the copy you read when you press Get. So the row holds still while
 * the pointer or focus is inside it, and a card you pressed Get on keeps its
 * copy for as long as that copy is in the results, with its live state on the
 * button. The list below keeps the same rule ([5] in ResultList.tsx).
 *
 * The Get button says who it is ASKING until the peer answers, because
 * upstream marks a file queued the moment Get is pressed, before the peer has
 * said a word (the corner panel's rule). A place in line, a start or a finish
 * is an answer.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Row } from '../data/searchStore.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import type { QueueBadge, Transfer, TransferSession, TransferState } from '../data/transferStore.ts';
import { folderKey, queueBadge, transferKey } from '../data/transferStore.ts';
import { bestPicks, pickId } from '../domain/bestPicks.ts';
import type { BestPick, PickKind, PickPins, PickPool } from '../domain/bestPicks.ts';
import type { DownloadPrefs } from '../domain/preferences.ts';
import { assess, worstAssessment } from '../domain/assessment.ts';
import { count, fileSize, integer, ordinal, slotWords, speed } from '../domain/format.ts';
import { QualityIndicator } from './QualityIndicator.tsx';
import { FormatBadge, QueueButton } from './rows.tsx';
import { Placeholder } from './ReleaseCard.tsx';

const KIND: Record<PickKind, string> = {
  overall: 'Best overall',
  fastest: 'Fastest',
  release: 'Whole release',
};

/** Collector's strip, where the chip's own facts say the rest. */
const KIND_SHORT: Record<PickKind, string> = {
  overall: 'Overall',
  fastest: 'Fastest',
  release: 'Release',
};

/** What a Get says between the press and the download starting. */
function waitingWords(transfers: Transfer[], user: string): string {
  if (transfers.some((t) => t.state === 'getting_status')) return 'Starting…';
  const places = transfers.flatMap((t) => (t.state === 'queued' && t.queuePosition !== null ? [t.queuePosition] : []));
  return places.length > 0 ? `Queued · ${ordinal(Math.min(...places))} in line` : `Asking ${user}…`;
}

/** Everything a card shows, from either kind of pick. */
function view(p: BestPick) {
  if (p.kind === 'release') {
    const r = p.release;
    return {
      artist: r.artist, title: r.title, raw: false,
      format: { label: r.dominantLabel, tier: r.dominantTier, title: undefined as string | undefined },
      facts: [count(r.trackCount, 'track'), fileSize(r.totalSize)],
      assessment: worstAssessment(r.files),
      peer: r.peer, cover: r,
      get: `Get all ${integer(r.trackCount)}`,
      label: `all ${r.trackCount} tracks of ${r.title} from ${r.user}`,
    };
  }
  const s = p.source;
  const spec = s.quality.lossless
    ? (s.sampleRate ? `${s.sampleRate / 1000} kHz${s.bitDepth ? ` · ${s.bitDepth}-bit` : ''}` : null)
    : (s.vbr === null ? null : s.vbr ? 'VBR' : 'CBR');
  return {
    artist: s.parsed.displayArtist, title: s.parsed.displayTitle, raw: s.parsed.fallback,
    format: { label: s.quality.label, tier: s.quality.tier, title: s.quality.description },
    facts: [...(spec ? [spec] : []), fileSize(s.size)],
    assessment: assess(s),
    peer: s.peer, cover: p.folder,
    get: 'Get',
    label: `${s.parsed.displayTitle} from ${s.user}`,
  };
}

export function BestPicks({
  pool, rules, transfers, queueStates, folderStates, artwork, onQueue, compact = false,
}: {
  /** Collector's form: one line of chips above the table, each a Get. */
  compact?: boolean;
  pool: PickPool;
  rules: DownloadPrefs;
  transfers: Pick<TransferSession, 'all' | 'groups'>;
  queueStates: Map<string, TransferState>;
  folderStates: Map<string, QueueBadge>;
  artwork?: ArtworkSession;
  onQueue(row: Row): void;
}) {
  const headingId = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  /** The picks last on screen, and the ones Get was pressed on. */
  const shown = useRef<BestPick[]>([]);
  const pressed = useRef(new Set<string>());

  const badgeOf = (p: BestPick): QueueBadge => (p.kind === 'release'
    ? folderStates.get(folderKey(p.release.peer.username, p.release.folderPath)) ?? 'idle'
    : queueBadge(queueStates.get(transferKey(p.source.user, p.source.path))));

  const held: PickPins = {};
  for (const p of shown.current) {
    const id = pickId(p);
    if (hover || focus || pressed.current.has(id) || badgeOf(p) !== 'idle') held[p.kind] = id;
  }
  const { overall, fastest, release } = held;
  const picks = useMemo(
    () => bestPicks(pool, rules, { overall, fastest, release }),
    [pool, rules, overall, fastest, release],
  );
  useEffect(() => { shown.current = picks; }, [picks]);

  useEffect(() => {
    if (!artwork?.enabled || compact) return;
    for (const p of picks) {
      const r = p.kind === 'release' ? p.release : p.folder;
      if (r) artwork.want(r.id, r.artist, r.title);
    }
  }, [picks, artwork, compact]);

  if (picks.length === 0) return null;

  return (
    <section
      className={compact ? 'pickchips' : 'picks'}
      aria-labelledby={headingId}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false); }}
    >
      <h2 className="picks__title" id={headingId}>Best picks</h2>
      <div className={compact ? 'pickchips__row' : 'picks__row'}>
        {picks.map((p) => {
          const v = view(p);
          const started = p.kind === 'release'
            ? transfers.groups.find((g) => g.key === folderKey(p.release.peer.username, p.release.folderPath))?.transfers ?? []
            : transfers.all.filter((t) => transferKey(t.username, t.path) === transferKey(p.source.user, p.source.path));
          const get = (className: string, children?: React.ReactNode) => (
            <QueueButton
              key={`${p.kind}:${pickId(p)}`}
              badge={badgeOf(p)}
              label={compact ? `${v.label}, ${KIND[p.kind].toLowerCase()}` : v.label}
              className={className}
              withText
              texts={{ idle: v.get, queued: waitingWords(started, v.peer.username), done: 'In Completed' }}
              onQueue={() => {
                pressed.current.add(pickId(p));
                onQueue(p.kind === 'release'
                  ? { kind: 'release', id: p.release.id, release: p.release, tick: p.release.tick }
                  : { kind: 'file', id: p.source.id, source: p.source, tick: p.source.tick });
              }}
            >
              {children}
            </QueueButton>
          );
          if (compact) {
            return get('pickchip pressable', (
              <>
                <span className="pickchip__kind">{KIND_SHORT[p.kind]}</span>
                <span className="pickchip__title" data-raw={v.raw ? 'true' : undefined}>{v.title}</span>
                <FormatBadge {...v.format} />
                <span className="pickchip__peer tnum">
                  {v.peer.username} · {slotWords(v.peer)}
                  {p.kind === 'release' ? ` · ${fileSize(p.release.totalSize)}`
                    : v.peer.advertisedSpeed > 0 && ` · ≈${speed(v.peer.advertisedSpeed)}`}
                </span>
              </>
            ));
          }
          const art = v.cover ? artwork?.get(v.cover.id) : undefined;
          return (
            <article
              key={`${p.kind}:${pickId(p)}`}
              className="pick"
              aria-label={`${KIND[p.kind]}: ${v.artist ? `${v.artist}, ` : ''}${v.title}`}
            >
              <span className="pick__kind">{KIND[p.kind]}</span>
              <div className="pick__head">
                <span className="art pick__art" aria-hidden>
                  <Placeholder seed={v.cover ? `${v.cover.artist ?? ''}${v.cover.title}` : `${v.artist ?? ''}${v.title}`} />
                  {art?.state === 'ready' && <img className="art__img" src={art.dataUri} alt="" loading="lazy" />}
                </span>
                <div className="pick__body">
                  <h3 className="pick__title">
                    {v.artist && <>{v.artist}<span className="pick__dash" aria-hidden> — </span></>}
                    <span data-raw={v.raw ? 'true' : undefined}>{v.title}</span>
                  </h3>
                  <div className="pick__facts">
                    <FormatBadge {...v.format} />
                    {v.facts.map((f) => <span key={f} className="tnum">{f}</span>)}
                  </div>
                </div>
              </div>
              <div className="pick__foot">
                <div className="pick__about">
                  <QualityIndicator assessment={v.assessment} text={v.assessment.short} />
                  <span className="pick__peer tnum">
                    {v.peer.username} · {slotWords(v.peer)}
                    {v.peer.advertisedSpeed > 0 && (
                      <span title="Speed advertised by the peer. A claim, not a measurement.">
                        {' · ≈'}{speed(v.peer.advertisedSpeed)}
                      </span>
                    )}
                  </span>
                </div>
                {get('action action--primary pressable qbtn pick__get')}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
