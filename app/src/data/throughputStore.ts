/*
 * Seek — live aggregate throughput.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * `connection.stats` has been emitted about once a second since the protocol
 * was written and consumed by nothing. It carries the two numbers a status bar
 * wants — total bytes/sec down and up across every transfer — already summed
 * by the engine, so this is a subscription rather than a computation.
 *
 * DELIBERATELY NOT DERIVED FROM `transferStore`. Adding up the per-transfer
 * rates would miss uploads entirely (Seek has no upload view yet, but the
 * engine is still serving peers), and would drift from what the connection is
 * actually doing. The engine's own figure is the honest one.
 *
 * The tick is ~1Hz, which is slow enough to render straight through. The 400ms
 * batching `transferStore` needs exists because progress arrives per transfer
 * per second and can be hundreds of events; this is one event for the whole
 * connection.
 */

import { useEffect, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';

export interface Throughput {
  /** Bytes/sec across all downloads. */
  down: number;
  /** Bytes/sec across all uploads. */
  up: number;
  /** Open peer sockets. */
  connections: number;
  /** A stats event has arrived, so the numbers mean something. */
  live: boolean;
}

const IDLE: Throughput = { down: 0, up: 0, connections: 0, live: false };

export function useThroughput(client: SidecarClient | null): Throughput {
  const [state, setState] = useState<Throughput>(IDLE);

  useEffect(() => {
    if (!client) {
      setState(IDLE);
      return;
    }
    return client.on('connection.stats', (d) => {
      const s = d as { downloadBandwidth?: number; uploadBandwidth?: number; connections?: number };
      setState({
        // Upstream emits this event with NO arguments as a reset (RECON.md §3).
        // The sidecar already normalises that into explicit zeros, so a missing
        // field here would be a real protocol change rather than the known
        // reset — but defaulting to 0 keeps a stale rate off the screen either
        // way, and a stale rate is the one thing a live figure must never be.
        down: s.downloadBandwidth ?? 0,
        up: s.uploadBandwidth ?? 0,
        connections: s.connections ?? 0,
        live: true,
      });
    });
  }, [client]);

  return state;
}
