/*
 * Seek — the release's own checksum file, read back to you.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The evidence behind the badge, for the same reason `Spectrum.tsx` exists: a
 * verdict you cannot check is a rumour. Every line the sidecar claimed is
 * here, in the order that puts problems first.
 *
 * The one thing this panel must never do is let an .md5 mismatch and an .ffp
 * mismatch look alike — see the note at the top of `domain/checksums.ts`. Each
 * row says which kind of claim it is, and the tone comes from the kind.
 */

import {
  KIND_LABEL, explainEntry, labelOfEntry, orderedEntries, summarise, toneOfEntry,
} from '../domain/checksums.ts';
import type { ChecksumReport } from '../../../shared/protocol.ts';

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

export function ChecksumPanel({ report }: { report: ChecksumReport }) {
  const s = summarise(report);
  const entries = orderedEntries(report);

  return (
    <figure className="cks" data-tone={s.tone}>
      <figcaption className="cks__cap">
        <span className="cks__headline" data-tone={s.tone}>{s.headline}</span>
        {report.sidecars.length > 0 && (
          <span className="cks__meta">
            {report.sidecars.map((c) => baseName(c.path)).join(', ')}
          </span>
        )}
        {s.unparsedLines > 0 && (
          <span className="cks__meta" title="Lines we could not read as a name and a digest. Reported rather than ignored, so a half-understood file cannot look like a clean one.">
            {s.unparsedLines} unreadable {s.unparsedLines === 1 ? 'line' : 'lines'}
          </span>
        )}
      </figcaption>

      {s.none ? (
        <p className="cks__note">
          Most releases ship without one. Nothing is wrong — there is simply no
          published digest to check these files against.
        </p>
      ) : (
        <ul className="cks__list">
          {entries.map((e) => {
            const tone = toneOfEntry(e);
            return (
              <li className="cks__row" key={`${e.kind}:${e.name}`} data-tone={tone}>
                <span className="cks__name" title={e.localPath || e.name}>
                  {baseName(e.name)}
                </span>
                <span className="cks__kind">{KIND_LABEL[e.kind]}</span>
                <span className="cks__verdict" data-tone={tone}>
                  {labelOfEntry(e)}
                </span>
                <span className="cks__why">{explainEntry(e)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Said once, at the bottom, rather than on every green row. A passing
          fingerprint is a strong result and this is its one limit. */}
      {s.matched > 0 && (
        <p className="cks__note">
          A fingerprint is compared against the one the file carries in its own
          header, so a match proves the audio is the same — not that every
          compressed frame survived the trip.
        </p>
      )}
    </figure>
  );
}
