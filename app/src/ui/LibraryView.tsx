/*
 * Seek — the collection.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * What you already own, built by walking the download folder. Its real job is
 * not this screen — it is the "you have this" marker on search results, which
 * is what stops you downloading the same record twice at 2am.
 *
 * Scanning is honest about its cost: reading tags is far more accurate and far
 * slower, so it is a choice rather than a default decided on the user's behalf.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LibrarySession } from '../data/libraryStore.ts';
import { fileSize } from '../domain/format.ts';
import { canChooseFolder, chooseFolder } from '../data/choose.ts';
import { IconLibrary, IconSearch } from '../icons/index.tsx';
import type { LibraryRelease } from '../data/libraryStore.ts';
import { StatsView } from './StatsView.tsx';
import { SegmentedControl } from './controls.tsx';
import type { Segment } from './controls.tsx';

const TABS: Segment<'releases' | 'stats'>[] = [
  { value: 'releases', label: 'Releases' },
  { value: 'stats', label: 'Statistics' },
];

function when(seconds: number): string {
  if (!seconds) return 'never';
  const delta = Date.now() / 1000 - seconds;
  if (delta < 90) return 'just now';
  if (delta < 3600) return `${Math.round(delta / 60)} minutes ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)} hours ago`;
  return `${Math.round(delta / 86400)} days ago`;
}

/**
 * One owned release, and the gap report it can open.
 *
 * Gaps are per-release rather than a whole-collection sweep: each one costs a
 * rate-limited MusicBrainz request, so scanning 2,400 releases would take the
 * better part of an hour and most of it on records nobody asked about.
 */
function ReleaseRow({
  r, library, onSearch,
}: {
  r: LibraryRelease;
  library: LibrarySession;
  onSearch(query: string): void;
}) {
  const gap = library.gaps.get(r.key);
  const missing = gap && gap !== 'looking' ? gap.tracks.filter((t) => !t.have) : [];

  return (
    <>
      <li className="wish__row">
        <span className="wish__q">
          {r.artist && <span className="shelf__artist">{r.artist} — </span>}
          {r.release}
        </span>
        <span className="browse__stat tnum">{r.trackCount} tracks</span>
        <span className="browse__stat tnum">{fileSize(r.bytes)}</span>
        {gap === 'looking' ? (
          <span className="verify verify--busy">Checking…</span>
        ) : gap && !gap.matched ? (
          <span className="verify verify--failed" title="MusicBrainz has no confident match for this release.">
            No match
          </span>
        ) : gap ? (
          <span
            className="verify verify--done"
            data-tone={missing.length === 0 ? 'good' : 'warn'}
          >
            {missing.length === 0
              ? 'Complete'
              : `${missing.length} missing`}
          </span>
        ) : (
          <button
            type="button"
            className="verify pressable"
            title="Ask MusicBrainz what this release should contain"
            onPointerDown={() => library.findGaps(r.key, r.artist, r.release)}
          >
            Check
          </button>
        )}
        <button
          type="button"
          className="verify pressable"
          title="Look for this release on Soulseek"
          onPointerDown={() => onSearch(`${r.artist} ${r.release}`.trim())}
        >
          <IconSearch size={12} painted={1.5} /> Find
        </button>
      </li>

      {missing.length > 0 && (
        <li className="lib__gaps">
          <p className="settings__hint">
            MusicBrainz lists {gap !== 'looking' && gap ? gap.tracks.length : 0} tracks.
            These are not on disk:
          </p>
          <ul className="lib__missing">
            {missing.map((t) => (
              <li key={`${t.position}-${t.title}`}>
                <span className="tnum lib__pos">{String(t.position).padStart(2, '0')}</span>
                <span className="lib__title">{t.title}</span>
                <button
                  type="button"
                  className="verify pressable"
                  onPointerDown={() => onSearch(`${t.artist || r.artist} ${t.title}`.trim())}
                >
                  Search
                </button>
              </li>
            ))}
          </ul>
        </li>
      )}
    </>
  );
}

export function LibraryView({
  library, onSearch,
}: {
  library: LibrarySession;
  onSearch(query: string): void;
}) {
  const [filter, setFilter] = useState('');
  const [readTags, setReadTags] = useState(true);
  const [dropping, setDropping] = useState(false);
  const [tab, setTab] = useState<'releases' | 'stats'>('releases');

  /* Drop folders here to scan them as well as the download folder.
   *
   * Tauri's webview reports a real filesystem path on the dropped File, which
   * a browser deliberately does not — so this works in the app and degrades to
   * nothing on the dev server rather than pretending to. */
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const paths: string[] = [];
    for (const item of Array.from(e.dataTransfer.files)) {
      const path = (item as File & { path?: string }).path;
      if (path) paths.push(path);
    }
    if (paths.length > 0) library.scan(paths, readTags);
  }, [library, readTags]);
  const { state, releases, loadReleases } = library;

  /* The folder picker, and the reason it exists: until it did, the ONLY way to
   * index anything but the download folder was the drop handler above, and that
   * cannot fire — Tauri v2 intercepts the OS drag before the webview sees it,
   * and a `File` in a Tauri webview has no `.path` anyway. So a collection that
   * already existed could not be pointed at, and the screen read zero for
   * anyone whose music was not downloaded through Seek. Reported by a user with
   * 53,000 tracks and an empty library.
   *
   * `state.roots` is carried back in every scan, here and on Rescan, because
   * the sidecar builds its list as `[download folder] + what it is given`: send
   * nothing and an added folder is silently dropped the next time anyone
   * rescans. Re-sending the download folder inside that list is harmless —
   * `dedupe_roots` collapses it, and collapses a folder that CONTAINS it too,
   * which is the common case and would otherwise count those files twice. */
  const addFolder = useCallback(() => {
    void chooseFolder('Choose a folder to add to your library').then((picked) => {
      if (picked) library.scan([...state.roots, picked], readTags);
    });
  }, [library, state.roots, readTags]);

  useEffect(() => { loadReleases(); }, [loadReleases, state.scannedAt]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return releases;
    return releases.filter((r) => (
      r.release.toLowerCase().includes(q) || r.artist.toLowerCase().includes(q)
    ));
  }, [releases, filter]);

  const totalBytes = useMemo(
    () => releases.reduce((n, r) => n + r.bytes, 0),
    [releases],
  );

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Library</h1>
        <p className="pane__subtitle">
          {state.scannedAt
            ? `${state.releaseCount.toLocaleString()} releases, `
              + `${state.trackCount.toLocaleString()} tracks · scanned ${when(state.scannedAt)}`
            : 'Not scanned yet.'}
        </p>
        <div className="browse__form lib__actions">
          <button
            type="button"
            className="btn btn--primary pressable"
            disabled={state.scanning || !library.available}
            onPointerDown={() => library.scan(state.roots, readTags)}
          >
            {state.scanning ? 'Scanning…' : state.scannedAt ? 'Rescan' : 'Scan my downloads'}
          </button>
          {/* Absent in a plain browser, where there is no native panel — the
              same contract as the folder settings, which is why this reuses
              their `chooseFolder` rather than growing a second one. */}
          {canChooseFolder() && (
            <button
              type="button"
              className="btn pressable"
              disabled={state.scanning || !library.available}
              /* onClick, not onPointerDown as the button beside it uses: a
                 keyboard Enter dispatches a click and never a pointerdown, so
                 the house pattern here is silently mouse-only. The sidebar has
                 the same problem and that is why Library cannot be reached from
                 a keyboard at all — worth fixing broadly, but not by leaving
                 this one unreachable in the meantime. */
              onClick={addFolder}
            >
              Add a folder…
            </button>
          )}
          {/* Borrowed from the metadata panel — the same shape, a checkbox with
              an inline label. Renamed along with it when `.meta` was
              namespaced away from the search row's grid. */}
          <label className="mdpanel__embed">
            <input
              type="checkbox"
              checked={readTags}
              disabled={state.scanning}
              onChange={(e) => setReadTags(e.target.checked)}
            />
            {/* Stated plainly rather than buried: it is a real trade, and on a
                network volume the difference is minutes. */}
            <span>Read tags — slower, much more accurate</span>
          </label>
          {releases.length > 0 && (
            <SegmentedControl<'releases' | 'stats'>
              value={tab}
              segments={TABS}
              onChange={setTab}
              label="What to show about the collection"
            />
          )}
          {releases.length > 0 && tab === 'releases' && (
            <input
              className="settings__input browse__filter"
              value={filter}
              placeholder="Filter the collection…"
              aria-label="Filter the collection"
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
        </div>
      </header>

      <div
        className="pane__scroll"
        data-dropping={dropping ? 'true' : undefined}
        onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        {dropping && (
          <p className="lib__drop">Drop folders to add them to the scan</p>
        )}
        {!library.available ? (
          <div className="empty empty--section">
            <span className="empty__icon"><IconLibrary size={28} painted={1.3} /></span>
            <p className="empty__title">Not connected</p>
            <p className="empty__body">The library is built by the sidecar.</p>
          </div>
        ) : releases.length === 0 ? (
          <div className="empty empty--section">
            <span className="empty__icon"><IconLibrary size={28} painted={1.3} /></span>
            <p className="empty__title">
              {state.scanning ? 'Scanning…' : 'Nothing indexed yet'}
            </p>
            <p className="empty__body">
              {state.scanning
                ? `${state.trackCount.toLocaleString()} files so far.`
                : 'Seek indexes your download folder. Add the folder your collection '
                  + 'already lives in and it will mark search results you own, so you '
                  + 'stop downloading the same record twice. This is separate from your '
                  + 'shared folders, which are what you send to other people.'}
            </p>
          </div>
        ) : tab === 'stats' ? (
          <StatsView library={library} />
        ) : (
          <div className="browse">
            <div className="browse__bar">
              <span className="browse__stat tnum">{shown.length.toLocaleString()} releases</span>
              <span className="browse__stat tnum">{fileSize(totalBytes)}</span>
              {state.roots.length > 0 && (
                <span className="browse__stat" title={state.roots.join('\n')}>
                  {state.roots.length === 1 ? state.roots[0] : `${state.roots.length} folders`}
                </span>
              )}
            </div>

            <ul className="wish">
              {shown.slice(0, 500).map((r) => (
                <ReleaseRow key={r.key} r={r} library={library} onSearch={onSearch} />
              ))}
            </ul>
            {shown.length > 500 && (
              <p className="settings__hint">
                Showing the first 500. Use the filter to narrow it down.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
