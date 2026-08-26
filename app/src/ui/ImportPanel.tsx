/*
 * Seek — import an existing Nicotine+ configuration.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * docs/PRODUCT.md §9a: explicit, user-triggered, never on startup, and the UI
 * states what it will read BEFORE it reads it. That is why this is two steps
 * and not one button — `import.inspect` reports what exists without pulling
 * anything across, and `import.apply` takes three independent choices.
 *
 * The password never crosses the socket in either direction. `inspect` returns
 * `hasCredentials` as a boolean; `apply` copies the value config-to-config
 * inside the sidecar process. There is no field on the wire that could carry
 * it, and there are tests in the sidecar asserting the schema cannot acquire
 * one. Nothing here should ever be changed to display or transport a password.
 */

import { useCallback, useState } from 'react';
import type { SidecarClient } from '../data/sidecarClient.ts';

interface ImportSource {
  available: boolean;
  configPath: string;
  hasCredentials: boolean;
  username: string | null;
  folders: string[];
  downloadFolder: string | null;
}

interface ImportResult {
  importedCredentials: boolean;
  importedShares: number;
  importedDownloadFolder: boolean;
}

export function ImportPanel({ client }: { client: SidecarClient | null }) {
  const [source, setSource] = useState<ImportSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const [wantCredentials, setWantCredentials] = useState(true);
  const [wantShares, setWantShares] = useState(false);
  const [wantFolder, setWantFolder] = useState(true);

  const inspect = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      setSource(await client.request<ImportSource>('import.inspect'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [client]);

  /* Deliberately NOT inspecting on mount. `inspect` copies nothing into Seek —
   * it only reports what is on disk — but docs/PRODUCT.md §9a says the UI
   * states what it will read BEFORE it reads it, and auto-running does that in
   * the wrong order. Opening a settings tab should not read a file in the
   * user's home directory unasked. One click is a small price for the rule
   * holding everywhere rather than only where it is inconvenient. */

  const apply = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await client.request<ImportResult>('import.apply', {
          credentials: wantCredentials,
          shares: wantShares,
          downloadFolder: wantFolder,
        }),
      );
      await inspect();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [client, wantCredentials, wantShares, wantFolder, inspect]);

  if (!client) {
    return (
      <p className="settings__hint">
        Import needs a running sidecar. Seek is replaying recorded results.
      </p>
    );
  }

  if (error) {
    return (
      <div className="settings__text">
        <span className="settings__label">Could not read the configuration</span>
        <span className="settings__hint">{error}</span>
        <button type="button" className="btn pressable" onPointerDown={() => void inspect()}>
          Try again
        </button>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="import">
        <p className="settings__hint">
          If you already use Nicotine+, Seek can copy your sign-in details, shared folders and
          download folder across. Checking looks at <code>~/.config/nicotine/config</code> and
          reports what it finds — nothing is copied until you choose it below.
        </p>
        <div className="import__actions">
          <button
            type="button"
            className="btn pressable"
            disabled={busy}
            onPointerDown={() => void inspect()}
          >
            {busy ? 'Checking…' : 'Check for a Nicotine+ configuration'}
          </button>
        </div>
      </div>
    );
  }

  if (!source.available) {
    return (
      <p className="settings__hint">
        No Nicotine+ configuration found at <code>{source.configPath}</code>. You can sign in
        directly once the connection panel lands.
      </p>
    );
  }

  return (
    <div className="import">
      <p className="settings__hint">
        Found a Nicotine+ configuration at <code>{source.configPath}</code>. Nothing has been
        copied. Choose what to bring across:
      </p>

      <ul className="import__choices">
        <li>
          <label>
            <input
              type="checkbox"
              checked={wantCredentials && source.hasCredentials}
              disabled={!source.hasCredentials}
              onChange={(e) => setWantCredentials(e.target.checked)}
            />
            <span>
              Sign-in details
              <em>
                {source.hasCredentials
                  ? `Username ${source.username ?? 'unknown'}, and the saved password. `
                    + 'The password is copied inside the sidecar and never sent to this window.'
                  : 'No saved password in that configuration.'}
              </em>
            </span>
          </label>
        </li>
        <li>
          <label>
            <input
              type="checkbox"
              checked={wantShares}
              disabled={source.folders.length === 0}
              onChange={(e) => setWantShares(e.target.checked)}
            />
            <span>
              Shared folders
              <em>
                {source.folders.length === 0
                  ? 'That configuration shares nothing.'
                  : `${source.folders.length} folder${source.folders.length === 1 ? '' : 's'}. `
                    + 'Sharing is how you stay welcome on Soulseek — peers deprioritise '
                    + 'clients that share nothing.'}
              </em>
            </span>
          </label>
        </li>
        <li>
          <label>
            <input
              type="checkbox"
              checked={wantFolder}
              disabled={!source.downloadFolder}
              onChange={(e) => setWantFolder(e.target.checked)}
            />
            <span>
              Download folder
              <em>{source.downloadFolder ?? 'Not set in that configuration.'}</em>
            </span>
          </label>
        </li>
      </ul>

      <div className="import__actions">
        <button
          type="button"
          className="btn btn--primary pressable"
          disabled={busy || (!wantCredentials && !wantShares && !wantFolder)}
          onPointerDown={() => void apply()}
        >
          {busy ? 'Importing…' : 'Import selected'}
        </button>
        {result && (
          <span className="settings__hint" role="status">
            {result.importedCredentials ? 'Signed-in details imported. ' : ''}
            {result.importedShares > 0 ? `${result.importedShares} folders shared. ` : ''}
            {result.importedDownloadFolder ? 'Download folder set.' : ''}
          </span>
        )}
      </div>
    </div>
  );
}
