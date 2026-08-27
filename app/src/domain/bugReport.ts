/*
 * Seek — the block of text a person pastes when something goes wrong.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * WHY THIS EXISTS AS ONE BUTTON. The facts that make a report actionable are
 * spread across three places: the app knows its own version, the engine knows
 * the OS and architecture, and the log is a file inside the .app's data folder.
 * Asking someone to gather all three is five steps, and the first real bug
 * report this project received was "Not a link Seek recognises — that's all I
 * get", which was true, complete, and took an hour of live debugging.
 *
 * Most people reporting this app will be replying to a Reddit comment, not
 * filing a GitHub issue. So the output is plain text with a fenced log, which
 * pastes correctly into Reddit, GitHub and a DM alike — no Markdown tables, no
 * HTML, nothing that renders differently depending where it lands.
 *
 * NOTHING HERE SENDS ANYTHING. It produces a string for the clipboard. Whether
 * it reaches anybody is a decision the user makes afterwards, in another app.
 */

export interface ReportInput {
  /** The frontend's own version, compiled in. */
  appVersion: string;
  /** From the handshake — the Python engine and the Nicotine+ core. */
  sidecarVersion: string;
  coreVersion: string;
  /** From the engine, which unlike the webview knows the truth. */
  os: string;
  arch: string;
  logPath: string;
  logTail: string;
  /** Path to the fingerprinter, or '' when identify-by-sound is unavailable. */
  fpcalc: string;
  /** Size of the whole log, so a trimmed tail is stated rather than implied. */
  logBytes: number;
}

/** Roughly how much log to keep. Past this, people stop reading. */
const MAX_LOG_CHARS = 12000;

function trimLog(text: string): { body: string; trimmed: boolean } {
  if (text.length <= MAX_LOG_CHARS) return { body: text.trimEnd(), trimmed: false };
  // Keep the END: whatever went wrong is the last thing that happened.
  const cut = text.slice(text.length - MAX_LOG_CHARS);
  // Drop the leading partial line so the paste does not open mid-sentence.
  const nl = cut.indexOf('\n');
  return { body: (nl === -1 ? cut : cut.slice(nl + 1)).trimEnd(), trimmed: true };
}

export function buildReport(input: ReportInput): string {
  const lines: string[] = [];

  lines.push(`Seek ${input.appVersion || '?'} · ${input.os || 'macOS ?'} · ${input.arch || '?'}`);
  const engine = [
    input.sidecarVersion ? `engine ${input.sidecarVersion}` : '',
    input.coreVersion ? `core ${input.coreVersion}` : '',
  ].filter(Boolean).join(' · ');
  // Absent when the sidecar never answered — which is itself the bug, and
  // saying so beats printing "engine  · core ".
  lines.push(engine || 'engine: not connected');
  /* Stated either way. "Identify by sound does nothing" and "identify by sound
   * is broken" are different reports, and only this line tells them apart. */
  lines.push(input.fpcalc ? 'fingerprinting: available' : 'fingerprinting: UNAVAILABLE');

  lines.push('');
  lines.push('What I did:');
  lines.push('What I expected:');
  lines.push('What happened instead:');
  lines.push('');

  if (!input.logPath) {
    lines.push('(No log file — the engine did not report one.)');
    return `${lines.join('\n')}\n`;
  }
  if (!input.logTail.trim()) {
    lines.push(`(Log is empty: ${input.logPath})`);
    return `${lines.join('\n')}\n`;
  }

  const { body, trimmed } = trimLog(input.logTail);
  lines.push(trimmed
    ? `Log (last part of ${Math.round(input.logBytes / 1024)} KB):`
    : 'Log:');
  // A fenced block, because every one of Reddit, GitHub and Discord renders
  // this the same way and none of them reflow what is inside it.
  lines.push('```');
  lines.push(body);
  lines.push('```');

  return `${lines.join('\n')}\n`;
}

/**
 * The prompts above are left blank on purpose.
 *
 * A report that arrives as versions and a log still needs a sentence saying
 * what the person was doing, and they are far more likely to write it if the
 * paste already has a space for it than if they are asked afterwards.
 */
export const PROMPT_LINES = 3;
