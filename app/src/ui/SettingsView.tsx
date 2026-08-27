/*
 * Seek — Settings.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Split out of `views.tsx`, which is otherwise a file of empty states.
 *
 * This screen used to be one long column of Seek's own preferences, and Iva's
 * verdict on it was "the settings section feels empty, we don't provide a lot
 * of use there". The gap was not decoration: there was no way to say WHERE
 * DOWNLOADS GO. That setting was inherited from a Nicotine+ config import and
 * could only be changed by editing that config by hand — so someone who had
 * never run Nicotine+ had no way to set it at all, and no way to configure
 * what they shared either.
 *
 * The commands for all of it already existed in the sidecar, tested, reachable
 * from a socket and from no screen. See `data/engineStore.ts`.
 *
 * SIX SECTIONS, not one column. The ordering is by what a new user needs
 * first: sign in, say where files go, then the rules, then the network, then
 * the optional external services, then the things you read once.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { sidecarDiagnostics } from '../data/sidecarClient.ts';
import { copyText } from '../data/clipboard.ts';
import { buildReport } from '../domain/bugReport.ts';
import { SegmentedControl, Toggle } from './controls.tsx';
import type { Segment } from './controls.tsx';
import { ImportPanel } from './ImportPanel.tsx';
import { SignIn } from './SignIn.tsx';
import { FolderSetting, SharedFolders } from './FolderSettings.tsx';
import { ConnectionsPanel, ProfilePanel } from './ProfilePanel.tsx';
import type { SidecarClient } from '../data/sidecarClient.ts';
import type { PrefsSession } from '../data/prefsStore.ts';
import type { EngineSession } from '../data/engineStore.ts';
import type { ConnectionsSession, ProfileSession } from '../data/profileStore.ts';
import { readableError } from '../domain/folders.ts';
import { IconInfo } from '../icons/index.tsx';

type Tab = 'account' | 'folders' | 'downloads' | 'network' | 'lookups' | 'about';

const TABS: Segment<Tab>[] = [
  { value: 'account', label: 'Account' },
  { value: 'folders', label: 'Folders' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'network', label: 'Network' },
  { value: 'lookups', label: 'Lookups' },
  { value: 'about', label: 'About' },
];

/* ------------------------------------------------------------- primitives */

export function Group({
  title, children, footnote,
}: {
  title?: string;
  children: React.ReactNode;
  footnote?: string;
}) {
  return (
    <section className="settings__group">
      {title && <h2 className="settings__title">{title}</h2>}
      <div className="settings__rows">{children}</div>
      {footnote && <p className="settings__footnote">{footnote}</p>}
    </section>
  );
}

export function Row({
  label, hint, control, help,
}: {
  label: string;
  hint?: string;
  control: React.ReactNode;
  help?: React.ReactNode;
}) {
  return (
    <div className="settings__row">
      <div className="settings__text">
        <span className="settings__label">
          {label}
          {help}
        </span>
        {hint && <span className="settings__hint">{hint}</span>}
      </div>
      <div className="settings__control">{control}</div>
    </div>
  );
}

/**
 * "Learn how to" — a popover of numbered steps.
 *
 * The dismissal listeners are on `document` rather than on the panel, which is
 * the same choice `QualityIndicator` made and for the same measured reason:
 * a handler on the element only fires where focus happens to be, and Escape
 * stopped working the moment anything else held it.
 */
export function HowTo({ title, steps, note }: { title: string; steps: string[]; note?: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="howto" ref={wrapRef}>
      <button
        type="button"
        className="howto__trigger"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        aria-label={`How to get ${title}`}
        onPointerDown={(e) => {
          // Same reason as the copies chip: without this the browser's own
          // mousedown focus lands after the panel mounts and pulls focus back
          // out of it.
          e.preventDefault();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <IconInfo size={13} painted={1.5} />
      </button>
      {open && (
        <span className="howto__panel" id={id} role="note">
          <span className="howto__title">{title}</span>
          <ol className="howto__steps">
            {steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          {note && <span className="howto__note">{note}</span>}
        </span>
      )}
    </span>
  );
}

/** A password field with a Save/Clear button. Three of these exist. */
function SecretRow({
  label, hint, placeholderSet, placeholderUnset, stored, ariaLabel, available, onSave, help,
}: {
  label: string;
  hint: string;
  placeholderSet: string;
  placeholderUnset: string;
  stored: boolean;
  ariaLabel: string;
  available: boolean;
  onSave(value: string): void;
  help?: React.ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  /* WHY THESE ARE TWO BUTTONS.
   *
   * They used to be one, whose label flipped to "Clear" the moment the field
   * emptied — which is exactly what saving does. So: paste a token, press Save,
   * the field clears, and the button under the user's finger silently becomes a
   * destroy button. A second press — a double-click, or clicking again to check
   * it took — sent an empty string, and the sidecar reads empty as "delete it".
   *
   * Reported from real use: "i pasted and saved the token, now the search says
   * discogs token needed". It fires on pointerDOWN, so a stray double-tap was
   * enough, and nothing said the token had gone.
   *
   * Save is now disabled with nothing to save, Clear only exists when there IS
   * something to clear, and Clear asks twice.
   */
  return (
    <Row
      label={label}
      hint={hint}
      help={help}
      control={(
        <span className="settings__inline">
          <input
            className="settings__input"
            type="password"
            value={draft}
            placeholder={stored ? placeholderSet : placeholderUnset}
            aria-label={ariaLabel}
            onChange={(e) => {
              setDraft(e.target.value);
              // Typing is a change of mind about clearing.
              setConfirmClear(false);
            }}
          />
          <button
            type="button"
            className="btn pressable"
            disabled={!available || !draft.trim()}
            onPointerDown={() => {
              if (!draft.trim()) return;
              onSave(draft);
              setDraft('');
              setConfirmClear(false);
            }}
          >
            Save
          </button>
          {stored && (
            <button
              type="button"
              className="btn pressable"
              disabled={!available}
              aria-label={confirmClear ? `Confirm clearing ${label}` : `Clear ${label}`}
              /* onClick, not onPointerDown: the rest of the app uses pointerDown
                 for responsiveness, but this one throws away a credential the
                 user had to leave the app to obtain. */
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true);
                  return;
                }
                onSave('');
                setConfirmClear(false);
              }}
            >
              {confirmClear ? 'Really clear?' : 'Clear'}
            </button>
          )}
        </span>
      )}
    />
  );
}

/** Bytes/sec on the wire, KB/s in the field — nobody thinks in bytes/sec. */
function SpeedLimit({
  label, hint, value, available, onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  available: boolean;
  onCommit(bytesPerSecond: number): void;
}) {
  const [draft, setDraft] = useState(() => String(Math.round(value / 1024)));
  const lastValue = useRef(value);

  // Follow the engine when it changes underneath us — after a save, or after
  // an import — but never while the field is being typed in.
  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setDraft(String(Math.round(value / 1024)));
    }
  }, [value]);

  const commit = () => {
    const kb = Math.max(0, Math.floor(Number(draft) || 0));
    setDraft(String(kb));
    onCommit(kb * 1024);
  };

  return (
    <Row
      label={label}
      hint={hint}
      control={(
        <span className="settings__inline">
          <input
            className="settings__input settings__input--num tnum"
            type="number"
            min={0}
            step={64}
            value={draft}
            disabled={!available}
            aria-label={`${label} in kilobytes per second, 0 for unlimited`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
          />
          <span className="settings__unit">KB/s</span>
        </span>
      )}
    />
  );
}

/* ------------------------------------------------------------------ screen */

export function SettingsView({
  client, serverState, prefs, engine, profile, connections,
}: {
  client: SidecarClient | null;
  serverState: string | null;
  prefs: PrefsSession;
  engine: EngineSession;
  profile: ProfileSession;
  connections: ConnectionsSession;
}) {
  const [tab, setTab] = useState<Tab>('account');
  const { settings } = prefs;
  const engineSettings = engine.settings;
  const [error, setError] = useState<string | null>(null);

  /* Every engine save funnels through here so one failed write cannot leave a
   * section showing a value the config does not hold. */
  const saveEngine = useCallback((patch: Parameters<EngineSession['save']>[0]) => {
    setError(null);
    void engine.save(patch).catch((e) => setError(readableError(e)));
  }, [engine]);

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Settings</h1>
        <div className="settings__tabs">
          <SegmentedControl<Tab>
            segments={TABS}
            value={tab}
            onChange={setTab}
            label="Settings section"
          />
        </div>
      </header>

      <div className="pane__scroll">
        <div className="settings">
          {!prefs.available && (
            <p className="settings__notice">
              Not connected to the sidecar, so changes here cannot be saved.
            </p>
          )}
          {error && (
            <p className="settings__notice settings__notice--error" role="alert">
              {error}
            </p>
          )}
          {/* A failed save used to be discarded, while the field optimistically
              showed the new value — so a token could read as saved and not be.
              That is what a user hit; it must never be silent again. */}
          {prefs.saveError && (
            <p className="settings__notice settings__notice--error" role="alert">
              Could not save that: {prefs.saveError}
            </p>
          )}
          {/* Queued, not lost. The engine runs commands on one thread, and on a
              first launch the queue in front of a write can be long — telling
              someone their change failed while it is still being applied is the
              error that made the app look broken when it was only slow. */}
          {prefs.saveBusy && !prefs.saveError && (
            <p className="settings__notice" role="status">
              Still saving — the engine is busy. This will finish on its own.
            </p>
          )}

          {tab === 'account' && (
            <>
              <Group
                title="Your Soulseek account"
                footnote="Seek keeps its own configuration. Importing copies from Nicotine+ once; it does not link the two, and Nicotine+ is left untouched."
              >
                <div className="settings__row settings__row--block">
                  <SignIn client={client} state={serverState} settings={prefs.settings} />
                </div>
                <Row
                  label="Sign in automatically"
                  hint={settings.hasCredentials
                    ? `Signs in as ${settings.username || 'the stored account'} when Seek opens.`
                    : 'Nothing is stored yet — sign in once and Seek will remember it.'}
                  control={(
                    <Toggle
                      checked={settings.autoConnect}
                      onChange={(v) => prefs.patch({ autoConnect: v })}
                      label="Sign in automatically"
                    />
                  )}
                />
                <div className="settings__row settings__row--block">
                  <ImportPanel client={client} />
                </div>
              </Group>

              <ProfilePanel profile={profile} />

              <Group
                title="Privacy"
                footnote="Seek collects nothing, sends no telemetry, and has no crash reporting. Peer reliability is computed from your own transfer history and never leaves this machine."
              >
                <Row
                  label="Telemetry"
                  hint="There is none, and there is no switch because there is nothing to switch off."
                  control={<span className="settings__static">None</span>}
                />
              </Group>
            </>
          )}

          {tab === 'folders' && (
            <>
              <Group
                title="Where files go"
                footnote="Both folders are checked before they are saved: Seek writes a file into the folder and deletes it, because on a Mac neither a read-only volume nor a folder macOS has not granted access to shows up in the permissions."
              >
                <FolderSetting
                  label="Downloads"
                  purpose="download"
                  value={engineSettings?.downloadFolder ?? ''}
                  engine={engine}
                  onSave={(path) => saveEngine({ downloadFolder: path })}
                />
                <FolderSetting
                  label="Files in progress"
                  purpose="incomplete"
                  value={engineSettings?.incompleteFolder ?? ''}
                  engine={engine}
                  onSave={(path) => saveEngine({ incompleteFolder: path })}
                  hint="Partial downloads live here until they finish, then move to the downloads folder. Keeping it on the same volume makes that a rename rather than a copy."
                />
              </Group>

              <SharedFolders engine={engine} />
            </>
          )}

          {tab === 'downloads' && (
            <>
              <Group
                title="Choosing what to take"
                footnote="These apply when you queue something. A refused download always says why rather than quietly not happening."
              >
                <Row
                  label="Prefer lossless"
                  hint="When a track has several sources, take the best lossless one instead of the highest overall score — a free fast 320 usually out-scores a queued FLAC."
                  control={(
                    <Toggle
                      checked={settings.preferLossless}
                      onChange={(v) => prefs.patch({ preferLossless: v })}
                      label="Prefer lossless"
                    />
                  )}
                />
                <Row
                  label="Minimum bitrate"
                  hint="Refuse lossy files below this. Never applied to lossless, which advertises no bitrate at all. 0 disables it."
                  control={(
                    <span className="settings__inline">
                      <input
                        className="settings__input settings__input--num tnum"
                        type="number"
                        min={0}
                        max={1411}
                        step={32}
                        value={settings.minBitrate}
                        aria-label="Minimum bitrate in kbps"
                        onChange={(e) => prefs.patch({ minBitrate: Number(e.target.value) })}
                      />
                      <span className="settings__unit">kbps</span>
                    </span>
                  )}
                />
                <Row
                  label="Reject suspected transcodes"
                  hint="Refuse files the physics check flags. The check is a prediction from metadata, so this errs on the side of not downloading."
                  control={(
                    <Toggle
                      checked={settings.rejectTranscodes}
                      onChange={(v) => prefs.patch({ rejectTranscodes: v })}
                      label="Reject suspected transcodes"
                    />
                  )}
                />
              </Group>

              <Group title="After downloading">
                <Row
                  label="Organise completed downloads"
                  hint="Move finished files into Artist/Year - Album/ using the MusicBrainz match. Never overwrites, never leaves the download folder."
                  control={(
                    <Toggle
                      checked={settings.autoOrganise}
                      onChange={(v) => prefs.patch({ autoOrganise: v })}
                      label="Organise completed downloads"
                    />
                  )}
                />
                <Row
                  label="Embed artwork into file tags"
                  hint="Writes the fetched cover into the downloaded file."
                  control={(
                    <Toggle
                      checked={settings.embedArtwork}
                      onChange={(v) => prefs.patch({ embedArtwork: v })}
                      label="Embed artwork"
                    />
                  )}
                />
                <Row
                  label="Write cover.jpg into the release folder"
                  control={(
                    <Toggle
                      checked={settings.writeCoverFile}
                      onChange={(v) => prefs.patch({ writeCoverFile: v })}
                      label="Write cover.jpg"
                    />
                  )}
                />
              </Group>

              <Group title="Digging">
                <Row
                  label="Group saved links into digging sessions"
                  hint="When several links are saved to the want list within a few minutes, gather them under one session. Only ever adds a grouping — nothing is hidden or changed."
                  control={(
                    <Toggle
                      checked={settings.autoDigSessions}
                      onChange={(v) => prefs.patch({ autoDigSessions: v })}
                      label="Group saved links into digging sessions"
                    />
                  )}
                />
              </Group>
            </>
          )}

          {tab === 'network' && (
            <>
              <Group
                title="Connection"
                footnote="Soulseek needs one incoming port reachable from outside. Without it you can still search and download from people whose port IS open, but nobody can reach you, which costs you upload credit and therefore queue position."
              >
                <Row
                  label="Listening port"
                  hint="Forward this port on your router to be reachable. Changing it takes effect on the next sign-in."
                  control={(
                    <PortField
                      value={engineSettings?.listenPort ?? 0}
                      available={engine.available}
                      onCommit={(port) => saveEngine({ listenPort: port })}
                    />
                  )}
                />
                <Row
                  label="Your address"
                  hint="How the Soulseek server sees you. Only known while signed in."
                  control={(
                    <span className="settings__static tnum">
                      {engine.publicAddress ?? 'Not signed in'}
                    </span>
                  )}
                />
              </Group>

              <Group
                title="Speed limits"
                footnote="0 means unlimited. Limiting uploads is usually the wrong instinct — upload speed is what earns queue position on Soulseek."
              >
                <SpeedLimit
                  label="Maximum download speed"
                  hint="Across all downloads together, not per transfer."
                  value={engineSettings?.maxDownloadSpeed ?? 0}
                  available={engine.available}
                  onCommit={(v) => saveEngine({ maxDownloadSpeed: v })}
                />
                <SpeedLimit
                  label="Maximum upload speed"
                  hint="Across all uploads together."
                  value={engineSettings?.maxUploadSpeed ?? 0}
                  available={engine.available}
                  onCommit={(v) => saveEngine({ maxUploadSpeed: v })}
                />
                <Row
                  label="Upload slots"
                  hint="How many people can download from you at once. Everyone else waits in your queue."
                  control={(
                    <NumberSetting
                      value={engineSettings?.uploadSlots ?? 0}
                      min={0}
                      max={99}
                      step={1}
                      ariaLabel="Upload slots"
                      available={engine.available}
                      onCommit={(v) => saveEngine({ uploadSlots: v })}
                    />
                  )}
                />
              </Group>

              <ConnectionsPanel connections={connections} />

              <Group
                title="Transfers"
                footnote="Soulseek has no stall signal of its own — a transfer that has quietly died looks exactly like one that is queued. Seek decides from the progress it can see."
              >
                <Row
                  label="Call a download stalled after"
                  hint="Zero progress for this long while supposedly transferring."
                  control={(
                    <NumberSetting
                      value={engineSettings?.stallSeconds ?? 0}
                      min={10}
                      max={3600}
                      step={10}
                      suffix="seconds"
                      ariaLabel="Stall timeout in seconds"
                      available={engine.available}
                      onCommit={(v) => saveEngine({ stallSeconds: v })}
                    />
                  )}
                />
              </Group>
            </>
          )}

          {tab === 'lookups' && (
            <Group
              title="External lookups"
              footnote="Soulseek transmits no artwork. Turning this off keeps Seek from contacting anyone but the Soulseek network itself."
            >
              <Row
                label="Look up artwork and release data"
                hint="MusicBrainz, Cover Art Archive, and Deezer. Rate-limited and cached."
                control={(
                  <Toggle
                    checked={settings.externalLookups}
                    onChange={(v) => prefs.patch({ externalLookups: v })}
                    label="Enable external lookups"
                  />
                )}
              />
              <SecretRow
                label="Discogs token"
                hint="Optional, but Discogs is the one that actually knows underground electronic releases."
                placeholderSet="Token saved"
                placeholderUnset="Personal access token"
                stored={settings.discogsToken}
                ariaLabel="Discogs personal access token"
                available={prefs.available}
                onSave={(v) => prefs.patch({ discogsToken: v })}
                help={(
                  <HowTo
                    title="a Discogs token"
                    steps={[
                      'Sign in at discogs.com, then open Settings → Developers.',
                      'Press "Generate new token" under Personal access token.',
                      'Copy the token it shows and paste it here.',
                    ]}
                    note="A personal token is tied to your own account and needs no app registration. Discogs allows 60 requests a minute with one; Seek stays well under that."
                  />
                )}
              />
              <SecretRow
                label="AcoustID application key"
                hint="Needed to identify a track by its sound. Free from acoustid.org. Drop an audio file on the search field once it is set."
                placeholderSet="Key saved"
                placeholderUnset="Application key"
                stored={settings.acoustidApiKey}
                ariaLabel="AcoustID application key"
                available={prefs.available}
                onSave={(v) => prefs.patch({ acoustidApiKey: v })}
                help={(
                  <HowTo
                    title="an AcoustID key"
                    steps={[
                      'Register an account at acoustid.org.',
                      'Go to acoustid.org/new-application and register an application — any name will do.',
                      'Copy the API key shown for that application and paste it here.',
                    ]}
                    note="This is the APPLICATION key, not the API key on your profile page. The profile one is for submitting fingerprints and AcoustID rejects it for lookups — which cost an hour to work out here, because the rejection arrives as an empty result rather than an error."
                  />
                )}
              />
              <SecretRow
                label="YouTube Data API key"
                hint="Needed to read a public playlist's contents."
                placeholderSet="Key saved"
                placeholderUnset="API key"
                stored={settings.youtubeApiKey}
                ariaLabel="YouTube Data API key"
                available={prefs.available}
                onSave={(v) => prefs.patch({ youtubeApiKey: v })}
                help={(
                  <HowTo
                    title="a YouTube Data API key"
                    steps={[
                      'Open console.cloud.google.com and create a project, or pick an existing one.',
                      'In APIs & Services → Library, search for "YouTube Data API v3" and enable it.',
                      'In APIs & Services → Credentials, press Create credentials → API key.',
                      'Copy the key and paste it here.',
                    ]}
                    note="An API key, not an OAuth client. OAuth is for reaching a Google account's private data; a public playlist needs none of it, and Seek holds no client secret and never asks you to sign in to Google."
                  />
                )}
              />
              <Row
                label="Artwork cache limit"
                hint="Least-recently-used eviction once the cap is reached."
                control={(
                  <span className="settings__inline">
                    <input
                      className="settings__input settings__input--num tnum"
                      type="number"
                      min={50}
                      step={50}
                      value={settings.artworkCacheMb}
                      aria-label="Artwork cache limit in megabytes"
                      onChange={(e) => prefs.patch({ artworkCacheMb: Number(e.target.value) })}
                    />
                    <span className="settings__suffix">MB</span>
                  </span>
                )}
              />
            </Group>
          )}

          {tab === 'about' && <About client={client} />}
        </div>
      </div>
    </>
  );
}

/* A committed-on-blur number, so a half-typed port is never sent. */
function NumberSetting({
  value, min, max, step, suffix, ariaLabel, available, onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  ariaLabel: string;
  available: boolean;
  onCommit(v: number): void;
}) {
  const [draft, setDraft] = useState(() => String(value));
  const last = useRef(value);

  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setDraft(String(value));
    }
  }, [value]);

  const commit = () => {
    const n = Math.min(max, Math.max(min, Math.floor(Number(draft) || 0)));
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };

  return (
    <span className="settings__inline">
      <input
        className="settings__input settings__input--num tnum"
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={!available}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      />
      {suffix && <span className="settings__unit">{suffix}</span>}
    </span>
  );
}

function PortField({
  value, available, onCommit,
}: {
  value: number;
  available: boolean;
  onCommit(v: number): void;
}) {
  return (
    <NumberSetting
      value={value}
      /* Below 1024 needs root on macOS, and Soulseek clients conventionally sit
       * well above it. */
      min={1024}
      max={65535}
      step={1}
      ariaLabel="Listening port"
      available={available}
      onCommit={onCommit}
    />
  );
}

function About({ client }: { client: SidecarClient | null }) {
  /* Read at render rather than held in state: the handshake writes it once per
   * connection and nothing changes it in between. */
  const diag = sidecarDiagnostics();
  const [copied, setCopied] = useState(false);
  /* The report itself, shown only when the clipboard refused it. Someone who
   * can see the text can still select it; someone told "Copied" over an empty
   * clipboard cannot do anything at all. */
  const [uncopied, setUncopied] = useState<string | null>(null);

  /* The whole point of the button: the facts live in three places — the app
   * knows its version, the engine knows the OS and the log, and the log is a
   * file inside the .app's data folder. Gathering them by hand is five steps,
   * and most people replying to a Reddit thread will not take them. */
  const copyReport = useCallback(() => {
    if (!client) return;
    void (async () => {
      /* The engine half is best-effort, and that is the point. A sidecar too
       * busy to answer within the request timeout is PRECISELY what the first
       * real user was trying to report, so a report that requires it to reply
       * cannot describe the commonest failure. `buildReport` already words the
       * gap as "engine: not connected" rather than printing a half-empty line. */
      let engine = {
        os: '', arch: '', python: '',
        logPath: '', logTail: '', logBytes: 0, fpcalc: '',
      };
      try {
        engine = await client.request<typeof engine>('app.diagnostics');
      } catch {
        // Keep going with what the app itself knows.
      }
      const report = buildReport({
        appVersion: __APP_VERSION__,
        sidecarVersion: diag.sidecarVersion,
        coreVersion: diag.coreVersion,
        os: engine.os,
        arch: engine.arch,
        logPath: engine.logPath,
        logTail: engine.logTail,
        logBytes: engine.logBytes,
        fpcalc: engine.fpcalc,
      });

      if (await copyText(report)) {
        setUncopied(null);
        setCopied(true);
        // Long enough to read, short enough that the button is ready again
        // if the first paste went somewhere wrong.
        window.setTimeout(() => setCopied(false), 2500);
        return;
      }
      /* Nothing reached the clipboard. Say so and hand over the text. The old
       * code reported success here, which is how this button shipped doing
       * nothing while looking like it worked. */
      setCopied(false);
      setUncopied(report);
    })();
  }, [client, diag]);

  return (
    <>
      <Group title="Seek">
        <Row
          label="Version"
          hint="An unofficial frontend for Nicotine+. Not affiliated with the Nicotine+ team."
          control={<span className="settings__static tnum">{__APP_VERSION__}</span>}
        />
        <Row
          label="Licence"
          hint="Seek is free software, and carries the same licence as the Nicotine+ core it runs."
          control={<span className="settings__static">GPL-3.0-or-later</span>}
        />
      </Group>
      {/* The three facts every bug report needs, in one place, so nobody has to
          be talked through finding them. The log path especially: it is inside
          the app's data folder, which no one will guess at. */}
      <Group
        title="Diagnostics"
        footnote="If something goes wrong, this is what to include. The log records what Seek itself did — not what you searched for, and not who you exchanged files with."
      >
        <Row
          label="Engine"
          hint="The Python sidecar, and the Nicotine+ core it runs."
          control={(
            <span className="settings__static tnum">
              {diag.sidecarVersion || '—'}
              {diag.coreVersion ? ` · core ${diag.coreVersion}` : ''}
            </span>
          )}
        />
        {/* A block row, not a Row with a `control`: the control column is
            sized for a toggle or a short value, and a filesystem path squeezed
            into it wraps the LABEL to one character per line. Measured. */}
        <div className="settings__row settings__row--block">
          <span className="settings__label">Log file</span>
          <p className="settings__hint">
            On this machine only. <b>Copy diagnostics</b> puts the version, your
            macOS details and the end of this log on the clipboard, ready to
            paste into a bug report. Nothing is sent anywhere by Seek.
          </p>
          <p className="settings__path">{diag.logPath || 'Not connected'}</p>
          <button
            type="button"
            className="btn btn--primary pressable settings__copy"
            disabled={!client}
            onClick={copyReport}
          >
            {copied ? 'Copied' : 'Copy diagnostics'}
          </button>
          {/* Only ever rendered because a write was ATTEMPTED and refused, so
              it doubles as the report that the clipboard is unavailable. */}
          {uncopied !== null && (
            <>
              <p className="settings__copyfail">
                Seek could not write to the clipboard on this Mac. The report is
                below — select it and copy it yourself.
              </p>
              <textarea
                className="settings__report"
                readOnly
                rows={12}
                value={uncopied}
                aria-label="Diagnostic report"
                onFocus={(event) => event.currentTarget.select()}
              />
            </>
          )}
        </div>
      </Group>
      <Group
        title="What Seek does not do"
        footnote="These are commitments, not settings, which is why there is nothing here to switch."
      >
        <Row
          label="No telemetry"
          hint="Nothing is collected, nothing is sent, and there is no crash reporting. Seek keeps a diagnostic log on this machine; it goes nowhere unless you attach it to a bug report yourself."
          control={<span className="settings__static">—</span>}
        />
        <Row
          label="Never writes to Rekordbox"
          hint="Finished files are handed over through a watch folder. Seek does not touch the Rekordbox database."
          control={<span className="settings__static">—</span>}
        />
        <Row
          label="Never modifies Nicotine+"
          hint="Seek keeps its own configuration. An import copies from Nicotine+ once and leaves it untouched."
          control={<span className="settings__static">—</span>}
        />
      </Group>
    </>
  );
}
