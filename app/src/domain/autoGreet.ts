/*
 * Seek — who to greet when an upload finishes.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The whole decision, as a pure function, for the same reason
 * `autoWishlist.ts` is one: this feature sends messages to strangers, and the
 * rules that stop it sending too many need to be testable without a socket.
 *
 * WHY A PERSON RATHER THAN A TRANSFER is the load-bearing choice here. Somebody
 * pulling a 200-file album finishes 200 uploads, usually within a minute. The
 * unit being greeted is the PERSON, once, ever — not the transfer, not the
 * folder, not the session.
 */

/**
 * Decide who to greet right now. PURE.
 *
 * The rules, in order:
 *   - never someone already greeted — the guard that makes this once-per-person
 *     rather than once-per-download, and the only thing standing between a
 *     regular downloader and the same message every week;
 *   - never the same person twice within one batch, because a folder grab
 *     finishes many files at once and they all arrive together;
 *   - at most `slotsLeft`, so a busy night cannot turn into a message flood.
 */
export function planGreetings(
  candidates: readonly string[],
  greeted: ReadonlySet<string>,
  slotsLeft: number,
): string[] {
  if (slotsLeft <= 0) return [];
  const plan: string[] = [];
  const picked = new Set<string>();
  for (const user of candidates) {
    if (!user || greeted.has(user) || picked.has(user)) continue;
    picked.add(user);
    plan.push(user);
    if (plan.length >= slotsLeft) break;
  }
  return plan;
}
