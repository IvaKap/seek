/*
 * Seek — ⌘K.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The vision note's Tier 4, and the fastest route to "this feels like a real
 * Mac app" once there is an action surface worth addressing.
 *
 * Two rules shape it:
 *
 * 1. It lists ACTIONS, not a menu of everything. A palette that mirrors the
 *    navigation is just a slower sidebar. Everything here either does something
 *    or goes somewhere you cannot already reach in one click.
 *
 * 2. Typing is the primary interaction, so the first result must be the right
 *    one. The matcher scores prefix and word-boundary hits far above scattered
 *    subsequence hits, because "dow" should find Downloads, not "Download
 *    folder" three items later.
 *
 * Motion, per the apple-design skill: it appeared, it was not thrown, so it
 * must not overshoot — a short fade with a 1.01 scale settle, and nothing at
 * all under reduced motion.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from '../motion/prefs.ts';

export interface Command {
  id: string;
  label: string;
  /** Where it lives, shown as a quiet prefix. */
  group: string;
  hint?: string;
  shortcut?: string;
  run(): void;
}

interface Scored { cmd: Command; score: number; hits: number[] }

/**
 * Subsequence match with position-aware scoring. Returns null when a character
 * is missing entirely, so non-matches are dropped rather than ranked low.
 */
function score(query: string, text: string): { score: number; hits: number[] } | null {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  let ti = 0;
  let total = 0;
  let streak = 0;
  const hits: number[] = [];

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;

    // Start of the string, or of a word, is what a person actually aims at.
    const atStart = found === 0;
    const afterBoundary = found > 0 && /[\s\-_/·]/.test(t[found - 1]);
    let points = 1;
    if (atStart) points += 12;
    else if (afterBoundary) points += 8;
    // Consecutive characters mean the user is typing the word, not stabbing at it.
    if (found === ti && qi > 0) { streak += 1; points += 4 + streak * 2; }
    else streak = 0;
    // Later matches are worth less, so a hit in the label beats one in the hint.
    points -= Math.min(found * 0.08, 4);

    total += points;
    hits.push(found);
    ti = found + 1;
  }
  return { score: total, hits };
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (hits.length === 0) return <>{text}</>;
  const set = new Set(hits);
  return (
    <>
      {[...text].map((ch, i) => (
        set.has(i)
          ? <mark key={i} className="cmdk__hit">{ch}</mark>
          : <span key={i}>{ch}</span>
      ))}
    </>
  );
}

export function CommandPalette({
  open, commands, onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  const results = useMemo<Scored[]>(() => {
    const out: Scored[] = [];
    for (const cmd of commands) {
      const onLabel = score(query, cmd.label);
      if (onLabel) {
        out.push({ cmd, score: onLabel.score + 6, hits: onLabel.hits });
        continue;
      }
      // Group and hint are searchable, but never outrank a label match.
      const onOther = score(query, `${cmd.group} ${cmd.hint ?? ''}`);
      if (onOther) out.push({ cmd, score: onOther.score, hits: [] });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 40);
  }, [commands, query]);

  // Reset per opening, not per keystroke — reopening should feel like a fresh
  // start, but typing must not fight the selection back to the top.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // Focus after paint, or the browser hands focus back to whatever had it.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  // Keep the selection in view without scrolling the whole page.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  const commit = useCallback((index: number) => {
    const chosen = results[index];
    if (!chosen) return;
    // Close first: a command that changes section should not run against a
    // palette still capturing the keyboard.
    onClose();
    chosen.cmd.run();
  }, [results, onClose]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); commit(active); }
  }, [results, active, commit, onClose]);

  if (!open) return null;

  return (
    <div
      className="cmdk__scrim"
      data-reduced={reduced ? 'true' : undefined}
      onPointerDown={onClose}
      role="presentation"
    >
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        // The scrim closes; the panel must not close when you click inside it.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk__input"
          value={query}
          placeholder="Search commands…"
          aria-label="Search commands"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className="cmdk__list" ref={listRef} role="listbox" aria-label="Commands">
          {results.length === 0 ? (
            <p className="cmdk__empty">No command matches that.</p>
          ) : (
            results.map((r, i) => (
              <button
                key={r.cmd.id}
                type="button"
                className="cmdk__item"
                role="option"
                aria-selected={i === active}
                data-active={i === active ? 'true' : undefined}
                // Pointer-down, not click: the palette closes on commit, and a
                // click handler would fire after the element had gone.
                onPointerDown={(e) => { e.preventDefault(); commit(i); }}
                onPointerEnter={() => setActive(i)}
              >
                <span className="cmdk__group">{r.cmd.group}</span>
                <span className="cmdk__label">
                  <Highlight text={r.cmd.label} hits={r.hits} />
                </span>
                {r.cmd.hint && <span className="cmdk__hint">{r.cmd.hint}</span>}
                {r.cmd.shortcut && <kbd className="cmdk__key">{r.cmd.shortcut}</kbd>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
