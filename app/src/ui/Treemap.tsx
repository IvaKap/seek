/*
 * Seek — a peer's collection as area.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A 340 GB share is 95 releases and nine thousand files. As a scrolling list
 * that is a wall; as area it is a shape you can read in a second — what they
 * mostly have, what the big rips are, whether it is a FLAC library with some
 * MP3s or the other way round.
 *
 * Squarified treemap (Bruls, Huizing, van Wijk): lay out along the shorter side
 * and keep aspect ratios near 1, because long thin slivers are unclickable and
 * unreadable. Plain rectangles, no gradients, no 3D — this is a map, not a
 * dashboard tile.
 */

import { useMemo, useState } from 'react';
import type { Shelf } from '../data/browseStore.ts';
import { fileSize } from '../domain/format.ts';

interface Cell { shelf: Shelf; x: number; y: number; w: number; h: number }

const W = 1000;
const H = 620;

/** Squarified layout. Areas are already normalised to W*H by the caller. */
function squarify(items: Array<{ shelf: Shelf; area: number }>, x: number, y: number, w: number, h: number, out: Cell[]): void {
  if (items.length === 0) return;
  if (items.length === 1) {
    out.push({ shelf: items[0].shelf, x, y, w, h });
    return;
  }

  const total = items.reduce((n, i) => n + i.area, 0);
  // Split so the first group fills roughly its share of the shorter side.
  let acc = 0;
  let split = 0;
  const half = total / 2;
  while (split < items.length - 1 && acc + items[split].area <= half) {
    acc += items[split].area;
    split += 1;
  }

  const head = items.slice(0, split || 1);
  const tail = items.slice(split || 1);
  const headArea = head.reduce((n, i) => n + i.area, 0);
  const frac = total > 0 ? headArea / total : 0.5;

  if (w >= h) {
    const cut = w * frac;
    squarify(head, x, y, cut, h, out);
    squarify(tail, x + cut, y, w - cut, h, out);
  } else {
    const cut = h * frac;
    squarify(head, x, y, w, cut, out);
    squarify(tail, x, y + cut, w, h - cut, out);
  }
}

/** Format families get distinct hues; everything else is neutral. */
function tone(shelf: Shelf): string {
  const f = shelf.formats[0] ?? '';
  if (f === 'FLAC' || f === 'WAV' || f === 'AIFF' || f === 'AIF' || f === 'ALAC') return 'lossless';
  if (f === 'MP3' || f === 'AAC' || f === 'M4A' || f === 'OGG' || f === 'OPUS') return 'lossy';
  return 'other';
}

export function Treemap({
  shelves, onOpen, onGet,
}: {
  shelves: Shelf[];
  onOpen(shelf: Shelf): void;
  onGet(shelf: Shelf): void;
}) {
  const [hover, setHover] = useState<Shelf | null>(null);

  const cells = useMemo(() => {
    const sorted = [...shelves].filter((s) => s.size > 0).sort((a, b) => b.size - a.size);
    const total = sorted.reduce((n, s) => n + s.size, 0);
    if (total === 0) return [];
    const scaled = sorted.map((s) => ({ shelf: s, area: (s.size / total) * W * H }));
    const out: Cell[] = [];
    squarify(scaled, 0, 0, W, H, out);
    return out;
  }, [shelves]);

  if (cells.length === 0) {
    return <p className="settings__hint">Nothing to map.</p>;
  }

  return (
    <div className="tmap">
      <svg viewBox={`0 0 ${W} ${H}`} className="tmap__svg" role="group" aria-label="Collection by size">
        {cells.map((c) => {
          // Only label cells with room for it — a truncated word in a sliver is
          // noise, and the tooltip carries the detail anyway.
          const roomy = c.w > 90 && c.h > 34;
          return (
            <g
              key={c.shelf.path}
              className="tmap__cell"
              data-tone={tone(c.shelf)}
              data-hover={hover?.path === c.shelf.path ? 'true' : undefined}
              onPointerEnter={() => setHover(c.shelf)}
              onPointerLeave={() => setHover((h) => (h?.path === c.shelf.path ? null : h))}
              onPointerDown={(e) => {
                if (e.altKey) onGet(c.shelf);
                else onOpen(c.shelf);
              }}
              role="button"
              tabIndex={0}
              aria-label={`${c.shelf.name}, ${fileSize(c.shelf.size)}, ${c.shelf.files.length} tracks`}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(c.shelf); }}
            >
              <rect x={c.x} y={c.y} width={c.w} height={c.h} className="tmap__rect" />
              {roomy && (
                <>
                  <text x={c.x + 8} y={c.y + 18} className="tmap__label">
                    {c.shelf.artist ?? c.shelf.name}
                  </text>
                  <text x={c.x + 8} y={c.y + 32} className="tmap__sub">
                    {fileSize(c.shelf.size)} · {c.shelf.formats[0] ?? ''}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>

      <div className="tmap__legend">
        <span className="tmap__key" data-tone="lossless">Lossless</span>
        <span className="tmap__key" data-tone="lossy">Lossy</span>
        <span className="tmap__key" data-tone="other">Other</span>
        <span className="tmap__hint">
          {hover
            ? `${hover.name} — ${hover.files.length} tracks, ${fileSize(hover.size)}`
            : 'Area is size on disk. Click to open, ⌥-click to queue the folder.'}
        </span>
      </div>
    </div>
  );
}
