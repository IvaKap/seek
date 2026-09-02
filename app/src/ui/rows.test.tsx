// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * FileRow — the classic flat-list leaf.
 *
 * It is a clone of TrackRow/SourceRow, and the thing that regresses in a clone
 * is the cell wiring: a `col=` typo or a dropped cell breaks the shared column
 * grid silently (jsdom has no layout, so alignment itself can't be asserted, but
 * the presence and `data-col` of each cell can). This also pins that the flat
 * list carries the two columns a grouped view gets from its card — the peer and
 * the folder — because in a flat list nothing above the row says either.
 */

import { StrictMode, act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileRow, QueueButton } from './rows.tsx';
import { adaptSearchResult } from '../data/adapt.ts';
import type { WireSearchResultData } from '../data/adapt.ts';
import type { SourceFile } from '../domain/types.ts';

afterEach(cleanup);

function source(): SourceFile {
  const wire: WireSearchResultData = {
    searchId: 1,
    peer: { username: 'sublow', freeSlots: true, advertisedSpeed: 800_000, queueLength: 3 },
    files: [{
      path: 'music\\Burial - Untrue (2007) [FLAC]\\02 Burial - Archangel.flac',
      size: 48_200_000, bitrate: null, duration: 372,
      sampleRate: 44_100, bitDepth: 16, isVbr: null,
    }],
  };
  return adaptSearchResult(wire, 0, () => 0.5)[0];
}

const cell = (col: string) => document.querySelector(`.meta__cell[data-col="${col}"]`);

describe('FileRow', () => {
  it('renders the parsed title and the format badge', () => {
    const s = source();
    render(<StrictMode><FileRow source={s} onQueue={() => {}} /></StrictMode>);

    expect(screen.getByText(s.parsed.displayTitle)).toBeTruthy();
    expect(screen.getByText(s.quality.label)).toBeTruthy();
  });

  it('carries the peer and the folder, which a grouped view gets from its card', () => {
    const s = source();
    render(<StrictMode><FileRow source={s} onQueue={() => {}} /></StrictMode>);

    const user = cell('user');
    const folder = cell('folder');
    expect(user?.textContent).toContain('sublow');
    // The folder SEGMENT (not the whole path), with the full path in the title.
    expect(folder?.textContent).toBe(s.parsed.folder);
    expect(folder?.getAttribute('title')).toBe(s.parsed.folderPath);
  });

  it('queues from the download action', () => {
    const s = source();
    const onQueue = vi.fn();
    render(<StrictMode><FileRow source={s} onQueue={onQueue} /></StrictMode>);

    fireEvent.pointerDown(screen.getByLabelText(/^Queue /), { button: 0 });
    expect(onQueue).toHaveBeenCalledTimes(1);
  });
});

describe('QueueButton — Get that reports state', () => {
  const btn = () => document.querySelector('.qbtn') as HTMLButtonElement;

  it('idle shows a Queue label and queues on press', () => {
    const onQueue = vi.fn();
    render(<StrictMode><QueueButton badge="idle" onQueue={onQueue} label="Archangel" /></StrictMode>);
    expect(btn().getAttribute('data-q')).toBe('idle');
    expect(btn().getAttribute('title')).toBe('Queue Archangel');

    act(() => { fireEvent.pointerDown(btn()); });
    expect(onQueue).toHaveBeenCalledTimes(1);
    // Optimistic: the store has not ticked yet, but the button already reports it.
    expect(btn().getAttribute('data-q')).toBe('queued');
  });

  it('follows the store once it reflects a real state', () => {
    const { rerender } = render(
      <StrictMode><QueueButton badge="downloading" onQueue={() => {}} label="x" /></StrictMode>,
    );
    expect(btn().getAttribute('data-q')).toBe('downloading');
    expect(btn().getAttribute('title')).toBe('Downloading…');

    rerender(<StrictMode><QueueButton badge="done" onQueue={() => {}} label="x" /></StrictMode>);
    expect(btn().getAttribute('data-q')).toBe('done');
  });

  it('a second press while working does not double-queue', () => {
    const onQueue = vi.fn();
    render(<StrictMode><QueueButton badge="downloading" onQueue={onQueue} label="x" /></StrictMode>);
    act(() => { fireEvent.pointerDown(btn()); });
    act(() => { fireEvent.pointerDown(btn()); });
    expect(onQueue).not.toHaveBeenCalled();
  });

  it('a failed download re-queues on press', () => {
    const onQueue = vi.fn();
    render(<StrictMode><QueueButton badge="failed" onQueue={onQueue} label="x" /></StrictMode>);
    expect(btn().getAttribute('title')).toMatch(/failed/i);
    act(() => { fireEvent.pointerDown(btn()); });
    expect(onQueue).toHaveBeenCalledTimes(1);
  });
});
