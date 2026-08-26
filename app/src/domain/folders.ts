/*
 * Seek — what a local path means for the job it is being asked to do.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The sidecar reports facts about a path — exists, isDirectory, writable, and
 * the same two about its parent — and stops there, deliberately. Whether those
 * facts add up to an acceptable folder depends entirely on what the folder is
 * FOR, and that is a product decision rather than a filesystem one:
 *
 *   a download folder    must be writable — files are created in it
 *   a shared folder      need only be readable; a read-only archive volume is
 *                        a perfectly reasonable thing to offer the network
 *
 * Collapsing that into one boolean in Python would have made a read-only
 * external drive un-shareable, which is precisely the drive most people's
 * collections live on.
 *
 * The second job here is wording. "ENOENT" and "the folder does not exist" are
 * the same fact, but only one of them tells you that the thing to do next is
 * press Create. Every verdict below carries the ACTION as well as the problem.
 */

/** `PathCheck` from the wire, restated (see `data/adapt.ts` on why). */
export interface PathFacts {
  path: string;
  resolved: string;
  exists: boolean;
  isDirectory: boolean;
  writable: boolean;
  parentExists: boolean;
  parentWritable: boolean;
}

export type FolderPurpose = 'download' | 'incomplete' | 'share';

export type FolderTone = 'ok' | 'warn' | 'error' | 'empty';

export interface FolderVerdict {
  /** Whether this path can be saved for this purpose. */
  usable: boolean;
  tone: FolderTone;
  /** One line, written for a person. Empty when there is nothing to say. */
  message: string;
  /** The folder does not exist but could be created here. */
  offerCreate: boolean;
}

const PURPOSE_NAME: Record<FolderPurpose, string> = {
  download: 'Finished downloads go here',
  incomplete: 'Files in progress go here',
  share: 'This folder is offered to other people',
};

/**
 * Note the order. Each branch assumes the ones above it did not fire, which is
 * what keeps the messages specific — "it is not writable" would be a confusing
 * thing to say about a path that is not a folder, and "it does not exist" would
 * be a confusing thing to say about an empty field.
 */
export function judgeFolder(facts: PathFacts | null, purpose: FolderPurpose): FolderVerdict {
  if (facts === null) {
    return { usable: false, tone: 'empty', message: '', offerCreate: false };
  }

  if (facts.resolved === '') {
    return {
      usable: false,
      tone: 'empty',
      message: purpose === 'share' ? '' : 'No folder set.',
      offerCreate: false,
    };
  }

  if (!facts.exists) {
    // A missing folder is only worth an error if nothing can be done about it.
    // Where the parent is writable this is the ordinary case of typing a path
    // for a folder you have not made yet, so it is an offer, not a failure.
    if (facts.parentWritable) {
      return {
        usable: false,
        tone: 'warn',
        message: 'This folder does not exist yet.',
        offerCreate: true,
      };
    }
    return {
      usable: false,
      tone: 'error',
      message: facts.parentExists
        ? 'This folder does not exist, and it cannot be created here.'
        : 'Nothing along this path exists.',
      offerCreate: false,
    };
  }

  if (!facts.isDirectory) {
    return {
      usable: false,
      tone: 'error',
      message: 'That is a file, not a folder.',
      offerCreate: false,
    };
  }

  if (purpose === 'share') {
    // Readability is not separately reported: the sidecar refuses to store an
    // unreadable share, and an existing directory it could stat is readable in
    // every case a person will hit here.
    return { usable: true, tone: 'ok', message: '', offerCreate: false };
  }

  if (!facts.writable) {
    // The macOS cases, which are the ones that actually happen: a read-only
    // volume, or a folder the app has not been granted access to. Neither is
    // visible in the permission bits, which is why the sidecar tests this by
    // writing a file rather than by asking.
    return {
      usable: false,
      tone: 'error',
      message: 'Seek cannot write into this folder. It may be on a read-only '
        + 'volume, or macOS may not have granted access to it yet.',
      offerCreate: false,
    };
  }

  return { usable: true, tone: 'ok', message: '', offerCreate: false };
}

/** The one-line explanation of what a folder setting is for. */
export function folderPurposeHint(purpose: FolderPurpose): string {
  return PURPOSE_NAME[purpose];
}

/**
 * `~/Music/Seek` rather than `/Users/dana/Music/Seek`.
 *
 * Only for display, and only ever alongside the real path being kept — the
 * config stores the expanded form, because upstream expands nothing.
 */
export function tildeAbbreviate(path: string, home: string): string {
  if (!path || !home) return path;
  const trimmedHome = home.replace(/\/+$/, '');
  if (path === trimmedHome) return '~';
  if (path.startsWith(`${trimmedHome}/`)) return `~${path.slice(trimmedHome.length)}`;
  return path;
}

/**
 * The last segment, for a folder chip that has to fit in a row.
 *
 * Falls back to the whole path rather than to an empty string: a chip reading
 * nothing at all is worse than one reading something long.
 */
export function folderLeaf(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Strip the sidecar's error code prefix for display.
 *
 * `sidecarClient` rejects with `"<code>: <message>"` so callers can branch on
 * the code. A settings screen has already decided what to do with the failure
 * and only needs the sentence.
 */
export function readableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const match = /^[a-z_]+: (.+)$/s.exec(text);
  return match ? match[1] : text;
}
