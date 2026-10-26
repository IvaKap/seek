/*
 * Seek — Mini Seek: the window made small, to watch downloads while you work
 * in something else, after its canvas board.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * What is coming down, what is waiting and what needs you, sorted and worded
 * the way Downloads · Simple sorts and words them (downloadsKind), so the two
 * never disagree. A release that finishes leaves the list: Completed and the
 * notification say so, and wishlist downloads held for review get the strip
 * at the bottom.
 *
 * The field does not search here. A window this size has no room for results,
 * so a search opens the full window and runs there, which is also what ⌘↵
 * means everywhere else in Seek.
 */

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { TransferGroup, TransferSession } from '../data/transferStore.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import type { AutoClaim } from '../../../shared/protocol.ts';
import { integer } from '../domain/format.ts';
import { IconMaximize, IconMinimize, IconSearch } from '../icons/index.tsx';
import { Bar, Cover, ReleaseName } from './transferBits.tsx';
import { Rescue, Section, downloadsKind, queueLine, rateAndTime } from './DownloadsSimple.tsx';
import { troubleLine, troubleTone } from './CornerPanel.tsx';
import type { Kind } from './CornerPanel.tsx';

/** The way into Mini Seek, in the Downloads header. ⇧⌘M and the palette are the others. */
export function MiniSeekButton({ onClick }: { onClick(): void }) {
  return (
    <button
      type="button" className="btn pressable" onClick={onClick}
      title="Shrink Seek to a small window that can stay on top (⇧⌘M)"
    >
      <IconMinimize size={13} painted={1.5} />
      Mini Seek
    </button>
  );
}

function Row({ g, artwork, line, tone, bar, children }: {
  g: TransferGroup;
  artwork?: ArtworkSession;
  line: string;
  tone?: string;
  bar?: 'active' | 'paused';
  children?: ReactNode;
}) {
  return (
    <li className="mini__row" data-tone={tone}>
      <Cover g={g} artwork={artwork} size="row" />
      <span className="mini__main">
        <span className="mini__name"><ReleaseName g={g} /></span>
        {bar && <Bar done={g.bytesDone} total={g.size} state={bar} />}
        <span className="mini__line tnum">{line}</span>
        {children}
      </span>
    </li>
  );
}

export function MiniSeek({
  session, artwork, awaiting, onTop, onKeepOnTop, onSearch, onFindAnother, onReview, onOpen, onBack,
}: {
  session: TransferSession;
  artwork?: ArtworkSession;
  /** Wishlist downloads held for review. */
  awaiting: AutoClaim[];
  onTop: boolean;
  onKeepOnTop(on: boolean): void;
  /** Runs a search in the full window. */
  onSearch(query: string): void;
  onFindAnother(query: string): void;
  onReview(): void;
  /** The full window, on Downloads. */
  onOpen(): void;
  /** The full window, on the screen you left it on. */
  onBack(): void;
}) {
  const [query, setQuery] = useState('');
  const reviewId = useId();
  const submit = () => {
    const q = query.trim();
    if (q) onSearch(q);
  };

  // The time only decides which finishes are news, and Mini Seek lists none.
  const of = (kind: Kind) => session.groups.filter((g) => downloadsKind(g, 0) === kind);
  const moving = of('moving');
  const waiting = of('waiting');
  const trouble = of('trouble');
  const held = awaiting.length > 0
    ? session.groups.find((g) => g.transfers.some((t) => t.id === awaiting[0].transferId))
    : undefined;

  return (
    <section className="mini" aria-label="Mini Seek">
      <header className="mini__bar" data-tauri-drag-region="deep">
        <h1 className="mini__title">Seek</h1>
        <button
          type="button" className="mini__back" aria-label="Back to the full window"
          title="Back to the full window (⇧⌘M)" onClick={onBack}
        >
          <IconMaximize size={14} painted={1.5} />
        </button>
      </header>

      <form className="mini__search" role="search" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <IconSearch size={14} painted={1.5} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // ⌘↵ as everywhere in Seek; a plain ↵ submits the form by itself.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          }}
          aria-label="Search the Soulseek network"
          placeholder="Search"
          autoComplete="off"
          spellCheck={false}
        />
        <kbd className="mini__key" title="Searches in the full window">⌘↵</kbd>
      </form>

      <div className="mini__list">
        {moving.length + waiting.length + trouble.length === 0 && (
          <p className="mini__empty">Nothing downloading</p>
        )}
        {moving.length > 0 && (
          <Section title="Downloading" block="mini">
            {moving.map((g) => <Row key={g.key} g={g} artwork={artwork} line={rateAndTime(g)} bar="active" />)}
          </Section>
        )}
        {waiting.length > 0 && (
          <Section title="Waiting" block="mini">
            {waiting.map((g) => (
              <Row
                key={g.key} g={g} artwork={artwork} line={queueLine(g)}
                bar={g.state === 'paused' && g.bytesDone > 0 ? 'paused' : undefined}
              />
            ))}
          </Section>
        )}
        {trouble.length > 0 && (
          <Section title="Needs attention" block="mini">
            {trouble.map((g) => (
              <Row key={g.key} g={g} artwork={artwork} line={troubleLine(g)} tone={troubleTone(g)}>
                <Rescue g={g} session={session} onFindAnother={onFindAnother} className="btn pressable mini__act" />
              </Row>
            ))}
          </Section>
        )}
      </div>

      {awaiting.length > 0 && (
        <section className="mini__review" aria-labelledby={reviewId}>
          {held && <Cover g={held} artwork={artwork} size="row" />}
          <span id={reviewId} className="mini__review-text tnum">
            {integer(awaiting.length)} waiting for your review
          </span>
          <button type="button" className="btn btn--primary pressable" onClick={onReview}>Review</button>
        </section>
      )}

      <footer className="mini__foot">
        <label className="mini__ontop">
          <input type="checkbox" checked={onTop} onChange={(e) => onKeepOnTop(e.target.checked)} />
          Keep on top
        </label>
        <button type="button" className="corner__link" onClick={onOpen}>Open Seek</button>
      </footer>
    </section>
  );
}
