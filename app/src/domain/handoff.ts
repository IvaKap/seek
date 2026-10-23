/*
 * Seek — the Rekordbox hand-off, in words: what one release's files have done.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The sidecar answers with outcome codes and a record of what went; wording
 * them, and summing a release's files into one state, happens here.
 *
 * Never "Rekordbox watches this". Rekordbox has no watch folder: the DJ imports
 * this folder in Rekordbox. Copy that implied otherwise would promise tracks
 * appearing on their own that never will.
 */

/** Outcomes that mean the file is in the Rekordbox folder. */
export const HANDED_OVER: ReadonlySet<string> = new Set(['copied', 'already_there']);

export function outcomeLine(outcome: string): string {
  switch (outcome) {
    case 'not_finished': return 'It has not finished downloading.';
    case 'file_missing': return 'The file is no longer where it downloaded to.';
    case 'exists_different':
      return 'A different file with this name is already in the Rekordbox folder, and Seek never replaces one.';
    case 'io_error': return 'The copy failed. Is the drive full, or unplugged?';
    default: return 'It could not be sent.';
  }
}

export interface ReleaseHandoff {
  /** Files that can be sent: the finished ones. */
  total: number;
  sent: number;
  sending: boolean;
  /** The first refusal, worded. Null when nothing was refused. */
  problem: string | null;
  /** The newest send, epoch seconds. Null when nothing has gone. */
  sentAt: number | null;
  /** The folder holding the release's first copy. Null when nothing has gone. */
  dest: string | null;
}

interface HandoffFacts {
  sent: ReadonlyMap<string, { dest: string; sentAt: number }>;
  sending: ReadonlySet<string>;
  failed: ReadonlyMap<string, string>;
}

/** One release's hand-off, from its finished files' ids. */
export function releaseHandoff(finishedIds: readonly string[], h: HandoffFacts): ReleaseHandoff {
  const rows = finishedIds.map((id) => h.sent.get(id)).filter((r) => r !== undefined);
  const refused = finishedIds.map((id) => h.failed.get(id)).find((o) => o !== undefined);
  const first = rows[0]?.dest ?? null;
  return {
    total: finishedIds.length,
    sent: rows.length,
    sending: finishedIds.some((id) => h.sending.has(id)),
    problem: refused === undefined ? null : outcomeLine(refused),
    sentAt: rows.length > 0 ? Math.max(...rows.map((r) => r.sentAt)) : null,
    dest: first === null ? null : first.slice(0, first.lastIndexOf('/')) || '/',
  };
}

/** The button's word for a release in that state. */
export function handoffLabel(r: ReleaseHandoff): string {
  if (r.sending) return 'Sending…';
  if (r.total > 0 && r.sent === r.total) return 'Sent to Rekordbox';
  if (r.problem) return 'Send again';
  if (r.sent > 0) return 'Send the rest';
  return 'Send to Rekordbox';
}
