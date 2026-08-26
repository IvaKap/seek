/*
 * Seek — download preferences, applied at the moment of queueing.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Every check here already existed — quality tiers, the physics-based
 * transcode test. This is only the layer that decides what to DO about them,
 * which is why it lives in the domain rather than in the sidecar: the facts
 * are already in TypeScript, and sending a file down the socket only to be
 * told no would be a round trip to learn something we knew.
 *
 * A refused download always says why. Silently dropping something the user
 * clicked would be worse than downloading a file they did not want.
 */

import type { SourceFile } from './types.ts';

export interface DownloadPrefs {
  preferLossless: boolean;
  minBitrate: number;
  rejectTranscodes: boolean;
}

export interface Verdict {
  allowed: boolean;
  /** Present when refused; written for a person, not a log. */
  reason?: string;
}

export function judge(file: SourceFile, prefs: DownloadPrefs): Verdict {
  if (prefs.rejectTranscodes && file.transcode.suspect) {
    return {
      allowed: false,
      reason: `${file.parsed.displayTitle} looks like a transcode, and "reject `
        + 'suspected transcodes" is on.',
    };
  }

  // A lossless file carries no advertised bitrate at all (RECON.md §4), so a
  // minimum-bitrate rule must never be applied to one — it would reject every
  // FLAC on the network for failing to claim a number it cannot have.
  if (prefs.minBitrate > 0 && !file.quality.lossless && file.bitrate !== null
      && file.bitrate < prefs.minBitrate) {
    return {
      allowed: false,
      reason: `${file.parsed.displayTitle} is ${file.bitrate} kbps, below your `
        + `${prefs.minBitrate} kbps minimum.`,
    };
  }

  return { allowed: true };
}

/**
 * Which source to actually queue from a set of alternatives.
 *
 * The default is the highest combined score, which weighs speed and queue
 * length alongside format — so a free, fast 320 routinely beats a queued FLAC.
 * That is right when you want the track tonight and wrong when you are
 * building a collection, which is exactly what `preferLossless` selects.
 */
export function pickSource(sources: SourceFile[], prefs: DownloadPrefs): SourceFile {
  const allowed = sources.filter((s) => judge(s, prefs).allowed);
  const pool = allowed.length > 0 ? allowed : sources;

  if (prefs.preferLossless) {
    const lossless = pool.filter((s) => s.quality.lossless);
    if (lossless.length > 0) {
      // Still the best-scoring lossless one: the preference narrows the field,
      // it does not throw away everything else the score knows.
      return lossless.reduce((best, s) => (s.score > best.score ? s : best));
    }
  }
  return pool.reduce((best, s) => (s.score > best.score ? s : best));
}
