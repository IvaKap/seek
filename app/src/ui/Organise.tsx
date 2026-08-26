/*
 * Seek — move a finished file into Artist/Year - Album/.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The sidecar does the moving and enforces the safety rules; this only asks and
 * reports. It reports the DESTINATION rather than a tick, because the one thing
 * you want to know after a file moves is where it went.
 */

import { useCallback, useState } from 'react';
import type { SidecarClient } from '../data/sidecarClient.ts';

interface OrganiseResult {
  moved: boolean;
  fromPath: string;
  toPath: string;
  reason: string;
}

export function OrganiseButton({
  client, transferId,
}: {
  client: SidecarClient | null;
  transferId: string;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'skipped' | 'failed'>('idle');
  const [detail, setDetail] = useState('');

  const run = useCallback(() => {
    if (!client) return;
    setState('busy');
    void client.request<OrganiseResult>('organise.file', { path: null, transferId })
      .then((r) => {
        setDetail(r.moved ? r.toPath : r.reason);
        setState(r.moved ? 'done' : 'skipped');
      })
      .catch((e: Error) => { setDetail(e.message); setState('failed'); });
  }, [client, transferId]);

  if (state === 'busy') return <span className="verify verify--busy">Moving…</span>;
  if (state === 'done') {
    // The folder it landed in is the useful part; the full path is the tooltip.
    const folder = detail.split('/').slice(-2, -1)[0] ?? 'organised';
    return <span className="verify verify--done" data-tone="good" title={detail}>{folder}</span>;
  }
  if (state === 'skipped') return <span className="verify verify--failed" title={detail}>Not moved</span>;
  if (state === 'failed') return <span className="verify verify--failed" title={detail}>Failed</span>;

  return (
    <button
      type="button"
      className="verify pressable"
      disabled={!client}
      title="Move this file into Artist/Year - Album/ inside your download folder"
      onPointerDown={run}
    >
      Organise
    </button>
  );
}
