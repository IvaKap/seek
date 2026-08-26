/*
 * Seek — your own profile, and who you are connected to.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Both live in Settings rather than in the sidebar, and both for the same
 * reason the backlog gives: the profile is account configuration, so it
 * belongs beside sign-in; the connections list "pairs with 1c", the Network
 * tab, which is already the place that answers "what is my network doing".
 * Neither earns a permanent nav item — one is edited about twice, and the
 * other is a diagnostic you go and look at.
 *
 * WHAT THE PROFILE SHOWS IS WHAT A PEER SEES. That is the whole point of it,
 * and it is why the shared-file count and the slot figures are here beside the
 * two editable fields: those travel with your description whether you think
 * about them or not, and they are most of what a stranger judges you on.
 */

import { useEffect, useRef, useState } from 'react';
import { Group, Row } from './SettingsView.tsx';
import { Toggle } from './controls.tsx';
import { Flag } from './Flag.tsx';
import { canChooseFolder, chooseImage } from '../data/choose.ts';
import type { ConnectionsSession, ProfileSession } from '../data/profileStore.ts';
import { fileSize } from '../domain/format.ts';
import { IconFolderOpen, IconUser } from '../icons/index.tsx';

/* ------------------------------------------------------------------ profile */

export function ProfilePanel({ profile: session }: { profile: ProfileSession }) {
  const { profile } = session;
  const [draft, setDraft] = useState('');
  const committed = useRef('');

  /* Follow the engine when it changes underneath — after a save, or after an
   * import brought a description with it — but never over what is being
   * typed. Same rule as the folder fields. */
  useEffect(() => {
    if (profile && profile.description !== committed.current) {
      committed.current = profile.description;
      setDraft(profile.description);
    }
  }, [profile]);

  if (!profile) {
    return (
      <Group title="Your profile">
        <div className="settings__row settings__row--block">
          <p className="settings__hint">
            Your profile lives in the engine's configuration, so it arrives with
            the connection.
          </p>
        </div>
      </Group>
    );
  }

  const dirty = draft !== profile.description;

  const pickPicture = () => {
    void chooseImage('Choose a profile picture', profile.picturePath || null)
      .then((picked) => {
        if (picked) void session.save({ picturePath: picked }).catch(() => {});
      });
  };

  return (
    <Group
      title="Your profile"
      footnote="This is what someone sees when they look you up — the description, the picture, and how much you are sharing. Peers do judge queue position on it."
    >
      <div className="settings__row settings__row--block">
        <div className="profile__head">
          <span className="profile__pic" aria-hidden={!profile.pictureUri}>
            {profile.pictureUri
              ? <img className="profile__img" src={profile.pictureUri} alt="Your profile picture" />
              : <IconUser size={22} painted={1.3} />}
          </span>
          <div className="profile__facts">
            <span className="settings__label">{profile.username || 'Not signed in'}</span>
            <span className="settings__hint tnum">
              {/* Null is "the index has not been built", which is a different
                  statement from sharing nothing — and the one that matters,
                  because the second gets you throttled. */}
              {profile.sharedFiles === null
                ? 'Share index not built yet'
                : `${profile.sharedFiles.toLocaleString()} files in ${(profile.sharedFolders ?? 0).toLocaleString()} folders shared`}
            </span>
            <span className="settings__hint tnum">
              {profile.uploadSlots} upload {profile.uploadSlots === 1 ? 'slot' : 'slots'}
              {' · '}
              {profile.freeSlots ? 'a slot is free' : 'all slots busy'}
              {profile.queueSize > 0 && <> · {profile.queueSize} queued on you</>}
            </span>
          </div>
        </div>
      </div>

      <div className="settings__row settings__row--block">
        <div className="folderset__head">
          <span className="settings__label">Description</span>
          <span className="settings__hint">
            Free text. Plenty of people write what they collect and what they
            will not share.
          </span>
        </div>
        <textarea
          className="settings__input profile__descr"
          rows={4}
          value={draft}
          spellCheck
          placeholder="Say something about what you collect…"
          aria-label="Your profile description"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setDraft(profile.description); }}
        />
        {dirty && (
          <div className="folderset__controls">
            <button
              type="button"
              className="btn btn--primary pressable"
              disabled={session.saving}
              onPointerDown={() => {
                committed.current = draft;
                void session.save({ description: draft }).catch(() => {});
              }}
            >
              {session.saving ? 'Saving…' : 'Save description'}
            </button>
            <button
              type="button"
              className="btn pressable"
              onPointerDown={() => setDraft(profile.description)}
            >
              Revert
            </button>
          </div>
        )}
        {session.error && (
          <p className="folderset__verdict" data-tone="error" role="alert">{session.error}</p>
        )}
      </div>

      <div className="settings__row settings__row--block">
        <div className="folderset__head">
          <span className="settings__label">Picture</span>
          {profile.picturePath && (
            <span className="settings__hint profile__path">
              {profile.picturePath}
              {profile.pictureBytes > 0 && <> · {fileSize(profile.pictureBytes)}</>}
            </span>
          )}
        </div>
        <div className="folderset__controls">
          {canChooseFolder() && (
            <button type="button" className="btn pressable" onPointerDown={pickPicture}>
              <IconFolderOpen size={14} painted={1.5} />
              <span>{profile.picturePath ? 'Change…' : 'Choose a picture…'}</span>
            </button>
          )}
          {profile.picturePath && (
            <button
              type="button"
              className="btn pressable"
              onPointerDown={() => { void session.save({ picturePath: '' }).catch(() => {}); }}
            >
              Remove
            </button>
          )}
          {!canChooseFolder() && !profile.picturePath && (
            <span className="settings__hint">
              Choosing a picture needs the desktop app; this is the browser build.
            </span>
          )}
        </div>
        {/* A path outlives the file it points at, and this is the screen where
            you would fix that — so it reports rather than failing. */}
        {profile.pictureError && (
          <p className="folderset__verdict" data-tone="warn">{profile.pictureError}</p>
        )}
      </div>

      <Row
        label="Send the picture to peers"
        hint="Off keeps the description and shows no picture at all."
        control={(
          <Toggle
            checked={profile.pictureVisible}
            onChange={(v) => { void session.save({ pictureVisible: v }).catch(() => {}); }}
            label="Send the picture to peers"
          />
        )}
      />
    </Group>
  );
}

/* -------------------------------------------------------------- connections */

export function ConnectionsPanel({ connections }: { connections: ConnectionsSession }) {
  const { snapshot, available } = connections;
  const peers = snapshot.peers;

  return (
    <Group
      title="Connected right now"
      footnote="Seek can only name peers it has a transfer with. The socket total is far larger because most connections carry the DISTRIBUTED SEARCH network — you relay other people's searches, which is Soulseek working rather than anything wrong. Upstream keeps its socket table inside the network thread, and Seek does not modify upstream."
    >
      <Row
        label="Open sockets"
        hint="Everything the network thread is holding, in both directions."
        control={(
          <span className="settings__static tnum">
            {available ? snapshot.socketCount.toLocaleString() : '—'}
          </span>
        )}
      />

      {peers.length === 0 ? (
        <div className="settings__row settings__row--block">
          <p className="settings__hint">
            {available
              ? (
                <>
                  Nothing is running or queued with anyone right now.
                  {/* Worth saying, because a full download list beside "nobody"
                      reads as a bug. Upstream moves a transfer OUT of the
                      queued set the moment its peer drops (`_abort_transfer`
                      dequeues before it fails), so files waiting on someone who
                      has gone offline are in Downloads and on no connection —
                      which is exactly why they are not moving. */}
                  {' '}Downloads waiting on a peer who has gone offline are not
                  connections, so they are not listed here.
                </>
              )
              : 'Not connected to the engine.'}
          </p>
        </div>
      ) : (
        peers.map((peer) => (
          <div className="settings__row conn" key={peer.username}>
            <div className="settings__text">
              <span className="settings__label conn__who">
                <Flag code={peer.country} />
                {peer.username}
              </span>
            </div>
            <div className="settings__control conn__dirs tnum">
              {/* Only the directions that are actually doing something. A row
                  of four zeros beside a peer says nothing. */}
              {peer.downloading > 0 && (
                <span className="conn__dir" data-dir="down">↓ {peer.downloading}</span>
              )}
              {peer.downloadQueued > 0 && (
                <span className="conn__dir conn__dir--queued">↓ {peer.downloadQueued} queued</span>
              )}
              {peer.uploading > 0 && (
                <span className="conn__dir" data-dir="up">↑ {peer.uploading}</span>
              )}
              {peer.uploadQueued > 0 && (
                <span className="conn__dir conn__dir--queued">↑ {peer.uploadQueued} queued</span>
              )}
            </div>
          </div>
        ))
      )}
    </Group>
  );
}
