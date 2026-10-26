// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Signed out by a second Seek on the same account, and the form said only
 * "Signed out". The reason now shows when Settings opens, not only when the
 * event happens to land while the form is on screen, and a server code is a
 * sentence rather than INVALIDPASS.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SignIn } from './SignIn.tsx';
import type { SidecarClient } from '../data/sidecarClient.ts';

afterEach(cleanup);

function fakeClient() {
  const handlers = new Set<(d: unknown) => void>();
  const client = {
    on(_event: string, fn: (d: unknown) => void) { handlers.add(fn); return () => { handlers.delete(fn); }; },
    request: async () => ({}),
  } as unknown as SidecarClient;
  const emit = (d: unknown) => act(() => { for (const fn of handlers) fn(d); });
  return { client, emit };
}

describe('why you are signed out', () => {
  it('is said when the form opens', () => {
    const { client } = fakeClient();
    render(<SignIn client={client} state="offline" problem="relogged" />);
    expect(screen.getByRole('alert').textContent).toMatch(/signed in somewhere else/);
  });

  it('words a refused login as it arrives', () => {
    const { client, emit } = fakeClient();
    render(<SignIn client={client} state="offline" />);
    expect(screen.queryByRole('alert')).toBeNull();
    emit({ status: 'failed', error: 'INVALIDPASS' });
    expect(screen.getByRole('alert').textContent).toBe('Wrong password for that account.');
  });
});
