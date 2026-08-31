// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Rendering the checksum report. Pure-logic tests already pin the verdicts and
 * the wording (`domain/checksums.test.ts`); this pins that the panel actually
 * SHOWS them — that the severity ordering survives into the DOM, that a tone is
 * carried onto the element the CSS colours, and that the empty case renders as
 * an answer rather than as an error.
 *
 * Rendered in <StrictMode> like the rest of the component tests here: it costs
 * nothing and it is the only configuration that surfaces an impure render.
 */

import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ChecksumEntry, ChecksumReport } from '../../../shared/protocol.ts';
import { ChecksumPanel } from './ChecksumPanel.tsx';

afterEach(cleanup);

const A = 'ab'.repeat(16);
const B = 'cd'.repeat(16);

function entry(over: Partial<ChecksumEntry> = {}): ChecksumEntry {
  return {
    name: '01 Track.flac',
    kind: 'ffp',
    expected: A,
    localPath: '/dl/release/01 Track.flac',
    actual: A,
    issue: null,
    ...over,
  };
}

function draw(over: Partial<ChecksumReport> = {}) {
  const report: ChecksumReport = {
    requestId: 'r',
    folderPath: '/dl/release',
    transferId: 't',
    sidecars: [{
      path: '/dl/release/album.ffp', kind: 'ffp',
      entryCount: 1, unparsedLines: 0, error: '',
    }],
    entries: [entry()],
    ...over,
  };
  return render(<StrictMode><ChecksumPanel report={report} /></StrictMode>);
}

describe('the checksum panel', () => {
  it('renders one row per claim', () => {
    const { container } = draw({
      entries: [entry(), entry({ name: '02 Track.flac' })],
    });
    expect(container.querySelectorAll('.cks__row')).toHaveLength(2);
  });

  it('names the sidecar it read, so the claim can be traced', () => {
    draw();
    expect(screen.getByText('album.ffp')).toBeTruthy();
  });

  it('shows the file name without its folder', () => {
    draw({ entries: [entry({ name: 'CD1\\01 Track.flac' })] });
    expect(screen.getByText('01 Track.flac')).toBeTruthy();
  });

  it('puts the failing file at the top', () => {
    // The one thing you came here to see must not be third.
    const { container } = draw({
      entries: [
        entry({ name: 'ok.flac' }),
        entry({ name: 'bad.flac', actual: B }),
      ],
    });
    const names = [...container.querySelectorAll('.cks__name')].map((n) => n.textContent);
    expect(names[0]).toBe('bad.flac');
  });

  it('colours an audio mismatch differently from a whole-file mismatch', () => {
    // The property this whole feature rests on, checked where the CSS reads it.
    const { container } = draw({
      entries: [
        entry({ name: 'audio.flac', kind: 'ffp', actual: B }),
        entry({ name: 'bytes.flac', kind: 'md5', actual: B }),
      ],
    });
    const tones = [...container.querySelectorAll('.cks__row')]
      .map((r) => r.getAttribute('data-tone'));
    expect(tones).toEqual(['bad', 'warn']);
  });

  it('and words them differently, so colour is not the only carrier', () => {
    const { container } = draw({
      entries: [
        entry({ name: 'audio.flac', kind: 'ffp', actual: B }),
        entry({ name: 'bytes.flac', kind: 'md5', actual: B }),
      ],
    });
    const said = [...container.querySelectorAll('.cks__verdict')]
      .map((n) => n.textContent);
    expect(new Set(said).size).toBe(2);
  });

  it('an empty folder reads as an answer, not a failure', () => {
    const { container } = draw({ sidecars: [], entries: [] });
    expect(container.querySelector('.cks__list')).toBeNull();
    expect(container.querySelector('.cks')?.getAttribute('data-tone')).toBe('unknown');
    expect(container.textContent).toMatch(/Most releases ship without one/);
  });

  it('does not promise more than a header read can prove', () => {
    // A passing fingerprint is strong, and this is its one limit. Said once,
    // at the bottom — not on every green row.
    const { container } = draw();
    expect(container.textContent).toMatch(/not that every\s+compressed frame survived/);
  });

  it('says nothing about frames when nothing passed', () => {
    const { container } = draw({ entries: [entry({ actual: B })] });
    expect(container.textContent).not.toMatch(/compressed frame/);
  });

  it('surfaces lines it could not read rather than hiding them', () => {
    const { container } = draw({
      sidecars: [{
        path: '/dl/release/album.ffp', kind: 'ffp',
        entryCount: 1, unparsedLines: 3, error: '',
      }],
    });
    expect(container.textContent).toMatch(/3 unreadable lines/);
  });

  it('does not render a row twice when both sidecars name one file', () => {
    // Distinct React keys: `name` alone collides, because an .ffp and an .md5
    // in the same folder both name every track.
    const { container } = draw({
      entries: [entry({ kind: 'ffp' }), entry({ kind: 'md5' })],
    });
    expect(container.querySelectorAll('.cks__row')).toHaveLength(2);
  });
});
