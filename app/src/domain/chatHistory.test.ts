/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Reading Nicotine+'s chat logs back, so a restart stops wiping every
 * conversation. The line format is the engine's; the parsing is ours.
 */

import { describe, expect, it } from 'vitest';
import { parseLogLine, withoutLive } from './chatHistory.ts';

describe('parseLogLine', () => {
  it('splits a line the way Nicotine+ writes it', () => {
    expect(parseLogLine('09/21/26 17:10:25 [Charfield] got the white label?')).toEqual({
      stamp: '09/21/26 17:10:25', username: 'Charfield', message: 'got the white label?',
    });
  });

  it('keeps brackets inside the message as text', () => {
    const line = parseLogLine('21.09.26 17:10 [bob] it says [promo] on the sleeve');
    expect(line.username).toBe('bob');
    expect(line.message).toBe('it says [promo] on the sleeve');
  });

  it('shows a line without a sender rather than dropping it', () => {
    expect(parseLogLine('--- old messages ---')).toEqual({
      stamp: '', username: null, message: '--- old messages ---',
    });
  });
});

describe('withoutLive', () => {
  const h = (username: string, message: string) => ({ stamp: 't', username, message });

  it('drops the tail this session already shows', () => {
    /* The engine logs a message before Seek hears about it, so the message
     * that opened the conversation is both on screen and last in the log. */
    const history = [h('bob', 'yesterday'), h('bob', 'hey, still got it?')];
    expect(withoutLive(history, [{ username: 'bob', message: 'hey, still got it?' }]))
      .toEqual([h('bob', 'yesterday')]);
  });

  it('keeps everything when nothing has been said yet this session', () => {
    const history = [h('bob', 'a'), h('me', 'b')];
    expect(withoutLive(history, [])).toEqual(history);
  });

  it('skips live lines the log never had, such as command replies', () => {
    const history = [h('bob', 'old'), h('bob', 'one'), h('me', 'two')];
    const live = [
      { username: 'bob', message: 'one' },
      { username: 'me', message: 'Unknown command: /foo' },
      { username: 'me', message: 'two' },
    ];
    expect(withoutLive(history, live)).toEqual([h('bob', 'old')]);
  });
});
