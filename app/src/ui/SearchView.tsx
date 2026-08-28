/*
 * Seek — the search screen.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Layout, per docs/PRODUCT.md §3: a large search field, quick-filter pills
 * directly beneath it, the result count, then results. Advanced filters slide
 * down from the pill row rather than opening a modal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Filters, GroupBy, Release, SortKey } from '../domain/types.ts';
import { filtersActive } from '../domain/types.ts';
import { integer } from '../domain/format.ts';
import type { Row, SearchSession } from '../data/searchStore.ts';
import { SegmentedControl, Select, Chip } from './controls.tsx';
import { ViewMenu } from './ViewMenu.tsx';
import type { Density, SearchDensity } from './ViewMenu.tsx';
import { FilterBar } from './FilterBar.tsx';
import { ResultList } from './ResultList.tsx';
import type { TransferSession } from '../data/transferStore.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import type { LibrarySession } from '../data/libraryStore.ts';
import { judge, pickSource } from '../domain/preferences.ts';
import { copiesOf, groupCopies } from '../domain/bestSources.ts';
import { CopiesSheet } from './CopiesSheet.tsx';
import type { DownloadPrefs } from '../domain/preferences.ts';
import { useSpringNumber } from '../motion/useSpring.ts';
import { DiscoverPreviewCard } from './DiscoverPreview.tsx';
import type { DiscoverSession } from '../data/discoverStore.ts';
import type { PeerLookup } from './PeerHistory.tsx';
import {
  IconChevronDown, IconEmpty, IconRelease, IconSearch, IconStar, IconTrack, IconUser,
} from '../icons/index.tsx';

const GROUPS: Array<{ value: GroupBy; label: string; icon: React.ReactNode }> = [
  { value: 'track', label: 'Track', icon: <IconTrack size={14} painted={1.5} /> },
  { value: 'release', label: 'Release', icon: <IconRelease size={14} painted={1.5} /> },
  { value: 'user', label: 'User', icon: <IconUser size={14} painted={1.5} /> },
];

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'best', label: 'Best' },
  { value: 'quality', label: 'Quality' },
  { value: 'speed', label: 'Speed' },
  { value: 'queue', label: 'Queue' },
  { value: 'size', label: 'Size' },
  { value: 'name', label: 'Name' },
];

/** The quick pills. Each maps to a filter the advanced panel also exposes. */
const QUICK = [
  { id: 'FLAC', kind: 'format' as const },
  { id: 'WAV', kind: 'format' as const },
  { id: 'AIFF', kind: 'format' as const },
  { id: '320', kind: 'format' as const },
  { id: 'lossless', kind: 'lossless' as const, label: 'Lossless only' },
  { id: 'free', kind: 'free' as const, label: 'Free slots' },
  { id: 'clean', kind: 'clean' as const, label: 'No transcodes' },
];

export function SearchView({
  session, searchRef, density, onDensity, transfers, onBrowse, onSave, artwork, library,
  onContext, onWish, prefs, discover, onOpenSettings, onWant, wanted, onBrowseCatalog, onWantTracklist, onWantPlaylist,
  peers,
}: {
  session: SearchSession;
  searchRef: React.RefObject<HTMLInputElement | null>;
  density: SearchDensity;
  onDensity(d: Density): void;
  transfers: TransferSession;
  onBrowse?(username: string): void;
  onSave?(): void;
  artwork?: ArtworkSession;
  library?: LibrarySession;
  onContext?(row: Row, x: number, y: number): void;
  /** Add the current query to the wishlist. */
  onWish?(): void;
  prefs?: DownloadPrefs;
  /** The Dig Bar. Absent in fixture mode, where there is no provider to ask. */
  discover?: DiscoverSession;
  onOpenSettings?(): void;
  /** Keep the previewed link for later rather than searching for it now. */
  onWant?(): void;
  /** True when the previewed link is already on the want list. */
  wanted?: boolean;
  /** Open a label or artist catalogue, when the link names one. */
  onBrowseCatalog?(): void;
  /** Put every track of a parsed set tracklist on the want list. */
  onWantTracklist?(): void;
  /** Put every track of a YouTube playlist on the want list. */
  onWantPlaylist?(): void;
  /** Your own transfer history with each peer, for the reliability chip. */
  peers?: PeerLookup;
  }) {
  const [advanced, setAdvanced] = useState(false);
  /** A file is being dragged over the search field. */
  const [dropping, setDropping] = useState(false);
  /** Why the last queue attempt was refused. Cleared by the next one. */
  const [refused, setRefused] = useState<string | null>(null);
  /* Which release the user is comparing copies of. Opening this downloads
   * nothing: it is the whole point of the change that got rid of the automatic
   * switch — the data goes on screen and the choice stays with the user. */
  const [comparing, setComparing] = useState<Release | null>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const setCount = useSpringNumber(countRef, (n) => integer(Math.max(0, Math.round(n))));

  useEffect(() => {
    setCount(session.matchedFiles);
  }, [session.matchedFiles, setCount]);

  const patch = useCallback(
    (p: Partial<Filters>) => session.setFilters({ ...session.filters, ...p }),
    [session],
  );

  const toggleFormat = useCallback(
    (label: string) => {
      const next = new Set(session.filters.formats);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      patch({ formats: next });
    },
    [session.filters.formats, patch],
  );

  /* Copies of the same record, grouped once per result set rather than per
   * card. Cards are virtualised, so a pairwise scan would run for every row
   * that scrolls into view, on a list that grows all through a search. Scoped
   * to the rows actually on screen: what the comparison offers is what the
   * current filters let through, which is what the count beside Get promises. */
  const copyGroups = useMemo(
    () => groupCopies(session.rows.flatMap((r) => (r.kind === 'release' ? [r.release] : []))),
    [session.rows],
  );

  /* MusicBrainz's track count for a release, when the artwork lookup matched.
   * The card already shows it as "11 of 13". It is the only source here that
   * can PROVE a copy is short of the record, which is why the sheet takes it
   * rather than inferring completeness from the other copies. */
  const artworkTracks = useCallback((id: string) => {
    const art = artwork?.get(id);
    return art?.state === 'ready' ? art.trackCount : null;
  }, [artwork]);

  const queueRelease = useCallback((release: Release) => {
    setRefused(null);
    void transfers.enqueueFolder(release.user, release.folderPath);
  }, [transfers]);

  /* Queue whatever the row represents. A release queues the whole remote
   * folder in one command — the two-phase folder dance lives in the sidecar
   * (RECON.md §5) — because the unit a DJ downloads is a folder, not a file. */
  const rules: DownloadPrefs = prefs
    ?? { preferLossless: false, minBitrate: 0, rejectTranscodes: false };

  const onQueue = useCallback((row: Row) => {
    switch (row.kind) {
      case 'track': {
        // Which source to take is a preference, not a fixed rule: the default
        // score weighs speed and queue alongside format, which is right for
        // tonight and wrong for a collection.
        const chosen = pickSource(row.track.sources, rules);
        const verdict = judge(chosen, rules);
        if (!verdict.allowed) { setRefused(verdict.reason ?? null); return; }
        setRefused(null);
        void transfers.enqueue(chosen.user, chosen.path, chosen.size);
        break;
      }
      case 'source': {
        // An explicit choice of source still respects the hard filters — but
        // never the "prefer lossless" pick, because the user named this file.
        const verdict = judge(row.source, rules);
        if (!verdict.allowed) { setRefused(verdict.reason ?? null); return; }
        setRefused(null);
        void transfers.enqueue(row.source.user, row.source.path, row.source.size);
        break;
      }
      case 'release': {
        /* The copy that was clicked, from the peer whose card it is. This used
         * to rank every other copy in the results and quietly queue a different
         * one — measured handing over a stranger's 13-track copy when a 9-track
         * card had been clicked. Where other copies exist the card offers a
         * comparison instead, and the user picks from it. */
        queueRelease(row.release);
        break;
      }
      case 'user':
        // A user header is a grouping, not a thing to download.
        break;
    }
  }, [transfers, rules, queueRelease]);

  const active = filtersActive(session.filters);
  const available = new Set(session.availableFormats);

  /* Run the search the preview card implies, and put that text in the field:
   * the user must be able to see what was actually searched for, and correct it
   * afterwards like any other query. */
  const runFromPreview = useCallback(() => {
    if (!discover) return;
    const q = discover.query();
    if (!q) return;
    session.setQuery(q);
    session.run(q);
    discover.dismiss();
  }, [discover, session]);

  const onSearchKey = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && discover?.preview) {
      // preventDefault matters on a type="search" input: WebKit's own Escape
      // handling clears the field, which would take the URL with it.
      event.preventDefault();
      discover.dismiss();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    // ⌥↵ keeps it for later instead of searching now — the whole point of the
    // want list is that finding time and listening time are different times.
    if (event.altKey && discover?.preview && onWant) {
      onWant();
      return;
    }
    // A label or artist link's primary action is to browse it, so Return does
    // that rather than searching Soulseek for a label's name.
    if (discover?.preview) {
      const kind = discover.preview.kind;
      if ((kind === 'label' || kind === 'artist') && onBrowseCatalog) onBrowseCatalog();
      else runFromPreview();
      return;
    }
    // Typed rather than pasted: a URL in the field is a link to look up, not a
    // phrase to search Soulseek for.
    if (discover?.inspect(session.query)) return;
    session.run();
  }, [discover, runFromPreview, session, onWant, onBrowseCatalog]);

  return (
    <>
      <header
        className="header"
        onDragOver={(e) => { if (discover) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          if (!discover) return;
          e.preventDefault();
          /* Tauri exposes the real filesystem path on a dropped File; a plain
           * browser does not, and there is nothing the sidecar can do with a
           * name alone. Silence is the right answer there rather than an error
           * about an unsupported environment nobody chose to be in. */
          const file = e.dataTransfer?.files?.[0] as (File & { path?: string }) | undefined;
          if (file?.path) discover.identify(file.path);
        }}
        data-dropping={dropping ? 'true' : undefined}
      >
        <div className="search">
          <IconSearch size={17} painted={1.7} className="search__icon" />
          <input
            ref={searchRef}
            className="search__input"
            type="search"
            value={session.query}
            placeholder="Search Soulseek"
            aria-label="Search Soulseek"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => session.setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            onPaste={(e) => {
              /* Not preventDefault: the field still takes the text. Dismissing
               * the card is supposed to leave the URL sitting there to edit. */
              discover?.inspect(e.clipboardData?.getData('text') ?? '');
            }}
          />
          <kbd className="search__kbd" aria-hidden>⌘↵</kbd>
        </div>

        {discover && (
          <DiscoverPreviewCard
            preview={discover.preview}
            onSearch={runFromPreview}
            onDismiss={discover.dismiss}
            onEdit={discover.edit}
            onOpenSettings={onOpenSettings}
            onWant={onWant}
            wanted={wanted}
            onBrowse={onBrowseCatalog}
            tracklist={discover.tracklist}
            onFindTracklist={discover.findTracklist}
            onWantTracklist={onWantTracklist}
            onWantPlaylist={onWantPlaylist}
            playlist={discover?.playlist}
            playlistId={discover?.playlistId}
            onImportPlaylist={discover?.importPlaylist}
          />
        )}

        {onWish && (
          <button
            type="button"
            className="btn pressable search__wish"
            disabled={!session.query.trim()}
            title="Keep looking for this in the background, on the interval the server allows"
            onPointerDown={onWish}
          >
            <IconStar size={14} painted={1.5} />
            Wishlist
          </button>
        )}

        <div className="quick">
          {QUICK.map((q) => {
            if (q.kind === 'format') {
              if (!available.has(q.id) && !session.filters.formats.has(q.id)) return null;
              return (
                <Chip
                  key={q.id}
                  active={session.filters.formats.has(q.id)}
                  onToggle={() => toggleFormat(q.id)}
                >
                  {q.id}
                </Chip>
              );
            }
            if (q.kind === 'lossless') {
              return (
                <Chip
                  key={q.id}
                  active={session.filters.losslessOnly}
                  onToggle={() => patch({ losslessOnly: !session.filters.losslessOnly })}
                >
                  {q.label}
                </Chip>
              );
            }
            if (q.kind === 'free') {
              return (
                <Chip
                  key={q.id}
                  active={session.filters.freeSlotsOnly}
                  onToggle={() => patch({ freeSlotsOnly: !session.filters.freeSlotsOnly })}
                >
                  {q.label}
                </Chip>
              );
            }
            return (
              <Chip
                key={q.id}
                active={session.filters.excludeTranscodes}
                onToggle={() => patch({ excludeTranscodes: !session.filters.excludeTranscodes })}
              >
                {q.label}
              </Chip>
            );
          })}

          <button
            type="button"
            className="quick__more pressable"
            aria-expanded={advanced}
            onPointerDown={() => setAdvanced((v) => !v)}
          >
            <span>Advanced</span>
            <IconChevronDown
              size={13}
              painted={1.6}
              className="quick__caret"
              data-open={advanced ? 'true' : undefined}
            />
          </button>
        </div>

        {/* Slides down from the pill row. Never a modal. */}
        <div className="advanced" data-open={advanced ? 'true' : undefined}>
          <div className="advanced__inner">
            <FilterBar
              filters={session.filters}
              onChange={session.setFilters}
              onReset={session.resetFilters}
              availableFormats={session.availableFormats}
            />
          </div>
        </div>

        {refused && (
          <p className="refused" role="status">
            {refused}
            <button type="button" className="verify pressable" onPointerDown={() => setRefused(null)}>
              Dismiss
            </button>
          </p>
        )}

        <div className="resultbar">
          <div className="resultbar__count">
            {/* No React children: the spring owns this node's text. A literal
                child here would be rewritten to its JSX value on every render,
                erasing whatever frame the animation had just written. */}
            <span className="tnum" ref={countRef} />
            <span className="resultbar__word">
              {session.matchedFiles === 1 ? 'result' : 'results'}
            </span>
            {active && session.totalFiles !== session.matchedFiles && (
              <span className="resultbar__of tnum">of {integer(session.totalFiles)}</span>
            )}
            {session.running && <span className="resultbar__live">searching…</span>}
            {!session.running && session.closedReason && (
              <span
                className="resultbar__closed"
                title="Soulseek has no completion signal. Peers answer whenever they like and stragglers can arrive minutes later — this only means Seek stopped listening."
              >
                stopped listening
              </span>
            )}
          </div>

          <div className="resultbar__controls">
            <SegmentedControl
              label="Group results by"
              segments={GROUPS}
              value={session.groupBy}
              onChange={session.setGroupBy}
            />
            <Select
              label="Sort results"
              value={session.sort}
              onChange={session.setSort}
              options={SORTS}
            />
            {onSave && session.query.trim() !== '' && (
              <button
                type="button"
                className="btn pressable"
                onPointerDown={onSave}
                title="Save this query together with the filters currently applied"
              >
                Save
              </button>
            )}
            <ViewMenu density={density} onDensity={onDensity} />
          </div>
        </div>
      </header>

      <ResultList
        rows={session.rows}
        currentTick={session.tick}
        density={density}
        expanded={session.expanded}
        onToggle={session.toggleExpanded}
        onQueue={onQueue}
        copies={copyGroups}
        onCompare={setComparing}
        onBrowse={onBrowse}
        artwork={artwork}
        library={library}
        peers={peers}
        onContext={onContext}
        pendingCount={session.pendingCount}
        onFoldIn={session.foldInPending}
        onViewport={session.reportViewport}
        emptyState={
          <div className="empty">
            <IconEmpty size={28} painted={1.3} className="empty__icon" />
            {/* A search that could never have reached the network must say so.
                Showing the ordinary "no results" here would report an empty
                Soulseek when the truth is that we never asked it. */}
            {session.closedReason === 'disconnected' ? (
              <>
                <p className="empty__title">Not signed in to Soulseek</p>
                <p className="empty__body">
                  The search never reached the network. Import your Nicotine+ account in
                  Settings, or sign in there, then try again.
                </p>
              </>
            ) : (
              <>
                <p className="empty__title">
                  {session.totalFiles === 0 ? 'No results yet' : 'Nothing matches these filters'}
                </p>
                <p className="empty__body">
                  {session.totalFiles === 0
                    ? 'Press Return to search. Results stream in for about half a minute.'
                    : `${integer(session.totalFiles)} results are loaded — the filters are hiding all of them.`}
                </p>
              </>
            )}
          </div>
        }
      />

      {/* Opening this queues nothing. It is the comparison that replaced the
          app choosing a source: every copy, the facts that decide between them,
          and a Get on each row that downloads that peer and only that peer. */}
      {comparing && (
        <CopiesSheet
          target={comparing}
          copies={copiesOf(comparing, copyGroups)}
          catalogueTracks={artworkTracks(comparing.id)}
          peers={peers}
          onQueue={(copy) => { queueRelease(copy); setComparing(null); }}
          onClose={() => setComparing(null)}
        />
      )}
    </>
  );
}
