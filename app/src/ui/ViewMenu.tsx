/*
 * Seek — the density view menu.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * docs/PRODUCT.md §4: grouping and density are orthogonal and must not compete
 * for the same space. Grouping is the primary segmented control; density lives
 * in a toolbar view menu, the way Finder does it. Two segmented controls side by
 * side in one header is exactly the density this redesign exists to remove.
 *
 * The popover scales from its trigger, not from its centre — anchoring a
 * popover to the thing that opened it is what makes the relationship legible.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { IconCheck, IconFilters } from '../icons/index.tsx';

export type Density = 'comfortable' | 'compact' | 'table';

const OPTIONS: Array<{ value: Density; label: string; hint: string }> = [
  { value: 'comfortable', label: 'Comfortable', hint: 'Full release cards' },
  { value: 'compact', label: 'Compact', hint: 'Denser, no recommendation line' },
  { value: 'table', label: 'Table', hint: 'Every column, power-user view' },
];

export function ViewMenu({
  density, onDensity,
}: {
  density: Density;
  onDensity(d: Density): void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
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
    <div className="viewmenu" ref={wrapRef}>
      <button
        type="button"
        className="viewmenu__trigger pressable"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label="View options"
        onPointerDown={() => setOpen((v) => !v)}
      >
        <IconFilters size={15} painted={1.6} />
        <span className="viewmenu__label">View</span>
      </button>

      {open && (
        <div className="viewmenu__pop" id={id} role="menu" aria-label="Density">
          <div className="viewmenu__section">Density</div>
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={density === o.value}
              className="viewmenu__item"
              onPointerDown={() => {
                onDensity(o.value);
                setOpen(false);
              }}
            >
              <span className="viewmenu__check" aria-hidden>
                {density === o.value && <IconCheck size={13} painted={1.9} />}
              </span>
              <span className="viewmenu__text">
                <span className="viewmenu__item-label">{o.label}</span>
                <span className="viewmenu__item-hint">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
