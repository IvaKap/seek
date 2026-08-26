/*
 * Seek — uploads.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The last thing in the app that was happening with nothing on screen. Seek
 * has served peers since sharing was first switched on, and the only trace was
 * a byte count on the Statistics screen; there were no upload commands, events
 * or state at all until this.
 *
 * NOT the downloads screen with a filter, and the difference is the point.
 * Downloads carry verify, organise, preview, related, metadata — every one of
 * those is something you do to a file you RECEIVED, and none of them mean
 * anything about a file of your own that a stranger is fetching. What matters
 * here is the opposite: WHO is taking it, how far along they are, and whether
 * you want to stop. So this reads as a guest list rather than a work queue.
 *
 * IT IS ALSO NOT A CONTROL PANEL. There is no pause, because upstream has no
 * paused state for an upload — `uploads.py` never sets it — and a peer sitting
 * in your queue is not something to quietly park. Cancelling tells them,
 * through upstream's UploadDenied, rather than dropping the socket in silence.
 */

import type { TransferGroup, TransferSession } from '../data/transferStore.ts';
import { fileName, isActive, isFailed } from '../data/transferStore.ts';
import { fileSize, integer, speed as fmtSpeed } from '../domain/format.ts';
import { Bar, eta, groupEta, releaseOf } from './transferBits.tsx';
import { PeerHistory } from './PeerHistory.tsx';
import type { PeerLookup } from './PeerHistory.tsx';
import { IconArrowUp, IconClose, IconEmpty } from '../icons/index.tsx';

function Row({
  group, peers, onCancel, onClear,
}: {
  group: TransferGroup;
  peers?: PeerLookup;
  onCancel(ids: string[]): void;
  onClear(ids: string[]): void;
}) {
  const { artist, release } = releaseOf(group);
  const running = group.transfers.filter((t) => isActive(t.state));
  const done = group.state === 'finished';
  const remaining = groupEta(group);

  return (
    <div className="up" data-state={group.state}>
      <div className="up__head">
        <span className="up__who">
          {/* No flag here on purpose. `Transfer` carries no country, and the
              only cache Seek has is populated from SEARCH responses — a peer
              downloading from you may never have appeared in one of your
              searches, so it would be blank for most rows and present for a
              few, which reads as a bug rather than as missing data. */}
          <span className="up__user">{group.username}</span>
          <PeerHistory username={group.username} peers={peers} compact />
        </span>
        <span className="up__title">
          {artist && <span className="up__artist">{artist}</span>}
          {release}
        </span>
      </div>

      <div className="up__facts tnum">
        <span>{integer(group.transfers.length)} {group.transfers.length === 1 ? 'file' : 'files'}</span>
        <span>{fileSize(group.size)}</span>
        {group.speed > 0 && <span className="up__speed">{fmtSpeed(group.speed)}</span>}
        {running.length > 0 && remaining !== null && <span>{eta(remaining)} left</span>}
        {group.failed > 0 && (
          <span className="up__failed">
            {group.failed} {group.failed === 1 ? 'failed' : 'failed'}
          </span>
        )}
      </div>

      <Bar done={group.bytesDone} total={group.size} state={group.state} />

      <div className="up__files">
        {group.transfers.slice(0, 6).map((t) => (
          <span className="up__file" key={t.id} data-state={t.state}>
            <span className="up__file-name" title={t.path}>{fileName(t.path)}</span>
            <span className="up__file-size tnum">{fileSize(t.size)}</span>
            {/* Their place in YOUR queue, which is the one number a peer
                actually cares about and the one they cannot see. */}
            {t.queuePosition !== null && t.state === 'queued' && (
              <span className="up__queue tnum">#{t.queuePosition}</span>
            )}
            {isFailed(t.state) && <span className="up__file-bad">{t.error ?? 'failed'}</span>}
          </span>
        ))}
        {group.transfers.length > 6 && (
          <span className="up__file up__more tnum">
            and {group.transfers.length - 6} more
          </span>
        )}
      </div>

      <div className="up__actions">
        {running.length > 0 && (
          <button
            type="button"
            className="verify pressable"
            title="Stop sending these. The peer is told, rather than the connection just dropping."
            onPointerDown={() => onCancel(running.map((t) => t.id))}
          >
            <IconClose size={12} painted={1.7} />
            Stop
          </button>
        )}
        {done && (
          <button
            type="button"
            className="verify pressable"
            onPointerDown={() => onClear(group.transfers.map((t) => t.id))}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

export function UploadsView({
  session, peers, sharing,
}: {
  session: TransferSession;
  peers?: PeerLookup;
  /**
   * Whether anything is shared — or NULL when the engine has not said.
   *
   * Three states, not two. Collapsing "we have not been told" into "you are
   * not sharing" makes this screen state a fact about the user's own
   * configuration that it cannot possibly know: in offline mode it told
   * someone sharing six thousand files that they were sharing nothing, and
   * pointed them at a settings screen that could not be reached either.
   */
  sharing: boolean | null;
}) {
  const groups = session.uploadGroups;
  const active = groups.filter((g) => g.state === 'active' || g.state === 'queued');
  const totalBytes = groups.reduce((n, g) => n + g.size, 0);
  const speed = groups.reduce((n, g) => n + g.speed, 0);

  const header = (
    <header className="header header--plain">
      <h1 className="pane__title">Uploads</h1>
      {groups.length > 0 ? (
        <p className="pane__subtitle tnum">
          {integer(groups.length)} {groups.length === 1 ? 'release' : 'releases'}
          {' · '}{fileSize(totalBytes)}
          {speed > 0 && <> · {fmtSpeed(speed)}</>}
          {active.length > 0 && <> · {integer(active.length)} in progress</>}
        </p>
      ) : (
        <p className="pane__subtitle">
          What other people are taking from you.
        </p>
      )}
    </header>
  );

  if (groups.length === 0) {
    return (
      <>
        {header}
        <div className="pane__scroll">
          <div className="empty empty--section">
            <span className="empty__icon">
              {sharing === true
                ? <IconArrowUp size={28} painted={1.3} />
                : <IconEmpty size={28} painted={1.3} />}
            </span>
            {/* Three genuinely different situations. Conflating any two of
                them sends someone hunting a fault that is not there. */}
            <p className="empty__title">
              {sharing === null ? 'Not connected to the engine'
                : sharing ? 'Nobody is downloading from you'
                  : 'You are not sharing anything'}
            </p>
            <p className="empty__body">
              {sharing === null
                ? 'Uploads are served by the engine, so they arrive with the '
                  + 'connection — along with whether you are sharing at all.'
                : sharing
                  ? 'Uploads appear here on their own — a peer asks, and the engine '
                    + 'serves them. Nothing to start.'
                  : 'Soulseek is reciprocal: peers deprioritise and ban clients that '
                    + 'share nothing, which is usually why a queue crawls. '
                    + 'Settings → Folders is where you choose what to offer.'}
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
        <div className="ups">
          {groups.map((g) => (
            <Row
              key={g.key}
              group={g}
              peers={peers}
              onCancel={session.cancel}
              onClear={session.clear}
            />
          ))}
        </div>
      </div>
    </>
  );
}
