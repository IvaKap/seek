/*
 * Seek — the one file that knows both the wire and the domain.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * AGENTS.md §"The seam": `shared/protocol.ts` is core's; `app/src/domain/` is
 * ours; this adapter is the only join. Keep it thin and keep it honest — if the
 * wire changes shape, it changes HERE and nowhere else.
 */

import type { PeerStats, SourceFile } from '../domain/types.ts';
import { toSourceFile } from '../domain/ingest.ts';
import type { RawFile } from '../domain/ingest.ts';

/* The subset of `shared/protocol.ts` we actually consume, restated structurally
 * so the app builds whether or not the sibling package is on the path. Field
 * names are copied exactly from core's file; any drift is a real bug, not a
 * naming preference. */

export interface WireFileRef {
  path: string;
  size: number;
  bitrate: number | null;
  duration: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  isVbr: boolean | null;
}

export interface WirePeerStats {
  username: string;
  freeSlots: boolean;
  advertisedSpeed: number;
  queueLength: number;
  files?: number | null;
  folders?: number | null;
  country?: string | null;
}

export interface WireSearchResultData {
  searchId: number;
  peer: WirePeerStats;
  files: WireFileRef[];
}

export type SearchCloseReason = 'timeout' | 'result_cap' | 'stopped' | 'disconnected';

export interface WireSearchClosedData {
  searchId: number;
  reason: SearchCloseReason;
  resultCount: number;
  peerCount: number;
}

export type WireFrame =
  | { ev: 'search.started'; data: { searchId: number; query: string } }
  | { ev: 'search.result'; data: WireSearchResultData }
  | { ev: 'search.closed'; data: WireSearchClosedData }
  | { ev: string; data: unknown };

/**
 * Historical success rate with a peer. Persisted in SQLite via Tauri in a later
 * phase; until then every peer gets the neutral prior, which is what
 * `reliabilityFrom(0, 0)` returns.
 */
export type ReliabilityLookup = (username: string) => number;

export function adaptPeer(p: WirePeerStats, reliability: ReliabilityLookup): PeerStats {
  return {
    username: p.username,
    // Forwarded raw. Upstream's GTK client rewrites queueLength to 0 whenever
    // freeSlots is true; core deliberately does not, and neither do we — a peer
    // with a free slot and 30 people queued is a real and useful distinction.
    freeSlots: p.freeSlots,
    advertisedSpeed: p.advertisedSpeed,
    queueLength: p.queueLength,
    reliability: reliability(p.username),
    // `?? null` rather than a default: the field is absent on the fixture
    // replay and null on the wire for an unresolvable peer, and both mean the
    // same thing — no flag.
    country: p.country ?? null,
  };
}

export function adaptFile(f: WireFileRef, user: string): RawFile {
  return {
    user,
    path: f.path,
    size: f.size,
    bitrate: f.bitrate,
    duration: f.duration,
    sampleRate: f.sampleRate,
    bitDepth: f.bitDepth,
    // `null` means "the peer did not say", which is NOT the same as "constant
    // bitrate". The domain type is nullable precisely so this stays visible.
    vbr: f.isVbr,
  };
}

export function adaptSearchResult(
  data: WireSearchResultData,
  tick: number,
  reliability: ReliabilityLookup,
): SourceFile[] {
  const peer = adaptPeer(data.peer, reliability);
  const out: SourceFile[] = [];
  for (const f of data.files) {
    out.push(toSourceFile(adaptFile(f, data.peer.username), peer, tick));
  }
  return out;
}

/** Non-audio files ride along in real search responses; the list should not show them. */
const AUDIO = /\.(flac|wav|wave|aiff?|alac|ape|wv|m4a|mp3|aac|ogg|oga|opus|wma|mpc|shn|dsf|dff)$/i;

export function isAudioPath(path: string): boolean {
  return AUDIO.test(path);
}
