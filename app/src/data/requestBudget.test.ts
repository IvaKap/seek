/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The 15 s budget was a guess, and it told the first real user that a login and
 * a settings write had FAILED when both had succeeded — the engine was simply
 * still working through a first-launch queue on its single main thread.
 *
 * What is pinned here is the decision that follows: a write is never declared
 * dead on the same short clock as a read.
 */

import { describe, expect, it } from 'vitest';
import { requestBudget } from './sidecarClient.ts';

describe('requestBudget', () => {
  const reads = [
    'app.settings.get', 'settings.get', 'shares.get', 'app.diagnostics',
    'library.state', 'profile.get', 'connections.get',
  ];
  const writes = [
    // Both of the commands the first user watched "fail" while they worked.
    'connection.connect', 'app.settings.patch',
    'shares.set', 'shares.rescan', 'import.apply', 'want.add', 'want.remove',
    'transfer.cancel', 'transfer.retry', 'transfer.clear', 'wishlist.add',
  ];

  it.each(writes)('%s is a write and gets the long budget', (cmd) => {
    expect(requestBudget(cmd)).toBeGreaterThan(requestBudget('app.settings.get'));
  });

  it.each(reads)('%s is a read and keeps the short budget', (cmd) => {
    expect(requestBudget(cmd)).toBe(15_000);
  });

  it('treats an unknown verb as a read, which is the safe default', () => {
    /* Guessing "write" for anything unrecognised would let a genuinely wedged
     * read hang for two minutes. Guessing "read" only risks giving up early on
     * something that had no side effect to lose. */
    expect(requestBudget('some.futureCommand')).toBe(15_000);
  });

  it('reads the verb, not the noun, so a namespace cannot fool it', () => {
    expect(requestBudget('patch.get')).toBe(15_000);
    expect(requestBudget('get.patch')).toBeGreaterThan(15_000);
  });
});
