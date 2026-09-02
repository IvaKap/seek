/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The Get button's states, derived from the transfer store. Pinned here because
 * the whole point of the button is to tell the truth about what happened to the
 * file — "queued" that never becomes "downloading", or "failed" shown for a file
 * the user cancelled, is worse than no badge at all.
 */

import { describe, expect, it } from 'vitest';
import {
  buildQueueMaps, folderKey, queueBadge, transferKey,
} from './transferStore.ts';
import type { Transfer } from './transferStore.ts';

function t(over: Partial<Transfer>): Transfer {
  return {
    id: 'x', direction: 'download', username: 'peer', path: 'a\\b\\c.flac',
    localFolder: null, size: 1, bytesDone: 0, state: 'transferring', speed: 0,
    averageSpeed: 0, queuePosition: null, secondsLeft: null, secondsElapsed: 0,
    stalled: false, secondsSinceProgress: 0, finishedAt: null, error: null,
    ...over,
  };
}

describe('queueBadge', () => {
  it('maps each transfer state to what the button should say', () => {
    expect(queueBadge(undefined)).toBe('idle');
    expect(queueBadge('queued')).toBe('queued');
    expect(queueBadge('getting_status')).toBe('queued');
    expect(queueBadge('transferring')).toBe('downloading');
    expect(queueBadge('paused')).toBe('paused');
    expect(queueBadge('finished')).toBe('done');
  });

  it('treats a failure as failed but a cancel as idle', () => {
    // Failed states offer a retry; a cancelled/removed file is grabbable again.
    expect(queueBadge('user_logged_off')).toBe('failed');
    expect(queueBadge('connection_closed')).toBe('failed');
    expect(queueBadge('cancelled')).toBe('idle');
    expect(queueBadge('filtered')).toBe('idle');
  });
});

describe('transferKey / folderKey', () => {
  it('normalises forward slashes to the backslash the transport uses', () => {
    // A search source may carry either separator; the store always has one.
    expect(transferKey('peer', 'a/b/c.flac')).toBe(transferKey('peer', 'a\\b\\c.flac'));
    expect(folderKey('peer', 'a/b')).toBe('peer\0a\\b');
  });

  it('keys on the peer too, so two peers offering one path do not collide', () => {
    expect(transferKey('alice', 'a\\b.flac')).not.toBe(transferKey('bob', 'a\\b.flac'));
  });
});

describe('buildQueueMaps', () => {
  it('indexes each file by peer+path', () => {
    const { files } = buildQueueMaps([
      t({ username: 'alice', path: 'm\\rec\\01.flac', state: 'transferring' }),
      t({ username: 'bob', path: 'm\\rec\\02.flac', state: 'queued' }),
    ]);
    expect(files.get(transferKey('alice', 'm\\rec\\01.flac'))).toBe('transferring');
    expect(files.get(transferKey('bob', 'm\\rec\\02.flac'))).toBe('queued');
    expect(files.get(transferKey('alice', 'nope.flac'))).toBeUndefined();
  });

  it('a folder takes the liveliest badge of its files', () => {
    // One file still downloading, another already done → the folder is "downloading".
    const { folders } = buildQueueMaps([
      t({ username: 'p', path: 'm\\rec\\01.flac', state: 'finished' }),
      t({ username: 'p', path: 'm\\rec\\02.flac', state: 'transferring' }),
    ]);
    expect(folders.get(folderKey('p', 'm\\rec'))).toBe('downloading');
  });

  it('a folder whose every file is finished reads done', () => {
    const { folders } = buildQueueMaps([
      t({ username: 'p', path: 'm\\rec\\01.flac', state: 'finished' }),
      t({ username: 'p', path: 'm\\rec\\02.flac', state: 'finished' }),
    ]);
    expect(folders.get(folderKey('p', 'm\\rec'))).toBe('done');
  });

  it('queued outranks paused, and downloading outranks queued', () => {
    const { folders } = buildQueueMaps([
      t({ username: 'p', path: 'm\\a\\1.flac', state: 'paused' }),
      t({ username: 'p', path: 'm\\a\\2.flac', state: 'queued' }),
    ]);
    expect(folders.get(folderKey('p', 'm\\a'))).toBe('queued');
    const two = buildQueueMaps([
      t({ username: 'p', path: 'm\\b\\1.flac', state: 'queued' }),
      t({ username: 'p', path: 'm\\b\\2.flac', state: 'transferring' }),
    ]);
    expect(two.folders.get(folderKey('p', 'm\\b'))).toBe('downloading');
  });
});
