/*
 * Seek — Digging Sessions.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * DISCOVERY.md asks these to read like journal entries, and the thing that
 * makes a journal entry useful is that it says what happened, not that it
 * exists. So a session card leads with what it collected — nine entries, three
 * of them already downloaded, from Discogs and Bandcamp — rather than with its
 * own name, which for an unnamed session is only a timestamp.
 *
 * The list and the detail are one component with one piece of state, because
 * the transition between them is a push: the detail slides in from the right
 * over the list, macOS-style, and that is far simpler to get right when both
 * sides are rendered by the same thing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSummary, SessionsSession } from '../data/sessionStore.ts';
import { sessionName } from '../data/sessionStore.ts';
import type { WantEntry, WantSession, WantStatus } from '../data/wantStore.ts';
import { WantRows } from './WantListView.tsx';
import { IconChevronRight, IconEmpty } from '../icons/index.tsx';

/** Only the states worth putting on a card. 'searching' is transient. */
const SHOWN: Array<{ key: WantStatus; label: string }> = [
  { key: 'downloaded', label: 'downloaded' },
  { key: 'found', label: 'found' },
  { key: 'pending', label: 'to find' },
  { key: 'not_found', label: 'not found' },
];

const SOURCE_LABEL: Record<WantEntry['sourceKind'], string> = {
  youtube: 'YouTube', bandcamp: 'Bandcamp', discogs: 'Discogs',
  manual: 'by hand', fingerprint: 'fingerprint',
};

function ago(epochSeconds: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** Inline rename. Double-click the title, Escape abandons, Enter commits. */
function SessionTitle({
  session, onRename, heading,
}: {
  session: SessionSummary;
  onRename(name: string): void;
  heading?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== sessionName(session)) onRename(next);
  }, [draft, session, onRename]);

  if (editing) {
    return (
      <input
        ref={ref}
        className="dig-session__rename"
        value={draft}
        aria-label="Session name"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          // Escape abandons the edit rather than committing a half-typed name.
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
      />
    );
  }

  const Tag = heading ? 'h1' : 'span';
  return (
    <Tag
      className={heading ? 'pane__title dig-session__name' : 'dig-session__name'}
      title="Double-click to rename"
      onDoubleClick={() => { setDraft(sessionName(session)); setEditing(true); }}
    >
      {sessionName(session)}
    </Tag>
  );
}

function SessionCard({
  session, onOpen, onRename,
}: {
  session: SessionSummary;
  onOpen(): void;
  onRename(name: string): void;
}) {
  const parts = SHOWN
    .filter((s) => session.counts[s.key] > 0)
    .map((s) => `${session.counts[s.key]} ${s.label}`);

  return (
    <div className="dig-session">
      <div className="dig-session__head">
        <SessionTitle session={session} onRename={onRename} />
        {!session.closed && <span className="dig-session__live">collecting</span>}
      </div>

      <p className="dig-session__facts tnum">
        {session.entries.length} {session.entries.length === 1 ? 'entry' : 'entries'}
        {parts.length > 0 && <> · {parts.join(' · ')}</>}
      </p>
      <p className="dig-session__facts dig-session__facts--dim">
        {session.sources.length > 0
          ? session.sources.map((s) => SOURCE_LABEL[s]).join(' · ')
          : 'nothing in it yet'}
        {' · started '}{ago(session.createdAt)}
      </p>

      <button
        type="button"
        className="dig-session__open pressable"
        aria-label={`Open ${sessionName(session)}`}
        onPointerDown={onOpen}
      >
        Open
        <IconChevronRight size={13} painted={1.5} />
      </button>
    </div>
  );
}

export function DigSessionsView({
  sessions, want, onSearch, searchingId,
}: {
  sessions: SessionsSession;
  want: WantSession;
  onSearch(entry: WantEntry): void;
  searchingId: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = sessions.sessions.find((s) => s.id === openId) ?? null;

  // A session deleted from under the detail view should not strand it.
  useEffect(() => {
    if (openId && !sessions.sessions.some((s) => s.id === openId)) setOpenId(null);
  }, [openId, sessions.sessions]);

  if (open) {
    return (
      <>
        <header className="header header--plain dig-session__detail-head">
          <button
            type="button"
            className="verify pressable"
            onPointerDown={() => setOpenId(null)}
          >
            ← All sessions
          </button>
          <SessionTitle
            session={open}
            heading
            onRename={(name) => sessions.rename(open.id, name)}
          />
          <p className="pane__subtitle tnum">
            {open.entries.length} {open.entries.length === 1 ? 'entry' : 'entries'}
            {' · '}{open.sources.length} {open.sources.length === 1 ? 'source' : 'sources'}
            {' · started '}{ago(open.createdAt)}
            {open.closed ? '' : ' · still collecting'}
          </p>
          <div className="browse__form dig-session__actions">
            {!open.closed && (
              <button
                type="button"
                className="btn pressable"
                title="Stop new entries joining this session"
                onPointerDown={() => sessions.close(open.id)}
              >
                Close session
              </button>
            )}
            <button
              type="button"
              className="btn pressable"
              title="Forget the session. Its entries stay on the want list."
              onPointerDown={() => sessions.remove(open.id)}
            >
              Delete session
            </button>
          </div>
        </header>

        <div className="pane__scroll">
          {open.entries.length === 0 ? (
            <div className="empty empty--section">
              <span className="empty__icon"><IconEmpty size={28} painted={1.3} /></span>
              <p className="empty__title">Nothing in this session</p>
              <p className="empty__body">
                Entries you add while it is collecting will appear here.
              </p>
            </div>
          ) : (
            <div className="wants">
              <WantRows
                entries={open.entries}
                want={want}
                onSearch={onSearch}
                searchingId={searchingId}
              />
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Dig Sessions</h1>
        <p className="pane__subtitle">
          What you found, and when. A session gathers a burst of saved links so
          an evening's digging stays together.
        </p>
        <div className="browse__form">
          <button
            type="button"
            className="btn pressable"
            title="Start a session — everything you save next joins it"
            onPointerDown={() => sessions.create()}
          >
            Start a session
          </button>
        </div>
      </header>

      <div className="pane__scroll">
        {sessions.sessions.length === 0 ? (
          <div className="empty empty--section">
            <span className="empty__icon"><IconEmpty size={28} painted={1.3} /></span>
            <p className="empty__title">No sessions yet</p>
            <p className="empty__body">
              Save three links to the want list within a few minutes and one
              appears on its own — or start one here.
            </p>
          </div>
        ) : (
          <div className="dig-sessions">
            {sessions.sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                onOpen={() => setOpenId(session.id)}
                onRename={(name) => sessions.rename(session.id, name)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
