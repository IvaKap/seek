/* SPDX-License-Identifier: GPL-3.0-or-later */

import { describe, expect, it, vi } from 'vitest';
import { browseFileMenuItems } from './browseFileMenu.ts';
import { enrichFile } from '../data/browseStore.ts';

function file(path: string) {
  return enrichFile({
    path, size: 1000, bitrate: 320, duration: 200, sampleRate: null, bitDepth: null, isVbr: false,
  });
}

describe('browseFileMenuItems', () => {
  it('offers Get, singular, for one file', () => {
    const queue = vi.fn();
    const items = browseFileMenuItems([file('a.mp3')], 'jazzcat', { queue, copy: vi.fn() });
    expect(items.find((i) => i.id === 'get')?.label).toBe('Get');
  });

  it('pluralises Get and drops per-file copy actions for a selection', () => {
    const items = browseFileMenuItems(
      [file('a.mp3'), file('b.mp3')], 'jazzcat', { queue: vi.fn(), copy: vi.fn() },
    );
    expect(items.find((i) => i.id === 'get')?.label).toBe('Get 2 files');
    expect(items.some((i) => i.id === 'copypath')).toBe(false);
    expect(items.some((i) => i.id === 'copyname')).toBe(false);
  });

  it('always offers Copy username, for one file or many', () => {
    const items = browseFileMenuItems([file('a.mp3')], 'jazzcat', { queue: vi.fn(), copy: vi.fn() });
    expect(items.some((i) => i.id === 'copyuser')).toBe(true);
  });

  it('Get queues exactly the targets it was given', () => {
    const queue = vi.fn();
    const targets = [file('a.mp3'), file('b.mp3')];
    const items = browseFileMenuItems(targets, 'jazzcat', { queue, copy: vi.fn() });
    items.find((i) => i.id === 'get')?.run();
    expect(queue).toHaveBeenCalledWith(targets);
  });

  it('returns nothing for an empty selection', () => {
    expect(browseFileMenuItems([], 'jazzcat', { queue: vi.fn(), copy: vi.fn() })).toEqual([]);
  });
});
