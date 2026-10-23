/*
 * Seek — Downloads · Folders: the same releases as folders on this Mac, each
 * opening to its files, with the Rekordbox folder beside the downloads.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * After its canvas board. Simple only, like the Board, and sorted by the
 * Board's own columns: a release sits under Downloads until it has been sent,
 * then under the Rekordbox folder, so the two layouts never disagree about
 * where a release is. Each release's line is the Board card's line (`say`).
 *
 * Built from what Seek knows, not from a walk of the disk: the transfers and
 * the hand-off's record. A file put in the folder by hand does not appear,
 * and the footnote does not pretend otherwise.
 */

import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Transfer, TransferGroup, TransferSession } from '../data/transferStore.ts';
import { fileName } from '../data/transferStore.ts';
import type { ChecksumSession } from '../data/checksumStore.ts';
import type { AutoClaim, HandoffSent } from '../../../shared/protocol.ts';
import { copyText } from '../data/clipboard.ts';
import { reportFailure, showNotice } from '../data/failures.ts';
import { transferStatus } from '../domain/transferStatus.ts';
import { count, fileSize, integer, since, speed } from '../domain/format.ts';
import { IconChevronRight, IconRelease, IconTrack } from '../icons/index.tsx';
import { Bar } from './transferBits.tsx';
import { LayoutHeader, boardColumns, homeShort, say } from './DownloadsBoard.tsx';
import { downloadsKind } from './DownloadsSimple.tsx';
import type { Column } from './DownloadsBoard.tsx';
import type { HandoffBits } from './HandoffButton.tsx';

export interface TreeNode {
  key: string;
  name: string;
  /** Files beneath, for a folder. Absent for a file. */
  files?: number;
  size: string;
  status: string;
  tone?: string;
  bar?: { done: number; total: number; state: 'active' | 'paused' | 'trouble' };
  /** Still on its way: drawn dimmed until it lands. */
  pending?: boolean;
  /** Where it is on this Mac, when Seek knows. */
  path: string | null;
  /** What Show in Finder reveals. Absent while there is nothing on disk yet. */
  reveal?: { transferId: string } | { path: string };
  children?: TreeNode[];
}

const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path;
const firstFinished = (g: TransferGroup) => g.transfers.find((t) => t.state === 'finished');

/* ponytail: a finished file's path is its folder plus its remote name. Upstream
   renames a second copy "name (1).flac", and that one would show its first
   name here; Show in Finder asks the sidecar, so it is never wrong. */
function fileNode(t: Transfer): TreeNode {
  const name = fileName(t.path);
  const done = t.state === 'finished';
  const moving = t.state === 'transferring' && !t.stalled;
  const status = transferStatus(t);
  return {
    key: t.id,
    name,
    size: fileSize(t.size),
    status: done ? 'Done'
      : moving ? `${t.size > 0 ? Math.floor((t.bytesDone / t.size) * 100) : 0}% · ${speed(t.speed)}`
        : status.text,
    tone: status.tone,
    bar: moving ? { done: t.bytesDone, total: t.size, state: 'active' } : undefined,
    pending: !done,
    path: t.localFolder ? `${t.localFolder}/${name}` : null,
    reveal: done ? { transferId: t.id } : undefined,
  };
}

interface TreeInput {
  groups: readonly TransferGroup[];
  now: number;
  checks: ChecksumSession['byTransfer'];
  handoff: HandoffBits;
  review: ReadonlyMap<string, AutoClaim>;
  downloadFolder: string | null;
}

/** The two roots: what is coming into Downloads, and what went to Rekordbox. */
export function folderTree({ groups, now, checks, handoff, review, downloadFolder }: TreeInput): TreeNode[] {
  const cols = boardColumns(groups, now, checks, handoff.session, handoff.held);
  const ctx = { now, checks, handoff: handoff.session, review };
  const release = (g: TransferGroup, column: Column): TreeNode => {
    const said = say(g, column, ctx);
    const finished = firstFinished(g);
    return {
      key: g.key,
      name: g.title,
      files: g.transfers.length,
      size: fileSize(g.size),
      status: said.line,
      tone: said.check ?? said.tone,
      bar: said.bar && { done: g.bytesDone, total: g.size, state: said.bar },
      path: g.transfers[0].localFolder,
      reveal: finished ? { transferId: finished.id } : undefined,
      children: g.transfers.map(fileNode),
    };
  };
  const incoming = [
    ...cols.downloading.map((g) => release(g, 'downloading')),
    ...cols.checking.map((g) => release(g, 'checking')),
    ...cols.queued.map((g) => release(g, 'queued')),
    ...cols.ready.map((g) => release(g, 'ready')),
  ];
  const troubled = [...cols.queued, ...cols.downloading].filter((g) => downloadsKind(g, now) === 'trouble').length;
  const onTheWay = cols.queued.length + cols.downloading.length - troubled;
  const ready = cols.checking.length + cols.ready.length;
  const roots: TreeNode[] = [{
    key: 'downloads',
    name: downloadFolder ? leaf(downloadFolder) : 'Downloads',
    files: incoming.reduce((n, r) => n + (r.files ?? 0), 0),
    size: fileSize([...cols.queued, ...cols.downloading, ...cols.checking, ...cols.ready].reduce((n, g) => n + g.size, 0)),
    status: [
      onTheWay > 0 && `${integer(onTheWay)} on the way`,
      ready > 0 && `${integer(ready)} ready`,
      troubled > 0 && `${integer(troubled)} need${troubled === 1 ? 's' : ''} you`,
    ].filter(Boolean).join(' · ') || 'Nothing downloading',
    path: downloadFolder,
    reveal: downloadFolder ? { path: downloadFolder } : undefined,
    children: incoming,
  }];

  const folder = handoff.session.folder;
  if (folder) roots.push(rekordboxRoot(folder, handoff.session, groups));
  return roots;
}

/**
 * The Rekordbox folder, from the hand-off's own record rather than the list:
 * every release that went, including one only partly sent and one since
 * cleared from Completed. One folder per release, as the list groups them
 * (who it came from, and its remote folder). Newest first.
 */
function rekordboxRoot(folder: string, h: HandoffBits['session'], groups: readonly TransferGroup[]): TreeNode {
  const sizes = new Map(groups.flatMap((g) => g.transfers.map((t) => [t.id, t.size] as const)));
  const releases = new Map<string, HandoffSent[]>();
  for (const row of h.sent.values()) {
    const key = `${row.user}\0${row.path.slice(0, row.path.lastIndexOf('\\'))}`;
    releases.set(key, [...(releases.get(key) ?? []), row]);
  }
  const bytes = (rows: HandoffSent[]) => rows.reduce((n, r) => n + (sizes.get(r.transferId) ?? 0), 0);
  const children = [...releases.values()]
    .map((rows) => ({ rows, sentAt: Math.max(...rows.map((r) => r.sentAt)) }))
    .sort((a, b) => b.sentAt - a.sentAt)
    .map(({ rows, sentAt }): TreeNode => {
      const dest = rows[0].dest.slice(0, rows[0].dest.lastIndexOf('/')) || '/';
      return {
        key: `rb\0${rows[0].transferId}`,
        name: leaf(dest),
        files: rows.length,
        // A cleared download's size is no longer known, and a guess is not a size.
        size: rows.every((r) => sizes.has(r.transferId)) ? fileSize(bytes(rows)) : '',
        status: `Copied ${since(sentAt)}`,
        path: dest,
        reveal: { path: dest },
        children: rows.map((r) => ({
          key: `rb\0${r.transferId}\0file`,
          name: leaf(r.dest),
          size: sizes.has(r.transferId) ? fileSize(sizes.get(r.transferId)!) : '',
          status: 'Copied',
          path: r.dest,
          reveal: { path: r.dest },
        })),
      };
    });
  const newest = Math.max(0, ...[...h.sent.values()].map((row) => row.sentAt));
  return {
    key: 'rekordbox',
    name: leaf(folder),
    files: h.sent.size,
    size: '',
    status: newest > 0 ? `${count(children.length, 'folder')} · last copy ${since(newest)}` : 'Nothing sent yet',
    path: folder,
    reveal: { path: folder },
    children,
  };
}


function Row({ node, depth, open, current, onPick }: {
  node: TreeNode; depth: number; open: boolean; current: boolean; onPick(): void;
}) {
  const folder = node.children !== undefined;
  return (
    <li className="dlf__row" data-current={current || undefined} data-pending={node.pending || undefined}>
      <button
        type="button"
        className="dlf__name"
        style={{ '--depth': depth } as CSSProperties}
        aria-expanded={folder ? open : undefined}
        aria-current={current || undefined}
        title={node.name}
        onClick={onPick}
      >
        <IconChevronRight size={12} painted={1.6} className="dlf__chev" data-open={open || undefined} data-hidden={!folder || undefined} />
        {folder ? <IconRelease size={14} painted={1.5} /> : <IconTrack size={14} painted={1.5} />}
        <span className="dlf__label">{node.name}</span>
      </button>
      <span className="dlf__files tnum">{node.files === undefined ? '' : integer(node.files)}</span>
      <span className="dlf__size tnum">{node.size}</span>
      <span className="dlf__status tnum" data-tone={node.tone} title={node.status}>
        {node.bar && <Bar done={node.bar.done} total={node.bar.total} state={node.bar.state} />}
        <span className="dlf__statustext">{node.status}</span>
      </span>
    </li>
  );
}

export function DownloadsFolders({
  session, checksums, handoff, claims, now, downloadFolder, tools, notices,
}: {
  session: TransferSession;
  checksums: ChecksumSession;
  handoff: HandoffBits;
  claims: readonly AutoClaim[];
  now: number;
  downloadFolder: string | null;
  tools: ReactNode;
  notices: ReactNode;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(['downloads', 'rekordbox']));
  const [picked, setPicked] = useState<string | null>(null);
  const review = new Map(claims.filter((c) => c.status === 'awaiting-review').map((c) => [c.transferId, c]));
  const roots = folderTree({ groups: session.groups, now, checks: checksums.byTransfer, handoff, review, downloadFolder });

  const rows: { node: TreeNode; depth: number }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.children && open.has(node.key)) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  const chosen = rows.find((r) => r.node.key === picked)?.node ?? roots[0];
  const crumbs = chosen.path ? homeShort(chosen.path).split('/').filter(Boolean) : [chosen.name];

  const pick = (node: TreeNode) => {
    setPicked(node.key);
    if (node.children) {
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(node.key)) next.delete(node.key); else next.add(node.key);
        return next;
      });
    }
  };
  const reveal = () => {
    const target = chosen.reveal;
    if (!target) return;
    if ('transferId' in target) session.reveal(target.transferId);
    else void handoff.session.reveal(target.path).catch((e) => reportFailure('Show in Finder', e));
  };
  const copy = () => {
    if (!chosen.path) return;
    void copyText(chosen.path).then((ok) => showNotice(ok ? 'Path copied' : 'Could not copy the path'));
  };

  return (
    <>
      <LayoutHeader groups={session.groups} now={now} handoff={handoff} tools={tools} />
      <div className="pane__scroll">
        {notices}
        <div className="dlf">
          <div className="dlf__bar">
            <nav className="dlf__crumbs" aria-label="Selected path">
              {crumbs.map((c, i) => (
                // By position: a path can name the same folder twice.
                <span key={i} className="dlf__crumb" aria-current={i === crumbs.length - 1 ? 'location' : undefined}>
                  {i > 0 && <span aria-hidden className="dlf__sep">›</span>}
                  {c}
                </span>
              ))}
            </nav>
            <button type="button" className="btn pressable" disabled={!chosen.reveal} onClick={reveal}>Show in Finder</button>
            <button type="button" className="btn pressable" disabled={!chosen.path} onClick={copy}>Copy path</button>
          </div>
          <div className="dlf__table">
            <div className="dlf__head" aria-hidden>
              <span>Name</span><span className="dlf__files">Files</span><span className="dlf__size">Size</span><span>Status</span>
            </div>
            <ul className="dlf__rows" aria-label="Folders on this Mac">
              {rows.map(({ node, depth }) => (
                <Row
                  key={node.key} node={node} depth={depth}
                  open={open.has(node.key)} current={node.key === chosen.key} onPick={() => pick(node)}
                />
              ))}
            </ul>
          </div>
          <p className="dlf__foot">
            Files still on their way are drawn dimmed until they land. This shows what Seek downloaded and sent, not
            everything in these folders.
          </p>
        </div>
      </div>
    </>
  );
}
