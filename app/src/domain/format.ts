/*
 * Seek — display formatting. The Python side formats nothing; this is where all
 * of it lives.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Every function here returns a string destined for a `tabular-nums` context,
 * so widths are chosen to be stable: a value must not change character count
 * while it ticks. `1.2 MB/s` → `12.4 MB/s` is one extra glyph and that is fine;
 * `999 KB/s` → `1.0 MB/s` is not, so units switch on fixed thresholds and
 * decimals are fixed per unit, never "significant figures".
 */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/**
 * "2 hours ago" — a notebook needs recency, not a timestamp.
 *
 * Lived in `WantListView` until the label watchlist needed the same wording.
 * Two copies of this would drift, and a want list saying "8 days ago" beside a
 * watchlist saying "1 week ago" for the same moment reads as a bug.
 *
 * Takes epoch SECONDS, which is what the sidecar stores throughout.
 */
export function since(epochSeconds: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.round(days / 30);
  return `${months} ${months === 1 ? 'month' : 'months'} ago`;
}

/** Bytes → `48.2 MB`. One decimal below 100, none above, so width is stable. */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(0)} KB`;
  if (bytes < GB) {
    const v = bytes / MB;
    return `${v < 100 ? v.toFixed(1) : v.toFixed(0)} MB`;
  }
  return `${(bytes / GB).toFixed(2)} GB`;
}

/** Bytes/sec → `2.4 MB/s`. */
export function speed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  if (bytesPerSec < KB) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < MB) return `${(bytesPerSec / KB).toFixed(0)} KB/s`;
  return `${(bytesPerSec / MB).toFixed(1)} MB/s`;
}

/** Seconds → `6:12`, or `1:04:30` past an hour. */
export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** `44.1/16` — the compact sample-rate/bit-depth pair from the brief's row spec. */
export function audioSpec(sampleRate: number | null, bitDepth: number | null): string | null {
  if (!sampleRate) return null;
  const khz = sampleRate / 1000;
  const rate = Number.isInteger(khz) ? String(khz) : khz.toFixed(1);
  return bitDepth ? `${rate}/${bitDepth}` : `${rate} kHz`;
}

export function bitrate(kbps: number | null, vbr: boolean): string {
  if (!kbps) return '—';
  return `${Math.round(kbps)}${vbr ? ' VBR' : ''}`;
}

/** `0 queued` / `1 queued` / `40 queued`. */
export function queued(n: number): string {
  return `${n} queued`;
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Integers with thin separators, for the result count. */
export function integer(n: number): string {
  return n.toLocaleString('en-US');
}
