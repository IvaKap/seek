/*
 * Seek — a peer's picture, or their initials when they have not set one.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Most Soulseek users have never set a profile picture — that is the common
 * case, not a failure state, which is why the fallback is a plain initials
 * badge rather than a broken-image icon or an empty circle.
 */

export function PeerAvatar({
  username, pictureUri, size = 28,
}: {
  username: string;
  /** `undefined` (never asked / in flight) renders the same as `null` (asked, nothing set). */
  pictureUri: string | null | undefined;
  size?: number;
}) {
  return (
    <span
      className="peeravatar"
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {pictureUri ? (
        <img src={pictureUri} alt="" className="peeravatar__pic" />
      ) : (
        <span className="peeravatar__initials">{username.slice(0, 2).toUpperCase()}</span>
      )}
    </span>
  );
}
