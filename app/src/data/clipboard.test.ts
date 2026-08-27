/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * These tests exist because of one shipped defect, and the first case below IS
 * that defect. `navigator.clipboard?.writeText(text)` evaluates to `undefined`
 * when the API is absent — no throw — so the caller's success branch ran and
 * Copy diagnostics reported "Copied" over an untouched clipboard.
 *
 * The contract being pinned is therefore not "copying works". It is that a
 * write which did not happen can never be reported as one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.ts';

/** A document stub with just enough of the DOM for the execCommand path. */
function fakeDocument(execResult: boolean, seen: { text?: string }) {
  const body = {
    appendChild: () => undefined,
    removeChild: () => undefined,
  };
  return {
    body,
    createElement: () => ({
      value: '',
      style: {},
      setAttribute: () => undefined,
      select() { seen.text = (this as { value: string }).value; },
      setSelectionRange: () => undefined,
    }),
    execCommand: () => execResult,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyText', () => {
  it('reports FAILURE when no clipboard mechanism exists at all', async () => {
    /* The regression. Under vitest there is no window, no navigator.clipboard
     * and no document — the same shape as the shipped webview, where
     * `navigator.clipboard` is undefined because `tauri://localhost` is not a
     * secure context. The old code reported success here. */
    await expect(copyText('anything')).resolves.toBe(false);
  });

  it('reports failure for empty text rather than claiming a write', async () => {
    await expect(copyText('')).resolves.toBe(false);
  });

  it('writes through navigator.clipboard when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyText('the report')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('the report');
  });

  it('reports failure when navigator.clipboard REJECTS', async () => {
    /* WebKit refuses a write whose user activation has expired, which is what
     * happens when the diagnostics request is awaited first. A rejection has
     * to read as "not copied", not as a caught-and-forgotten nicety. */
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyText('the report')).resolves.toBe(false);
  });

  it('falls back to execCommand when there is no clipboard API', async () => {
    const seen: { text?: string } = {};
    vi.stubGlobal('document', fakeDocument(true, seen));

    await expect(copyText('fallback text')).resolves.toBe(true);
    expect(seen.text).toBe('fallback text');
  });

  it('reports failure when execCommand refuses too', async () => {
    vi.stubGlobal('document', fakeDocument(false, {}));

    await expect(copyText('fallback text')).resolves.toBe(false);
  });

  it('prefers the clipboard API over execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const seen: { text?: string } = {};
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('document', fakeDocument(true, seen));

    await expect(copyText('prefer me')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    // execCommand never reached, so nothing was selected.
    expect(seen.text).toBeUndefined();
  });
});
