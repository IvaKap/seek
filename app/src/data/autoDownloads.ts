/*
 * Seek — the auto-download controller.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The one moving part the feature adds, and deliberately a small one. It does
 * NOT search: upstream re-runs each wish on the server's interval and
 * `useWishHits` already ingests the results. This hook only watches those
 * results and, for a wish whose owner asked for it, starts ONE download of the
 * best qualifying file — then gets out of the way until a person reviews it.
 *
 * WHY IT LIVES AT APP LEVEL. It has to run whenever Seek is open, not only when
 * the Wishlist screen is showing — that is the whole point, and it is also why
 * there is no always-on daemon: the sidecar is killed when the app quits, so
 * nothing here (or anywhere) searches while Seek is closed. Keeping shares
 * online means keeping Seek open, which is the bargain we want anyway.
 *
 * WHAT KEEPS IT HONEST. The claim ledger. A wish with a live claim is skipped,
 * so a re-run cannot re-download the same item and "stop searching once a
 * candidate is found" needs no actual stopping — we simply stop acting. The
 * decision of WHAT to grab is the pure planner in domain/autoWishlist.ts; this
 * file only performs it and remembers what it did.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidecarClient } from './sidecarClient.ts';
import type { WishHits } from './wishHits.ts';
import type { Transfer } from './transferStore.ts';
import { isCancelled, isFailed } from './transferStore.ts';
import { planAutoDownloads, skipKey } from '../domain/autoWishlist.ts';
import type { DownloadPrefs } from '../domain/preferences.ts';
import type { AutoClaim, AutoClaimList, Wish, WishlistState } from '../../../shared/protocol.ts';
import { readUntilAnswered, reportFailure } from './failures.ts';

/** At most this many auto-downloads in flight at once, so a wall of auto-wishes
 *  cannot open a hundred transfers on a single interval tick. */
const MAX_INFLIGHT = 3;

/** The status that occupies a download slot. Once a claim reaches
 *  awaiting-review it is done downloading, so it holds its wish but frees a
 *  slot for the next one. */
const DOWNLOADING = 'downloading';
const AWAITING = 'awaiting-review';
/** A file rejected at review, or one that failed to download. Kept in the
 *  ledger so the planner never picks it again for that wish, but it holds
 *  neither the wish nor a slot. Dropped with everything else when the wish is
 *  removed or approved. */
const SKIPPED = 'skipped';

/** How many skipped files are remembered per wish. Past this the oldest go —
 *  a wish rejected that often has bigger problems than one stale entry. */
const SKIP_CAP = 25;

/**
 * How long a claim may wait for its download to appear before it is given up.
 *
 * Enqueue can fail without saying so, and a queued auto-download can be
 * cleared by hand from Downloads; either way the transfer never shows up. Those
 * claims used to wait for ever, each holding one of the three slots, so three
 * of them stopped auto-download for good — across restarts, since the ledger
 * persists. Generous on purpose: it must outlast a slow first load of the
 * transfer list after launch.
 */
const MISSING_GRACE_MS = 3 * 60_000;

/**
 * Failures that undo themselves: the peer comes back online, or the sweep in
 * transferStore re-asks after a timeout. Treating these as final started a
 * second copy from someone else while the first was still coming — and the
 * first then finished straight into Completed, past review. They get this long
 * to recover; after that the copy is given up AND cleared, so it cannot land
 * behind the review's back later.
 */
const TRANSIENT = new Set(['user_logged_off', 'connection_timeout', 'connection_closed']);
const TRANSIENT_GRACE_MS = 20 * 60_000;

/** The slices of the transfers and analysis sessions this controller drives. */
interface TransfersView {
  enqueue(username: string, path: string, size: number): Promise<void>;
  all: Transfer[];
  clear(ids: string[]): void;
}
interface AnalysisView {
  analyseTransfer(transferId: string): void;
}

export interface AutoDownloads {
  /** Every live claim — consumed by the review UI. */
  claims: AutoClaim[];
  /** Keep the reviewed file and finish the wish. */
  approve(query: string): void;
  /** Discard the reviewed file and let the wish find another copy. */
  reject(query: string): void;
}

export function useAutoDownloads(
  client: SidecarClient | null,
  wishHits: WishHits,
  transfers: TransfersView,
  analysis: AnalysisView,
  /** Settings → Downloads, applied as they are to a manual Get. */
  rules?: DownloadPrefs,
  /** Signed in. Nothing is started while offline: every enqueue would be
   *  refused, and each refusal used to cost the wish one of its candidates. */
  online = true,
): AutoDownloads {
  const [wishes, setWishes] = useState<Wish[]>([]);
  /** The wishes as last reported, or null before the first report. */
  const wishQueries = useRef<Set<string> | null>(null);
  const [claims, setClaims] = useState<AutoClaim[]>([]);
  /* Until the ledger has loaded, acting would re-download everything already
     awaiting review from a previous session. State, not a ref, so the effects
     below re-run the moment it flips. */
  const [loaded, setLoaded] = useState(false);
  /** When each in-flight claim was first seen with no transfer, by user+path. */
  const missingSince = useRef<Map<string, number>>(new Map());
  /** When each in-flight claim's transfer entered a transient failure. */
  const failingSince = useRef<Map<string, number>>(new Map());
  /** Ticks while a claim is waiting, so the grace above is checked on time. */
  const [now, setNow] = useState(() => Date.now());

  // The wishlist itself — which wishes are auto, and their filters. Its own
  // small subscription rather than lifting WishlistView's state, so the
  // controller works with that screen closed.
  useEffect(() => {
    if (!client) return undefined;
    /* A removed wish's claim goes with it. The engine drops it from the
       ledger on remove, but this hook holds its own copy and writes the whole
       list back, which used to bring the claim straight back. */
    const apply = (items: Wish[]) => {
      setWishes(items);
      wishQueries.current = new Set(items.map((w) => w.query));
      setClaims((prev) => {
        const kept = prev.filter((c) => wishQueries.current!.has(c.query));
        return kept.length === prev.length ? prev : kept;
      });
    };
    const off = client.on('wishlist.state', (d) => apply((d as WishlistState).items));
    const stop = readUntilAnswered<WishlistState>(client, 'wishlist.list', undefined, (s) => apply(s.items));
    return () => { off(); stop(); };
  }, [client]);

  // The claim ledger, read on connect so an awaiting-review candidate survives
  // a restart. A failed read is RETRIED, never taken as an empty ledger: the
  // sidecar replaces the whole ledger on every write, so acting on "empty"
  // erased everything awaiting review and downloaded it all again.
  useEffect(() => {
    if (!client) return undefined;
    // A new client is a reconnect or a restarted engine: nothing may act on
    // the claims held from before until the ledger has been read again, or a
    // write-back of the old copy replaces the newer one on disk.
    setLoaded(false);
    let live = true;
    let timer = 0;
    const load = () => {
      void client.request<AutoClaimList>('wishlist.claimsList')
        .then((r) => {
          if (!live) return;
          setClaims(r.items);
          setLoaded(true);
        })
        .catch(() => { if (live) timer = window.setTimeout(load, 5_000); });
    };
    load();
    return () => { live = false; window.clearTimeout(timer); };
  }, [client]);

  const persist = useCallback((next: AutoClaim[]) => {
    const known = wishQueries.current;
    const items = known ? next.filter((c) => known.has(c.query)) : next;
    setClaims(items);
    // Said, not swallowed: a ledger that did not save means a file awaiting
    // review can vanish at the next launch, and be downloaded again.
    void client?.request('wishlist.claims', { items })
      .catch((e) => reportFailure('Save the auto-download list', e));
  }, [client]);

  // The reaction: start downloads for eligible wishes as results arrive.
  useEffect(() => {
    if (!client || !loaded || !online) return;
    const live = claims.filter((c) => c.status !== SKIPPED);
    const claimed = new Set(live.map((c) => c.query));
    const slotsFree = MAX_INFLIGHT - live.filter((c) => c.status === DOWNLOADING).length;
    if (slotsFree <= 0) return;
    const skipped = new Set(
      claims.filter((c) => c.status === SKIPPED).map((c) => skipKey(c.query, c.user, c.path)),
    );

    const sourcesByQuery = Object.fromEntries(
      Object.entries(wishHits.byQuery).map(([query, hit]) => [query, hit.sources]),
    );

    const plan = planAutoDownloads(wishes, sourcesByQuery, claimed, slotsFree, skipped, rules);
    if (plan.length === 0) return;

    for (const item of plan) {
      void transfers.enqueue(item.source.user, item.source.path, item.source.size).catch(() => {});
    }
    persist([
      ...claims,
      ...plan.map((item): AutoClaim => ({
        query: item.query,
        user: item.source.user,
        transferId: '',
        path: item.source.path,
        status: DOWNLOADING,
      })),
    ]);
  }, [client, loaded, online, wishes, claims, wishHits.byQuery, transfers, persist, rules]);

  // A claim that is waiting needs a clock: if its transfer never appears,
  // nothing else will change to re-run the check below.
  const waiting = claims.some((c) => c.status === DOWNLOADING && !c.transferId);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  // When a claimed download finishes, analyse it and hand it to review. The
  // transfer is found by its natural key (user + path); the spectrogram then
  // computes in the background and the review card shows it when ready, exactly
  // as the manual Verify does — the automation never reads the verdict itself.
  useEffect(() => {
    if (!client || !loaded) return;
    // The real clock, not `now`: `now` only wakes this effect up, and can be
    // minutes stale when a claim is made, which would skip it on sight.
    const at = Date.now();
    let changed = false;
    const next: AutoClaim[] = [];
    for (const c of claims) {
      if (c.status !== DOWNLOADING) { next.push(c); continue; }
      const natural = `${c.user}\n${c.path}`;
      const t = transfers.all.find((x) => x.username === c.user && x.path === c.path);
      if (!t) {
        // Not appeared yet (enqueue is async) — wait, but not for ever. Then
        // the claim is DROPPED, not skipped: a transfer that never appeared
        // says nothing against that copy (offline, a refused enqueue, a row
        // cleared by hand), so the wish is free to try again, it included.
        const since = missingSince.current.get(natural) ?? at;
        missingSince.current.set(natural, since);
        if (at - since >= MISSING_GRACE_MS) {
          missingSince.current.delete(natural);
          changed = true;
        } else {
          next.push(c);
        }
        continue;
      }
      missingSince.current.delete(natural);
      if (t.state === 'finished') {
        failingSince.current.delete(natural);
        analysis.analyseTransfer(t.id);
        next.push({ ...c, transferId: t.id, status: AWAITING });
        changed = true;
      } else if (TRANSIENT.has(t.state)) {
        const since = failingSince.current.get(natural) ?? at;
        failingSince.current.set(natural, since);
        if (at - since >= TRANSIENT_GRACE_MS) {
          failingSince.current.delete(natural);
          transfers.clear([t.id]);
          next.push({ ...c, status: SKIPPED });
          changed = true;
        } else {
          next.push(c);
        }
      } else if (isFailed(t.state) || isCancelled(t.state)) {
        // Final: Seek could not write it, you cancelled it, or the peer said
        // no. Remember the copy so the next pass picks a different one.
        // ('rejected' used to be in none of these lists, so a refused copy
        // held its slot for ever.)
        failingSince.current.delete(natural);
        next.push({ ...c, status: SKIPPED });
        changed = true;
      } else {
        failingSince.current.delete(natural);
        next.push(c);
      }
    }
    if (changed) persist(capSkips(next));
  }, [client, loaded, claims, transfers, analysis, persist, now]);

  // Approve: keep the file — it becomes an ordinary completed download once its
  // claim is gone — and end the wish, which is answered. wishlist.remove also
  // drops the server-side claim and the auto flag; we drop our copy to match.
  const approve = useCallback((query: string) => {
    void client?.request('wishlist.remove', { query })
      .catch((e) => reportFailure('Finish the wish', e));
    persist(claims.filter((c) => c.query !== query));
  }, [client, claims, persist]);

  // Reject: discard this copy and resume. The wish and its auto flag stay, so
  // the next run looks for another copy — and this one is remembered as
  // skipped, because the planner reads the same results and would otherwise
  // choose it again at once.
  const reject = useCallback((query: string) => {
    const claim = claims.find((c) => c.query === query && c.status !== SKIPPED);
    if (claim?.transferId) transfers.clear([claim.transferId]);
    persist(capSkips(claims.map((c) => (c === claim ? { ...c, status: SKIPPED } : c))));
  }, [claims, transfers, persist]);

  return { claims, approve, reject };
}

/** Keep at most SKIP_CAP skipped entries per wish, dropping the oldest. */
function capSkips(claims: AutoClaim[]): AutoClaim[] {
  const counts = new Map<string, number>();
  const keep = new Array<boolean>(claims.length).fill(true);
  for (let i = claims.length - 1; i >= 0; i -= 1) {
    const c = claims[i];
    if (c.status !== SKIPPED) continue;
    const n = (counts.get(c.query) ?? 0) + 1;
    counts.set(c.query, n);
    if (n > SKIP_CAP) keep[i] = false;
  }
  return claims.filter((_c, i) => keep[i]);
}
