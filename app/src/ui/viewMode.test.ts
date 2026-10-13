/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Simple and Collector are presets over the same app. These pin the three
 * promises that make that safe: an upgrade changes nothing, each screen
 * remembers its own choice in each mode, and a Simple sidebar never hides news
 * or the screen you are on.
 */

import { describe, expect, it } from 'vitest';
import { densityKey, initialMode, loadViews, splitSimple } from './viewMode.ts';

const store = (entries: Record<string, string>) => (key: string) => entries[key] ?? null;

describe('which mode the app opens in', () => {
  it('a first launch gets Simple', () => {
    expect(initialMode(store({}), ['seek.sidebar.collapsed'])).toBe('simple');
  });

  it('an install from before the switch keeps the Collector view it had', () => {
    // A person who never touched density stored no density key at all.
    expect(initialMode(store({ 'seek.sidebar.collapsed': '[]' }), ['seek.sidebar.collapsed'])).toBe('collector');
    expect(initialMode(store({ 'seek.density': 'compact' }), [])).toBe('collector');
  });

  it('a chosen mode wins', () => {
    expect(initialMode(store({ 'seek.mode': 'simple', 'seek.density': 'table' }), [])).toBe('simple');
  });
});

describe('each screen remembers its density per mode', () => {
  it('starts from the preset', () => {
    expect(loadViews('simple', store({}))).toEqual({ search: 'comfortable', downloads: 'comfortable', library: 'grid' });
    expect(loadViews('collector', store({}))).toEqual({ search: 'table', downloads: 'table', library: 'grid' });
  });

  it('Collector reads the keys the app always used, so an upgrade changes nothing', () => {
    expect(densityKey('search', 'collector')).toBe('seek.density');
    expect(loadViews('collector', store({ 'seek.density.downloads': 'compact' })).downloads).toBe('compact');
  });

  it("a choice made in one mode stays out of the other's", () => {
    const stored = store({ [densityKey('search', 'simple')]: 'grid' });
    expect(loadViews('simple', stored).search).toBe('grid');
    expect(loadViews('collector', stored).search).toBe('table');
  });

  it('an unreadable value falls back to the preset', () => {
    expect(loadViews('collector', store({ 'seek.density': 'roomy' })).search).toBe('table');
  });
});

describe("Simple's sidebar", () => {
  const items = ['search', 'downloads', 'uploads', 'stats', 'wishlist', 'messages', 'browsing']
    .map((id) => ({ id, badge: undefined as number | undefined }));

  it('keeps the everyday entries in front and the rest behind More', () => {
    const { front, more } = splitSimple(items, 'search');
    expect(front.map((i) => i.id)).toEqual(['search', 'downloads', 'wishlist']);
    expect(more.map((i) => i.id)).toEqual(['uploads', 'stats', 'messages', 'browsing']);
  });

  it('never hides news or the screen you are on', () => {
    const withNews = items.map((i) => (i.id === 'messages' ? { ...i, badge: 2 } : i));
    const { front } = splitSimple(withNews, 'stats');
    expect(front.map((i) => i.id)).toEqual(['search', 'downloads', 'stats', 'wishlist', 'messages']);
  });
});
