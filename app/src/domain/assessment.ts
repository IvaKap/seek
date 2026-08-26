/*
 * Seek — the five quality states.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * docs/PRODUCT.md §5. This layer sits on top of `quality.ts` (what the peer
 * claims) and `checkTranscode` (whether the bytes support the claim) and turns
 * the pair into the one thing the user actually reads.
 *
 * THE LANGUAGE RULE, and it is the important one: never state any of this as
 * definitive. We are reasoning from file size and self-reported metadata, both
 * of which can be innocently wrong. So: "likely lossless", "strong signs of a
 * lossy source", "inconclusive" — never "FAKE FLAC". Being confidently wrong
 * about the exact thing the user is trusting us on is the worst failure
 * available to this app.
 *
 * `unverified` is not a fallback or an error. Roughly a quarter of real results
 * carry no audio attributes at all (RECON.md §4), and for those the honest
 * answer is that we do not know. It ranks as its own state, gets its own glyph,
 * and is never rendered as if it had passed.
 */

import type { SourceFile } from './types.ts';

export type QualityState =
  | 'excellent'
  | 'good'
  | 'suspicious'
  | 'likely-transcode'
  | 'unverified';

/** Distinct SHAPES, so the state survives greyscale and colour blindness. */
export type QualityGlyph = 'disc' | 'ring' | 'triangle' | 'cross' | 'dashed';

export interface Assessment {
  state: QualityState;
  label: string;
  glyph: QualityGlyph;
  /** One hedged line. Used as the accessible label. */
  summary: string;
  /** Paragraphs of actual arithmetic, shown when the indicator is clicked. */
  detail: string[];
  /** Sort weight, best first. */
  rank: number;
}

const STATE_META: Record<QualityState, { label: string; glyph: QualityGlyph; rank: number }> = {
  excellent: { label: 'Excellent', glyph: 'disc', rank: 0 },
  good: { label: 'Good', glyph: 'ring', rank: 1 },
  unverified: { label: 'Unverified', glyph: 'dashed', rank: 2 },
  suspicious: { label: 'Suspicious', glyph: 'triangle', rank: 3 },
  'likely-transcode': { label: 'Likely transcode', glyph: 'cross', rank: 4 },
};

function build(state: QualityState, summary: string, detail: string[]): Assessment {
  const meta = STATE_META[state];
  return { state, label: meta.label, glyph: meta.glyph, rank: meta.rank, summary, detail };
}

export function assess(file: SourceFile): Assessment {
  const t = file.transcode;
  const q = file.quality;

  /* ---- we could not check: its own state, never folded into "clean" ---- */
  if (t.verdict === 'unchecked') {
    return build(
      'unverified',
      'Not enough information to check this file',
      [
        t.explanation,
        'This is not a warning about the file — it may well be perfect. It means ' +
          'the check could not run, so treat the format label as unconfirmed.',
      ],
    );
  }

  /* ---- the claim is contradicted by the byte count ---- */
  if (t.verdict === 'contradicted') {
    return build(
      'likely-transcode',
      'Strong signs of a lossy source',
      [
        t.explanation,
        'Sizes can be off for innocent reasons — a trimmed intro, an unusual ' +
          'encoder, a long silence. But a gap this large usually means the audio ' +
          'was encoded at a lower bitrate first and re-labelled.',
      ],
    );
  }

  /* ---- lossless container, arithmetic doesn't support it ---- */
  if (t.verdict === 'inferred-transcode') {
    return build(
      'suspicious',
      'Lossless container, but the numbers do not add up',
      [
        t.explanation,
        'This one is inferred rather than proven: lossless files carry no ' +
          'advertised bitrate, so there is no claim here to contradict outright. ' +
          'Unusually quiet or sparse music does compress further than normal. ' +
          'Treat it as a reason to prefer another source, not as proof.',
      ],
    );
  }

  /* ---- the check ran and passed ---- */
  const hiRes = q.lossless && ((file.bitDepth ?? 0) >= 24 || (file.sampleRate ?? 0) > 48000);

  if (hiRes) {
    return build(
      'excellent',
      `Likely lossless, high resolution — ${q.label} ${(file.sampleRate ?? 0) / 1000} kHz / ${file.bitDepth}-bit`,
      [t.explanation, 'Both the format and the file size are consistent with a high-resolution lossless encode.'],
    );
  }

  if (q.lossless) {
    return build(
      'good',
      `Likely lossless — ${q.label}${file.sampleRate && file.bitDepth ? `, ${file.sampleRate / 1000} kHz / ${file.bitDepth}-bit` : ''}`,
      [t.explanation, 'The file size is consistent with a standard-resolution lossless encode.'],
    );
  }

  // Verified lossy. It passed its own check, so it belongs in `good`; the format
  // badge carries the actual bitrate, so a verified 128 is never mistaken for a
  // verified 320 despite sharing a state.
  return build(
    'good',
    `Lossy at ${q.label} kbps, size consistent with the claim`,
    [t.explanation, 'Lossy, but honestly labelled — the bytes match the advertised bitrate.'],
  );
}

/** Worst state across a set of files — what a release card shows. */
export function worstAssessment(files: SourceFile[]): Assessment {
  let worst: Assessment | null = null;
  for (const f of files) {
    const a = assess(f);
    if (!worst || a.rank > worst.rank) worst = a;
  }
  return worst ?? build('unverified', 'No files to assess', ['']);
}

/** Counts per state, for a release's "9 good, 1 suspicious" summary. */
export function assessmentCounts(files: SourceFile[]): Map<QualityState, number> {
  const counts = new Map<QualityState, number>();
  for (const f of files) {
    const s = assess(f).state;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}
