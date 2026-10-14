/*
 * Seek — Downloads · Simple: what is arriving, what is waiting, what needs you.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The Downloads screen in Simple, after its canvas board. One release leads,
 * as a card: how far, how fast, how long, and the last five minutes of speed,
 * because "is it slowing down" is the question a bare rate cannot answer. The
 * rest follow, sorted by what each needs from you, by the corner panel's own
 * `kindOf`, so the panel and this screen never disagree about which is which.
 *
 * Simple keeps Failed behind More, so a download that stalled or was refused
 * shows HERE, under Needs attention, rather than on a screen its sidebar does
 * not show. Its button opens a search for another copy, and the person picks
 * one: nothing is chosen for them (docs/PRODUCT.md §7).
 *
 * The lead card does not change hands while its release is still downloading.
 * Rates swap places every second, and a card that followed the fastest would
 * be the jitter the brief forbids. For the same reason time left is said in
 * minutes, never as a countdown.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TransferGroup, TransferSession } from '../data/transferStore.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import type { AutoClaim } from '../../../shared/protocol.ts';
import { isAudioPath } from '../data/adapt.ts';
import { classify } from '../domain/quality.ts';
import type { Quality } from '../domain/types.ts';
import { groupStatus } from '../domain/transferStatus.ts';
import { count, fileSize, integer, ordinal, spanWords, speed } from '../domain/format.ts';
import { IconDownload } from '../icons/index.tsx';
import { Bar, Cover, ReleaseName, groupEta, releaseOf } from './transferBits.tsx';
import { FormatBadge } from './rows.tsx';
import { finishedAt, kindOf, queuePlace, startsWhen, troubleLine } from './CornerPanel.tsx';
import type { Kind } from './CornerPanel.tsx';

/** How long a finished release counts as just finished. Then it is Completed's. */
const JUST_FINISHED_S = 3600;
/** Finished releases listed here; the rest are a click away in Completed. */
const MAX_FINISHED = 3;

export interface Sections {
  /** The release on the card. */
  lead: TransferGroup | null;
  /** Every other release coming down. */
  moving: TransferGroup[];
  /** In a peer's queue, asked and not yet answered, or paused. */
  waiting: TransferGroup[];
  trouble: TransferGroup[];
  /** Newest first. */
  finished: TransferGroup[];
}

/**
 * What a release on Downloads is doing, in either mode: the corner panel's
 * answer, except that a paused release waits here (the panel leaves out what
 * you paused) and only the last hour's finishes are news. Null for a cancel,
 * and for anything older. `now` is epoch seconds.
 */
export function downloadsKind(g: TransferGroup, now: number): Kind | null {
  return g.state === 'paused' ? 'waiting' : kindOf(g, now - JUST_FINISHED_S);
}

/**
 * Sort the releases into the screen's sections. `now` is epoch seconds;
 * `lead` is the key of the release on the card last time, which keeps it
 * there for as long as it is still coming down.
 */
export function sections(groups: TransferGroup[], now: number, lead: string | null): Sections {
  const out: Sections = { lead: null, moving: [], waiting: [], trouble: [], finished: [] };
  for (const g of groups) {
    const kind = downloadsKind(g, now);
    if (kind) out[kind].push(g);
  }
  out.lead = out.moving.find((g) => g.key === lead) ?? out.moving[0] ?? null;
  out.moving = out.moving.filter((g) => g !== out.lead);
  out.finished.sort((a, b) => finishedAt(b) - finishedAt(a));
  return out;
}

/** The format most of a release's audio files are in. Null with no audio. */
export function formatOf(g: TransferGroup): Quality | null {
  const tally = new Map<string, number>();
  for (const t of g.transfers) {
    if (!isAudioPath(t.path)) continue;
    const ext = t.path.slice(t.path.lastIndexOf('.') + 1).toLowerCase();
    tally.set(ext, (tally.get(ext) ?? 0) + 1);
  }
  const [top] = [...tally].sort((a, b) => b[1] - a[1]);
  // Transfers carry no bitrate, so an MP3 says MP3: nothing is guessed from size.
  return top ? classify({ extension: top[0], size: 0, bitrate: null, duration: null, sampleRate: null, bitDepth: null, vbr: null }) : null;
}

function rateAndTime(g: TransferGroup): string {
  if (g.speed <= 0) return 'Starting';
  const eta = groupEta(g);
  if (!eta) return speed(g.speed);
  return `${speed(g.speed)} · ${eta < 90 ? 'less than a minute' : `about ${spanWords(eta)}`} left`;
}

function waitingLine(g: TransferGroup): string {
  if (g.state === 'paused') {
    return g.bytesDone > 0 ? `Paused · ${fileSize(g.bytesDone)} of ${fileSize(g.size)}` : 'Paused';
  }
  const place = queuePlace(g);
  if (place === null) return `Asked ${g.username} · waiting for an answer`;
  return `${ordinal(place)} in ${g.username}'s queue. ${startsWhen(place)}.`;
}

/** What to search for when a release will not come down. */
export function another(g: TransferGroup): string {
  const { artist, release } = releaseOf(g);
  return [artist, release].filter(Boolean).join(' ') || g.title;
}

/* ------------------------------------------------------------ speed chart */

/** One sample every five seconds, five minutes of them. */
const SAMPLE_MS = 5000;
const SAMPLES = 60;

/* ponytail: the history lives here, so it starts when the screen opens. Move
   the sampling into transferStore if a longer memory is ever wanted. */
function useSpeedHistory(groups: TransferGroup[]): ReadonlyMap<string, number[]> {
  const latest = useRef(groups);
  latest.current = groups;
  const [history, setHistory] = useState<ReadonlyMap<string, number[]>>(() => new Map());
  useEffect(() => {
    const timer = window.setInterval(() => setHistory((prev) => {
      const next = new Map<string, number[]>();
      for (const g of latest.current) {
        if (g.state === 'active') next.set(g.key, [...(prev.get(g.key) ?? []), g.speed].slice(-SAMPLES));
      }
      return next;
    }), SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return history;
}

const W = 600;
const H = 64;

/** Five minutes of speed, now at the right edge, scaled to its own peak. */
function SpeedChart({ samples }: { samples: number[] }) {
  const peak = Math.max(0, ...samples);
  const step = W / (SAMPLES - 1);
  const points = samples.map((v, i) => {
    const x = W - (samples.length - 1 - i) * step;
    const y = H - 2 - (peak > 0 ? (v / peak) * (H - 8) : 0);
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const line = points.length > 1 ? `M${points.join(' L')}` : null;
  const left = (W - (samples.length - 1) * step).toFixed(1);
  return (
    <figure className="speed">
      <svg
        className="speed__chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={peak > 0
          ? `Download speed over the last five minutes, at most ${speed(peak)}`
          : 'Download speed over the last five minutes, still measuring'}
      >
        <path className="speed__grid" d={`M0 16H${W}M0 32H${W}M0 48H${W}`} vectorEffect="non-scaling-stroke" />
        {line && <path className="speed__area" d={`${line} L${W} ${H} L${left} ${H} Z`} />}
        {line && <path className="speed__line" d={line} vectorEffect="non-scaling-stroke" />}
      </svg>
      <figcaption className="speed__axis tnum">
        <span>5 min ago</span>
        <span>{peak > 0 && `Peak ${speed(peak)}`}</span>
        <span>Now</span>
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------- the pieces */

function Lead({ g, artwork, samples, open, onToggle, session, children }: {
  g: TransferGroup;
  artwork?: ArtworkSession;
  samples: number[];
  open: boolean;
  onToggle(): void;
  session: TransferSession;
  children: ReactNode;
}) {
  const ids = g.transfers.map((t) => t.id);
  const audio = g.transfers.filter((t) => isAudioPath(t.path));
  const done = audio.filter((t) => t.state === 'finished').length;
  // Down, not to the nearest: 99.6% of a release is not 100% of one.
  const pct = g.size > 0 ? Math.floor((g.bytesDone / g.size) * 100) : 0;
  const what = audio.length > 0
    ? `${formatOf(g)?.label} · ${count(audio.length, 'track')}`
    : count(g.transfers.length, 'file');
  return (
    <section className="dlsimple__lead" aria-labelledby="dl-lead">
      <Cover g={g} artwork={artwork} size="lead" />
      <div className="dlsimple__lead-body">
        <div className="dlsimple__lead-top">
          <div className="dlsimple__name">
            <span id="dl-lead" className="dlsimple__eyebrow">Now downloading</span>
            <span className="dlsimple__title"><ReleaseName g={g} /></span>
            <span className="dlsimple__facts">{what} · from {g.username}</span>
          </div>
          <span className="dlsimple__pct tnum">{pct}%</span>
        </div>
        <Bar done={g.bytesDone} total={g.size} state="active" />
        <div className="dlsimple__stats tnum">
          <span>
            {fileSize(g.bytesDone)} of {fileSize(g.size)}
            {audio.length > 0 && ` · ${done} of ${count(audio.length, 'track')} done`}
          </span>
          <span>{rateAndTime(g)}</span>
        </div>
        <SpeedChart samples={samples} />
        <div className="dlsimple__actions">
          <button type="button" className="btn pressable" onClick={() => session.pause(ids)}>Pause</button>
          <button type="button" className="btn pressable" aria-expanded={open} onClick={onToggle}>
            {open ? 'Hide tracks' : 'Show tracks'}
          </button>
          <button type="button" className="btn pressable" onClick={() => session.cancel(ids)}>Cancel</button>
        </div>
      </div>
      {open && <div className="dlsimple__open">{children}</div>}
    </section>
  );
}

/** One release, one line about it. Opens to its files and what you can do. */
function Row({ g, artwork, open, onToggle, line, tone, bar, trailing, children }: {
  g: TransferGroup;
  artwork?: ArtworkSession;
  open: boolean;
  onToggle(): void;
  line: string;
  tone?: string;
  bar?: 'active' | 'paused' | 'trouble' | 'finished';
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const format = formatOf(g);
  return (
    <li className="dlrow" data-tone={tone}>
      <button type="button" className="dlrow__hit" aria-expanded={open} onClick={onToggle}>
        <Cover g={g} artwork={artwork} size="row" />
        <span className="dlrow__main">
          <span className="dlrow__title">
            <span className="dlrow__name"><ReleaseName g={g} /></span>
            {format && <FormatBadge label={format.label} tier={format.tier} title={format.description} />}
          </span>
          {bar && <Bar done={bar === 'finished' ? 1 : g.bytesDone} total={bar === 'finished' ? 1 : g.size} state={bar} />}
          <span className="dlrow__line tnum">{line}</span>
        </span>
      </button>
      {trailing && <span className="dlrow__trail">{trailing}</span>}
      {open && <div className="dlrow__open">{children}</div>}
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dlsimple__section" aria-label={title}>
      <h2 className="dlsimple__h">{title}</h2>
      <ul className="dlsimple__rows">{children}</ul>
    </section>
  );
}

/* ------------------------------------------------------------- the screen */

export function SimpleDownloads({
  session, artwork, awaiting, signedIn, openKeys, onOpen, renderOpen, notices,
  onFindAnother, onShowCompleted,
}: {
  session: TransferSession;
  artwork?: ArtworkSession;
  /** Wishlist downloads held for review. */
  awaiting: AutoClaim[];
  signedIn: boolean;
  openKeys: ReadonlySet<string>;
  onOpen(key: string, next: boolean): void;
  /** A release's files, with its actions when `actions` (DownloadsView's). */
  renderOpen(g: TransferGroup, actions: boolean): ReactNode;
  /** Undo, notes and errors, from DownloadsView. */
  notices: ReactNode;
  onFindAnother?(query: string): void;
  onShowCompleted?(): void;
}) {
  // A coarse clock: "finished 3 minutes ago" moves when nothing else does.
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const lastLead = useRef<string | null>(null);
  const s = sections(session.groups, now, lastLead.current);
  useEffect(() => { lastLead.current = s.lead?.key ?? null; });
  const history = useSpeedHistory(session.groups);

  const toggle = (g: TransferGroup) => () => onOpen(g.key, !openKeys.has(g.key));
  const row = (g: TransferGroup, line: string, more: Partial<Parameters<typeof Row>[0]> = {}) => (
    <Row key={g.key} g={g} artwork={artwork} open={openKeys.has(g.key)} onToggle={toggle(g)} line={line} {...more}>
      {renderOpen(g, true)}
    </Row>
  );

  const inProgress = (s.lead ? 1 : 0) + s.moving.length + s.waiting.length;
  const total = [s.lead, ...s.moving].reduce((n, g) => n + (g?.speed ?? 0), 0);
  const empty = inProgress + s.trouble.length + s.finished.length + awaiting.length === 0;

  return (
    <>
      <header data-tauri-drag-region="deep" className="header header--plain dls__header">
        <div className="dls__heading">
          <h1 className="pane__title">Downloads</h1>
          {inProgress > 0 && (
            <p className="pane__subtitle tnum">
              {integer(inProgress)} in progress{total > 0 && ` · ${speed(total)} in total`}
            </p>
          )}
        </div>
      </header>
      <div className="pane__scroll">
        <div className="dlsimple">
          {notices}
          {empty && (
            <div className="empty empty--section">
              <span className="empty__icon"><IconDownload size={28} painted={1.3} /></span>
              <p className="empty__title">Nothing downloading</p>
              <p className="empty__body">
                {signedIn
                  ? 'Queue a track or a release from Search and it appears here.'
                  : 'Sign in from Settings to download anything.'}
              </p>
            </div>
          )}

          {s.lead && (
            <Lead
              g={s.lead} artwork={artwork} samples={history.get(s.lead.key) ?? []}
              open={openKeys.has(s.lead.key)} onToggle={toggle(s.lead)} session={session}
            >
              {renderOpen(s.lead, false)}
            </Lead>
          )}

          {s.moving.length > 0 && (
            <Section title="Also downloading">
              {s.moving.map((g) => row(g, `${fileSize(g.bytesDone)} of ${fileSize(g.size)} · ${rateAndTime(g)}`, { bar: 'active' }))}
            </Section>
          )}

          {s.waiting.length > 0 && (
            <Section title="Waiting">
              {s.waiting.map((g) => row(g, waitingLine(g), {
                bar: g.state === 'paused' && g.bytesDone > 0 ? 'paused' : undefined,
              }))}
            </Section>
          )}

          {s.trouble.length > 0 && (
            <Section title="Needs attention">
              {s.trouble.map((g) => row(g, troubleLine(g), {
                tone: g.state === 'stalled' ? 'broken' : groupStatus(g.transfers)?.tone,
                bar: g.bytesDone > 0 ? 'trouble' : undefined,
                trailing: onFindAnother && (
                  <button type="button" className="btn pressable" onClick={() => onFindAnother(another(g))}>
                    Find another copy
                  </button>
                ),
              }))}
            </Section>
          )}

          {s.finished.length > 0 && (
            <Section title="Just finished">
              {s.finished.slice(0, MAX_FINISHED).map((g) => row(g,
                `Finished ${spanWords(now - finishedAt(g))} ago. Now in Completed.`, {
                  bar: 'finished',
                  trailing: (
                    <button
                      type="button" className="btn pressable"
                      onClick={() => session.reveal(g.transfers.find((t) => t.state === 'finished')?.id ?? g.transfers[0].id)}
                    >
                      Show in Finder
                    </button>
                  ),
                }))}
              {s.finished.length > MAX_FINISHED && onShowCompleted && (
                <li className="dlsimple__more">
                  <button type="button" className="corner__link" onClick={onShowCompleted}>
                    Show all {integer(s.finished.length)} in Completed
                  </button>
                </li>
              )}
            </Section>
          )}

          {awaiting.length > 0 && (
            <section className="dlsimple__review" aria-labelledby="dl-review">
              <div className="dlsimple__review-text">
                <h2 id="dl-review">
                  {awaiting.length === 1
                    ? 'A wishlist download is waiting for your review'
                    : `${integer(awaiting.length)} wishlist downloads are waiting for your review`}
                </h2>
                <p>
                  “{awaiting[0].query}”{awaiting.length > 1 && ` and ${integer(awaiting.length - 1)} more`} arrived.
                  Keep or reject {awaiting.length === 1 ? 'it' : 'them'} in Completed.
                </p>
              </div>
              {onShowCompleted && (
                <button type="button" className="btn btn--primary pressable" onClick={onShowCompleted}>Review</button>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
