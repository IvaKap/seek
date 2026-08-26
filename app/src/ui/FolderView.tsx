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
import { IconDownload, IconLibrary, IconRelease } from '../icons/index.tsx';

interface Node {
  name: string;
  path: string;
  children: Map<string, Node>;
  files: BrowseFile[];
  /** Bytes in this subtree, computed once on build. */
  size: number;
  fileCount: number;
}

function emptyNode(name: string, path: string): Node {
  return { name, path, children: new Map(), files: [], size: 0, fileCount: 0 };
}

/** Rebuild the directory tree the peer actually has from the flat path list. */
function buildTree(shelves: Shelf[]): Node {
  const root = emptyNode('', '');
  for (const shelf of shelves) {
    const parts = shelf.path.replace(/\//g, '\\').split('\\').filter(Boolean);
    let node = root;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}\\${part}` : part;
      let next = node.children.get(part);
      if (!next) {
        next = emptyNode(part, acc);
        node.children.set(part, next);
      }
      node = next;
    }
    node.files = shelf.files;
  }

  // Roll sizes up once, rather than walking the subtree on every render.
  const measure = (n: Node): void => {
    let size = n.files.reduce((sum, f) => sum + f.size, 0);
    let count = n.files.length;
    for (const child of n.children.values()) {
      measure(child);
      size += child.size;
      count += child.fileCount;
    }
    n.size = size;
    n.fileCount = count;
  };
  measure(root);
  return root;
}

function resolve(root: Node, path: string[]): Node {
  let node = root;
  for (const part of path) {
    const next = node.children.get(part);
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
  const root = useMemo(() => buildTree(shelves), [shelves]);
  const [path, setPath] = useState<string[]>([]);

  const node = resolve(root, path);
  const folders = [...node.children.values()].sort((a, b) => b.size - a.size);

  return (
    <div className="finder">
      <nav className="finder__crumbs" aria-label="Folder path">
        <button
          type="button"
          className="finder__crumb pressable"
          onPointerDown={() => setPath([])}
        >
          All
        </button>
        {path.map((part, i) => (
          <button
            key={`${part}-${i}`}
            type="button"
            className="finder__crumb pressable"
            onPointerDown={() => setPath(path.slice(0, i + 1))}
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
            onPointerDown={(e) => {
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
            onPointerDown={() => onGetFile(f)}
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
            onPointerDown={() => onGetFolder(node.path)}
          >
            <IconDownload size={13} painted={1.5} />
            Get this folder — {node.fileCount} files, {fileSize(node.size)}
          </button>
        </div>
      )}
    </div>
  );
}
