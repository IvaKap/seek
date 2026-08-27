/*
 * Seek — the pasteable bug report.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The first real report this project received was "Not a link Seek recognises
 * — that's all I get", and diagnosing it took an hour and access to the
 * developer's own machine. These pin the things that would have shortened it.
 */

import { describe, expect, it } from 'vitest';
import { buildReport } from './bugReport.ts';

function input(over: Partial<Parameters<typeof buildReport>[0]> = {}) {
  return {
    appVersion: '0.2.3',
    sidecarVersion: '0.2.3',
    coreVersion: '3.4.0.dev1',
    os: 'macOS 15.5',
    arch: 'arm64',
    logPath: '/x/data/seek.log',
    logTail: 'INFO seek.core  something happened\n',
    logBytes: 512,
    fpcalc: '/x/Resources/sidecar/fpcalc',
    ...over,
  };
}

describe('what a report has to carry', () => {
  it('leads with the three facts every report needs', () => {
    const out = buildReport(input());
    expect(out).toContain('Seek 0.2.3');
    expect(out).toContain('macOS 15.5');
    expect(out).toContain('arm64');
    expect(out).toContain('engine 0.2.3');
    expect(out).toContain('core 3.4.0.dev1');
  });

  it('fences the log so it survives Reddit, GitHub and a DM alike', () => {
    const out = buildReport(input());
    expect(out).toContain('```\nINFO seek.core  something happened\n```');
  });

  it('leaves prompts for the sentence only a person can write', () => {
    /* Versions and a log still do not say what someone was trying to do. They
     * are far likelier to write it if the paste already has a space for it. */
    const out = buildReport(input());
    expect(out).toContain('What I did:');
    expect(out).toContain('What I expected:');
    expect(out).toContain('What happened instead:');
  });
});

describe('when things are missing, which is when it matters most', () => {
  it('says so plainly when the engine never answered', () => {
    /* An empty "engine  · core " reads as a formatting bug and hides the
     * actual finding, which is that the sidecar is not up. */
    const out = buildReport(input({ sidecarVersion: '', coreVersion: '' }));
    expect(out).toContain('engine: not connected');
    expect(out).not.toMatch(/engine\s+·\s+core\s*$/m);
  });

  it('reports a missing log rather than emitting an empty fence', () => {
    const out = buildReport(input({ logPath: '', logTail: '' }));
    expect(out).toContain('No log file');
    expect(out).not.toContain('```');
  });

  it('distinguishes an empty log from an absent one', () => {
    /* Different bugs: one means logging never started, the other means the
     * engine has not said anything yet. */
    const out = buildReport(input({ logTail: '   \n' }));
    expect(out).toContain('Log is empty');
    expect(out).toContain('/x/data/seek.log');
  });

  it('still produces a usable report with nothing but a version', () => {
    const out = buildReport(input({
      sidecarVersion: '', coreVersion: '', os: '', arch: '',
      logPath: '', logTail: '', logBytes: 0, fpcalc: '',
    }));
    expect(out).toContain('Seek 0.2.3');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('trimming', () => {
  it('keeps the END of a long log, because that is where the failure is', () => {
    const long = `${'x'.repeat(30000)}\nLAST LINE BEFORE IT BROKE\n`;
    const out = buildReport(input({ logTail: long, logBytes: long.length }));
    expect(out).toContain('LAST LINE BEFORE IT BROKE');
    expect(out.length).toBeLessThan(long.length);
  });

  it('says the log was trimmed, and how big it really was', () => {
    const long = `${'y'.repeat(40000)}\ntail\n`;
    const out = buildReport(input({ logTail: long, logBytes: 40960 }));
    expect(out).toMatch(/Log \(last part of \d+ KB\):/);
  });

  it('does not open the paste mid-line', () => {
    const long = `${'z'.repeat(30000)}\nclean line\n`;
    const out = buildReport(input({ logTail: long, logBytes: long.length }));
    const body = out.slice(out.indexOf('```') + 4);
    expect(body.startsWith('z')).toBe(false);
  });

  it('leaves a short log exactly as it was', () => {
    const out = buildReport(input({ logTail: 'one\ntwo\nthree\n' }));
    expect(out).toContain('```\none\ntwo\nthree\n```');
    expect(out).toContain('Log:');
    expect(out).not.toContain('last part of');
  });
});

describe('fingerprinting availability', () => {
  /* "Identify by sound does nothing" and "identify by sound is broken" are
   * different reports with different answers. Only this line separates them. */
  it('says so when the tool is there', () => {
    expect(buildReport(input())).toContain('fingerprinting: available');
  });

  it('shouts when it is not', () => {
    expect(buildReport(input({ fpcalc: '' }))).toContain('fingerprinting: UNAVAILABLE');
  });
});
