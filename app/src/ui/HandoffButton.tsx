/*
 * Seek — Send to Rekordbox, on a release.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Shared by the Downloads list, Completed and the Board, so the three cannot
 * disagree about what a release has sent or what pressing it does.
 */

import type { TransferGroup } from '../data/transferStore.ts';
import type { HandoffSession } from '../data/handoffStore.ts';
import { reportFailure } from '../data/failures.ts';
import { handoffLabel, releaseHandoff } from '../domain/handoff.ts';
import { since } from '../domain/format.ts';

/** The Rekordbox hand-off, as Downloads hands it to each release. */
export interface HandoffBits {
  session: HandoffSession;
  /** Auto-downloads still waiting for review: kept or rejected first. */
  held: ReadonlySet<string>;
  /** No folder is set: open Settings where one is chosen. */
  onSetFolder(): void;
}

/**
 * Copy the release into the Rekordbox folder, to import into Rekordbox from
 * there. A copy: the download stays where it is. Once everything has gone,
 * the button shows the copy in Finder instead.
 */
export function HandoffButton({ g, handoff, compact }: { g: TransferGroup; handoff: HandoffBits; compact?: boolean }) {
  const { session } = handoff;
  const ids = g.transfers
    .filter((t) => t.state === 'finished' && !handoff.held.has(t.id))
    .map((t) => t.id);
  if (ids.length === 0) return null;
  const r = releaseHandoff(ids, session);
  const done = r.sent === r.total;
  const title = !session.folder ? 'Choose the folder Seek copies finished releases into, in Settings → Folders'
    : r.problem ?? (done ? `In ${r.dest} · sent ${since(r.sentAt!)}. Show the copy in Finder.`
      : r.sent > 0 ? `${r.sent} of ${r.total} files are in the Rekordbox folder`
        : `Copy these files into ${session.folder}, to import into Rekordbox`);
  return (
    <button
      type="button"
      className={`${compact ? 'verify' : 'btn'} handoff pressable`}
      data-tone={r.problem ? 'bad' : done ? 'good' : undefined}
      disabled={r.sending}
      title={title}
      onClick={() => {
        if (!session.folder) handoff.onSetFolder();
        else if (done) void session.reveal(r.dest!).catch((e) => reportFailure('Show the copy in Finder', e));
        else {
          void session.send(ids.filter((id) => !session.sent.has(id)))
            .catch((e) => reportFailure('Send to Rekordbox', e));
        }
      }}
    >
      {/* A table row's actions are single words: Finder, Clear, Send. */}
      {compact ? handoffLabel(r).replace(' to Rekordbox', '').replace('the rest', 'rest') : handoffLabel(r)}
    </button>
  );
}
