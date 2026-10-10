// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Buttons that behave like Mac buttons. They used to act on pointer-down: a
 * right-click ran them, a press could not be dragged off, and Return or Space
 * did nothing. They act on click now, which a native button also fires for the
 * keyboard; these pin the shared pieces.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chip, SegmentedControl, Toggle, hitTarget } from './controls.tsx';

afterEach(cleanup);
// jsdom has no layout; the segmented control measures itself to place its pill.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

describe('the shared controls act on click, never on a press', () => {
  it('Toggle', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Forward the port" />);
    const sw = screen.getByRole('switch');
    fireEvent.pointerDown(sw, { button: 2 });
    fireEvent.pointerDown(sw);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Chip', () => {
    const onToggle = vi.fn();
    render(<Chip active={false} onToggle={onToggle}>Lossless only</Chip>);
    fireEvent.pointerDown(screen.getByRole('button'));
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('SegmentedControl', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Density"
        value="a"
        onChange={onChange}
        segments={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]}
      />,
    );
    fireEvent.pointerDown(screen.getByRole('radio', { name: 'B' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('hitTarget', () => {
  it('answers keys on the row itself, not on a button inside it', () => {
    /* A Return on Get bubbled to the row, ran the row's action too, and the
     * row's preventDefault swallowed Get's own click. */
    const row = vi.fn();
    render(
      <div {...hitTarget(row)} data-testid="row">
        <button type="button">Get</button>
      </div>,
    );
    fireEvent.keyDown(screen.getByText('Get'), { key: 'Enter' });
    expect(row).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('row'), { key: 'Enter' });
    expect(row).toHaveBeenCalledTimes(1);
  });
});
