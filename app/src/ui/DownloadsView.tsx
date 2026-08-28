/*
 * Seek — downloads.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * docs/PRODUCT.md §7: a download is an object — a release with one progress
 * bar — not a table of cryptic transfer rows. Per-file detail is behind
 * expansion, because you should only have to think about individual files when
 * something goes wrong. When something does go wrong, the failing file surfaces
 * itself: a group with failures sorts up and says so on its header.
 *
 * Every number is tabular. A live download with jittering digits is exactly the
 * thing the brief says destroys the calm.
 */

import { useEffect, useMemo, useState } from 'react';
import type { TransferGroup, TransferSession } from '../data/transferStore.ts';
import { fileName, isActive, isFailed } from '../data/transferStore.ts';
/* Shared with the uploads screen — see the header on transferBits.tsx for
   what deliberately did NOT move there. */
import { Bar, eta, groupEta, releaseOf } from './transferBits.tsx';
import { fileSize, integer, spanWords, speed as fmtSpeed } from '../domain/format.ts';
import { transferStatus } from '../domain/transferStatus.ts';
import { ViewMenu } from './ViewMenu.tsx';
import { matchesQuery, sortGroups } from '../domain/transferOrder.ts';
import type { SortKey } from '../domain/transferOrder.ts';
import type { Density } from './ViewMenu.tsx';
import type { AnalysisSession } from '../data/analysisStore.ts';
import type { SidecarClient } from '../data/sidecarClient.ts';
import { ASSESSMENT_LABEL, ASSESSMENT_TONE, explain } from '../data/analysisStore.ts';
import { Spectrum } from './Spectrum.tsx';
import { MetadataPanel, MetadataTrigger, useMetadata } from './MetadataPanel.tsx';
import { PreviewButton } from './Preview.tsx';
import { OrganiseButton } from './Organise.tsx';
import type { PreviewSession } from './Preview.tsx';
import { Related } from './Related.tsx';
import type { RelatedSession } from '../data/relatedStore.ts';
import type { CatalogEntry } from '../data/catalogStore.ts';
import type { ArtworkSession } from '../data/artworkStore.ts';
import type { LibrarySession } from '../data/libraryStore.ts';
import { IconChevronDown, IconDownload, IconEmpty, IconRelease } from '../icons/index.tsx';
import { Placeholder } from './ReleaseCard.tsx';
import { useNearViewport } from './useNearViewport.ts';

/** Everything the Related shelf needs, bundled so it threads as one prop. */
export interface RelatedDiscovery {
  related: RelatedSession;
  artwork?: ArtworkSession;
  library?: LibrarySession;
  wantedUrls: Set<string>;
  onSearch(entry: CatalogEntry): void;
  onWant(entry: CatalogEntry): void;
}

/** What a group is, as far as a related-releases lookup is concerned. */
/**
 * The post-download finding, distinct from the search-time prediction.
 * PRODUCT §6: a file that passed the prediction and fails this is the moment
 * the app earns its keep, so this never reuses the search badge's wording.
 */
function Verdict({
  id, analysis, open, onToggle,
}: {
  id: string;
  analysis: AnalysisSession;
  open: boolean;
  onToggle(): void;
}) {
  const entry = analysis.byTransfer.get(id);

  if (!entry) {
    return (
      <button
        type="button"
        className="verify pressable"
        onPointerDown={() => analysis.analyseTransfer(id)}
        title="Decode the file and inspect its spectrum for a lowpass shelf — the only transcode check that works on lossless."
      >
        Verify
      </button>
    );
  }
  if (entry.state === 'running') return <span className="verify verify--busy">Analysing…</span>;
  if (entry.state === 'failed') {
    return <span className="verify verify--failed" title={entry.reason}>Could not analyse</span>;
  }

  const a = entry.result!;
  return (
    <button
      type="button"
      className="verify verify--done pressable"
      data-tone={ASSESSMENT_TONE[a.assessment]}
      aria-expanded={open}
      title={explain(a)}
      onPointerDown={onToggle}
    >
      {ASSESSMENT_LABEL[a.assessment]}
      <span className="verify__caret" aria-hidden>{open ? '\u2303' : '\u2304'}</span>
    </button>
  );
}

/**
 * One file, and the detail rows it can open. Emits SIBLING <li>s rather than
 * nesting: the file row is a grid, and a panel placed inside one of its cells
 * is trapped in that column however wide the content wants to be.
 */
function FileRow({
  t, analysis, client, spectrumOpen, onToggleSpectrum, preview,
}: {
  t: TransferGroup['transfers'][number];
  analysis: AnalysisSession;
  client: SidecarClient | null;
  spectrumOpen: boolean;
  onToggleSpectrum(): void;
  preview: PreviewSession;
}) {
  const meta = useMetadata(client, t.id);
  const spectrum = analysis.byTransfer.get(t.id)?.result;
  const status = transferStatus(t);

  return (
    <>
      <li className="dl__file" data-state={t.state}>
        <span className="dl__name">
          {fileName(t.path)}
          {/* Per-file progress. A folder download shows one bar for the whole
              release, which answers "how long" but not "which track is moving"
              — and when one file stalls in a 12-track album, the group bar
              hides exactly the thing you need to see. */}
          {t.size > 0 && t.bytesDone > 0 && t.state !== 'finished' && (
            <span className="dl__fileprog" aria-hidden>
              <span
                className="dl__fileprog-fill"
                style={{ transform: `scaleX(${Math.min(1, t.bytesDone / t.size)})` }}
              />
            </span>
          )}
        </span>
        <span className="dl__meta tnum">
          {t.state === 'finished' || t.size === 0 || t.bytesDone === 0
            ? fileSize(t.size)
            : `${Math.round((t.bytesDone / t.size) * 100)}%`}
        </span>
        <span className="dl__meta tnum">
          {isActive(t.state) && t.speed > 0 ? `↓ ${fmtSpeed(t.speed)}` : ''}
        </span>
        <span className="dl__meta tnum">
          {t.queuePosition !== null ? `#${t.queuePosition} in queue` : ''}
        </span>
        {/* `t.state.replace(/_/g, ' ')` used to be here, which is how a queue of
            stalled downloads came to read "unknown" and "user logged off" at
            people. All the wording lives in domain/transferStatus.ts now; the
            raw text stays on the title so the original is still recoverable. */}
        <span className="dl__state" data-tone={status.tone} title={t.error ?? undefined}>
          {status.text}
        </span>
        <span className="dl__verify">
          {t.state === 'finished' && <PreviewButton id={t.id} preview={preview} />}
        </span>
        <span className="dl__verify">
          {t.state === 'finished' && <MetadataTrigger m={meta} />}
        </span>
        <span className="dl__verify">
          {t.state === 'finished' && <OrganiseButton client={client} transferId={t.id} />}
        </span>
        <span className="dl__verify">
          {t.state === 'finished' && (
            <Verdict
              id={t.id}
              analysis={analysis}
              open={spectrumOpen}
              onToggle={onToggleSpectrum}
            />
          )}
        </span>
      </li>

      {meta.proposal && meta.proposal.matched && !meta.result && (
        <li className="dl__detail"><MetadataPanel m={meta} /></li>
      )}
      {spectrumOpen && spectrum && (
        <li className="dl__detail"><Spectrum a={spectrum} /></li>
      )}
    </>
  );
}

/** The longest ETA in a group — the release is done when its slowest file is. */
/**
 * The actions a group offers. Shared by both densities so the table cannot
 * silently drift from the card — `compact` drops the labels that repeat what
 * the row already says.
 */
function Actions({
  g, session, compact, discovery, related, setRelated,
}: {
  g: TransferGroup;
  session: TransferSession;
  compact?: boolean;
  discovery?: RelatedDiscovery;
  related?: boolean;
  setRelated?(fn: (v: boolean) => boolean): void;
}) {
  const ids = g.transfers.map((t) => t.id);
  const cls = compact ? 'verify pressable' : 'btn pressable';
  return (
    <>
      {g.state === 'active' && (
        <button type="button" className={cls} onPointerDown={() => session.pause(ids)}>
          Pause
        </button>
      )}
      {g.state === 'paused' && (
        <button type="button" className={cls} onPointerDown={() => session.resume(ids)}>
          Resume
        </button>
      )}
      {g.failed > 0 && (
        <button
          type="button"
          className={cls}
          onPointerDown={() => session.retry(
            g.transfers.filter((t) => isFailed(t.state)).map((t) => t.id),
          )}
        >
          Retry{compact ? '' : ' failed'}
        </button>
      )}
      {g.state === 'cancelled' && (
        <button type="button" className={cls} onPointerDown={() => session.retry(ids)}>
          Retry
        </button>
      )}
      {discovery && g.state === 'finished' && (
        <button
          type="button" className={cls}
          aria-expanded={related}
          title="What else this artist made, and what else is on the label"
          onPointerDown={() => setRelated?.((v) => !v)}
        >
          Related
        </button>
      )}
      {g.state === 'finished' || g.state === 'cancelled' ? (
        <button type="button" className={cls} onPointerDown={() => session.clear(ids)}>
          Clear
        </button>
      ) : (
        <button type="button" className={cls} onPointerDown={() => session.cancel(ids)}>
          Cancel
        </button>
      )}
    </>
  );
}

/**
 * One release as a single table line.
 *
 * Structurally different from the card rather than a flattened version of it,
 * for the reason recorded on the search table's CSS: flex containers cannot
 * align across siblings, so "the card, but shorter" never lines up column to
 * column. This is a grid row whose cells are siblings of the header's, and it
 * carries THREE separate buttons — disclosure, and the actions — rather than
 * nesting them inside one hit target, which is invalid HTML.
 */
function TableRow({
  g, session, filter, open, onToggle, discovery, related, setRelated,
}: {
  g: TransferGroup;
  session: TransferSession;
  filter: 'active' | 'finished' | 'failed';
  open: boolean;
  onToggle(): void;
  discovery?: RelatedDiscovery;
  related: boolean;
  setRelated(fn: (v: boolean) => boolean): void;
}) {
  const pct = g.size > 0 ? Math.round((g.bytesDone / g.size) * 100) : 0;
  const firstError = g.transfers.find((t) => t.error)?.error;

  return (
    <div className="dl__row" data-state={g.state}>
      <button
        type="button"
        className="dl__disclose"
        aria-expanded={open}
        aria-label={`${g.title}, ${g.finished} of ${g.transfers.length} files, ${fileSize(g.size)}`}
        onPointerDown={onToggle}
      >
        <IconChevronDown
          size={12} painted={1.6} className="dl__chev"
          data-open={open ? 'true' : undefined}
        />
        <span className="dl__rowname">{g.title}</span>
        {g.stalled && <span className="dl__flag">stalled</span>}
      </button>

      <span className="dl__cell tnum">{g.finished}/{g.transfers.length}</span>
      <span className="dl__cell tnum">{fileSize(g.size)}</span>

      {filter === 'active' && (
        <span className="dl__cell dl__progcell">
          <span className="dl__minibar" aria-hidden>
            <span className="dl__minifill" style={{ transform: `scaleX(${pct / 100})` }} />
          </span>
          <span className="tnum">{pct}%</span>
        </span>
      )}
      {filter === 'active' && (
        <span className="dl__cell tnum">{g.speed > 0 ? fmtSpeed(g.speed) : '—'}</span>
      )}
      {filter === 'active' && (
        <span className="dl__cell tnum">{eta(groupEta(g))}</span>
      )}
      {filter === 'failed' && (
        <span className="dl__cell dl__cell--reason" title={firstError ?? undefined}>
          {firstError ?? g.state.replace(/_/g, ' ')}
        </span>
      )}

      <span className="dl__cell dl__cell--who">{g.username}</span>
      <span className="dl__cell dl__rowactions">
        <Actions g={g} session={session} compact discovery={discovery}
                 related={related} setRelated={setRelated} />
      </span>
    </div>
  );
}

function Group({
  g, session, analysis, client, preview, density, filter, discovery,
}: {
  g: TransferGroup;
  session: TransferSession;
  analysis: AnalysisSession;
  client: SidecarClient | null;
  preview: PreviewSession;
  density: Density;
  filter: 'active' | 'finished' | 'failed';
  discovery?: RelatedDiscovery;
}) {
  const [open, setOpen] = useState(false);
  /** Whether the Related shelf is showing for this release. */
  const [related, setRelated] = useState(false);
  /** Which file's spectrum is expanded. Only one at a time — the chart is the
   *  evidence for a single claim, and two side by side invite comparison the
   *  data does not support. */
  const [spectrumFor, setSpectrumFor] = useState<string | null>(null);
  const pct = g.size > 0 ? Math.round((g.bytesDone / g.size) * 100) : 0;

  const { artist, release } = releaseOf(g);
  /* The label comes from the artwork pipeline, which already found it while
   * fetching the cover — MusicBrainz returns both from the same lookup, so
   * this costs nothing extra. */
  const artKey = `dl:${g.key}`;
  const art = discovery?.artwork?.get(artKey);
  const label = art?.state === 'ready' ? art.label : '';

  // Ask for artwork in an effect, not during render.
  useEffect(() => {
    if (related) discovery?.artwork?.want(artKey, artist, release);
  }, [related, discovery, artKey, artist, release]);

  /* WAIT FOR THE LABEL before asking. The label comes from the same
   * MusicBrainz lookup that fetches the cover, and it is the whole point of
   * this panel for a label-driven collector — asking before it arrives got
   * "More by Massive Attack" and no label shelf at all, because the request is
   * deduplicated and never asked again once the label turned up. `missing`
   * counts as settled: no cover means no label is coming either. */
  const artSettled = !discovery?.artwork
    || art?.state === 'ready' || art?.state === 'missing';

  useEffect(() => {
    if (!related || !discovery || !artSettled) return;
    discovery.related.want(artKey, artist, release, label || null);
  }, [related, discovery, artSettled, artKey, artist, release, label]);

  const relatedPanel = related && discovery && (
    <Related
      result={discovery.related.get(artKey)}
      artist={artist}
      isOwned={(e) => discovery.library?.hasRelease(e.artist, e.title) ?? false}
      isWanted={(e) => discovery.wantedUrls.has(e.url)}
      onSearch={discovery.onSearch}
      onWant={discovery.onWant}
    />
  );

  const files = open && (
    <ul className="dl__files">
      {g.transfers.map((t) => (
        <FileRow
          key={t.id}
          t={t}
          analysis={analysis}
          client={client}
          spectrumOpen={spectrumFor === t.id}
          onToggleSpectrum={() => setSpectrumFor((cur) => (cur === t.id ? null : t.id))}
          preview={preview}
        />
      ))}
    </ul>
  );

  if (density === 'table') {
    return (
      <>
        <TableRow
          g={g}
          session={session}
          filter={filter}
          open={open}
          onToggle={() => setOpen((v) => !v)}
          discovery={discovery}
          related={related}
          setRelated={setRelated}
        />
        {files}
        {relatedPanel && <div className="dl__detail dl__detail--row">{relatedPanel}</div>}
      </>
    );
  }

  return (
    <div className="dl" data-state={g.state} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="dl__hit"
        aria-expanded={open}
        onPointerDown={() => setOpen((v) => !v)}
      >
        {/* Review lenses only. While a download is RUNNING the folder name is
            the honest label — it is literally what is arriving — and a cover
            beside a progress bar is decoration. Once it has stopped, the
            question changes from "how far" to "what is this", and the record
            is the answer. */}
        {filter !== 'active' && <Cover g={g} artwork={discovery?.artwork} />}
        <span className="dl__main">
          <span className="dl__title">
            {filter === 'active' ? g.title : <ReleaseName g={g} />}
          </span>
          <span className="dl__sub">
            <span className="dl__who">{g.username}</span>
            <span className="tnum">
              {g.finished}/{g.transfers.length} files
            </span>
            <span className="tnum">
              {fileSize(g.bytesDone)} / {fileSize(g.size)}
            </span>
            {g.state === 'active' && (
              <>
                <span className="tnum">↓ {fmtSpeed(g.speed)}</span>
                <span className="tnum">{eta(groupEta(g))}</span>
              </>
            )}
            {/* The number, not the word. "Stalled" is a state; "no movement
                for 34 minutes" is the fact a person needs to decide whether to
                retry it, and it is the same number the give-up threshold is
                compared against — so the row explains its own presence in
                Failed rather than appearing there unaccountably. */}
            {g.state === 'stalled' ? (
              <span className="dl__flag dl__flag--bad">
                no movement for {spanWords(g.quietFor)}
              </span>
            ) : g.stalled ? (
              <span className="dl__flag">stalled</span>
            ) : null}
            {g.failed > 0 && (
              <span className="dl__flag dl__flag--bad tnum">{g.failed} failed</span>
            )}
          </span>
        </span>

        <span className="dl__pct tnum">{pct}%</span>
        <IconChevronDown size={14} painted={1.5} className="dl__chev" data-open={open ? 'true' : undefined} />
      </button>

      {/* A finished release is at 100% by definition, and a full-width bar
          saying so on every row was pure furniture — it cost a whole line each
          and carried no information the section title did not already give. */}
      {g.state !== 'finished' && (
        <Bar done={g.bytesDone} total={g.size} state={g.state} />
      )}

      <div className="dl__actions">
        <Actions g={g} session={session} discovery={discovery}
                 related={related} setRelated={setRelated} />
      </div>

      {files}
      {relatedPanel && <div className="dl__detail">{relatedPanel}</div>}
    </div>
  );
}

/**
 * The cover and the real name, for a row you are REVIEWING rather than watching.
 *
 * `g.title` is the last segment of the remote folder, which is a filename and
 * often looks like one: `[HDA002] Seafoam - Lost In The Archives Vol. 2 [2025]`.
 * That is the right thing to show while a download is running, because it is
 * literally what is arriving — but a Failed list exists to be triaged, and
 * triage needs the record, not the path it came down.
 *
 * `releaseOf` already parses artist and release out of the path (the same
 * `parsePath` the whole app uses), and it is exactly the pair `artwork.want`
 * takes, so the cover costs no new lookup path.
 *
 * Only rendered when NEAR the viewport. These lists are not virtualised, so a
 * Completed section with four hundred releases would otherwise queue four
 * hundred rate-limited MusicBrainz requests the moment it opened.
 */
/**
 * `Artist — Release`, falling back to the folder name.
 *
 * Falls back rather than guessing: `parsePath` reports what it could actually
 * read, and a folder it cannot parse is shown verbatim instead of being
 * rendered as an empty artist and a mangled title. Half a parse looks like a
 * bug; the raw name at least matches what is on disk.
 */
function ReleaseName({ g }: { g: TransferGroup }) {
  const { artist, release } = releaseOf(g);
  if (!artist) return <>{release || g.title}</>;
  /* Some folders name the artist twice — `Revenge Of The Jaguar - The Aztec
   * Mystic` parses to an artist that is also the start of the release, and
   * rendering both gives "Revenge Of The Jaguar — Revenge Of The Jaguar - …".
   * The release alone is the more complete of the two, so it wins. Observed on
   * real completed downloads, not imagined. */
  if (release.toLowerCase().startsWith(artist.toLowerCase())) {
    return <>{release}</>;
  }
  return (
    <>
      <span className="dl__artist">{artist}</span>
      <span className="dl__dash" aria-hidden> — </span>
      {release}
    </>
  );
}

function Cover({ g, artwork }: { g: TransferGroup; artwork?: ArtworkSession }) {
  const { artist, release } = releaseOf(g);
  const key = `dl:${g.key}`;
  const [ref, near] = useNearViewport();

  // In an effect, not in render: React double-invokes render in development and
  // a network request is not something to fire while deciding what to draw.
  useEffect(() => {
    if (near) artwork?.want(key, artist, release);
  }, [near, artwork, key, artist, release]);

  const art = artwork?.get(key);
  return (
    <span className="art art--dl" ref={ref} aria-hidden>
      <Placeholder seed={`${artist}${release}`} />
      <IconRelease size={13} painted={1.3} className="art__fallback" />
      {art?.state === 'ready' && (
        <img className="art__img" src={art.dataUri} alt="" loading="lazy" />
      )}
    </span>
  );
}

const TITLES: Record<'active' | 'finished' | 'failed', string> = {
  active: 'Downloads', finished: 'Completed', failed: 'Failed',
};

/** Column labels, per lens. The header and the rows share one track list. */
function TableHead({ filter }: { filter: 'active' | 'finished' | 'failed' }) {
  return (
    <div className="dl__thead" aria-hidden>
      <span>Release</span>
      <span>Files</span>
      <span>Size</span>
      {filter === 'active' && <span>Progress</span>}
      {filter === 'active' && <span>Speed</span>}
      {filter === 'active' && <span>ETA</span>}
      {filter === 'failed' && <span>Reason</span>}
      <span>From</span>
      <span />
    </div>
  );
}

export function DownloadsView({
  session, signedIn, filter, analysis, client, preview, density, onDensity,
  discovery,
}: {
  session: TransferSession;
  signedIn: boolean;
  /** Which section this is rendering — the same list, three lenses. */
  filter: 'active' | 'finished' | 'failed';
  analysis: AnalysisSession;
  client: SidecarClient | null;
  preview: PreviewSession;
  density: Density;
  onDensity(d: Density): void;
  discovery?: RelatedDiscovery;
}) {
  /* Sort and query are per-lens and per-visit, deliberately. A search box that
   * remembered what you typed last time is a list that looks empty for reasons
   * you cannot see, which is the single most confusing state a filter has. */
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('default');
  const [descending, setDescending] = useState(false);

  const lens = session.groups.filter((g) => (
    /* A given-up group is excluded from 'active' by having its own state, and
     * joins Failed below. It is not a failure — nothing refused it and nothing
     * errored — but Failed is where you go to deal with downloads that are not
     * happening, and that is exactly what this is. */
    filter === 'active' ? g.state === 'active' || g.state === 'queued' || g.state === 'paused'
      : filter === 'finished' ? g.state === 'finished'
        // Cancelled sits with Failed: it did not complete, and it can be retried.
        : g.state === 'failed' || g.state === 'cancelled' || g.state === 'stalled'
  ));

  const groups = useMemo(
    () => sortGroups(lens.filter((g) => matchesQuery(g, query)), sort, descending),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lens, query, sort, descending],
  );

  /* Counted off the FILTERED list, so the subtitle describes what is on screen.
   * `hiddenCount` is what the filter is holding back, and it is stated rather
   * than left implied — an empty list with a stale query in the box is the
   * thing people report as "my downloads disappeared". */
  const totalBytes = groups.reduce((n, g) => n + g.size, 0);
  const totalFiles = groups.reduce((n, g) => n + g.transfers.length, 0);
  const hiddenCount = lens.length - groups.length;

  const header = (
    <header className="header header--plain dls__header">
      <div className="dls__heading">
        <h1 className="pane__title">{TITLES[filter]}</h1>
        {groups.length > 0 && (
          <p className="pane__subtitle tnum">
            {integer(groups.length)} {groups.length === 1 ? 'release' : 'releases'}
            {' · '}{integer(totalFiles)} {totalFiles === 1 ? 'file' : 'files'}
            {' · '}{fileSize(totalBytes)}
            {hiddenCount > 0 && <> · {integer(hiddenCount)} hidden by the filter</>}
          </p>
        )}
      </div>
      <div className="dls__tools">
        {(lens.length > 0 || query) && (
          <input
            className="settings__input browse__filter"
            value={query}
            placeholder={filter === 'failed' ? 'Filter by release or peer…' : 'Filter these…'}
            aria-label="Filter by release name or peer"
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {lens.length > 0 && (
          <ViewMenu
            density={density}
            onDensity={onDensity}
            /* Grid is for picking through a pile of records you already have or
               already lost. While a download is running the useful information
               is progress and speed, and a cover says neither. */
            densities={filter === 'active'
              ? ['comfortable', 'compact', 'table']
              : ['comfortable', 'compact', 'table', 'grid']}
            sort={sort}
            onSort={setSort}
            descending={descending}
            onDescending={setDescending}
          />
        )}
      </div>
    </header>
  );

  /* A filter that matches nothing is NOT an empty section, and saying "no
   * completed downloads yet" over twenty of them is the confidently-wrong
   * answer this app exists not to give. Caught by driving the real thing: the
   * filter box stays on screen, so the state is recoverable — but the sentence
   * was still a lie about what the user has. */
  if (groups.length === 0 && lens.length > 0) {
    return (
      <>
        {header}
        <div className="pane__scroll">
          <div className="empty empty--section">
            <span className="empty__icon"><IconEmpty size={28} painted={1.3} /></span>
            <p className="empty__title">Nothing matches that</p>
            <p className="empty__body">
              {integer(lens.length)}
              {lens.length === 1 ? ' release is' : ' releases are'} here, but none
              match “{query}”.
            </p>
            <button
              type="button"
              className="btn pressable"
              onClick={() => setQuery('')}
            >
              Clear the filter
            </button>
          </div>
        </div>
      </>
    );
  }

  if (groups.length === 0) {
    return (
      <>
        {header}
        <div className="pane__scroll">
          <div className="empty empty--section">
            <span className="empty__icon">
              {filter === 'active'
                ? <IconDownload size={28} painted={1.3} />
                : <IconEmpty size={28} painted={1.3} />}
            </span>
            <p className="empty__title">
              {filter === 'active' ? 'Nothing downloading'
                : filter === 'finished' ? 'No completed downloads yet'
                  : 'Nothing has failed'}
            </p>
            <p className="empty__body">
              {!signedIn
                ? 'Sign in from Settings to download anything.'
                : filter === 'active'
                  ? 'Queue a track or a release from Search and it appears here.'
                  : filter === 'finished'
                    ? 'Finished releases collect here, with where each one landed.'
                    : 'Transfers that error or lose their peer show up here with a retry.'}
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="pane__scroll">
        <div className="dls" data-density={density} data-filter={filter}>
          {session.note && !session.error && (
            <p className="dls__note" role="status">{session.note}</p>
          )}
          {session.error && (
            <p className="dls__error" role="alert">{session.error}</p>
          )}
          {density === 'table' && <TableHead filter={filter} />}
          {groups.map((g) => (
            <Group
              key={g.key}
              g={g}
              session={session}
              analysis={analysis}
              client={client}
              preview={preview}
              density={density}
              filter={filter}
              discovery={discovery}
            />
          ))}
        </div>
      </div>
    </>
  );
}
