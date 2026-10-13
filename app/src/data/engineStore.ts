/*
 * Seek — the engine's own configuration, as distinct from Seek's preferences.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Two settings stores exist and the split is deliberate:
 *
 *   `prefsStore`   Seek's preferences — quality rules, artwork, API keys.
 *                  Lives in `<dataFolder>/seek-state.json`, which Seek owns.
 *   this file      pynicotine's configuration — where files land, which port
 *                  listens, speed limits, slots, what is shared. Lives in the
 *                  Nicotine+ config, because upstream reads it from there and
 *                  nowhere else.
 *
 * Every command here already existed in the sidecar and was tested; nothing in
 * the UI had ever called one. `settings.get`, `settings.patch`, `shares.get`,
 * `shares.set` and `shares.rescan` were all reachable from a socket and from
 * no screen, which is why someone who had never used Nicotine+ had no way to
 * say where their downloads should go.
 *
 * Unlike `prefsStore`, saving here is NOT optimistic. A toggle can echo
 * locally because it cannot fail; a folder can, and a field that shows the new
 * path for half a second before snapping back to the old one — with the reason
 * arriving separately — is worse than one that simply waits.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import type { PathFacts } from '../domain/folders.ts';
import { readableError } from '../domain/folders.ts';
import { readUntilAnswered } from './failures.ts';

/** `Settings` on the wire. Bytes/sec throughout; upstream's KiB/s is the
 * sidecar's problem, not ours. */
interface EngineSettings {
  downloadFolder: string | null;
  incompleteFolder: string | null;
  listenPort: number;
  maxDownloadSpeed: number;
  maxUploadSpeed: number;
  uploadSlots: number;
  autoConnect: boolean;
  stallSeconds: number;
  portMapping: boolean;
  /** Minutes without input before showing as away. 0 = never. */
  autoAwayMinutes: number;
  /** Sent once to each person who messages you while away. '' = none. */
  autoReply: string;
  /** Buddies go to the front of the upload queue. */
  preferBuddies: boolean;
  /** First come, first served, instead of one file per person in turn. */
  fifoQueue: boolean;
  /** Most files one person may queue from you. 0 = no limit. */
  queueLimitFiles: number;
  /** Most megabytes one person may queue from you. 0 = no limit. */
  queueLimitMb: number;
  /** The two limits above do not apply to buddies. */
  buddiesUnlimited: boolean;
}

type EngineSettingsPatch = Partial<EngineSettings>;

type ShareConsent = 'unset' | 'granted' | 'declined';

export interface SharedFolder {
  virtualName: string;
  path: string;
  exists: boolean;
}

interface ShareState {
  consent: ShareConsent;
  folders: SharedFolder[];
  scanning: boolean;
  ready: boolean;
  fileCount: number | null;
  folderCount: number | null;
  totalSize: number | null;
  lastScanAt: number | null;
  restartRequired: boolean;
  /** Shared folders that stopped the last rescan because they could not be
   * read. Until this is empty, peers see the index from before. */
  unavailable: string[];
}

export interface EngineSession {
  /** Null until the first read lands, so the UI can tell "not yet" from "zero". */
  settings: EngineSettings | null;
  shares: ShareState | null;
  /** Resolves on success; rejects with a sentence fit for display. */
  save(patch: EngineSettingsPatch): Promise<EngineSettings>;
  /** Read the settings again — after an import has changed them underneath. */
  reload(): void;
  setShares(consent: ShareConsent, folders: SharedFolder[]): Promise<ShareState>;
  rescan(force?: boolean): Promise<void>;
  check(path: string): Promise<PathFacts>;
  ensureFolder(path: string): Promise<PathFacts>;
  /** Our public IP as the Soulseek server sees it. Null unless signed in. */
  publicAddress: string | null;
  saving: boolean;
  available: boolean;
}

/**
 * A patch is sent with every key present, `null` meaning "leave this alone" —
 * the generated validator rejects a missing field. `prefsStore` does the same
 * for the same reason.
 */
const NOTHING: Record<keyof EngineSettings, null> = {
  downloadFolder: null,
  incompleteFolder: null,
  listenPort: null,
  maxDownloadSpeed: null,
  maxUploadSpeed: null,
  uploadSlots: null,
  autoConnect: null,
  stallSeconds: null,
  portMapping: null,
  autoAwayMinutes: null,
  autoReply: null,
  preferBuddies: null,
  fifoQueue: null,
  queueLimitFiles: null,
  queueLimitMb: null,
  buddiesUnlimited: null,
};

export function useEngine(client: SidecarClient | null): EngineSession {
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const [shares, setShares] = useState<ShareState | null>(null);
  const [publicAddress, setPublicAddress] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!client) {
      // Offline mode replays a fixture and has no engine behind it. Drop any
      // state from a previous connection rather than leaving the last-known
      // folder on screen as though it were still in force.
      setSettings(null);
      setShares(null);
      setPublicAddress(null);
      return;
    }

    const offShares = client.on('shares.state', (d) => setShares(d as ShareState));
    /* The address is only meaningful while signed in, and the event carries it
     * as null when we are not — so this follows the connection rather than
     * latching the last address we saw. */
    const offConn = client.on('connection.state', (d) => {
      setPublicAddress((d as { publicAddress?: string | null }).publicAddress ?? null);
    });

    // Asked until answered: a single failed read on a busy first launch left
    // Settings showing "No folder set" and port 0 as though they were saved.
    const stopSettings = readUntilAnswered<{ settings: EngineSettings }>(
      client, 'settings.get', undefined, (r) => setSettings(r.settings),
    );
    const stopShares = readUntilAnswered<ShareState>(client, 'shares.get', undefined, setShares);

    return () => { offShares(); offConn(); stopSettings(); stopShares(); };
  }, [client]);

  const save = useCallback(async (patch: EngineSettingsPatch) => {
    if (!client) throw new Error('Not connected to the engine.');
    setSaving(true);
    try {
      const reply = await client.request<{ settings: EngineSettings }>(
        'settings.patch', { settings: { ...NOTHING, ...patch } },
      );
      setSettings(reply.settings);
      return reply.settings;
    } catch (error) {
      // Rethrow the sentence, not the frame. Every caller here is a form that
      // wants to put this next to a field.
      throw new Error(readableError(error));
    } finally {
      setSaving(false);
    }
  }, [client]);

  const reload = useCallback(() => {
    if (!client) return;
    void client.request<{ settings: EngineSettings }>('settings.get')
      .then((r) => setSettings(r.settings))
      .catch(() => { /* the next read on reconnect will catch up */ });
  }, [client]);

  const applyShares = useCallback(async (consent: ShareConsent, folders: SharedFolder[]) => {
    if (!client) throw new Error('Not connected to the engine.');
    setSaving(true);
    try {
      const state = await client.request<ShareState>('shares.set', { consent, folders });
      setShares(state);
      return state;
    } catch (error) {
      throw new Error(readableError(error));
    } finally {
      setSaving(false);
    }
  }, [client]);

  const rescan = useCallback(async (force = false) => {
    if (!client) throw new Error('Not connected to the engine.');
    try {
      await client.request('shares.rescan', { force });
    } catch (error) {
      throw new Error(readableError(error));
    }
  }, [client]);

  const check = useCallback(async (path: string) => {
    if (!client) throw new Error('Not connected to the engine.');
    return client.request<PathFacts>('fs.check', { path });
  }, [client]);

  const ensureFolder = useCallback(async (path: string) => {
    if (!client) throw new Error('Not connected to the engine.');
    try {
      return await client.request<PathFacts>('fs.ensureFolder', { path });
    } catch (error) {
      throw new Error(readableError(error));
    }
  }, [client]);

  return {
    settings,
    shares,
    save,
    reload,
    setShares: applyShares,
    rescan,
    check,
    ensureFolder,
    publicAddress,
    saving,
    available: Boolean(client),
  };
}
