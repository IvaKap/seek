// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The Rekordbox hand-off on this side of the socket: the record survives a
 * restart, a refusal is said rather than swallowed, Send waits for a folder and
 * for review, and a release with its own checksum file checks itself the
 * moment it lands.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useHandoff } from './handoffStore.ts';
import type { HandoffSession } from './handoffStore.ts';
import { useAutoChecksums } from './checksumStore.ts';
import type { ChecksumSession } from './checksumStore.ts';
import { group } from './transferStore.ts';
import type { Transfer, TransferGroup } from './transferStore.ts';
import { HandoffButton } from '../ui/HandoffButton.tsx';
import { handoffLabel, releaseHandoff } from '../domain/handoff.ts';
import type { SidecarClient } from './sidecarClient.ts';
import type { HandoffSent } from '../../../shared/protocol.ts';

afterEach(cleanup);

function fakeClient(answer: (cmd: string, params: unknown) => Promise<unknown>) {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const phases = new Set<(p: string) => void>();
  let phase = 'open';
  const client = {
    onPhase(fn: (p: string) => void) {
      phases.add(fn);
      fn(phase);
      return () => { phases.delete(fn); };
    },
    on(event: string, fn: (d: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(fn);
      handlers.set(event, set);
      return () => { set.delete(fn); };
    },
    request: vi.fn(answer),
  } as unknown as SidecarClient & { request: ReturnType<typeof vi.fn> };
  const emit = (event: string, data: unknown) => act(() => {
    for (const fn of handlers.get(event) ?? []) fn(data);
  });
  const setPhase = (next: string) => act(async () => {
    phase = next;
    for (const fn of phases) fn(next);
  });
  return { client, emit, setPhase };
}

const row = (transferId: string, dest = `/RB/Release/${transferId}.flac`): HandoffSent => (
  { transferId, user: 'nightbus', path: `Music\\Release\\${transferId}.flac`, dest, sentAt: 1_000 }
);

describe('the record', () => {
  it('is read on connect, so Sent survives a restart, and follows every change', async () => {
    const { client, emit } = fakeClient(async (cmd) => (cmd === 'handoff.list' ? { sent: [row('a')] } : {}));
    const box: { s?: HandoffSession } = {};
    function Probe() { box.s = useHandoff(client, '/RB'); return null; }
    render(<StrictMode><Probe /></StrictMode>);
    await act(async () => {});
    expect([...box.s!.sent.keys()]).toEqual(['a']);

    emit('handoff.state', { sent: [row('a'), row('b')] });
    expect([...box.s!.sent.keys()]).toEqual(['a', 'b']);
  });

  it('marks files on their way, then each one done or refused', async () => {
    const { client, emit } = fakeClient(async (cmd) => (cmd === 'handoff.list' ? { sent: [] } : {}));
    const box: { s?: HandoffSession } = {};
    function Probe() { box.s = useHandoff(client, '/RB'); return null; }
    render(<StrictMode><Probe /></StrictMode>);

    await act(() => box.s!.send(['a', 'b']));
    expect(client.request).toHaveBeenCalledWith('handoff.send', { transferIds: ['a', 'b'] });
    expect([...box.s!.sending]).toEqual(['a', 'b']);

    emit('handoff.done', { results: [
      { transferId: 'a', outcome: 'copied', dest: '/RB/a.flac' },
      { transferId: 'b', outcome: 'exists_different', dest: null },
    ] });
    expect(box.s!.sending.size).toBe(0);
    expect([...box.s!.failed]).toEqual([['b', 'exists_different']]);
  });

  /* The report goes to whoever is connected when the copy ends. One that ended
     while the socket was down told nobody, and "Sending…" stayed for good. */
  it('forgets what was on its way when the socket drops, and re-reads the record', async () => {
    let ledger: HandoffSent[] = [];
    const { client, setPhase } = fakeClient(async (cmd) => (cmd === 'handoff.list' ? { sent: ledger } : {}));
    const box: { s?: HandoffSession } = {};
    function Probe() { box.s = useHandoff(client, '/RB'); return null; }
    render(<StrictMode><Probe /></StrictMode>);

    await act(() => box.s!.send(['a']));
    expect([...box.s!.sending]).toEqual(['a']);

    await setPhase('connecting');
    expect(box.s!.sending.size).toBe(0);

    ledger = [row('a')];
    await setPhase('open');
    expect([...box.s!.sent.keys()]).toEqual(['a']);
  });

  it('says why a send was refused, and leaves nothing marked as on its way', async () => {
    const { client } = fakeClient(async (cmd) => {
      if (cmd === 'handoff.send') throw new Error('bad_request: the Rekordbox folder does not exist: /Volumes/USB');
      return { sent: [] };
    });
    const box: { s?: HandoffSession } = {};
    function Probe() { box.s = useHandoff(client, '/Volumes/USB'); return null; }
    render(<StrictMode><Probe /></StrictMode>);

    let said = '';
    await act(() => box.s!.send(['a']).catch((e: Error) => { said = e.message; }));
    expect(said).toBe('the Rekordbox folder does not exist: /Volumes/USB');
    expect(box.s!.sending.size).toBe(0);
  });
});

describe('one release, in words', () => {
  const facts = (sent: string[], over: Partial<Parameters<typeof releaseHandoff>[1]> = {}) => ({
    sent: new Map(sent.map((id) => [id, row(id)])), sending: new Set<string>(), failed: new Map<string, string>(), ...over,
  });

  it('counts what went and names the folder it went to', () => {
    const r = releaseHandoff(['a', 'b'], facts(['a', 'b']));
    expect(r).toMatchObject({ total: 2, sent: 2, dest: '/RB/Release', sentAt: 1_000, problem: null });
    expect(handoffLabel(r)).toBe('Sent to Rekordbox');
  });

  it('offers the rest, then says what was refused', () => {
    expect(handoffLabel(releaseHandoff(['a', 'b'], facts(['a'])))).toBe('Send the rest');
    const refused = releaseHandoff(['a', 'b'], facts(['a'], { failed: new Map([['b', 'io_error']]) }));
    expect(handoffLabel(refused)).toBe('Send again');
    expect(refused.problem).toBe('The copy failed. Is the drive full, or unplugged?');
  });
});

let n = 0;
function file(over: Partial<Transfer> = {}): Transfer {
  n += 1;
  return {
    id: `t${n}`, direction: 'download', username: 'nightbus', path: `Music\\Burial - Untrue\\${n} Track.flac`,
    localFolder: '/Downloads/Burial - Untrue', size: 1_000, bytesDone: 1_000, state: 'finished', speed: 0,
    averageSpeed: 0, queuePosition: null, secondsLeft: null, secondsElapsed: 0, stalled: false,
    secondsSinceProgress: 0, finishedAt: Date.now() / 1000, error: null, ...over,
  };
}
const release = (files: Transfer[]): TransferGroup => group(files, 999_999, Date.now())[0];

describe('the Send button', () => {
  function show(g: TransferGroup, session: Partial<HandoffSession>, held: string[] = []) {
    const s: HandoffSession = {
      folder: '/RB', sent: new Map(), sending: new Set(), failed: new Map(),
      send: vi.fn(async () => {}), reveal: vi.fn(async () => {}), ...session,
    };
    const onSetFolder = vi.fn();
    render(<HandoffButton g={g} handoff={{ session: s, held: new Set(held), onSetFolder }} />);
    return { s, onSetFolder };
  }

  it('without a folder, opens Settings instead of sending', () => {
    const { s, onSetFolder } = show(release([file()]), { folder: null });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Rekordbox' }));
    expect(onSetFolder).toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });

  it('sends only what has not gone, and nothing still waiting for review', () => {
    const [a, b, c] = [file(), file(), file()];
    const { s } = show(release([a, b, c]), { sent: new Map([[a.id, row(a.id)]]) }, [c.id]);
    fireEvent.click(screen.getByRole('button', { name: 'Send the rest' }));
    expect(s.send).toHaveBeenCalledWith([b.id]);
  });

  it('is not offered for a release that is all waiting for review', () => {
    const a = file();
    show(release([a]), {}, [a.id]);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('once everything has gone, shows the copy in Finder', () => {
    const a = file();
    const { s } = show(release([a]), { sent: new Map([[a.id, row(a.id)]]) });
    fireEvent.click(screen.getByRole('button', { name: 'Sent to Rekordbox' }));
    expect(s.reveal).toHaveBeenCalledWith('/RB/Release');
    expect(s.send).not.toHaveBeenCalled();
  });
});

describe('a release with its own checksum file', () => {
  function watch(initial: TransferGroup[]) {
    const checksums = { byTransfer: new Map(), check: vi.fn() } as unknown as ChecksumSession;
    function Probe({ groups }: { groups: TransferGroup[] }) { useAutoChecksums(groups, checksums); return null; }
    const view = render(<StrictMode><Probe groups={initial} /></StrictMode>);
    return { checksums, update: (groups: TransferGroup[]) => view.rerender(<StrictMode><Probe groups={groups} /></StrictMode>) };
  }

  it('checks itself the moment its last file lands, once', () => {
    const audio = file({ state: 'transferring', bytesDone: 10 });
    const ffp = file({ path: 'Music\\Burial - Untrue\\release.ffp' });
    const { checksums, update } = watch([release([audio, ffp])]);
    expect(checksums.check).not.toHaveBeenCalled();

    const landed = [release([{ ...audio, state: 'finished', bytesDone: 1_000 }, ffp])];
    update(landed);
    update([...landed]);
    expect(checksums.check).toHaveBeenCalledTimes(1);
    expect(checksums.check).toHaveBeenCalledWith(audio.id);
  });

  it('leaves alone a release finished before Seek opened, and one with nothing to check', () => {
    const old = release([file(), file({ path: 'Music\\Burial - Untrue\\old.md5' })]);
    expect(old.transfers).toHaveLength(2);
    const plain = file({ state: 'transferring', path: 'Music\\Plain\\01.flac' });
    const { checksums, update } = watch([old, release([plain])]);
    update([old, release([{ ...plain, state: 'finished' }])]);
    expect(checksums.check).not.toHaveBeenCalled();
  });
});
