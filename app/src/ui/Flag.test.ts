/*
 * Seek — country flags.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { countryName, flagEmoji, normaliseCountry } from './Flag.tsx';

describe('normaliseCountry', () => {
  it('accepts a two-letter code', () => {
    expect(normaliseCountry('GB')).toBe('GB');
  });

  it('uppercases and trims', () => {
    expect(normaliseCountry(' de ')).toBe('DE');
  });

  /* `country` is documented as "when known" and the sidecar sends null for a
   * peer on a private address. A missing flag must never become a wrong one. */
  it('refuses everything that is not a country code', () => {
    for (const bad of [null, undefined, '', '   ', 'USA', 'U', '12', 'G1', 'GB '.repeat(3)]) {
      expect(normaliseCountry(bad)).toBeNull();
    }
  });
});

describe('flagEmoji', () => {
  it('maps letters onto the regional indicator block', () => {
    // U+1F1EC U+1F1E7 — the pair macOS renders as the UK flag.
    expect(flagEmoji('GB')).toBe('\u{1F1EC}\u{1F1E7}');
    expect(flagEmoji('US')).toBe('\u{1F1FA}\u{1F1F8}');
  });

  it('produces two code points, not two characters', () => {
    // Each regional indicator is above the BMP, so this is length 4 in UTF-16
    // and 2 by code point. Slicing it as a string would split a surrogate pair.
    expect([...flagEmoji('DE')]).toHaveLength(2);
  });
});

describe('countryName', () => {
  it('names a country in the reader language', () => {
    expect(countryName('JP')).toMatch(/Japan/i);
  });

  /* Measured: `QQ` is unassigned and Intl returns it unchanged rather than
   * throwing or blanking. Note `ZZ` would NOT work as this case — CLDR has a
   * real entry for it, "Unknown Region". */
  it('falls back to the code rather than throwing or blanking', () => {
    expect(countryName('QQ')).toBe('QQ');
  });
});
