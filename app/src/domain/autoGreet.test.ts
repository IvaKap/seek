/* SPDX-License-Identifier: GPL-3.0-or-later */

import { describe, expect, it } from 'vitest';
import { planGreetings } from './autoGreet.ts';

const none = new Set<string>();

describe('planGreetings', () => {
  it('greets somebody new', () => {
    expect(planGreetings(['jazzcat'], none, 20)).toEqual(['jazzcat']);
  });

  it('never greets somebody already greeted', () => {
    /* THE rule. Without it a regular downloader gets the same message every
       time they come back, which is the difference between a greeting and
       being a nuisance. */
    expect(planGreetings(['jazzcat'], new Set(['jazzcat']), 20)).toEqual([]);
  });

  it('greets a person once for a folder grab that finishes many files', () => {
    const batch = ['jazzcat', 'jazzcat', 'jazzcat', 'raspberry', 'jazzcat'];
    expect(planGreetings(batch, none, 20)).toEqual(['jazzcat', 'raspberry']);
  });

  it('honours the session cap', () => {
    const many = ['a', 'b', 'c', 'd', 'e'];
    expect(planGreetings(many, none, 2)).toEqual(['a', 'b']);
  });

  it('plans nothing when no slots are left', () => {
    expect(planGreetings(['jazzcat'], none, 0)).toEqual([]);
    expect(planGreetings(['jazzcat'], none, -1)).toEqual([]);
  });

  it('counts the cap against NEW greetings, not candidates seen', () => {
    /* An already-greeted name must not eat a slot — otherwise a few regulars
       downloading would starve the one new person in the same batch. */
    const greeted = new Set(['old1', 'old2', 'old3']);
    expect(planGreetings(['old1', 'old2', 'old3', 'newcomer'], greeted, 1))
      .toEqual(['newcomer']);
  });

  it('ignores blank usernames', () => {
    expect(planGreetings(['', 'jazzcat'], none, 20)).toEqual(['jazzcat']);
  });

  it('plans nothing from an empty batch', () => {
    expect(planGreetings([], none, 20)).toEqual([]);
  });
});
