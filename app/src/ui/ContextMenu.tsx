/*
 * Seek — right-click menu.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The GTK client's context menu is where its power actually lives, and a
 * redesign that drops it trades depth for tidiness. This keeps the depth and
 * puts it behind a right-click, so the row itself stays quiet.
 *
 * Three behaviours make a context menu feel native rather than approximate:
 *
 *  - It opens AT THE POINTER, and flips rather than overflowing when near an
 *    edge. A menu that opens half off-screen is worse than no menu.
 *  - It scales from the corner nearest the pointer, so it grows out of where
 *    you clicked instead of appearing from nowhere (apple-design: popovers
 *    scale from their trigger's origin, never their centre).
 *  - The keyboard drives it: arrows, Home/End, Enter, Escape. A menu you can
 *    only click is a menu that breaks the keyboard-first promise.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../motion/prefs.ts';

export interface MenuItem {
  id: string;
  label: string;
  /** Rendered right-aligned, for a shortcut or a hint. */
  hint?: string;
  disabled?: boolean;
  /** Draws a separator ABOVE this item. */
  separated?: boolean;
  danger?: boolean;
  run(): void;
}

export interface MenuRequest {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
}

const EDGE = 8;

export function ContextMenu({
  request, onClose,
}: {
  request: MenuRequest | null;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0, flipX: false, flipY: false });
  const [active, setActive] = useState(-1);
  const reduced = useReducedMotion();

  const usable = request?.items.filter((i) => !i.disabled) ?? [];

  /* Measure then place, before paint: positioning after paint would show the
   * menu at the wrong spot for a frame, which reads as a jump. */
  useLayoutEffect(() => {
    if (!request) return;
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const flipX = request.x + width + EDGE > window.innerWidth;
    const flipY = request.y + height + EDGE > window.innerHeight;
    setPos({
      x: flipX ? Math.max(EDGE, request.x - width) : request.x,
      // When flipping up would still overflow the top, clamp instead: a menu
      // taller than the viewport should sit against the edge, not off it.
      y: flipY ? Math.max(EDGE, Math.min(request.y - height, window.innerHeight - height - EDGE))
        : request.y,
      flipX,
      flipY,
    });
    setActive(-1);
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => {
          if (usable.length === 0) return -1;
          const step = e.key === 'ArrowDown' ? 1 : -1;
          return (i + step + usable.length) % usable.length;
        });
        return;
      }
      if (e.key === 'Home') { e.preventDefault(); setActive(0); return; }
      if (e.key === 'End') { e.preventDefault(); setActive(usable.length - 1); return; }
      if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        const item = usable[active];
        onClose();
        item?.run();
      }
    };
    // Capture, so the menu wins over the app's own global shortcuts while open.
    window.addEventListener('keydown', onKey, true);
    // Any scroll invalidates the anchor point, so close rather than drift.
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [request, usable, active, onClose]);

  const choose = useCallback((item: MenuItem) => {
    if (item.disabled) return;
    // Close first: an action that changes section must not run while a menu
    // still owns the keyboard.
    onClose();
    item.run();
  }, [onClose]);

  if (!request) return null;

  return (
    <div className="ctx__scrim" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        ref={ref}
        className="ctx"
        role="menu"
        aria-label={request.title ?? 'Actions'}
        data-reduced={reduced ? 'true' : undefined}
        style={{
          left: pos.x,
          top: pos.y,
          transformOrigin: `${pos.flipX ? 'right' : 'left'} ${pos.flipY ? 'bottom' : 'top'}`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {request.title && <div className="ctx__title">{request.title}</div>}
        {request.items.map((item) => {
          const index = usable.indexOf(item);
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="ctx__item"
              data-separated={item.separated ? 'true' : undefined}
              data-danger={item.danger ? 'true' : undefined}
              data-active={index >= 0 && index === active ? 'true' : undefined}
              disabled={item.disabled}
              onPointerDown={(e) => { e.preventDefault(); choose(item); }}
              onPointerEnter={() => setActive(index)}
            >
              <span className="ctx__label">{item.label}</span>
              {item.hint && <span className="ctx__hint">{item.hint}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
