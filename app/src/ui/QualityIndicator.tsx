/*
 * Seek — the five-state quality indicator.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * These five marks are drawn here rather than pulled from Lucide, and that is
 * not a violation of the one-icon-set rule: they are status marks, not icons —
 * the same category as the dot in a macOS sidebar or a Finder tag. Lucide has no
 * set of five shapes that stay unambiguous at 13px, and mixing in a second icon
 * library to find them would be the actual violation. They follow the same
 * geometry conventions as the icon set (round caps and joins, stroke derived
 * from render size) so they sit correctly beside it.
 *
 * SHAPE carries the meaning; colour is a second, redundant signal:
 *
 *   ●  disc      Excellent          filled, solid
 *   ◍  ring      Good               ring with a filled centre
 *   ○  dashed    Unverified         dashed ring — visibly "incomplete"
 *   △  triangle  Suspicious         hollow triangle
 *   ⊗  cross     Likely transcode   cross inside a circle
 *
 * Clicking opens the arithmetic. Hover shows it too, but click is what makes it
 * reachable by keyboard and on a trackpad without hover intent.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Assessment, QualityGlyph } from '../domain/assessment.ts';

const GRID = 24;
/** Gap between trigger and card, and the minimum margin from a window edge. */
const GAP = 8;
const EDGE = 8;

function Mark({ glyph, size = 13, painted = 1.6 }: { glyph: QualityGlyph; size?: number; painted?: number }) {
  const sw = (painted * GRID) / size;
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: sw,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    style: { display: 'block', flex: 'none' as const },
  };

  switch (glyph) {
    case 'disc':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'ring':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.5" />
          <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'dashed':
      return (
        <svg {...common}>
          {/* Deliberately broken: an incomplete outline reads as "we don't know"
              rather than as a quiet pass. */}
          <circle cx="12" cy="12" r="7.5" strokeDasharray="3.1 2.9" />
        </svg>
      );
    case 'triangle':
      return (
        <svg {...common}>
          <path d="M12 4.5 L20.5 19.5 L3.5 19.5 Z" />
          <path d="M12 10v3.6" />
          <path d="M12 16.6h.01" />
        </svg>
      );
    case 'cross':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </svg>
      );
  }
}

export function QualityIndicator({
  assessment, size = 13, showLabel = false,
}: {
  assessment: Assessment;
  size?: number;
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  /* The card is portalled to <body> and placed with `position: fixed`, measured
   * against the trigger. It used to be absolutely positioned inside the row and
   * always opened rightward, so once the Check column sat near the right edge
   * the card ran off the window and was clipped. Inside the row it also lived
   * under a transformed ancestor (the virtualised `.row-slot`), where `fixed`
   * would anchor to the row rather than the window — hence the portal.
   *
   * It flips left or up when there is no room, then clamps to the window, the
   * same rules as ContextMenu.
   *
   * It re-places itself EVERY FRAME while open, not on scroll: result rows move
   * by `transform` — the virtualiser, and the re-rank springs during a live
   * search — which fires no scroll event, so a card placed once is left
   * pointing at empty space while its row slides away. One rect read a frame,
   * for the one card that can be open, written straight to the element so it
   * never re-renders. */
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    let last = '';
    const place = (): boolean => {
      const trigger = wrapRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!trigger || !pop) return true;
      // The row left the window: nothing left to point at.
      if (trigger.bottom < 0 || trigger.top > window.innerHeight) {
        setOpen(false);
        return false;
      }
      const { width, height } = pop.getBoundingClientRect();
      const flipX = trigger.left - GAP + width + EDGE > window.innerWidth;
      const flipY = trigger.bottom + GAP + height + EDGE > window.innerHeight;
      const x = flipX ? trigger.right + GAP - width : trigger.left - GAP;
      const y = flipY ? trigger.top - GAP - height : trigger.bottom + GAP;
      const left = Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE));
      const top = Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE));
      const origin = `${flipX ? 'right' : 'left'} ${flipY ? 'bottom' : 'top'}`;
      const key = `${left}|${top}|${origin}`;
      if (key !== last) {
        last = key;
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        pop.style.transformOrigin = origin;
      }
      return true;
    };
    const tick = () => {
      if (place()) frame = requestAnimationFrame(tick);
    };
    // Once synchronously, so the first paint is already in the right place.
    if (place()) frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // The card is no longer inside the wrapper, so a click on it must be
      // recognised separately or reading the arithmetic would dismiss it.
      if (!wrapRef.current?.contains(target) && !popRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="quality" ref={wrapRef} data-state={assessment.state}>
      <button
        type="button"
        className="quality__trigger"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        aria-label={`Quality: ${assessment.label}. ${assessment.summary}. Show the reasoning.`}
        onPointerDown={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <Mark glyph={assessment.glyph} size={size} />
        {showLabel && <span className="quality__label">{assessment.label}</span>}
      </button>

      {open && createPortal(
        <span
          ref={popRef}
          className="quality__pop"
          id={id}
          role="dialog"
          aria-label={assessment.label}
          // React bubbles portal events through the COMPONENT tree, so without
          // this a click on the card would still reach the row underneath and
          // select or expand it.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="quality__pop-head">
            <Mark glyph={assessment.glyph} size={15} />
            <span className="quality__pop-title">{assessment.label}</span>
          </span>
          <span className="quality__pop-summary">{assessment.summary}</span>
          {assessment.detail.filter(Boolean).map((p, i) => (
            <span className="quality__pop-para" key={i}>{p}</span>
          ))}
        </span>,
        document.body,
      )}
    </span>
  );
}

export { Mark as QualityMark };
