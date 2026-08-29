/*
 * Seek — app shell and global keyboard navigation.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from './ui/Sidebar.tsx';
import { UpdateBanner } from './ui/UpdateBanner.tsx';
import type { ConnectionStatus, Section } from './ui/Sidebar.tsx';
import type { SearchSession } from './data/searchStore.ts';
import type { SidecarClient } from './data/sidecarClient.ts';
import { SearchView } from './ui/SearchView.tsx';
import { SectionView } from './ui/views.tsx';
import type { Density, SearchDensity } from './ui/ViewMenu.tsx';
import { normaliseColumns } from './domain/searchColumns.ts';
import type { ColumnId } from './domain/searchColumns.ts';
import { isSignedIn, useSearchSession } from './data/searchStore.ts';
import { useSidecarConnection } from './data/connectionStore.ts';
import { useSearchTabs } from './data/searchTabs.ts';
import { useChatSession } from './data/chatStore.ts';
import { useTransfers } from './data/transferStore.ts';
import { useUpdates } from './data/updateStore.ts';
import { useAnalysis } from './data/analysisStore.ts';
import { useBrowse } from './data/browseStore.ts';
import { useArtwork } from './data/artworkStore.ts';
import { useLibrary } from './data/libraryStore.ts';
import { usePrefs } from './data/prefsStore.ts';
import { useEngine } from './data/engineStore.ts';
import { useThroughput } from './data/throughputStore.ts';
import { useTransferStats } from './data/statsStore.ts';
import { useConnections, useProfile } from './data/profileStore.ts';
import { TransferStatsView } from './ui/TransferStatsView.tsx';
import { UploadsView } from './ui/UploadsView.tsx';
import { useDiscover } from './data/discoverStore.ts';
import { resultsMatch, useWant } from './data/wantStore.ts';
import type { WantEntry } from './data/wantStore.ts';
import { WantListView } from './ui/WantListView.tsx';
import { useSessions } from './data/sessionStore.ts';
import { DigSessionsView } from './ui/DigSessionsView.tsx';
import { useCatalog } from './data/catalogStore.ts';
import { useLabels } from './data/labelStore.ts';
import type { WatchedLabel } from './data/labelStore.ts';
import { LabelsView } from './ui/LabelsView.tsx';
import { LabelBrowserView } from './ui/LabelBrowserView.tsx';
import { useRelated } from './data/relatedStore.ts';
import { LibraryView } from './ui/LibraryView.tsx';
import { BrowseView } from './ui/BrowseView.tsx';
import { WishlistView } from './ui/WishlistView.tsx';
import { FollowedView, HistoryView, SavedView, serialiseFilters } from './ui/DiscoveryViews.tsx';
import { DownloadsView } from './ui/DownloadsView.tsx';
import { ChatView } from './ui/ChatView.tsx';
import { CommandPalette } from './ui/CommandPalette.tsx';
import { ContextMenu } from './ui/ContextMenu.tsx';
import { usePreview } from './ui/Preview.tsx';
import { useDownloadNotifications } from './data/notify.ts';
import type { MenuRequest } from './ui/ContextMenu.tsx';
import type { Command } from './ui/CommandPalette.tsx';
import type { MenuItem } from './ui/ContextMenu.tsx';
import type { Row } from './data/searchStore.ts';
import './styles/components.css';
import { copyText } from './data/clipboard.ts';

/** ⌘1–4, per docs/PRODUCT.md §2. */
const NUMBER_KEYS: Record<string, Section> = {
  '1': 'search',
  '2': 'downloads',
  '3': 'completed',
  '4': 'settings',
  '5': 'chat',
  '6': 'messages',
  '8': 'want',
  '9': 'sessions',
};

const DENSITY_KEY = 'seek.density';
/* Downloads keeps its OWN density. The two lists answer different questions —
 * search results are things you are still judging, transfers are things you
 * have already decided on — and a collector who wants roomy release cards while
 * choosing usually wants a dense table while watching them arrive. */
const DL_DENSITY_KEY = 'seek.density.downloads';
/* The table's columns. Local, like density, and for the same reason: it is a
   view preference about this machine's window, not an account setting the
   sidecar has any use for. */
const COLUMNS_KEY = 'seek.columns';

function storedColumns(): ColumnId[] {
  try {
    return normaliseColumns(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? 'null'));
  } catch {
    // Unreadable, unparseable, or a shape from a future version: the defaults
    // are always renderable, which is the only thing this must guarantee.
    return normaliseColumns(null);
  }
}

/* Grid is a Downloads layout only, so a stored 'grid' reaching the search list
 * — from an older build, or a hand-edited localStorage — resolves to the
 * roomiest thing search does have rather than to a layout it cannot render. */
function searchDensity(d: Density): SearchDensity {
  return d === 'grid' ? 'comfortable' : d;
}

function storedDensity(key: string, fallback: Density): Density {
  try {
    const raw = localStorage.getItem(key);
    return raw === 'compact' || raw === 'table' || raw === 'comfortable' || raw === 'grid'
      ? raw : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Four distinct states, because collapsing them would lie. A live socket to the
 * sidecar does not mean we are signed in to Soulseek, and saying "Connected"
 * when a search would return `not_connected` is exactly the confidently-wrong
 * behaviour this app exists to avoid.
 */
function connectionStatus(session: SearchSession): ConnectionStatus {
  if (session.isMock) {
    return {
      dot: 'offline',
      label: 'Offline — mock data',
      detail: 'Replaying a recorded search. Start the sidecar and reload with '
        + '?sidecar=host:port&token=… to search the real network.',
    };
  }
  if (session.phase === 'connecting') {
    return { dot: 'pending', label: 'Connecting…', detail: 'Reaching the sidecar.' };
  }
  if (session.phase === 'closed') {
    return {
      dot: 'offline',
      label: 'Sidecar unreachable',
      detail: 'The sidecar is not answering. It may have exited, or the token may be wrong.',
    };
  }
  if (!isSignedIn(session.serverState)) {
    return {
      dot: 'pending',
      label: 'Not signed in',
      detail: 'The sidecar is running but not logged in to Soulseek. '
        + 'Sign in from Settings, or import your Nicotine+ account there.',
    };
  }
  return { dot: 'online', label: 'Connected', detail: 'Signed in to Soulseek.' };
}

export default function App() {
  const [section, setSection] = useState<Section>('search');
  const [density, setDensity] = useState<SearchDensity>(
    () => searchDensity(storedDensity(DENSITY_KEY, 'comfortable')),
  );
  /* Table by default here, unlike search. A transfer list is a status board:
     the question is "what is happening to all of it", and the card layout
     answered that for four releases per screen. */
  const [columns, setColumns] = useState<ColumnId[]>(storedColumns);
  const changeColumns = useCallback((next: ColumnId[]) => {
    setColumns(next);
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(next));
    } catch {
      /* nothing to do — the choice simply won't be remembered */
    }
  }, []);

  const [dlDensity, setDlDensity] = useState<Density>(
    () => storedDensity(DL_DENSITY_KEY, 'table'),
  );
  const searchRef = useRef<HTMLInputElement>(null);
  /* Prefs first: the search session scores sources using real transfer
   * history, so the lookup has to exist before the session that reads it. */
  const [prefsClient, setPrefsClient] = useState<SidecarClient | null>(null);
  const prefs = usePrefs(prefsClient);
  /* One connection, shared. The search session is per-tab and takes it. */
  const conn = useSidecarConnection();
  const session = useSearchSession(conn, { reliability: prefs.reliability });
  /* Several searches open at once. One runs at a time — the transport allows no
   * more — so a tab is a search put away with everything needed to bring it
   * back. See data/searchTabs.ts. */
  const searchTabs = useSearchTabs(session);
  // The client is created inside the session, so hand it back to prefs once.
  useEffect(() => { setPrefsClient(session.client); }, [session.client]);
  const chat = useChatSession(session.client, isSignedIn(session.serverState));
  /* pynicotine's own configuration — folders, port, limits, shares. Distinct
   * from `prefs`, which is Seek's; see the header on `data/engineStore.ts`. */
  const engine = useEngine(session.client);
  const throughput = useThroughput(session.client);
  const transferStats = useTransferStats(session.client);
  const profile = useProfile(session.client);
  const connections = useConnections(session.client);
  const roomUnread = chat.conversations
    .reduce((n, c) => n + (c.scope === 'room' ? c.unread : 0), 0);
  const privateUnread = chat.conversations
    .reduce((n, c) => n + (c.scope === 'private' ? c.unread : 0), 0);
  /* Minutes in the setting, seconds in the store — the setting is a number a
   * person picks and the store compares against a clock. Converting at the one
   * boundary keeps the unit out of both. */
  const transfers = useTransfers(
    session.client,
    prefs.settings.stalledFailMinutes * 60,
    prefs.settings.clearCompletedDays,
  );
  const updates = useUpdates();
  const analysis = useAnalysis(session.client);
  const artwork = useArtwork(session.client);
  const library = useLibrary(session.client);
  const browse = useBrowse(session.client, library.ownedReleases);
  const preview = usePreview(session.client);
  const discover = useDiscover(session.client);
  const want = useWant(session.client);
  const sessions = useSessions(session.client, want.entries);
  const catalog = useCatalog(session.client);
  const labels = useLabels(session.client);
  const related = useRelated(session.client);
  /* The want entry whose search is in flight. One at a time on purpose:
     Soulseek throttles a client that searches faster than the server allows,
     and CLAUDE.md records that as the thing which gets an account limited. */
  const [searchingWant, setSearchingWant] = useState<WantEntry | null>(null);
  useDownloadNotifications(transfers.groups);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menu, setMenu] = useState<MenuRequest | null>(null);


  /** Back/forward through visited sections, for ⌘[ and ⌘]. */
  const history = useRef<Section[]>(['search']);
  const cursor = useRef(0);

  const go = useCallback((next: Section) => {
    setSection((cur) => {
      if (cur === next) return cur;
      history.current = [...history.current.slice(0, cursor.current + 1), next];
      cursor.current = history.current.length - 1;
      return next;
    });
  }, []);

  /* Search for a want list entry, then judge the outcome.
   *
   * This is the half of `want.*` the sidecar deliberately does not do. It
   * cannot: Soulseek has no completion signal, so "not found" is a timeout
   * decision, and whether a result IS the wanted record is fuzzy matching over
   * parsed paths, which lives here beside the parser that produced them. */
  const searchWant = useCallback((entry: WantEntry) => {
    setSearchingWant(entry);
    want.update(entry.id, { status: 'searching' });
    const query = want.queryFor(entry);
    session.setQuery(query);
    setSection('search');
    session.run(query);
  }, [want, session]);

  useEffect(() => {
    // The search the user launched from the want list has stopped listening.
    if (!searchingWant || session.running) return;
    if (!session.closedReason) return;
    const names = session.rows.flatMap((row) => (
      row.kind === 'release' ? [`${row.release.artist ?? ''} ${row.release.title}`]
        : row.kind === 'track' ? [`${row.track.displayArtist ?? ''} ${row.track.displayTitle}`]
          : []
    ));
    want.update(searchingWant.id, {
      status: resultsMatch(searchingWant, names) ? 'found' : 'not_found',
    });
    setSearchingWant(null);
  }, [searchingWant, session.running, session.closedReason, session.rows, want]);

  /* Every URL already on the want list. Both the Dig Bar card and the
     catalogue grid ask "have I saved this one", and computing it once keeps
     the two answers from disagreeing. */
  const wantedUrls = useMemo(
    () => new Set(want.entries.map((e) => e.sourceUrl).filter((u): u is string => Boolean(u))),
    [want.entries],
  );

  const searchCatalogEntry = useCallback((entry: { artist: string; title: string }) => {
    const q = `${entry.artist} ${entry.title}`.replace(/\s+/g, ' ').trim();
    session.setQuery(q);
    setSection('search');
    session.run(q);
  }, [session]);

  const wantCatalogEntry = useCallback((entry: {
    artist: string; title: string; year: number | null; catno: string; url: string;
  }) => {
    void want.add([{
      artist: entry.artist,
      title: entry.title,
      album: entry.title,
      year: entry.year,
      catalogNumber: entry.catno || null,
      sourceKind: 'discogs',
      sourceUrl: entry.url,
      tracklist: [],
    }]);
  }, [want]);

  /* What the open catalogue would be watched AS. Null for anything that
   * cannot be re-opened later — `labels.watch` refuses those, and offering a
   * button that always fails is worse than not offering one. */
  const watchRequest = useMemo(() => {
    const c = catalog.catalog;
    if (!c || !c.name) return null;
    if (c.sourceKind !== 'discogs' && c.sourceKind !== 'bandcamp') return null;
    // Bandcamp has no ids at all, so its catalogue is only re-findable by URL.
    if (c.sourceKind === 'bandcamp' && !c.url) return null;
    return {
      sourceKind: c.sourceKind,
      kind: c.kind,
      name: c.name,
      url: c.url,
      entityId: c.entityId,
    };
  }, [catalog.catalog]);

  const watchedLabel = useMemo(
    () => (watchRequest ? labels.find(watchRequest) : null),
    [watchRequest, labels],
  );

  /** Re-open a watched catalogue. This is the read the watchlist never does
   *  on its own — several rate-limited requests, so it happens on a press. */
  const openWatchedLabel = useCallback((label: WatchedLabel) => {
    catalog.browse({
      sourceKind: label.sourceKind,
      kind: label.kind,
      // The id where there is one: it skips the fuzzy name search entirely.
      id: label.entityId,
      name: label.name,
      url: label.url || null,
    });
    go('catalog');
  }, [catalog, go]);

  /** Open a label or artist catalogue from a parsed Dig Bar link. */
  const browseCatalog = useCallback(() => {
    const p = discover.preview;
    if (!p || !p.provider || (p.kind !== 'label' && p.kind !== 'artist')) return;
    catalog.browse({
      sourceKind: p.provider,
      kind: p.kind,
      name: p.title || p.rawTitle || null,
      url: p.url,
    });
    discover.dismiss();
    go('catalog');
  }, [discover, catalog, go]);

  /** Put every track of a set's tracklist on the want list at once. */
  const addPlaylistToWant = useCallback(() => {
    const pl = discover.playlist;
    if (!pl || pl.entries.length === 0) return;
    void want.add(pl.entries.map((e) => ({
      artist: e.artist,
      /* A title the parser could not split still goes on the list as its own
       * raw text: an unsplit line is still searchable, and dropping it would
       * silently lose a track from the playlist. */
      title: e.title || e.raw,
      sourceKind: 'youtube' as const,
      sourceUrl: `https://www.youtube.com/watch?v=${e.videoId}`,
      sourceTitle: e.raw,
      tracklist: [],
    })));
    discover.dismiss();
    go('want');
  }, [discover, want, go]);

  const addTracklistToWant = useCallback(() => {
    const tl = discover.tracklist;
    const p = discover.preview;
    if (!tl || tl.tracks.length === 0) return;
    void want.add(tl.tracks.map((t) => ({
      artist: t.artist,
      // A line the parser could not split still goes on the list, as its own
      // raw text: an unsplit "Burial - Archangel" is still searchable, and
      // dropping it would silently lose a track from the set.
      title: t.title || t.text,
      sourceKind: 'youtube' as const,
      sourceUrl: p ? `${p.url}&t=${t.offsetSeconds}` : null,
      sourceTitle: t.text,
      tracklist: [],
    })));
    discover.dismiss();
    go('want');
  }, [discover, want, go]);

  /** Keep the previewed link instead of searching for it. */
  const addPreviewToWant = useCallback(() => {
    const p = discover.preview;
    if (!p || p.loading || p.error) return;
    void want.add([{
      artist: p.artist,
      title: p.title,
      album: p.album,
      year: p.year,
      label: p.label,
      catalogNumber: p.catalogNumber,
      sourceKind: p.provider ?? 'manual',
      sourceUrl: p.url,
      // What the provider actually said, kept beside what we made of it: a
      // parse the user corrects should not erase what it was corrected from.
      sourceTitle: p.rawTitle || null,
      artworkUri: p.artworkUri,
      tracklist: [],
    }]);
    discover.dismiss();
    go('want');
  }, [discover, want, go]);

  /** Wishlist adds happen from three places; keep the behaviour in one. */
  const addWish = useCallback((query: string) => {
    const q = query.trim();
    if (!q || !session.client) return;
    void session.client.request('wishlist.add', { query: q }).catch(() => {});
    go('wishlist');
  }, [session.client, go]);

  const changeDensity = useCallback((d: Density) => {
    // The search menu never offers Grid, so this narrowing is a formality —
    // but it is the one place the two density spaces meet, so it is stated.
    setDensity(searchDensity(d));
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      /* nothing to do — density simply won't be remembered */
    }
  }, []);

  const changeDlDensity = useCallback((d: Density) => {
    setDlDensity(d);
    try {
      localStorage.setItem(DL_DENSITY_KEY, d);
    } catch {
      /* nothing to do — density simply won't be remembered */
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target?.isContentEditable;

      // Space toggles the preview, but only when it is not being typed. The
      // brief asks for Space-to-preview; stealing the space bar mid-query
      // would be a worse bug than not having the shortcut.
      if (e.key === ' ' && !typing && !e.metaKey && !e.ctrlKey) {
        if (preview.activeId) {
          e.preventDefault();
          preview.stop();
        }
        return;
      }

      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      if (e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === 'f') {
        e.preventDefault();
        setSection('search');
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      /* ⌘T, as everywhere else that has tabs. It has to exist rather than only
       * the + in the strip, because the strip is hidden until there are two
       * tabs — so the button that makes the second one would have been inside
       * the thing that only appears once it exists. */
      if (e.key === 't') {
        e.preventDefault();
        setSection('search');
        searchTabs.open();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        setSection('search');
        session.run();
        return;
      }
      if (NUMBER_KEYS[e.key]) {
        e.preventDefault();
        go(NUMBER_KEYS[e.key]);
        return;
      }
      if (e.key === '[') {
        e.preventDefault();
        if (cursor.current > 0) {
          cursor.current -= 1;
          setSection(history.current[cursor.current]);
        }
        return;
      }
      if (e.key === ']') {
        e.preventDefault();
        if (cursor.current < history.current.length - 1) {
          cursor.current += 1;
          setSection(history.current[cursor.current]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, session, preview]);

  // Start the recorded session so the app is never a dead screen.
  //
  // Deliberately NOT ref-guarded: StrictMode mounts, unmounts and remounts, and
  // the unmount tears the sidecar down. A "run once" guard would skip the restart
  // and leave a permanently empty list in development. `run()` resets cleanly, so
  // being invoked twice is harmless.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    // Only against recorded data. Firing a real Soulseek search for someone
    // else's demo query the instant the app opens would be presumptuous, and
    // it burns a search slot the user did not ask for.
    if (!sessionRef.current.isMock) return;
    /* Set the box as well as running it, the way every other caller of `run`
     * does. The field no longer starts with a query in it, so without this the
     * replay would show results for a search the box claims was never made. */
    sessionRef.current.setQuery('burial');
    sessionRef.current.run('burial');
  }, []);

  /* Actions, not a mirror of the navigation. Rebuilt whenever the state they
   * close over changes, so a command always acts on what is true now. */
  const commands: Command[] = useMemo(() => {
    const go2 = (id: Section) => () => go(id);
    const list: Command[] = [
      { id: 'go.search', group: 'Go', label: 'Search', shortcut: '⌘1', run: go2('search') },
      { id: 'go.downloads', group: 'Go', label: 'Downloads', shortcut: '⌘2', run: go2('downloads') },
      { id: 'go.completed', group: 'Go', label: 'Completed', shortcut: '⌘3', run: go2('completed') },
      { id: 'go.failed', group: 'Go', label: 'Failed', run: go2('failed') },
      { id: 'go.uploads', group: 'Go', label: 'Uploads', run: go2('uploads') },
      { id: 'go.stats', group: 'Go', label: 'Statistics', run: go2('stats') },
      /* The sidebar's Library. It was the ONE section reachable by neither a
         shortcut nor the palette, so the only way in was clicking it — and the
         sidebar activates on pointerdown, which a keyboard never sends. A
         keyboard user could focus the item and press Return all day. */
      { id: 'go.library', group: 'Go', label: 'Library', run: go2('collections') },
      {
        id: 'search.newtab', group: 'Search', label: 'New search tab', shortcut: '⌘T',
        run: () => { setSection('search'); searchTabs.open(); searchRef.current?.focus(); },
      },
      { id: 'go.wishlist', group: 'Go', label: 'Wishlist', run: go2('wishlist') },
      { id: 'go.history', group: 'Go', label: 'Search History', run: go2('history') },
      { id: 'go.saved', group: 'Go', label: 'Saved Searches', run: go2('saved') },
      /* Only where there is something to go to, matching the sidebar — a
         palette entry that lands on an empty state is a dead end. */
      ...(labels.labels.length > 0
        ? [{ id: 'go.labels', group: 'Go', label: 'Labels', run: go2('labels') }]
        : []),
      { id: 'go.followed', group: 'Go', label: 'Followed', run: go2('followed') },
      { id: 'go.browse', group: 'Go', label: 'Browse a user', run: go2('browsing') },
      { id: 'go.rooms', group: 'Go', label: 'Chat rooms', shortcut: '⌘5', run: go2('chat') },
      { id: 'go.messages', group: 'Go', label: 'Private chats', shortcut: '⌘6', run: go2('messages') },
      { id: 'go.settings', group: 'Go', label: 'Settings', shortcut: '⌘4', run: go2('settings') },

      {
        id: 'search.focus', group: 'Search', label: 'Focus the search field', shortcut: '⌘F',
        run: () => { setSection('search'); searchRef.current?.focus(); searchRef.current?.select(); },
      },
      {
        id: 'search.run', group: 'Search', label: 'Run this search again', shortcut: '⌘↵',
        hint: session.query || undefined,
        run: () => { setSection('search'); session.run(); },
      },
      {
        id: 'search.stop', group: 'Search', label: 'Stop listening for results',
        run: () => session.stop(),
      },
      { id: 'group.track', group: 'Group by', label: 'Track', run: () => session.setGroupBy('track') },
      { id: 'group.release', group: 'Group by', label: 'Release', run: () => session.setGroupBy('release') },
      { id: 'group.user', group: 'Group by', label: 'User', run: () => session.setGroupBy('user') },
      { id: 'sort.best', group: 'Sort by', label: 'Best', run: () => session.setSort('best') },
      { id: 'sort.quality', group: 'Sort by', label: 'Quality', run: () => session.setSort('quality') },
      { id: 'sort.speed', group: 'Sort by', label: 'Speed', run: () => session.setSort('speed') },
      { id: 'sort.queue', group: 'Sort by', label: 'Queue length', run: () => session.setSort('queue') },
      { id: 'sort.size', group: 'Sort by', label: 'Size', run: () => session.setSort('size') },

      {
        id: 'filter.lossless', group: 'Filter', label: 'Lossless only',
        hint: session.filters.losslessOnly ? 'on' : undefined,
        run: () => session.setFilters({ ...session.filters, losslessOnly: !session.filters.losslessOnly }),
      },
      {
        id: 'filter.free', group: 'Filter', label: 'Free slots only',
        hint: session.filters.freeSlotsOnly ? 'on' : undefined,
        run: () => session.setFilters({ ...session.filters, freeSlotsOnly: !session.filters.freeSlotsOnly }),
      },
      {
        id: 'filter.clean', group: 'Filter', label: 'Hide suspected transcodes',
        hint: session.filters.excludeTranscodes ? 'on' : undefined,
        run: () => session.setFilters({ ...session.filters, excludeTranscodes: !session.filters.excludeTranscodes }),
      },
      { id: 'filter.reset', group: 'Filter', label: 'Reset all filters', run: () => session.resetFilters() },

      { id: 'view.comfortable', group: 'View', label: 'Comfortable rows', run: () => changeDensity('comfortable') },
      { id: 'view.compact', group: 'View', label: 'Compact rows', run: () => changeDensity('compact') },
      { id: 'view.table', group: 'View', label: 'Table rows', run: () => changeDensity('table') },
    ];

    if (session.client) {
      list.push({
        id: 'wish.add', group: 'Wishlist', label: 'Add this search to the wishlist',
        hint: session.query || undefined,
        run: () => {
          const q = session.query.trim();
          if (!q) return;
          void session.client?.request('wishlist.add', { query: q }).catch(() => {});
          go('wishlist');
        },
      });
      list.push({
        id: 'saved.add', group: 'Saved', label: 'Save this search with its filters',
        hint: session.query || undefined,
        run: () => {
          const q = session.query.trim();
          if (!q) return;
          void session.client?.request('saved.add', {
            query: q, filtersJson: serialiseFilters(session.filters),
          }).catch(() => {});
        },
      });
    }

    if (browse.current) {
      list.push({
        id: 'browse.open', group: 'Browse', label: `Open ${browse.current.username}'s share`,
        run: go2('browsing'),
      });
    }
    if (transfers.activeCount > 0) {
      const active = transfers.all.filter((t) => t.state !== 'finished').map((t) => t.id);
      list.push({
        id: 'transfer.pauseAll', group: 'Downloads', label: 'Pause every download',
        hint: `${transfers.activeCount} active`,
        run: () => transfers.pause(active),
      });
      list.push({
        id: 'transfer.resumeAll', group: 'Downloads', label: 'Resume every download',
        run: () => transfers.resume(active),
      });
    }

    return list;
  }, [go, session, transfers, browse, changeDensity, labels.labels.length]);

  /* The right-click menu. Built per row because the useful actions differ:
   * a release is a folder, a track cluster is a choice of peers, and a user
   * header is a person. Anything not applicable is omitted rather than shown
   * greyed — a menu of dead entries is harder to read, not more informative. */
  const openMenu = useCallback((row: Row, x: number, y: number) => {
    const items: MenuItem[] = [];
    /* `copyText`, not `navigator.clipboard` — the latter is undefined in the
     * shipped app, and `?.` made that a silent no-op for every Copy item here.
     * See data/clipboard.ts. Nothing in a context menu can report a result, so
     * the value of the fix is simply that these now write at all. */
    const copy = (text: string) => () => { void copyText(text); };

    if (row.kind === 'release') {
      const r = row.release;
      const who = r.peer.username;
      items.push(
        { id: 'get', label: `Download folder — ${r.trackCount} tracks`,
          run: () => void transfers.enqueueFolder(who, r.folderPath) },
        { id: 'browse', label: `Browse ${who}`, separated: true,
          run: () => { browse.browse(who); go('browsing'); } },
        { id: 'follow', label: `Follow ${who}`,
          run: () => void session.client?.request('buddies.add', { username: who }).catch(() => {}) },
        { id: 'msg', label: `Message ${who}`,
          run: () => { chat.openPrivate(who); go('messages'); } },
        { id: 'wish', label: 'Add to wishlist', separated: true,
          run: () => addWish(`${r.artist ?? ''} ${r.title}`.trim()) },
        { id: 'copyfolder', label: 'Copy folder path', separated: true, run: copy(r.folderPath) },
        { id: 'copyuser', label: 'Copy username', run: copy(who) },
      );
    } else if (row.kind === 'track' || row.kind === 'source') {
      const file = row.kind === 'track' ? row.track.best : row.source;
      const who = file.user;
      const label = row.kind === 'track'
        ? `Download best of ${row.track.sources.length} sources`
        : 'Download this file';
      items.push(
        { id: 'get', label, run: () => void transfers.enqueue(who, file.path, file.size) },
        { id: 'getfolder', label: 'Download the whole folder',
          run: () => void transfers.enqueueFolder(who, file.parsed.folderPath) },
        { id: 'browse', label: `Browse ${who}`, separated: true,
          run: () => { browse.browse(who); go('browsing'); } },
        { id: 'follow', label: `Follow ${who}`,
          run: () => void session.client?.request('buddies.add', { username: who }).catch(() => {}) },
        { id: 'msg', label: `Message ${who}`,
          run: () => { chat.openPrivate(who); go('messages'); } },
        { id: 'wish', label: 'Add to wishlist', separated: true,
          run: () => addWish(file.parsed.displayTitle) },
        { id: 'copypath', label: 'Copy file path', separated: true, run: copy(file.path) },
        { id: 'copyname', label: 'Copy file name', run: copy(file.parsed.filename) },
        { id: 'copyuser', label: 'Copy username', run: copy(who) },
      );
    } else {
      const who = row.group.user;
      items.push(
        { id: 'browse', label: `Browse everything ${who} shares`,
          run: () => { browse.browse(who); go('browsing'); } },
        { id: 'follow', label: `Follow ${who}`,
          run: () => void session.client?.request('buddies.add', { username: who }).catch(() => {}) },
        { id: 'msg', label: `Message ${who}`,
          run: () => { chat.openPrivate(who); go('messages'); } },
        { id: 'copyuser', label: 'Copy username', separated: true, run: copy(who) },
      );
    }

    setMenu({ x, y, items });
  }, [transfers, browse, chat, session.client, go, addWish]);

  return (
    <div className="app">
      <UpdateBanner
        state={updates}
        onInstall={updates.install}
        onDismiss={updates.dismiss}
      />
      <ContextMenu request={menu} onClose={() => setMenu(null)} />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <Sidebar
        active={section}
        onSelect={go}
        downloadCount={transfers.activeCount}
        browsingUser={browse.current?.username ?? null}
        status={connectionStatus(session)}
        throughput={throughput}
        roomUnread={roomUnread}
        privateUnread={privateUnread}
        wantPending={want.pendingCount}
        hasSessions={sessions.sessions.length > 0}
        hasLabels={labels.labels.length > 0}
        uploadCount={transfers.uploadCount}
      />
      <main className="pane" data-scrolled="false">
        {section === 'search' ? (
          <SearchView
            session={session}
            searchRef={searchRef}
            density={density}
            onDensity={changeDensity}
            columns={columns}
            onColumns={changeColumns}
            tabs={searchTabs}
            transfers={transfers}
            artwork={artwork}
            library={library}
            onBrowse={(who) => { browse.browse(who); go('browsing'); }}
            prefs={prefs.settings}
            peers={(username) => prefs.peers.get(username)}
            discover={discover.enabled ? discover : undefined}
            onOpenSettings={() => go('settings')}
            onWant={want.enabled ? addPreviewToWant : undefined}
            wanted={Boolean(discover.preview && wantedUrls.has(discover.preview.url))}
            onBrowseCatalog={catalog.enabled ? browseCatalog : undefined}
            onWantTracklist={want.enabled ? addTracklistToWant : undefined}
            onWantPlaylist={want.enabled ? addPlaylistToWant : undefined}
            onContext={openMenu}
            onWish={() => addWish(session.query)}
            onSave={() => {
              void session.client?.request('saved.add', {
                query: session.query.trim(),
                filtersJson: serialiseFilters(session.filters),
              }).catch(() => {});
            }}
          />
        ) : section === 'chat' || section === 'messages' ? (
          <ChatView
            chat={chat}
            signedIn={isSignedIn(session.serverState)}
            scope={section === 'chat' ? 'room' : 'private'}
          />
        ) : section === 'history' ? (
          <HistoryView
            client={session.client}
            onSearch={(q) => { setSection('search'); session.run(q); }}
          />
        ) : section === 'saved' ? (
          <SavedView
            client={session.client}
            onOpen={(q, f) => {
              // Filters first: running the search before applying them would
              // ingest a burst against the wrong filter set and then re-filter,
              // which is visible as a flash of results that should not be there.
              session.setFilters(f);
              setSection('search');
              session.run(q);
            }}
          />
        ) : section === 'followed' ? (
          <FollowedView
            client={session.client}
            signedIn={isSignedIn(session.serverState)}
            onBrowse={(who) => { browse.browse(who); go('browsing'); }}
          />
        ) : section === 'collections' ? (
          <LibraryView
            library={library}
            onSearch={(q) => { setSection('search'); session.run(q); }}
          />
        ) : section === 'want' ? (
          <WantListView
            want={want}
            onSearch={searchWant}
            searchingId={searchingWant?.id ?? null}
            wantlist={discover.wantlist}
            onFetchWantlist={discover.fetchWantlist}
            onClearWantlist={discover.clearWantlist}
            onOpenSettings={() => go('settings')}
          />
        ) : section === 'catalog' && catalog.catalog ? (
          <LabelBrowserView
            catalog={catalog.catalog}
            library={library}
            artwork={artwork}
            wantedUrls={wantedUrls}
            onSearch={(entry) => {
              const q = `${entry.artist} ${entry.title}`.replace(/\s+/g, ' ').trim();
              session.setQuery(q);
              setSection('search');
              session.run(q);
            }}
            onWant={(entry) => {
              void want.add([{
                artist: entry.artist,
                title: entry.title,
                album: entry.title,
                year: entry.year,
                label: catalog.catalog?.kind === 'label' ? catalog.catalog.name : null,
                catalogNumber: entry.catno || null,
                sourceKind: catalog.catalog?.sourceKind ?? 'manual',
                sourceUrl: entry.url,
                tracklist: [],
              }]);
            }}
            onClose={() => { catalog.clear(); go('search'); }}
            watched={Boolean(watchedLabel)}
            onToggleWatch={watchRequest ? () => (
              watchedLabel ? labels.unwatch(watchedLabel.id) : labels.watch(watchRequest)
            ) : undefined}
            onSeen={watchedLabel ? (counts) => labels.seen(watchedLabel.id, counts) : undefined}
          />
        ) : section === 'labels' ? (
          <LabelsView labels={labels} onOpen={openWatchedLabel} />
        ) : section === 'stats' ? (
          <TransferStatsView stats={transferStats} prefs={prefs} />
        ) : section === 'uploads' ? (
          <UploadsView
            session={transfers}
            peers={(u) => prefs.peers.get(u)}
            // null when the engine has not reported yet — NOT false. See the
            // prop's own note: the two are different claims.
            sharing={engine.shares ? engine.shares.folders.length > 0 : null}
          />
        ) : section === 'sessions' ? (
          <DigSessionsView
            sessions={sessions}
            want={want}
            onSearch={searchWant}
            searchingId={searchingWant?.id ?? null}
          />
        ) : section === 'wishlist' ? (
          <WishlistView
            client={session.client}
            signedIn={isSignedIn(session.serverState)}
            onSearch={(q) => { setSection('search'); session.run(q); }}
          />
        ) : section === 'browsing' ? (
          <BrowseView
            browse={browse}
            transfers={transfers}
            signedIn={isSignedIn(session.serverState)}
          />
        ) : section === 'downloads' || section === 'completed' || section === 'failed' ? (
          <DownloadsView
            session={transfers}
            signedIn={isSignedIn(session.serverState)}
            filter={section === 'downloads' ? 'active'
              : section === 'completed' ? 'finished' : 'failed'}
            analysis={analysis}
            client={session.client}
            preview={preview}
            density={dlDensity}
            onDensity={changeDlDensity}
            discovery={related.enabled ? {
              related,
              artwork,
              library,
              wantedUrls,
              onSearch: searchCatalogEntry,
              onWant: wantCatalogEntry,
            } : undefined}
          />
        ) : (
          <SectionView
            section={section}
            client={session.client}
            serverState={session.serverState}
            prefs={prefs}
            engine={engine}
            profile={profile}
            connections={connections}
          />
        )}
      </main>
    </div>
  );
}
