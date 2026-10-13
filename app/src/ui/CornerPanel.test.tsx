// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The corner panel speaks only once a peer has answered, then always says
 * where you stand: your place in line, the transfer moving, a refusal, or a
 * finish you have not looked at yet.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CornerPanel, cornerRows, cornerSummary } from './CornerPanel.tsx';
import { group } from '../data/transferStore.ts';
import type { Transfer } from '../data/transferStore.ts';
import { fileSize, speed } from '../domain/format.ts';

afterEach(cleanup);

const FOLDER = 'Music\\Burial - Untrue (2007)';
let n = 0;

function file(over: Partial<Transfer> = {}, folder = FOLDER): Transfer {
  n += 1;
  return {
    id: `t${n}`, direction: 'download', username: 'nightbus', path: `${folder}\\${String(n).padStart(2, '0')} - Track.flac`,
    localFolder: null, size: 1_000_000, bytesDone: 0, state: 'queued', speed: 0,
    averageSpeed: 0, queuePosition: null, secondsLeft: null, secondsElapsed: 0,
    stalled: false, secondsSinceProgress: 0, finishedAt: null, error: null,
    ...over,
  };
}

const rowsOf = (files: Transfer[], since = 0) => cornerRows(group(files), since);

describe('what earns a row', () => {
  it('nothing while the peer has not answered', () => {
    expect(rowsOf([file(), file()])).toEqual([]);
  });

  it('a place in line, and how many are ahead', () => {
    const [r] = rowsOf([file({ queuePosition: 4 }), file({ queuePosition: 3 })]);
    expect(r.kind).toBe('waiting');
    expect(r.line).toBe("Waiting in nightbus's queue · 3rd in line");
    expect(r.sub).toBe('Starts when the 2 ahead of you finish');
    expect(rowsOf([file({ queuePosition: 2 })])[0].sub).toBe('Starts when the 1 ahead of you finishes');
    expect(rowsOf([file({ queuePosition: 1 })])[0].sub).toBe('Starts next');
  });

  it('a moving transfer, with its rate and how much has arrived', () => {
    const [r] = rowsOf([file({ state: 'transferring', speed: 2_100_000, bytesDone: 410_000 }), file()]);
    expect(r.kind).toBe('moving');
    expect(r.line).toBe(`${speed(2_100_000)} · ${fileSize(410_000)} of ${fileSize(2_000_000)}`);
  });

  it('a refusal, in the shared wording', () => {
    const [r] = rowsOf([file({ state: 'rejected', error: 'File not shared.' })]);
    expect(r.kind).toBe('trouble');
    expect(r.line).toBe('They are no longer sharing this file');
  });

  it('a finish you have not seen, counting tracks rather than files', () => {
    const done = (path?: string) => file({ state: 'finished', finishedAt: 2_000, ...(path ? { path } : {}) });
    const files = [done(), done(), done(`${FOLDER}\\cover.jpg`)];
    expect(rowsOf(files, 1_000)[0].line).toBe('Finished · 2 tracks now in Completed');
    // Seen already: it finished before you last looked at Downloads.
    expect(rowsOf(files, 3_000)).toEqual([]);
  });

  it('not something you paused yourself', () => {
    expect(rowsOf([file({ state: 'paused', queuePosition: 2 })])).toEqual([]);
  });

  it('moving first, then waiting, then trouble, then finished', () => {
    const rows = cornerRows(group([
      file({ state: 'finished', finishedAt: 2_000 }, 'Music\\A'),
      file({ state: 'rejected', error: 'Banned' }, 'Music\\B'),
      file({ queuePosition: 5 }, 'Music\\C'),
      file({ state: 'transferring', speed: 1 }, 'Music\\D'),
    ]), 1_000);
    expect(rows.map((r) => r.kind)).toEqual(['moving', 'waiting', 'trouble', 'finished']);
    expect(cornerSummary(rows)).toEqual([
      `1 downloading · ${speed(1)}`, '1 waiting, 5th in line', '1 needs a look', '1 finished',
    ]);
  });
});

describe('the two forms', () => {
  const queued = group([file({ queuePosition: 3 })]);
  const props = { since: 0, onShowAll: vi.fn(), onShowCompleted: vi.fn() };

  it('Simple opens on the card and folds into the pill', () => {
    render(<CornerPanel {...props} groups={queued} mode="simple" />);
    expect(screen.getByText("Waiting in nightbus's queue · 3rd in line")).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Fold the panel' }));
    expect(screen.queryByText("Waiting in nightbus's queue · 3rd in line")).toBeNull();
    expect(screen.getByText('1 waiting, 3rd in line')).toBeTruthy();
  });

  it('Collector opens on the pill, which opens the card', () => {
    render(<CornerPanel {...props} groups={queued} mode="collector" />);
    fireEvent.click(screen.getByRole('button', { name: /1 waiting/ }));
    expect(screen.getByText("Waiting in nightbus's queue · 3rd in line")).toBeTruthy();
  });

  it('is absent while there is nothing to say', () => {
    const { container } = render(<CornerPanel {...props} groups={group([file()])} mode="simple" />);
    expect(container.firstChild).toBeNull();
  });

  it('a finished release offers Completed', () => {
    const onShowCompleted = vi.fn();
    render(<CornerPanel {...props} onShowCompleted={onShowCompleted} mode="simple"
      groups={group([file({ state: 'finished', finishedAt: 10 })])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show in Completed' }));
    expect(onShowCompleted).toHaveBeenCalled();
  });
});
