/*
 * Seek — Downloads · Board: every release as a card in the column of what is
 * happening to it, from a peer's queue to the Rekordbox folder.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * After its canvas board. Simple only: Collector keeps its densities. The
 * columns sort by the same rules as Simple's list and the corner panel
 * (`downloadsKind`), so a release never sits in one column here and another
 * section there. Two columns are new, and both are facts rather than guesses:
 * Checking is a checksum check in progress, Sent is the hand-off's own record.
 *
 * Nothing moves a card on its own. Keep, Reject and Send are the person's.
 */

import type { ReactNode } from 'react';
import type { TransferGroup, TransferSession } from '../data/transferStore.ts';
import { firstFinished } from '../data/transferStore.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import type { ChecksumSession } from '../data/checksumStore.ts';
import type { AutoClaim } from '../../../shared/protocol.ts';
import { summarise } from '../domain/checksums.ts';
import { releaseHandoff } from '../domain/handoff.ts';
import { fileSize, integer, since, spanWords } from '../domain/format.ts';
import { Bar, Cover, ReleaseName } from './transferBits.tsx';
import { FormatBadge } from './rows.tsx';
import { finishedAt, troubleLine, troubleTone } from './CornerPanel.tsx';
import { LayoutHeader, Rescue, downloadsKind, formatOf, queueLine, rateAndTime } from './DownloadsSimple.tsx';
import { HandoffButton } from './HandoffButton.tsx';
import type { HandoffBits } from './HandoffButton.tsx';
import { reportFailure } from '../data/failures.ts';

/** Sent cards shown; the column still counts them all. */
const MAX_SENT = 8;

export interface Columns {
  queued: TransferGroup[];
  downloading: TransferGroup[];
  checking: TransferGroup[];
  ready: TransferGroup[];
  /** Newest send first. All of them: the Board shows the first few. */
  sent: TransferGroup[];
}

const finishedIds = (g: TransferGroup) => g.transfers.filter((t) => t.state === 'finished').map((t) => t.id);

/**
 * Sort releases into the board's columns. `now` is epoch seconds; `held` are
 * transfers waiting for review, which are Ready whatever their age, because
 * they wait for a decision only the person can make.
 *
 * A finished release is Sent once every finished file is in the Rekordbox
 * folder, Checking while its checksum check runs, and otherwise Ready while it
 * is the last hour's: the same window as Downloads' Just finished. Older ones
 * are Completed's.
 */
export function boardColumns(
  groups: readonly TransferGroup[],
  now: number,
  checks: ChecksumSession['byTransfer'],
  handoff: HandoffBits['session'],
  held: ReadonlySet<string>,
): Columns {
  const out: Columns = { queued: [], downloading: [], checking: [], ready: [], sent: [] };
  const sentAt = new Map<TransferGroup, number>();
  for (const g of groups) {
    if (g.state === 'finished') {
      // Review first: a held file waits for Keep or Reject even when the rest
      // of its folder has already gone.
      if (g.transfers.some((t) => held.has(t.id))) {
        out.ready.push(g);
        continue;
      }
      const ids = finishedIds(g);
      const r = releaseHandoff(ids, handoff);
      if (ids.length > 0 && r.sent === r.total) {
        out.sent.push(g);
        sentAt.set(g, r.sentAt!);
      } else if (downloadsKind(g, now) !== 'finished') continue;
      else if (checks.get(firstFinished(g)?.id ?? '')?.state === 'running') out.checking.push(g);
      else out.ready.push(g);
      continue;
    }
    const kind = downloadsKind(g, now);
    if (kind === 'moving') out.downloading.push(g);
    else if (kind === 'waiting' || kind === 'trouble') (g.bytesDone > 0 ? out.downloading : out.queued).push(g);
  }
  out.ready.sort((a, b) => finishedAt(b) - finishedAt(a));
  out.sent.sort((a, b) => sentAt.get(b)! - sentAt.get(a)!);
  return out;
}

export type Column = keyof Columns;

export interface Said {
  line: string;
  /** Why it will not come down, as `groupStatus` tones it. */
  tone?: string;
  /** A finished checksum check's tone, which colours the line. */
  check?: string;
  bar?: 'active' | 'paused' | 'trouble';
}

interface SayContext {
  now: number;
  checks: ChecksumSession['byTransfer'];
  handoff: HandoffBits['session'];
  /** Awaiting-review claims, by transfer id. */
  review: ReadonlyMap<string, AutoClaim>;
}

/** The claim a release is waiting for review under, if any. */
export const claimOf = (g: TransferGroup, review: SayContext['review']) =>
  g.transfers.map((t) => review.get(t.id)).find((c) => c !== undefined);

/** What one line says about a release in a column. The Board's cards and the
 * Folders tree say the same thing, so neither can drift from the other. */
export function say(g: TransferGroup, column: Column, ctx: SayContext): Said {
  const trouble = downloadsKind(g, ctx.now) === 'trouble';
  const tone = troubleTone(g);
  switch (column) {
    case 'queued':
      return trouble ? { line: troubleLine(g), tone } : { line: queueLine(g) };
    case 'downloading':
      if (trouble) return { line: troubleLine(g), tone, bar: 'trouble' };
      if (g.state === 'paused') return { line: queueLine(g), bar: 'paused' };
      return { line: `${fileSize(g.bytesDone)} of ${fileSize(g.size)} · ${rateAndTime(g)}`, bar: 'active' };
    case 'checking': {
      // Every sidecar in the folder is checked, so a release with both says both.
      const kinds = ['.ffp', '.md5'].filter((ext) => g.transfers.some((t) => t.path.toLowerCase().endsWith(ext)));
      return { line: `Checking each track against the ${kinds.join(' and ') || 'checksum file'}` };
    }
    case 'ready': {
      if (claimOf(g, ctx.review)) return { line: 'Waiting for your review' };
      const check = ctx.checks.get(firstFinished(g)?.id ?? '');
      const s = check?.state === 'done' ? summarise(check.report!) : null;
      return s && !s.none
        ? { line: s.headline, check: s.tone }
        : { line: `Finished ${spanWords(ctx.now - finishedAt(g))} ago` };
    }
    case 'sent':
      return { line: `In the Rekordbox folder · sent ${since(releaseHandoff(finishedIds(g), ctx.handoff).sentAt ?? ctx.now)}` };
  }
}

function Card({ g, artwork, said: { line, tone, check, bar }, chip, children }: {
  g: TransferGroup;
  artwork?: ArtworkSession;
  said: Said;
  chip?: string;
  children?: ReactNode;
}) {
  const format = formatOf(g);
  return (
    <li className="board__card" data-tone={tone}>
      <div className="board__head">
        <Cover g={g} artwork={artwork} size="row" />
        <div className="board__name">
          <span className="board__title"><ReleaseName g={g} /></span>
          <span className="board__chips">
            {format && <FormatBadge label={format.label} tier={format.tier} title={format.description} />}
            {chip && <span className="board__chip">{chip}</span>}
          </span>
        </div>
      </div>
      {bar && <Bar done={g.bytesDone} total={g.size} state={bar} />}
      <span className="board__line tnum" data-check={check}>{line}</span>
      {children && <div className="board__actions">{children}</div>}
    </li>
  );
}

function Column({ id, title, note, count, children }: {
  id: string; title: string; note: string; count: number; children: ReactNode;
}) {
  return (
    <section className="board__col" aria-labelledby={`board-${id}`}>
      <header className="board__colhead">
        <h2 id={`board-${id}`} className="board__h">
          {title} <span className="board__n tnum">{integer(count)}</span>
        </h2>
        <span className="board__note">{note}</span>
      </header>
      {count > 0 ? <ul className="board__cards">{children}</ul> : <p className="board__empty">Nothing here</p>}
    </section>
  );
}

export function DownloadsBoard({
  session, artwork, checksums, handoff, review, now, tools, notices,
  onFindAnother, onApproveAuto, onRejectAuto,
}: {
  session: TransferSession;
  artwork?: ArtworkSession;
  checksums: ChecksumSession;
  handoff: HandoffBits;
  /** Claims awaiting review, by transfer id: Ready's. */
  review: ReadonlyMap<string, AutoClaim>;
  /** Epoch seconds, from DownloadsView's coarse clock. */
  now: number;
  /** The header's buttons, from DownloadsView: the layout switch, Mini Seek. */
  tools: ReactNode;
  notices: ReactNode;
  onFindAnother?(query: string): void;
  onApproveAuto?(query: string): void;
  onRejectAuto?(query: string): void;
}) {
  const cols = boardColumns(session.groups, now, checksums.byTransfer, handoff.session, handoff.held);
  const ctx = { now, checks: checksums.byTransfer, handoff: handoff.session, review };

  const rescue = (g: TransferGroup) => downloadsKind(g, now) === 'trouble'
    && <Rescue g={g} session={session} onFindAnother={onFindAnother} />;
  const card = (g: TransferGroup, column: Column, children?: ReactNode, chip?: string) => (
    <Card key={g.key} g={g} artwork={artwork} said={say(g, column, ctx)} chip={chip}>{children}</Card>
  );

  return (
    <>
      <LayoutHeader groups={session.groups} now={now} handoff={handoff} tools={tools} />
      <div className="pane__scroll">
        {notices}
        <div className="board">
          <Column id="queued" title="Queued by peer" note="Waiting for a slot on their side" count={cols.queued.length}>
            {cols.queued.map((g) => card(g, 'queued', rescue(g)))}
          </Column>

          <Column id="downloading" title="Downloading" note="Measured speed, updated every 0.4 s" count={cols.downloading.length}>
            {cols.downloading.map((g) => card(g, 'downloading', rescue(g)))}
          </Column>

          <Column id="checking" title="Checking" note="Compared with the .ffp or .md5 it came with" count={cols.checking.length}>
            {cols.checking.map((g) => card(g, 'checking'))}
          </Column>

          <Column id="ready" title="Ready" note="Finished and waiting for you" count={cols.ready.length}>
            {cols.ready.map((g) => {
              const claim = claimOf(g, review);
              return claim ? card(g, 'ready', (
                <>
                  {onApproveAuto && <button type="button" className="btn pressable" onClick={() => onApproveAuto(claim.query)}>Keep</button>}
                  {onRejectAuto && <button type="button" className="btn pressable" onClick={() => onRejectAuto(claim.query)}>Reject</button>}
                </>
              ), 'From your wishlist') : card(g, 'ready', <HandoffButton g={g} handoff={handoff} />);
            })}
          </Column>

          <Column id="sent" title="Sent to Rekordbox" note="Copied into your Rekordbox folder" count={cols.sent.length}>
            {cols.sent.slice(0, MAX_SENT).map((g) => {
              const dest = releaseHandoff(finishedIds(g), handoff.session).dest;
              return card(g, 'sent', dest && (
                <button
                  type="button" className="btn pressable" title={dest}
                  onClick={() => void handoff.session.reveal(dest).catch((e) => reportFailure('Show the copy in Finder', e))}
                >
                  Show in Finder
                </button>
              ));
            })}
            {cols.sent.length > MAX_SENT && (
              <li className="board__more tnum">and {integer(cols.sent.length - MAX_SENT)} more, in Completed</li>
            )}
          </Column>
        </div>
      </div>
    </>
  );
}
