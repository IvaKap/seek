/*
 * Seek — transfer counters.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Reads upstream's `statistics` component, which Seek has had enabled since
 * the beginning and never surfaced. The upload figures are therefore the first
 * sight of a whole side of the app: there is no upload view (backlog 2a), yet
 * the engine has been serving peers and counting the bytes the entire time.
 *
 * Two halves. `session` resets when the sidecar starts; `total` persists in
 * the pynicotine config with a `sinceTimestamp`. Showing both costs nothing
 * and answers two different questions — "is it working right now" and "what
 * has this account actually done".
 *
 * The event is rate-limited on the sidecar side, because upstream emits its
 * own `update-stat` once per FRAGMENT per transfer. See `STATS_MIN_INTERVAL`
 * in core_host.py.
 */

import { useEffect, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import type { TransferStats } from '../domain/transferStats.ts';
import { EMPTY_STATS } from '../domain/transferStats.ts';

export interface StatsSession {
  stats: TransferStats;
  /** A reading has arrived. False in offline mode and before the first reply. */
  available: boolean;
}

export function useTransferStats(client: SidecarClient | null): StatsSession {
  const [stats, setStats] = useState<TransferStats>(EMPTY_STATS);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (!client) {
      // Offline mode replays a fixture and has no engine behind it. Zeros with
      // `available: false` rather than the last connection's totals, which
      // would otherwise sit there looking current.
      setStats(EMPTY_STATS);
      setAvailable(false);
      return;
    }

    const off = client.on('stats.changed', (d) => {
      setStats(d as TransferStats);
      setAvailable(true);
    });

    void client.request<TransferStats>('stats.get')
      .then((r) => { setStats(r); setAvailable(true); })
      .catch(() => {});

    return off;
  }, [client]);

  return { stats, available };
}
