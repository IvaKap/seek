/*
 * Seek — folder settings, and the shared-folder list.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The most serious gap on the settings screen: there was no way to say where
 * downloads go, or what you share. Sharing in particular is not a nicety on
 * Soulseek — it is reciprocal, peers deprioritise clients that share nothing,
 * and a client that cannot configure it is a leech by default.
 *
 * A picker AND a path field, always both. The native panel is a Tauri
 * capability and the same frontend runs in a plain browser tab against a
 * hand-started sidecar, where no picker exists — see `data/choose.ts`. The
 * field is also simply better for a path on a volume the panel makes awkward
 * to reach, or one pasted from a terminal.
 *
 * NOTHING IS SAVED UNTIL IT HAS BEEN CHECKED. The check is a round trip to the
 * sidecar, because the only honest test of whether a folder is writable is
 * writing a file into it — on macOS neither a read-only volume nor a folder
 * outside the app's granted access shows up in the permission bits. What the
 * user sees is a verdict under the field before they commit, and the option to
 * create the folder when that is all that is wrong.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Group } from './SettingsView.tsx';
import { canChooseFolder, chooseFolder } from '../data/choose.ts';
import type { EngineSession, SharedFolder } from '../data/engineStore.ts';
import type { FolderPurpose, PathFacts } from '../domain/folders.ts';
import { folderLeaf, judgeFolder, readableError } from '../domain/folders.ts';
import { IconClose, IconFolderOpen, IconPlus } from '../icons/index.tsx';

/** Long enough that typing a path does not fire a request per keystroke. */
const CHECK_DEBOUNCE_MS = 350;

/**
 * Check a path against the sidecar as it is edited.
 *
 * Every reply carries the path it was asked about, and a reply for a path that
 * is no longer in the field is discarded. Without that, a slow check for a
 * half-typed `/Volumes/Arc` lands after the fast one for `/Volumes/Archive`
 * and the field ends up showing a red "does not exist" under a folder that
 * does — a race that is invisible on a fast disk and constant on a network
 * volume, which is exactly where a DJ's collection lives.
 */
function usePathCheck(engine: EngineSession, path: string, enabled: boolean) {
  const [facts, setFacts] = useState<PathFacts | null>(null);
  const [checking, setChecking] = useState(false);
  const wanted = useRef(path);

  useEffect(() => {
    wanted.current = path;
    if (!enabled || !engine.available) {
      setFacts(null);
      return;
    }
    if (path.trim() === '') {
      setFacts(null);
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);
    const timer = window.setTimeout(() => {
      void engine.check(path)
        .then((result) => {
          if (cancelled || wanted.current !== path) return;
          setFacts(result);
        })
        .catch(() => {
          if (!cancelled) setFacts(null);
        })
        .finally(() => {
          if (!cancelled && wanted.current === path) setChecking(false);
        });
    }, CHECK_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [engine, path, enabled]);

  return { facts, checking };
}

/* ---------------------------------------------------------- one folder row */

export function FolderSetting({
  label, hint, purpose, value, engine, onSave,
}: {
  label: string;
  hint?: string;
  purpose: FolderPurpose;
  /** The path the engine currently holds. Empty when it holds none. */
  value: string;
  engine: EngineSession;
  onSave(path: string): void;
}) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const committed = useRef(value);

  /* Follow the engine when it changes underneath — a save, or an import that
   * brought a folder with it — without ever overwriting what is being typed. */
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  const dirty = draft.trim() !== value.trim();
  const { facts, checking } = usePathCheck(engine, draft, dirty);
  const verdict = judgeFolder(dirty ? facts : null, purpose);

  const commit = useCallback((path: string) => {
    setFailure(null);
    committed.current = path;
    onSave(path);
  }, [onSave]);

  const create = useCallback(() => {
    setBusy(true);
    setFailure(null);
    void engine.ensureFolder(draft)
      .then((made) => {
        // Save straight away. Creating a folder and then having to press Save
        // is a second decision for something the user already decided.
        commit(made.resolved);
      })
      .catch((e) => setFailure(readableError(e)))
      .finally(() => setBusy(false));
  }, [engine, draft, commit]);

  const browse = useCallback(() => {
    void chooseFolder(`Choose the ${label.toLowerCase()} folder`, value || null)
      .then((picked) => {
        if (!picked) return;
        setDraft(picked);
        // A folder chosen from the panel demonstrably exists, so there is
        // nothing to confirm — but it still goes through the sidecar's check,
        // which is what catches a read-only volume.
        commit(picked);
      });
  }, [label, value, commit]);

  return (
    <div className="settings__row settings__row--block folderset">
      <div className="folderset__head">
        <span className="settings__label">{label}</span>
        {hint && <span className="settings__hint">{hint}</span>}
      </div>

      <div className="folderset__controls">
        <input
          className="settings__input folderset__path"
          type="text"
          value={draft}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          disabled={!engine.available}
          placeholder={engine.available ? 'No folder set' : 'Not connected'}
          aria-label={`${label} folder path`}
          aria-describedby={verdict.message ? `${label}-verdict` : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && verdict.usable) commit(draft);
            if (e.key === 'Escape') setDraft(value);
          }}
        />
        {canChooseFolder() && (
          <button
            type="button"
            className="btn pressable"
            disabled={!engine.available}
            onPointerDown={browse}
            title={`Choose the ${label.toLowerCase()} folder`}
          >
            <IconFolderOpen size={14} painted={1.5} />
            <span>Choose…</span>
          </button>
        )}
        {dirty && verdict.usable && (
          <button
            type="button"
            className="btn btn--primary pressable"
            disabled={busy}
            onPointerDown={() => commit(draft)}
          >
            Save
          </button>
        )}
        {dirty && verdict.offerCreate && (
          <button
            type="button"
            className="btn pressable"
            disabled={busy}
            onPointerDown={create}
          >
            {busy ? 'Creating…' : 'Create it'}
          </button>
        )}
      </div>

      {/* One line, and only one. `checking` deliberately renders nothing: a
          message that flickers through "does not exist" on the way to "fine"
          is worse than a beat of silence. */}
      {(failure || (dirty && verdict.message && !checking)) && (
        <p
          className="folderset__verdict"
          id={`${label}-verdict`}
          data-tone={failure ? 'error' : verdict.tone}
          role={failure ? 'alert' : undefined}
        >
          {failure ?? verdict.message}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ shared folders */

export function SharedFolders({ engine }: { engine: EngineSession }) {
  const state = engine.shares;
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const folders = state?.folders ?? [];
  const consent = state?.consent ?? 'unset';
  const { facts } = usePathCheck(engine, draft, adding);
  const verdict = judgeFolder(draft.trim() ? facts : null, 'share');

  const apply = useCallback((next: SharedFolder[]) => {
    setFailure(null);
    // Consent follows the list. An empty list with consent 'granted' is a
    // contradiction the sidecar rejects, and removing your last folder is a
    // perfectly ordinary way to say "stop sharing".
    void engine.setShares(next.length > 0 ? 'granted' : 'declined', next)
      .catch((e) => setFailure(readableError(e)));
  }, [engine]);

  const add = useCallback((path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    if (folders.some((f) => f.path === trimmed)) {
      setFailure('That folder is already shared.');
      return;
    }
    // The virtual name is what peers see. Upstream keys shares on it and
    // refuses duplicates, so a second "Music" gets its parent folder's name
    // rather than a rejection the user has to decipher.
    const leaf = folderLeaf(trimmed);
    const taken = new Set(folders.map((f) => f.virtualName));
    let name = leaf;
    let n = 2;
    while (taken.has(name)) {
      name = `${leaf} ${n}`;
      n += 1;
    }
    apply([...folders, { virtualName: name, path: trimmed, exists: true }]);
    setDraft('');
    setAdding(false);
  }, [folders, apply]);

  const browse = useCallback(() => {
    void chooseFolder('Choose a folder to share').then((picked) => {
      if (picked) add(picked);
    });
  }, [add]);

  return (
    <Group
      title="What you share"
      footnote="Soulseek is reciprocal: people who share nothing get deprioritised in queues and banned outright by some peers. Shared folders only ever need to be readable, so an archive on a read-only drive is fine."
    >
      {consent === 'declined' && folders.length === 0 && (
        <div className="settings__row settings__row--block">
          <p className="shares__notice">
            You are not sharing anything. Downloads will still work, but your
            queue position with most peers will be poor and some will refuse you
            outright.
          </p>
        </div>
      )}

      {folders.map((folder) => (
        <div className="settings__row shares__row" key={folder.path}>
          <div className="settings__text">
            <span className="settings__label">{folder.virtualName}</span>
            <span className="settings__hint shares__path">{folder.path}</span>
            {!folder.exists && (
              <span className="folderset__verdict" data-tone="error">
                This folder is missing. Peers asking for anything in it will be
                refused until it comes back, or you remove it here.
              </span>
            )}
          </div>
          <div className="settings__control">
            <button
              type="button"
              className="btn pressable"
              aria-label={`Stop sharing ${folder.virtualName}`}
              onPointerDown={() => apply(folders.filter((f) => f.path !== folder.path))}
            >
              <IconClose size={13} painted={1.7} />
              <span>Remove</span>
            </button>
          </div>
        </div>
      ))}

      <div className="settings__row settings__row--block">
        {adding ? (
          <div className="folderset__controls">
            <input
              className="settings__input folderset__path"
              type="text"
              value={draft}
              autoFocus
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder="Path to a folder you want to share"
              aria-label="Path to a folder to share"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && verdict.usable) add(draft);
                if (e.key === 'Escape') { setDraft(''); setAdding(false); }
              }}
            />
            <button
              type="button"
              className="btn btn--primary pressable"
              disabled={!verdict.usable}
              onPointerDown={() => add(draft)}
            >
              Share it
            </button>
            <button
              type="button"
              className="btn pressable"
              onPointerDown={() => { setDraft(''); setAdding(false); }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="folderset__controls">
            <button
              type="button"
              className="btn pressable"
              disabled={!engine.available}
              onPointerDown={() => (canChooseFolder() ? browse() : setAdding(true))}
            >
              <IconPlus size={14} painted={1.7} />
              <span>Share a folder…</span>
            </button>
            {canChooseFolder() && (
              <button
                type="button"
                className="btn pressable"
                disabled={!engine.available}
                onPointerDown={() => setAdding(true)}
              >
                Type a path
              </button>
            )}
            {state?.ready && state.fileCount !== null && (
              <span className="settings__static tnum">
                {state.fileCount.toLocaleString()} files indexed
              </span>
            )}
            {state?.scanning && <span className="settings__static">Indexing…</span>}
          </div>
        )}
        {adding && draft.trim() && verdict.message && (
          <p className="folderset__verdict" data-tone={verdict.tone}>{verdict.message}</p>
        )}
        {failure && (
          <p className="folderset__verdict" data-tone="error" role="alert">{failure}</p>
        )}
        {state?.restartRequired && (
          <p className="folderset__verdict" data-tone="warn">
            Seek was started without the sharing engine, so these folders begin
            being served the next time you open it.
          </p>
        )}
      </div>
    </Group>
  );
}
