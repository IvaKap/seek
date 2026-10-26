// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The sidebar in each mode. Simple keeps a short list in front and the rest
 * one click away behind More; Collector shows every group. Nothing is
 * unreachable in either, and news is never hidden behind More.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar.tsx';
import type { Mode } from './viewMode.ts';

beforeAll(() => {
  // jsdom has no layout; the Mode control measures itself to place its pill.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

function sidebar(mode: Mode, extra: { privateUnread?: number } = {}) {
  const onMode = vi.fn();
  render(
    <Sidebar
      active="search"
      onSelect={() => {}}
      downloadCount={0}
      browsingUser={null}
      status={{ dot: 'online', label: 'Online', detail: '' }}
      mode={mode}
      onMode={onMode}
      {...extra}
    />,
  );
  return { onMode };
}

const nav = (name: string) => screen.queryByRole('button', { name: new RegExp(`^${name}`) });

describe('Simple', () => {
  it('keeps the everyday entries in front and the rest behind More', () => {
    sidebar('simple');
    expect(nav('Downloads')).not.toBeNull();
    expect(nav('Statistics')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^More/ }));
    expect(nav('Statistics')).not.toBeNull();
  });

  it('never hides an unread private message behind More', () => {
    sidebar('simple', { privateUnread: 3 });
    expect(nav('Private chats')).not.toBeNull();
  });
});

describe('Collector', () => {
  it('shows every group', () => {
    sidebar('collector');
    expect(screen.getByRole('button', { name: 'Library' })).not.toBeNull();
    expect(nav('Statistics')).not.toBeNull();
    expect(nav('More')).toBeNull();
  });
});

it('the Mode control switches modes', () => {
  const { onMode } = sidebar('simple');
  fireEvent.click(screen.getByRole('radio', { name: 'Collector' }));
  expect(onMode).toHaveBeenCalledWith('collector');
});
