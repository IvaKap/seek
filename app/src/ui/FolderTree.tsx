/*
 * Seek — a peer's share as a real folder tree.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Classic Nicotine+: every folder visible at once, disclosure triangles,
 * arrow keys move the highlight. `buildFolderTree` walks the same trie
 * `FolderView.tsx` builds for its Finder-style drill-down — a peer's flat
 * path list resolves to one hierarchy; only the two views read it
 * differently.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { BrowseFile, Shelf } from '../data/browseStore.ts';
import { IconChevronDown, IconLibrary } from '../icons/index.tsx';

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  files: BrowseFile[];
  /** Bytes/files in this subtree, computed once on build. */
  size: number;
  fileCount: number;
}

interface MutableNode {
  name: string; path: string;
  children: Map<string, MutableNode>;
  files: BrowseFile[]; size: number; fileCount: number;
}

function emptyNode(name: string, path: string): MutableNode {
  return { name, path, children: new Map(), files: [], size: 0, fileCount: 0 };
}

/** Rebuild the directory tree the peer actually has from the flat shelf list. */
export function buildFolderTree(shelves: Shelf[]): FolderNode {
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

  const freeze = (n: MutableNode): FolderNode => {
    const children = [...n.children.values()]
      .map(freeze)
      .sort((a, b) => a.name.localeCompare(b.name));
    let size = n.files.reduce((sum, f) => sum + f.size, 0);
    let count = n.files.length;
    for (const c of children) { size += c.size; count += c.fileCount; }
    return { name: n.name, path: n.path, children, files: n.files, size, fileCount: count };
  };
  return freeze(root);
}

/** Find a node by its full path, or the root if nothing matches (a stale
 * selection from before the peer's share changed). */
export function findFolder(root: FolderNode, path: string): FolderNode {
  if (root.path === path) return root;
  for (const child of root.children) {
    const found = findFolderOrNull(child, path);
    if (found) return found;
  }
  return root;
}

function findFolderOrNull(node: FolderNode, path: string): FolderNode | null {
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findFolderOrNull(child, path);
    if (found) return found;
  }
  return null;
}

interface Row { node: FolderNode; depth: number }

function flatten(node: FolderNode, open: ReadonlySet<string>, depth: number, out: Row[]): Row[] {
  out.push({ node, depth });
  if (depth === 0 || open.has(node.path)) {
    for (const child of node.children) flatten(child, open, depth + 1, out);
  }
  return out;
}

export function FolderTree({
  root, open, onToggle, selected, onSelect,
}: {
  root: FolderNode;
  /** Which folders are expanded. Owned by the caller so it can be persisted per peer. */
  open: ReadonlySet<string>;
  onToggle(path: string): void;
  selected: string;
  onSelect(path: string): void;
}) {
  const rows = useMemo(() => flatten(root, open, 0, []), [root, open]);
  const activeIndex = Math.max(0, rows.findIndex((r) => r.node.path === selected));
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const row = rows[activeIndex];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = rows[Math.min(activeIndex + 1, rows.length - 1)];
      if (next) onSelect(next.node.path);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = rows[Math.max(activeIndex - 1, 0)];
      if (prev) onSelect(prev.node.path);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (row && row.node.children.length > 0 && !open.has(row.node.path)) onToggle(row.node.path);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (row && open.has(row.node.path)) onToggle(row.node.path);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (row && row.node.children.length > 0) onToggle(row.node.path);
    } else if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
      // Type-ahead: jump to the next folder starting with the typed letter.
      const q = e.key.toLowerCase();
      for (let i = 1; i <= rows.length; i++) {
        const idx = (activeIndex + i) % rows.length;
        const name = rows[idx].node.name.toLowerCase();
        if (name.startsWith(q)) { onSelect(rows[idx].node.path); break; }
      }
    }
  };

  return (
    <div
      ref={listRef}
      className="ftree"
      role="tree"
      aria-label="Folders"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {rows.map(({ node, depth }, i) => (
        <div
          key={node.path || '\u0000root'}
          role="treeitem"
          aria-expanded={node.children.length > 0 ? open.has(node.path) : undefined}
          aria-selected={i === activeIndex}
          data-active={i === activeIndex ? 'true' : undefined}
          className="ftree__row pressable"
          style={{ paddingLeft: `${0.5 + depth * 1.1}rem` }}
          onPointerDown={() => { listRef.current?.focus(); onSelect(node.path); }}
        >
          {node.children.length > 0 ? (
            <button
              type="button"
              className="ftree__disclosure"
              aria-label={open.has(node.path) ? 'Collapse folder' : 'Expand folder'}
              onPointerDown={(e) => { e.stopPropagation(); onToggle(node.path); }}
            >
              <IconChevronDown
                size={11}
                painted={1.6}
                className="ftree__chev"
                data-open={open.has(node.path) ? 'true' : undefined}
              />
            </button>
          ) : (
            <span className="ftree__spacer" aria-hidden />
          )}
          <IconLibrary size={13} painted={1.4} className="ftree__icon" />
          <span className="ftree__name">{node.name || 'All folders'}</span>
          {node.fileCount > 0 && <span className="ftree__count tnum">{node.fileCount}</span>}
        </div>
      ))}
    </div>
  );
}
