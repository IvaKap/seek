/*
 * Seek — what a checksum sidecar actually tells you.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The sidecar reports raw facts: an expected digest, an actual digest, and a
 * reason when the actual could not be computed. Every comparison and every
 * word about it is here, because the meaning of a mismatch depends entirely on
 * which kind of sidecar it came from, and that is a display decision.
 *
 * THE DISTINCTION THIS FILE EXISTS TO PROTECT:
 *
 *   .ffp  hashes the DECODED AUDIO. Re-tag a FLAC and it is unchanged. A
 *         mismatch means the audio itself is different — a re-encode, another
 *         master, another take. This is the strong result.
 *
 *   .md5  hashes the WHOLE FILE. Fixing one misspelt track title changes it.
 *         A mismatch is worth showing and is NOT evidence the audio is wrong.
 *
 * Collapsing those two into one red badge would be the same mistake PRODUCT §6
 * forbids between the search-time prediction and the spectral finding: it
 * reads as certainty the data does not support. An .md5 mismatch on its own is
 * a question. An .ffp mismatch is an answer.
 *
 * And note what even a passing .ffp does not cover. The expected value is the
 * FLAC's own STREAMINFO signature, read from its header — so a match says
 * "this is the audio the fingerprint was made from", not "this file decodes
 * cleanly". Damage to a compressed frame leaves the header untouched.
 */

import type { ChecksumEntry, ChecksumReport } from '../../../shared/protocol.ts';

export type ChecksumVerdict = 'match' | 'mismatch' | 'unchecked';
export type ChecksumTone = 'good' | 'warn' | 'bad' | 'unknown';

/** Case-insensitive, because a sidecar's hex case is nobody's business. */
export function verdictOf(e: ChecksumEntry): ChecksumVerdict {
  if (e.issue !== null || e.actual === null) return 'unchecked';
  return e.expected.toLowerCase() === e.actual.toLowerCase() ? 'match' : 'mismatch';
}

export interface ChecksumSummary {
  /** True when the folder had no sidecar at all — the ordinary case. */
  none: boolean;
  matched: number;
  mismatched: number;
  /** Mismatches of the decoded audio. The only kind that settles anything. */
  audioMismatched: number;
  /** Named by a sidecar and not in the folder. About completeness, not damage. */
  missing: number;
  /** Present, but nothing to compare against. Not a fault of the file. */
  unverifiable: number;
  /** Sidecars that could not be read at all. */
  unreadableSidecars: number;
  /** Lines in a sidecar we did not understand. Never silently ignored. */
  unparsedLines: number;
  tone: ChecksumTone;
  headline: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function summarise(report: ChecksumReport): ChecksumSummary {
  let matched = 0;
  let mismatched = 0;
  let audioMismatched = 0;
  let missing = 0;
  let unverifiable = 0;

  for (const e of report.entries) {
    const v = verdictOf(e);
    if (v === 'match') matched += 1;
    else if (v === 'mismatch') {
      mismatched += 1;
      if (e.kind === 'ffp') audioMismatched += 1;
    } else if (e.issue === 'missing') missing += 1;
    else unverifiable += 1;
  }

  const unreadableSidecars = report.sidecars.filter((s) => s.error !== '').length;
  const unparsedLines = report.sidecars.reduce((n, s) => n + s.unparsedLines, 0);
  const none = report.sidecars.length === 0;

  const s: ChecksumSummary = {
    none,
    matched,
    mismatched,
    audioMismatched,
    missing,
    unverifiable,
    unreadableSidecars,
    unparsedLines,
    tone: 'unknown',
    headline: '',
  };
  s.tone = toneOf(s);
  s.headline = headlineOf(s);
  return s;
}

function toneOf(s: ChecksumSummary): ChecksumTone {
  if (s.audioMismatched > 0) return 'bad';
  // A byte mismatch with no audio mismatch is a question, never a charge.
  if (s.mismatched > 0) return 'warn';
  if (s.matched > 0) return 'good';
  return 'unknown';
}

function headlineOf(s: ChecksumSummary): string {
  /* MOST FOLDERS HAVE NONE, and this must not read as a failed check. It is
     the answer to a question that had no answer available. */
  if (s.none) return 'No .ffp or .md5 shipped with this folder.';
  if (s.unreadableSidecars > 0 && s.matched + s.mismatched === 0) {
    return 'A checksum file is here but could not be read.';
  }

  if (s.audioMismatched > 0) {
    return `${plural(s.audioMismatched, 'file')} ${s.audioMismatched === 1 ? 'is' : 'are'} `
      + 'not the audio the fingerprint names.';
  }
  if (s.mismatched > 0) {
    return `${plural(s.mismatched, 'file')} ${s.mismatched === 1 ? 'does' : 'do'} `
      + 'not match the .md5, which a tag edit alone would do.';
  }
  if (s.matched > 0) {
    const checked = s.matched + s.mismatched;
    const head = `${s.matched} of ${plural(checked, 'file')} verified.`;
    return s.missing > 0
      ? `${head} ${plural(s.missing, 'more file is', 'more files are')} named but not here.`
      : head;
  }
  if (s.missing > 0) {
    return `The checksum file names ${plural(s.missing, 'file')} that ${
      s.missing === 1 ? 'is' : 'are'} not in this folder.`;
  }
  return 'Nothing here could be checked.';
}

/** One sentence for one line of a sidecar. The hedging is the point. */
export function explainEntry(e: ChecksumEntry): string {
  switch (e.issue) {
    case 'missing':
      return 'Named by the checksum file, but not in this folder.';
    case 'not_flac':
      return 'Not a FLAC, so it carries no audio fingerprint to compare against.';
    case 'no_signature':
      return 'This file’s encoder left the audio signature unset, so there is '
        + 'nothing to compare. Permitted, and not a fault of the file.';
    case 'unreadable':
      return 'Could not be read from disk.';
    default:
      break;
  }

  const match = verdictOf(e) === 'match';
  if (e.kind === 'ffp') {
    return match
      ? 'The decoded audio is exactly what the fingerprint was made from. Tags may '
        + 'have changed since; the audio has not.'
      : 'This is not the audio the fingerprint names — a re-encode, a different '
        + 'master or a different take.';
  }
  return match
    ? 'Byte for byte the file the checksum was made from.'
    : 'The bytes differ. Editing a single tag does that, so on its own this is not '
      + 'evidence the audio is wrong — an .ffp would settle it.';
}

const ORDER: Record<ChecksumVerdict, number> = { mismatch: 0, unchecked: 1, match: 2 };

/**
 * Problems first, then things that could not be checked, then the good news.
 * Stable within each band, so the folder's own order survives.
 */
export function orderedEntries(report: ChecksumReport): ChecksumEntry[] {
  return report.entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => ORDER[verdictOf(a.e)] - ORDER[verdictOf(b.e)] || a.i - b.i)
    .map(({ e }) => e);
}

/**
 * What the row SAYS, which — like the tone — depends on what was hashed.
 *
 * Not a table keyed on the verdict, and not for tidiness. Two rows reading
 * "Does not match" in red and amber puts the entire distinction into colour,
 * and the distinction is the feature. These two say different words.
 */
export function labelOfEntry(e: ChecksumEntry): string {
  const v = verdictOf(e);
  if (v === 'match') return 'Verified';
  if (v === 'unchecked') return 'Not checked';
  return e.kind === 'ffp' ? 'Different audio' : 'Bytes differ';
}

/**
 * A FUNCTION rather than a table, because the tone of a mismatch is not a
 * property of the mismatch — it is a property of what was hashed. Red on a
 * whole-file mismatch would call a retagged file a fake.
 */
export function toneOfEntry(e: ChecksumEntry): ChecksumTone {
  const v = verdictOf(e);
  if (v === 'match') return 'good';
  if (v === 'unchecked') return 'unknown';
  return e.kind === 'ffp' ? 'bad' : 'warn';
}

/** What kind of claim this row makes, said in three words rather than a suffix. */
export const KIND_LABEL: Record<ChecksumEntry['kind'], string> = {
  ffp: 'audio fingerprint',
  md5: 'whole-file checksum',
};
