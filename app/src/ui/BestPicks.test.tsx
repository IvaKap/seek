// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The best-pick cards: Get takes the copy named on the card, the button says
 * who it is asking until the peer answers, and a card holds still under the
 * pointer while better copies stream in. Collector's chips are the same picks
 * on one line, and each chip is the Get.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BestPicks } from './BestPicks.tsx';
import { adaptSearchResult } from '../data/adapt.ts';
import type { WireFileRef, WireSearchResultData } from '../data/adapt.ts';
import { buildQueueMaps, group } from '../data/transferStore.ts';
import type { Transfer } from '../data/transferStore.ts';
import { createGrouper } from '../domain/group.ts';
import type { PickPool } from '../domain/bestPicks.ts';

afterEach(cleanup);

const UNTRUE = 'Music\\Burial - Untrue (2007)';
const RULES = { preferLossless: false, minBitrate: 0, rejectTranscodes: false };
const flac = (path: string): WireFileRef => ({
  path, size: 28_400_000, bitrate: null, duration: 238, sampleRate: 44_100, bitDepth: 16, isVbr: null,
});

function answer(username: string, files: WireFileRef[], speed = 1_000_000): WireSearchResultData {
  return {
    searchId: 1,
    peer: { username, freeSlots: true, advertisedSpeed: speed, queueLength: 0, files: 10, folders: 1, country: null },
    files,
  };
}

function pool(...answers: WireSearchResultData[]): PickPool {
  const g = createGrouper();
  answers.forEach((a, i) => adaptSearchResult(a, i + 1, () => 0.5).forEach((s) => g.add(s)));
  return { tracks: g.tracks(g.all), releases: g.releases(g.all) };
}

const dave = answer('dave', [flac(`${UNTRUE}\\02 Archangel.flac`), flac(`${UNTRUE}\\03 Near Dark.flac`)], 2_400_000);
const ARCHANGEL = `${UNTRUE}\\02 Archangel.flac`;

function transfer(over: Partial<Transfer>): Transfer {
  return {
    id: 't1', direction: 'download', username: 'dave', path: ARCHANGEL, localFolder: null,
    size: 28_400_000, bytesDone: 0, state: 'queued', speed: 0, averageSpeed: 0, queuePosition: null,
    secondsLeft: null, secondsElapsed: 0, stalled: false, secondsSinceProgress: 0, finishedAt: null,
    error: null, ...over,
  };
}

function picks(p: PickPool, all: Transfer[] = [], onQueue = vi.fn()) {
  const { files, folders } = buildQueueMaps(all);
  const props = { rules: RULES, queueStates: files, folderStates: folders, onQueue };
  const ui = (next: PickPool) => (
    <StrictMode>
      <BestPicks {...props} pool={next} transfers={{ all, groups: group(all) }} />
    </StrictMode>
  );
  const view = render(ui(p));
  return { onQueue, rerender: (next: PickPool) => view.rerender(ui(next)) };
}

const card = (kind: string) => screen.getByText(kind).closest('article') as HTMLElement;
const getIn = (el: HTMLElement) => el.querySelector('button.pick__get') as HTMLButtonElement;

describe('what a card offers', () => {
  it('names the copy, and Get takes exactly that one', () => {
    const { onQueue } = picks(pool(dave));
    const overall = card('Best overall');
    expect(overall.textContent).toContain('Archangel');
    expect(overall.textContent).toContain('dave · slot free');

    fireEvent.click(getIn(overall));
    expect(onQueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'file', source: expect.objectContaining({ user: 'dave', path: ARCHANGEL }),
    }));
  });

  it('a whole release says how many tracks Get takes, and queues the folder', () => {
    const { onQueue } = picks(pool(dave));
    const release = card('Whole release');
    expect(getIn(release).textContent).toBe('Get all 2');
    fireEvent.click(getIn(release));
    expect(onQueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'release' }));
  });

  it('nothing to offer, nothing on screen', () => {
    const { container } = render(
      <BestPicks pool={pool()} rules={RULES} transfers={{ all: [], groups: [] }}
        queueStates={new Map()} folderStates={new Map()} onQueue={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('what Get says', () => {
  it('who it is asking, from the press until the peer answers', () => {
    picks(pool(dave));
    fireEvent.click(getIn(card('Best overall')));
    expect(getIn(card('Best overall')).textContent).toBe('Asking dave…');
  });

  it('the place in line once the peer has given one', () => {
    picks(pool(dave), [transfer({ queuePosition: 3 })]);
    expect(getIn(card('Best overall')).textContent).toBe('Queued · 3rd in line');
  });

  it('that it is starting, and where a finished file went', () => {
    picks(pool(dave), [transfer({ state: 'getting_status' })]);
    expect(getIn(card('Best overall')).textContent).toBe('Starting…');
    cleanup();
    picks(pool(dave), [transfer({ state: 'finished', finishedAt: 1 })]);
    expect(getIn(card('Best overall')).textContent).toBe('In Completed');
  });
});

describe('a card under the pointer', () => {
  const faster = answer('faster', [flac(`${UNTRUE}\\02 Archangel.flac`)], 9_000_000);

  it('keeps its copy while a better one arrives, and moves on once you leave', () => {
    const { rerender } = picks(pool(dave));
    const section = screen.getByRole('region', { name: 'Best picks' });

    fireEvent.pointerEnter(section);
    rerender(pool(dave, faster));
    expect(card('Best overall').textContent).toContain('dave');

    fireEvent.pointerLeave(section);
    expect(card('Best overall').textContent).toContain('faster');
  });

  it('keeps a copy you pressed Get on after the pointer has gone', () => {
    const { rerender } = picks(pool(dave));
    const section = screen.getByRole('region', { name: 'Best picks' });
    fireEvent.pointerEnter(section);
    fireEvent.click(getIn(card('Best overall')));
    fireEvent.pointerLeave(section);

    rerender(pool(dave, faster));
    expect(card('Best overall').textContent).toContain('dave');
  });
});

describe("Collector's line of chips", () => {
  it('names each copy on one chip, and the chip takes exactly that copy', () => {
    const onQueue = vi.fn();
    render(
      <StrictMode>
        <BestPicks compact pool={pool(dave)} rules={RULES} transfers={{ all: [], groups: [] }}
          queueStates={new Map()} folderStates={new Map()} onQueue={onQueue} />
      </StrictMode>,
    );
    const strip = screen.getByRole('region', { name: 'Best picks' });
    expect(within(strip).queryByRole('article')).toBeNull();

    const overall = within(strip).getByRole('button', { name: 'Queue Archangel from dave, best overall' });
    for (const words of ['Overall', 'Archangel', 'FLAC', 'dave · slot free · ≈2.3 MB/s', 'Get']) {
      expect(overall.textContent).toContain(words);
    }
    const release = within(strip).getByRole('button', { name: /^Queue all 2 tracks of Untrue from dave/ });
    expect(release.textContent).toContain('Get all 2');

    fireEvent.click(overall);
    expect(onQueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'file', source: expect.objectContaining({ user: 'dave', path: ARCHANGEL }),
    }));
    expect(overall.textContent).toContain('Asking dave…');
    fireEvent.click(release);
    expect(onQueue).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'release' }));
  });
});
