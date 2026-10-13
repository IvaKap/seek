// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Before the engine answers, a number field shows a placeholder 0. The port's
 * floor is 1024, so committing that untouched 0 on the way out of Settings
 * "saved" 1024 over the real port. Only an edit may be committed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NumberSetting } from './SettingsView.tsx';

afterEach(cleanup);

const port = (onCommit: (v: number) => void) => render(
  <NumberSetting value={0} min={1024} max={65535} step={1} ariaLabel="Listening port" available onCommit={onCommit} />,
);

describe('NumberSetting commits only what was typed', () => {
  it('leaving an untouched field saves nothing', () => {
    const onCommit = vi.fn();
    const view = port(onCommit);
    fireEvent.blur(screen.getByLabelText('Listening port'));
    view.unmount();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('the engine answering is not an edit either', () => {
    // The answer lands while the field still shows the placeholder.
    const onCommit = vi.fn();
    const view = port(onCommit);
    view.rerender(
      <NumberSetting value={50123} min={1024} max={65535} step={1} ariaLabel="Listening port" available onCommit={onCommit} />,
    );
    fireEvent.blur(screen.getByLabelText('Listening port'));
    view.unmount();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('an edit is saved on blur, clamped', () => {
    const onCommit = vi.fn();
    port(onCommit);
    const input = screen.getByLabelText('Listening port');
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(1024);
  });

  it('an edit still pending when Settings closes is saved', () => {
    const onCommit = vi.fn();
    const view = port(onCommit);
    fireEvent.change(screen.getByLabelText('Listening port'), { target: { value: '50123' } });
    view.unmount();
    expect(onCommit).toHaveBeenCalledWith(50123);
  });
});
