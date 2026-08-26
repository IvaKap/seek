/*
 * Seek — transfer status wording.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The bug these exist for: a queue of stalled downloads all read "unknown",
 * because upstream puts a peer's refusal into `transfer.status` and Seek
 * mapped only the closed TransferStatus set. Every one of those had a reason
 * attached that was thrown away.
 */

import { describe, expect, it } from 'vitest';
import { needsAttention, transferStatus } from './transferStatus.ts';

function t(over: Partial<Parameters<typeof transferStatus>[0]> = {}) {
  return transferStatus({
    state: 'queued', error: null, queuePosition: null, stalled: false, bytesDone: 0, ...over,
  });
}

describe('the queue, which is where most downloads actually are', () => {
  it('states the position when the peer gave one', () => {
    expect(t({ state: 'queued', queuePosition: 39 }).text).toBe(
      'Waiting in their queue — number 39',
    );
  });

  it('still says it is queued when the peer gave no number', () => {
    /* Upstream reports 0 both for "not queued" and "queued, position unknown",
     * so the sidecar sends null. A queue with no number is still a queue. */
    expect(t({ state: 'queued', queuePosition: null }).text).toBe('Waiting in their queue');
  });

  it('does not offer Retry for something that is working', () => {
    expect(t({ state: 'queued', queuePosition: 3 }).retryable).toBe(false);
    expect(needsAttention(t({ state: 'queued' }))).toBe(false);
  });
});

describe('refusals — what "unknown" was hiding', () => {
  it('says what the peer said, in words', () => {
    expect(t({ state: 'rejected', error: 'File not shared.' }).text)
      .toBe('They are no longer sharing this file');
    expect(t({ state: 'rejected', error: 'Banned' }).text)
      .toBe('This person has banned you');
  });

  it('distinguishes refusals worth retrying from ones that are not', () => {
    /* The useful half. "Banned" will still be banned in an hour; a queue that
     * is full right now will not be full for ever. */
    expect(t({ state: 'rejected', error: 'Banned' }).retryable).toBe(false);
    expect(t({ state: 'rejected', error: 'File not shared.' }).retryable).toBe(false);
    expect(t({ state: 'rejected', error: 'Pending shutdown.' }).retryable).toBe(true);
    expect(t({ state: 'rejected', error: 'Too many files' }).retryable).toBe(true);
  });

  it('quotes free text rather than paraphrasing it', () => {
    /* Peers send their own strings — upstream special-cases anything starting
     * "User limit of", which proves the set is open. Guessing at the meaning
     * would be inventing words a stranger did not say. */
    const line = t({ state: 'rejected', error: 'User limit of 250 files reached' });
    expect(line.text).toBe('They refused: User limit of 250 files reached');
    expect(line.tone).toBe('refused');
  });

  it('copes with a refusal that carried no text at all', () => {
    expect(t({ state: 'rejected', error: null }).text).toBe('They refused the request');
  });

  it('marks every refusal as needing attention', () => {
    expect(needsAttention(t({ state: 'rejected', error: 'Banned' }))).toBe(true);
  });
});

describe('the states people actually stare at', () => {
  it('explains an offline peer instead of naming the enum', () => {
    const line = t({ state: 'user_logged_off' });
    expect(line.text).toBe('They are offline — it will resume when they return');
    expect(line.text).not.toMatch(/logged.off/i);
    /* Waiting, not broken: this one resolves itself, and offering Retry would
     * suggest the person can do something about someone else's laptop. */
    expect(line.tone).toBe('waiting');
    expect(line.retryable).toBe(false);
  });

  it('never prints the word "unknown" at anyone', () => {
    const line = t({ state: 'unknown' });
    expect(line.text).not.toMatch(/unknown/i);
    expect(line.retryable).toBe(true);
  });

  it('separates a stalled transfer from a slow one', () => {
    /* Both report a speed of 0, so the number cannot tell them apart. */
    expect(t({ state: 'transferring', stalled: false }).text).toBe('Downloading');
    expect(t({ state: 'transferring', stalled: true }).text).toMatch(/Stalled/);
    expect(t({ state: 'transferring', stalled: true }).retryable).toBe(true);
  });

  it('says whether a dropped connection got anywhere', () => {
    expect(t({ state: 'connection_closed', bytesDone: 0 }).text)
      .toBe('They did not answer');
    expect(t({ state: 'connection_closed', bytesDone: 5000 }).text)
      .toBe('The connection dropped part-way');
  });

  it('blames Seek for Seek\'s own failures', () => {
    expect(t({ state: 'download_folder_error' }).text).toMatch(/^Seek could not/);
    expect(t({ state: 'local_file_error' }).text).toMatch(/^Seek could not/);
  });
});

describe('the wording contract', () => {
  const STATES = [
    'queued', 'getting_status', 'transferring', 'paused', 'cancelled', 'filtered',
    'finished', 'rejected', 'user_logged_off', 'connection_closed',
    'connection_timeout', 'download_folder_error', 'local_file_error', 'unknown',
  ];

  it('gives every state a sentence, with no enum leaking through', () => {
    for (const state of STATES) {
      const line = t({ state });
      expect(line.text.length, state).toBeGreaterThan(0);
      // The bug in one assertion: no underscores, and no bare identifier.
      expect(line.text, state).not.toMatch(/_/);
      expect(line.text[0], state).toBe(line.text[0].toUpperCase());
    }
  });

  it('survives a state the sidecar has not been taught yet', () => {
    /* A newer engine against an older app. Silence would be worse. */
    expect(t({ state: 'something_new' }).text.length).toBeGreaterThan(0);
  });
});
