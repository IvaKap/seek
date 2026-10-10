import { describe, expect, it } from 'vitest';
import { shouldGoAway } from './presence.ts';

const MIN = 60_000;

describe('shouldGoAway', () => {
  it('goes away once the idle spell reaches the setting', () => {
    expect(shouldGoAway(15 * MIN, 0, 15, 'online', false)).toBe(true);
    expect(shouldGoAway(14 * MIN, 0, 15, 'online', false)).toBe(false);
  });
  it('never when switched off', () => {
    expect(shouldGoAway(999 * MIN, 0, 0, 'online', false)).toBe(false);
  });
  it('leaves a manual away, and a signed-out engine, alone', () => {
    expect(shouldGoAway(99 * MIN, 0, 15, 'away', false)).toBe(false);
    expect(shouldGoAway(99 * MIN, 0, 15, 'offline', false)).toBe(false);
  });
  it('does not set away twice', () => {
    expect(shouldGoAway(99 * MIN, 0, 15, 'online', true)).toBe(false);
  });
});
