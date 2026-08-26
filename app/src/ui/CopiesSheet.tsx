/*
 * Seek — every copy of one album, side by side, so the user picks.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This replaces an automatic choice. The app used to rank the copies of a
 * release, download whichever it rated best, and tell you afterwards — and it
 * was measured handing over a 13-track copy from a stranger when a 9-track copy
 * had been clicked. Iva's instruction: "I don't want the app to choose what to
 * download, I need to see the data myself, and decide myself." So the ranking
 * survives as the ORDER of this list and nothing else. Every row here is inert
 * until it is clicked.
 *
 * WHAT IT WILL NOT DO, and this is load-bearing. Where an album is spread over
 * several peers, the useful-sounding thing to build is "take tracks 1-4 from
 * her and 5-13 from him". That needs the same track recognised across different
 * people's rips, and `docs/HANDOFF.md` §3 records it measured three ways on
 * real data: 46, then 146, then 186 picks for a 13-track record, because rips
 * disagree about numbering and filenames. So this sheet shows each copy's files
 * VERBATIM, exactly as that peer sent them, and never lines two copies up
 * against each other or says which files are "the same track". Reading across
 * them is the user's job, with the real strings in front of them; asserting the
 * match is what was wrong three times.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Release } from '../domain/types.ts';
import { completeness } from '../domain/bestSources.ts';
import { count, fileSize, speed } from '../domain/format.ts';
import { worstAssessment } from '../domain/assessment.ts';
import { FormatBadge } from './rows.tsx';
import { QualityIndicator } from './QualityIndicator.tsx';
import { PeerHistory } from './PeerHistory.tsx';
import { Flag } from './Flag.tsx';
import type { PeerLookup } from './PeerHistory.tsx';
import { hitTarget } from './controls.tsx';
import { useReducedMotion } from '../motion/prefs.ts';
import { IconChevronDown, IconClose, IconDownload } from '../icons/index.tsx';

/** One copy: the facts that decide it, then its contents on demand. */
function CopyRow({
  copy, clicked, open, onToggle, onQueue, peers, entering,
}: {
  copy: Release;
  /** The card the user came from. Marked, never treated differently. */
  clicked: boolean;
  /** Just folded in from the pill, so it fades rather than simply appearing. */
  entering?: boolean;
  open: boolean;
  onToggle(): void;
  onQueue(): void;
  peers?: PeerLookup;
}) {
  const assessment = worstAssessment(copy.files);

  return (
    <li
      className="copy"
      data-open={open ? 'true' : undefined}
      data-enter={entering ? '1' : undefined}
    >
      {/* `hitTarget` carries the role, the tab stop and the keyboard; the
          pointer half is explicit, exactly as the release card does it. */}
      <div
        className="copy__hit"
        {...hitTarget(onToggle)}
        onPointerDown={(e) => { if (e.button === 0) onToggle(); }}
        aria-expanded={open}
      >
        <span className="copy__who">
          <span className="copy__user">
            <Flag code={copy.peer.country} />
            {copy.user}
          </span>
          {clicked && <span className="copy__clicked">the copy you clicked</span>}
          <span className="copy__folder" title={copy.folderPath}>{copy.folder}</span>
        </span>

        <span className="copy__facts">
          <span className="copy__tracks">
            <span className="tnum">{copy.trackCount}</span>
            <span> tracks</span>
          </span>
          <FormatBadge label={copy.dominantLabel} tier={copy.dominantTier} />
          <span className="copy__fact tnum">{fileSize(copy.totalSize)}</span>
          <QualityIndicator assessment={assessment} showLabel={false} />
          {copy.peer.freeSlots
            ? <span className="copy__free">slot free</span>
            : (
              <span className="copy__queue">
                <span className="tnum">{copy.peer.queueLength}</span> queued
              </span>
            )}
          <span
            className="copy__fact tnum"
            title="Speed advertised by the peer. A claim, not a measurement."
          >
            ≈ {speed(copy.peer.advertisedSpeed)}
          </span>
          <PeerHistory username={copy.user} peers={peers} />
        </span>

        <span className="copy__chev" aria-hidden>
          <IconChevronDown size={14} painted={1.5} />
        </span>
      </div>

      <span className="copy__actions">
        <button
          type="button"
          className="action action--primary pressable"
          onPointerDown={(e) => { e.stopPropagation(); onQueue(); }}
          aria-label={`Download this copy from ${copy.user}, ${count(copy.trackCount, 'track')}`}
          title={`Download this copy from ${copy.user}`}
        >
          <IconDownload size={15} painted={1.6} />
          <span>Get</span>
        </button>
      </span>

      {open && (
        /* Verbatim, in the peer's own order. No numbering of our own, no
         * alignment against any other copy — see the header. */
        <ol className="copy__files">
          {copy.files.map((f) => (
            <li key={f.id} className="copy__file">
              <span className="copy__filename" title={f.path}>{f.parsed.filename}</span>
              <span className="copy__filesize tnum">{fileSize(f.size)}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function CopiesSheet({
  target, copies, catalogueTracks, peers, onQueue, onClose,
}: {
  /** The release whose card was clicked. */
  target: Release;
  /** Every copy of it in the current results, best first. */
  copies: Release[];
  /** MusicBrainz's track count, when the artwork lookup matched. */
  catalogueTracks?: number | null;
  peers?: PeerLookup;
  onQueue(copy: Release): void;
  onClose(): void;
}) {
  const reduced = useReducedMotion();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  /* Results stream in for about half a minute, and the ranking moves as they
   * do — a copy that was fourth is second once a slow peer answers. Reordering
   * the list somebody is reading, mid-decision, is the same mistake as the
   * result list's rule [5], so the ORDER is frozen at open and new copies wait
   * behind a fold-in exactly like the "new results" pill does.
   *
   * What is NOT frozen is the data. Rows are looked up live by id every render,
   * because a folder's file count grows as its peer's results arrive and a
   * stale "6 tracks" beside a live "13 tracks" would be worse than any
   * reshuffle — the whole point of this screen is that its numbers are true. */
  const live = useMemo(() => new Map(copies.map((c) => [c.id, c])), [copies]);
  const [order, setOrder] = useState<string[]>(() => copies.map((c) => c.id));
  const known = useMemo(() => new Set(order), [order]);

  const shown = useMemo(
    () => order.flatMap((id) => {
      const r = live.get(id);
      // Gone from the results entirely — a filter change behind the sheet.
      return r ? [r] : [];
    }),
    [order, live],
  );
  const arrived = useMemo(() => copies.filter((c) => !known.has(c.id)), [copies, known]);

  /* Which rows the fold-in just brought in, so they can announce themselves.
   * Without this the list silently grows: rows appear mid-page, the copy being
   * read is shoved down, and nothing says which entries are the new ones. The
   * result list solves the same problem the same way — see `rowEnter`. */
  const [entering, setEntering] = useState<Set<string>>(() => new Set());

  const foldIn = useCallback(() => {
    setEntering(new Set(arrived.map((c) => c.id)));
    setOrder(copies.map((c) => c.id));
  }, [copies, arrived]);

  // Drop the marks once the animation has run, or a later re-render would
  // replay it on rows that are no longer new.
  useEffect(() => {
    if (entering.size === 0) return;
    const t = window.setTimeout(() => setEntering(new Set()), 400);
    return () => window.clearTimeout(t);
  }, [entering]);

  const state = useMemo(
    () => completeness(shown, catalogueTracks),
    [shown, catalogueTracks],
  );

  /* Hand focus back to the chip that opens this release's comparison, so
   * closing does not dump a keyboard user on <body>, several hundred results
   * from where they were.
   *
   * Looked up by release id at close time rather than captured on open, and
   * both halves of that matter. The result list is VIRTUALISED: the node that
   * opened the sheet gets recycled to a different record as results stream, so
   * a captured node would eventually return focus to an album the user never
   * touched. And the chip suppresses its own mousedown focus (so the dialog
   * can take it), so there is no `document.activeElement` to capture anyway.
   * A query finds whichever node currently carries this release, or nothing at
   * all if the card has scrolled out — in which case focus is left where it
   * is, which is the honest answer rather than a guess. */
  const restoreFocus = useCallback(() => {
    const sel = `.copies[data-release="${CSS.escape(target.id)}"]`;
    document.querySelector<HTMLElement>(sel)?.focus();
  }, [target.id]);

  const close = useCallback(() => {
    restoreFocus();
    onClose();
  }, [restoreFocus, onClose]);

  const queue = useCallback((copy: Release) => {
    restoreFocus();
    onQueue(copy);
  }, [restoreFocus, onQueue]);

  /* Focus the dialog itself, so a screen reader enters it and Tab starts from
   * inside. Synchronous in a layout effect rather than deferred to a frame:
   * the chip that opens the sheet suppresses its own mousedown focus, so
   * there is nothing left to race, and a deferred focus was measured landing
   * on <body> instead. */
  useLayoutEffect(() => { dialogRef.current?.focus(); }, []);

  /* Keyboard handling lives on `document`, not on the dialog, for the same
   * reason `QualityIndicator` puts its dismiss listener there: it must work
   * wherever focus actually is. A modal whose Escape depends on winning a
   * focus race is a modal that traps you at exactly the wrong moment. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      /* `aria-modal` tells a screen reader this is modal; it does nothing to
       * the Tab order, so without this the next Tab lands on a result card
       * behind the scrim that cannot be seen or clicked. Wrapped rather than
       * blocked, so every row and every Get stays reachable. */
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const stops = [...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((el) => el.getClientRects().length > 0);
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      // Anything outside the sheet, or falling off either end, wraps back in.
      if (active instanceof Node && !root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const title = target.artist ? `${target.artist} — ${target.title}` : target.title;

  return (
    <div
      className="sheet__scrim"
      data-reduced={reduced ? 'true' : undefined}
      onPointerDown={close}
      role="presentation"
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Copies of ${title}`}
        tabIndex={-1}
        ref={dialogRef}
        // The scrim closes on pointerdown; inside it, nothing should.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="sheet__head">
          <div className="sheet__heading">
            <h2 className="sheet__title">{title}</h2>
            <p className="sheet__sub">
              <span className="tnum">{shown.length}</span>
              {shown.length === 1 ? ' copy' : ' copies'} in these results
            </p>
          </div>
          {/* New copies wait here rather than pushing the list around while it
              is being read. Same idiom as the result list's pill. */}
          {arrived.length > 0 && (
            <button type="button" className="pill pressable" onPointerDown={foldIn}>
              <span className="tnum">{arrived.length}</span>
              <span>more {arrived.length === 1 ? 'copy' : 'copies'}</span>
            </button>
          )}
          <button
            type="button"
            className="sheet__close pressable"
            onPointerDown={close}
            aria-label="Close"
            title="Close"
          >
            <IconClose size={15} painted={1.6} />
          </button>
        </header>

        {/* What is known about length, and no more than that. `short` is only
            ever true when MusicBrainz supplied a count to prove it; a spread of
            track counts on its own means the peers disagree, which is a
            different statement and is worded as one. */}
        {state && (state.short || state.disagree) && (
          <p className="sheet__note" data-tone={state.short ? 'warn' : undefined}>
            {state.short ? (
              <>
                No copy here has the whole record. MusicBrainz lists{' '}
                <span className="tnum">{state.catalogue}</span> tracks; the fullest
                copy is <strong>{state.fullest.user}</strong>&apos;s, with{' '}
                <span className="tnum">{state.high}</span>. Getting all of it means
                taking more than one of these and reading across them yourself —
                Seek will not guess which file is which track.
              </>
            ) : (
              <>
                These copies hold between <span className="tnum">{state.low}</span> and{' '}
                <span className="tnum">{state.high}</span> tracks. Nothing here says
                which is the whole record, so open a copy to see what is actually in it.
              </>
            )}
          </p>
        )}

        <ol className="sheet__list">
          {shown.map((copy) => (
            <CopyRow
              key={copy.id}
              copy={copy}
              clicked={copy.id === target.id}
              open={open.has(copy.id)}
              entering={entering.has(copy.id)}
              onToggle={() => toggle(copy.id)}
              onQueue={() => queue(copy)}
              peers={peers}
            />
          ))}
        </ol>

        <footer className="sheet__foot">
          Ordered by completeness, then quality, slots, queue and your own history
          with each peer. Files are listed exactly as each peer sent them; Seek does
          not match tracks between copies, because measured against real rips that
          matching was wrong more often than it was right.
        </footer>
      </div>
    </div>
  );
}
