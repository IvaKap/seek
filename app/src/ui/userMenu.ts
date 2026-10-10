/*
 * Seek — what you can do about a person, wherever their name appears.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * One builder for every menu that names someone: a search result, a chat line,
 * a room's member list. Three copies of Browse / Follow / Message lived in
 * App.tsx and none knew whether you already followed the person, so there was
 * no Unfollow anywhere but the Followed screen, and no Ignore or Ban at all.
 *
 * The wording of Ignore and Ban says what each actually does, because they are
 * not degrees of one thing: Ignore hides someone's messages, and only Ban stops
 * them searching and downloading from you (upstream networkfilter / uploads).
 */

import type { People } from '../data/peopleStore.ts';
import type { MenuItem } from './ContextMenu.tsx';

export interface UserMenuActions {
  browse(username: string): void;
  message(username: string): void;
  /** Search this person's shares. */
  searchFiles(username: string): void;
  copy(text: string): void;
}

export function userMenuItems(
  username: string, people: People, a: UserMenuActions, opts: { separated?: boolean } = {},
): MenuItem[] {
  const buddy = people.buddies.has(username);
  const ignored = people.ignored.has(username);
  const banned = people.banned.has(username);
  return [
    { id: 'browse', label: `Browse ${username}`, separated: opts.separated,
      run: () => a.browse(username) },
    { id: 'searchfiles', label: `Search ${username}'s files…`, run: () => a.searchFiles(username) },
    { id: 'msg', label: `Message ${username}`, run: () => a.message(username) },
    { id: 'follow', label: buddy ? `Unfollow ${username}` : `Follow ${username}`,
      run: () => people.follow(username, !buddy) },
    { id: 'ignore', separated: true,
      label: ignored ? `Stop ignoring ${username}` : `Ignore ${username}`,
      hint: ignored ? undefined : 'hide their messages',
      run: () => people.ignore(username, !ignored) },
    { id: 'ban', danger: !banned,
      label: banned ? `Lift the ban on ${username}` : `Ban ${username}`,
      hint: banned ? undefined : 'no searching or downloading from you',
      run: () => people.ban(username, !banned) },
    { id: 'copyuser', label: 'Copy username', separated: true, run: () => a.copy(username) },
  ];
}
