/*
 * Seek — hear it before you commit to the rest.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * An excerpt, not a player. The brief puts a short preview in scope and a full
 * player firmly out of it, and the sidecar honours that literally: it decodes a
 * slice, downmixes to mono and drops the rate, so a fifteen-second listen is
 * ~650 KB rather than a 50 MB FLAC crossing a WebSocket.
 *
 * Starting a little way in is deliberate. Track one of most electronic releases
 * opens on silence or a long intro, and a preview that plays two seconds of
 * nothing tells you nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from '../data/sidecarClient.ts';

interface PreviewResult {
  requestId: string;
  path: string;
  dataUri: string;
  startSeconds: number;
  seconds: number;
  durationSeconds: number;
}

/** Far enough in to be past an intro, early enough to still be the track. */
const DEFAULT_START = 45;
const DEFAULT_LENGTH = 20;

export interface PreviewSession {
  /** Currently loading or playing, by transfer id. */
  activeId: string | null;
  state: 'idle' | 'loading' | 'playing' | 'failed';
  error: string | null;
  toggle(transferId: string): void;
  stop(): void;
  available: boolean;
}

export function usePreview(client: SidecarClient | null): PreviewSession {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [state, setState] = useState<PreviewSession['state']>('idle');
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingFor = useRef<string | null>(null);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      // Release the data URI: these are megabytes, and holding several alive
      // because the element still points at them is a real leak.
      audio.removeAttribute('src');
      audio.load();
    }
    pendingFor.current = null;
    setActiveId(null);
    setState('idle');
  }, []);

  useEffect(() => {
    if (!client) return;

    const offResult = client.on('preview.result', (d) => {
      const r = d as PreviewResult;
      // A result for a preview we already cancelled must not start playing.
      if (!pendingFor.current) return;

      let audio = audioRef.current;
      if (!audio) {
        audio = new Audio();
        audio.addEventListener('ended', () => setState('idle'));
        audioRef.current = audio;
      }
      audio.src = r.dataUri;
      void audio.play()
        .then(() => setState('playing'))
        .catch((e: Error) => { setError(e.message); setState('failed'); });
    });

    const offFailed = client.on('preview.failed', (d) => {
      if (!pendingFor.current) return;
      setError((d as { reason: string }).reason);
      setState('failed');
    });

    return () => { offResult(); offFailed(); };
  }, [client]);

  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const toggle = useCallback((transferId: string) => {
    if (!client) return;
    // Same row again means stop — Space is a toggle, not a restart.
    if (activeId === transferId && (state === 'playing' || state === 'loading')) {
      stop();
      return;
    }
    audioRef.current?.pause();
    setError(null);
    setActiveId(transferId);
    setState('loading');
    pendingFor.current = transferId;
    void client.request('preview.get', {
      path: null,
      transferId,
      startSeconds: DEFAULT_START,
      seconds: DEFAULT_LENGTH,
    }).catch((e: Error) => { setError(e.message); setState('failed'); });
  }, [client, activeId, state, stop]);

  return { activeId, state, error, toggle, stop, available: Boolean(client) };
}

/** The per-file control. */
export function PreviewButton({
  id, preview,
}: {
  id: string;
  preview: PreviewSession;
}) {
  const mine = preview.activeId === id;
  const label = mine && preview.state === 'loading' ? 'Decoding…'
    : mine && preview.state === 'playing' ? 'Stop'
      : mine && preview.state === 'failed' ? 'No preview'
        : 'Preview';

  return (
    <button
      type="button"
      className="verify pressable"
      data-tone={mine && preview.state === 'playing' ? 'good' : undefined}
      disabled={!preview.available}
      title={mine && preview.state === 'failed' && preview.error
        ? preview.error
        : 'Play a short excerpt — Space'}
      onPointerDown={() => preview.toggle(id)}
    >
      {label}
    </button>
  );
}
