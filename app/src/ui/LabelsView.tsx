/*
 * Seek — the label watchlist.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A shelf of catalogues you are working through, so a Hyperdub link pasted in
 * October is still there in December instead of dying with the card.
 *
 * The rule this screen keeps: it never reads a catalogue by itself. Opening
 * one is several rate-limited HTTP requests, and a view that refreshed six
 * labels on mount would spend a minute of someone else's API budget to render
 * a list you were only glancing at — the same reasoning that stops the
 * catalogue browser from searching Soulseek for 300 releases at once. So every
 * figure here is a snapshot, always shown with when it was taken, and opening
 * a label is something you press.
 */

import { useState } from 'react';
import type { LabelsSession, WatchedLabel } from '../data/labelStore.ts';
import { describeProgress, describeRemaining, isStale, kindLabel } from '../domain/labels.ts';
import { PROVIDER_LABEL } from '../domain/discoverUrl.ts';
import {
  IconBandcamp, IconClose, IconDiscogs, IconEmpty, IconRelease,
} from '../icons/index.tsx';

function ProviderIcon({ source }: { source: WatchedLabel['sourceKind'] }) {
  return source === 'bandcamp'
    ? <IconBandcamp size={13} painted={1.4} />
    : <IconDiscogs size={13} painted={1.4} />;
}

function Row({
  label, onOpen, onUnwatch, onNote,
}: {
  label: WatchedLabel;
  onOpen(): void;
  onUnwatch(): void;
  onNote(note: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label.note);

  const progress = describeProgress(label);
  const detail = describeRemaining(label);

  return (
    <div className="watch" data-unread={progress.read ? undefined : 'true'}>
      <span className="watch__body">
        <span className="watch__head">
          <span className="watch__name">{label.name}</span>
          <span className="watch__kind">
            <ProviderIcon source={label.sourceKind} />
            {PROVIDER_LABEL[label.sourceKind]} {kindLabel(label.kind).toLowerCase()}
          </span>
        </span>

        <span className="watch__facts tnum">
          {progress.summary}
          {/* NEVER without this. The counts are a reading, not a live figure —
              see the header on domain/labels.ts. */}
          {progress.when && <span className="watch__when"> · {progress.when}</span>}
          {isStale(label) && (
            <span className="watch__stale" title="Your library has probably moved on since this reading">
              {' '}· worth another look
            </span>
          )}
        </span>

        {detail && <span className="watch__detail tnum">{detail}</span>}

        {editing ? (
          <span className="watch__noteform">
            <input
              className="settings__input"
              value={draft}
              autoFocus
              placeholder="A note to yourself about this catalogue…"
              aria-label={`Note on ${label.name}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onNote(draft); setEditing(false); }
                if (e.key === 'Escape') { setDraft(label.note); setEditing(false); }
              }}
            />
            <button
              type="button"
              className="verify pressable"
              onPointerDown={() => { onNote(draft); setEditing(false); }}
            >
              Save
            </button>
          </span>
        ) : label.note ? (
          <button
            type="button"
            className="watch__note pressable"
            title="Edit this note"
            onPointerDown={() => setEditing(true)}
          >
            {label.note}
          </button>
        ) : null}
      </span>

      <span className="watch__actions">
        <button type="button" className="btn btn--primary pressable" onPointerDown={onOpen}>
          Open
        </button>
        {!label.note && !editing && (
          <button
            type="button"
            className="verify pressable"
            onPointerDown={() => { setDraft(''); setEditing(true); }}
          >
            Add a note
          </button>
        )}
        <button
          type="button"
          className="verify pressable"
          aria-label={`Stop watching ${label.name}`}
          onPointerDown={onUnwatch}
        >
          <IconClose size={12} painted={1.7} />
          Stop watching
        </button>
      </span>
    </div>
  );
}

export function LabelsView({
  labels, onOpen,
}: {
  labels: LabelsSession;
  onOpen(label: WatchedLabel): void;
}) {
  const list = labels.labels;
  const unread = list.filter((l) => l.lastSeenAt === null).length;

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Labels</h1>
        <p className="pane__subtitle">
          Catalogues you are working through. Nothing here is read until you
          open it — a catalogue costs several requests, so this list never
          refreshes itself.
        </p>
      </header>

      <div className="pane__scroll">
        {labels.error && (
          <p className="settings__notice settings__notice--error" role="alert">
            {labels.error}
          </p>
        )}

        {list.length === 0 ? (
          <div className="empty empty--section">
            <span className="empty__icon"><IconEmpty size={28} painted={1.3} /></span>
            <p className="empty__title">No catalogues watched</p>
            <p className="empty__body">
              Paste a Discogs or Bandcamp label or artist link into the search
              field, open its catalogue, and press Watch. It will still be here
              next month, with what you had of it when you last looked.
            </p>
          </div>
        ) : (
          <div className="watches">
            {unread > 0 && list.length > unread && (
              <p className="watches__note tnum">
                {unread} {unread === 1 ? 'catalogue has' : 'catalogues have'} not
                been opened yet.
              </p>
            )}
            {list.map((label) => (
              <Row
                key={label.id}
                label={label}
                onOpen={() => onOpen(label)}
                onUnwatch={() => labels.unwatch(label.id)}
                onNote={(note) => labels.note(label.id, note)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Shown in the catalogue browser's header.
 *
 * ONE toggle rather than a watch and an unwatch handler. The two-handler
 * version had a real bug in it: the caller only had an unwatch closure when
 * something was already watched, so the button was hidden in exactly the state
 * where you needed it to say "Watch".
 */
export function WatchButton({ watched, onToggle }: { watched: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      className={watched ? 'verify pressable' : 'btn pressable'}
      aria-pressed={watched}
      title={watched
        ? 'Stop keeping this catalogue on the Labels screen'
        : 'Keep this catalogue on the Labels screen to work through over time'}
      onPointerDown={onToggle}
    >
      <IconRelease size={13} painted={1.4} />
      {watched ? 'Watching' : 'Watch this catalogue'}
    </button>
  );
}
