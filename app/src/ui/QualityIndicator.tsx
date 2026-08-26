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

import { useEffect, useId, useRef, useState } from 'react';
import type { Assessment, QualityGlyph } from '../domain/assessment.ts';

const GRID = 24;

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
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
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

      {open && (
        <span className="quality__pop" id={id} role="dialog" aria-label={assessment.label}>
          <span className="quality__pop-head">
            <Mark glyph={assessment.glyph} size={15} />
            <span className="quality__pop-title">{assessment.label}</span>
          </span>
          <span className="quality__pop-summary">{assessment.summary}</span>
          {assessment.detail.filter(Boolean).map((p, i) => (
            <span className="quality__pop-para" key={i}>{p}</span>
          ))}
        </span>
      )}
    </span>
  );
}

export { Mark as QualityMark };
