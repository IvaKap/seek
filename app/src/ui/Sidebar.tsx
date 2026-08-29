/*
 * Seek — the grouped sidebar.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * docs/PRODUCT.md §2. Grouped, not four flat items: Finder, Music and Mail all
 * do exactly this, so it is more Mac-native rather than less. Sections collapse
 * and the collapsed state persists.
 *
 * `Browsing` appears only while a browse session is open — a permanently
 * visible nav item that is usually empty is dead chrome.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  IconChat, IconChevronDown, IconDownload, IconLibrary, IconRelease, IconSearch,
  IconArrowUp, IconSettings, IconStar, IconTransfers, IconUser, IconUsers,
} from '../icons/index.tsx';
import { speed } from '../domain/format.ts';
import type { Throughput } from '../data/throughputStore.ts';

export type Section =
  | 'search'
  | 'downloads' | 'uploads' | 'completed' | 'failed' | 'stats'
  | 'history' | 'saved' | 'collections' | 'wishlist' | 'want' | 'sessions' | 'catalog'
  | 'labels'
  | 'followed' | 'browsing'
  | 'chat'
  | 'messages'
  | 'settings';

interface Item {
  id: Section;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  badge?: number;
}

interface Group {
  id: string;
  title: string | null;
  items: Item[];
}

const STORAGE_KEY = 'seek.sidebar.collapsed';

/**
 * The socket being open and being signed in to Soulseek are different things,
 * and conflating them would tell the user searching will work when it will not.
 */
export interface ConnectionStatus {
  dot: 'online' | 'offline' | 'pending';
  label: string;
  detail: string;
}

/**
 * One direction of the live rate.
 *
 * Dimmed rather than hidden at zero: a row that appears and disappears as
 * traffic starts and stops would reflow the status bar every few seconds,
 * which is exactly the twitch the brief's calm rules exist to prevent. The
 * width is held by tabular figures for the same reason — `9.9 MB/s` and
 * `1.1 MB/s` must occupy the same space or the arrow beside them dances.
 */
function Rate({ direction, bytesPerSec }: { direction: 'down' | 'up'; bytesPerSec: number }) {
  const idle = bytesPerSec <= 0;
  return (
    <span className="sidebar__rate-one" data-idle={idle ? 'true' : undefined}>
      <span aria-hidden>{direction === 'down' ? '\u2193' : '\u2191'}</span>
      <span className="tnum">{idle ? '0 KB/s' : speed(bytesPerSec)}</span>
      <span className="sr-only">
        {direction === 'down' ? 'download rate' : 'upload rate'}
      </span>
    </span>
  );
}

export function Sidebar({
  active, onSelect, downloadCount, browsingUser, status, throughput,
  roomUnread = 0, privateUnread = 0, wantPending = 0, hasSessions = false,
  hasLabels = false, uploadCount = 0,
}: {
  active: Section;
  onSelect(s: Section): void;
  downloadCount: number;
  browsingUser: string | null;
  status: ConnectionStatus;
  /** Live aggregate rate from the engine. Absent in offline fixture mode. */
  throughput?: Throughput;
  /** Want list entries not yet looked for. Absent, not zero, when there are none. */
  wantPending?: number;
  /** Dig Sessions appears only once one exists — see the note on `browsing`. */
  hasSessions?: boolean;
  /** Labels appears only once a catalogue is watched, for the same reason. */
  hasLabels?: boolean;
  /** Uploads running or queued. Absent, not zero, when there are none. */
  uploadCount?: number;
  /** Unread lines, counted separately: rooms are ambient, a private message
   *  is addressed to you and deserves its own badge. */
  roomUnread?: number;
  privateUnread?: number;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* Private mode or a full quota — the UI still works, it just forgets. */
    }
  }, [collapsed]);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const groups: Group[] = [
    {
      id: 'top',
      title: null,
      items: [
        { id: 'search', label: 'Search', icon: <IconSearch size={16} />, shortcut: '⌘1' },
      ],
    },
    {
      id: 'library',
      title: 'Library',
      items: [
        { id: 'downloads', label: 'Downloads', icon: <IconDownload size={16} />, shortcut: '⌘2', badge: downloadCount || undefined },
        { id: 'completed', label: 'Completed', icon: <IconLibrary size={16} />, shortcut: '⌘3' },
        { id: 'failed', label: 'Failed', icon: <IconRelease size={16} /> },
        // AFTER the three download lenses, not between them. Downloads,
        // Completed and Failed are one list read three ways (CLAUDE.md);
        // dropping Uploads into the middle of that split a set that belongs
        // together. It stays in this group because it is the same kind of
        // object going the other way — just not inside the trio.
        //
        // The badge counts what is moving or queued and disappears at zero,
        // like the others: a nav item wearing a permanent 0 is the dead chrome
        // the Dig Sessions note warns about.
        { id: 'uploads', label: 'Uploads', icon: <IconArrowUp size={16} />, badge: uploadCount || undefined },
        // Always present, unlike Dig Sessions and Labels: the counters exist
        // from the first transfer and the screen is where you go to find out
        // that uploads have been happening at all.
        { id: 'stats', label: 'Statistics', icon: <IconTransfers size={16} /> },
      ],
    },
    {
      id: 'discovery',
      title: 'Discovery',
      items: [
        { id: 'collections', label: 'Library', icon: <IconLibrary size={16} /> },
        // The badge counts entries not yet looked for, and DISAPPEARS at zero
        // rather than showing 0 — a nav item permanently wearing a "0" is
        // noise that trains you to stop reading badges.
        { id: 'want', label: 'Want List', icon: <IconStar size={16} />, shortcut: '⌘8', badge: wantPending || undefined },
        // Only once one exists, for the same reason as `browsing` above: a nav
        // item that is empty until you happen to earn it is dead chrome, and
        // sessions are earned rather than created in the ordinary case.
        ...(hasSessions
          ? [{ id: 'sessions' as Section, label: 'Dig Sessions', icon: <IconRelease size={16} />, shortcut: '⌘9' }]
          : []),
        // Same rule as Dig Sessions above: it appears once you have earned it.
        // A permanently empty "Labels & Artists" is dead chrome for anyone who never
        // watches one, and the empty state is reachable from the catalogue
        // screen where watching actually happens.
        ...(hasLabels
          ? [{ id: 'labels' as Section, label: 'Labels & Artists', icon: <IconLibrary size={16} /> }]
          : []),
        { id: 'wishlist', label: 'Wishlist', icon: <IconSearch size={16} /> },
        { id: 'history', label: 'Search History', icon: <IconSearch size={16} /> },
        { id: 'saved', label: 'Saved Searches', icon: <IconLibrary size={16} /> },
      ],
    },
    {
      id: 'users',
      title: 'Users',
      items: [
        { id: 'followed', label: 'Followed', icon: <IconUsers size={16} /> },
        { id: 'chat', label: 'Chat rooms', icon: <IconChat size={16} />, shortcut: '⌘5', badge: roomUnread || undefined },
        { id: 'messages', label: 'Private chats', icon: <IconUsers size={16} />, shortcut: '⌘6', badge: privateUnread || undefined },
        // Always reachable — it is a place you go, not only a state you are
        // already in — but it names whoever is open so the nav reflects reality.
        {
          id: 'browsing' as Section,
          label: browsingUser ?? 'Browse',
          icon: <IconUser size={16} />,
        },
      ],
    },
  ];

  return (
    <nav className="sidebar" aria-label="Sections">
      <div className="sidebar__brand">Seek</div>

      <div className="sidebar__scroll">
        {groups.map((g) => {
          const isCollapsed = g.title !== null && collapsed.has(g.id);
          return (
            <div className="sidebar__group" key={g.id}>
              {g.title && (
                <button
                  type="button"
                  className="sidebar__header"
                  aria-expanded={!isCollapsed}
                  onPointerDown={() => toggle(g.id)}
                >
                  <IconChevronDown
                    size={12}
                    painted={1.7}
                    className="sidebar__caret"
                    data-collapsed={isCollapsed ? 'true' : undefined}
                  />
                  <span>{g.title}</span>
                </button>
              )}
              {!isCollapsed && (
                <div className="sidebar__items">
                  {g.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="nav-item"
                      aria-current={active === item.id ? 'page' : undefined}
                      onPointerDown={() => onSelect(item.id)}
                    >
                      <span className="nav-item__icon">{item.icon}</span>
                      <span className="nav-item__label">{item.label}</span>
                      {item.badge !== undefined && (
                        <span className="nav-item__badge tnum">{item.badge}</span>
                      )}
                      {item.badge === undefined && item.shortcut && (
                        <span className="nav-item__key">{item.shortcut}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar__spacer" />

      <div className="sidebar__group sidebar__group--footer">
        <div className="sidebar__items">
          <button
            type="button"
            className="nav-item"
            aria-current={active === 'settings' ? 'page' : undefined}
            onPointerDown={() => onSelect('settings')}
          >
            <span className="nav-item__icon"><IconSettings size={16} /></span>
            <span className="nav-item__label">Settings</span>
            <span className="nav-item__key">⌘4</span>
          </button>
        </div>
      </div>

      <div className="sidebar__status">
        <span className="sidebar__conn" title={status.detail}>
          <span className="status-dot" data-state={status.dot} aria-hidden />
          <span>{status.label}</span>
        </span>
        {/* Only once the engine has actually reported. A rate of zero is real
            information — nothing is moving — but a rate of zero before any
            stats event has arrived is just an absence dressed as a fact. */}
        {throughput?.live && (
          <span
            className="sidebar__rate"
            title={`${throughput.connections} peer connections open`}
          >
            <Rate direction="down" bytesPerSec={throughput.down} />
            <Rate direction="up" bytesPerSec={throughput.up} />
          </span>
        )}
      </div>
    </nav>
  );
}
