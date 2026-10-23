/*
 * Seek — the Rekordbox hand-off: what Seek has copied into the Rekordbox
 * folder, what it is copying now, and what it could not.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The sidecar keeps the record (seek-handoff.json), so "Sent" survives a
 * restart, and reports only the copies still in the folder set now. This
 * mirrors that, plus the two things only this session can know: which files
 * are on their way, and which the last send refused.
 *
 * Keyed by transfer id. Ids are a hash of user and remote path, so they are
 * the same after a restart, and a sent row whose transfer was cleared still
 * carries its user and path for the Board's Sent column.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { lostInTransit } from './sidecarClient.ts';
import { onReconnect, readUntilAnswered } from './failures.ts';
import { readableError } from '../domain/folders.ts';
import { HANDED_OVER } from '../domain/handoff.ts';
import type { HandoffDone, HandoffSent, HandoffState } from '../../../shared/protocol.ts';
import type { SidecarClient } from './sidecarClient.ts';

export interface HandoffSession {
  /** Where files go. Null when none is set; Send then opens Settings. */
  folder: string | null;
  /** What Seek put there and is still there, by transfer id. */
  sent: ReadonlyMap<string, HandoffSent>;
  /** Asked for and not reported yet. */
  sending: ReadonlySet<string>;
  /** What the last send of each file could not do, by transfer id. */
  failed: ReadonlyMap<string, string>;
  /** Resolves once the sidecar has the files; rejects with a sentence. */
  send(transferIds: string[]): Promise<void>;
  /** Show a copy in Finder. Rejects with a sentence when it has gone. */
  reveal(path: string): Promise<void>;
}

const byId = (rows: HandoffSent[]) => new Map(rows.map((row) => [row.transferId, row]));

/** `prev` without `ids`: what a report or a refusal takes off the way. */
const without = (ids: Iterable<string>) => (prev: ReadonlySet<string>) => {
  const next = new Set(prev);
  for (const id of ids) next.delete(id);
  return next;
};

export function useHandoff(client: SidecarClient | null, folder: string | null): HandoffSession {
  const [sent, setSent] = useState<ReadonlyMap<string, HandoffSent>>(() => new Map());
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(() => new Map());

  useEffect(() => {
    /* A copy's report goes to whoever is connected when it finishes, so one
       that finished while the engine restarted, or while the socket was down,
       told nobody: "Sending…" would stay for the session. The ledger is
       re-read when the socket is back, so a copy that did land shows as Sent. */
    const unsend = () => setSending((prev) => (prev.size ? new Set() : prev));
    unsend();
    if (!client) {
      setSent(new Map());
      return;
    }
    const read = () => readUntilAnswered<HandoffState>(client, 'handoff.list', undefined, (r) => setSent(byId(r.sent)));
    let stop = read();
    const again = () => { stop(); stop = read(); };
    const offDrop = onReconnect(client, unsend, again);
    /* A stick swapped, or a copy deleted in Finder, happened while Seek was
       behind: what is in the folder is asked again when it comes to the front. */
    window.addEventListener('focus', again);
    const offState = client.on('handoff.state', (d) => setSent(byId((d as HandoffState).sent)));
    const offDone = client.on('handoff.done', (d) => {
      const { results } = d as HandoffDone;
      setSending(without(results.map((r) => r.transferId)));
      setFailed((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          if (HANDED_OVER.has(r.outcome)) next.delete(r.transferId);
          else next.set(r.transferId, r.outcome);
        }
        return next;
      });
    });
    return () => { offDrop(); offState(); offDone(); stop(); window.removeEventListener('focus', again); };
  }, [client]);

  const send = useCallback(async (transferIds: string[]) => {
    if (!client) throw new Error('Not connected to the engine.');
    const ids = transferIds.filter((id) => !sending.has(id));
    if (ids.length === 0) return;
    setSending((prev) => new Set([...prev, ...ids]));
    try {
      await client.request('handoff.send', { transferIds: ids });
    } catch (error) {
      // Refused outright (no folder, or it has gone): nothing is on its way.
      // Lost in transit may still be copying, and its report will land anyway.
      setSending(without(ids));
      if (!lostInTransit(error)) throw new Error(readableError(error));
    }
  }, [client, sending]);

  const reveal = useCallback(async (path: string) => {
    if (!client) throw new Error('Not connected to the engine.');
    try {
      await client.request('fs.reveal', { transferId: null, path });
    } catch (error) {
      throw new Error(readableError(error));
    }
  }, [client]);

  return useMemo(
    () => ({ folder, sent, sending, failed, send, reveal }),
    [folder, sent, sending, failed, send, reveal],
  );
}
