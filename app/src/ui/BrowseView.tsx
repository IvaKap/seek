/*
 * Seek — a peer's shelves.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Iva's vision note §12. Not a folder tree: folders presented as the releases
 * they almost always are, searchable, with the whole folder downloadable in one
 * action — which is the unit a DJ actually wants anyway.
 *
 * Reliability figures are deliberately absent here. The protocol tells us
 * nothing about how a stranger behaves, and the note is explicit that we must
 * never pretend to know things it does not expose. What we know is what they
 * share, so that is what this shows.
 */

import { useState } from 'react';
import type { BrowseSession, Shelf } from '../data/browseStore.ts';
import type { TransferSession } from '../data/transferStore.ts';
import { fileSize } from '../domain/format.ts';
import { fileName } from '../data/transferStore.ts';
import { Treemap } from './Treemap.tsx';
import { FolderView } from './FolderView.tsx';
import { SegmentedControl } from './controls.tsx';
import type { Segment } from './controls.tsx';
import { IconChevronDown, IconDownload, IconLibrary, IconRelease, IconUser } from '../icons/index.tsx';

type BrowseMode = 'list' | 'map' | 'folders';

const MODES: Segment<BrowseMode>[] = [
  { value: 'list', label: 'List', icon: <IconRelease size={14} painted={1.5} /> },
  { value: 'map', label: 'Map', icon: <IconLibrary size={14} painted={1.5} /> },
  { value: 'folders', label: 'Folders', icon: <IconLibrary size={14} painted={1.5} /> },
];

function ShelfRow({
  shelf, username, transfers,
}: {
  shelf: Shelf;
  username: string;
  transfers: TransferSession;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="shelf">
      <button
        type="button"
        className="shelf__hit"
        aria-expanded={open}
        onPointerDown={() => setOpen((v) => !v)}
      >
        <span className="shelf__main">
          <span className="shelf__name">{shelf.name}</span>
          <span className="shelf__sub">
            {shelf.artist && <span className="shelf__artist">{shelf.artist}</span>}
            {shelf.year && <span className="tnum">{shelf.year}</span>}
            <span className="tnum">{shelf.files.length} tracks</span>
            <span className="tnum">{fileSize(shelf.size)}</span>
            {shelf.formats.slice(0, 3).map((f) => (
              <span key={f} className="shelf__fmt">{f}</span>
            ))}
            {shelf.private && <span className="shelf__private">private</span>}
          </span>
        </span>

        <IconChevronDown
          size={14}
          painted={1.5}
          className="dl__chev"
          data-open={open ? 'true' : undefined}
        />
      </button>

      <button
        type="button"
        className="btn pressable shelf__get"
        onPointerDown={() => void transfers.enqueueFolder(username, shelf.path)}
        aria-label={`Download the folder ${shelf.name} from ${username}`}
      >
        <IconDownload size={13} painted={1.5} /> Get folder
      </button>

      {open && (
        <ul className="shelf__files">
          {shelf.files.map((f) => (
            <li key={f.path} className="shelf__file">
              <span className="shelf__track">{fileName(f.path)}</span>
              <span className="shelf__size tnum">{fileSize(f.size)}</span>
              <button
                type="button"
                className="verify pressable"
                onPointerDown={() => void transfers.enqueue(username, f.path, f.size)}
              >
                Get
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BrowseView({
  browse, transfers, signedIn,
}: {
  browse: BrowseSession;
  transfers: TransferSession;
  signedIn: boolean;
}) {
  const [who, setWho] = useState('');
  const [mode, setMode] = useState<BrowseMode>('list');
  const cur = browse.current;

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Browse</h1>
        <form
          className="browse__form"
          onSubmit={(e) => { e.preventDefault(); browse.browse(who.trim()); }}
        >
          <input
            className="settings__input"
            value={who}
            placeholder="Username to browse…"
            aria-label="Username to browse"
            spellCheck={false}
            autoCapitalize="none"
            onChange={(e) => setWho(e.target.value)}
          />
        </form>
      </header>

      <div className="pane__scroll">
        {!signedIn && (
          <div className="empty empty--section">
            <span className="empty__icon"><IconUser size={28} painted={1.3} /></span>
            <p className="empty__title">Not signed in</p>
            <p className="empty__body">Browsing a peer needs a live connection.</p>
          </div>
        )}

        {signedIn && !cur && (
          <div className="empty empty--section">
            <span className="empty__icon"><IconUser size={28} painted={1.3} /></span>
            <p className="empty__title">Nobody open</p>
            <p className="empty__body">
              Type a username above, or open someone from a search result. Browsing shows
              everything they share, grouped as releases.
            </p>
          </div>
        )}

        {cur?.state === 'loading' && (
          <div className="empty empty--section">
            <p className="empty__title">Asking {cur.username}…</p>
            <p className="empty__body">
              Share lists come from the peer directly, so this waits on them being online
              and willing. A large share can take a while.
            </p>
          </div>
        )}

        {cur?.state === 'failed' && (
          <div className="empty empty--section">
            <p className="empty__title">Could not browse {cur.username}</p>
            <p className="empty__body">{cur.reason ?? 'The peer did not answer.'}</p>
          </div>
        )}

        {cur?.state === 'ready' && (
          <div className="browse">
            <div className="browse__bar">
              <span className="browse__who">{cur.username}</span>
              <span className="browse__stat tnum">{cur.fileCount.toLocaleString()} files</span>
              <span className="browse__stat tnum">{fileSize(cur.totalSize)}</span>
              <span className="browse__stat tnum">{browse.shelves.length} releases</span>
              {/* The strongest signal Soulseek can give you about a stranger:
                  their taste overlaps yours where it has been tested. A count,
                  not a percentage — see domain/overlap.ts. */}
              {browse.overlap.count > 0 && (
                <span
                  className="browse__overlap tnum"
                  title={`Already in your library: ${browse.overlap.examples.join(', ')}${
                    browse.overlap.count > browse.overlap.examples.length ? ', …' : ''}`}
                >
                  {browse.overlap.count} in common with your library
                </span>
              )}
              <input
                className="settings__input browse__filter"
                value={browse.filter}
                placeholder="Filter this collection…"
                aria-label="Filter this collection"
                onChange={(e) => browse.setFilter(e.target.value)}
              />
              <SegmentedControl<BrowseMode>
                value={mode}
                segments={MODES}
                onChange={setMode}
                label="How to view this collection"
              />
            </div>

            {browse.shelves.length === 0 ? (
              <p className="settings__hint">
                {cur.fileCount === 0
                  ? 'This user shares nothing.'
                  : 'Nothing here matches that filter.'}
              </p>
            ) : mode === 'map' ? (
              <Treemap
                shelves={browse.shelves}
                onOpen={(s) => { browse.setFilter(s.name); setMode('list'); }}
                onGet={(s) => void transfers.enqueueFolder(cur.username, s.path)}
              />
            ) : mode === 'folders' ? (
              <FolderView
                shelves={browse.shelves}
                onGetFolder={(p) => void transfers.enqueueFolder(cur.username, p)}
                onGetFile={(f) => void transfers.enqueue(cur.username, f.path, f.size)}
              />
            ) : (
              browse.shelves.map((s) => (
                <ShelfRow key={s.path} shelf={s} username={cur.username} transfers={transfers} />
              ))
            )}
          </div>
        )}
      </div>
    </>
  );
}
