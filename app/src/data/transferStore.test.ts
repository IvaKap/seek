/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Giving up on a quiet download, and — the half that actually matters —
 * un-giving-up on it.
 *
 * Iva asked for stalled downloads to be swept into Failed on a timer, and chose
 * that they be RECLASSIFIED rather than cancelled: the transfer is not touched,
 * so it keeps its place in the peer's queue, which on Soulseek is often hours
 * long and frequently does come good.
 *
 * That choice is what makes the direction tests below the point of this file. A
 * stored "gave up" flag would satisfy every forward test here and still be
 * wrong, because nothing would ever clear it and a download that recovered
 * would sit in Failed for the rest of the session. The classification has to be
 * a pure derivation of "how long since this moved", and the only way to pin
 * that is to move it and watch the group come back.
 */

import { describe, expect, it } from 'vitest';
import { autoRetry, group, MAX_AUTO_RETRIES, silenceSeconds } from './transferStore.ts';
import type { Transfer } from './transferStore.ts';

const NOW = 1_800_000_000_000;

function t(over: Partial<Transfer> = {}): Transfer {
  return {
    id: over.path ?? 'id',
    direction: 'download',
    username: 'peer',
    path: '@@x\\Burial - Untrue\\01 - Archangel.flac',
    localFolder: null,
    size: 100,
    bytesDone: 0,
    state: 'transferring',
    speed: 0,
    averageSpeed: 0,
    queuePosition: null,
    secondsLeft: null,
    secondsElapsed: 0,
    stalled: false,
    secondsSinceProgress: 0,
    finishedAt: null,
    error: null,
    seenAt: NOW,
    ...over,
  };
}

/** Quiet for `seconds` as of NOW, reported when the sidecar last spoke. */
function quiet(seconds: number, over: Partial<Transfer> = {}): Transfer {
  return t({ stalled: true, secondsSinceProgress: seconds, seenAt: NOW, ...over });
}

const FIVE_MIN = 300;

describe('silenceSeconds', () => {
  it('keeps counting after the sidecar stops talking', () => {
    /* The reason the frontend stamps arrival at all. A quiet transfer emits
     * nothing more BY DEFINITION, so the number it last sent is the last one
     * there will ever be; reading it raw would freeze the clock at whatever
     * that final packet happened to say and the threshold would never arrive. */
    const held = t({ secondsSinceProgress: 60, seenAt: NOW - 120_000 });
    expect(silenceSeconds(held, NOW)).toBeCloseTo(180, 0);
  });

  it('treats a transfer with no stamp as freshly seen', () => {
    const { seenAt: _drop, ...rest } = t({ secondsSinceProgress: 42 });
    expect(silenceSeconds(rest as Transfer, NOW)).toBe(42);
  });
});

describe('group — giving up on a quiet download', () => {
  it('moves a group whose every file has gone quiet', () => {
    const [g] = group([quiet(FIVE_MIN + 1)], FIVE_MIN, NOW);
    expect(g.state).toBe('stalled');
  });

  it('COMES BACK the moment a byte moves', () => {
    /* The test a stored flag fails. Same transfer, same group, progress
     * reported: the sidecar resets `secondsSinceProgress` at the source and the
     * derivation has no memory of ever having given up. */
    const gone = group([quiet(FIVE_MIN + 1)], FIVE_MIN, NOW);
    expect(gone[0].state).toBe('stalled');

    const moved = group(
      [t({ stalled: false, secondsSinceProgress: 0, bytesDone: 10 })],
      FIVE_MIN, NOW,
    );
    expect(moved[0].state).toBe('active');
  });

  it('does not give up while ONE file is still moving', () => {
    /* A release arrives file by file. Burying it because nine of its ten files
     * are queued behind the one that is downloading would hide a download that
     * is working perfectly. */
    const g = group([
      quiet(FIVE_MIN + 1, { path: 'a\\rel\\1.flac', id: '1' }),
      t({ path: 'a\\rel\\2.flac', id: '2', secondsSinceProgress: 2 }),
    ], FIVE_MIN, NOW)[0];
    expect(g.state).toBe('active');
  });

  it('never gives up when the threshold is 0', () => {
    const [g] = group([quiet(86_400)], 0, NOW);
    expect(g.state).toBe('active');
  });

  it('does not sweep up a finished release', () => {
    /* A finished file is silent forever. Counting it as quiet would drag every
     * completed download into Failed the moment the feature was switched on —
     * which is the most destructive-looking bug this could have shipped. */
    const [g] = group(
      [t({ state: 'finished', bytesDone: 100, secondsSinceProgress: 999_999 })],
      FIVE_MIN, NOW,
    );
    expect(g.state).toBe('finished');
  });

  it('reports how long the LIVELIEST file has been quiet', () => {
    /* Minimum, not maximum: the group is only as dead as its most recently
     * active file, and reporting the worst would overstate how stuck it is. */
    const g = group([
      quiet(600, { path: 'a\\rel\\1.flac', id: '1' }),
      quiet(400, { path: 'a\\rel\\2.flac', id: '2' }),
    ], FIVE_MIN, NOW)[0];
    expect(g.quietFor).toBe(400);
  });

  it('sorts given-up groups below anything still working', () => {
    const groups = group([
      quiet(FIVE_MIN + 1, { path: 'a\\dead\\1.flac', id: 'd', username: 'a' }),
      t({ path: 'b\\live\\1.flac', id: 'l', username: 'b', secondsSinceProgress: 1 }),
    ], FIVE_MIN, NOW);
    expect(groups.map((g) => g.state)).toEqual(['active', 'stalled']);
  });

  it('leaves the failed COUNT alone', () => {
    /* `failed` feeds the "N failed" badge and the Retry-failed button. A group
     * that merely went quiet has failed nothing, and widening this to include
     * it would make both of those lie. */
    const [g] = group([quiet(FIVE_MIN + 1)], FIVE_MIN, NOW);
    expect(g.failed).toBe(0);
  });
});

describe('autoRetry — re-asking a peer that did not answer in time', () => {
  const timedOut = (id: string, over: Partial<Transfer> = {}) =>
    t({ id, path: `a\\rel\\${id}.flac`, state: 'connection_timeout', ...over });

  it('re-asks a timed-out download and counts the attempt', () => {
    const { retry, counts } = autoRetry([timedOut('1')], new Map());
    expect(retry).toEqual(['1']);
    expect(counts.get('1')).toBe(1);
  });

  it('only touches connection_timeout, not other failures', () => {
    // A logged-off peer resumes itself; a dropped connection and a local write
    // error are not the peer failing to answer. None are re-asked automatically.
    const transfers = [
      timedOut('to'),
      t({ id: 'off', state: 'user_logged_off' }),
      t({ id: 'closed', state: 'connection_closed' }),
      t({ id: 'local', state: 'local_file_error' }),
    ];
    expect(autoRetry(transfers, new Map()).retry).toEqual(['to']);
  });

  it('never re-asks an upload', () => {
    const up = timedOut('u', { direction: 'upload' });
    expect(autoRetry([up], new Map()).retry).toEqual([]);
  });

  it('stops at the cap, leaving the file for a manual retry', () => {
    const at = new Map([['1', MAX_AUTO_RETRIES]]);
    const { retry, counts } = autoRetry([timedOut('1')], at);
    expect(retry).toEqual([]);
    expect(counts.get('1')).toBe(MAX_AUTO_RETRIES);   // not incremented past the cap
  });

  it('climbs to the cap over repeated sweeps then holds', () => {
    let counts = new Map<string, number>();
    const attempts: number[] = [];
    for (let sweep = 0; sweep < MAX_AUTO_RETRIES + 2; sweep++) {
      const out = autoRetry([timedOut('1')], counts);
      attempts.push(out.retry.length);
      counts = out.counts;
    }
    // Retried exactly `cap` times, then silent.
    expect(attempts).toEqual([1, 1, 1, 0, 0]);
  });

  it('refreshes the budget once the file actually connects', () => {
    // Timed out, retried to the cap, then it CONNECTS — a later timeout is a
    // fresh episode and deserves fresh retries, not a dead row.
    const capped = new Map([['1', MAX_AUTO_RETRIES]]);
    const connected = autoRetry([t({ id: '1', state: 'transferring' })], capped);
    expect(connected.counts.has('1')).toBe(false);
    // And now a new timeout is re-asked again.
    expect(autoRetry([timedOut('1')], connected.counts).retry).toEqual(['1']);
  });

  it('forgets tallies for transfers that are gone', () => {
    const counts = new Map([['gone', 2]]);
    expect(autoRetry([timedOut('here')], counts).counts.has('gone')).toBe(false);
  });
});
