/*
 * Seek — small peer profile pictures, fetched lazily and cached.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Downloads can show transfers from many different peers at once, unlike
 * Browse's one-at-a-time peer header — so this is a MAP keyed by username,
 * not a single slot. A picture is requested once per username and kept for
 * the session; most peers have set nothing at all, which is cached as `null`
 * too, so a peer with no picture is not re-requested on every render.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';

export interface PeerPictureCache {
  /** The peer's picture, or undefined if never requested (or still in flight). */
  get(username: string): string | null | undefined;
  /** Fetch this peer's picture if it hasn't been asked for yet. Idempotent — safe every render. */
  request(username: string): void;
}

export function usePeerPictures(client: SidecarClient | null): PeerPictureCache {
  const [pictures, setPictures] = useState<Map<string, string | null>>(new Map());
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!client) return;
    const offResult = client.on('user.info.result', (data) => {
      const d = data as { username: string; pictureUri: string | null };
      setPictures((prev) => (
        prev.get(d.username) === d.pictureUri ? prev : new Map(prev).set(d.username, d.pictureUri)
      ));
    });
    const offFailed = client.on('user.info.failed', (data) => {
      const d = data as { username: string };
      setPictures((prev) => (prev.has(d.username) ? prev : new Map(prev).set(d.username, null)));
    });
    return () => { offResult(); offFailed(); };
  }, [client]);

  const request = useCallback((username: string) => {
    if (!client || requested.current.has(username)) return;
    requested.current.add(username);
    void client.request('user.info.get', { username }).catch(() => {
      setPictures((prev) => (prev.has(username) ? prev : new Map(prev).set(username, null)));
    });
  }, [client]);

  const get = useCallback((username: string) => pictures.get(username), [pictures]);

  return { get, request };
}
