/*
 * Seek — preferences and peer history.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Both were previously overstated. Settings existed as React state that reset
 * on every launch behind a notice admitting it, and source scoring advertised
 * "historical success rate with that user" while handing every peer the same
 * neutral prior — an input that never varies is decoration, not a score.
 *
 * Both now live in the sidecar's state file, which is the side of the seam that
 * owns durability. The Discogs token is the one exception to the usual
 * round-trip: it goes down, and only a boolean comes back. A settings screen
 * has no reason to hold a secret it is not about to send.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import { reliabilityFrom } from '../domain/score.ts';

export interface AppSettings {
  /** Sign in on launch using the stored account. Upstream's own flag. */
  autoConnect: boolean;
  hasCredentials: boolean;
  /** The stored account name, so the UI can say whose it is. Never the password. */
  username: string;
  externalLookups: boolean;
  /** Whether a token is stored — never the value itself. */
  discogsToken: boolean;
  artworkCacheMb: number;
  embedArtwork: boolean;
  writeCoverFile: boolean;
  /** Queue the best LOSSLESS source rather than the highest overall score. */
  preferLossless: boolean;
  minBitrate: number;
  rejectTranscodes: boolean;
  autoOrganise: boolean;
  /** Group a burst of want list additions into a digging session. */
  autoDigSessions: boolean;
  /** Whether an AcoustID key is stored — never the value. */
  acoustidApiKey: boolean;
  /** Whether a YouTube Data API key is stored — never the value. */
  youtubeApiKey: boolean;
}

export interface PeerRecord {
  username: string;
  ok: number;
  failed: number;
  lastSeen: number;
}

const DEFAULTS: AppSettings = {
  autoConnect: true,
  hasCredentials: false,
  username: '',
  externalLookups: true,
  discogsToken: false,
  artworkCacheMb: 500,
  embedArtwork: true,
  writeCoverFile: false,
  preferLossless: false,
  minBitrate: 0,
  rejectTranscodes: false,
  autoOrganise: false,
  autoDigSessions: true,
  acoustidApiKey: false,
  youtubeApiKey: false,
};

/**
 * The patch shape, written out rather than derived from AppSettings. Deriving
 * it collapsed `discogsToken` to `never`: the settings type carries a boolean
 * (is one stored?) while a patch carries the string itself, and intersecting
 * those two leaves nothing assignable.
 */
export interface AppSettingsPatch {
  autoConnect?: boolean;
  externalLookups?: boolean;
  discogsToken?: string;
  artworkCacheMb?: number;
  embedArtwork?: boolean;
  writeCoverFile?: boolean;
  preferLossless?: boolean;
  minBitrate?: number;
  rejectTranscodes?: boolean;
  autoOrganise?: boolean;
  autoDigSessions?: boolean;
  acoustidApiKey?: string;
  youtubeApiKey?: string;
}

export interface PrefsSession {
  settings: AppSettings;
  patch(p: AppSettingsPatch): void;
  /** 0..1, Laplace-smoothed. 0.5 for a peer we have never transferred from. */
  reliability(username: string): number;
  peers: Map<string, PeerRecord>;
  saving: boolean;
  /** Why the last save failed, or null. Settings shows it; nothing else may
   *  claim a save succeeded while this is set. */
  saveError: string | null;
  available: boolean;
}

export function usePrefs(client: SidecarClient | null): PrefsSession {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [peers, setPeers] = useState<Map<string, PeerRecord>>(() => new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;

    const offSettings = client.on('app.settings', (d) => setSettings(d as AppSettings));
    const offPeers = client.on('peers.stats', (d) => {
      const items = (d as { items: PeerRecord[] }).items ?? [];
      setPeers(new Map(items.map((p) => [p.username, p])));
    });

    void client.request<AppSettings>('app.settings.get').then(setSettings).catch(() => {});
    void client.request<{ items: PeerRecord[] }>('peers.stats')
      .then((r) => setPeers(new Map((r.items ?? []).map((p) => [p.username, p]))))
      .catch(() => {});

    return () => { offSettings(); offPeers(); };
  }, [client]);

  const patch = useCallback((p: AppSettingsPatch) => {
    if (!client) return;
    // Optimistic, because a toggle that waits on a round trip feels broken —
    // but the server's answer is authoritative and replaces this.
    // Optimistic for the plain toggles only. `discogsToken` is a string going
    // down and a boolean coming back, so echoing it locally would put the wrong
    // type in state until the reply lands.
    const { discogsToken, acoustidApiKey, youtubeApiKey, ...echoable } = p;
    setSettings((s) => ({
      ...s,
      ...echoable,
      ...(discogsToken === undefined ? {} : { discogsToken: Boolean(discogsToken.trim()) }),
      ...(acoustidApiKey === undefined ? {} : { acoustidApiKey: Boolean(acoustidApiKey.trim()) }),
      ...(youtubeApiKey === undefined ? {} : { youtubeApiKey: Boolean(youtubeApiKey.trim()) }),
    }));
    setSaving(true);
    void client.request<AppSettings>('app.settings.patch', {
      autoConnect: null,
      externalLookups: null,
      discogsToken: null,
      acoustidApiKey: null,
      // Its absence made EVERY settings save fail. `Optional` in the sidecar's
      // schema means nullable, not omittable, and validate_struct rejects a
      // missing key as hard as an unknown one — so one forgotten line here
      // silently broke every toggle and every key on this screen. Reported from
      // real use as "i pasted and saved the token, now it says token needed".
      youtubeApiKey: null,
      artworkCacheMb: null,
      embedArtwork: null,
      writeCoverFile: null,
      preferLossless: null,
      minBitrate: null,
      rejectTranscodes: null,
      autoOrganise: null,
      autoDigSessions: null,
      ...p,
    })
      .then((saved) => {
        setSettings(saved);
        setError(null);
      })
      /* NOT swallowed. The optimistic update above has already told the user
       * their token is stored; if the write then fails, silence turns a
       * recoverable error into "the app is lying to me". Re-reading the real
       * settings afterwards undoes the optimistic claim. */
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        void client.request<AppSettings>('app.settings.get')
          .then(setSettings)
          .catch(() => {});
      })
      .finally(() => setSaving(false));
  }, [client]);

  return {
    settings,
    patch,
    peers,
    reliability: (username) => {
      const p = peers.get(username);
      return reliabilityFrom(p?.ok ?? 0, p?.failed ?? 0);
    },
    saving,
    saveError: error,
    available: Boolean(client),
  };
}
