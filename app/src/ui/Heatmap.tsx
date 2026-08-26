/*
 * Seek — the Spek-style spectrogram.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Time across, frequency up, loudness as colour. This sits ALONGSIDE the
 * averaged curve rather than replacing it, because they answer different
 * questions:
 *
 *   curve   — is there an encoder lowpass? A cliff in the average is decisive.
 *   heatmap — where in the track does energy sit, and does the ceiling hold?
 *
 * That second question separates a genuinely quiet passage (a vertical dark
 * stripe) from a lowpassed file (a horizontal dark band across the whole
 * width). The curve alone cannot tell those apart.
 *
 * Rendered to a canvas, not SVG: the grid is thousands of cells and that many
 * DOM nodes is real cost for a picture nothing needs to hit-test.
 */

import { useEffect, useRef } from 'react';
import type { SpectralAnalysis } from '../data/analysisStore.ts';

const DB_FLOOR = -90;
const DB_CEIL = 0;

/**
 * Spek's palette, near enough: black → indigo → blue → cyan → green → yellow →
 * orange → red → white. It is monotonic in lightness, which is what makes the
 * gradient readable, and the warm top end is what makes a loud band obvious at
 * a glance rather than something you have to hunt for.
 */
const STOPS: Array<[number, [number, number, number]]> = [
  [0.00, [0, 0, 0]],
  [0.13, [26, 8, 66]],
  [0.26, [42, 22, 148]],
  [0.39, [22, 96, 190]],
  [0.52, [16, 168, 176]],
  [0.64, [42, 196, 84]],
  [0.76, [190, 214, 34]],
  [0.86, [250, 190, 24]],
  [0.94, [232, 92, 26]],
  [1.00, [252, 252, 252]],
];

function colour(t: number): [number, number, number] {
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const k = (t - t0) / (t1 - t0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/**
 * Ticks scaled to the actual Nyquist. Hardcoding 5–22 kHz was wrong: a 192 kHz
 * file has a 96 kHz ceiling, so every label landed in the bottom fifth of the
 * axis on top of its neighbours. Pick a round step that yields ~6 divisions.
 */
function freqTicks(nyquistKhz: number): number[] {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100];
  const target = nyquistKhz / 6;
  const step = steps.find((s) => s >= target) ?? steps[steps.length - 1];
  const out: number[] = [];
  for (let k = step; k < nyquistKhz - step * 0.35; k += step) out.push(k);
  return out;
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s === 60 ? 0 : s).padStart(2, '0')}`;
}

export function Heatmap({ a }: { a: SpectralAnalysis }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cols = a.heatmapTimeBins;
  const rows = a.heatmapFreqBins;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || cols === 0 || rows === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = cols;
    canvas.height = rows;

    const img = ctx.createImageData(cols, rows);
    for (let f = 0; f < rows; f++) {
      for (let t = 0; t < cols; t++) {
        const db = a.heatmapDb[f * cols + t] ?? DB_FLOOR;
        const norm = Math.max(0, Math.min(1, (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)));
        const [r, g, b] = colour(norm);
        // Canvas y grows downward; frequency grows upward.
        const px = ((rows - 1 - f) * cols + t) * 4;
        img.data[px] = r;
        img.data[px + 1] = g;
        img.data[px + 2] = b;
        img.data[px + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [a, cols, rows]);

  if (cols === 0 || rows === 0) return null;

  const nyqKhz = a.nyquistHz / 1000;
  const ticks = freqTicks(nyqKhz);
  const duration = a.durationSeconds || 0;
  // Quarters: enough to locate yourself in the track, few enough to stay quiet.
  const timeMarks = [0, 0.25, 0.5, 0.75, 1];
  const dbMarks = [0, -20, -40, -60, -80];

  // The colour bar is the legend: it maps the picture's colours to dB directly,
  // so the scale needs no separate explanation.
  const barStops = STOPS.map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${t * 100}%`).join(', ');

  return (
    <div className="heat">
      <div className="heat__layout">
        <div className="heat__yaxis" aria-hidden>
          {ticks.map((k) => (
            <span key={k} className="heat__tick tnum" style={{ bottom: `${(k / nyqKhz) * 100}%` }}>
              {k >= 1000 ? `${k / 1000}M` : `${k}k`}
            </span>
          ))}
        </div>

        <div className="heat__frame">
          <canvas
            ref={ref}
            className="heat__canvas"
            role="img"
            aria-label={`Spectrogram. Time across ${clock(duration)}, frequency to ${nyqKhz.toFixed(1)} kilohertz.`}
          />
          {a.cutoffHz !== null && (
            <div
              className="heat__cut"
              style={{ bottom: `${(a.cutoffHz / a.nyquistHz) * 100}%` }}
            >
              <span className="heat__cutlabel tnum">{(a.cutoffHz / 1000).toFixed(1)} kHz</span>
            </div>
          )}
        </div>

        <div className="heat__scale" aria-hidden>
          <div className="heat__bar" style={{ background: `linear-gradient(to top, ${barStops})` }} />
          <div className="heat__dbs">
            {dbMarks.map((db) => (
              <span
                key={db}
                className="heat__db tnum"
                style={{ bottom: `${((db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)) * 100}%` }}
              >
                {db}
              </span>
            ))}
          </div>
        </div>

        <div className="heat__xaxis" aria-hidden>
          {timeMarks.map((p) => (
            <span key={p} className="heat__time tnum" style={{ left: `${p * 100}%` }}>
              {clock(duration * p)}
            </span>
          ))}
        </div>
      </div>

      <p className="heat__cap">
        Time across, frequency up, loudness as colour (dB at right). A horizontal
        dark band the whole way across is an encoder ceiling; a vertical dark
        stripe is just a quiet passage.
      </p>
    </div>
  );
}
