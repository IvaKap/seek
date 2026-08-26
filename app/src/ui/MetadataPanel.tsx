/*
 * Seek — fix a downloaded file's tags from MusicBrainz.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Soulseek filenames are wildly inconsistent, so a downloaded file's tags are
 * usually wrong, partial, or absent. MusicBrainz knows what the release
 * actually is; this proposes the difference.
 *
 * PROPOSED, NEVER AUTOMATIC. A wrong automatic retag is unrecoverable once the
 * original name is gone, and MusicBrainz matching on a folder name is a guess
 * however good the score. So every field is a checkbox, shown as
 * `current → proposed`, unticked fields are left completely alone, and nothing
 * is written until you press Apply. Same discipline as the transcode check:
 * show the evidence, let the person decide.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SidecarClient } from '../data/sidecarClient.ts';

interface TagChange { field: string; current: string; proposed: string }

interface Proposal {
  requestId: string;
  path: string;
  transferId: string | null;
  matched: boolean;
  score: number;
  query: string;
  trackMatched: boolean;
  releaseTitle: string;
  releaseArtist: string;
  date: string;
  label: string;
  mbid: string;
  changes: TagChange[];
}

const FIELD_LABEL: Record<string, string> = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  albumartist: 'Album artist',
  date: 'Year',
  tracknumber: 'Track number',
  discnumber: 'Disc number',
  genre: 'Genre',
  label: 'Label',
};

/**
 * State lives in a hook so the trigger and the panel can render in DIFFERENT
 * places. The trigger belongs in the file row's narrow action cell; the panel
 * needs the full width of the list. Rendering both from one component put the
 * panel inside a 6rem grid cell, where `grid-column: 1 / -1` cannot apply
 * because it was not a child of the grid — every word wrapped.
 */
export function useMetadata(client: SidecarClient | null, transferId: string) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [state, setState] = useState<'idle' | 'looking' | 'done' | 'failed'>('idle');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [embedArt, setEmbedArt] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    return client.on('metadata.proposal', (d) => {
      const p = d as Proposal;
      if (p.transferId && p.transferId !== transferId) return;
      setProposal(p);
      setState('done');
      // Everything ticked by default — the user is here because they want the
      // tags fixed, and unticking an exception is less work than ticking eight.
      setChosen(new Set(p.changes.map((c) => c.field)));
    });
  }, [client, transferId]);

  const inspect = useCallback(() => {
    if (!client) return;
    setState('looking');
    setError(null);
    setResult(null);
    void client.request('metadata.inspect', { path: null, transferId })
      .catch((e: Error) => { setError(e.message); setState('failed'); });
  }, [client, transferId]);

  const apply = useCallback(() => {
    if (!client || !proposal) return;
    const fields = proposal.changes.filter((c) => chosen.has(c.field));
    void client.request<{ written: number; artworkEmbedded: boolean }>('metadata.apply', {
      path: proposal.path,
      fields,
      embedArtwork: embedArt,
      artist: proposal.releaseArtist,
      release: proposal.releaseTitle,
    })
      .then((r) => {
        setResult(
          `${r.written} field${r.written === 1 ? '' : 's'} written`
          + (r.artworkEmbedded ? ', artwork embedded.' : '.'),
        );
        setProposal(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [client, proposal, chosen, embedArt]);

  return {
    proposal, state, error, result, chosen, setChosen, embedArt, setEmbedArt,
    inspect, apply,
  };
}

export type MetadataState = ReturnType<typeof useMetadata>;

/** The compact control that lives in the file row. */
export function MetadataTrigger({ m }: { m: MetadataState }) {
  if (m.result) {
    return <span className="verify verify--done" data-tone="good">{m.result}</span>;
  }
  if (m.error) {
    return <span className="verify verify--failed" title={m.error}>Lookup failed</span>;
  }
  if (m.state === 'looking') return <span className="verify verify--busy">Matching…</span>;
  if (m.proposal && !m.proposal.matched) {
    return (
      <span
        className="verify verify--failed"
        title="No confident MusicBrainz match. Underground releases are often in no database at all — that is not a fault in the file."
      >
        No match
      </span>
    );
  }
  if (m.state === 'idle') {
    return (
      <button type="button" className="verify pressable" onPointerDown={m.inspect}>
        Fix tags
      </button>
    );
  }
  return null;
}

/** The full-width proposal. Rendered as its own row, never inside a cell. */
export function MetadataPanel({ m }: { m: MetadataState }) {
  const { proposal, chosen, setChosen, embedArt, setEmbedArt, apply } = m;
  if (!proposal || !proposal.matched || m.result) return null;

  return (
    <div className="mdpanel">
      <p className="mdpanel__head">
        <span className="mdpanel__rel">{proposal.releaseArtist} — {proposal.releaseTitle}</span>
        {proposal.date && <span className="mdpanel__bit tnum">{proposal.date.slice(0, 4)}</span>}
        {proposal.label && <span className="mdpanel__bit">{proposal.label}</span>}
      </p>

      <p className="mdpanel__status">
        <span>
          Matched on MusicBrainz at <span className="tnum">{proposal.score}</span>%
          {proposal.query && <> for “{proposal.query}”</>}
        </span>
        {proposal.mbid && (
          <span className="mdpanel__mbid" title={proposal.mbid}>
            {proposal.mbid.slice(0, 8)}
          </span>
        )}
        {proposal.score < 90 && (
          <span className="mdpanel__warn">
            Not a certain match — check the values before applying.
          </span>
        )}
        {!proposal.trackMatched && (
          <span className="mdpanel__warn">
            The release matched but this track did not, so the title and number
            below are a guess from position alone.
          </span>
        )}
      </p>

      {proposal.changes.length === 0 ? (
        <p className="settings__hint">Tags already agree with MusicBrainz. Nothing to change.</p>
      ) : (
        <ul className="mdpanel__list">
          {proposal.changes.map((c) => (
            <li key={c.field} className="mdpanel__row">
              <label>
                <input
                  type="checkbox"
                  checked={chosen.has(c.field)}
                  onChange={(e) => setChosen((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c.field);
                    else next.delete(c.field);
                    return next;
                  })}
                />
                <span className="mdpanel__field">{FIELD_LABEL[c.field] ?? c.field}</span>
                {/* Proposed first: it is the value being decided on, and with
                    most files untagged the old column is mostly "empty", so
                    leading with it pushed the real content off to the right. */}
                <span className="mdpanel__to">{c.proposed}</span>
                <span className="mdpanel__was">
                  {c.current ? <>was <span className="mdpanel__old">{c.current}</span></> : 'was empty'}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="mdpanel__actions">
        <label className="mdpanel__embed">
          <input
            type="checkbox"
            checked={embedArt}
            onChange={(e) => setEmbedArt(e.target.checked)}
          />
          <span>Also embed the cover art</span>
        </label>
        <button
          type="button"
          className="btn btn--primary pressable"
          disabled={chosen.size === 0 && !embedArt}
          onPointerDown={apply}
        >
          Apply to file
        </button>
      </div>
    </div>
  );
}
