/*
 * Seek — your own profile, and who you are talking to.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Two small stores that both answer questions Seek could never answer about
 * ITSELF, only about other people: what does my profile look like, and who am
 * I actually connected to.
 *
 * The profile is not optimistic. `prefsStore` echoes a toggle locally because
 * a toggle cannot fail; a picture path can (the file may not be there), and a
 * description goes through an encode/decode round trip in the sidecar, so the
 * value that comes back is the authority on what was stored.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import { readableError } from '../domain/folders.ts';

export interface Profile {
  username: string;
  description: string;
  picturePath: string;
  /** A data: URI, when the file exists and is under the sidecar's cap. */
  pictureUri: string | null;
  /** Why there is a path but no picture. Empty when nothing is wrong. */
  pictureError: string;
  pictureBytes: number;
  pictureVisible: boolean;
  /** Null before the share index is built — NOT the same as sharing nothing. */
  sharedFiles: number | null;
  sharedFolders: number | null;
  uploadSlots: number;
  freeSlots: boolean;
  queueSize: number;
}

export interface ProfilePatch {
  description?: string;
  picturePath?: string;
  pictureVisible?: boolean;
}

export interface ProfileSession {
  /** Null until the first read lands. */
  profile: Profile | null;
  save(patch: ProfilePatch): Promise<void>;
  saving: boolean;
  /** Why the last save failed, for a line beside the field. */
  error: string | null;
  available: boolean;
}

const NOTHING: Record<keyof ProfilePatch, null> = {
  description: null,
  picturePath: null,
  pictureVisible: null,
};

export function useProfile(client: SidecarClient | null): ProfileSession {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) {
      setProfile(null);
      return;
    }
    void client.request<Profile>('profile.get').then(setProfile).catch(() => {});
  }, [client]);

  const save = useCallback(async (patch: ProfilePatch) => {
    if (!client) throw new Error('Not connected to the engine.');
    setSaving(true);
    setError(null);
    try {
      setProfile(await client.request<Profile>('profile.set', { ...NOTHING, ...patch }));
    } catch (e) {
      const message = readableError(e);
      setError(message);
      throw new Error(message);
    } finally {
      setSaving(false);
    }
  }, [client]);

  return { profile, save, saving, error, available: Boolean(client) };
}

/* --------------------------------------------------------------- connections */

export interface PeerConnection {
  username: string;
  country: string | null;
  downloading: number;
  downloadQueued: number;
  uploading: number;
  uploadQueued: number;
}

export interface ConnectionSnapshot {
  /** Open sockets. Far larger than `peers` — see the view. */
  socketCount: number;
  peers: PeerConnection[];
}

export interface ConnectionsSession {
  snapshot: ConnectionSnapshot;
  available: boolean;
}

const EMPTY: ConnectionSnapshot = { socketCount: 0, peers: [] };

export function useConnections(client: SidecarClient | null): ConnectionsSession {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>(EMPTY);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (!client) {
      setSnapshot(EMPTY);
      setAvailable(false);
      return;
    }
    /* Pushed on change rather than polled: the sidecar checks once a second
     * and only emits when the picture actually differs, so an idle client gets
     * nothing at all. */
    const off = client.on('connections.changed', (d) => {
      setSnapshot(d as ConnectionSnapshot);
      setAvailable(true);
    });
    void client.request<ConnectionSnapshot>('connections.get')
      .then((r) => { setSnapshot(r); setAvailable(true); })
      .catch(() => {});
    return off;
  }, [client]);

  return { snapshot, available };
}
