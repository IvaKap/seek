/* SPDX-License-Identifier: GPL-3.0-or-later */

import { describe, expect, it } from 'vitest';
import { fileMenuItems } from './downloadMenu.ts';
import type { FileMenuActions } from './downloadMenu.ts';
import type { Transfer, TransferState } from '../data/transferStore.ts';

/** A transfer stub carrying only what the menu reads. */
function t(id: string, state: TransferState, over: Partial<Transfer> = {}): Transfer {
  return {
    id, state, path: `music\\Album\\${id}.flac`, username: 'peer', ...over,
  } as Transfer;
}

function spies(): FileMenuActions & { calls: Record<string, string[][]> } {
  const calls: Record<string, string[][]> = {
    pause: [], resume: [], retry: [], cancel: [], clear: [], copy: [],
  };
  return {
    calls,
    pause: (ids) => { calls.pause.push(ids); },
    resume: (ids) => { calls.resume.push(ids); },
    retry: (ids) => { calls.retry.push(ids); },
    cancel: (ids) => { calls.cancel.push(ids); },
    clear: (ids) => { calls.clear.push(ids); },
    copy: (text) => { calls.copy.push([text]); },
  };
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);
const run = (items: { id: string; run(): void }[], id: string) => {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no menu item "${id}"`);
  item.run();
};

describe('fileMenuItems', () => {
  it('a running file can be paused or cancelled, and its details copied', () => {
    const a = spies();
    const items = fileMenuItems([t('x', 'transferring')], a);
    expect(ids(items)).toEqual(['pause', 'cancel', 'copypath', 'copyname', 'copyuser']);

    run(items, 'cancel');
    expect(a.calls.cancel).toEqual([['x']]);
  });

  it('a finished file offers Clear, never Cancel or Retry', () => {
    const items = fileMenuItems([t('x', 'finished')], spies());
    expect(ids(items)).toEqual(['clear', 'copypath', 'copyname', 'copyuser']);
  });

  it('a failed file offers Retry and Clear but not Cancel (it is already terminal)', () => {
    const items = fileMenuItems([t('x', 'user_logged_off')], spies());
    expect(ids(items)).toEqual(['retry', 'clear', 'copypath', 'copyname', 'copyuser']);
  });

  it('a paused file offers Resume and Cancel', () => {
    const items = fileMenuItems([t('x', 'paused')], spies());
    expect(ids(items)).toEqual(['resume', 'cancel', 'copypath', 'copyname', 'copyuser']);
  });

  it('over a MIXED selection each action touches only the files it fits', () => {
    const a = spies();
    const items = fileMenuItems(
      [t('run', 'transferring'), t('bad', 'connection_closed')],
      a,
    );
    // No copy rows for a selection, and a count suffix appears.
    expect(ids(items)).toEqual(['pause', 'retry', 'cancel', 'clear']);
    expect(items.find((i) => i.id === 'pause')?.label).toBe('Pause 1');

    run(items, 'pause');
    run(items, 'retry');
    run(items, 'cancel');
    run(items, 'clear');
    expect(a.calls.pause).toEqual([['run']]);   // only the running one
    expect(a.calls.retry).toEqual([['bad']]);   // only the failed one
    expect(a.calls.cancel).toEqual([['run']]);  // failed is terminal — not cancelled
    expect(a.calls.clear).toEqual([['bad']]);   // running is not clearable
  });

  it('Cancel over a selection of several running files cancels them all', () => {
    const a = spies();
    const items = fileMenuItems(
      [t('a', 'transferring'), t('b', 'queued'), t('c', 'transferring')],
      a,
    );
    expect(items.find((i) => i.id === 'cancel')?.label).toBe('Cancel 3 — stop and remove');
    run(items, 'cancel');
    expect(a.calls.cancel).toEqual([['a', 'b', 'c']]);
  });

  it('copies the right strings for a single file', () => {
    const a = spies();
    const items = fileMenuItems([t('x', 'finished', {
      path: 'music\\Burial - Untrue\\02 Archangel.flac', username: 'sublow',
    })], a);
    run(items, 'copypath');
    run(items, 'copyname');
    run(items, 'copyuser');
    expect(a.calls.copy).toEqual([
      ['music\\Burial - Untrue\\02 Archangel.flac'],
      ['02 Archangel.flac'],
      ['sublow'],
    ]);
  });

  it('is empty for no targets, so the caller opens no menu', () => {
    expect(fileMenuItems([], spies())).toEqual([]);
  });

  it('marks Cancel as the dangerous item', () => {
    const items = fileMenuItems([t('x', 'transferring')], spies());
    expect(items.find((i) => i.id === 'cancel')?.danger).toBe(true);
  });
});
