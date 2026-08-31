/*
 * Seek — what a transfer's state means, said in a sentence.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * WHY THIS EXISTS: DownloadsView rendered `state.replace(/_/g, ' ')`, so a
 * queue of stalled downloads read "unknown", "user logged off", "connection
 * closed" — enum identifiers with the underscores knocked out. None of them
 * answer the only question a stalled download raises, which is *is this ever
 * going to finish, and is there anything I can do*.
 *
 * The states divide three ways, and the wording has to make the difference
 * obvious at a glance, because the right response to each is different:
 *
 *   WAITING     it is working, leave it alone        queued, getting_status
 *   REFUSED     they said no; retrying will not help rejected (mostly)
 *   BROKEN      something went wrong; retry may work connection_*, *_error
 *
 * `error` carries the peer's own words for a refusal and is the only copy of
 * them — see TransferState in the schema. Known reject reasons are recognised
 * here rather than passed through raw, because "File not shared." is protocol
 * vocabulary, not a sentence anyone wrote for a person to read.
 */

export type TransferTone = 'active' | 'waiting' | 'refused' | 'broken' | 'done';

export interface TransferStatusLine {
  /** One line, for a person. Never an enum identifier. */
  text: string;
  tone: TransferTone;
  /** Whether pressing Retry could plausibly change the outcome. */
  retryable: boolean;
}

/**
 * The refusals a peer can send, in their own words.
 *
 * From `TransferRejectReason` in upstream's slskmessages.py. Upstream writes
 * these directly into `transfer.status`, so they arrive as the failure text
 * rather than as a state — which is exactly why they used to read "unknown".
 *
 * `retryable` is the useful half. "Banned" will still be banned in an hour;
 * "Pending shutdown." is someone closing their client, and the file may well be
 * there tomorrow.
 */
const REJECTIONS: Record<string, { text: string; retryable: boolean }> = {
  'File not shared.': {
    text: 'They are no longer sharing this file', retryable: false,
  },
  'File read error.': {
    text: 'They could not read the file from their disk', retryable: true,
  },
  Banned: {
    text: 'This person has banned you', retryable: false,
  },
  'Pending shutdown.': {
    text: 'They are shutting down — try again later', retryable: true,
  },
  'Too many files': {
    text: 'Their queue is full', retryable: true,
  },
  'Too many megabytes': {
    text: 'Their queue is full', retryable: true,
  },
  'Disallowed extension': {
    text: 'They do not send this type of file', retryable: false,
  },
  Complete: {
    text: 'They say you already have it', retryable: false,
  },
};

/**
 * One line for a whole release, so the list says WHY without being opened.
 *
 * A group is many files and they are rarely in the same state. The order below
 * is not "most common", it is MOST WORTH KNOWING — a refusal never resolves on
 * its own and should be read before a queue position that will:
 *
 *   1. refused    they said no; the group is going nowhere until you act
 *   2. stalled    moving once, silent now
 *   3. paused     you did that
 *   4. waiting    queued, and where in the queue
 *   5. active     nothing — the progress bar already says it, and repeating
 *                 "Downloading" beside a moving bar is noise
 *
 * Returns null when there is nothing worth saying, which is the common case
 * for a healthy download and for a finished one.
 */
export function groupStatus(transfers: Array<Parameters<typeof transferStatus>[0]>):
TransferStatusLine | null {
  if (transfers.length === 0) return null;

  const lines = transfers
    .filter((t) => t.state !== 'finished')
    .map(transferStatus);
  if (lines.length === 0) return null;

  const byTone = (tone: TransferTone) => lines.find((l) => l.tone === tone);

  const refused = byTone('refused');
  if (refused) return countedLine(refused, lines);

  const broken = byTone('broken');
  if (broken) return countedLine(broken, lines);

  const waiting = byTone('waiting');
  if (waiting) return waiting;

  // Everything left is moving. The bar says so better than words.
  return null;
}

/**
 * "They refused" reads as the whole release when it was one file of twelve.
 * Counting is the difference between a release you should give up on and one
 * with a single bad track in it.
 */
function countedLine(line: TransferStatusLine, all: TransferStatusLine[]): TransferStatusLine {
  const same = all.filter((l) => l.text === line.text).length;
  // Only when it is PARTIAL. `same === all.length` covers the lone-file case
  // too, since one of one is not a fraction worth printing.
  if (same === all.length) return line;
  return { ...line, text: `${line.text} (${same} of ${all.length})` };
}

/**
 * Queue position, worded so the number means something.
 *
 * `queuePosition` is null both for "not queued" and "queued but they have not
 * said where" — upstream collapses both to 0. Those are different sentences: a
 * queue with no number is still a queue, and saying so beats saying nothing.
 */
function queuedText(position: number | null): string {
  if (position === null) return 'Waiting in their queue';
  return `Waiting in their queue — number ${position}`;
}

export function transferStatus(t: {
  state: string;
  error: string | null;
  queuePosition: number | null;
  stalled: boolean;
  bytesDone: number;
}): TransferStatusLine {
  switch (t.state) {
    case 'transferring':
      // A transfer that has stopped moving is not the same as one that is
      // moving slowly, and the difference is invisible in a speed of 0.
      return t.stalled
        ? { text: 'Stalled — nothing received for a while', tone: 'broken', retryable: true }
        : { text: 'Downloading', tone: 'active', retryable: false };

    case 'queued':
      return { text: queuedText(t.queuePosition), tone: 'waiting', retryable: false };

    case 'getting_status':
      return { text: 'Asking them for the file…', tone: 'waiting', retryable: false };

    case 'finished':
      return { text: 'Finished', tone: 'done', retryable: false };

    case 'paused':
      return { text: 'Paused', tone: 'waiting', retryable: false };

    case 'cancelled':
      return { text: 'Cancelled', tone: 'broken', retryable: true };

    case 'filtered':
      return {
        text: 'Skipped by your download filter', tone: 'broken', retryable: false,
      };

    case 'rejected': {
      const known = t.error ? REJECTIONS[t.error] : undefined;
      if (known) return { ...known, tone: 'refused' };
      // Free text. Peers send their own strings — upstream itself special-cases
      // anything starting "User limit of". Quote it rather than paraphrase: it
      // is a stranger's words, and guessing at the meaning would be inventing.
      return {
        text: t.error ? `They refused: ${t.error}` : 'They refused the request',
        tone: 'refused',
        retryable: true,
      };
    }

    case 'user_logged_off':
      return {
        // The single most common reason a download sits still, and the one the
        // old wording ("user logged off") stated most coldly.
        text: 'They are offline — it will resume when they return',
        tone: 'waiting',
        retryable: false,
      };

    case 'connection_closed':
      return {
        text: t.bytesDone > 0
          ? 'The connection dropped part-way'
          : 'They did not answer',
        tone: 'broken',
        retryable: true,
      };

    case 'connection_timeout':
      return { text: 'They did not answer in time', tone: 'broken', retryable: true };

    case 'download_folder_error':
      return {
        text: 'Seek could not write to your download folder',
        tone: 'broken',
        retryable: true,
      };

    case 'local_file_error':
      return {
        text: 'Seek could not write the file', tone: 'broken', retryable: true,
      };

    case 'unknown':
    default:
      // Upstream genuinely had no status: a restored transfer whose saved row
      // predates the field. Retry is the only thing that resolves it, so say
      // that rather than printing the word "unknown" at someone.
      return {
        text: 'Not started — press Retry to ask again',
        tone: 'waiting',
        retryable: true,
      };
  }
}

/** Every state that means the transfer is not going to progress on its own. */
export function needsAttention(line: TransferStatusLine): boolean {
  return line.tone === 'broken' || line.tone === 'refused';
}
