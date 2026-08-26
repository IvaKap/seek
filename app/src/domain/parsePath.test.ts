/*
 * Seek — parsePath tests. Real, ugly, Soulseek-shaped paths.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The point of these is not coverage, it is PINNING BEHAVIOUR ON AMBIGUOUS
 * INPUT. Several cases below assert a deliberately imperfect result, because
 * the alternative was worse. Those are marked. If you change the parser and one
 * of them flips, read the comment before you "fix" it.
 */

import { describe, expect, it } from 'vitest';
import { parsePath, parseReleaseFolder } from './parsePath.ts';

describe('parsePath — the shapes the brief names', () => {
  it('Artist - Album (year) [FLAC] / NN - Title', () => {
    const p = parsePath('@@abcde\\Music\\Burial - Untrue (2007) [FLAC]\\03 - Archangel.flac');
    expect(p.artist?.value).toBe('Burial');
    expect(p.release?.value).toBe('Untrue');
    expect(p.year?.value).toBe(2007);
    expect(p.trackNumber?.value).toBe(3);
    expect(p.title?.value).toBe('Archangel');
    expect(p.formatHint?.value).toBe('FLAC');
    expect(p.extension).toBe('flac');
    expect(p.fallback).toBe(false);
    expect(p.confidence).toBeGreaterThan(0.8);
  });

  it('NN - Artist - Title', () => {
    const p = parsePath('@@x\\VA - Mixed (2011)\\07 - Levon Vincent - Man Or Mistress.mp3');
    expect(p.trackNumber?.value).toBe(7);
    expect(p.artist?.value).toBe('Levon Vincent');
    expect(p.title?.value).toBe('Man Or Mistress');
    expect(p.compilation).toBe(true);
  });

  it('NN. Title', () => {
    const p = parsePath('@@x\\Music\\Actress - Splazsh\\04. Get Ohn (Fairlight).mp3');
    expect(p.trackNumber?.value).toBe(4);
    expect(p.title?.value).toBe('Get Ohn (Fairlight)');
    expect(p.artist?.value).toBe('Actress');
    expect(p.artist?.from).toBe('folder');
  });

  it('Artist - Title with no track number', () => {
    const p = parsePath('@@x\\techno\\Jeff Mills - The Bells.wav');
    expect(p.artist?.value).toBe('Jeff Mills');
    expect(p.title?.value).toBe('The Bells');
    expect(p.trackNumber).toBeNull();
  });

  it('catalogue-number prefix in the filename', () => {
    const p = parsePath('@@a\\Techno\\WARP123 - Autechre - Gantz Graf.flac');
    expect(p.catalogue?.value).toBe('WARP123');
    expect(p.artist?.value).toBe('Autechre');
    expect(p.title?.value).toBe('Gantz Graf');
  });

  it('bracketed catalogue on the folder, vinyl position on the file', () => {
    const p = parsePath('@@x\\shared\\[PAN 74] Objekt - Flatland\\A1 Objekt - Agnes Revenge.flac');
    expect(p.catalogue?.value).toBe('PAN 74');
    expect(p.release?.value).toBe('Flatland');
    expect(p.vinylPosition?.value).toBe('A1');
    expect(p.artist?.value).toBe('Objekt');
    expect(p.title?.value).toBe('Agnes Revenge');
  });

  it('vinyl position with a dot, artist from the folder', () => {
    const p = parsePath('@@x\\music\\VA - Tresor 25 (2016) [FLAC]\\B2. Marcel Dettmann - Tempest.flac');
    expect(p.vinylPosition?.value).toBe('B2');
    expect(p.artist?.value).toBe('Marcel Dettmann');
    expect(p.title?.value).toBe('Tempest');
    expect(p.compilation).toBe(true);
    expect(p.year?.value).toBe(2016);
  });

  it('folder holds the artist, file holds only a number', () => {
    const p = parsePath('@@xyz\\Aphex Twin\\Selected Ambient Works 85-92\\01.mp3');
    expect(p.trackNumber?.value).toBe(1);
    expect(p.title).toBeNull();
    expect(p.artist?.value).toBe('Aphex Twin');
    expect(p.artist?.from).toBe('parent');
    expect(p.release?.value).toBe('Selected Ambient Works 85-92');
    // Never invent a title. Show the file exactly as it arrived.
    expect(p.fallback).toBe(true);
    expect(p.displayTitle).toBe('01.mp3');
  });

  it('disc-track prefix', () => {
    const p = parsePath('@@x\\Music\\Some Compilation [2CD]\\1-04 Surgeon - Badger Bite.flac');
    expect(p.discNumber?.value).toBe(1);
    expect(p.trackNumber?.value).toBe(4);
    expect(p.artist?.value).toBe('Surgeon');
    expect(p.title?.value).toBe('Badger Bite');
  });
});

describe('parsePath — scene releases', () => {
  it('Artist-Title-(CAT)-WEB-YEAR-GROUP folder', () => {
    const p = parsePath(
      '@@q\\Burial-Untrue-(HDBLP002)-WEB-2007-XXL\\01-burial-archangel.mp3',
    );
    expect(p.release?.value).toBe('Untrue');
    expect(p.year?.value).toBe(2007);
    expect(p.catalogue?.value).toBe('HDBLP002');
    expect(p.trackNumber?.value).toBe(1);
    // Unpadded dashes are only trusted because the stem has no spaces at all.
    expect(p.artist?.value).toBe('burial');
    expect(p.title?.value).toBe('archangel');
  });

  it('underscore-separated scene filename', () => {
    const p = parsePath('@@q\\Music\\Aphex Twin - Windowlicker\\01_aphex_twin_-_windowlicker.mp3');
    expect(p.trackNumber?.value).toBe(1);
    expect(p.artist?.value).toBe('aphex twin');
    expect(p.title?.value).toBe('windowlicker');
  });
});

describe('parsePath — refuses to invent', () => {
  it('junk filename falls back to the raw name, visibly', () => {
    const p = parsePath('@@q\\downloads\\audiotrack.mp3');
    expect(p.artist).toBeNull();
    // A bare word is a weak title, but it is what the file says. It is shown.
    expect(p.displayTitle).toBe('audiotrack');
    expect(p.confidence).toBeLessThan(0.4);
  });

  it('generic container folders never become an artist or a release', () => {
    const p = parsePath('@@q\\Music\\Downloads\\Untitled.wav');
    expect(p.artist).toBeNull();
    expect(p.release).toBeNull();
  });

  it('a totally unparseable name keeps the extension and the raw filename', () => {
    const p = parsePath('@@q\\incoming\\_.mp3');
    expect(p.fallback).toBe(true);
    expect(p.displayTitle).toBe('_.mp3');
    expect(p.extension).toBe('mp3');
  });

  it('"Various Artists" never propagates as an artist name', () => {
    const p = parsePath('@@z\\Music\\Various Artists\\Mixed by Villalobos\\09 - Untitled.flac');
    expect(p.compilation).toBe(true);
    expect(p.artist).toBeNull();
  });

  it('confidence is lower for a bare title than for Artist - Title', () => {
    const bare = parsePath('@@q\\Music\\Some Folder\\Rainfall.mp3');
    const full = parsePath('@@q\\Music\\Some Folder\\Chameleon - Rainfall.mp3');
    expect(full.title!.confidence).toBeGreaterThan(bare.title!.confidence);
  });
});

describe('parsePath — numeric artist names (the ambiguity that bites)', () => {
  it('does not eat a leading number that is part of the artist name', () => {
    const p = parsePath('@@q\\Music\\Hardcore\\2 Bad Mice - Bombscare.mp3');
    expect(p.trackNumber).toBeNull();
    expect(p.artist?.value).toBe('2 Bad Mice');
    expect(p.title?.value).toBe('Bombscare');
  });

  it('three-digit band names are never track numbers', () => {
    const p = parsePath('@@q\\Music\\Acid\\808 State - Pacific State.mp3');
    expect(p.trackNumber).toBeNull();
    expect(p.artist?.value).toBe('808 State');
  });

  it('space-separated track number IS taken when no artist dash follows', () => {
    const p = parsePath('@@q\\Music\\Moodymann - Silence In The Secret Garden\\05 Music People.mp3');
    expect(p.trackNumber?.value).toBe(5);
    expect(p.title?.value).toBe('Music People');
    // Weak signal, and the confidence says so.
    expect(p.trackNumber!.confidence).toBeLessThan(0.8);
  });

  it('KNOWN LIMITATION: "NN Artist - Title" keeps the number on the artist', () => {
    // The alternative rule silently truncates "2 Bad Mice" to "Bad Mice", which
    // is a worse failure — the user cannot see that it happened. Pinned so the
    // trade-off is visible rather than accidental.
    const p = parsePath('@@q\\Music\\Aphex Twin - SAW\\01 Aphex Twin - Xtal.mp3');
    expect(p.artist?.value).toBe('01 Aphex Twin');
    expect(p.title?.value).toBe('Xtal');
  });
});

describe('parsePath — remix / version information survives', () => {
  it('keeps the remix in the title and surfaces it separately', () => {
    const p = parsePath('@@q\\Music\\X - Y\\02 - Floating Points - Silhouettes (Four Tet Remix).flac');
    expect(p.title?.value).toBe('Silhouettes (Four Tet Remix)');
    expect(p.version).toBe('Four Tet Remix');
  });

  it('does not split a hyphenated word into artist and title', () => {
    const p = parsePath('@@q\\Music\\Some Folder\\Hi-Fi Companion.mp3');
    expect(p.artist).toBeNull();
    expect(p.title?.value).toBe('Hi-Fi Companion');
  });
});

describe('parsePath — path handling', () => {
  it('accepts forward slashes as well as backslashes', () => {
    const p = parsePath('@@q/Music/Burial - Untrue/03 - Archangel.flac');
    expect(p.artist?.value).toBe('Burial');
    expect(p.trackNumber?.value).toBe(3);
  });

  it('groups by the full parent path, not just the folder name', () => {
    const a = parsePath('@@q\\A\\Untrue\\01 - X.flac');
    const b = parsePath('@@q\\B\\Untrue\\01 - X.flac');
    expect(a.folderPath).not.toBe(b.folderPath);
    expect(a.folder).toBe(b.folder);
  });

  it('handles a filename with no extension', () => {
    const p = parsePath('@@q\\Music\\Artist - Album\\Track Name');
    expect(p.extension).toBeNull();
    expect(p.title?.value).toBe('Track Name');
  });

  it('share-root segments never become an artist', () => {
    const p = parsePath('@@abcdef\\Chameleon - Rainfall.mp3');
    expect(p.artist?.value).toBe('Chameleon');
    expect(p.release).toBeNull();
  });
});

describe('parseReleaseFolder', () => {
  it('splits Artist - Album and strips tags', () => {
    const f = parseReleaseFolder('Autechre - Tri Repetae (1995) [FLAC]');
    expect(f.artist?.value).toBe('Autechre');
    expect(f.release?.value).toBe('Tri Repetae');
    expect(f.year?.value).toBe(1995);
    expect(f.format?.value).toBe('FLAC');
  });

  it('reads a leading unbracketed catalogue number', () => {
    const f = parseReleaseFolder('HDBLP002 Burial - Untrue');
    expect(f.catalogue?.value).toBe('HDBLP002');
    expect(f.artist?.value).toBe('Burial');
    expect(f.release?.value).toBe('Untrue');
  });

  it('does not treat a hyphenated band name as Artist - Album', () => {
    const f = parseReleaseFolder('Nine-Inch-Nails');
    expect(f.artist).toBeNull();
    expect(f.release?.value).toBe('Nine-Inch-Nails');
  });

  it('a year alone is not a catalogue number', () => {
    const f = parseReleaseFolder('Some Album (2019)');
    expect(f.catalogue).toBeNull();
    expect(f.year?.value).toBe(2019);
  });

  it('rejects an implausible future year', () => {
    const f = parseReleaseFolder('Album (2099)');
    expect(f.year).toBeNull();
  });
});
