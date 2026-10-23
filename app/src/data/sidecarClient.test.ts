// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A request made in the moment between a socket starting to close and its
 * `onclose` running used to hang for good: the client still said 'open', the
 * wait for an open socket called its own unsubscribe before it existed, and the
 * throw rejected a promise nothing caught. A check or a copy asked for in that
 * moment never got its button back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSidecarClient, lostInTransit } from './sidecarClient.ts';

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeSocket.last = this; }
  send(frame: string) { this.sent.push(frame); }
  close() { this.readyState = 3; }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('a request while the socket is closing', () => {
  it('is refused as lost in transit, rather than never settling', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const client = createSidecarClient({ host: '127.0.0.1', port: 1, token: 't' });
    client.open();
    const socket = FakeSocket.last!;
    socket.readyState = 1;
    socket.onopen!();
    let phase = '';
    client.onPhase((p) => { phase = p; });
    expect(phase).toBe('open');

    socket.readyState = 2; // CLOSING: `onclose` has not run yet
    const outcome = await Promise.race([
      client.request('handoff.list').then(() => 'answered', (e: Error) => e),
      new Promise((resolve) => { setTimeout(() => resolve('hung'), 200); }),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect(lostInTransit(outcome)).toBe(true);
    client.close();
  });
});
