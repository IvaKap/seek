import { describe, expect, it } from 'vitest';
import { soulseekUrl } from './soulseekUrl.ts';

// Expected values produced by Python's urllib.parse.quote, which is what
// Nicotine+ uses (userbrowse.py get_soulseek_url).
describe('soulseekUrl', () => {
  it('matches Nicotine+ for brackets, spaces and !', () => {
    expect(soulseekUrl('dj', 'Music\\Artist - Album (2001)\\01 Track!.flac'))
      .toBe('slsk://dj/Music/Artist%20-%20Album%20%282001%29/01%20Track%21.flac');
  });
  it("matches for accents, ' * & # and a space in the name", () => {
    expect(soulseekUrl('a b', "Shared\\Björk\\It's * & #1.mp3"))
      .toBe('slsk://a%20b/Shared/Bj%C3%B6rk/It%27s%20%2A%20%26%20%231.mp3');
  });
  it('leaves the unreserved characters alone', () => {
    expect(soulseekUrl('x', 'é~_.-')).toBe('slsk://x/%C3%A9~_.-');
  });
  it('ends a folder link with a slash', () => {
    expect(soulseekUrl('dj', 'Music\\Album', true)).toBe('slsk://dj/Music/Album/');
  });
});
