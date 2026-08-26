/*
 * Seek — transfer statistics arithmetic.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The figures below are taken from Iva's real config, so the cases are the
 * shapes this actually meets rather than round numbers.
 */

import { describe, expect, it } from 'vitest';
import {
  completionRate, describeRatio, describeSince, formatRate,
  peerHistorySuspect, peerTotals, shareRatio,
} from './transferStats.ts';
import type { TransferCounts } from './transferStats.ts';
import { peerTone } from './score.ts';

/** Measured from a real run: ~6.6 GB down, ~767 MB up. */
function counts(over: Partial<TransferCounts> = {}): TransferCounts {
  return {
    startedDownloads: 381,
    completedDownloads: 261,
    downloadedSize: 7_086_835_876,
    startedUploads: 26,
    completedUploads: 18,
    uploadedSize: 804_009_811,
    ...over,
  };
}

describe('shareRatio', () => {
  it('divides bytes sent by bytes received', () => {
    expect(shareRatio(counts())).toBeCloseTo(0.1134, 3);
  });

  /* 0/0 is not a ratio of zero, it is the absence of one. A fresh install
   * reading "0.00" would state a fact about behaviour that has not happened. */
  it('is null when nothing has been downloaded', () => {
    expect(shareRatio(counts({ downloadedSize: 0, uploadedSize: 0 }))).toBeNull();
    expect(shareRatio(counts({ downloadedSize: 0, uploadedSize: 500 }))).toBeNull();
  });

  it('is zero, not null, when downloads happened and uploads did not', () => {
    expect(shareRatio(counts({ uploadedSize: 0 }))).toBe(0);
  });
});

describe('describeRatio', () => {
  it('words a ratio below parity as a share of what was taken', () => {
    const v = describeRatio(counts());
    expect(v.headline).toBe('11% of what you have taken');
    expect(v.tone).toBe('low');
  });

  it('names reciprocity as the mechanism, not a virtue', () => {
    const v = describeRatio(counts());
    expect(v.note).toMatch(/reciprocal/);
    expect(v.note).toMatch(/queues are slow/);
    // Not a scolding: no "should", no "must".
    expect(v.note).not.toMatch(/\byou should\b|\bmust\b/i);
  });

  it('treats a healthy ratio as a multiplier', () => {
    const v = describeRatio(counts({ uploadedSize: 14_000_000_000 }));
    expect(v.tone).toBe('good');
    expect(v.headline).toMatch(/^1\.98× more sent/);
  });

  /* Above 10 the decimals stop carrying information and start jittering as
   * bytes move. */
  it('drops the decimals on a very high ratio', () => {
    const v = describeRatio(counts({ uploadedSize: 7_086_835_876 * 42 }));
    expect(v.headline).toBe('42× more sent than received');
  });

  it('says there is no ratio rather than reporting zero', () => {
    const v = describeRatio(counts({ downloadedSize: 0, uploadedSize: 0 }));
    expect(v.tone).toBe('none');
    expect(v.headline).toBe('');
    expect(v.note).toMatch(/no ratio/);
  });

  it('separates fair from low at a quarter', () => {
    expect(describeRatio(counts({ uploadedSize: 1_000_000, downloadedSize: 5_000_000 })).tone)
      .toBe('low');
    expect(describeRatio(counts({ uploadedSize: 2_000_000, downloadedSize: 5_000_000 })).tone)
      .toBe('fair');
  });

  it('treats exact parity as good', () => {
    expect(describeRatio(counts({ uploadedSize: 100, downloadedSize: 100 })).tone).toBe('good');
  });
});

describe('completionRate', () => {
  it('divides completed by started', () => {
    expect(completionRate(381, 261)).toBeCloseTo(0.685, 3);
  });

  /* Two failures out of two is bad luck, not a pattern — the same reasoning
   * `peerTone` applies to a single peer. */
  it('withholds a rate below a handful of attempts', () => {
    expect(completionRate(0, 0)).toBeNull();
    expect(completionRate(4, 1)).toBeNull();
    expect(completionRate(5, 1)).not.toBeNull();
  });

  /* `started` and `completed` are independent counters, and a transfer begun
   * before a restart can finish after one. A rate above 1 reads as a bug. */
  it('never exceeds one', () => {
    expect(completionRate(10, 14)).toBe(1);
  });
});

describe('formatRate', () => {
  it('renders a percentage', () => {
    expect(formatRate(0.685)).toBe('69%');
  });

  it('renders nothing rather than 0% when there is no rate', () => {
    expect(formatRate(null)).toBe('');
  });

  it('renders a real zero as 0%', () => {
    expect(formatRate(0)).toBe('0%');
  });
});

describe('describeSince', () => {
  it('names the month and year counting began', () => {
    // 2026-05-09 in UTC; the exact day does not matter, the month does.
    expect(describeSince(1_778_000_000)).toMatch(/2026/);
  });

  /* Upstream only stamps this on a genuinely first run, so an older config
   * carries 0. Wording a span from that dates the history to 1970. */
  it('says nothing for an unstamped config', () => {
    expect(describeSince(0)).toBe('');
    expect(describeSince(-1)).toBe('');
  });

  it('says nothing for a timestamp in the future', () => {
    const now = Date.now();
    expect(describeSince(Math.floor(now / 1000) + 86_400, now)).toBe('');
  });
});

describe('peerTotals', () => {
  const sample = [
    { ok: 1, failed: 0 },      // too little history to judge
    { ok: 3, failed: 0 },      // good
    { ok: 9, failed: 10 },     // 47% — mixed, judged but neither
    { ok: 0, failed: 8 },      // bad
    { ok: 0, failed: 0 },      // never transferred: not a peer with history
  ];

  it('counts only peers with a transfer behind them', () => {
    expect(peerTotals(sample).peers).toBe(4);
  });

  it('sums the raw transfers', () => {
    const t = peerTotals(sample);
    expect(t.ok).toBe(13);
    expect(t.failed).toBe(18);
  });

  /* `peerTone` withholds a verdict below three transfers, so a total must not
   * publish one either. */
  it('judges only peers that clear the threshold', () => {
    const t = peerTotals(sample);
    expect(t.judged).toBe(3);
    expect(t.good).toBe(1);
    expect(t.bad).toBe(1);
    // The 9/19 peer is judged but is neither good nor bad.
    expect(t.good + t.bad).toBeLessThan(t.judged);
  });

  it('agrees with peerTone on every case', () => {
    for (const record of sample) {
      const total = record.ok + record.failed;
      if (total < 3) continue;
      const tone = peerTone(record.ok, record.failed);
      const one = peerTotals([record]);
      expect(one.good).toBe(tone === 'good' ? 1 : 0);
      expect(one.bad).toBe(tone === 'bad' ? 1 : 0);
    }
  });

  it('handles an empty history', () => {
    expect(peerTotals([])).toEqual({
      peers: 0, ok: 0, failed: 0, judged: 0, good: 0, bad: 0,
    });
  });
});

describe('peerHistorySuspect', () => {
  /* Peer outcomes are recorded once per DOWNLOAD transfer, so there cannot be
   * more of them than downloads ever started. Measured on a real config before
   * the fix: 1,792 outcomes against 381 started. */
  it('spots more recorded outcomes than downloads ever started', () => {
    expect(peerHistorySuspect({ ok: 259, failed: 1792 }, 381)).toBe(true);
  });

  it('accepts a history that fits inside the engine count', () => {
    expect(peerHistorySuspect({ ok: 259, failed: 100 }, 381)).toBe(false);
  });

  /* Transfers still running have no outcome yet, so fewer is ordinary. */
  it('accepts far fewer outcomes than downloads', () => {
    expect(peerHistorySuspect({ ok: 2, failed: 0 }, 381)).toBe(false);
  });

  it('treats exactly equal as fine', () => {
    expect(peerHistorySuspect({ ok: 200, failed: 181 }, 381)).toBe(false);
  });

  /* Nothing to compare against — a fresh config, or one whose statistics were
   * reset. Accusing the peer store on that basis would be guessing. */
  it('says nothing when the engine has no download count', () => {
    expect(peerHistorySuspect({ ok: 500, failed: 500 }, 0)).toBe(false);
  });

  it('says nothing about an empty peer history', () => {
    expect(peerHistorySuspect({ ok: 0, failed: 0 }, 381)).toBe(false);
  });
});
