// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Per-track control in Downloads: the inline Cancel on one file, and clicking a
 * file to select it. The MENU logic is pinned purely in downloadMenu.test.ts and
 * the SELECTION model in select.test.ts; this is the wiring those two rely on —
 * that a file's Cancel reaches session.cancel with only that file's id, and that
 * a plain click lights exactly one row.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { DownloadsView } from './DownloadsView.tsx';
import { group } from '../data/transferStore.ts';
import type { Transfer, TransferSession } from '../data/transferStore.ts';
import type { AnalysisSession } from '../data/analysisStore.ts';
import type { ChecksumSession } from '../data/checksumStore.ts';
import type { PreviewSession } from './Preview.tsx';

afterEach(cleanup);

function file(id: string, over: Partial<Transfer> = {}): Transfer {
  return {
    id,
    direction: 'download',
    username: 'peer',
    path: `@@x\\Burial - Untrue\\${id}.flac`,
    localFolder: null,
    size: 100,
    bytesDone: 10,
    state: 'transferring',
    speed: 0,
    averageSpeed: 0,
    queuePosition: null,
    secondsLeft: null,
    secondsElapsed: 0,
    stalled: false,
    secondsSinceProgress: 0,
    finishedAt: null,
    error: null,
    seenAt: Date.now(),
    ...over,
  };
}

function mockSession(transfers: Transfer[]) {
  const calls = { cancel: [] as string[][], pause: [] as string[][] };
  const session = {
    groups: group(transfers, 999_999, Date.now()),
    note: null,
    error: null,
    pause: (ids: string[]) => { calls.pause.push(ids); },
    resume: () => {},
    retry: () => {},
    cancel: (ids: string[]) => { calls.cancel.push(ids); },
    clear: () => {},
  } as unknown as TransferSession;
  return { session, calls };
}

const analysis = { byTransfer: new Map() } as unknown as AnalysisSession;
const checksums = { byTransfer: new Map() } as unknown as ChecksumSession;
const preview = {} as unknown as PreviewSession;

function renderView(session: TransferSession) {
  return render(
    <StrictMode>
      <DownloadsView
        session={session}
        signedIn
        filter="active"
        analysis={analysis}
        checksums={checksums}
        client={null}
        preview={preview}
        density="comfortable"
        onDensity={() => {}}
      />
    </StrictMode>,
  );
}

/** Open the one release so its file rows render. */
function openGroup(container: HTMLElement) {
  const hit = container.querySelector('.dl__hit');
  if (!hit) throw new Error('no group header to open');
  act(() => { fireEvent.pointerDown(hit); });
}

describe('per-track control', () => {
  it('a file’s inline Cancel stops and removes only that file', () => {
    const { session, calls } = mockSession([file('01'), file('02')]);
    const { container } = renderView(session);
    openGroup(container);

    const cancels = container.querySelectorAll<HTMLButtonElement>(
      'button[title="Stop and remove this file"]',
    );
    // One per in-flight file, and it fires with just that file's id.
    expect(cancels).toHaveLength(2);
    act(() => { fireEvent.pointerDown(cancels[0]); });
    expect(calls.cancel).toEqual([['01']]);
  });

  it('clicking a file row selects exactly that one', () => {
    const { session } = mockSession([file('01'), file('02')]);
    const { container } = renderView(session);
    openGroup(container);

    const rows = container.querySelectorAll<HTMLElement>('.dl__file');
    const names = container.querySelectorAll<HTMLElement>('.dl__name');
    act(() => { fireEvent.click(names[1]); });

    expect(rows[0].getAttribute('data-selected')).toBeNull();
    expect(rows[1].getAttribute('data-selected')).toBe('true');
  });

  it('cmd-clicking a second file adds it to the selection', () => {
    const { session } = mockSession([file('01'), file('02')]);
    const { container } = renderView(session);
    openGroup(container);

    const rows = container.querySelectorAll<HTMLElement>('.dl__file');
    const names = container.querySelectorAll<HTMLElement>('.dl__name');
    act(() => { fireEvent.click(names[0]); });
    act(() => { fireEvent.click(names[1], { metaKey: true }); });

    expect(rows[0].getAttribute('data-selected')).toBe('true');
    expect(rows[1].getAttribute('data-selected')).toBe('true');
  });

  it('a right-click opens the actions menu for the file', () => {
    const { session } = mockSession([file('01'), file('02')]);
    const { container } = renderView(session);
    openGroup(container);

    const rows = container.querySelectorAll<HTMLElement>('.dl__file');
    act(() => { fireEvent.contextMenu(rows[0]); });

    // The generic ContextMenu renders a role="menu" with a Cancel item.
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('Cancel');
  });
});
