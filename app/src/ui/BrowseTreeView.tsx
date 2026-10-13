/*
 * Seek — Browse's default view: a folder tree beside a dense file table.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The classic Nicotine+ layout: a folder tree on the left, one row per file
 * on the right. Selection, right-click and keyboard follow the exact shape
 * `DownloadsView.tsx` already pins for its own file table — the same three
 * gestures, the same pure `nextSelection`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowseFile, BrowseFolder, Shelf } from '../data/browseStore.ts';
import { filesUnder } from '../data/browseStore.ts';
import type { BrowseGet } from './BrowseView.tsx';
import type { TransferSession } from '../data/transferStore.ts';
import { buildQueueMaps, fileName } from '../data/transferStore.ts';
import { nextSelection } from '../domain/select.ts';
import { buildFolderTree, findFolder, FolderTree } from './FolderTree.tsx';
import { BrowseFileRow } from './rows.tsx';
import { ContextMenu } from './ContextMenu.tsx';
import type { MenuRequest } from './ContextMenu.tsx';
import { browseFileMenuItems } from './browseFileMenu.ts';
import { copyText } from '../data/clipboard.ts';
import { fileSize } from '../domain/format.ts';
import { IconDownload, IconUser } from '../icons/index.tsx';

function expandedKey(username: string): string {
  return `seek.browse.expanded.${username}`;
}

const TREE_WIDTH_KEY = 'seek.browse.treeWidth';
const MIN_TREE_WIDTH = 160;
const MAX_TREE_WIDTH = 480;
const DEFAULT_TREE_WIDTH = 240;

function storedTreeWidth(): number {
  try {
    const raw = Number(localStorage.getItem(TREE_WIDTH_KEY));
    return raw >= MIN_TREE_WIDTH && raw <= MAX_TREE_WIDTH ? raw : DEFAULT_TREE_WIDTH;
  } catch {
    return DEFAULT_TREE_WIDTH;
  }
}

/** Drag-to-resize the tree pane. A ref carries the live width into the
 * `pointerup` handler, which closes over the value from the render that
 * started the drag otherwise — state updates mid-drag never reach it. */
function useTreeResize() {
  const [width, setWidth] = useState(storedTreeWidth);
  const widthRef = useRef(width);
  const [dragging, setDragging] = useState(false);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, startWidth + (ev.clientX - startX)));
      widthRef.current = next;
      setWidth(next);
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { localStorage.setItem(TREE_WIDTH_KEY, String(widthRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  return { width, dragging, onResizeStart };
}

export function BrowseTreeView({
  shelves, folders, username, transfers, get,
}: {
  shelves: Shelf[];
  /** Every folder with every file, for counting what a folder Get fetches. */
  folders: BrowseFolder[];
  username: string;
  transfers: TransferSession;
  get: BrowseGet;
}) {
  const root = useMemo(() => buildFolderTree(shelves), [shelves]);

  // Expand-state and the current selection both key off the peer, so
  // switching to someone else — or reopening this one later — starts fresh
  // rather than pointing at a path that belonged to the last person.
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(expandedKey(username));
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : ['']);
    } catch {
      return new Set(['']);
    }
  });
  const [selectedPath, setSelectedPath] = useState('');

  useEffect(() => {
    setSelectedPath('');
    try {
      const raw = localStorage.getItem(expandedKey(username));
      setOpen(new Set<string>(raw ? (JSON.parse(raw) as string[]) : ['']));
    } catch {
      setOpen(new Set(['']));
    }
  }, [username]);

  useEffect(() => {
    try { localStorage.setItem(expandedKey(username), JSON.stringify([...open])); } catch { /* private mode, or a full quota — the tree still works, it just forgets */ }
  }, [open, username]);

  const toggle = useCallback((path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const node = findFolder(root, selectedPath);
  const files = node.files;
  const order = useMemo(() => files.map((f) => f.path), [files]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  /* ---- selection + right-click, the exact shape DownloadsView.tsx pins ---- */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<MenuRequest | null>(null);

  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [node.path]);

  const listRef = useRef<HTMLDivElement>(null);

  const onFileSelect = useCallback((path: string, mods: { meta: boolean; shift: boolean }) => {
    // A click must hand keyboard focus to the list, or the very next arrow
    // press falls through to the page and scrolls it instead of the file
    // that is now highlighted.
    listRef.current?.focus();
    setSelected((prev) => {
      const r = nextSelection(prev, order, path, anchor.current, mods);
      anchor.current = r.anchor;
      return r.selected;
    });
  }, [order]);

  const queueFiles = useCallback((targets: BrowseFile[], destination: string | null = null) => {
    for (const f of targets) get.file(f, destination);
  }, [get]);

  /* The single selected file, when there is exactly one — what arrow-key
   * navigation moves and what Enter downloads. A multi-selection (shift or
   * cmd-click) has no one "current" row to move from, so arrows restart
   * from an end rather than picking one arbitrarily. */
  const activePath = selected.size === 1 ? [...selected][0] : null;

  useEffect(() => {
    if (!activePath) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activePath]);

  const onListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (order.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const current = activePath ? order.indexOf(activePath) : -1;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = current === -1
        ? (step === 1 ? 0 : order.length - 1)
        : Math.min(Math.max(current + step, 0), order.length - 1);
      anchor.current = order[next];
      setSelected(new Set([order[next]]));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const targets = [...selected].map((p) => byPath.get(p)).filter((x): x is BrowseFile => x !== undefined);
      if (targets.length > 0) queueFiles(targets);
    } else if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
      // Type-ahead: jump to the next filename starting with the typed letter.
      const q = e.key.toLowerCase();
      const start = (activePath ? order.indexOf(activePath) : -1) + 1;
      for (let i = 0; i < order.length; i++) {
        const idx = (start + i) % order.length;
        const f = byPath.get(order[idx]);
        if (f && fileName(f.path).toLowerCase().startsWith(q)) {
          anchor.current = order[idx];
          setSelected(new Set([order[idx]]));
          break;
        }
      }
    }
  }, [order, activePath, selected, byPath, queueFiles]);

  const clearSelection = useCallback(() => {
    anchor.current = null;
    setSelected((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  useEffect(() => {
    if (selected.size === 0 && !menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menu) setMenu(null); else clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size, menu, clearSelection]);

  const onContext = useCallback((path: string, e: React.MouseEvent) => {
    e.preventDefault();
    // Right-click inside a multi-selection acts on the whole selection;
    // elsewhere it selects just that row first, so the menu always matches
    // what is lit — same rule DownloadsView.onFileContext uses.
    let paths: string[];
    if (selected.has(path) && selected.size > 1) {
      paths = [...selected];
    } else {
      paths = [path];
      anchor.current = path;
      setSelected(new Set([path]));
    }
    const targets = paths.map((p) => byPath.get(p)).filter((x): x is BrowseFile => x !== undefined);
    const pick = get.pickDestination;
    const items = browseFileMenuItems(targets, username, {
      queue: queueFiles,
      queueTo: pick ? (fs) => pick((dest) => queueFiles(fs, dest)) : undefined,
      copy: (text) => { void copyText(text); },
    });
    if (items.length === 0) return;
    const title = targets.length > 1 ? `${targets.length} files` : fileName(targets[0].path);
    setMenu({ x: e.clientX, y: e.clientY, title, items });
  }, [selected, byPath, username, queueFiles, get]);

  const { files: queueStates } = useMemo(() => buildQueueMaps(transfers.all), [transfers.all]);
  const fetch = useMemo(() => {
    const all = filesUnder(folders, node.path, true);
    return { count: all.length, size: all.reduce((n, f) => n + f.size, 0) };
  }, [folders, node.path]);
  // Not for the root: "All folders" is not a folder a peer can send.
  const fetchCount = node.path ? fetch.count : 0;
  const resize = useTreeResize();

  if (root.children.length === 0 && root.files.length === 0) {
    return (
      <div className="empty empty--section">
        <span className="empty__icon"><IconUser size={28} painted={1.3} /></span>
        <p className="empty__title">Nothing to show</p>
        <p className="empty__body">This user shares nothing, or nothing matches the filter above.</p>
      </div>
    );
  }

  return (
    <div className="btree" style={{ '--tree-w': `${resize.width}px` } as React.CSSProperties}>
      <div className="btree__tree">
        <FolderTree
          root={root}
          open={open}
          onToggle={toggle}
          selected={selectedPath}
          onSelect={setSelectedPath}
        />
      </div>

      <div
        className="btree__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the folder tree"
        data-dragging={resize.dragging ? 'true' : undefined}
        onPointerDown={resize.onResizeStart}
      />

      <div className="btree__files">
        {/* Get whenever there is anything under the folder: an artist folder
            whose albums are all subfolders used to offer no Get at all. The
            count is what the engine will fetch — subfolders, covers and
            checksums included — not the audio shown in the list below. */}
        {fetchCount > 0 && (
          <div className="btree__toolbar">
            <span className="btree__path" title={node.path || 'All folders'}>
              {node.path || 'All folders'}
            </span>
            <button
              type="button"
              className="btn pressable"
              onClick={() => get.folder(node.path, true)}
            >
              <IconDownload size={13} painted={1.5} />
              Get this folder — <span className="tnum">{fetchCount.toLocaleString()}</span> files, {fileSize(fetch.size)}
            </button>
            {get.pickDestination && (
              <button
                type="button"
                className="btn pressable"
                onClick={() => get.pickDestination?.((dest) => get.folder(node.path, true, dest))}
              >
                Get to…
              </button>
            )}
          </div>
        )}
        {files.length === 0 ? (
          <p className="settings__hint">
            {node.children.length > 0 ? 'Its files are in the folders inside it.' : 'This folder is empty.'}
          </p>
        ) : (
          <div
            ref={listRef}
            className="btree__list"
            tabIndex={0}
            role="listbox"
            aria-label="Files in this folder"
            onKeyDown={onListKeyDown}
          >
            {files.map((f) => (
              <BrowseFileRow
                key={f.path}
                file={f}
                username={username}
                selected={selected.has(f.path)}
                onSelect={(mods) => onFileSelect(f.path, mods)}
                onQueue={() => get.file(f)}
                onContextMenu={(e) => onContext(f.path, e)}
                queueStates={queueStates}
              />
            ))}
          </div>
        )}
      </div>

      <ContextMenu request={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
