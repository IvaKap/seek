/*
 * Seek — the one line that says a newer version exists.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Deliberately a strip along the bottom rather than a modal. An update is never
 * urgent, and a dialog over the top of a running queue treats it as though it
 * were — the one moment someone is most likely to be mid-download is the moment
 * they launched the app to get something.
 *
 * It says the version, offers to install, and takes no for an answer.
 */

import type { UpdateState } from '../data/updateStore.ts';

export function UpdateBanner({
  state, onInstall, onDismiss,
}: {
  state: UpdateState;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  // 'idle' is the overwhelmingly common case and says nothing. 'failed' is
  // silent too: being unable to reach GitHub is not something the person using
  // the app can act on, and it does not stop anything working.
  if (state.phase === 'idle' || state.phase === 'failed') return null;

  const pct = state.progress === null ? null : Math.round(state.progress * 100);

  return (
    <div className="updbar" role="status" aria-live="polite">
      <div className="updbar__body">
        {state.phase === 'available' && (
          <>
            <span className="updbar__text">
              <strong>Seek {state.version}</strong> is available.
            </span>
            <span className="updbar__actions">
              <button type="button" className="btn btn--primary pressable" onClick={onInstall}>
                Install and restart
              </button>
              <button type="button" className="btn pressable" onClick={onDismiss}>
                Not now
              </button>
            </span>
          </>
        )}

        {state.phase === 'downloading' && (
          <span className="updbar__text">
            Downloading Seek {state.version}
            {pct === null ? '…' : ` — ${pct}%`}
          </span>
        )}

        {state.phase === 'ready' && (
          <span className="updbar__text">Restarting into Seek {state.version}…</span>
        )}
      </div>

      {state.phase === 'downloading' && (
        <div
          className="updbar__track"
          role="progressbar"
          aria-valuenow={pct ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {/* An indeterminate stripe when no length was stated, rather than a
              bar that pretends to know how far along it is. */}
          <div
            className="updbar__fill"
            data-indeterminate={pct === null ? 'true' : undefined}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
