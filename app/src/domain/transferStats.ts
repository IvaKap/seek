/*
 * Seek — what the transfer counters mean.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The sidecar forwards six raw counters twice over (session and lifetime) and
 * derives nothing. Every ratio, rate and percentage on the statistics screen
 * is computed here, which is the same seam every other derivation in this
 * project sits on.
 *
 * THE SIZE FIELDS COUNT BYTES MOVED, NOT FILES KEPT. Upstream adds each
 * fragment as it arrives, so a download that reached 80% and then lost its
 * peer put 80% of a file into `downloadedSize` and nothing into
 * `completedDownloads`. That makes it the right number for "bandwidth used"
 * and the wrong one for "how much music do I have" — the library index answers
 * the second. Nothing here may word it as a collection size.
 *
 * THE RATIO IS THE ONE FIGURE THAT MEANS SOMETHING SOCIALLY. Soulseek is
 * reciprocal: peers deprioritise and ban clients that take without giving, so
 * a low ratio is not a moral failing but it IS the mechanical reason queues
 * get slow. `describeRatio` states it and says what it does, once, without
 * nagging — the number is the argument.
 */

import { peerTone } from './score.ts';

export interface TransferCounts {
  startedDownloads: number;
  completedDownloads: number;
  downloadedSize: number;
  startedUploads: number;
  completedUploads: number;
  uploadedSize: number;
}

export interface TransferStats {
  sinceTimestamp: number;
  session: TransferCounts;
  total: TransferCounts;
}

export const EMPTY_COUNTS: TransferCounts = {
  startedDownloads: 0,
  completedDownloads: 0,
  downloadedSize: 0,
  startedUploads: 0,
  completedUploads: 0,
  uploadedSize: 0,
};

export const EMPTY_STATS: TransferStats = {
  sinceTimestamp: 0,
  session: EMPTY_COUNTS,
  total: EMPTY_COUNTS,
};

/**
 * Bytes sent divided by bytes received.
 *
 * Null when nothing has been downloaded: 0/0 is not a ratio of zero, it is the
 * absence of one, and a screen that reads "0.00" for a fresh install would be
 * stating a fact about behaviour that has not happened yet. Same rule as
 * `PeerHistory` refusing to show a smoothed prior as a measurement.
 */
export function shareRatio(counts: TransferCounts): number | null {
  if (counts.downloadedSize <= 0) return null;
  return counts.uploadedSize / counts.downloadedSize;
}

export type RatioTone = 'none' | 'low' | 'fair' | 'good';

export interface RatioVerdict {
  ratio: number | null;
  tone: RatioTone;
  /** The figure, as a person would say it. Empty when there is no ratio. */
  headline: string;
  /** What it means on this network. One sentence, never a scolding. */
  note: string;
}

/* Thresholds are conventions rather than measurements, and are named as such
 * wherever they surface. Soulseek has no published rule — individual peers set
 * their own — so these describe where a number stops being unusual, not a
 * standard anyone enforces. */
const LOW = 0.25;
const FAIR = 1;

export function describeRatio(counts: TransferCounts): RatioVerdict {
  const ratio = shareRatio(counts);

  if (ratio === null) {
    return {
      ratio: null,
      tone: 'none',
      headline: '',
      note: 'Nothing downloaded yet, so there is no ratio to report.',
    };
  }

  const headline = ratio >= 10
    // Above 10 the decimals stop carrying information and start jittering.
    ? `${Math.round(ratio)}× more sent than received`
    : ratio >= 1
      ? `${ratio.toFixed(2)}× more sent than received`
      : `${Math.round(ratio * 100)}% of what you have taken`;

  if (ratio < LOW) {
    return {
      ratio,
      tone: 'low',
      note: 'Soulseek is reciprocal — peers deprioritise and ban clients that '
        + 'share little, so this is usually why queues are slow. Sharing more '
        + 'folders is the fix.',
      headline,
    };
  }
  if (ratio < FAIR) {
    return {
      ratio,
      tone: 'fair',
      headline,
      note: 'Below parity, which most peers accept without comment.',
    };
  }
  return {
    ratio,
    tone: 'good',
    headline,
    note: 'More given than taken. This is what earns queue position.',
  };
}

/**
 * How many started transfers actually finished, 0..1.
 *
 * Null below a handful of attempts, for the reason `peerTone` gives about
 * peers: two failures out of two is bad luck, not a pattern. Unlike a peer
 * this is about the network as a whole, but the arithmetic is just as noisy
 * when the denominator is tiny.
 */
const MIN_ATTEMPTS = 5;

export function completionRate(started: number, completed: number): number | null {
  if (started < MIN_ATTEMPTS) return null;
  // Clamped: `started` and `completed` are independent counters and a transfer
  // begun before a restart can finish after one, so completed CAN exceed
  // started on a long-lived config. A rate above 1 would read as a bug.
  return Math.min(1, completed / started);
}

/**
 * "68%" or nothing. Never "0%" from an empty denominator.
 */
export function formatRate(rate: number | null): string {
  return rate === null ? '' : `${Math.round(rate * 100)}%`;
}

/**
 * "since March 2026", or empty.
 *
 * Upstream only stamps `since_timestamp` on a genuinely first run, so a config
 * that predates the field carries 0. Wording a span from that would date the
 * user's history to 1970.
 */
export function describeSince(sinceTimestamp: number, now = Date.now()): string {
  if (!sinceTimestamp || sinceTimestamp <= 0) return '';
  const when = new Date(sinceTimestamp * 1000);
  if (when.getTime() > now) return '';
  return when.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export interface PeerTotals {
  /** Peers with at least one recorded transfer. */
  peers: number;
  ok: number;
  failed: number;
  /** Peers with enough history for `peerTone` to render a verdict. */
  judged: number;
  good: number;
  bad: number;
}

/**
 * Aggregate the per-peer history.
 *
 * Tones come from `peerTone` itself rather than from a second copy of its
 * thresholds. A duplicated rule here would let a peer's own chip read "mixed"
 * while this total counted the same peer as "bad" — and `peerTone` withholds a
 * verdict below three transfers precisely so that two failures out of two are
 * not published as a pattern. `judged` says how many peers cleared that bar,
 * so the good and bad counts are never mistaken for the whole list.
 */
/**
 * Whether the stored per-peer history can be trusted against the engine's own
 * counters.
 *
 * Peer outcomes are recorded once per DOWNLOAD transfer, so the number of them
 * cannot exceed the number of downloads ever started. When it does, the store
 * predates the fix in `_record_outcome`, which counted every transition into a
 * terminal state rather than every transfer — so a queued download whose peer
 * kept going offline and coming back logged a failure per cycle.
 *
 * Measured on a real config: 1,792 recorded outcomes against 381 downloads
 * ever started. There is no way to reconstruct the truth from that, so the
 * screen declines to publish the totals rather than printing a figure it can
 * prove is wrong.
 *
 * A statistics reset in upstream that left the peer store alone would also
 * trip this, which is why the wording says the two disagree rather than
 * blaming either.
 */
export function peerHistorySuspect(
  totals: Pick<PeerTotals, 'ok' | 'failed'>,
  startedDownloads: number,
): boolean {
  if (startedDownloads <= 0) return false;
  return totals.ok + totals.failed > startedDownloads;
}

export function peerTotals(
  records: Iterable<{ ok: number; failed: number }>,
): PeerTotals {
  const out: PeerTotals = { peers: 0, ok: 0, failed: 0, judged: 0, good: 0, bad: 0 };
  for (const record of records) {
    const total = record.ok + record.failed;
    if (total === 0) continue;
    out.peers += 1;
    out.ok += record.ok;
    out.failed += record.failed;

    const tone = peerTone(record.ok, record.failed);
    // 'mixed' below three transfers is "we do not know", not a middle verdict,
    // so those peers are counted in `peers` and nowhere else.
    if (total < 3) continue;
    out.judged += 1;
    if (tone === 'good') out.good += 1;
    else if (tone === 'bad') out.bad += 1;
  }
  return out;
}
