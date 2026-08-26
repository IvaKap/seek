/*
 * Seek — transfer statistics.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Distinct from `StatsView`, which describes the LIBRARY — what the collection
 * is made of. This one describes the TRANSFERS: what has moved, in both
 * directions, and how the peers behaved. It reuses that screen's tiles and
 * bars deliberately, so the two agree about what a figure looks like.
 *
 * THE UPLOAD FIGURES ARE THE POINT. Seek has no upload view at all — the
 * engine has been serving peers since the first sign-in and counting bytes
 * nobody could see. This is the first screen that says so.
 *
 * TWO THINGS IT REFUSES TO SAY. It never calls `downloadedSize` a collection
 * size: those are bytes MOVED, so a download that died at 80% is in there and
 * the file is not (the library screen answers "what do I have"). And it never
 * shows a rate or a ratio computed from too little history — `completionRate`
 * and `peerTone` both withhold, and an empty string is the honest render.
 */

import { useMemo } from 'react';
import type { StatsSession } from '../data/statsStore.ts';
import type { PrefsSession } from '../data/prefsStore.ts';
import { fileSize } from '../domain/format.ts';
import {
  completionRate, describeRatio, describeSince, formatRate,
  peerHistorySuspect, peerTotals,
} from '../domain/transferStats.ts';
import { peerTone } from '../domain/score.ts';
import { IconEmpty } from '../icons/index.tsx';

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value tnum">{value}</span>
      {sub && <span className="stat__sub tnum">{sub}</span>}
    </div>
  );
}

/** started / completed / rate, for one direction. */
function Direction({
  label, started, completed, bytes,
}: {
  label: string;
  started: number;
  completed: number;
  bytes: number;
}) {
  const rate = formatRate(completionRate(started, completed));
  return (
    <div className="tstat__dir">
      <span className="tstat__dir-label">{label}</span>
      <span className="tstat__dir-figure tnum">{fileSize(bytes)}</span>
      <span className="tstat__dir-sub tnum">
        {completed.toLocaleString()} of {started.toLocaleString()} finished
        {/* Empty below five attempts rather than a percentage computed from
            two — see `completionRate`. */}
        {rate && <> · {rate}</>}
      </span>
    </div>
  );
}

export function TransferStatsView({
  stats: session, prefs,
}: {
  stats: StatsSession;
  prefs: PrefsSession;
}) {
  const { stats, available } = session;
  const total = stats.total;

  const ratio = useMemo(() => describeRatio(total), [total]);
  const since = useMemo(() => describeSince(stats.sinceTimestamp), [stats.sinceTimestamp]);

  const peers = useMemo(() => peerTotals(prefs.peers.values()), [prefs.peers]);
  /* More recorded outcomes than downloads ever started means the store
   * predates the fix in `_record_outcome` and its failure counts are inflated
   * by transfers that oscillated rather than transfers that failed. Nothing
   * can reconstruct the truth from that, so the totals are withheld. */
  const suspect = useMemo(
    () => peerHistorySuspect(peers, total.startedDownloads),
    [peers, total.startedDownloads],
  );

  /* Busiest peers first. Names are real Soulseek handles and this is the
   * user's own log, which is the only basis PRODUCT §8 allows — nothing here
   * claims anything about how a peer treats anyone else. */
  const topPeers = useMemo(() => (
    [...prefs.peers.values()]
      .filter((p) => p.ok + p.failed > 0)
      .sort((a, b) => (b.ok + b.failed) - (a.ok + a.failed))
      .slice(0, 10)
  ), [prefs.peers]);

  const sessionActive = Object.values(stats.session).some((v) => v > 0);

  if (!available) {
    return (
      <>
        <header className="header header--plain">
          <h1 className="pane__title">Statistics</h1>
        </header>
        <div className="pane__scroll">
          <div className="empty empty--section">
            <span className="empty__icon"><IconEmpty size={28} painted={1.3} /></span>
            <p className="empty__title">Not connected to the engine</p>
            <p className="empty__body">
              These counters live in the engine's own configuration, so they
              arrive with the connection.
            </p>
          </div>
        </div>
      </>
    );
  }

  const peakBytes = Math.max(total.downloadedSize, total.uploadedSize, 1);

  return (
    <>
      <header className="header header--plain">
        <h1 className="pane__title">Statistics</h1>
        <p className="pane__subtitle">
          Everything this account has moved{since && <> since {since}</>}.
          These are bytes transferred, not files kept — a download that died
          part-way counts here and is not in your library.
        </p>
      </header>

      <div className="pane__scroll">
        <div className="stats">
          <div className="stats__tiles">
            <Tile label="Downloaded" value={fileSize(total.downloadedSize)} />
            <Tile label="Uploaded" value={fileSize(total.uploadedSize)} />
            <Tile
              label="Share ratio"
              value={ratio.headline || '—'}
              sub={ratio.ratio === null ? undefined : `${peers.peers} peers`}
            />
          </div>

          {/* The one genuinely chart-shaped thing here: two magnitudes worth
              comparing directly. The accent marks what was GIVEN, matching the
              app's rule that the accent goes on the better thing. */}
          <section className="stats__block">
            <h2 className="stats__title">Given and taken</h2>
            <ul className="bars">
              <li className="bar bar--named">
                <span className="bar__name bar__name--wide">Downloaded</span>
                <span className="bar__track">
                  <span
                    className="bar__fill"
                    data-kind="lossy"
                    style={{ width: `${(total.downloadedSize / peakBytes) * 100}%` }}
                  />
                </span>
                <span className="bar__value tnum">{fileSize(total.downloadedSize)}</span>
              </li>
              <li className="bar bar--named">
                <span className="bar__name bar__name--wide">Uploaded</span>
                <span className="bar__track">
                  <span
                    className="bar__fill"
                    data-kind="lossless"
                    style={{ width: `${(total.uploadedSize / peakBytes) * 100}%` }}
                  />
                </span>
                <span className="bar__value tnum">{fileSize(total.uploadedSize)}</span>
              </li>
            </ul>
            <p className="tstat__note" data-tone={ratio.tone}>{ratio.note}</p>
          </section>

          <section className="stats__block">
            <h2 className="stats__title">Transfers</h2>
            <div className="tstat__dirs">
              <Direction
                label="Downloads"
                started={total.startedDownloads}
                completed={total.completedDownloads}
                bytes={total.downloadedSize}
              />
              <Direction
                label="Uploads"
                started={total.startedUploads}
                completed={total.completedUploads}
                bytes={total.uploadedSize}
              />
            </div>
            <p className="settings__footnote">
              Soulseek transfers fail constantly and that is normal — peers go
              offline, queues never come up, shares move. The completion rate
              is a fact about the network far more than about you.
            </p>
          </section>

          {/* Only when this run has actually done something. A block of zeros
              is noise, and it trains you to stop reading the screen. */}
          {sessionActive && (
            <section className="stats__block">
              <h2 className="stats__title">Since Seek started</h2>
              <div className="tstat__dirs">
                <Direction
                  label="Downloads"
                  started={stats.session.startedDownloads}
                  completed={stats.session.completedDownloads}
                  bytes={stats.session.downloadedSize}
                />
                <Direction
                  label="Uploads"
                  started={stats.session.startedUploads}
                  completed={stats.session.completedUploads}
                  bytes={stats.session.uploadedSize}
                />
              </div>
            </section>
          )}

          {peers.peers > 0 && (
            <section className="stats__block">
              <h2 className="stats__title">Peers</h2>
              {suspect ? (
                <p className="tstat__peers" data-suspect="true">
                  Seek has {(peers.ok + peers.failed).toLocaleString()} recorded
                  outcomes across {peers.peers} peers, against{' '}
                  {total.startedDownloads.toLocaleString()} downloads ever
                  started — so the failure counts are inflated and the totals
                  are not worth stating. A transfer that sat in a queue while
                  its peer went offline and came back used to be logged as a
                  failure on every cycle; that is fixed, but the numbers it
                  already wrote cannot be untangled.
                </p>
              ) : (
                <p className="tstat__peers tnum">
                  {peers.ok.toLocaleString()} of {(peers.ok + peers.failed).toLocaleString()} transfers
                  finished, across {peers.peers} {peers.peers === 1 ? 'peer' : 'peers'}.
                  {/* `peerTone` withholds a verdict below three transfers, so the
                      good and bad counts are stated against `judged`, never
                      against the whole list. */}
                  {peers.judged > 0 && (
                    <>
                      {' '}Of the {peers.judged} you have dealt with enough to judge,{' '}
                      {peers.good} {peers.good === 1 ? 'has' : 'have'} been reliable
                      {peers.bad > 0 && <> and {peers.bad} not</>}.
                    </>
                  )}
                </p>
              )}

              <ul className="bars">
                {topPeers.map((p) => {
                  const attempts = p.ok + p.failed;
                  const tone = peerTone(p.ok, p.failed);
                  return (
                    <li className="bar bar--named" key={p.username}>
                      <span className="bar__name bar__name--wide" title={p.username}>
                        {p.username}
                      </span>
                      <span className="bar__track">
                        <span
                          className="bar__fill"
                          data-tone={tone}
                          style={{
                            width: `${(attempts / (topPeers[0].ok + topPeers[0].failed)) * 100}%`,
                          }}
                        />
                      </span>
                      <span className="bar__value tnum">
                        {p.ok}/{attempts}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="settings__footnote">
                Your own history with each peer, and nothing else — Soulseek
                exposes nothing about how anyone treats other people. Peers with
                fewer than three transfers are counted above but not judged.
              </p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
