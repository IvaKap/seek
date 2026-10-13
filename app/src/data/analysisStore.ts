/*
 * Seek — post-download spectral verification.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * docs/PRODUCT.md §6, and the reason this exists at all: RECON.md §4 proved the
 * search-time metadata check CANNOT run on lossless files, because the protocol
 * sends no bitrate for FLAC/WAV/AIFF — there is no claim to contradict. So the
 * one format the target user cares most about had no transcode check at all.
 *
 * Spectral analysis closes that gap, and it needs no cooperation from the
 * uploader's metadata. But it needs the actual bytes, so it is strictly
 * POST-download.
 *
 * The two checks are deliberately NOT merged:
 *
 *   search time  -> a PREDICTION, from metadata arithmetic, always provisional
 *   post download -> a FINDING, from the audio itself
 *
 * A file that passed the prediction and fails the finding is the moment this
 * app earns its keep, so the UI must be able to tell them apart.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lostInTransit } from './sidecarClient.ts';
import type { SidecarClient } from './sidecarClient.ts';

type SpectralAssessment =
  | 'likely_lossless'
  | 'possible_transcode'
  | 'strong_signs_of_lossy_source'
  | 'inconclusive';

export interface SpectralAnalysis {
  requestId: string;
  path: string;
  transferId: string | null;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  decodedWith: string;
  nyquistHz: number;
  cutoffHz: number | null;
  shelfDropDb: number | null;
  shelfWidthHz: number | null;
  confidence: number;
  assessment: SpectralAssessment;
  declaredLossless: boolean;
  /** Best-guess source bitrate implied by where the lowpass sits. */
  impliedSourceKbps: number | null;
  /* The averaged spectrum, emitted by the sidecar and rendered as the chart.
   * Note this is frequency -> dB averaged over the analysed window, NOT a
   * time x frequency heatmap like Spek's. For deciding whether an encoder
   * lowpass exists the averaged curve is the sharper instrument: a cliff that
   * would be a faint edge in a heatmap is unmistakable here. */
  spectrumHz: number[];
  spectrumDb: number[];
  /* The Spek-style picture, flattened freq-major: index = f * heatmapTimeBins
   * + t, low frequency first, dB peak-normalised to 0. Empty when rendering
   * failed — the verdict never depends on it. */
  heatmapDb: number[];
  heatmapTimeBins: number;
  heatmapFreqBins: number;
  fftSize: number;
  windowCount: number;
  analysedSeconds: number;
}

interface AnalysisEntry {
  state: 'running' | 'done' | 'failed';
  result?: SpectralAnalysis;
  reason?: string;
}

/** Human wording. Never definitive — see the enum's own note in the schema. */
export const ASSESSMENT_LABEL: Record<SpectralAssessment, string> = {
  likely_lossless: 'Likely lossless',
  possible_transcode: 'Possible transcode',
  strong_signs_of_lossy_source: 'Strong signs of a lossy source',
  inconclusive: 'Inconclusive',
};

export const ASSESSMENT_TONE: Record<SpectralAssessment, 'good' | 'warn' | 'bad' | 'unknown'> = {
  likely_lossless: 'good',
  possible_transcode: 'warn',
  strong_signs_of_lossy_source: 'bad',
  inconclusive: 'unknown',
};

/** Explain the arithmetic, because a verdict the user cannot check is a rumour. */
export function explain(a: SpectralAnalysis): string {
  const nyq = `${(a.nyquistHz / 1000).toFixed(1)} kHz`;
  if (a.cutoffHz === null) {
    return `No lowpass shelf found below ${nyq}. Content reaches the ceiling the `
      + `sample rate allows, which is what an untouched ${a.declaredLossless ? 'lossless' : ''} `
      + 'file looks like. Quiet or sparse music can also lack high content, so this is not proof.';
  }
  const cut = `${(a.cutoffHz / 1000).toFixed(1)} kHz`;
  const drop = a.shelfDropDb !== null ? `${Math.round(a.shelfDropDb)} dB` : 'a sharp';
  return `Energy falls away by ${drop} at ${cut}, well below the ${nyq} this file's `
    + 'sample rate allows. Lossy encoders discard everything above a cutoff, and a '
    + `shelf that abrupt is characteristic of one. ${a.declaredLossless
      ? 'This file is declared lossless, so the source was probably lossy before it was re-encoded.'
      : 'For a lossy file this is expected and not a fault.'}`;
}

export interface AnalysisSession {
  /** Keyed by transfer id, so the downloads view need not assemble paths. */
  byTransfer: Map<string, AnalysisEntry>;
  analyseTransfer(transferId: string): void;
}

export function useAnalysis(client: SidecarClient | null): AnalysisSession {
  const [byTransfer, setByTransfer] = useState<Map<string, AnalysisEntry>>(() => new Map());
  /** requestId -> transferId, so a failure lands on the right file. */
  const pending = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!client) return;

    const offResult = client.on('analysis.result', (data) => {
      const a = data as SpectralAnalysis;
      const waiting = pending.current.get(a.requestId);
      pending.current.delete(a.requestId);
      const tid = a.transferId ?? waiting ?? null;
      if (tid) setByTransfer((prev) => new Map(prev).set(tid, { state: 'done', result: a }));
    });

    const offFailed = client.on('analysis.failed', (data) => {
      const f = data as { requestId: string; reason: string };
      const waiting = pending.current.get(f.requestId);
      pending.current.delete(f.requestId);
      if (waiting) setByTransfer((prev) => new Map(prev).set(waiting, { state: 'failed', reason: f.reason }));
    });

    return () => { offResult(); offFailed(); };
  }, [client]);

  const analyseTransfer = useCallback((transferId: string) => {
    if (!client) return;
    // Mark running immediately so the button cannot be pressed twice — a second
    // decode of the same file costs real CPU for an answer we already asked for.
    setByTransfer((prev) => (prev.get(transferId)?.state === 'running'
      ? prev : new Map(prev).set(transferId, { state: 'running' })));
    // The sidecar's schema requires both keys; only the transfer form is used.
    void client.request<{ requestId: string }>('analysis.spectral', { path: null, transferId })
      .then((r) => pending.current.set(r.requestId, transferId))
      .catch((e: Error) => {
        /* Never answered (a dropped connection): put the button back rather
           than a "could not analyse" that stays for the session. */
        setByTransfer((prev) => {
          const next = new Map(prev);
          if (lostInTransit(e)) next.delete(transferId);
          else next.set(transferId, { state: 'failed', reason: e.message });
          return next;
        });
      });
  }, [client]);

  // Memoised: every Downloads row reads this, and a fresh object per render
  // made each of them redraw on every tick.
  return useMemo(() => ({ byTransfer, analyseTransfer }), [byTransfer, analyseTransfer]);
}
