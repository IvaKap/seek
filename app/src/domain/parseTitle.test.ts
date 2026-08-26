/*
 * Seek — parseTitle tests. Real, ugly, YouTube-shaped titles.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Same purpose as parsePath.test.ts: PINNING BEHAVIOUR ON AMBIGUOUS INPUT.
 * Several cases assert a deliberately hedged result — a low confidence rather
 * than a clean parse — because the preview card can show the raw title and let
 * the user fix it, and a confident wrong artist it cannot. Those are marked.
 * If one flips, read the comment before "fixing" it.
 */

import { describe, expect, it } from 'vitest';
import {
  TITLE_CONFIDENCE_FLOOR, parseTitle, searchQuery,
} from './parseTitle.ts';

describe('parseTitle — the forms the brief names', () => {
  it('Artist - Title', () => {
    const p = parseTitle('Burial - Archangel');
    expect(p.artist).toBe('Burial');
    expect(p.title).toBe('Archangel');
    expect(p.from).toBe('separator');
    expect(p.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('em dash and en dash behave as the hyphen does', () => {
    for (const dash of ['—', '–', '‒', '―']) {
      const p = parseTitle(`Actress ${dash} Hubble`);
      expect(p.artist).toBe('Actress');
      expect(p.title).toBe('Hubble');
    }
  });

  it('strips (Official Video) and friends', () => {
    const cases = [
      'Burial - Archangel (Official Video)',
      'Burial - Archangel (Official Music Video)',
      'Burial - Archangel [Official Audio]',
      'Burial - Archangel (Official Visualizer)',
      'Burial - Archangel (Lyric Video)',
      'Burial - Archangel (HD)',
      'Burial - Archangel (HQ)',
      'Burial - Archangel [4K]',
      'Burial - Archangel (Audio)',
      'Burial - Archangel [FREE DOWNLOAD]',
      'Burial - Archangel (Premiere)',
    ];
    for (const raw of cases) {
      const p = parseTitle(raw);
      expect(p.artist, raw).toBe('Burial');
      expect(p.title, raw).toBe('Archangel');
    }
  });

  it('keeps feat. in the title', () => {
    const p = parseTitle('Four Tet - Only Human (feat. Ellie Goulding)');
    expect(p.artist).toBe('Four Tet');
    expect(p.title).toBe('Only Human (feat. Ellie Goulding)');
  });

  it('keeps a featured credit that sits in the artist position', () => {
    const p = parseTitle('Skepta ft. JME - That’s Not Me');
    expect(p.artist).toBe('Skepta ft. JME');
    expect(p.title).toBe('That’s Not Me');
  });

  it('keeps the remix name — it is a different record', () => {
    const p = parseTitle('Caribou - Odessa (Ricardo Villalobos Remix)');
    expect(p.artist).toBe('Caribou');
    expect(p.title).toBe('Odessa (Ricardo Villalobos Remix)');
  });

  it("Artist 'Title' and Artist \"Title\"", () => {
    for (const raw of ['Pangaea ‘Installation’', 'Pangaea "Installation"']) {
      const p = parseTitle(raw);
      expect(p.artist, raw).toBe('Pangaea');
      expect(p.title, raw).toBe('Installation');
      expect(p.from, raw).toBe('quoted');
    }
  });

  it('Title by Artist reverses', () => {
    const p = parseTitle('Xtal by Aphex Twin');
    expect(p.artist).toBe('Aphex Twin');
    expect(p.title).toBe('Xtal');
    expect(p.from).toBe('reversed');
  });

  it('Artist - Album - Title yields an album hint', () => {
    const p = parseTitle('Burial - Untrue - Archangel');
    expect(p.artist).toBe('Burial');
    expect(p.album).toBe('Untrue');
    expect(p.title).toBe('Archangel');
    // Three segments is a guess about which is which, so it earns less than two.
    expect(p.confidence).toBeLessThan(0.9);
  });

  it('VA takes its artist from the remix credit', () => {
    const p = parseTitle('VA - Sunset Dub (Levon Vincent Remix)');
    expect(p.artist).toBe('Levon Vincent');
    expect(p.title).toBe('Sunset Dub (Levon Vincent Remix)');
  });

  it('strips a leading track number', () => {
    for (const raw of ['01. Actress - Hubble', '01) Actress - Hubble', '1 - Actress - Hubble']) {
      const p = parseTitle(raw);
      expect(p.artist, raw).toBe('Actress');
      expect(p.title, raw).toBe('Hubble');
    }
  });

  it('Artist, Title — the shape the recorded Hyperdub fixture actually has', () => {
    const p = parseTitle('Burial, Archangel', { channel: 'Hyperdub' });
    expect(p.artist).toBe('Burial');
    expect(p.title).toBe('Archangel');
    expect(p.from).toBe('comma');
    // Above the floor so the card prefills it, but visibly weaker than a dash:
    // a comma is punctuation at least as often as it is a separator.
    expect(p.confidence).toBeGreaterThan(TITLE_CONFIDENCE_FLOOR);
    expect(p.confidence).toBeLessThan(0.8);
  });

  it('a comma that is punctuation is not a separator', () => {
    for (const raw of [
      'Untitled, Pt. 2', 'Kid A, Vol. 1', 'Rainforest, Disc 2',
      'Amsterdam, the second time', 'Ghosts, No. 4',
    ]) {
      const p = parseTitle(raw);
      expect(p.artist, raw).toBe('');
      expect(p.title, raw).toBe(raw);
    }
  });

  it('a dash beats a comma when a title has both', () => {
    const p = parseTitle('Burial - Untrue, Remastered');
    expect(p.artist).toBe('Burial');
    expect(p.title).toBe('Untrue, Remastered');
  });

  it('Artist: Title', () => {
    const p = parseTitle('Objekt: Ganzfeld');
    expect(p.artist).toBe('Objekt');
    expect(p.title).toBe('Ganzfeld');
    expect(p.from).toBe('colon');
  });
});

describe('parseTitle — the DJ-set edge cases from the brief', () => {
  it('Boiler Room - DJ Name - Live Set drops the branding', () => {
    const p = parseTitle('Boiler Room - Ben UFO - Live Set', { channel: 'Boiler Room' });
    expect(p.artist).toBe('Ben UFO');
    expect(p.title).toBe('Live Set');
  });

  it('drops the branding from the series list even with no channel given', () => {
    const p = parseTitle('Boiler Room - Ben UFO - Live Set');
    expect(p.artist).toBe('Ben UFO');
    expect(p.title).toBe('Live Set');
  });

  it('Resident Advisor - RA.823 DJ Name', () => {
    const p = parseTitle('Resident Advisor - RA.823 Anastasia Kristensen',
                         { channel: 'Resident Advisor' });
    expect(p.artist).toBe('Anastasia Kristensen');
    expect(p.title).toBe('RA.823');
    expect(p.from).toBe('series');
  });

  it('HÖR - DJ Name / date / city keeps the artist, hedges the title', () => {
    const p = parseTitle('HÖR - Sedef Adaşal / August 23 / Berlin', { channel: 'HÖR' });
    expect(p.artist).toBe('Sedef Adaşal');
    // DELIBERATE: the date and the city are not a track title. Under the floor,
    // so the card shows the original and invites a correction.
    expect(p.confidence).toBeLessThan(TITLE_CONFIDENCE_FLOOR);
    expect(p.from).toBe('billing');
  });

  it('TRAUMPRINZ All The Things has no separator and says so', () => {
    const p = parseTitle('TRAUMPRINZ All The Things');
    expect(p.artist).toBe('');
    expect(p.title).toBe('TRAUMPRINZ All The Things');
    expect(p.confidence).toBeCloseTo(0.2);
    expect(p.from).toBe('raw');
  });
});

describe('parseTitle — the channel', () => {
  it('a VEVO channel names the artist when the title cannot', () => {
    const p = parseTitle('Archangel', { channel: 'BurialVEVO' });
    expect(p.artist).toBe('Burial');
    expect(p.title).toBe('Archangel');
    expect(p.from).toBe('channel');
    // Exactly at the floor: usable, but not asserted as fact.
    expect(p.confidence).toBe(TITLE_CONFIDENCE_FLOOR);
  });

  it('a "- Topic" auto-channel names the artist too', () => {
    const p = parseTitle('Ghost Hardware', { channel: 'Burial - Topic' });
    expect(p.artist).toBe('Burial');
    expect(p.title).toBe('Ghost Hardware');
  });

  it('an artist channel does NOT get treated as branding', () => {
    // The trap: `Burial - Archangel` uploaded by `Burial - Topic` must keep its
    // artist, not have it stripped as if it were a series name.
    const p = parseTitle('Burial - Archangel', { channel: 'Burial - Topic' });
    expect(p.artist).toBe('Burial');
    expect(p.title).toBe('Archangel');
    expect(p.from).toBe('separator');
  });

  it('an unrelated channel changes nothing', () => {
    const p = parseTitle('Burial - Archangel', { channel: 'someuploader123' });
    expect(p.artist).toBe('Burial');
    expect(p.title).toBe('Archangel');
    expect(p.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('a channel whose name merely prefixes the title is still branding', () => {
    const p = parseTitle('Dekmantel Podcast - Call Super', { channel: 'Dekmantel Podcast 289' });
    expect(p.artist).toBe('Call Super');
  });

  it('YouTube Music trusts the enforced shape more', () => {
    const plain = parseTitle('Burial - Archangel');
    const music = parseTitle('Burial - Archangel', { enforced: true });
    expect(music.confidence).toBeGreaterThan(plain.confidence);
  });
});

describe('parseTitle — labels', () => {
  it('lifts a trailing [Label] out of the title', () => {
    const p = parseTitle('Burial - Archangel [Hyperdub]');
    expect(p.title).toBe('Archangel');
    expect(p.label).toBe('Hyperdub');
  });

  it('leaves a trailing [Extended Mix] alone — that is a version, not a label', () => {
    const p = parseTitle('Joy Orbison - Hyph Mngo [Extended Mix]');
    expect(p.title).toBe('Hyph Mngo [Extended Mix]');
    expect(p.label).toBeNull();
  });

  it('the label never ends up in the search query', () => {
    const p = parseTitle('Burial - Archangel [Hyperdub]');
    expect(searchQuery(p)).toBe('Burial Archangel');
  });
});

describe('parseTitle — degenerate input', () => {
  it('an empty string is empty, not a crash', () => {
    const p = parseTitle('');
    expect(p.artist).toBe('');
    expect(p.title).toBe('');
  });

  it('whitespace only', () => {
    const p = parseTitle('   \n  ');
    expect(p.title).toBe('');
  });

  it('a title that is nothing but noise keeps something searchable', () => {
    const p = parseTitle('(Official Video)');
    expect(p.title.length).toBeGreaterThan(0);
    expect(p.confidence).toBeLessThan(TITLE_CONFIDENCE_FLOOR);
  });

  it('a bare dash does not produce an empty artist and title', () => {
    const p = parseTitle('-');
    expect(p.title.length).toBeGreaterThan(0);
  });

  it('a trailing separator does not yield an empty title', () => {
    const p = parseTitle('Burial - ');
    expect(p.title.length).toBeGreaterThan(0);
  });

  it('numbers in an artist name survive', () => {
    for (const raw of ['2 Unlimited - No Limit', '4 Hero - Mr Kirk’s Nightmare']) {
      const p = parseTitle(raw);
      expect(p.artist, raw).toMatch(/^[24] /);
    }
  });

  it('diacritics are preserved in names, never folded', () => {
    const p = parseTitle('Björk - Jóga');
    expect(p.artist).toBe('Björk');
    expect(p.title).toBe('Jóga');
  });

  it('four or more segments do not invent an album', () => {
    const p = parseTitle('A - B - C - D');
    expect(p.artist).toBe('A');
    expect(p.album).toBeNull();
    expect(p.title).toBe('B - C - D');
  });

  it('the raw string is always preserved verbatim', () => {
    const raw = '  Burial  -  Archangel (Official Video)  ';
    expect(parseTitle(raw).raw).toBe(raw);
  });

  it('every parse returns a confidence in 0..1', () => {
    const inputs = [
      'Burial - Archangel', 'Archangel', 'A: B', 'X by Y', 'A / B / C',
      'RA.823 Someone', '', 'VA - Thing', 'Boiler Room - X - Y',
    ];
    for (const raw of inputs) {
      const p = parseTitle(raw, { channel: 'Boiler Room' });
      expect(p.confidence, raw).toBeGreaterThanOrEqual(0);
      expect(p.confidence, raw).toBeLessThanOrEqual(1);
    }
  });
});

describe('searchQuery', () => {
  it('joins artist and title', () => {
    expect(searchQuery({ artist: 'Burial', title: 'Archangel' })).toBe('Burial Archangel');
  });

  it('omits a missing artist without leaving whitespace', () => {
    expect(searchQuery({ artist: '', title: 'Archangel' })).toBe('Archangel');
  });
});
