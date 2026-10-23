/*
 * Seek — app shell and global keyboard navigation.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SIDEBAR_KEY, Sidebar } from './ui/Sidebar.tsx';
import { UpdateBanner } from './ui/UpdateBanner.tsx';
import type { ConnectionStatus, Section } from './ui/Sidebar.tsx';
import type { SearchSession } from './data/searchStore.ts';
import type { SidecarClient } from './data/sidecarClient.ts';
import { SearchView } from './ui/SearchView.tsx';
import { SettingsView } from './ui/SettingsView.tsx';
import { CornerPanel } from './ui/CornerPanel.tsx';
import { MiniSeek } from './ui/MiniSeek.tsx';
import { keepOnTop, restore, shrink } from './data/miniWindow.ts';
import type { Density } from './ui/ViewMenu.tsx';
import { LAYOUT_KEY, MODE_KEY, densityKey, initialMode, loadLayout, loadViews } from './ui/viewMode.ts';
import type { DensityScreen, DownloadsLayout, Mode, Views } from './ui/viewMode.ts';
import { normaliseColumns } from './domain/searchColumns.ts';
import type { ColumnId } from './domain/searchColumns.ts';
import { isSignedIn, useSearchSession } from './data/searchStore.ts';
import { useSidecarConnection } from './data/connectionStore.ts';
import { WISHLIST_REASON, useSearchTabs } from './data/searchTabs.ts';
import { useChatSession } from './data/chatStore.ts';
import { useTransfers } from './data/transferStore.ts';
import { useUpdates } from './data/updateStore.ts';
import { useAnalysis } from './data/analysisStore.ts';
import { useAutoChecksums, useChecksums } from './data/checksumStore.ts';
import { useHandoff } from './data/handoffStore.ts';
import { useBrowse } from './data/browseStore.ts';
import { useArtwork } from './data/artworkStore.ts';
import { useLibrary } from './data/libraryStore.ts';
import { useYoutube } from './data/youtubeStore.ts';
import { usePrefs } from './data/prefsStore.ts';
import { useEngine } from './data/engineStore.ts';
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
import { ErrorBoundary } from './ui/ErrorBoundary.tsx';
import { Failures } from './ui/Failures.tsx';
import { reportFailure, showNotice } from './data/failures.ts';
import { judge, judgeRelease } from './domain/preferences.ts';
import { useWishHits } from './data/wishHits.ts';
import { useAutoDownloads } from './data/autoDownloads.ts';
import { useAutoGreet } from './data/autoGreet.ts';
import { FollowedView, HistoryView, SavedView } from './ui/DiscoveryViews.tsx';
import { serialiseFilters } from './domain/types.ts';
import { DownloadsView } from './ui/DownloadsView.tsx';
import { ChatView } from './ui/ChatView.tsx';
import { CommandPalette } from './ui/CommandPalette.tsx';
import { ContextMenu } from './ui/ContextMenu.tsx';
import { usePreview } from './ui/Preview.tsx';
import { useChatNotifications, useDownloadNotifications, useWishNotifications } from './data/notify.ts';
import type { MenuRequest } from './ui/ContextMenu.tsx';
import type { Command } from './ui/CommandPalette.tsx';
import type { MenuItem } from './ui/ContextMenu.tsx';
import type { Row } from './data/searchStore.ts';
import './styles/components.css';
import { copyText } from './data/clipboard.ts';
import { usePeople } from './data/peopleStore.ts';
import { useAutoAway } from './data/presence.ts';
import { userMenuItems } from './ui/userMenu.ts';
import { ConfirmSheet } from './ui/ConfirmSheet.tsx';
import { canChooseFolder, chooseFolder } from './data/choose.ts';
import { soulseekUrl } from './domain/soulseekUrl.ts';
import type { UserMenuActions } from './ui/userMenu.ts';

/** ⌘1–4, per docs/PRODUCT.md §2. */
const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

const NUMBER_KEYS: Record<string, Section> = {
  '1': 'search',
  '2': 'downloads',
  '3': 'completed',
  '4': 'settings',
  '5': 'chat',
  '6': 'messages',
  '7': 'browsing',
  '8': 'want',
  '9': 'sessions',
};

/* The table's columns. Local, like density, and for the same reason: it is a
   view preference about this machine's window, not an account setting the
   sidecar has any use for. */
const COLUMNS_KEY = 'seek.columns';
/* Whether Mini Seek stays above other apps. A preference about this window. */
const MINI_ON_TOP_KEY = 'seek.miniOnTop';

function storedColumns(): ColumnId[] {
  try {
    return normaliseColumns(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? 'null'));
  } catch {
    // Unreadable, unparseable, or a shape from a future version: the defaults
    // are always renderable, which is the only thing this must guarantee.
    return normaliseColumns(null);
  }
}

/** A stored view choice, or null when there is none or storage is off. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Remember a view choice. Storage can be full or switched off; then the
 * choice simply isn't remembered, which is not worth a word. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* not remembered */ }
}

/**
 * Four distinct states, because collapsing them would lie. A live socket to the
 * sidecar does not mean we are signed in to Soulseek, and saying "Connected"
 * when a search would return `not_connected` is exactly the confidently-wrong
 * behaviour this app exists to avoid.
 */
function connectionStatus(session: SearchSession): ConnectionStatus {
  /* The shell could not start the engine, or gave up restarting it. First,
     because in that state there may be no client at all, and "mock data" or
     "unreachable" would hide the reason the shell already knows. */
  if (session.startupError) {
    return { dot: 'offline', label: 'Engine stopped', detail: session.startupError };
  }
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
  if (session.serverState === 'away') {
    return { dot: 'online', label: 'Away', detail: 'Signed in, and shown to others as away.' };
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

/** Sidebar entries that are one screen with a different lens. */
function screenOf(section: string): string {
  if (section === 'messages') return 'chat';
  if (section === 'completed' || section === 'failed') return 'downloads';
  return section;
}

export default function App() {
  const [section, setSection] = useState<Section>('search');
  /* Simple or Collector, and each screen's density in it (ui/viewMode.ts). */
  const [mode, setMode] = useState<Mode>(() => initialMode(stored, [SIDEBAR_KEY, COLUMNS_KEY]));
  const [views, setViews] = useState<Views>(() => loadViews(mode, stored));
  const [downloadsLayout, setDownloadsLayout] = useState<DownloadsLayout>(() => loadLayout(stored));
  const changeLayout = useCallback((next: DownloadsLayout) => {
    setDownloadsLayout(next);
    remember(LAYOUT_KEY, next);
  }, []);
  const [columns, setColumns] = useState<ColumnId[]>(storedColumns);
  const changeColumns = useCallback((next: ColumnId[]) => {
    setColumns(next);
    remember(COLUMNS_KEY, JSON.stringify(next));
  }, []);

  const searchRef = useRef<HTMLInputElement>(null);
  /* Entering Search readies the field — focus and select, so you can just type
   * and the last query is replaced. Same as the ⌘F handler, but on section
   * entry however it was reached (sidebar, ⌘1, palette, a search-from-elsewhere).
   * Idempotent, so StrictMode's double mount is harmless; on first load it
   * selects the seeded fixture query, which is the same "ready to type" state. */
  useEffect(() => {
    if (section !== 'search') return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [section]);
  /* Prefs first: the search session scores sources using real transfer
   * history, so the lookup has to exist before the session that reads it. */
  const [prefsClient, setPrefsClient] = useState<SidecarClient | null>(null);
  const prefs = usePrefs(prefsClient);
  /* One connection, shared. The search session is per-tab and takes it. */
  const conn = useSidecarConnection();
  /* Simple groups by version whatever the tab's own grouping says, which stays
     put for Collector (data/searchStore.ts). */
  const session = useSearchSession(conn, { reliability: prefs.reliability, versions: mode === 'simple' });
  /* Several searches open at once. One runs at a time — the transport allows no
   * more — so a tab is a search put away with everything needed to bring it
   * back. See data/searchTabs.ts. */
  const searchTabs = useSearchTabs(session);
  // The client is created inside the session, so hand it back to prefs once.
  useEffect(() => { setPrefsClient(session.client); }, [session.client]);
  const chat = useChatSession(session.client, isSignedIn(session.serverState));
  const people = usePeople(session.client);
  /* pynicotine's own configuration — folders, port, limits, shares. Distinct
   * from `prefs`, which is Seek's; see the header on `data/engineStore.ts`. */
  const engine = useEngine(session.client);
  useAutoAway(session.client, session.serverState, engine.settings?.autoAwayMinutes ?? 0);
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
  /* Filled in once the auto-download claims are known (below): a file held
     for review must never be cleared by the retention sweep. */
  const awaitingReview = useRef<ReadonlySet<string>>(new Set());
  const transfers = useTransfers(
    session.client,
    prefs.settings.stalledFailMinutes * 60,
    prefs.settings.clearCompletedDays,
    awaitingReview,
  );
  const updates = useUpdates(prefs.loaded ? prefs.settings.checkUpdates : null);
  const analysis = useAnalysis(session.client);
  const checksums = useChecksums(session.client);
  const handoff = useHandoff(session.client, engine.settings?.rekordboxFolder ?? null);
  useAutoChecksums(transfers.groups, checksums);
  const artwork = useArtwork(session.client);
  const library = useLibrary(session.client);
  const youtube = useYoutube(session.client);
  const browse = useBrowse(session.client, library.ownedReleases);
  const preview = usePreview(session.client);
  const discover = useDiscover(session.client);
  const want = useWant(session.client);
  const sessions = useSessions(session.client, want.entries);
  const catalog = useCatalog(session.client);
  const labels = useLabels(session.client);
  /* What the wishlist has turned up while you were doing something else. It
     never interrupts — the count waits on the Wishlist screen and in the nav. */
  const wishHits = useWishHits(session.client);
  /* Auto-download: for wishes the user has opted in, grab the best qualifying
     result as it arrives and hold it for review. Mounted here, not in the
     Wishlist screen, so it runs whenever Seek is open. Its claims feed the
     review UI in a later step; here it is mounted for its effect. */
  const autoDownloads = useAutoDownloads(
    session.client, wishHits, transfers, analysis, prefs.settings, isSignedIn(session.serverState),
  );
  awaitingReview.current = new Set(
    autoDownloads.claims.filter((c) => c.status === 'awaiting-review' && c.transferId)
      .map((c) => c.transferId as string),
  );
  /* Greet somebody the first time they finish downloading from you. Mounted
     here for the same reason as auto-download: an upload completes whether or
     not the Uploads screen is open. Off unless switched on in Settings. */
  useAutoGreet(
    session.client,
    transfers.uploadGroups,
    prefs.settings.uploadGreetingEnabled,
    prefs.settings.uploadGreeting,
    isSignedIn(session.serverState),
  );
  const related = useRelated(session.client);
  /* The want entry whose search is in flight. One at a time on purpose:
     Soulseek throttles a client that searches faster than the server allows,
     and CLAUDE.md records that as the thing which gets an account limited. */
  const [searchingWant, setSearchingWant] = useState<WantEntry | null>(null);
  useDownloadNotifications(transfers.groups);
  useChatNotifications(chat.conversations, chat.active);
  useWishNotifications(wishHits.byQuery);
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
  /* Settings opens on Account, except when something sends you to a folder. */
  const [settingsTab, setSettingsTab] = useState<'folders' | undefined>();
  useEffect(() => { if (section !== 'settings') setSettingsTab(undefined); }, [section]);
  const openFolders = useCallback(() => { setSettingsTab('folders'); go('settings'); }, [go]);

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
    setSection('search');
    searchTabs.openWith(query);
  }, [want, searchTabs]);

  useEffect(() => {
    // The search the user launched from the want list has stopped listening.
    if (!searchingWant || session.running) return;
    if (!session.closedReason) return;
    // A wish's stored results replaced the search: no verdict from those.
    // Put the entry back to waiting, or it reads "Searching" for good.
    if (session.closedReason === WISHLIST_REASON) {
      want.update(searchingWant.id, { status: 'pending' });
      setSearchingWant(null);
      return;
    }
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
    setSection('search');
    searchTabs.openWith(q);
  }, [searchTabs]);

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

  /* For the Downloads rows, memoised so a progress tick does not hand all of
   * them a new object. The two actions go through a ref: they close over
   * objects that change every render, and only their behaviour matters. */
  const catalogActions = useRef({ searchCatalogEntry, wantCatalogEntry });
  catalogActions.current = { searchCatalogEntry, wantCatalogEntry };
  const downloadsDiscovery = useMemo(() => (related.enabled ? {
    related,
    artwork,
    library,
    wantedUrls,
    onSearch: (e: { artist: string; title: string }) => catalogActions.current.searchCatalogEntry(e),
    onWant: (e: Parameters<typeof wantCatalogEntry>[0]) => catalogActions.current.wantCatalogEntry(e),
  } : undefined), [related, artwork, library, wantedUrls]);

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
    void session.client.request('wishlist.add', { query: q })
      .catch((e) => reportFailure('Add to wishlist', e));
    go('wishlist');
  }, [session.client, go]);

  const saveSearch = useCallback(() => {
    const q = session.query.trim();
    if (!q) return;
    void session.client?.request('saved.add', { query: q, filtersJson: serialiseFilters(session.filters) })
      .catch((e) => reportFailure('Save this search', e));
  }, [session.client, session.query, session.filters]);

  /* A screen's density is remembered for the mode it was chosen in. */
  const onDensity = useMemo(() => {
    const one = (screen: DensityScreen) => (d: Density) => {
      setViews((v) => ({ ...v, [screen]: d }));
      remember(densityKey(screen, mode), d);
    };
    return { search: one('search'), downloads: one('downloads'), library: one('library') };
  }, [mode]);

  const switchMode = useCallback((next: Mode) => {
    setMode(next);
    setViews(loadViews(next, stored));
  }, []);
  /* Written at once, so a first launch's Simple sticks: the next launch would
     otherwise find the sidebar's key and take this for an older install. */
  useEffect(() => remember(MODE_KEY, mode), [mode]);

  /* What the corner panel counts as already seen: anything that finished
     before this launch, or before you last left Downloads or Completed. */
  const [seenUntil, setSeenUntil] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (screenOf(section) !== 'downloads') return;
    setSeenUntil(Date.now() / 1000);
    return () => setSeenUntil(Date.now() / 1000);
  }, [section]);

  /* Mini Seek: the same window made small (data/miniWindow.ts). A reload
     while small would leave the window small with nothing drawn for it, so a
     fresh start puts the full window's rules back first. */
  const [mini, setMini] = useState(false);
  const [onTop, setOnTop] = useState(() => stored(MINI_ON_TOP_KEY) !== 'false');
  useEffect(() => { void restore().catch(() => {}); }, []);
  const enterMini = useCallback(() => {
    setMini(true);
    void shrink(onTop).catch((e) => reportFailure('Shrink to Mini Seek', e));
  }, [onTop]);
  const leaveMini = useCallback((to?: Section) => {
    setMini(false);
    if (to) go(to);
    void restore().catch((e) => reportFailure('Go back to the full window', e));
  }, [go]);
  const changeOnTop = useCallback((on: boolean) => {
    setOnTop(on);
    remember(MINI_ON_TOP_KEY, String(on));
    void keepOnTop(on).catch((e) => reportFailure('Keep Mini Seek on top', e));
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

      /* ⌘ only, on a Mac. Ctrl-F, Ctrl-K and Ctrl-T are the system's own text
       * editing keys there (forward a character, delete to the end of the line,
       * swap two letters), and taking them broke every text field. */
      const meta = MAC ? e.metaKey : e.ctrlKey;
      if (!meta) return;

      /* ⇧⌘M into Mini Seek and out. Inside it there are no screens or tabs for
       * the rest to act on; ⌘W goes back to the full window, never quits. */
      if (e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        // Held down, the key repeats: in, out, in, as fast as it auto-repeats.
        if (e.repeat) return;
        if (mini) leaveMini(); else enterMini();
        return;
      }
      if (mini) {
        if (e.key === 'w') { e.preventDefault(); leaveMini(); }
        return;
      }

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
      /* ⌘W closes the TAB, and only falls through to closing the window when
       * there is no tab left to close — which is exactly how Safari behaves,
       * and the behaviour the muscle memory expects.
       *
       * preventDefault ONLY in the first case. Calling it unconditionally would
       * leave the window with no keyboard close at all, and macOS users would
       * find ⌘W simply dead once they were down to one search. */
      if (e.key === 'w') {
        e.preventDefault();
        if (searchTabs.tabs.length > 1) {
          searchTabs.close(searchTabs.activeId);
        } else {
          /* The last tab: close the WINDOW, the way Safari does.
           *
           * Explicitly, because the native Window → Close item was removed in
           * lib.rs so that ⌘W could reach this handler at all. Nothing else
           * would close the window now, and a shortcut that does nothing on the
           * last tab is exactly the dead key that removal would have created.
           *
           * Dynamic import: this same frontend runs in a plain browser under
           * the dev recipe in CLAUDE.md, where there is no Tauri shell and the
           * import would throw. Failing to close a window that cannot be closed
           * is the correct outcome there, so the rejection is swallowed. */
          void import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) => getCurrentWindow().close())
            .catch(() => {});
        }
        return;
      }
      if (e.key === 'Enter') {
        // ⌘↵ in the search field was already handled there; running it again
        // here sent two searches in one keystroke.
        if (e.defaultPrevented) return;
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
      /* ⌘\, as the sidebar says: Simple to Collector and back. */
      if (e.key === '\\') {
        e.preventDefault();
        switchMode(mode === 'simple' ? 'collector' : 'simple');
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
  }, [go, session, preview, mode, switchMode, mini, enterMini, leaveMini]);

  // Start the recorded session so the app is never a dead screen.
  //
  // Deliberately NOT ref-guarded: StrictMode mounts, unmounts and remounts, and
  // the unmount tears the sidecar down. A "run once" guard would skip the restart
  // and leave a permanently empty list in development. `run()` resets cleanly, so
  // being invoked twice is harmless.
  useEffect(() => {
    // Only against recorded data. Firing a real Soulseek search for someone
    // else's demo query the instant the app opens would be presumptuous, and
    // it burns a search slot the user did not ask for.
    if (!session.isMock) return;
    /* Through `openWith`, like every other search, and for a reason beyond
     * tidiness: it runs in the fresh tab rather than opening one, AND it
     * records that this tab has now searched. Calling `run` directly left the
     * first tab looking untouched, so the user's NEXT search reused it instead
     * of opening a tab — the fixture quietly behaving unlike the real app. */
    searchTabs.openWith('burial');
  }, []); // Mount only: the first render's session and tabs are the ones to use.

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
      { id: 'go.library', group: 'Go', label: 'Collections', run: go2('collections') },
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
        ? [{ id: 'go.labels', group: 'Go', label: 'Labels & Artists', run: go2('labels') }]
        : []),
      { id: 'go.followed', group: 'Go', label: 'Followed', run: go2('followed') },
      { id: 'go.browse', group: 'Go', label: 'Browse a user', shortcut: '⌘7', run: go2('browsing') },
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
      { id: 'group.version', group: 'Group by', label: 'Version', run: () => session.setGroupBy('version') },
      // "Files" is the classic flat list; like the pane's own control it forces
      // table density, the only one it reads right in.
      { id: 'group.file', group: 'Group by', label: 'Files (classic list)',
        run: () => { session.setGroupBy('file'); onDensity.search('table'); } },
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

      { id: 'view.comfortable', group: 'View', label: 'Comfortable rows', run: () => onDensity.search('comfortable') },
      { id: 'view.compact', group: 'View', label: 'Compact rows', run: () => onDensity.search('compact') },
      { id: 'view.table', group: 'View', label: 'Table rows', run: () => onDensity.search('table') },
      {
        id: 'view.mode', group: 'View', shortcut: '⌘\\',
        label: mode === 'simple' ? 'Switch to Collector' : 'Switch to Simple',
        run: () => switchMode(mode === 'simple' ? 'collector' : 'simple'),
      },
      { id: 'view.mini', group: 'View', label: 'Mini Seek', shortcut: '⇧⌘M', hint: 'a small window that can stay on top', run: enterMini },
    ];

    if (session.client) {
      list.push({
        id: 'wish.add', group: 'Wishlist', label: 'Add this search to the wishlist',
        hint: session.query || undefined,
        run: () => addWish(session.query),
      });
      list.push({
        id: 'saved.add', group: 'Saved', label: 'Save this search with its filters',
        hint: session.query || undefined,
        run: saveSearch,
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
  }, [go, session, transfers, browse, onDensity, mode, switchMode, labels.labels.length, addWish, saveSearch, enterMini]);

  const userActions = useMemo<UserMenuActions>(() => ({
    browse: (who) => { browse.browse(who); go('browsing'); },
    message: (who) => { chat.openPrivate(who); go('messages'); },
    searchFiles: (who) => {
      // Pick the scope and put the cursor in the field; the words are theirs.
      go('search');
      session.setScope({ mode: 'user', user: who });
      window.setTimeout(() => searchRef.current?.focus(), 0);
    },
    copy: (text) => { void copyText(text); },
  }), [browse, chat, go, session]);

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
      // The same rules as the card's Get; this path skipped them.
      const getFolder = (destination: string | null) => {
        const verdict = judgeRelease(r.files, prefs.settings);
        if (!verdict.allowed) { showNotice(verdict.reason ?? ''); return; }
        void transfers.enqueueFolder(who, r.folderPath, false, { destination, count: r.files.length });
      };
      items.push(
        { id: 'get', label: `Download folder — ${r.trackCount} tracks`, run: () => getFolder(null) },
        ...(canChooseFolder() ? [{
          id: 'getto', label: 'Download folder to…',
          run: () => { void chooseFolder('Download to').then((dest) => { if (dest) getFolder(dest); }); },
        }] : []),
        { id: 'wish', label: 'Add to wishlist',
          run: () => addWish(`${r.artist ?? ''} ${r.title}`.trim()) },
        { id: 'copyfolder', label: 'Copy folder path', separated: true, run: copy(r.folderPath) },
        { id: 'copylink', label: 'Copy Soulseek link', run: copy(soulseekUrl(who, r.folderPath, true)) },
        ...userMenuItems(who, people, userActions, { separated: true }),
      );
    } else if (row.kind === 'track' || row.kind === 'source' || row.kind === 'file') {
      // A 'file' row (the classic flat list) carries its source just like a
      // 'source' row, so the whole file menu applies unchanged.
      const file = row.kind === 'track' ? row.track.best : row.source;
      const who = file.user;
      const label = row.kind === 'track'
        ? `Download best of ${row.track.sources.length} sources`
        : 'Download this file';
      const getFile = (destination: string | null) => {
        const verdict = judge(file, prefs.settings);
        if (!verdict.allowed) { showNotice(verdict.reason ?? ''); return; }
        void transfers.enqueue(who, file.path, file.size, destination);
      };
      const getFolder = () => {
        // The folder's files as far as these results show them, judged by
        // the same rules as a release Get.
        const inFolder = session.snapshot().files.filter((s) => (
          s.user === who && s.parsed.folderPath === file.parsed.folderPath
        ));
        const verdict = judgeRelease(inFolder.length > 0 ? inFolder : [file], prefs.settings);
        if (!verdict.allowed) { showNotice(verdict.reason ?? ''); return; }
        void transfers.enqueueFolder(who, file.parsed.folderPath, false, { count: inFolder.length });
      };
      items.push(
        { id: 'get', label, run: () => getFile(null) },
        ...(canChooseFolder() ? [{
          id: 'getto', label: 'Download to…',
          run: () => { void chooseFolder('Download to').then((dest) => { if (dest) getFile(dest); }); },
        }] : []),
        { id: 'getfolder', label: 'Download the whole folder', run: getFolder },
        { id: 'wish', label: 'Add to wishlist', separated: true,
          run: () => addWish(file.parsed.displayTitle) },
        { id: 'copypath', label: 'Copy file path', separated: true, run: copy(file.path) },
        { id: 'copyname', label: 'Copy file name', run: copy(file.parsed.filename) },
        { id: 'copylink', label: 'Copy Soulseek link', run: copy(soulseekUrl(who, file.path)) },
        ...userMenuItems(who, people, userActions, { separated: true }),
      );
    } else {
      items.push(...userMenuItems(row.group.user, people, userActions));
    }

    setMenu({ x, y, items });
  }, [transfers, session, addWish, prefs.settings, people, userActions]);

  /* A person's own menu, for places that show a name and nothing else: a chat
   * line, a room's member list. */
  const openUserMenu = useCallback((who: string, x: number, y: number) => {
    setMenu({ x, y, title: who, items: userMenuItems(who, people, userActions) });
  }, [people, userActions]);

  return (
    <div className="app" data-mini={mini ? 'true' : undefined}>
      {/* Over the full window, which stays mounted beneath it so nothing you
          left open is lost on the way back. */}
      {mini && (
        <MiniSeek
          session={transfers}
          artwork={artwork}
          awaiting={autoDownloads.claims.filter((c) => c.status === 'awaiting-review')}
          onTop={onTop}
          onKeepOnTop={changeOnTop}
          onSearch={(q) => { leaveMini('search'); searchTabs.openWith(q); }}
          onFindAnother={(q) => { leaveMini('search'); searchTabs.openWith(q); }}
          onReview={() => leaveMini('completed')}
          onOpen={() => leaveMini('downloads')}
          onBack={() => leaveMini()}
        />
      )}
      <UpdateBanner
        state={updates}
        onInstall={updates.install}
        onDismiss={updates.dismiss}
      />
      <ContextMenu request={menu} onClose={() => setMenu(null)} />
      {transfers.pendingFolder && (
        <ConfirmSheet
          title={`Download ${transfers.pendingFolder.count.toLocaleString()} files?`}
          body={`From ${transfers.pendingFolder.username}: ${
            transfers.pendingFolder.folderPath.split('\\').pop() || transfers.pendingFolder.folderPath
          }${transfers.pendingFolder.recurse ? ', with its subfolders' : ''}. They will all wait in that person's queue.`}
          action="Download all"
          onConfirm={transfers.confirmFolder}
          onCancel={transfers.dismissFolder}
        />
      )}
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
        client={session.client}
        roomUnread={roomUnread}
        privateUnread={privateUnread}
        wantPending={want.pendingCount}
        wishFound={wishHits.unseenCount}
        hasSessions={sessions.sessions.length > 0}
        hasLabels={labels.labels.length > 0}
        uploadCount={transfers.uploadCount}
        mode={mode}
        onMode={switchMode}
      />
      <main className="pane" data-scrolled="false">
        {/* Keyed by SCREEN, not by sidebar entry: going somewhere else is a
            fresh start, so one broken screen never follows you round the app —
            but Rooms and Private chats are one screen, and so are Downloads,
            Completed and Failed. Keying those apart remounted them on every
            switch and threw away their drafts, filters and selection. */}
        <ErrorBoundary key={screenOf(section)} label={`the ${section} screen`}>
        {section === 'search' ? (
          <SearchView
            session={session}
            searchRef={searchRef}
            density={views.search}
            onDensity={onDensity.search}
            simple={mode === 'simple'}
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
            rooms={chat.conversations.filter((c) => c.scope === 'room').map((c) => c.target)}
            onWish={() => addWish(session.query)}
            onSave={saveSearch}
          />
        ) : section === 'chat' || section === 'messages' ? (
          <ChatView
            chat={chat}
            signedIn={isSignedIn(session.serverState)}
            scope={section === 'chat' ? 'room' : 'private'}
            onUserMenu={openUserMenu}
            self={profile.profile?.username ?? null}
            buddies={people.buddies}
          />
        ) : section === 'history' ? (
          <HistoryView
            client={session.client}
            onSearch={(q) => { setSection('search'); searchTabs.openWith(q); }}
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
              searchTabs.openWith(q);
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
            artwork={artwork}
            density={views.library}
            onDensity={onDensity.library}
            onSearch={(q) => { setSection('search'); searchTabs.openWith(q); }}
            youtube={youtube}
            onBrowseArtist={(artist) => {
              catalog.browse({ sourceKind: 'discogs', kind: 'artist', name: artist, url: null });
              go('catalog');
            }}
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
            onSearch={searchCatalogEntry}
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
            onUserMenu={openUserMenu}
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
            onSearch={(q) => { setSection('search'); searchTabs.openWith(q); }}
            onOpenHits={(q) => {
              const found = wishHits.byQuery[q]?.sources ?? [];
              setSection('search');
              if (found.length > 0) searchTabs.showResults(q, found);
              else searchTabs.openWith(q);
            }}
            hits={wishHits}
            currentFilters={session.filters}
          />
        ) : section === 'browsing' ? (
          <BrowseView
            browse={browse}
            transfers={transfers}
            signedIn={isSignedIn(session.serverState)}
            peers={(u) => prefs.peers.get(u)}
            rules={prefs.settings}
            onUserMenu={openUserMenu}
          />
        ) : section === 'downloads' || section === 'completed' || section === 'failed' ? (
          <DownloadsView
            session={transfers}
            signedIn={isSignedIn(session.serverState)}
            filter={section === 'downloads' ? 'active'
              : section === 'completed' ? 'finished' : 'failed'}
            analysis={analysis}
            checksums={checksums}
            client={session.client}
            preview={preview}
            density={views.downloads}
            onDensity={onDensity.downloads}
            autoClaims={autoDownloads.claims}
            onApproveAuto={autoDownloads.approve}
            onRejectAuto={autoDownloads.reject}
            discovery={downloadsDiscovery}
            simple={mode === 'simple'}
            onFindAnother={(q) => { go('search'); searchTabs.openWith(q); }}
            peers={(u) => prefs.peers.get(u)}
            onBrowse={(who) => { browse.browse(who); go('browsing'); }}
            onShowCompleted={() => go('completed')}
            onMini={enterMini}
            handoff={handoff}
            onSetRekordboxFolder={openFolders}
            layout={downloadsLayout}
            onLayout={changeLayout}
            downloadFolder={engine.settings?.downloadFolder ?? null}
          />
        ) : section === 'settings' ? (
          <SettingsView
            initialTab={settingsTab}
            client={session.client}
            serverState={session.serverState}
            prefs={prefs}
            engine={engine}
            profile={profile}
            connections={connections}
            youtube={youtube}
            people={people}
          />
        ) : null}
        </ErrorBoundary>
        {/* Not on the Downloads screens: the list it summarises is right there. */}
        {screenOf(section) !== 'downloads' && (
          <CornerPanel
            key={mode}
            groups={transfers.groups}
            since={seenUntil}
            mode={mode}
            onShowAll={() => go('downloads')}
            onShowCompleted={() => go('completed')}
          />
        )}
      </main>
      <Failures />
    </div>
  );
}
