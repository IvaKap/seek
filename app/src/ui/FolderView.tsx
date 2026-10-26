/*
 * Seek — a peer's share as folders you walk into.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A share list arrives flat: every folder is an absolute path, and there is no
 * hierarchy in the protocol at all. So the hierarchy is rebuilt here from the
 * path separators, which is exactly how the peer's own disk is organised.
 *
 * This is the view for people who think in folders, and for shares whose
 * structure carries meaning the folder names alone do not — label runs, rips by
 * year, "to sort" piles.
 */

import { useMemo, useState } from 'react';
import type { BrowseFile, Shelf } from '../data/browseStore.ts';
import { fileSize } from '../domain/format.ts';
import { fileName } from '../data/transferStore.ts';
import { buildFolderTree } from './FolderTree.tsx';
import type { FolderNode } from './FolderTree.tsx';
import { IconDownload, IconLibrary, IconRelease } from '../icons/index.tsx';

/** Walk into the tree by folder name. A stale path from before the peer's
 * share changed stops at the deepest folder that still exists. */
function resolve(root: FolderNode, path: string[]): FolderNode {
  let node = root;
  for (const part of path) {
    const next = node.children.find((c) => c.name === part);
    if (!next) break;
    node = next;
  }
  return node;
}

export function FolderView({
  shelves, onGetFolder, onGetFile,
}: {
  shelves: Shelf[];
  onGetFolder(path: string): void;
  onGetFile(file: BrowseFile): void;
}) {
  const root = useMemo(() => buildFolderTree(shelves), [shelves]);
  const [path, setPath] = useState<string[]>([]);

  const node = resolve(root, path);
  const folders = [...node.children].sort((a, b) => b.size - a.size);

  return (
    <div className="finder">
      <nav className="finder__crumbs" aria-label="Folder path">
        <button
          type="button"
          className="finder__crumb pressable"
          onClick={() => setPath([])}
        >
          All
        </button>
        {path.map((part, i) => (
          <button
            key={`${part}-${i}`}
            type="button"
            className="finder__crumb pressable"
            onClick={() => setPath(path.slice(0, i + 1))}
          >
            {part}
          </button>
        ))}
      </nav>

      <div className="finder__grid">
        {folders.map((f) => (
          <button
            key={f.path}
            type="button"
            className="tile pressable"
            onClick={(e) => {
              if (e.altKey) onGetFolder(f.path);
              else setPath([...path, f.name]);
            }}
            title={`${f.path} — ${f.fileCount} files, ${fileSize(f.size)}`}
          >
            <span className="tile__icon"><IconLibrary size={26} painted={1.2} /></span>
            <span className="tile__name">{f.name}</span>
            <span className="tile__meta tnum">
              {f.fileCount} files · {fileSize(f.size)}
            </span>
          </button>
        ))}

        {node.files.map((f) => (
          <button
            key={f.path}
            type="button"
            className="tile tile--file pressable"
            onClick={() => onGetFile(f)}
            title={`Queue ${fileName(f.path)}`}
          >
            <span className="tile__icon"><IconRelease size={26} painted={1.2} /></span>
            <span className="tile__name">{fileName(f.path)}</span>
            <span className="tile__meta tnum">{fileSize(f.size)}</span>
          </button>
        ))}

        {folders.length === 0 && node.files.length === 0 && (
          <p className="settings__hint">This folder is empty.</p>
        )}
      </div>

      {path.length > 0 && node.fileCount > 0 && (
        <div className="finder__actions">
          <button
            type="button"
            className="btn pressable"
            onClick={() => onGetFolder(node.path)}
          >
            <IconDownload size={13} painted={1.5} />
            Get this folder — {node.fileCount} files, {fileSize(node.size)}
          </button>
        </div>
      )}
    </div>
  );
}
