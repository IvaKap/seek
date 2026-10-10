// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The crash guard. Without it, one render exception blanked the whole window.
 */

import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let explode = true;
function Fragile() {
  if (explode) throw new Error('bad payload');
  return <p>fine now</p>;
}

describe('ErrorBoundary', () => {
  it('shows what went wrong instead of a blank window, and can try again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    explode = true;
    const { getByRole, getByText } = render(
      <ErrorBoundary label="the downloads screen"><Fragile /></ErrorBoundary>,
    );
    expect(getByRole('alert').textContent).toMatch(/bad payload/);

    explode = false;
    act(() => { fireEvent.click(getByRole('button', { name: 'Try again' })); });
    expect(getByText('fine now')).toBeTruthy();
  });

  it('leaves a healthy tree alone', () => {
    function Counter() {
      const [n] = useState(3);
      return <p>{n} downloads</p>;
    }
    const { getByText } = render(<ErrorBoundary label="x"><Counter /></ErrorBoundary>);
    expect(getByText('3 downloads')).toBeTruthy();
  });
});
