// @vitest-environment jsdom
/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The YouTube sheet, rendered. The store test covers the data; this covers what
 * a row actually offers: a per-row search, a clickable artist that browses, a
 * clickable album that searches, a Downloaded tick that persists, and — the
 * honesty requirement — a no-match row that offers to retry or paste a URL
 * rather than pretending it matched.
 */

import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { YoutubeSheetView } from './YoutubeSheetView.tsx';
import type { YoutubeSession } from '../data/youtubeStore.ts';
import type { YoutubeRow, YoutubeSheet } from '../../../shared/protocol.ts';

// The column-fit hooks use ResizeObserver, which jsdom does not provide.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

function row(over: Partial<YoutubeRow['match']> = {}, video: Partial<YoutubeRow['video']> = {}): YoutubeRow {
  return {
    video: {
      videoId: 'v1', title: 'Aural Imbalance - Thought Patterns', channel: 'Found',
      url: 'https://www.youtube.com/watch?v=v1', description: '',
      durationSeconds: 514, publishedAt: null, ...video,
    },
    match: {
      status: 'matched', discogsId: 111, artist: 'Aural Imbalance',
      track: 'Aural Imbalance - Contented Life', album: 'Contented Life',
      genres: ['Electronic'], styles: ['Drum n Bass'], releaseUrl: 'u', ...over,
    },
    downloaded: false,
  };
}

function sheet(rows: YoutubeRow[], over: Partial<YoutubeSheet> = {}): YoutubeSheet {
  return {
    id: 's1', title: 'Late night', source: 'playlist', sourceId: 'PLx',
    rows, total: rows.length, complete: true, addedAt: 1, lastFetchedAt: 1,
    enriching: false, pending: rows.filter((r) => r.match.status === 'pending').length,
    ...over,
  };
}

function session(
  sheets: YoutubeSheet[],
  over: Partial<YoutubeSession> = {},
): YoutubeSession & Record<string, ReturnType<typeof vi.fn>> {
  return {
    sheets,
    available: true,
    error: null,
    clearError: vi.fn(),
    addSheet: vi.fn(),
    refresh: vi.fn(),
    remove: vi.fn(),
    setDownloaded: vi.fn(),
    enrichPending: vi.fn(),
    rematch: vi.fn(),
    auth: { configured: false, signedIn: false, account: '', error: '' },
    myPlaylists: [],
    signIn: vi.fn(),
    signOut: vi.fn(),
    loadMyPlaylists: vi.fn(),
    addLiked: vi.fn(),
    addPlaylist: vi.fn(),
    ...over,
  } as unknown as YoutubeSession & Record<string, ReturnType<typeof vi.fn>>;
}

function draw(yt: YoutubeSession, onSearch = vi.fn(), onBrowseArtist = vi.fn()) {
  render(
    <StrictMode>
      <YoutubeSheetView youtube={yt} onSearch={onSearch} onBrowseArtist={onBrowseArtist} />
    </StrictMode>,
  );
  return { onSearch, onBrowseArtist };
}

describe('the youtube sheet', () => {
  it('shows an empty state with no playlists', () => {
    draw(session([]));
    expect(screen.getByText(/No playlists yet/)).toBeTruthy();
  });

  it('renders a row from the active sheet', () => {
    draw(session([sheet([row()])]));
    expect(screen.getByText('Aural Imbalance - Thought Patterns')).toBeTruthy();
    expect(screen.getByText('Aural Imbalance')).toBeTruthy();
    expect(screen.getByText('Contented Life')).toBeTruthy();
  });

  it('a matched artist browses their catalogue', () => {
    const { onBrowseArtist } = draw(session([sheet([row()])]));
    fireEvent.click(screen.getByText('Aural Imbalance'));
    expect(onBrowseArtist).toHaveBeenCalledWith('Aural Imbalance');
  });

  it('a matched album searches for it', () => {
    const { onSearch } = draw(session([sheet([row()])]));
    fireEvent.click(screen.getByText('Contented Life'));
    expect(onSearch).toHaveBeenCalledWith('Aural Imbalance Contented Life');
  });

  it('the per-row search button searches', () => {
    const { onSearch } = draw(session([sheet([row()])]));
    fireEvent.click(screen.getByTitle(/Search Soulseek for/));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('ticking Downloaded persists it', () => {
    const yt = session([sheet([row()])]);
    draw(yt);
    fireEvent.click(screen.getByLabelText('Downloaded'));
    expect(yt.setDownloaded).toHaveBeenCalledWith('s1', 'v1', true);
  });

  it('Match all enriches the pending rows', () => {
    const yt = session([sheet([row({ status: 'pending' })])]);
    draw(yt);
    fireEvent.click(screen.getByText('Match all'));
    expect(yt.enrichPending).toHaveBeenCalledTimes(1);
  });

  it('Match all is disabled when nothing is pending', () => {
    draw(session([sheet([row({ status: 'matched' })])]));
    expect((screen.getByText('Match all') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a no-match row offers to retry, not a fake artist', () => {
    const yt = session([sheet([row({ status: 'none', artist: '', album: '', discogsId: null })])]);
    draw(yt);
    expect(screen.getByText('No match')).toBeTruthy();
    fireEvent.click(screen.getByText('No match'));
    expect(yt.rematch).toHaveBeenCalled();
  });

  it('a no-match row can open the paste-a-URL fixer', () => {
    const yt = session([sheet([row({ status: 'none', artist: '', album: '' })])]);
    draw(yt);
    fireEvent.click(screen.getByText('Fix'));
    const input = screen.getByPlaceholderText(/Discogs release URL/);
    fireEvent.change(input, { target: { value: 'https://www.discogs.com/release/9' } });
    fireEvent.click(screen.getByText('Use this release'));
    expect(yt.rematch).toHaveBeenCalledWith('s1', 'v1',
      { discogsUrl: 'https://www.discogs.com/release/9' });
  });

  it('an error message can be dismissed', () => {
    const yt = session([sheet([row()])]);
    (yt as unknown as { error: string | null }).error = 'Add a Discogs token in Settings to match releases.';
    draw(yt);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(yt.clearError).toHaveBeenCalled();
  });

  it('switching sheets shows the other one', () => {
    const a = sheet([row({}, {})], { id: 'a', title: 'Alpha', rows: [row({}, { videoId: 'va', title: 'Alpha track' })] });
    const b = sheet([row({}, {})], { id: 'b', title: 'Beta', rows: [row({}, { videoId: 'vb', title: 'Beta track' })] });
    draw(session([a, b]));
    // The first sheet is active by default.
    expect(screen.getByText('Alpha track')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Beta/ }));
    expect(screen.getByText('Beta track')).toBeTruthy();
  });

  it('offers the account picker only when signed in', () => {
    draw(session([sheet([row()])]));
    expect(screen.queryByText(/From your account/)).toBeNull();
    cleanup();
    draw(session([sheet([row()])], {
      auth: { configured: true, signedIn: true, account: 'Me', error: '' },
    }));
    expect(screen.getByText(/From your account/)).toBeTruthy();
  });

  it('the picker adds Liked videos', () => {
    const yt = session([sheet([row()])], {
      auth: { configured: true, signedIn: true, account: 'Me', error: '' },
      myPlaylists: [{ id: 'LL', title: 'Liked videos', itemCount: 0, privacy: '' }],
    });
    draw(yt);
    fireEvent.click(screen.getByText(/From your account/));
    expect(yt.loadMyPlaylists).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Liked videos'));
    expect(yt.addLiked).toHaveBeenCalled();
  });

  it('the picker adds a chosen private playlist', () => {
    const yt = session([sheet([row()])], {
      auth: { configured: true, signedIn: true, account: 'Me', error: '' },
      myPlaylists: [
        { id: 'LL', title: 'Liked videos', itemCount: 0, privacy: '' },
        { id: 'PLx', title: 'Digging', itemCount: 42, privacy: 'private' },
      ],
    });
    draw(yt);
    fireEvent.click(screen.getByText(/From your account/));
    fireEvent.click(screen.getByText('Digging'));
    expect(yt.addPlaylist).toHaveBeenCalledWith('PLx', 'Digging');
  });

  it('a low-confidence match is toned as a warning', () => {
    const { container } = ((): { container: HTMLElement } => {
      const r = render(
        <StrictMode>
          <YoutubeSheetView youtube={session([sheet([row({ status: 'low' })])])}
                            onSearch={vi.fn()} onBrowseArtist={vi.fn()} />
        </StrictMode>,
      );
      return { container: r.container };
    })();
    expect(container.querySelector('.yt__row[data-tone="warn"]')).toBeTruthy();
  });
});
