import { describe, expect, it, vi } from 'vitest';
import { userMenuItems } from './userMenu.ts';
import type { People } from '../data/peopleStore.ts';

function people(over: Partial<People> = {}): People {
  return {
    buddies: new Set(), ignored: new Set(), banned: new Set(),
    follow: vi.fn(), ignore: vi.fn(), ban: vi.fn(), ...over,
  };
}
const actions = { browse: vi.fn(), message: vi.fn(), searchFiles: vi.fn(), copy: vi.fn() };
const label = (items: ReturnType<typeof userMenuItems>, id: string) => items.find((i) => i.id === id)?.label;

describe('userMenuItems', () => {
  it('offers Follow, Ignore and Ban to a stranger', () => {
    const items = userMenuItems('ana', people(), actions);
    expect(label(items, 'follow')).toBe('Follow ana');
    expect(label(items, 'ignore')).toBe('Ignore ana');
    expect(label(items, 'ban')).toBe('Ban ana');
  });

  it('offers the way back once each is set', () => {
    const p = people({ buddies: new Set(['ana']), ignored: new Set(['ana']), banned: new Set(['ana']) });
    const items = userMenuItems('ana', p, actions);
    expect(label(items, 'follow')).toBe('Unfollow ana');
    expect(label(items, 'ignore')).toBe('Stop ignoring ana');
    expect(label(items, 'ban')).toBe('Lift the ban on ana');
    items.find((i) => i.id === 'follow')!.run();
    expect(p.follow).toHaveBeenCalledWith('ana', false);
  });

  it('turns a toggle on for someone not yet on the list', () => {
    const p = people();
    userMenuItems('bo', p, actions).find((i) => i.id === 'ban')!.run();
    expect(p.ban).toHaveBeenCalledWith('bo', true);
  });
});
