/*
 * Seek — the spectrum, drawn.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A verdict you cannot check is a rumour. This is the evidence behind the
 * assessment: energy against frequency, with the detected lowpass marked and
 * the ceiling the file's own sample rate allows drawn alongside it.
 *
 * BOTH PICTURES, deliberately. This curve is the averaged spectrum — one dB
 * value per frequency bin — and `Heatmap.tsx` below it is the Spek-style time x
 * frequency view. They are not redundant: an encoder's lowpass is a decisive
 * vertical cliff in the average and only a faint edge in a heatmap, while the
 * heatmap is the only one that shows whether a dark ceiling holds across the
 * whole track or is just a quiet passage. Reading them together is what
 * separates a vinyl rip's gentle rolloff from a transcode.
 *
 * Drawn as inline SVG with no chart library: it is one polyline, two rules and
 * a handful of ticks.
 */

import { useId } from 'react';
import type { SpectralAnalysis } from '../data/analysisStore.ts';
import { ASSESSMENT_LABEL, ASSESSMENT_TONE, explain } from '../data/analysisStore.ts';
import { Heatmap } from './Heatmap.tsx';

const W = 560;
const H = 180;
const PAD_L = 34;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 22;

const DB_FLOOR = -110;
const DB_CEIL = 0;

export function Spectrum({ a }: { a: SpectralAnalysis }) {
  const clipId = useId();
  const maxHz = a.nyquistHz || 22050;

  const x = (hz: number) => PAD_L + (hz / maxHz) * (W - PAD_L - PAD_R);
  const y = (db: number) => {
    const clamped = Math.max(DB_FLOOR, Math.min(DB_CEIL, db));
    return PAD_T + ((DB_CEIL - clamped) / (DB_CEIL - DB_FLOOR)) * (H - PAD_T - PAD_B);
  };

  const n = Math.min(a.spectrumHz.length, a.spectrumDb.length);
  const points: string[] = [];
  for (let i = 0; i < n; i++) points.push(`${x(a.spectrumHz[i]).toFixed(1)},${y(a.spectrumDb[i]).toFixed(1)}`);

  // Ticks every 2 kHz up to Nyquist, labelled every 4 to keep it quiet.
  const ticks: number[] = [];
  for (let hz = 0; hz <= maxHz; hz += 2000) ticks.push(hz);

  const tone = ASSESSMENT_TONE[a.assessment];

  return (
    <figure className="spec" data-tone={tone}>
      <figcaption className="spec__cap">
        <span className="spec__verdict" data-tone={tone}>{ASSESSMENT_LABEL[a.assessment]}</span>
        <span className="spec__conf tnum">{Math.round(a.confidence * 100)}% confidence</span>
        <span className="spec__meta tnum">
          {(a.sampleRate / 1000).toFixed(1)} kHz · {a.channels === 1 ? 'mono' : 'stereo'} ·{' '}
          {a.windowCount} windows over {a.analysedSeconds.toFixed(0)}s · {a.decodedWith}
        </span>
      </figcaption>

      <svg
        className="spec__svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Frequency spectrum. ${ASSESSMENT_LABEL[a.assessment]}. ${explain(a)}`}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD_L} y={PAD_T} width={W - PAD_L - PAD_R} height={H - PAD_T - PAD_B} />
          </clipPath>
        </defs>

        {/* dB grid */}
        {[0, -20, -40, -60, -80, -100].map((db) => (
          <g key={db}>
            <line x1={PAD_L} y1={y(db)} x2={W - PAD_R} y2={y(db)} className="spec__grid" />
            <text x={PAD_L - 5} y={y(db) + 3} className="spec__axis" textAnchor="end">{db}</text>
          </g>
        ))}

        {/* frequency ticks */}
        {ticks.map((hz) => (
          <g key={hz}>
            <line x1={x(hz)} y1={H - PAD_B} x2={x(hz)} y2={H - PAD_B + 3} className="spec__grid" />
            {hz % 4000 === 0 && (
              <text x={x(hz)} y={H - PAD_B + 14} className="spec__axis" textAnchor="middle">
                {hz / 1000}k
              </text>
            )}
          </g>
        ))}

        {/* The curve. */}
        <polyline points={points.join(' ')} className="spec__line" clipPath={`url(#${clipId})`} />

        {/* The detected lowpass — the whole point of the picture. */}
        {a.cutoffHz !== null && (
          <g>
            <line
              x1={x(a.cutoffHz)} y1={PAD_T} x2={x(a.cutoffHz)} y2={H - PAD_B}
              className="spec__cut"
            />
            <text
              x={Math.min(x(a.cutoffHz) + 4, W - PAD_R - 42)}
              y={PAD_T + 10}
              className="spec__cutlabel"
            >
              {(a.cutoffHz / 1000).toFixed(1)} kHz
            </text>
          </g>
        )}

        {/* What the sample rate would have allowed. */}
        <line
          x1={x(maxHz)} y1={PAD_T} x2={x(maxHz)} y2={H - PAD_B}
          className="spec__nyq"
        />
      </svg>

      <Heatmap a={a} />

      <p className="spec__explain">{explain(a)}</p>
      {a.impliedSourceKbps !== null && (
        <p className="spec__implied">
          A lowpass there is typical of a source around{' '}
          <span className="tnum">{a.impliedSourceKbps}</span> kbps.
        </p>
      )}
    </figure>
  );
}
