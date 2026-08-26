/*
 * Seek — is what the user just pasted a music URL, and whose?
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Deliberately only a GUESS, and deliberately thin. The sidecar is the authority
 * on what a URL turns out to be: it is the side that makes the request, and it
 * is the only side that can tell a Bandcamp custom domain from any other host —
 * `bleep.bandcamp.com` matches a pattern, `mysterious.label` does not, and both
 * are answered by Bandcamp's oEmbed endpoint.
 *
 * So the split is: this decides whether to ASK (anything that parses as an
 * http(s) URL), and the guessed provider only chooses which icon to show on the
 * skeleton card while the real answer is in flight. Nothing about correctness
 * rests on it, which is why there is no host table to keep in step with the
 * sidecar's.
 */

/** The providers the Dig Bar can recognise on sight. Mirrors WantSource. */
export type UrlProvider = 'youtube' | 'bandcamp' | 'discogs';

export interface UrlGuess {
  /** The URL, trimmed. Safe to hand to the sidecar. */
  url: string;
  /** Null when the host is unfamiliar — still worth asking about. */
  provider: UrlProvider | null;
  /** True when this is an album/release rather than a single track. */
  album: boolean;
  /** True when the URL carries a playlist, which is a Phase D4 concern. */
  playlist: boolean;
  /**
   * The bare playlist id, when the URL names one. Empty otherwise.
   *
   * Extracted here rather than in the sidecar: URL shapes are the frontend's
   * business, and Python is deliberately kept out of the guessing seat.
   */
  playlistId: string;
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'music.youtube.com', 'youtu.be', 'www.youtu.be',
]);

const DISCOGS_HOSTS = new Set(['discogs.com', 'www.discogs.com', 'api.discogs.com']);

/**
 * Is this text a URL at all?
 *
 * Requires an explicit http(s) scheme rather than sniffing for dots, because
 * `Aphex Twin - Windowlicker.flac` contains a dot and is a search query. A user
 * pasting a URL always pastes the scheme; a user typing a query never does.
 */
export function looksLikeUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

/**
 * Classify a pasted string, or null when it is an ordinary search query.
 *
 * A URL on an unrecognised host still returns a guess with `provider: null` —
 * the sidecar tries Bandcamp's endpoint for exactly this case, and refusing to
 * ask would make every custom-domain label page unreachable.
 */
export function guessUrl(text: string): UrlGuess | null {
  const url = text.trim();
  if (!looksLikeUrl(url)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (YOUTUBE_HOSTS.has(host)) {
    /* `RD…` and `UL…` ids are YouTube's auto-generated radio and mixes. They
     * are per-viewer, generated on the fly, and the API refuses them, so
     * treating one as an importable playlist would promise something that
     * cannot be delivered. */
    const list = parsed.searchParams.get('list') ?? '';
    const importable = list !== '' && !/^(RD|UL)/.test(list);
    return {
      url,
      provider: 'youtube',
      album: false,
      // `list=` on a /watch URL means the video sits in a playlist, which is
      // not the same as the user meaning to import one. Both are D4's problem.
      playlist: parsed.searchParams.has('list') || path.startsWith('/playlist'),
      playlistId: importable ? list : '',
    };
  }

  if (DISCOGS_HOSTS.has(host)) {
    return {
      url,
      provider: 'discogs',
      album: /\/(release|master)\//.test(path),
      playlist: false,
      playlistId: '',
    };
  }

  if (host === 'bandcamp.com' || host.endsWith('.bandcamp.com')) {
    return {
      url,
      provider: 'bandcamp',
      album: path.startsWith('/album/'),
      playlist: false,
      playlistId: '',
    };
  }

  // An unfamiliar host. Ask anyway — it may be a Bandcamp custom domain.
  return { url, provider: null, album: false, playlist: false, playlistId: '' };
}

/** How the provider is named on the preview card. */
export const PROVIDER_LABEL: Record<UrlProvider, string> = {
  youtube: 'YouTube',
  bandcamp: 'Bandcamp',
  discogs: 'Discogs',
};
