/*
 * Seek — reading Nicotine+'s chat logs back.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The engine writes every conversation to disk as `<timestamp> [<user>] <text>`
 * and Seek never read any of it back, so a restart showed every chat empty.
 * `chat.history` hands the lines over raw; splitting them is a derivation, so
 * it lives here (CLAUDE.md: Python formats nothing).
 */

export interface HistoryLine {
  /** As written, in the locale the log was written in. Shown, never parsed. */
  stamp: string;
  /** Null for a line that does not have the `[user]` shape (a status line). */
  username: string | null;
  message: string;
}

/**
 * Split one log line the way Nicotine+ does (gtkgui/widgets/textview.py:468):
 * the FIRST " [" and the "] " after it. The timestamp format is a user
 * setting, so nothing about its shape is assumed beyond preceding the name.
 */
export function parseLogLine(line: string): HistoryLine {
  const start = line.indexOf(' [');
  if (start >= 0) {
    const end = line.indexOf('] ', start + 2);
    if (end > start + 2) {
      return {
        stamp: line.slice(0, start),
        username: line.slice(start + 2, end),
        message: line.slice(end + 2),
      };
    }
  }
  return { stamp: '', username: null, message: line };
}

/**
 * Drop the tail of the log that this session already shows.
 *
 * The engine logs a line BEFORE Seek hears about it, so a conversation opened
 * by an incoming message already has that message on screen when its history
 * arrives — and the log ends with it too. Matched from the end, by sender and
 * text, and only as far back as there are live lines, so an old line that
 * happens to repeat something said today is left alone.
 */
export function withoutLive(
  history: HistoryLine[],
  live: ReadonlyArray<{ username: string; message: string }>,
): HistoryLine[] {
  let keep = history.length;
  let i = live.length - 1;
  while (keep > 0 && i >= 0) {
    const h = history[keep - 1];
    const l = live[i];
    if (h.username === l.username && h.message === l.message) {
      keep -= 1;
      i -= 1;
    } else {
      i -= 1;
    }
  }
  return history.slice(0, keep);
}
