/*
 * Seek — shared controls.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { SPRING_SNAPPY } from '../motion/spring.ts';
import { useSpringValue } from '../motion/useSpring.ts';
import { IconCheck } from '../icons/index.tsx';

/* --------------------------------------------------------------- hit target */

/**
 * Props for a large clickable region that CONTAINS other controls.
 *
 * Result rows and release cards are clickable to expand, and they also carry
 * the quality indicator, which is itself a button that opens its reasoning.
 * A `<button>` inside a `<button>` is invalid HTML — its content model forbids
 * interactive content — and React says so at runtime on every search:
 *
 *   In HTML, <button> cannot be a descendant of <button>.
 *
 * The fix is not to demote the inner control, which is a real button doing a
 * real thing. It is that the OUTER region should never have been a button: a
 * big region containing a different, smaller action is exactly the case
 * `role="button"` exists for. Keyboard behaviour has to be restored by hand,
 * which is what this does — Enter and Space, the two keys a real button
 * answers to.
 */
export function hitTarget(activate: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onKeyDown(event: React.KeyboardEvent) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      // Space scrolls the page by default, and Enter would submit an ancestor
      // form. Both are wrong here.
      event.preventDefault();
      activate();
    },
  };
}

/* ------------------------------------------------------- segmented control */

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/**
 * The indicator is sprung, not transitioned, so a rapid back-and-forth between
 * two segments is continuous rather than restarting each time. Critically
 * damped — this appears in response to a click, not a flick, so it must not
 * overshoot.
 */
export function SegmentedControl<T extends string>({
  segments, value, onChange, label,
}: {
  segments: Segment<T>[];
  value: T;
  onChange(v: T): void;
  label: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(0);

  const springX = useSpringValue(
    (x) => {
      const el = indicatorRef.current;
      if (el) el.style.transform = `translate3d(${x}px, 0, 0)`;
    },
    0,
    SPRING_SNAPPY,
  );

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const el = indicatorRef.current;
    if (!wrap || !el) return;
    const active = wrap.querySelector<HTMLElement>(`[data-seg="${value}"]`);
    if (!active) return;
    if (active.offsetWidth !== widthRef.current) {
      widthRef.current = active.offsetWidth;
      el.style.width = `${active.offsetWidth}px`;
    }
    springX(active.offsetLeft);
  }, [value, springX]);

  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div className="segmented" role="radiogroup" aria-label={label} ref={wrapRef}>
      <div className="segmented__indicator" ref={indicatorRef} aria-hidden />
      {segments.map((s) => (
        <button
          key={s.value}
          data-seg={s.value}
          role="radio"
          aria-checked={value === s.value}
          className="segmented__item pressable"
          // Pointer-down, not click: the commit happens on release but the
          // interface must acknowledge the press immediately.
          onPointerDown={() => onChange(s.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onChange(s.value);
            }
          }}
        >
          {s.icon}
          <span>{s.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ toggle */

export function Toggle({
  checked, onChange, label,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="toggle pressable"
      onPointerDown={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onChange(!checked);
        }
      }}
    >
      <span className="toggle__track" aria-hidden>
        <span className="toggle__knob" />
      </span>
      <span className="toggle__label">{label}</span>
    </button>
  );
}

/* -------------------------------------------------------------------- chip */

export function Chip({
  active, onToggle, children, count,
}: {
  active: boolean;
  onToggle(): void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className="chip pressable"
      data-active={active ? 'true' : 'false'}
      onPointerDown={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      {/* Colour is never the only signal: the active chip also gets a check. */}
      {active && <IconCheck size={13} painted={1.9} />}
      <span>{children}</span>
      {count !== undefined && <span className="chip__count tnum">{count}</span>}
    </button>
  );
}

/* ------------------------------------------------------------ number field */

export function NumberField({
  value, onChange, placeholder, suffix, min = 0, width = '4.5rem', label,
}: {
  value: number | null;
  onChange(v: number | null): void;
  placeholder: string;
  suffix?: string;
  min?: number;
  width?: string;
  label: string;
}) {
  return (
    <label className="numfield">
      <span className="sr-only">{label}</span>
      <input
        className="numfield__input tnum"
        type="number"
        inputMode="numeric"
        min={min}
        style={{ width }}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value.trim();
          onChange(raw === '' ? null : Math.max(min, Number(raw)));
        }}
      />
      {suffix && <span className="numfield__suffix">{suffix}</span>}
    </label>
  );
}

/* ------------------------------------------------------------------ select */

export function Select<T extends string>({
  value, onChange, options, label,
}: {
  value: T;
  onChange(v: T): void;
  options: Array<{ value: T; label: string }>;
  label: string;
}) {
  return (
    <label className="select">
      <span className="sr-only">{label}</span>
      <select
        className="select__control"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
