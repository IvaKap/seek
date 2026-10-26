/*
 * Seek — the details beneath Collector's Downloads table: one release's
 * tracks, the peer it is coming from, and where its folder is, after the
 * Downloads · Collector board.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Table density only. The table keeps one line per release and its rows do
 * not open in place; choosing one shows it here instead, so the list stays
 * the same height while you look into a release.
 *
 * Everything said about the peer is from your own downloads: the protocol
 * says nothing about how a stranger treats anyone else (PRODUCT §8).
 */

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { TransferGroup } from '../data/transferStore.ts';
import { firstFinished } from '../data/transferStore.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import type { PeerPictureCache } from '../data/peerProfiles.ts';
import { isAudioPath } from '../data/adapt.ts';
import { copyText } from '../data/clipboard.ts';
import { count, fileSize } from '../domain/format.ts';
import { Cover, ReleaseName } from './transferBits.tsx';
import { FormatBadge } from './rows.tsx';
import { PeerAvatar } from './PeerAvatar.tsx';
import { PeerHistory } from './PeerHistory.tsx';
import type { PeerLookup } from './PeerHistory.tsx';
import { another, formatOf } from './DownloadsSimple.tsx';
import { statusOf } from './CornerPanel.tsx';
import { IconClose } from '../icons/index.tsx';

type Tab = 'tracks' | 'peer' | 'folder';

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'tracks', label: 'Tracks' },
  { value: 'peer', label: 'Peer' },
  { value: 'folder', label: 'Folder' },
];

export function DownloadInspector({
  g, groups, artwork, pictures, peers, tracks, onReveal, onBrowse, onFindAnother, onClose,
}: {
  g: TransferGroup;
  /** Every release in Downloads, to say how many come from this peer. */
  groups: TransferGroup[];
  artwork?: ArtworkSession;
  pictures: PeerPictureCache;
  peers?: PeerLookup;
  /** The release's files, the same rows a card opens to. */
  tracks: ReactNode;
  onReveal(id: string): void;
  onBrowse?(username: string): void;
  onFindAnother?(query: string): void;
  onClose(): void;
}) {
  const id = useId();
  const [tab, setTab] = useState<Tab>('tracks');
  const format = formatOf(g);
  const status = statusOf(g);
  const theirs = groups.filter((x) => x.username === g.username).length;
  const audio = g.transfers.filter((t) => isAudioPath(t.path)).length;
  const others = g.transfers.length - audio;
  const done = firstFinished(g);
  const local = g.transfers.find((t) => t.localFolder)?.localFolder ?? null;

  return (
    <section className="inspector" aria-labelledby={`${id}-h`}>
      <div className="inspector__head">
        <Cover g={g} artwork={artwork} />
        <div className="inspector__what">
          <h2 className="inspector__title" id={`${id}-h`}><ReleaseName g={g} /></h2>
          <span className="inspector__sub" title={g.folder}>
            {g.username} · {g.folder}
          </span>
        </div>
        {format && <FormatBadge label={format.label} tier={format.tier} />}
        <div className="tabset" role="tablist" aria-label="Details">
          {TABS.map((t) => (
            <span key={t.value} className="tabset__tab" data-on={tab === t.value ? 'true' : undefined}>
              <button
                type="button"
                role="tab"
                id={`${id}-${t.value}`}
                aria-selected={tab === t.value}
                aria-controls={`${id}-panel`}
                className="tabset__label"
                onClick={() => setTab(t.value)}
              >
                {t.label}
              </button>
            </span>
          ))}
        </div>
        <button type="button" className="inspector__close" aria-label="Close the details" onClick={onClose}>
          <IconClose size={12} painted={1.7} />
        </button>
      </div>

      <div className="inspector__body" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {tab === 'tracks' && tracks}

        {tab === 'peer' && (
          <>
            <dl className="facts">
              <dt>Peer</dt>
              <dd className="facts__who">
                <PeerAvatar username={g.username} pictureUri={pictures.get(g.username)} size={20} />
                {g.username}
                <PeerHistory username={g.username} peers={peers} />
              </dd>
              <dt>Right now</dt>
              <dd className="tnum" data-tone={status.tone}>{status.text}</dd>
              <dt>In Downloads</dt>
              <dd className="tnum">{count(theirs, 'release')} from them</dd>
            </dl>
            <div className="inspector__actions">
              {onBrowse && (
                <button type="button" className="btn pressable" onClick={() => onBrowse(g.username)}>
                  Browse their files
                </button>
              )}
              {onFindAnother && (
                <button
                  type="button"
                  className="btn pressable"
                  title="Search for this release, to pick a copy from someone else"
                  onClick={() => onFindAnother(another(g))}
                >
                  Find another copy
                </button>
              )}
            </div>
          </>
        )}

        {tab === 'folder' && (
          <>
            <dl className="facts">
              <dt>Their folder</dt>
              <dd className="facts__path">{g.folder}</dd>
              <dt>{done ? 'Saved in' : 'Saving to'}</dt>
              <dd className="facts__path">{local ?? 'Your download folder'}</dd>
              <dt>Files</dt>
              <dd className="tnum">
                {count(audio, 'track')}
                {others > 0 && ` · ${count(others, 'other file')}`}
                {' · '}{fileSize(g.size)}
              </dd>
            </dl>
            <div className="inspector__actions">
              {done && (
                <button type="button" className="btn pressable" onClick={() => onReveal(done.id)}>
                  Show in Finder
                </button>
              )}
              <button type="button" className="btn pressable" onClick={() => { void copyText(g.folder); }}>
                Copy their folder path
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
