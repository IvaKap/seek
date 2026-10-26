/*
 * Seek — why you are not signed in, in words.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The sidecar reports a code (ConnectionState.error): the server's own
 * rejection of a login, or why it signed us out. "Not signed in" alone sent a
 * person hunting, and a raw INVALIDPASS is not a sentence.
 */

/** Null when there is nothing to explain. */
export function signInProblem(code: string | null | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case 'relogged':
      return 'Your account signed in somewhere else — another Seek or Nicotine+ — so the '
        + 'server signed this one out. Seek will not sign back in by itself, or the two would '
        + 'keep pushing each other off. Close the other one, then sign in again.';
    case 'server_closed':
      return 'The Soulseek server ended the session. Seek will not sign back in by itself; '
        + 'sign in again when you are ready.';
    case 'INVALIDPASS': return 'Wrong password for that account.';
    case 'INVALIDUSERNAME': return 'The server does not accept that username.';
    case 'EMPTYPASSWORD': return 'The server needs a password.';
    case 'INVALIDVERSION': return 'The server refused this version of the engine.';
    case 'SVRFULL': return 'The Soulseek server is full right now. Try again in a few minutes.';
    case 'SVRPRIVATE': return 'The Soulseek server is not taking new accounts right now.';
    default: return `The server refused the sign-in (${code}).`;
  }
}

/** Signed out by the server, rather than refused at the door. */
export const signedOutByServer = (code: string | null | undefined): boolean => (
  code === 'relogged' || code === 'server_closed'
);
