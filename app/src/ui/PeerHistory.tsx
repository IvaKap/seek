/*
 * Seek — how a peer has actually treated you.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * docs/PRODUCT.md §8 asks for this and is emphatic about its one rule:
 * reliability is derived from OUR OWN interaction history and nothing else.
 * The Soulseek protocol exposes nothing about how a stranger behaves towards
 * anyone else, so "97% successful" would be a claim about the world we cannot
 * make. "9 of 19 with you" is a claim about our own logs, which we can.
 *
 * It was already being scored on — a peer with 76 failures and no successes
 * sinks to the bottom of every source list — and the user could not see why.
 * A ranking that reorders itself for reasons it will not show is the kind of
 * confident opacity this app exists to avoid.
 *
 * SHOWN ONLY WHEN THERE IS HISTORY. A peer you have never downloaded from gets
 * nothing at all, not "50%": the smoothed prior is the right input to a score
 * and the wrong thing to put on screen, because it looks like a measurement.
 */

import type { PeerRecord } from '../data/prefsStore.ts';
import { peerTone, peerTitle } from '../domain/score.ts';

/* The tone rule moved to `domain/score.ts`, beside `reliabilityFrom`, when the
   statistics screen needed to count peers by tone — one threshold, so a peer's
   own chip and a total can never disagree. Re-exported because this is still
   where callers expect to find it. */
export { peerTone, peerTitle } from '../domain/score.ts';
export type { PeerTone } from '../domain/score.ts';

/** A lookup the views are handed, so nothing below needs the whole store. */
export type PeerLookup = (username: string) => PeerRecord | undefined;

export function PeerHistory({
  username, peers, compact,
}: {
  username: string;
  peers?: PeerLookup;
  /** Drops the trailing words where the row is already dense. */
  compact?: boolean;
}) {
  const record = peers?.(username);
  if (!record) return null;
  const total = record.ok + record.failed;
  if (total === 0) return null;

  return (
    <span
      className="peerhist"
      data-tone={peerTone(record.ok, record.failed)}
      title={peerTitle(record.ok, record.failed)}
    >
      <span className="tnum">{record.ok}</span>
      <span aria-hidden>/</span>
      <span className="tnum">{total}</span>
      {!compact && <span className="peerhist__with">with you</span>}
    </span>
  );
}
