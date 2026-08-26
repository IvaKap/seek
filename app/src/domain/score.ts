/*
 * Seek — source scoring. Rank the SOURCE, not just the file.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The brief's premise, and it is correct: a perfect FLAC from a user with no
 * free slots, forty people queued and 12 KB/s is worse than a 320 from someone
 * free and fast. This is the default sort.
 *
 * Weights sum to 1.0 and are stated here so they can be argued with:
 *
 *   0.45  format quality      — still the largest single term; it is the product
 *   0.15  free upload slot    — binary, and the difference between "now" and "maybe"
 *   0.15  queue length        — how many people are ahead of you
 *   0.15  advertised speed    — a claim, so weighted no higher than the queue
 *   0.10  historical success  — our own record with this peer, Laplace-smoothed
 *
 * then penalties for a file that failed or could not pass the physics check.
 */

import type { PeerStats, Quality, TranscodeCheck } from './types.ts';

const W_QUALITY = 0.45;
const W_SLOTS = 0.15;
const W_QUEUE = 0.15;
const W_SPEED = 0.15;
const W_RELIABILITY = 0.10;

/** A refuted claim is a big deal; an inference is a smaller one. */
const PENALTY_CONTRADICTED = 0.25;
const PENALTY_INFERRED = 0.12;
/**
 * Not knowing is mildly worse than knowing it is fine — enough to break a tie
 * toward a verified file, not enough to bury an otherwise excellent source.
 */
const PENALTY_UNCHECKED = 0.04;

/** 0 queued → 1.0, 10 → 0.5, 40 → 0.2. Hyperbolic, so the first few matter most. */
export function queueScore(queueLength: number): number {
  return 1 / (1 + Math.max(0, queueLength) / 10);
}

/**
 * Log-scaled, because the difference between 20 and 200 KB/s matters enormously
 * and the difference between 4 and 8 MB/s does not. Saturates at ~5 MB/s.
 */
export function speedScore(bytesPerSec: number): number {
  if (!bytesPerSec || bytesPerSec <= 0) return 0;
  const norm = Math.log10(1 + bytesPerSec / 1024) / Math.log10(1 + 5_000_000 / 1024);
  return Math.max(0, Math.min(1, norm));
}

/**
 * Laplace-smoothed success rate. With no history at all this returns 0.5, so a
 * peer we have never met is treated as neither trusted nor distrusted.
 */
export function reliabilityFrom(ok: number, failed: number): number {
  return (ok + 1) / (ok + failed + 2);
}

/** Where a peer sits, in the only terms we can honestly use. */
export type PeerTone = 'good' | 'mixed' | 'bad';

/**
 * Lived in `ui/PeerHistory.tsx` until the statistics screen needed to count
 * how many peers fall in each tone. Two copies of this threshold would let a
 * peer's own chip say "mixed" while a total counted it as "bad".
 */
export function peerTone(ok: number, failed: number): PeerTone {
  const total = ok + failed;
  // Below a handful of transfers there is no pattern, only anecdote. Two
  // failures out of two is bad luck; seventy-six is a fact about the peer.
  if (total < 3) return 'mixed';
  if (failed === 0) return 'good';
  if (ok === 0) return 'bad';
  return ok / total >= 0.7 ? 'good' : ok / total >= 0.4 ? 'mixed' : 'bad';
}

export function peerTitle(ok: number, failed: number): string {
  return `${ok} of ${ok + failed} transfers from this peer finished, in your own`
    + ' history. Soulseek exposes nothing about how they treat anyone else, so'
    + ' this is the only honest basis for a reliability score.';
}


export function sourceScore(
  quality: Quality,
  peer: PeerStats,
  transcode: TranscodeCheck,
): number {
  const base =
    W_QUALITY * (quality.score / 100) +
    W_SLOTS * (peer.freeSlots ? 1 : 0) +
    W_QUEUE * queueScore(peer.queueLength) +
    W_SPEED * speedScore(peer.advertisedSpeed) +
    W_RELIABILITY * peer.reliability;

  let penalty = 0;
  if (transcode.verdict === 'contradicted') penalty = PENALTY_CONTRADICTED;
  else if (transcode.verdict === 'inferred-transcode') penalty = PENALTY_INFERRED;
  else if (transcode.verdict === 'unchecked') penalty = PENALTY_UNCHECKED;

  return Math.max(0, Math.min(1, base - penalty));
}

/** Human-readable breakdown, shown in the source tooltip. Never a bare number. */
export function explainScore(
  quality: Quality,
  peer: PeerStats,
  transcode: TranscodeCheck,
): Array<{ label: string; detail: string; weight: number; value: number }> {
  const rows = [
    {
      label: 'Format',
      detail: quality.description,
      weight: W_QUALITY,
      value: quality.score / 100,
    },
    {
      label: 'Upload slot',
      detail: peer.freeSlots ? 'Free right now' : 'None free — you will wait',
      weight: W_SLOTS,
      value: peer.freeSlots ? 1 : 0,
    },
    {
      label: 'Queue',
      detail: peer.queueLength === 0 ? 'Nobody ahead of you' : `${peer.queueLength} ahead of you`,
      weight: W_QUEUE,
      value: queueScore(peer.queueLength),
    },
    {
      label: 'Speed',
      detail: 'Advertised by the peer, not measured',
      weight: W_SPEED,
      value: speedScore(peer.advertisedSpeed),
    },
    {
      label: 'History',
      detail: peer.history
        ? `${peer.history.ok} completed, ${peer.history.failed} failed`
        : 'No history with this peer yet',
      weight: W_RELIABILITY,
      value: peer.reliability,
    },
  ];
  if (transcode.suspect) {
    rows.push({
      label: 'Transcode',
      detail: transcode.headline,
      weight: -1,
      value: transcode.verdict === 'contradicted' ? PENALTY_CONTRADICTED : PENALTY_INFERRED,
    });
  } else if (!transcode.checked) {
    rows.push({
      label: 'Unverified',
      detail: 'Could not check size against bitrate',
      weight: -1,
      value: PENALTY_UNCHECKED,
    });
  }
  return rows;
}
