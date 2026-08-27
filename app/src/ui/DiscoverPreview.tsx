/*
 * Seek — the Dig Bar preview card.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Slides down from the search field when the user pastes a music URL. Its job
 * is to let someone paste and press Return without looking — and to make the
 * one case where that would go wrong impossible to miss.
 *
 * So the card is honest about where its fields came from. A Bandcamp or Discogs
 * URL states its artist and title, and the card shows them plainly. A YouTube
 * title is one string somebody typed, and when the parse of it is weak the RAW
 * TITLE is what gets the prominent line, with the parse underneath as a pair of
 * editable fields. Same rule as the search results: never state a guess as a
 * fact (docs/PRODUCT.md §5).
 *
 * MOTION. The card is mounted and unmounted, and the visible movement is
 * `transform` and `opacity` on the content inside a clip — never `height`, per
 * CLAUDE.md. The wrapper's `max-height` is a generous constant and is never
 * animated; the exit runs before unmount so the card does not vanish mid-slide.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiscoverPreview as Preview, TracklistState } from '../data/discoverStore.ts';
import { PROVIDER_LABEL } from '../domain/discoverUrl.ts';
import { TITLE_CONFIDENCE_FLOOR } from '../domain/parseTitle.ts';
import { weakCount } from '../domain/playlistImport.ts';
import type { PlaylistState } from '../data/discoverStore.ts';
import type { TitleSource } from '../domain/parseTitle.ts';
import { useReducedMotion } from '../motion/prefs.ts';
import {
  IconBandcamp, IconClose, IconDiscogs, IconLink, IconYouTube,
} from '../icons/index.tsx';

/** Matches the CSS exit duration. Kept here so the two cannot drift silently. */
const EXIT_MS = 200;

function SourceIcon({ provider }: { provider: Preview['provider'] }) {
  const props = { size: 16, painted: 1.5 } as const;
  if (provider === 'youtube') return <IconYouTube {...props} />;
  if (provider === 'bandcamp') return <IconBandcamp {...props} />;
  if (provider === 'discogs') return <IconDiscogs {...props} />;
  return <IconLink {...props} />;
}

/**
 * One line saying where the fields came from. The user's first question when a
 * parse looks wrong is "where did you get that", and answering it in advance is
 * what makes the editable fields feel like a correction rather than a repair.
 */
function provenance(preview: Preview): string {
  /* A credential that EXISTS and was refused. Separate from 'needs-setting'
   * because the action is different: not "add one", but "the one you added is
   * wrong". 0.2.2 told people to supply a token they had already supplied,
   * which from the outside is indistinguishable from the app being broken. */
  if (preview.error === 'unauthorised') {
    return `${PROVIDER_LABEL[preview.provider ?? 'discogs']} rejected your token`;
  }
  if (preview.error === 'needs-setting') {
    return `${PROVIDER_LABEL[preview.provider ?? 'discogs']} lookups need a token`;
  }
  /* Names the provider when we know it. "Could not reach Bandcamp" says where
   * the problem is; for a custom domain we never identified, "that site" is the
   * honest wording rather than a guess. */
  if (preview.error === 'unreachable') {
    const who = preview.provider ? PROVIDER_LABEL[preview.provider] : 'that site';
    return `Could not reach ${who}`;
  }
  if (preview.error) return 'Not a link Seek recognises';

  const source = preview.provider ? PROVIDER_LABEL[preview.provider] : 'the link';
  if (preview.parsedFrom === null) return `From ${source} metadata`;

  const how: Record<TitleSource, string> = {
    separator: 'Parsed from the video title',
    quoted: 'Parsed from the video title',
    colon: 'Parsed from the video title',
    comma: 'Parsed from the video title — check the split',
    reversed: 'Parsed from the video title',
    series: 'Read as a series episode — check the artist',
    billing: 'Read as a DJ set billing — check the title',
    channel: `Artist taken from the ${source} channel`,
    raw: 'Could not split this title — search it as it is, or edit below',
  };
  return how[preview.parsedFrom];
}

export function DiscoverPreviewCard({
  preview, onSearch, onDismiss, onEdit, onOpenSettings, onWant, wanted, onBrowse,
  tracklist, onFindTracklist, onWantTracklist,
  playlist, playlistId, onImportPlaylist, onWantPlaylist,
}: {
  preview: Preview | null;
  onSearch(): void;
  onDismiss(): void;
  onEdit(patch: { artist?: string; title?: string }): void;
  onOpenSettings?(): void;
  /** Keep it for later. Absent until the want list exists (fixture mode). */
  onWant?(): void;
  /** True once this link is on the list, so the action can say so. */
  wanted?: boolean;
  /** Open the catalogue, when the link names a label or an artist. */
  onBrowse?(): void;
  /** A DJ set's tracklist, once asked for. */
  tracklist?: TracklistState | null;
  /** The playlist behind this link, once asked for. */
  playlist?: PlaylistState | null;
  /** Non-empty when the URL names an importable playlist. */
  playlistId?: string;
  onImportPlaylist?(): void;
  onWantPlaylist?(): void;
  onFindTracklist?(): void;
  onWantTracklist?(): void;
}) {
  const reduced = useReducedMotion();
  /* Keep rendering the last card through its exit, so dismissing animates out
   * instead of disappearing between frames. */
  const [shown, setShown] = useState<Preview | null>(preview);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef(0);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (preview) {
      setShown(preview);
      setLeaving(false);
      return;
    }
    if (!shown) return;
    setLeaving(true);
    timer.current = window.setTimeout(() => setShown(null), reduced ? 0 : EXIT_MS);
    // `shown` is deliberately not a dependency: reacting to it would restart the
    // exit timer every time the card re-rendered on its way out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, reduced]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
      return;
    }
    // Return from inside a field searches, so a correction can be committed
    // without reaching for the mouse.
    if (event.key === 'Enter') {
      event.preventDefault();
      onSearch();
    }
  }, [onDismiss, onSearch]);

  if (!shown) return null;

  const weak = shown.confidence < TITLE_CONFIDENCE_FLOOR;
  const catalogue = shown.kind === 'label' || shown.kind === 'artist';
  const detail = [
    shown.year ? String(shown.year) : '',
    shown.label ?? '',
    shown.catalogNumber ?? '',
    shown.trackCount ? `${shown.trackCount} tracks` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="dig" data-leaving={leaving ? 'true' : undefined} role="region"
         aria-label="Pasted link">
      <div className="dig__inner" onKeyDown={onKeyDown}>
        <div className="dig__art" aria-hidden>
          {shown.artworkUri
            ? <img className="dig__img" src={shown.artworkUri} alt="" />
            : <span className="dig__placeholder"><SourceIcon provider={shown.provider} /></span>}
        </div>

        <div className="dig__body">
          <p className="dig__source">
            <SourceIcon provider={shown.provider} />
            <span>
              {shown.loading
                ? `Reading the ${shown.provider ? PROVIDER_LABEL[shown.provider] : ''} link…`.replace('  ', ' ')
                : provenance(shown)}
            </span>
          </p>

          {shown.loading ? (
            <div className="dig__skeleton" aria-hidden>
              <span className="dig__bar dig__bar--title" />
              <span className="dig__bar dig__bar--artist" />
            </div>
          ) : shown.error ? (
            <div className="dig__error">
              <p className="dig__raw">{shown.url}</p>
              <p className="dig__hint">
                {shown.error === 'unauthorised'
                  ? 'The token is saved, but the provider would not accept it. Generate a '
                    + 'fresh one and paste it into Settings → External lookups.'
                  : shown.needs === 'discogsToken'
                  ? 'Add a Discogs personal access token in Settings and paste this again.'
                  /* Searching Soulseek for the URL text is the right fallback for a
                     link nothing recognises, and the wrong one for a link that is
                     probably fine — it buries a network problem under a search for
                     a string of slashes. */
                  : shown.error === 'unreachable'
                    ? 'The link may be fine. Check your connection and paste it again.'
                    : 'Press Return to search Soulseek for this text instead.'}
              </p>
            </div>
          ) : (
            <>
              {/* When the parse is weak the raw title leads, because it is the
                  only thing here we know to be true. */}
              {weak && shown.rawTitle && (
                <p className="dig__raw" title={shown.rawTitle}>{shown.rawTitle}</p>
              )}

              <div className="dig__fields">
                <label className="dig__field">
                  <span className="dig__label">Artist</span>
                  <input
                    className="dig__input"
                    value={shown.artist}
                    placeholder="Unknown"
                    spellCheck={false}
                    aria-label="Artist"
                    onChange={(e) => onEdit({ artist: e.target.value })}
                  />
                </label>
                <label className="dig__field">
                  <span className="dig__label">
                    {shown.kind === 'release' ? 'Release' : 'Title'}
                  </span>
                  <input
                    className="dig__input"
                    value={shown.kind === 'release' ? (shown.album ?? shown.title) : shown.title}
                    spellCheck={false}
                    aria-label={shown.kind === 'release' ? 'Release' : 'Title'}
                    onChange={(e) => onEdit({ title: e.target.value })}
                  />
                </label>
              </div>

              {detail && <p className="dig__detail tnum">{detail}</p>}

              {/* A DJ set's tracklist. Only offered for YouTube, where a
                  description is the only place one could be, and only after
                  the user asks — it costs a page fetch and most videos have
                  none. */}
              {shown.provider === 'youtube' && shown.kind === 'track' && onFindTracklist && (
                <div className="dig__tracklist">
                  {!tracklist ? (
                    <button type="button" className="verify pressable" onPointerDown={onFindTracklist}>
                      Look for a tracklist
                    </button>
                  ) : tracklist.loading ? (
                    <span className="dig__hint">Reading the description…</span>
                  ) : tracklist.tracks.length === 0 ? (
                    <span className="dig__hint">
                      No tracklist in this description — most videos have none.
                    </span>
                  ) : (
                    <>
                      <span className="dig__hint">
                        {tracklist.tracks.length} tracks listed in the description
                      </span>
                      <ol className="dig__tracks">
                        {tracklist.tracks.slice(0, 4).map((t) => (
                          <li key={t.position} className="dig__track">
                            <span className="dig__track-at tnum">
                              {Math.floor(t.offsetSeconds / 60)}:
                              {String(t.offsetSeconds % 60).padStart(2, '0')}
                            </span>
                            <span className="dig__track-text">{t.text}</span>
                          </li>
                        ))}
                        {tracklist.tracks.length > 4 && (
                          <li className="dig__track dig__track--more">
                            and {tracklist.tracks.length - 4} more
                          </li>
                        )}
                      </ol>
                      {onWantTracklist && (
                        <button type="button" className="verify pressable" onPointerDown={onWantTracklist}>
                          Add all {tracklist.tracks.length} to Want List
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

            </>
          )}

            {/* A playlist behind the link. Offered only when the URL names
                an importable one — YouTube's auto-generated RD/UL mixes are
                built per viewer and the API refuses them, so offering an
                import there would promise something undeliverable. Asked
                for rather than automatic: a long playlist costs several
                rate-limited requests. */}
            {playlistId && onImportPlaylist && (
              <div className="dig__tracklist">
                {!playlist ? (
                  <button type="button" className="verify pressable" onPointerDown={onImportPlaylist}>
                    Read this playlist
                  </button>
                ) : playlist.loading ? (
                  <span className="dig__hint">Reading the playlist…</span>
                ) : playlist.needs ? (
                  <span className="dig__hint">
                    A YouTube Data API key is needed to read a playlist.
                    {onOpenSettings && (
                      <button type="button" className="verify pressable" onPointerDown={onOpenSettings}>
                        Open Settings
                      </button>
                    )}
                  </span>
                ) : playlist.error === 'unreachable' ? (
                  <span className="dig__hint">
                    Could not reach YouTube. Check your connection.
                  </span>
                ) : playlist.error ? (
                  <span className="dig__hint">That playlist could not be read.</span>
                ) : playlist.entries.length === 0 ? (
                  <span className="dig__hint">Nothing importable in that playlist.</span>
                ) : (
                  <>
                    <span className="dig__hint">
                      <span className="tnum">{playlist.entries.length}</span> tracks
                      {/* Only ever claims what it actually fetched. */}
                      {!playlist.complete && (
                        <> of <span className="tnum">{playlist.total}</span> — the rest were not fetched</>
                      )}
                      {weakCount(playlist.entries) > 0 && (
                        <> · <span className="tnum">{weakCount(playlist.entries)}</span> worth a glance</>
                      )}
                    </span>
                    <ol className="dig__tracks">
                      {playlist.entries.slice(0, 4).map((e) => (
                        <li key={e.videoId} className="dig__track">
                          <span className="dig__track-at tnum">{e.artist || '—'}</span>
                          <span className="dig__track-text">{e.title}</span>
                        </li>
                      ))}
                      {playlist.entries.length > 4 && (
                        <li className="dig__track dig__track--more">
                          and {playlist.entries.length - 4} more
                        </li>
                      )}
                    </ol>
                    {onWantPlaylist && (
                      <button type="button" className="verify pressable" onPointerDown={onWantPlaylist}>
                        Add all {playlist.entries.length} to Want List
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
        </div>

        <div className="dig__actions">
          {/* A label or artist URL names a CATALOGUE, not a record. Searching
              Soulseek for "Hyperdub" returns whatever happens to have the word
              in its path; browsing the discography is the useful action, so it
              takes the primary slot when the link is one of those. */}
          {catalogue && onBrowse ? (
            <button
              type="button"
              className="btn btn--primary pressable"
              disabled={shown.loading}
              onPointerDown={onBrowse}
            >
              {/* Bandcamp does not distinguish a label page from an artist
                  page, so the wording does not either rather than asserting
                  which one this is. */}
              {shown.provider === 'bandcamp' ? 'Browse the catalogue' : `Browse the ${shown.kind}`}
              <kbd className="dig__kbd" aria-hidden>↵</kbd>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary pressable"
              disabled={shown.loading}
              onPointerDown={onSearch}
            >
              Search Soulseek
              <kbd className="dig__kbd" aria-hidden>↵</kbd>
            </button>
          )}
          {onWant && !shown.error && (
            <button
              type="button"
              className="btn pressable"
              disabled={shown.loading || wanted}
              title={wanted
                ? 'Already on your want list'
                : 'Keep this for later without searching now'}
              onPointerDown={onWant}
            >
              {wanted ? 'On the list' : 'Want List'}
              {!wanted && <kbd className="dig__kbd" aria-hidden>⌥↵</kbd>}
            </button>
          )}
          {shown.needs === 'discogsToken' && onOpenSettings && (
            <button type="button" className="verify pressable" onPointerDown={onOpenSettings}>
              Open Settings
            </button>
          )}
          <button
            type="button"
            className="dig__close pressable"
            aria-label="Dismiss (Escape)"
            title="Dismiss — the link stays in the search field"
            onPointerDown={onDismiss}
          >
            <IconClose size={14} painted={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
