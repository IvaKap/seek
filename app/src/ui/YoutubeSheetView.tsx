/*
 * Seek — the YouTube tab: a playlist as an Excel-like sheet, cross-referenced
 * to Discogs.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * docs/HANDOFF (the 2 Sep plan): a pasted playlist becomes a sheet of videos,
 * each matched to a Discogs release for artist/album/genre/style, with a
 * per-row Soulseek search, a clickable artist (browse their catalogue), a
 * clickable album (search it), and a Downloaded tick. One sheet per playlist,
 * added with the +.
 *
 * The table reuses the search table's column engine (`youtubeColumns.ts`): the
 * columns rearrange and hide through the same ↑/↓ ViewMenu, and drop the
 * least-useful first as the pane narrows. It is NOT virtualised — a playlist is
 * a few hundred rows, not thousands — so it renders only the fitted columns in
 * order rather than the search table's custom-property machinery.
 *
 * A MATCH IS A GUESS. The Discogs lookup is a fuzzy search over a title the
 * frontend parsed, right ~95% of the time and wrong the rest, so the wording is
 * hedged and every row offers a re-match or a pasted Discogs URL to correct it —
 * the same honesty the spectral and checksum checks insist on.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { YoutubeSession } from '../data/youtubeStore.ts';
import type { YoutubeRow, YoutubeSheet } from '../../../shared/protocol.ts';
import {
  YT_COLUMN_SET, YT_COLUMNS, YT_DEFAULT_COLUMNS, ytNormaliseColumns, ytTemplateFor,
  ytVisibleColumns,
} from '../domain/youtubeColumns.ts';
import type { YtColumnId } from '../domain/youtubeColumns.ts';
import { cleanForDiscogs, discogsQuery } from '../domain/youtubeMatch.ts';
import { duration } from '../domain/format.ts';
import { guessUrl } from '../domain/discoverUrl.ts';
import { ViewMenu } from './ViewMenu.tsx';
import { useRootFontSize, useWidthRem } from './useColumnFit.ts';
import { IconSearch, IconEmpty, IconClose } from '../icons/index.tsx';

const COLUMNS_KEY = 'seek.youtube.columns';

function loadColumns(): YtColumnId[] {
  try {
    return ytNormaliseColumns(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? 'null'));
  } catch {
    return [...YT_DEFAULT_COLUMNS];
  }
}

/** What a per-row Soulseek search should look for. */
function searchQuery(row: YoutubeRow): string {
  const m = row.match;
  if (m.status === 'matched' || m.status === 'low' || m.status === 'manual') {
    const q = `${m.artist} ${m.album}`.trim();
    if (q) return q;
  }
  const { artist, title } = discogsQuery(row.video.title, row.video.channel);
  return `${artist} ${title}`.trim();
}

/** The row's tone, so an uncertain or absent match reads as one at a glance. */
function rowTone(row: YoutubeRow): 'good' | 'warn' | 'unknown' | undefined {
  switch (row.match.status) {
    case 'matched':
    case 'manual':
      return 'good';
    case 'low':
      return 'warn';
    case 'none':
    case 'error':
      return 'unknown';
    default:
      return undefined;   // pending — nothing looked up yet
  }
}

export function YoutubeSheetView({
  youtube, onSearch, onBrowseArtist,
}: {
  youtube: YoutubeSession;
  onSearch(query: string): void;
  onBrowseArtist(artist: string): void;
}) {
  const { sheets, error, clearError } = youtube;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [columns, setColumns] = useState<YtColumnId[]>(loadColumns);
  const [draft, setDraft] = useState('');
  /** The row a manual Discogs URL is being pasted for, and the draft URL. */
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixUrl, setFixUrl] = useState('');

  const tableRef = useRef<HTMLDivElement>(null);
  const rootPx = useRootFontSize();
  const widthRem = useWidthRem(tableRef, rootPx);

  const active = sheets.find((s) => s.id === activeId) ?? sheets[0] ?? null;

  const changeColumns = useCallback((next: YtColumnId[]) => {
    setColumns(next);
    try { localStorage.setItem(COLUMNS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  }, []);

  const shown = useMemo(() => ytVisibleColumns(columns, widthRem), [columns, widthRem]);

  const add = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    // A pasted URL, or a bare playlist id typed directly.
    const guessed = guessUrl(text);
    const id = guessed?.playlistId || (guessed ? '' : text);
    if (!id) {
      // A YouTube URL that is a video-in-a-playlist, or an RD/UL mix, has no
      // importable id — say so rather than sending an empty command.
      return;
    }
    youtube.addSheet(id);
    setDraft('');
  }, [draft, youtube]);

  return (
    <div className="yt">
      {error && (
        <p className="signin__error" role="alert">
          {error}{' '}
          <button type="button" className="linkish" onClick={clearError}>Dismiss</button>
        </p>
      )}

      {/* The sheet strip: one chip per playlist, and the + that adds another. */}
      <div className="yt__strip">
        <div className="yt__tabs" role="tablist">
          {sheets.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active ? s.id === active.id : false}
              className={active && s.id === active.id ? 'yt__tab yt__tab--on pressable' : 'yt__tab pressable'}
              onClick={() => setActiveId(s.id)}
              title={s.sourceId}
            >
              {s.title}
              <span className="yt__tabcount tnum">{s.rows.length}</span>
            </button>
          ))}
        </div>
        <form className="yt__add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input
            className="settings__input"
            value={draft}
            placeholder="Paste a YouTube playlist URL…"
            aria-label="Add a playlist"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="verify pressable" disabled={!draft.trim()}>
            + Add
          </button>
        </form>
      </div>

      {!active ? (
        <div className="empty empty--section">
          <span className="empty__icon"><IconEmpty size={28} painted={1.3} /></span>
          <p className="empty__title">No playlists yet</p>
          <p className="empty__body">
            Paste a public YouTube playlist above. You will need a YouTube Data
            API key and a Discogs token in Settings — the same keys the Dig Bar
            uses. Your liked videos need a Google sign-in, which is not set up yet.
          </p>
        </div>
      ) : (
        <>
          <div className="yt__toolbar">
            <SheetProgress sheet={active} />
            <button
              type="button"
              className="verify pressable"
              disabled={active.pending === 0 || active.enriching}
              title="Look up Discogs for every track not yet matched"
              onClick={() => youtube.enrichPending(active)}
            >
              {active.enriching ? 'Matching…' : 'Match all'}
            </button>
            <button
              type="button"
              className="verify pressable"
              title="Fetch the playlist again and add anything new"
              onClick={() => youtube.refresh(active.id)}
            >
              Refresh
            </button>
            <ViewMenu<YtColumnId>
              columns={columns}
              onColumns={changeColumns}
              columnSet={YT_COLUMN_SET}
              density="table"
            />
            <button
              type="button"
              className="verify pressable"
              title="Remove this sheet"
              onClick={() => {
                youtube.remove(active.id);
                setActiveId(null);
              }}
            >
              <IconClose size={11} painted={1.7} /> Remove
            </button>
          </div>

          <div className="yt__grid" ref={tableRef}>
              <div className="yt__head" style={{ ['--cols' as string]: ytTemplateFor(shown) }}>
                {shown.map((id) => (
                  <span key={id} className="yt__h" data-col={id}>{YT_COLUMNS.label(id)}</span>
                ))}
              </div>

              {active.rows.map((row) => (
                <div key={row.video.videoId}>
                  <div
                    className="yt__row"
                    data-tone={rowTone(row)}
                    style={{ ['--cols' as string]: ytTemplateFor(shown) }}
                  >
                    {shown.map((id) => (
                      <Cell
                        key={id}
                        id={id}
                        row={row}
                        onSearch={onSearch}
                        onBrowseArtist={onBrowseArtist}
                        onDownloaded={(v) => youtube.setDownloaded(active.id, row.video.videoId, v)}
                        onRematch={() => youtube.rematch(active.id, row.video.videoId,
                          discogsQuery(row.video.title, row.video.channel))}
                        onFix={() => {
                          setFixing(row.video.videoId);
                          setFixUrl('');
                        }}
                      />
                    ))}
                  </div>
                  {fixing === row.video.videoId && (
                    <form
                      className="yt__fix"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const url = fixUrl.trim();
                        if (url) youtube.rematch(active.id, row.video.videoId, { discogsUrl: url });
                        setFixing(null);
                      }}
                    >
                      <input
                        className="settings__input"
                        value={fixUrl}
                        autoFocus
                        placeholder="Paste the correct Discogs release URL…"
                        aria-label="Discogs release URL"
                        spellCheck={false}
                        onChange={(e) => setFixUrl(e.target.value)}
                      />
                      <button type="submit" className="verify pressable" disabled={!fixUrl.trim()}>
                        Use this release
                      </button>
                      <button type="button" className="verify pressable" onClick={() => setFixing(null)}>
                        Cancel
                      </button>
                    </form>
                  )}
                </div>
              ))}

            {!active.complete && (
              <p className="settings__hint">
                This playlist is longer than Seek fetched in one pass. Refresh
                to pull more.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** "12 of 40 matched", so the enrichment's progress is legible while it runs. */
function SheetProgress({ sheet }: { sheet: YoutubeSheet }) {
  const total = sheet.rows.length;
  const done = total - sheet.pending;
  if (total === 0 || sheet.pending === 0) return null;
  return (
    <span className="yt__progress tnum" aria-live="polite">
      {done} of {total} matched
    </span>
  );
}

function Cell({
  id, row, onSearch, onBrowseArtist, onDownloaded, onRematch, onFix,
}: {
  id: YtColumnId;
  row: YoutubeRow;
  onSearch(query: string): void;
  onBrowseArtist(artist: string): void;
  onDownloaded(value: boolean): void;
  onRematch(): void;
  onFix(): void;
}) {
  const { video, match } = row;
  const matched = match.status === 'matched' || match.status === 'low' || match.status === 'manual';

  switch (id) {
    case 'title':
      return (
        <span className="yt__cell yt__title" data-col={id} title={video.title}>
          {video.title || '—'}
        </span>
      );

    case 'search':
      return (
        <span className="yt__cell yt__search" data-col={id}>
          <button
            type="button"
            className="verify pressable"
            title={`Search Soulseek for “${searchQuery(row)}”`}
            onClick={() => onSearch(searchQuery(row))}
          >
            <IconSearch size={12} painted={1.5} />
          </button>
        </span>
      );

    case 'duration':
      return (
        <span className="yt__cell tnum" data-col={id}>
          {duration(video.durationSeconds)}
        </span>
      );

    case 'artist':
      if (match.status === 'pending') {
        return <span className="yt__cell yt__muted" data-col={id}>—</span>;
      }
      if (!matched || !match.artist) {
        // No confident artist: offer to look again, or to paste the release.
        return (
          <span className="yt__cell yt__nomatch" data-col={id}>
            <button type="button" className="linkish" onClick={onRematch} title="Search Discogs again">
              {match.status === 'error' ? 'Retry' : 'No match'}
            </button>
            <button type="button" className="linkish" onClick={onFix} title="Paste the correct Discogs release URL">
              Fix
            </button>
          </span>
        );
      }
      return (
        <span className="yt__cell" data-col={id} data-tone={match.status === 'low' ? 'warn' : undefined}>
          <button
            type="button"
            className="linkish"
            title={`Browse ${match.artist} on Discogs`}
            onClick={() => onBrowseArtist(match.artist)}
          >
            {match.artist}
          </button>
        </span>
      );

    case 'track':
      return (
        <span className="yt__cell" data-col={id} title={match.track}>
          {matched ? (match.track || '—') : '—'}
        </span>
      );

    case 'album':
      return (
        <span className="yt__cell" data-col={id} title={match.album}>
          {matched && match.album ? (
            <button
              type="button"
              className="linkish"
              title={`Search for “${match.artist} ${match.album}”`}
              onClick={() => onSearch(`${match.artist} ${match.album}`.trim())}
            >
              {match.album}
            </button>
          ) : '—'}
        </span>
      );

    case 'style': {
      const style = [...match.genres, ...match.styles].join(', ');
      return (
        <span className="yt__cell yt__muted" data-col={id} title={style}>{style || '—'}</span>
      );
    }

    case 'downloaded':
      return (
        <span className="yt__cell yt__dl" data-col={id}>
          <input
            type="checkbox"
            checked={row.downloaded}
            aria-label="Downloaded"
            onChange={(e) => onDownloaded(e.target.checked)}
          />
        </span>
      );

    case 'url':
      return (
        <span className="yt__cell" data-col={id}>
          {video.url ? (
            <a
              className="linkish"
              href={video.url}
              target="_blank"
              rel="noreferrer noopener"
              title={video.url}
            >
              Open
            </a>
          ) : '—'}
        </span>
      );

    case 'published':
      return (
        <span className="yt__cell tnum yt__muted" data-col={id}>
          {video.publishedAt ? video.publishedAt.slice(0, 10) : '—'}
        </span>
      );

    case 'description':
      return (
        <span className="yt__cell yt__muted yt__desc" data-col={id} title={video.description}>
          {cleanForDiscogs(video.description) ? video.description : '—'}
        </span>
      );

    default:
      return <span className="yt__cell" data-col={id} />;
  }
}
