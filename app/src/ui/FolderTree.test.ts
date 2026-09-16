/* SPDX-License-Identifier: GPL-3.0-or-later */

import { describe, expect, it } from 'vitest';
import { buildFolderTree, findFolder } from './FolderTree.tsx';
import { enrichFile } from '../data/browseStore.ts';
import type { Shelf } from '../data/browseStore.ts';

function shelf(path: string, ...files: string[]): Shelf {
  return {
    path, name: path, artist: null, year: null, private: false,
    formats: ['FLAC'],
    files: files.map((p) => enrichFile({
      path: p, size: 1_000_000, bitrate: null, duration: 120,
      sampleRate: 44100, bitDepth: 16, isVbr: null,
    })),
    size: files.length * 1_000_000,
  };
}

describe('buildFolderTree', () => {
  it('rebuilds intermediate folders that carry no files of their own', () => {
    const root = buildFolderTree([shelf('Music\\Electronic\\Techno', 'Music\\Electronic\\Techno\\a.flac')]);
    expect(root.children).toHaveLength(1);
    const music = root.children[0];
    expect(music.name).toBe('Music');
    expect(music.files).toHaveLength(0);
    // The file count rolls up from the leaf even though this node has none of its own.
    expect(music.fileCount).toBe(1);
    const electronic = music.children[0];
    const techno = electronic.children[0];
    expect(techno.files).toHaveLength(1);
  });

  it('rolls up size and file count from every descendant', () => {
    const root = buildFolderTree([
      shelf('A\\One', 'A\\One\\a.flac', 'A\\One\\b.flac'),
      shelf('A\\Two', 'A\\Two\\c.flac'),
    ]);
    const a = root.children[0];
    expect(a.fileCount).toBe(3);
    expect(a.size).toBe(3_000_000);
  });

  it('sorts children by name', () => {
    const root = buildFolderTree([shelf('Zebra', 'Zebra\\z.flac'), shelf('Apple', 'Apple\\a.flac')]);
    expect(root.children.map((c) => c.name)).toEqual(['Apple', 'Zebra']);
  });
});

describe('findFolder', () => {
  it('finds a nested folder by its full path', () => {
    const root = buildFolderTree([shelf('A\\B\\C', 'A\\B\\C\\x.flac')]);
    const found = findFolder(root, 'A\\B');
    expect(found.path).toBe('A\\B');
  });

  it('falls back to the root for a path that no longer exists', () => {
    const root = buildFolderTree([shelf('A', 'A\\x.flac')]);
    expect(findFolder(root, 'Nonexistent').path).toBe(root.path);
  });
});
