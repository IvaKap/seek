/*
 * Seek — how a digging session is named.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This is the function that exists because `DISCOVERY.md` put it in the
 * sidecar. Wording a timestamp is display formatting, and Python does none in
 * this project — so the sidecar stores `createdAt`, and the words happen here,
 * in the user's own locale rather than in hardcoded English.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionName } from './sessionStore.ts';

/** A fixed "now" so "today" and "last week" mean something in a test. */
const NOW = new Date('2026-08-17T23:49:00Z').getTime();
const secondsAgo = (s: number) => (NOW - s * 1000) / 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('sessionName', () => {
  it('a renamed session keeps its name forever', () => {
    expect(sessionName({ name: 'Hyperdub rabbit hole', createdAt: secondsAgo(0) }))
      .toBe('Hyperdub rabbit hole');
  });

  it('a name of only whitespace is not a name', () => {
    expect(sessionName({ name: '   ', createdAt: secondsAgo(0) })).toMatch(/^Today · /);
  });

  it('today says Today', () => {
    expect(sessionName({ name: '', createdAt: secondsAgo(60 * 60) })).toMatch(/^Today · /);
  });

  it('yesterday says Yesterday', () => {
    expect(sessionName({ name: '', createdAt: secondsAgo(30 * 60 * 60) }))
      .toMatch(/^Yesterday · /);
  });

  it('within the week says the weekday — useful for about three days', () => {
    const name = sessionName({ name: '', createdAt: secondsAgo(3 * 24 * 60 * 60) });
    expect(name).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) · /);
  });

  it('older than a week gives a date, because a weekday is then ambiguous', () => {
    const name = sessionName({ name: '', createdAt: secondsAgo(30 * 24 * 60 * 60) });
    expect(name).not.toMatch(/Today|Yesterday/);
    // A day number appears; the exact wording is the locale's business.
    expect(name).toMatch(/\d/);
  });

  it('always carries a time, which is what separates two digs in one day', () => {
    for (const days of [0, 1, 3, 40]) {
      const name = sessionName({ name: '', createdAt: secondsAgo(days * 24 * 60 * 60) });
      expect(name, `${days} days`).toContain(' · ');
    }
  });
});
