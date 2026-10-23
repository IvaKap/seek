/*
 * Seek — asking the sidecar what the release's own checksum file says.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Shaped like `analysisStore`, and deliberately kept apart from it. Both are
 * post-download checks and that is where the resemblance stops:
 *
 *   spectral  — a READING of the audio. Evidence, hedged, never proof.
 *   checksums — a comparison against a digest somebody else published. When a
 *               sidecar is present this is the only hard fact available about
 *               the bytes, because the Soulseek protocol carries no hashes at
 *               all (RECON.md §2).
 *
 * Keyed by transfer, not by file: a sidecar covers the release, so one request
 * answers for the whole folder and asking again per track would re-hash every
 * byte of it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lostInTransit } from './sidecarClient.ts';
import { dropRunning, onReconnect } from './failures.ts';
import type { AnalysisFailedEvent, ChecksumReport } from '../../../shared/protocol.ts';
import type { SidecarClient } from './sidecarClient.ts';
import type { TransferGroup } from './transferStore.ts';

interface ChecksumEntryState {
  state: 'running' | 'done' | 'failed';
  report?: ChecksumReport;
  reason?: string;
}

export interface ChecksumSession {
  /** Keyed by the transfer the check was asked for. */
  byTransfer: Map<string, ChecksumEntryState>;
  check(transferId: string): void;
}

export function useChecksums(client: SidecarClient | null): ChecksumSession {
  const [byTransfer, setByTransfer] = useState<Map<string, ChecksumEntryState>>(
    () => new Map(),
  );
  /** requestId -> transferId, so a failure lands on the row that asked. */
  const pending = useRef(new Map<string, string>());

  useEffect(() => {
    /* A new client is a restarted engine, and a dropped socket may have missed
       the answer: either way a check still marked running may never hear back.
       Its button comes back, as for a request lost in transit. */
    setByTransfer(dropRunning);
    if (!client) return;
    const offDrop = onReconnect(client, () => setByTransfer(dropRunning));

    const offResult = client.on('checksums.result', (data) => {
      const report = data as ChecksumReport;
      /* Prefer the id the sidecar echoed. `pending` is the fallback for a
         reply that outlived its request — the map is only cleaned on arrival. */
      const id = report.transferId ?? pending.current.get(report.requestId) ?? null;
      pending.current.delete(report.requestId);
      if (id) setByTransfer((prev) => new Map(prev).set(id, { state: 'done', report }));
    });

    const offFailed = client.on('checksums.failed', (data) => {
      const f = data as AnalysisFailedEvent;
      // Echoed for the same reason as the report's: a failure can beat the reply.
      const id = f.transferId ?? pending.current.get(f.requestId) ?? null;
      pending.current.delete(f.requestId);
      if (id) {
        setByTransfer((prev) => new Map(prev).set(id, {
          state: 'failed', reason: f.reason,
        }));
      }
    });

    return () => { offDrop(); offResult(); offFailed(); };
  }, [client]);

  const check = useCallback((transferId: string) => {
    if (!client) return;
    // Marked running before the round trip, so the button cannot be pressed
    // twice — the second press would re-read every byte of the folder.
    setByTransfer((prev) => (prev.get(transferId)?.state === 'running'
      ? prev : new Map(prev).set(transferId, { state: 'running' })));

    /* `path: null` is REQUIRED, not tidiness. A nullable field in the schema
       may be null; it may not be ABSENT, and the sidecar's validator rejects
       the command with "path: missing" — which no unit test here would see,
       because nothing below the socket runs that validator. Caught by driving
       the frozen binary. */
    void client.request<{ requestId: string }>(
      'analysis.checksums', { path: null, transferId },
    )
      .then((r) => pending.current.set(r.requestId, transferId))
      .catch((e: Error) => {
        // Never answered: the button comes back instead of "could not check".
        setByTransfer((prev) => {
          const next = new Map(prev);
          if (lostInTransit(e)) next.delete(transferId);
          else next.set(transferId, { state: 'failed', reason: e.message });
          return next;
        });
      });
  }, [client]);

  return useMemo(
    () => ({ byTransfer, check }), [byTransfer, check],
  );
}

/**
 * Check a release against the .ffp or .md5 it came with the moment its last
 * file lands, so "Checking" on the Board happens without a press.
 *
 * Only releases seen unfinished in this session: one that was already finished
 * when Seek opened keeps its Check hashes button, rather than every old release
 * re-reading itself at launch. Keyed like HashButton, by the first finished
 * file, so the result shows on that button too.
 */
export function useAutoChecksums(groups: readonly TransferGroup[], checksums: ChecksumSession): void {
  const unfinished = useRef(new Set<string>());
  useEffect(() => {
    for (const g of groups) {
      if (g.state !== 'finished') {
        unfinished.current.add(g.key);
        continue;
      }
      if (!unfinished.current.delete(g.key)) continue;
      if (!g.transfers.some((t) => /\.(ffp|md5)$/i.test(t.path))) continue;
      const id = g.transfers.find((t) => t.state === 'finished')?.id;
      if (id && !checksums.byTransfer.has(id)) checksums.check(id);
    }
  }, [groups, checksums]);
}
