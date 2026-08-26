/*
 * Seek — audio quality ranking, and the physics check that catches liars.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Two separate jobs, deliberately not conflated:
 *
 *   `classify()` ranks what the peer CLAIMS. Soulseek file attributes are
 *   self-reported by whatever client shared the file. Nothing here is verified.
 *
 *   `checkTranscode()` cross-checks the claim against the one thing that cannot
 *   be faked — the byte count on the wire.
 *
 * Per RECON.md §4 the attributes arrive in two DISJOINT sets, so this is not one
 * check but three:
 *
 *   lossy    → bitrate is advertised, so compare implied against advertised.
 *              A contradiction. High confidence.
 *   lossless → no bitrate is advertised, so there is nothing to contradict.
 *              Compare implied against what `sampleRate × bitDepth × 2` would
 *              need uncompressed. An inference. Lower confidence, flagged quieter.
 *   neither  → no duration, or no attributes at all. NO CHECK IS POSSIBLE.
 *              This gets its own verdict and its own badge state, because for
 *              this user "unverifiable" rendered as "clean" is worse than useless.
 */

import type { Quality, TranscodeCheck } from './types.ts';
import { duration as fmtDuration, fileSize } from './format.ts';

const LOSSLESS_EXT = new Set(['flac', 'wav', 'wave', 'aiff', 'aif', 'alac', 'ape', 'wv', 'shn', 'dsf', 'dff']);

export interface AudioFacts {
  /** Derived from the filename — the wire's `ext` field is always null. */
  extension: string | null;
  size: number;
  bitrate: number | null;
  duration: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  vbr: boolean | null;
}

/* ----------------------------------------------------------------- ranking */

/**
 * Piecewise-linear map from effective kbps to a score, anchored on the ranking
 * the brief specifies: 320 CBR > V0 VBR > 256 > 192 > below.
 */
const LOSSY_CURVE: Array<[kbps: number, score: number]> = [
  [64, 12], [96, 22], [128, 33], [160, 45], [192, 55],
  [224, 62], [256, 68], [320, 80], [400, 84],
];

function lossyScore(kbps: number): number {
  if (kbps <= LOSSY_CURVE[0][0]) return LOSSY_CURVE[0][1] * (kbps / LOSSY_CURVE[0][0]);
  for (let i = 1; i < LOSSY_CURVE.length; i++) {
    const [x1, y1] = LOSSY_CURVE[i];
    const [x0, y0] = LOSSY_CURVE[i - 1];
    if (kbps <= x1) return y0 + ((kbps - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 86;
}

/**
 * VBR at a given average bitrate sounds better than CBR at the same number,
 * because the bits went where they were needed. Worth about 12%, capped so V0
 * (~245 avg) lands just below 320 CBR — the ordering the brief asks for.
 */
function effectiveKbps(kbps: number, vbr: boolean): number {
  return vbr ? Math.min(340, kbps * 1.12) : kbps;
}

/**
 * Format is decided by the FILENAME EXTENSION, not by the attributes, because
 * the wire carries no extension field and the attribute set is itself the
 * clue — a file with bitDepth is lossless, a file with bitrate is lossy.
 */
export function isLosslessFormat(f: Pick<AudioFacts, 'extension' | 'bitDepth'>): boolean {
  // `bitDepth !== null` IS the lossless signal on the wire. Upstream only sends
  // BIT_DEPTH for files it treats as lossless, and never sends it alongside a
  // bitrate — so it is a stronger signal than the extension, and it correctly
  // classifies misnamed or unusual extensions (including ALAC in `.m4a`).
  if (typeof f.bitDepth === 'number' && f.bitDepth > 0) return true;
  return LOSSLESS_EXT.has((f.extension ?? '').toLowerCase());
}

function vbrLabel(kbps: number): string | null {
  if (kbps >= 235 && kbps <= 275) return 'V0';
  if (kbps >= 210 && kbps < 235) return 'V1';
  if (kbps >= 175 && kbps < 210) return 'V2';
  return null;
}

export function classify(f: AudioFacts): Quality {
  const ext = (f.extension ?? '').toLowerCase();
  const label = ext ? ext.toUpperCase().replace(/^WAVE$/, 'WAV').replace(/^AIF$/, 'AIFF') : '?';

  if (isLosslessFormat(f)) {
    // Lossless files carry NO bitrate. Resolution comes from sampleRate/bitDepth
    // when the peer sent them, and is simply unknown when it didn't.
    const hiRes = (f.bitDepth ?? 0) >= 24 || (f.sampleRate ?? 0) > 48000;
    const spec = f.sampleRate && f.bitDepth
      ? `${f.sampleRate / 1000} kHz / ${f.bitDepth}-bit`
      : 'resolution not reported';
    return {
      tier: 'lossless',
      score: hiRes ? 98 : 95,
      label,
      description: `${label}, lossless, ${spec}`,
      lossless: true,
    };
  }

  if (f.bitrate && f.bitrate > 0) {
    const vbr = f.vbr === true;
    const eff = effectiveKbps(f.bitrate, vbr);
    const v = vbr ? vbrLabel(f.bitrate) : null;
    return {
      tier: eff >= 300 ? 'high' : eff >= 192 ? 'medium' : 'low',
      score: lossyScore(eff),
      label: v ?? String(Math.round(f.bitrate)),
      description:
        `${ext ? label + ', ' : ''}${Math.round(f.bitrate)} kbps ` +
        `${f.vbr === null ? '' : vbr ? 'variable' : 'constant'} bitrate, lossy`.replace(/\s+/g, ' '),
      lossless: false,
    };
  }

  // No bitrate and not a lossless extension. Do NOT infer a bitrate from the
  // size — that would manufacture a fact the peer never sent.
  return {
    tier: 'unknown',
    score: 30,
    label,
    description: ext
      ? `${label}, no bitrate reported by the peer`
      : 'Format and bitrate not reported by the peer',
    lossless: false,
  };
}

/* -------------------------------------------------------- the physics check */

/** Below this many seconds the size/bitrate relationship is too noisy to judge. */
const MIN_DURATION = 30;
/** Tag blocks and embedded artwork inflate a file; they never shrink it. */
const CBR_FLOOR = 0.85;
const VBR_FLOOR = 0.78;
/** A stereo lossless music encode does not compress below this share of PCM. */
const LOSSLESS_FLOOR = 0.30;
/** Absolute floor, kbps, when the peer did not report sample rate / bit depth. */
const LOSSLESS_ABS_FLOOR = 400;

function unchecked(reason: string): TranscodeCheck {
  return {
    verdict: 'unchecked',
    suspect: false,
    checked: false,
    impliedKbps: null,
    referenceKbps: null,
    ratio: null,
    confidence: 'none',
    headline: 'Not verified',
    explanation:
      `${reason}\n\nSeek verifies a file by comparing its size against the audio it ` +
      `claims to contain. That is not possible here, so this file is neither ` +
      `confirmed nor flagged — it is simply unknown.`,
  };
}

export function checkTranscode(f: AudioFacts): TranscodeCheck {
  if (!f.size || f.size <= 0) return unchecked('The peer reported no file size.');
  if (!f.duration || f.duration <= 0) {
    return unchecked('The peer reported no duration for this file.');
  }
  if (f.duration < MIN_DURATION) {
    return unchecked(
      `This file is only ${fmtDuration(f.duration)} long. Below ${MIN_DURATION} seconds the ` +
        `size-to-bitrate relationship is dominated by tags and headers, so a check would ` +
        `produce false alarms.`,
    );
  }

  const impliedKbps = (f.size * 8) / f.duration / 1000;

  /* ---- lossless: an inference, not a contradiction ---- */
  if (isLosslessFormat(f)) {
    const known = Boolean(f.sampleRate && f.bitDepth);
    const rate = f.sampleRate ?? 44100;
    const depth = f.bitDepth ?? 16;
    const pcmKbps = (rate * depth * 2) / 1000;
    const ratio = impliedKbps / pcmKbps;
    const fails = known ? ratio < LOSSLESS_FLOOR : impliedKbps < LOSSLESS_ABS_FLOOR;

    if (!fails) {
      return {
        verdict: 'ok',
        suspect: false,
        checked: true,
        impliedKbps,
        referenceKbps: pcmKbps,
        ratio,
        confidence: 'moderate',
        headline: 'Size is consistent with lossless',
        explanation:
          `${fileSize(f.size)} over ${fmtDuration(f.duration)} implies ` +
          `${Math.round(impliedKbps)} kbps, which is ${Math.round(ratio * 100)}% of the ` +
          `${Math.round(pcmKbps)} kbps this audio would need uncompressed. ` +
          `That is a normal lossless compression ratio.`,
      };
    }

    const assumed = known
      ? ''
      : `\n\nThe peer did not report sample rate or bit depth, so this compares against a ` +
        `plain CD-quality baseline (44.1 kHz / 16-bit stereo).`;

    return {
      verdict: 'inferred-transcode',
      suspect: true,
      checked: true,
      impliedKbps,
      referenceKbps: pcmKbps,
      ratio,
      // Inference, not contradiction: lossless files advertise no bitrate, so
      // there is no claim being refuted here. Flagged, but flagged quietly.
      confidence: 'moderate',
      headline: 'Too small to be lossless',
      explanation:
        `Shared as ${(f.extension ?? '').toUpperCase()}, but ${fileSize(f.size)} over ` +
        `${fmtDuration(f.duration)} implies only ${Math.round(impliedKbps)} kbps.\n\n` +
        `Uncompressed, ${rate / 1000} kHz / ${depth}-bit stereo needs ` +
        `${Math.round(pcmKbps)} kbps; lossless encoders typically reach 50–70% of that. ` +
        `This file is at ${Math.round(ratio * 100)}%.${assumed}\n\n` +
        `Most likely a lossy file re-encoded — or just renamed — into a lossless container. ` +
        `Note this is inferred from the compression ratio: lossless files carry no advertised ` +
        `bitrate, so there is no claim here to contradict outright.`,
    };
  }

  /* ---- lossy: a genuine contradiction ---- */
  const advertised = f.bitrate;
  if (!advertised || advertised <= 0) {
    return unchecked('The peer reported no bitrate for this file.');
  }
  if (advertised < 160) {
    return unchecked(
      `At ${Math.round(advertised)} kbps this file is already below the quality threshold ` +
        `where a transcode check tells you anything useful.`,
    );
  }

  const ratio = impliedKbps / advertised;
  const floor = f.vbr === true ? VBR_FLOOR : CBR_FLOOR;

  if (ratio >= floor) {
    return {
      verdict: 'ok',
      suspect: false,
      checked: true,
      impliedKbps,
      referenceKbps: advertised,
      ratio,
      confidence: 'high',
      headline: 'Size matches the advertised bitrate',
      explanation:
        `Advertised ${Math.round(advertised)} kbps × ${fmtDuration(f.duration)} needs about ` +
        `${fileSize((advertised * 1000 * f.duration) / 8)}. This file is ${fileSize(f.size)}, ` +
        `implying ${Math.round(impliedKbps)} kbps. The claim holds.`,
    };
  }

  return {
    verdict: 'contradicted',
    suspect: true,
    checked: true,
    impliedKbps,
    referenceKbps: advertised,
    ratio,
    confidence: 'high',
    headline: `Advertised ${Math.round(advertised)} kbps, size implies ${Math.round(impliedKbps)}`,
    explanation:
      `Advertised ${Math.round(advertised)} kbps${f.vbr === true ? ' (variable)' : ''} × ` +
      `${fmtDuration(f.duration)} needs about ${fileSize((advertised * 1000 * f.duration) / 8)}.\n\n` +
      `This file is ${fileSize(f.size)}, which implies ${Math.round(impliedKbps)} kbps — ` +
      `${Math.round((1 - ratio) * 100)}% under its own claim.\n\n` +
      `A file cannot hold more audio than its bytes allow, so the ` +
      `${Math.round(advertised)} kbps label was probably inherited from an upscale of a ` +
      `lower-bitrate source.`,
  };
}

/** Order used for "best quality present" comparisons. */
export const TIER_RANK: Record<Quality['tier'], number> = {
  lossless: 4, high: 3, medium: 2, low: 1, unknown: 0,
};

export function bestTier(a: Quality['tier'], b: Quality['tier']): Quality['tier'] {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}
