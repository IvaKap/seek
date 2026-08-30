// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The six sidebar icons were chosen by eye, from SVGs kept in
 * `app/src/icons/supplied/`. Four are VENDORED as raw geometry and two are
 * imported from lucide-react — see the long comment in `index.tsx` for which
 * and why. This file makes that distinction something a reader never has to
 * track: it asserts that all six RENDER exactly what was supplied, whatever
 * their source.
 *
 * That matters in both directions. Hand-copied geometry is the kind of thing
 * that is subtly wrong and still looks like an icon — a dropped subpath draws
 * a plausible glyph. And an imported one can change underneath us: 0.487.0
 * already draws `contact-round` and `mails` differently from the versions
 * chosen here, which is why those two stopped being imports.
 *
 * So if lucide-react is bumped, run this. Anything that starts failing is an
 * icon the new version redraws, and the fix is to vendor it — not to accept
 * the new drawing silently. Anything that keeps passing can go back to being
 * an import.
 */

import type { ReactElement } from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  IconCompleted, IconFailed, IconFollowed, IconMessages, IconWant, IconHistory,
  strokeFor,
} from './index.tsx';

/* `?raw` rather than `node:fs`. Reading the file at runtime would drag
 * `@types/node` into a browser app's type environment, and that is not free —
 * it redefines `setTimeout` to return a `Timeout` instead of a number, among
 * other things. Vite inlines these at transform time, and `*?raw` is already
 * declared in `vite-env.d.ts`. */
import folderCheckSvg from './supplied/folder-check.svg?raw';
import globeOffSvg from './supplied/globe-off.svg?raw';
import contactRoundSvg from './supplied/contact-round.svg?raw';
import mailsSvg from './supplied/mails.svg?raw';
import cloverSvg from './supplied/clover.svg?raw';
import listClockSvg from './supplied/list-clock.svg?raw';

afterEach(cleanup);

/** One comparable string per shape. Document ORDER is preserved on both sides,
 *  so reordering the subpaths of an icon fails too. */
function key(tag: string, at: (name: string) => string | null | undefined): string {
  switch (tag) {
    case 'path': return `path d=${at('d')}`;
    case 'circle': return `circle ${at('cx')},${at('cy')} r=${at('r')}`;
    case 'rect': return `rect ${at('x')},${at('y')} ${at('width')}x${at('height')} rx=${at('rx')}`;
    default: return `UNHANDLED <${tag}> — teach this test about it`;
  }
}

function shapesFromFile(svg: string): string[] {
  return [...svg.matchAll(/<(path|circle|rect)\b([^>]*)>/g)].map(([, tag, attrs]) =>
    key(tag, (n) => attrs.match(new RegExp(`\\s${n}="([^"]*)"`))?.[1]));
}

function shapesFromRender(node: ReactElement): string[] {
  const { container } = render(node);
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('no svg rendered');
  return [...svg.children].map((el) =>
    key(el.tagName.toLowerCase(), (n) => el.getAttribute(n)));
}

/** Every sidebar icon, and the file it was chosen from. */
const ICONS: Array<[string, string, () => ReactElement]> = [
  ['folder-check', folderCheckSvg, () => <IconCompleted />],
  ['globe-off', globeOffSvg, () => <IconFailed />],
  ['contact-round', contactRoundSvg, () => <IconFollowed />],
  ['mails', mailsSvg, () => <IconMessages />],
  ['clover', cloverSvg, () => <IconWant />],
  ['list-clock', listClockSvg, () => <IconHistory />],
];

describe('every sidebar icon renders the glyph that was supplied', () => {
  it.each(ICONS)('%s', (_name, svg, node) => {
    const expected = shapesFromFile(svg);
    // Guard the guard. A regex that matched nothing would make this pass
    // against an icon with no geometry at all.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.join('\n')).not.toContain('UNHANDLED');
    expect(shapesFromRender(node())).toEqual(expected);
  });
});

describe('vendored icons obey the same stroke arithmetic as imported ones', () => {
  it('derives strokeWidth from size, so optical weight holds at any size', () => {
    for (const size of [16, 20, 24]) {
      const { container } = render(<IconFailed size={size} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('width')).toBe(String(size));
      expect(Number(svg.getAttribute('stroke-width'))).toBeCloseTo(strokeFor(size), 6);
      cleanup();
    }
  });

  it('honours a painted override, like wrap() does for Lucide icons', () => {
    const { container } = render(<IconHistory size={16} painted={1.7} />);
    expect(Number(container.querySelector('svg')!.getAttribute('stroke-width')))
      .toBeCloseTo(strokeFor(16, 1.7), 6);
  });

  it('uses currentColor and no fill, so it inherits the nav item colour', () => {
    const { container } = render(<IconFollowed />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('fill')).toBe('none');
  });
});
