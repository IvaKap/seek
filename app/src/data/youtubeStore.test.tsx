// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * `useYoutube` under a real render. What matters here and nowhere else:
 *   - `youtube.sheet` merges ONE sheet in place, so a slow enrichment tick does
 *     not drop the others;
 *   - `enrichPending` derives each row's query on the FRONTEND (the seam) and
 *     sends only the pending rows;
 *   - nullable command fields go on the wire as null, present-not-absent, the
 *     rule a live bug already taught this codebase once;
 *   - a fetch failure carrying our requestId becomes a message; an unrelated
 *     one does not.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useYoutube } from './youtubeStore.ts';
import type { YoutubeSession } from './youtubeStore.ts';
import type { SidecarClient } from './sidecarClient.ts';
import type { YoutubeRow, YoutubeSheet } from '../../../shared/protocol.ts';

afterEach(cleanup);

function fakeClient() {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const sent: { cmd: string; params: Record<string, unknown> }[] = [];
  let reqN = 0;
  /** What request() resolves to, keyed by command; a function gets the params. */
  const replies: Record<string, unknown> = {};

  const client = {
    on(event: string, fn: (d: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(fn); handlers.set(event, set);
      return () => { set.delete(fn); };
    },
    request(cmd: string, params?: Record<string, unknown>) {
      sent.push({ cmd, params: params ?? {} });
      if (cmd in replies) return Promise.resolve(replies[cmd]);
      if (cmd === 'youtube.list') return Promise.resolve({ sheets: [] });
      // The RequestAccepted shape for the async commands.
      reqN += 1;
      return Promise.resolve({ requestId: `req-${reqN}` });
    },
  } as unknown as SidecarClient;

  const emit = (event: string, data: unknown) => {
    for (const fn of handlers.get(event) ?? []) fn(data);
  };
  return { client, emit, sent, replies };
}

function row(videoId: string, title: string, status: YoutubeRow['match']['status'] = 'pending'): YoutubeRow {
  return {
    video: {
      videoId, title, channel: 'Chan',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      description: '', durationSeconds: 200, publishedAt: null,
    },
    match: {
      status, discogsId: null, artist: '', track: '', album: '',
      genres: [], styles: [], releaseUrl: '',
    },
    downloaded: false,
  };
}

function sheet(id: string, rows: YoutubeRow[], over: Partial<YoutubeSheet> = {}): YoutubeSheet {
  return {
    id, title: id, source: 'playlist', sourceId: `PL${id}`,
    rows, total: rows.length, complete: true,
    addedAt: 1, lastFetchedAt: 1, enriching: false,
    pending: rows.filter((r) => r.match.status === 'pending').length,
    ...over,
  };
}

function mount(client: SidecarClient) {
  const box: { yt?: YoutubeSession } = {};
  function Probe() { box.yt = useYoutube(client); return null; }
  render(<StrictMode><Probe /></StrictMode>);
  return box as { yt: YoutubeSession };
}

describe('event handling', () => {
  it('youtube.state replaces the whole list', async () => {
    const { client, emit } = fakeClient();
    const box = mount(client);
    await act(async () => {});
    await act(async () => {
      emit('youtube.state', { sheets: [sheet('a', [row('1', 'T1')]), sheet('b', [])] });
    });
    expect(box.yt.sheets.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('youtube.sheet merges one sheet in place, leaving the rest', async () => {
    const { client, emit } = fakeClient();
    const box = mount(client);
    await act(async () => {});   // let the initial youtube.list resolve first
    await act(async () => {
      emit('youtube.state', { sheets: [sheet('a', [row('1', 'T1')]), sheet('b', [row('2', 'T2')])] });
    });
    await act(async () => {
      emit('youtube.sheet', sheet('a', [row('1', 'T1', 'matched')], { enriching: true }));
    });
    const a = box.yt.sheets.find((s) => s.id === 'a')!;
    const b = box.yt.sheets.find((s) => s.id === 'b')!;
    expect(a.rows[0].match.status).toBe('matched');
    expect(a.enriching).toBe(true);
    expect(b.rows[0].match.status).toBe('pending');   // untouched
    expect(box.yt.sheets.map((s) => s.id)).toEqual(['a', 'b']);   // order kept
  });
});

describe('commands', () => {
  it('addSheet sends title as null when omitted, present not absent', async () => {
    const { client, sent } = fakeClient();
    const box = mount(client);
    await act(async () => { box.yt.addSheet('PLxyz'); });
    const add = sent.find((c) => c.cmd === 'youtube.addSheet')!;
    expect(add.params).toEqual({ source: 'playlist', sourceId: 'PLxyz', title: null });
  });

  it('addSheet ignores an empty id', async () => {
    const { client, sent } = fakeClient();
    const box = mount(client);
    await act(async () => { box.yt.addSheet('   '); });
    expect(sent.some((c) => c.cmd === 'youtube.addSheet')).toBe(false);
  });

  it('enrichPending derives a query per pending row on the frontend', async () => {
    const { client, sent } = fakeClient();
    const box = mount(client);
    const s = sheet('a', [
      row('1', 'Aural Imbalance - Thought Patterns', 'pending'),
      row('2', 'Burial - Archangel', 'matched'),   // already matched, skipped
      row('3', 'Rez [Official Video]', 'pending'),
    ]);
    await act(async () => { box.yt.enrichPending(s); });

    const enrich = sent.find((c) => c.cmd === 'youtube.enrich')!;
    const queries = enrich.params.queries as { videoId: string; artist: string; title: string }[];
    // Only the two pending rows, and each carries a PARSED artist/title — the
    // sidecar never sees the raw video title.
    expect(queries.map((q) => q.videoId)).toEqual(['1', '3']);
    expect(queries[0]).toEqual({ videoId: '1', artist: 'Aural Imbalance', title: 'Thought Patterns' });
    expect(queries[1].title).toBe('Rez');   // "[Official Video]" cleaned off
  });

  it('enrichPending sends nothing when nothing is pending', async () => {
    const { client, sent } = fakeClient();
    const box = mount(client);
    await act(async () => { box.yt.enrichPending(sheet('a', [row('1', 'T', 'matched')])); });
    expect(sent.some((c) => c.cmd === 'youtube.enrich')).toBe(false);
  });

  it('setDownloaded applies the state the sidecar returns', async () => {
    const { client, replies } = fakeClient();
    replies['youtube.setDownloaded'] = { sheets: [sheet('a', [row('1', 'T')], { }) ] };
    const box = mount(client);
    await act(async () => { box.yt.setDownloaded('a', '1', true); });
    expect(box.yt.sheets.map((s) => s.id)).toEqual(['a']);
  });

  it('rematch by search sends artist/title, discogsUrl null', async () => {
    const { client, sent } = fakeClient();
    const box = mount(client);
    await act(async () => { box.yt.rematch('a', '1', { artist: 'X', title: 'Y' }); });
    const m = sent.find((c) => c.cmd === 'youtube.rematch')!;
    expect(m.params).toEqual({ sheetId: 'a', videoId: '1', artist: 'X', title: 'Y', discogsUrl: null });
  });

  it('rematch by url sends discogsUrl, artist/title null', async () => {
    const { client, sent } = fakeClient();
    const box = mount(client);
    await act(async () => {
      box.yt.rematch('a', '1', { discogsUrl: 'https://www.discogs.com/release/7' });
    });
    const m = sent.find((c) => c.cmd === 'youtube.rematch')!;
    expect(m.params).toEqual({
      sheetId: 'a', videoId: '1', artist: null, title: null,
      discogsUrl: 'https://www.discogs.com/release/7',
    });
  });
});

describe('fetch failures', () => {
  it('a parseFailed carrying our requestId becomes a message', async () => {
    const { client, emit, sent } = fakeClient();
    const box = mount(client);
    await act(async () => { box.yt.addSheet('PLxyz'); });
    // The fake resolved addSheet to { requestId: 'req-1' }.
    void sent;
    await act(async () => {
      emit('discover.parseFailed', { requestId: 'req-1', reason: 'nope', needs: 'youtubeApiKey' });
    });
    expect(box.yt.error).toMatch(/YouTube Data API key/);
    await act(async () => { box.yt.clearError(); });
    expect(box.yt.error).toBeNull();
  });

  it('a parseFailed for someone else is ignored', async () => {
    const { client, emit } = fakeClient();
    const box = mount(client);
    await act(async () => { box.yt.addSheet('PLxyz'); });
    await act(async () => {
      emit('discover.parseFailed', { requestId: 'not-ours', reason: 'x', needs: '' });
    });
    expect(box.yt.error).toBeNull();
  });
});
