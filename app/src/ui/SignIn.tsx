/*
 * Seek — manual Soulseek sign-in.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The import path copies credentials config-to-config without the password ever
 * crossing the socket. This path cannot do that: to authenticate an account
 * Seek has never seen, the password has to be transmitted once. The socket is
 * loopback-only and token-gated, which is the standard posture for local IPC,
 * but it is a real difference from the import path and worth being plain about.
 *
 * What this component must never do: echo the password back, put it in a URL,
 * log it, keep it after the request, or persist it in the frontend. It lives in
 * component state for exactly as long as it takes to send.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SidecarClient } from '../data/sidecarClient.ts';
import { isSignedIn } from '../data/searchStore.ts';
import { EngineBusyError } from '../data/sidecarClient.ts';

export function SignIn({
  client, state, settings,
}: {
  client: SidecarClient | null;
  /** Soulseek connection state, not the socket's. */
  state: string | null;
  /** So the form can say whose account is remembered. */
  settings?: { hasCredentials: boolean; username: string };
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Not an error. The connect command is queued on the engine's one thread
   * and has not been answered yet; `connection.state` is what settles it. */
  const [notice, setNotice] = useState<string | null>(null);

  const connected = isSignedIn(state);

  // Surface the server's own rejection — a wrong password reports through this
  // event, not as a failed command, because the login is asynchronous.
  useEffect(() => {
    if (!client) return;
    return client.on('connection.state', (data) => {
      const d = data as { status?: string; error?: string | null };
      if (d.error) {
        setError(d.error);
        setNotice(null);
        setBusy(false);
      } else if (isSignedIn(d.status ?? null)) {
        setBusy(false);
        setNotice(null);
        setPassword('');   // no reason to keep it in memory once it worked
      }
    });
  }, [client]);

  const connect = useCallback(async (useStored: boolean) => {
    if (!client) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.request('connection.connect', {
        username: useStored ? null : username.trim() || null,
        password: useStored ? null : password || null,
      });
      if (!useStored) setPassword('');
    } catch (e) {
      /* A busy engine is not a failed sign-in. The first user was shown
       * "timed out waiting for connection.connect" and WAS logged in — the
       * command was sitting behind a first-launch share scan, and it ran.
       * So: stay busy, say so, and let `connection.state` decide. */
      if (e instanceof EngineBusyError) {
        setNotice('Still signing in — the engine is busy on first launch. '
          + 'This will finish on its own.');
        return;
      }
      setError((e as Error).message);
      setBusy(false);
    }
  }, [client, username, password]);

  const disconnect = useCallback(() => {
    void client?.request('connection.disconnect').catch(() => {});
  }, [client]);

  if (!client) {
    return (
      <p className="settings__hint">
        Signing in needs a running sidecar. Seek is replaying recorded results.
      </p>
    );
  }

  if (connected) {
    return (
      <div className="signin">
        <p className="settings__hint">
          Signed in{settings?.username ? <> as <strong>{settings.username}</strong></> : ''}.
          Seek signs in again automatically next launch.
        </p>
        <div className="import__actions">
          <button type="button" className="btn pressable" onPointerDown={disconnect}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="signin"
      onSubmit={(e) => { e.preventDefault(); void connect(false); }}
    >
      <p className="settings__hint">
        {settings?.hasCredentials
          ? <>Signed out. <strong>{settings.username || 'An account'}</strong> is
              remembered — <em>Use stored details</em> signs back in without the
              password passing through this window.</>
          : <>Sign in with your Soulseek account. Seek remembers it, so this is a
              one-time step.</>}
      </p>

      <label className="signin__field">
        <span>Username</span>
        <input
          className="settings__input"
          value={username}
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="none"
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>

      <label className="signin__field">
        <span>Password</span>
        <input
          className="settings__input"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      {error && <p className="signin__error" role="alert">{error}</p>}
      {notice && !error && <p className="signin__notice" role="status">{notice}</p>}

      <div className="import__actions">
        <button
          type="submit"
          className="btn btn--primary pressable"
          disabled={busy || !username.trim() || !password}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button
          type="button"
          className="btn pressable"
          disabled={busy}
          onPointerDown={() => void connect(true)}
        >
          Use stored details
        </button>
      </div>

      <p className="settings__hint">
        Soulseek accounts are created by signing in — the server registers the
        name the first time it sees it. There is no separate sign-up.
      </p>
    </form>
  );
}
