/*
 * Seek — turn a video/track title into artist and title, with confidence.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The sibling of `parsePath.ts`, and it obeys the same rule: NEVER INVENT. A
 * title we do not trust comes back with a low confidence and the raw string
 * intact, so the Dig Bar can show the original prominently and offer the parse
 * as a suggestion. A confident wrong parse is worse than an unconfident right
 * one, because the preview card lets the user correct the second and hides the
 * first.
 *
 * This lives in TypeScript, not the sidecar, for the reason in AGENTS.md's
 * "seam": Python emits raw provider facts and derives nothing. The sidecar
 * forwards what YouTube's oEmbed endpoint said; deciding what it MEANS happens
 * here, next to `parsePath.ts`, sharing `text.ts` and one test suite.
 *
 * Bandcamp and Discogs need none of this — both return structured artist and
 * title. This exists for YouTube, where the only metadata is a free-text title
 * a human typed.
 */

import { fuzzyKey, normaliseDashes, squash, trimEdges } from './text.ts';

/** Below this a parse is a suggestion, not a fact. Mirrors parsePath.ts. */
export const TITLE_CONFIDENCE_FLOOR = 0.5;

/**
 * How the artist and title were arrived at. Shown as one line of caption text
 * on the preview card, because "where did this come from" is the question a
 * user asks the moment a parse looks wrong.
 */
export type TitleSource =
  /** An unambiguous separator: `Artist - Title`. */
  | 'separator'
  /** `Artist "Title"` — a convention, and a reliable one. */
  | 'quoted'
  /** `Artist: Title`. */
  | 'colon'
  /** `Artist, Title` — real, but weak enough that the card hedges it. */
  | 'comma'
  /** `Title by Artist`. */
  | 'reversed'
  /** A podcast/series episode code: `RA.823 DJ Name`. */
  | 'series'
  /** A DJ set billing: `DJ Name / August 23 / Berlin`. */
  | 'billing'
  /** No separator, but the uploading channel names an artist. */
  | 'channel'
  /** Nothing recognisable. `title` is the whole string. */
  | 'raw';

export interface ParsedTitle {
  /** The string exactly as the provider sent it. Never modified. */
  raw: string;
  /** Empty when no artist could be recovered — never a guess. */
  artist: string;
  /** Never empty: falls back to the cleaned raw title. */
  title: string;
  /** Album hint from a three-part `Artist - Album - Title` split. */
  album: string | null;
  /** A label lifted out of a trailing `[Bracket]`, when it is not a version. */
  label: string | null;
  /** 0..1. Below TITLE_CONFIDENCE_FLOOR, show `raw` and offer this. */
  confidence: number;
  from: TitleSource;
}

export interface ParseTitleOptions {
  /**
   * The uploading channel (`author_name` from oEmbed). Load-bearing in two
   * ways: it disambiguates `Boiler Room - DJ Name - Live Set` by identifying
   * the first segment as uploader branding rather than an artist, and it is
   * the fallback artist for VEVO and official artist channels.
   */
  channel?: string;
  /**
   * True for `music.youtube.com`, which enforces `Artist - Title` rather than
   * leaving it to whoever typed the title.
   */
  enforced?: boolean;
}

/* --------------------------------------------------------------- furniture */

/**
 * Bracketed or parenthesised noise. Stripped from the title because none of it
 * helps find the record on Soulseek.
 *
 * Deliberately a list of specific phrases rather than "strip all brackets":
 * `(Ricardo Villalobos Remix)`, `(feat. Burial)` and `[Hyperdub]` are all
 * load-bearing, and a blanket strip would eat the remix name — which for a DJ
 * is the difference between two different records.
 */
const NOISE = new RegExp(
  '[([]\\s*(?:'
  + 'official\\s*(?:music\\s*|lyrics?\\s*)?(?:video|audio|visuali[sz]er)?'
  + '|(?:music|lyrics?|dance|performance)\\s*video'
  + '|visuali[sz]er|audio\\s*only|audio|full\\s*stream'
  + '|hd|hq|uhd|4k|8k|1080p?|720p?|full\\s*hd'
  + '|free\\s*(?:download|dl)|out\\s*now|premiere|exclusive|teaser|trailer'
  + '|lyrics?|with\\s*lyrics|subtitulado|legendado'
  + ')\\s*[)\\]]',
  'gi',
);

/**
 * What follows a comma when the comma is punctuation rather than a separator.
 * `Untitled, Pt. 2` and `Kid A, Vol. 1` are one title; a lowercase opener means
 * the sentence simply continued.
 */
const CONTINUATION_WORD =
  /^(pt\.?|part|vol\.?|volume|no\.?|nos?\.?|disc|disk|cd|side|book|chapter|act)\b/i;

function looksLikeContinuation(text: string): boolean {
  // The lowercase test is deliberately case-SENSITIVE and separate from the
  // word list above, which is case-insensitive. Folding them together makes
  // `[a-z]` match `Archangel` too, and the rule stops working entirely.
  return CONTINUATION_WORD.test(text) || /^[a-z]/.test(text);
}

/** A trailing bracket that is a version, not a label. Stays in the title. */
const VERSIONISH =
  /\b(mix|remix|rmx|edit|version|dub|vip|instrumental|acapella|extended|radio|club|live|remaster(ed)?|reprise|bootleg|refix|rework|flip)\b/i;

/**
 * `RA.823`, `RA823`, `Truancy Volume 250`, `Dekmantel Podcast 300`, `XLR8R 542`.
 * The number is the episode; whatever follows it is the guest.
 */
const SERIES_CODE =
  /^([A-Za-zÀ-ÿ][\wÀ-ÿ]*(?:[.\s](?:podcast|volume|vol|mix|session|show|episode|ep))?[.\s#]?\d{1,4})\s+(.{2,})$/i;

/**
 * Series and residency channels that brand the first segment of their titles.
 * Only consulted when the channel name is unknown — when we have it, matching
 * against it is both more general and more honest than a list we maintain.
 */
const SERIES_CHANNELS = new Set([
  'boiler room', 'hor', 'hor berlin', 'resident advisor', 'ra',
  'dekmantel', 'cercle', 'mixmag', 'nts', 'nts radio', 'rinse',
  'rinse fm', 'fabric', 'awakenings', 'sonar', 'movement', 'dj mag',
  'crack magazine', 'the lot radio', 'kiosk radio', 'refuge worldwide',
  'truants', 'truancy volume', 'xlr8r', 'fact magazine', 'beatport',
  'keep hush', 'sable radio', 'lyl radio', 'threads radio',
]);

/** VEVO, `- Topic`, and "… Official" channels are the artist, not a series. */
function channelNamesAnArtist(channel: string): boolean {
  return /(?:vevo|\bofficial\b|\s-\s*topic)\s*$/i.test(channel.trim());
}

/** Strip the leading track number off `01. Artist - Title`. */
function stripTrackNumber(text: string): string {
  // Requires punctuation or a following separator, so `2 Unlimited - No Limit`
  // and `4 Hero - Mr Kirk` keep their numbers: those are names, not indices.
  const punctuated = text.match(/^\d{1,3}\s*[.)\]]\s*(.+)$/);
  if (punctuated) return punctuated[1];
  const dashed = text.match(/^\d{1,3}\s*[-–—]\s*(.+[-–—].+)$/);
  if (dashed) return dashed[1];
  return text;
}

/** Remove noise, then tidy the edges. Interior punctuation is untouched. */
function clean(text: string): string {
  return trimEdges(squash(text.replace(NOISE, ' ')));
}

/** Pull a trailing `[Hyperdub]` out as a label, leaving a version in place. */
function liftLabel(title: string): { title: string; label: string | null } {
  const match = title.match(/^(.*\S)\s*\[([^[\]]{2,40})\]\s*$/);
  if (!match) return { title, label: null };
  const candidate = match[2].trim();
  if (VERSIONISH.test(candidate)) return { title, label: null };
  return { title: trimEdges(match[1]), label: candidate };
}

/**
 * `VA - Title (Someone Remix)` names its real artist inside the parenthetical.
 * Lift it out rather than searching Soulseek for "VA".
 */
function artistFromRemix(title: string): string | null {
  const match = title.match(/[([]\s*([^()[\]]{2,60}?)\s+(?:remix|rmx|edit|rework|refix|flip|bootleg|vip)\s*[)\]]/i);
  return match ? trimEdges(match[1]) : null;
}

const VARIOUS = /^(va|v\.?a\.?|various(\s+artists)?|unknown(\s+artist)?)$/i;

/* ------------------------------------------------------------------ parser */

/**
 * Best-effort artist/title from a free-text title.
 *
 * Never throws and never returns an empty `title` — a caller with a string
 * always gets something searchable back, plus a confidence saying how much to
 * trust it.
 */
export function parseTitle(raw: string, options: ParseTitleOptions = {}): ParsedTitle {
  const original = raw ?? '';
  const channel = (options.channel ?? '').trim();

  const base: ParsedTitle = {
    raw: original,
    artist: '',
    title: clean(original) || squash(original),
    album: null,
    label: null,
    confidence: 0.2,
    from: 'raw',
  };
  if (!squash(original)) return { ...base, title: '' };

  let text = clean(normaliseDashes(original));
  text = stripTrackNumber(text);

  /* Uploader branding first. `Boiler Room - DJ Name - Live Set` is a
   * three-part title whose first part is not an artist at all, and the channel
   * name is what proves it — no maintained list of series can keep up with
   * every residency, but every one of them uploads under its own name. */
  const segments = text.split(/\s+[-–—]\s+/).map(trimEdges).filter(Boolean);
  if (segments.length > 1 && isUploaderBranding(segments[0], channel)) {
    return ensureTitle(
      branded(base, segments[0], segments.slice(1).join(' - '), options), base,
    );
  }

  return ensureTitle(withoutBranding(base, text, segments, options), base);
}

/**
 * A caller that handed us a string always gets something searchable back.
 *
 * Cleaning can legitimately empty a title — `(Official Video)` is entirely
 * noise, and `-` is entirely separator — and an empty title would render as a
 * blank preview card with a Search button that searches for nothing.
 */
function ensureTitle(parsed: ParsedTitle, base: ParsedTitle): ParsedTitle {
  if (parsed.title.trim()) return parsed;
  return { ...parsed, title: base.title, confidence: Math.min(parsed.confidence, 0.2) };
}

/** Does this segment name the uploader rather than a musician? */
function isUploaderBranding(segment: string, channel: string): boolean {
  const key = fuzzyKey(segment);
  if (!key) return false;
  if (channel) {
    const channelKey = fuzzyKey(channel);
    // `HÖR` uploading `HÖR - DJ Name / …`, or a channel whose name merely
    // starts the title (`Boiler Room` vs `Boiler Room Berlin`).
    if (channelKey && (channelKey === key
      || channelKey.startsWith(`${key} `) || key.startsWith(`${channelKey} `))) {
      // …unless the channel IS the artist, as on VEVO and artist channels,
      // where `Burial - Archangel` on the Burial channel is a real credit.
      return !channelNamesAnArtist(channel);
    }
  }
  return SERIES_CHANNELS.has(key);
}

/** Re-parse the remainder after dropping uploader branding. */
function branded(
  base: ParsedTitle, branding: string, rest: string, options: ParseTitleOptions,
): ParsedTitle {
  // Parse the remainder with the channel withheld, so the branding rule cannot
  // fire twice and strip a real artist on a `Series - Artist - Title` layout.
  const inner = parseTitle(rest, { ...options, channel: undefined });

  /* `Dekmantel Podcast - Call Super` and `Boiler Room - Ben UFO`: once the
   * branding is gone, what is left has no separator because it is not a track
   * at all — it is the guest's name. Reading it as a title would search
   * Soulseek for the words "Call Super" with no artist, which is the one thing
   * we know is wrong. The series becomes the title, exactly as it does in the
   * `RA.823 Guest` form. */
  if (inner.from === 'raw' && inner.title.trim()) {
    return {
      ...base,
      artist: inner.title,
      title: branding,
      confidence: 0.5,
      from: 'series',
    };
  }

  return {
    ...inner,
    raw: base.raw,
    // A parse that needed branding removed is one inference deeper than a
    // plain `Artist - Title`, so it does not get to claim the same confidence.
    confidence: Math.min(inner.confidence, 0.8),
  };
}

function withoutBranding(
  base: ParsedTitle, text: string, segments: string[], options: ParseTitleOptions,
): ParsedTitle {
  /* ---- the dash forms, which are most of real life ---- */
  if (segments.length >= 2) {
    const artist = segments[0];
    // Four or more segments is not a structure anyone means; treat everything
    // after the first as the title rather than inventing an album.
    const album = segments.length === 3 ? segments[1] : null;
    const title = segments.length === 3
      ? segments[2]
      : segments.slice(1).join(' - ');

    const lifted = liftLabel(title);
    const out: ParsedTitle = {
      ...base,
      artist,
      title: lifted.title || title,
      album,
      label: lifted.label,
      // YouTube Music enforces this shape; elsewhere a human typed it.
      confidence: options.enforced ? 0.95 : segments.length === 2 ? 0.9 : 0.8,
      from: 'separator',
    };
    return resolveVarious(out);
  }

  /* ---- quoted: `Artist "Title"` ---- */
  const quoted = text.match(/^(.{2,}?)\s*['"“‘]([^'"”’]{2,})['"”’]\s*$/);
  if (quoted) {
    const lifted = liftLabel(trimEdges(quoted[2]));
    return resolveVarious({
      ...base,
      artist: trimEdges(quoted[1]),
      title: lifted.title,
      label: lifted.label,
      confidence: 0.85,
      from: 'quoted',
    });
  }

  /* ---- `Artist, Title` ----
   *
   * A real convention — the Hyperdub channel uses it — and a dangerous one,
   * because a comma is also ordinary punctuation: `Untitled, Pt. 2` and
   * `Amsterdam, 1997` are single titles. So it is guarded, and it earns barely
   * more than the floor: enough to prefill the card, not enough to assert.
   */
  const comma = text.match(/^([^,]{2,60}),\s+([^,]{2,})$/);
  if (comma && !looksLikeContinuation(comma[2])) {
    const lifted = liftLabel(trimEdges(comma[2]));
    return resolveVarious({
      ...base,
      artist: trimEdges(comma[1]),
      title: lifted.title,
      label: lifted.label,
      confidence: 0.55,
      from: 'comma',
    });
  }

  /* ---- a series episode code: `RA.823 DJ Name` ---- */
  const series = text.match(SERIES_CODE);
  if (series) {
    return {
      ...base,
      artist: trimEdges(series[2]),
      title: trimEdges(series[1]),
      confidence: 0.6,
      from: 'series',
    };
  }

  /* ---- a DJ set billing: `DJ Name / August 23 / Berlin` ---- */
  const billing = text.split(/\s*\/\s*/).map(trimEdges).filter(Boolean);
  if (billing.length >= 2 && billing[0].length >= 2) {
    return {
      ...base,
      artist: billing[0],
      title: billing.slice(1).join(' '),
      // Deliberately under the floor. The date and city are not a track title,
      // and the user should see the original and decide what to search for.
      confidence: 0.45,
      from: 'billing',
    };
  }

  /* ---- `Artist: Title`, only when no dash offered itself first ---- */
  const colon = text.match(/^([^:]{2,60}):\s+(.{2,})$/);
  if (colon) {
    const lifted = liftLabel(trimEdges(colon[2]));
    return resolveVarious({
      ...base,
      artist: trimEdges(colon[1]),
      title: lifted.title,
      label: lifted.label,
      confidence: 0.75,
      from: 'colon',
    });
  }

  /* ---- `Title by Artist` ---- */
  const byParts = text.split(/\s+by\s+/i);
  if (byParts.length === 2 && byParts[0].length >= 2 && byParts[1].length >= 2) {
    return resolveVarious({
      ...base,
      artist: trimEdges(byParts[1]),
      title: trimEdges(byParts[0]),
      // "by" is a real English word as well as a separator, so this earns less
      // trust than punctuation does: `Song by the River` is a title.
      confidence: 0.65,
      from: 'reversed',
    });
  }

  /* ---- nothing separable. The channel may still name the artist ---- */
  const channel = (options.channel ?? '').trim();
  if (channel && channelNamesAnArtist(channel)) {
    return {
      ...base,
      // Strip the channel's own suffix: `BurialVEVO` is not how anyone is credited.
      artist: trimEdges(channel.replace(/(?:vevo|\s-\s*topic)\s*$/i, '')),
      title: text,
      confidence: 0.5,
      from: 'channel',
    };
  }

  return { ...base, title: text, confidence: 0.2, from: 'raw' };
}

/**
 * `VA - Title (Someone Remix)` — a compilation credit is not an artist, and
 * searching Soulseek for "VA" returns the whole network. Prefer the remixer.
 */
function resolveVarious(parsed: ParsedTitle): ParsedTitle {
  if (!VARIOUS.test(parsed.artist)) return parsed;
  const remixer = artistFromRemix(parsed.title);
  if (remixer) {
    return { ...parsed, artist: remixer, confidence: Math.min(parsed.confidence, 0.7) };
  }
  // No remixer to fall back on: say we do not know rather than search for "VA".
  return { ...parsed, artist: '', confidence: Math.min(parsed.confidence, 0.4) };
}

/**
 * The Soulseek query a parse implies. Album-level entries search the album,
 * because the unit a DJ downloads is a folder (docs/PRODUCT.md §4).
 */
export function searchQuery(parsed: Pick<ParsedTitle, 'artist' | 'title'>): string {
  return squash(`${parsed.artist} ${parsed.title}`);
}
