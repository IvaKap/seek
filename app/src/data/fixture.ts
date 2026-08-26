/*
 * Seek — a recorded search session, synthesised deterministically.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * `fixtures/` (owned by the core agent) did not exist when this was written, and
 * AGENTS.md is explicit that app must not wait on core. So this generates its
 * own. When core's recording lands, `data/adapt.ts` should be the only file that
 * needs to change.
 *
 * The whole point of a fixture is to be HARDER than the happy path, so this
 * deliberately produces:
 *   - the two disjoint attribute sets (RECON.md §4), never both at once;
 *   - files with NO attributes at all, which older clients really do send;
 *   - lossy files whose size contradicts their advertised bitrate;
 *   - "FLAC" files far too small to be lossless;
 *   - nine different path conventions, including ones that cannot be parsed;
 *   - peers that are fast and free, and peers with 60 people queued.
 *
 * Deterministic: same seed, same session, so motion work is reproducible.
 */

import type { WireFile, WireSearchResult } from '../domain/types.ts';

/** mulberry32 — small, fast, and stable across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ARTISTS = [
  'Burial', 'Aphex Twin', 'Actress', 'Objekt', 'Floating Points', 'Jeff Mills',
  'Marcel Dettmann', 'Levon Vincent', 'Moodymann', 'Theo Parrish', 'Surgeon',
  'Autechre', 'Boards of Canada', 'Four Tet', 'Andres', 'DJ Koze', 'Skee Mask',
  'Call Super', 'Peverelist', 'Shackleton', 'Basic Channel', 'Maurizio',
  'Donato Dozzy', 'Voices From The Lake', 'Nathan Fake', 'Pearson Sound',
  'Batu', 'Overmono', 'Bruce', 'Rrose', 'Anthony Naples', 'DJ Python',
  'Huerco S.', 'Sky H1', 'Upsammy', 'Parris', 'Loraine James', 'Beatrice Dillon',
  '2 Bad Mice', '808 State', '4hero', 'LTJ Bukem', 'Photek', 'Source Direct',
];

const RELEASES = [
  ['Untrue', 2007], ['Selected Ambient Works 85-92', 1992], ['Splazsh', 2010],
  ['Flatland', 2014], ['Elaenia', 2015], ['Waveform Transmission Vol. 1', 1992],
  ['Dettmann', 2010], ['Fabric 63', 2012], ['Silence In The Secret Garden', 1998],
  ['First Floor', 1998], ['Balance', 2000], ['Tri Repetae', 1995],
  ['Music Has The Right To Children', 1998], ['Rounds', 2003], ['New For U', 2012],
  ['Amygdala', 2013], ['Compro', 2018], ['Suzi Ecto', 2014], ['Jarvik Mindstate', 2013],
  ['Music For Real Airports', 2010], ['BCD', 1995], ['M-Series', 1997],
  ['K', 2011], ['Lentamente', 2012], ['Drowning In A Sea Of Love', 2006],
  ['Alien Jams', 2019], ['Zeros', 2016], ['Everything Ecstatic', 2005],
  ['For Those Of You Who Have Never', 2016], ['Fabric 91', 2016],
];

const TITLES = [
  'Archangel', 'Xtal', 'Ghost Hardware', 'Untitled', 'Rainfall', 'Tempest',
  'Agnes Revenge', 'Silhouettes', 'The Bells', 'Man Or Mistress', 'Music People',
  'Badger Bite', 'Gantz Graf', 'Windowlicker', 'Bombscare', 'Pacific State',
  'Nuclear Sun', 'Cascade', 'Interlock', 'Second Sight', 'Mercurial',
  'Low Pressure', 'Night Bus', 'Deep Water', 'Halogen', 'Slow Motion',
  'Grey Area', 'Concrete', 'Stanza', 'Vantage', 'Hollow Point', 'Drift',
  'Reflex', 'Signal Path', 'Undertow', 'Meridian', 'Static Bloom', 'Kestrel',
  'Ferrous', 'Copper Line', 'Terminus', 'Dawn Chorus', 'Aphelion', 'Sable',
];

const VERSIONS = [
  '', '', '', '', '', '', ' (Original Mix)', ' (Four Tet Remix)',
  ' (Ricardo Villalobos Remix)', ' (Dub)', ' (Extended Mix)', ' (VIP)',
  ' (Instrumental)', ' (Live)',
];

const LABELS = ['HDBLP', 'WARP', 'PAN', 'TRESOR', 'NS', 'OSTGUT', 'HDB', 'RS', 'BC', 'MORD'];
const GROUPS = ['XXL', 'DEF', 'JUST', 'WAV', 'MTD', 'FKN'];
const USER_NAMES = [
  'vinyljunkie', 'technoheadz', 'dusty_crates', 'sub_bass_99', 'analogdreams',
  'kraut_rock', 'nightbus', 'lowend_theory', 'basschat', 'wax_addict',
  'modular_mike', 'deepcuts', 'rave_archive', 'tapedeck', 'the_selector',
  'coldstorage', 'ambient_af', 'grime_time', 'four_to_floor', 'dubplate',
];

type FormatSpec = {
  ext: string;
  lossless: boolean;
  bitrate: number | null;
  vbr: boolean | null;
  sampleRate: number | null;
  bitDepth: number | null;
  /** Relative likelihood. */
  weight: number;
};

/**
 * The two disjoint attribute sets, exactly as clients send them: lossless gets
 * duration + sampleRate + bitDepth; lossy gets bitrate + duration + vbr.
 */
const FORMATS: FormatSpec[] = [
  { ext: 'flac', lossless: true, bitrate: null, vbr: null, sampleRate: 44100, bitDepth: 16, weight: 26 },
  { ext: 'flac', lossless: true, bitrate: null, vbr: null, sampleRate: 96000, bitDepth: 24, weight: 3 },
  { ext: 'wav', lossless: true, bitrate: null, vbr: null, sampleRate: 44100, bitDepth: 16, weight: 5 },
  { ext: 'aiff', lossless: true, bitrate: null, vbr: null, sampleRate: 44100, bitDepth: 16, weight: 3 },
  { ext: 'mp3', lossless: false, bitrate: 320, vbr: false, sampleRate: null, bitDepth: null, weight: 24 },
  { ext: 'mp3', lossless: false, bitrate: 245, vbr: true, sampleRate: null, bitDepth: null, weight: 10 },
  { ext: 'mp3', lossless: false, bitrate: 256, vbr: false, sampleRate: null, bitDepth: null, weight: 7 },
  { ext: 'mp3', lossless: false, bitrate: 192, vbr: false, sampleRate: null, bitDepth: null, weight: 8 },
  { ext: 'mp3', lossless: false, bitrate: 128, vbr: false, sampleRate: null, bitDepth: null, weight: 4 },
  { ext: 'm4a', lossless: false, bitrate: 256, vbr: false, sampleRate: null, bitDepth: null, weight: 2 },
];

const FORMAT_TOTAL = FORMATS.reduce((a, f) => a + f.weight, 0);

function pickFormat(r: () => number): FormatSpec {
  let n = r() * FORMAT_TOTAL;
  for (const f of FORMATS) {
    n -= f.weight;
    if (n <= 0) return f;
  }
  return FORMATS[0];
}

const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length) % xs.length];
const chance = (r: () => number, p: number): boolean => r() < p;

const pad2 = (n: number) => String(n).padStart(2, '0');
const lc = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export interface FixtureOptions {
  seed?: number;
  /** Roughly how many files the whole session should contain. */
  targetFiles?: number;
  /** How long the session takes to stream in, ms. */
  durationMs?: number;
}

export interface RecordedResponse {
  /** Milliseconds after search start. */
  at: number;
  response: Omit<WireSearchResult, 'searchId'>;
}

export interface RecordedSession {
  query: string;
  responses: RecordedResponse[];
  totalFiles: number;
}

/**
 * Build one file. `mode` forces the awkward shapes so they are guaranteed to be
 * present rather than left to chance.
 */
function makeFile(
  r: () => number,
  mode: 'normal' | 'no-attrs' | 'transcode' | 'fake-lossless',
): WireFile {
  const fmt = mode === 'fake-lossless'
    ? FORMATS[0]
    : mode === 'transcode'
      ? FORMATS[4]
      : pickFormat(r);

  const artist = pick(r, ARTISTS);
  const [release, year] = pick(r, RELEASES) as [string, number];
  const title = pick(r, TITLES) + pick(r, VERSIONS);
  const track = 1 + Math.floor(r() * 12);
  const duration = 150 + Math.floor(r() * 420);
  const label = pick(r, LABELS);
  const cat = `${label}${pad2(1 + Math.floor(r() * 400))}`;
  const share = `@@${Math.floor(r() * 1e6).toString(36)}`;
  const fmtTag = fmt.lossless ? fmt.ext.toUpperCase() : String(fmt.bitrate);
  const vinyl = `${'ABCD'[Math.floor(r() * 4)]}${1 + Math.floor(r() * 3)}`;

  /* ---- size, derived from the format so the physics check has real input ---- */
  let size: number;
  if (fmt.lossless) {
    const pcm = ((fmt.sampleRate ?? 44100) * (fmt.bitDepth ?? 16) * 2 * duration) / 8;
    // Real FLAC lands around 50–70% of PCM. A fake one is a renamed MP3.
    size = mode === 'fake-lossless'
      ? Math.round((320 * 1000 * duration) / 8)
      : Math.round(pcm * (0.5 + r() * 0.2));
  } else {
    const trueRate = mode === 'transcode' ? 150 + Math.floor(r() * 45) : (fmt.bitrate ?? 320);
    size = Math.round((trueRate * 1000 * duration) / 8) + Math.floor(r() * 90_000);
  }

  /* ---- path convention ---- */
  const style = Math.floor(r() * 100);
  let path: string;
  if (style < 22) {
    path = `${share}\\Music\\${artist} - ${release} (${year}) [${fmtTag}]\\${pad2(track)} - ${title}.${fmt.ext}`;
  } else if (style < 38) {
    path = `${share}\\${artist}\\${release}\\${pad2(track)}. ${title}.${fmt.ext}`;
  } else if (style < 50) {
    path = `${share}\\${lc(artist)}-${lc(release)}-(${cat})-WEB-${year}-${pick(r, GROUPS)}\\${pad2(track)}-${lc(artist)}-${lc(title)}.${fmt.ext}`;
  } else if (style < 60) {
    path = `${share}\\shared\\[${cat}] ${artist} - ${release}\\${vinyl} ${artist} - ${title}.${fmt.ext}`;
  } else if (style < 70) {
    path = `${share}\\Music\\VA - ${release} (${year})\\${pad2(track)} - ${artist} - ${title}.${fmt.ext}`;
  } else if (style < 78) {
    path = `${share}\\downloads\\${artist} - ${title}.${fmt.ext}`;
  } else if (style < 84) {
    // The folder holds the artist; the file holds only a number.
    path = `${share}\\${artist}\\${release}\\${pad2(track)}.${fmt.ext}`;
  } else if (style < 90) {
    // Genuinely unparseable. The UI must show this raw, and visibly so.
    path = `${share}\\incoming\\${lc(title)}${Math.floor(r() * 9999)}.${fmt.ext}`;
  } else if (style < 95) {
    path = `${'CDEF'[Math.floor(r() * 4)]}:\\Music\\${artist} - ${release} [${fmtTag}]\\${pad2(track)} - ${title}.${fmt.ext}`;
  } else {
    path = `${share}\\Music\\${artist}\\${release} (${year})\\${pad2(track)} - ${artist} - ${title}.${fmt.ext}`;
  }

  if (mode === 'no-attrs') {
    // Older clients send no attributes whatsoever. No check is possible.
    return { path, size, bitrate: null, duration: null, isVbr: null, sampleRate: null, bitDepth: null };
  }

  return {
    path,
    size,
    bitrate: fmt.bitrate,
    duration,
    isVbr: fmt.vbr,
    sampleRate: fmt.sampleRate,
    bitDepth: fmt.bitDepth,
  };
}

export function recordSession(query: string, opts: FixtureOptions = {}): RecordedSession {
  const seed = opts.seed ?? 0x5eec;
  const targetFiles = opts.targetFiles ?? 2400;
  const durationMs = opts.durationMs ?? 26_000;
  const r = rng(seed);

  const responses: RecordedResponse[] = [];
  let totalFiles = 0;
  let userSeq = 0;

  while (totalFiles < targetFiles) {
    const user = `${pick(r, USER_NAMES)}${Math.floor(r() * 900) + 10}`;
    userSeq++;

    // A peer answers with anywhere from one file to a whole folder.
    const n = Math.max(1, Math.round(1 + Math.pow(r(), 2) * 22));
    const files: WireFile[] = [];
    for (let i = 0; i < n; i++) {
      const roll = r();
      const mode =
        roll < 0.07 ? 'no-attrs'
          : roll < 0.13 ? 'transcode'
            : roll < 0.17 ? 'fake-lossless'
              : 'normal';
      files.push(makeFile(r, mode));
    }
    totalFiles += files.length;

    // Peer stats. `advertisedSpeed` is the peer's own claim about itself.
    const freeSlots = chance(r, 0.42);
    const response: Omit<WireSearchResult, 'searchId'> = {
      type: 'search.result',
      user,
      files,
      userStats: {
        freeSlots,
        advertisedSpeed: Math.round(Math.pow(r(), 2.2) * 4_000_000 + 8_000),
        queueLength: freeSlots ? 0 : Math.floor(Math.pow(r(), 1.6) * 70),
      },
    };

    // Arrival curve: Soulseek front-loads hard, then trails for half a minute.
    // Exponential with a long tail, so the list is usable almost immediately.
    const u = r();
    const at = Math.min(durationMs, Math.round(-Math.log(1 - u * 0.985) * (durationMs / 7)));
    responses.push({ at: at + (userSeq % 3) * 40, response });
  }

  responses.sort((a, b) => a.at - b.at);
  return { query, responses, totalFiles };
}
