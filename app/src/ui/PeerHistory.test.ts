/*
 * Seek — how a peer's history is characterised.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The judgement worth pinning is the SMALL-SAMPLE one. Two failures out of two
 * is bad luck; seventy-nine is a fact about the peer, and calling the first one
 * "bad" in red would be exactly the confident wrongness this app avoids.
 */

import { describe, expect, it } from 'vitest';
import { peerTone, peerTitle } from './PeerHistory.tsx';

describe('peerTone', () => {
  it('is unwilling to judge on almost no evidence', () => {
    // One failure, or two, is anecdote. The chip still shows the numbers.
    expect(peerTone(0, 1)).toBe('mixed');
    expect(peerTone(0, 2)).toBe('mixed');
    expect(peerTone(1, 0)).toBe('mixed');
    expect(peerTone(2, 0)).toBe('mixed');
  });

  it('calls a real pattern what it is', () => {
    // Measured from the real state file: these peers have never once delivered.
    expect(peerTone(0, 315)).toBe('bad');
    expect(peerTone(0, 79)).toBe('bad');
    expect(peerTone(3, 0)).toBe('good');
    expect(peerTone(9, 0)).toBe('good');
  });

  it('grades the middle rather than rounding it to an opinion', () => {
    expect(peerTone(9, 10)).toBe('mixed');    // 47%
    expect(peerTone(8, 2)).toBe('good');      // 80%
    expect(peerTone(2, 8)).toBe('bad');       // 20%
  });

  it('never claims anything about how a peer treats anyone else', () => {
    // The protocol exposes nothing of the sort, so the wording must not imply
    // it. This is docs/PRODUCT.md §8's one hard rule about reliability.
    const text = peerTitle(9, 10);
    expect(text).toContain('your own');
    expect(text).toMatch(/anyone else/);
  });
});
