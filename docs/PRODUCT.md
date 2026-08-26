# Seek — product spec

Reconciles Iva's vision note (`Tolaria Vault/Getting Started/Bin Laden/nicotine-fork.md`)
with this document, this document, and the verified findings in `RECON.md`.

**Precedence when documents disagree:** `RECON.md` (what the protocol actually
gives us) > this file (what we're building) > this document (how it was first
sketched) > this document (visual system only).

---

## 1. The thesis

Not "a prettier Nicotine+". This:

> The best desktop tool for discovering, evaluating, and building a
> high-quality music collection from Soulseek.

Soulseek is already an extraordinary decentralised music search engine. The
opportunity is an **intelligence layer** on top of it.

The loop is **Search → Evaluate → Compare → Download → Verify → Organise**,
replacing Nicotine+'s *search → stare at table → double-click → hope*.

**The evaluation step is the product.** Everything else is plumbing. A user
searching `Burial - Untrue` is not asking for *a file* — they're asking: is this
really lossless, is it a transcode, is the folder complete, is this uploader
worth waiting on. The UI answers those in the first second of looking.

Design philosophy: **simple on first contact, extremely deep when you need it.**
A casual user searches, clicks an album, hits Download. A collector spends thirty
minutes on FLAC → 24-bit → complete release → verified lossless → preferred
users → tagged → organised, and the UI never gets in the way.

---

## 2. Information architecture

The vision note's grouped sidebar supersedes this document's four flat items.
A grouped sidebar is *more* Mac-native, not less — Finder, Music and Mail all do
exactly this. But it needs tightening; the note's version has redundancy.

```
SEEK

⌕  Search

LIBRARY
   Downloads          ← active + queued, the live surface
   Completed
   Failed

DISCOVERY
   Search History
   Saved Searches
   Collections        ← Tier 3; hidden until the library index exists

USERS
   Followed
   Browsing           ← only present while a browse session is open

────────────────
⚙  Settings
```

Changes from the note, with reasons:

- **`TOOLS > Transfer Queue` removed.** It duplicates `LIBRARY > Downloads`. One
  concept, one place.
- **`TOOLS > Logs` removed from primary nav.** A debug surface in the navigation
  backbone is the GTK-era instinct the redesign exists to escape. Put it behind
  Settings → Advanced, or a `⌘K` command.
- **`Active` folded into `Downloads`.** "Downloads" that excludes active
  downloads is a surprising empty state.
- **`USERS > User Files` → `Browsing`,** and it only appears while a browse is
  open. A permanently visible nav item that is usually empty is dead chrome.

Sections collapse and their state persists. `⌘1–4` map to Search, Downloads,
Completed, Settings.

---

## 3. Search — the centrepiece

Large search field, quick-filter pills directly beneath it, results below.
Filters are **pills, never buried menus** (this matches this document's
"persistent, always-visible filter bar", so the two documents agree).

```
Search Soulseek
┌───────────────────────────────────────────────┐
│ Burial Untrue                          ⌘↵     │
└───────────────────────────────────────────────┘

FLAC   WAV   ALAC   MP3   24-bit   16-bit   >320kbps   Lossless only

37 results
```

Advanced filtering slides down from the pill row rather than opening a modal.

Ship the full filter set: format multi-select, bit depth, sample rate, MP3
bitrate, min bitrate, lossless-only, duration range, size range,
exclude-transcodes, free-slots-only, min peer speed, max queue length, filename
include/exclude.

Plus the release-structure filters from the note, which are genuinely
differentiating and cheap once results are grouped by folder:

- Prefer complete album folders
- Hide individual tracks when an album exists
- Show/hide compilations, singles, duplicates

Behaviour is unchanged from this document: client-side, instant, re-applies to
still-streaming results, animates rows out rather than blanking, per-tab, and
survives restart. Presets ("my usual") in one click.

---

## 4. Results — release cards, not a spreadsheet

The single biggest visual change. Group `(user, parent folder)` into a release
card; the unit a DJ downloads is a folder, not a file.

```
┌──────────────────────────────────────────────┐
│ [art]  Burial                                │
│        Untrue                                │
│        2007 · Hyperdub                       │
│                                              │
│        FLAC · 16/44.1 · 421 MB               │
│        10 tracks · 6 sources                 │
│                                              │
│        ● Recommended source                  │
│        electronichead · 8.4 MB/s             │
│                                              │
│        [Preview] [View sources] [↓ Download] │
└──────────────────────────────────────────────┘
```

Expanding shows sources ranked by score, not by arrival order.

**Two orthogonal controls, and they must not compete for the same space:**

- **Grouping** — Track · Release · User (this document)
- **Density** — Comfortable · Compact · Table (vision note §18)

Grouping is a primary segmented control in the results header. Density is a
view-menu affordance in the toolbar, the way Finder does it. Two segmented
controls side by side in one header is exactly the density the redesign is
trying to remove.

Table density preserves the full power-user column set. **Do not hide Soulseek's
power-user nature — that is part of its charm.** Comfortable is the default.

---

## 5. Quality — explainable, never arbitrary

Four states, each with a glyph, a label and a "why". Colour is never the only
signal (this document §14).

| | Meaning |
|---|---|
| ● **Excellent** | Lossless, high resolution — FLAC 24/96, checks pass |
| ● **Good** | Lossless, standard resolution — FLAC 16/44.1 |
| △ **Suspicious** | Lossless container, but the numbers don't add up |
| × **Likely transcode** | Strong evidence of a lossy source |
| ○ **Unverified** | **Not enough metadata to check.** Not the same as "clean". |

Clicking the indicator explains the arithmetic. The user's instinct here is
right and it is load-bearing: **never state it as definitive.** Language is
"likely lossless", "possible transcode", "strong signs of a lossy source",
"inconclusive" — never "FAKE FLAC".

The fifth state, **Unverified**, is not in the vision note but is mandatory.
`RECON.md` §4 found that roughly a quarter of real results carry no audio
attributes at all. Rendering those as "clean" would be confidently wrong about
exactly the thing the user is trusting us on.

---

## 6. Spectral analysis — and why it matters more than the note realises

The note proposes this as a nice-to-have Tier 3 feature. It is more important
than that, because of what the recon found.

`RECON.md` §4 established that the size-arithmetic transcode check
(`size × 8 / duration` vs advertised bitrate) **cannot run on lossless files at
all** — the protocol sends no bitrate for FLAC/WAV/AIFF, so there is no claim to
contradict. The single feature this document called the project's
justification does not work on the format the target user cares most about.

**Spectral analysis is the answer to that gap.** A lowpass shelf around 16–20 kHz
in a file claiming to be FLAC is real evidence of an MP3 source, and it needs no
cooperation from the uploader's metadata. It is the only check that works where
the metadata check structurally cannot.

**Critical scoping constraint:** spectral analysis needs the actual audio bytes,
so it can only run **after** download. It cannot inform the search-time decision.
So the two checks live at different points in the loop and must not be conflated:

| Stage | Check | Confidence |
|---|---|---|
| **Evaluate** (pre-download) | Metadata arithmetic — lossy only; lossless gets the weak compression-ratio heuristic; no duration means no check | Low–medium, always provisional |
| **Verify** (post-download) | Decode → FFT → lowpass detection | Medium–high, still never definitive |

The search-time badge is a **prediction**. The post-download result is a
**finding**. The UI must distinguish them; a file that passed search-time
heuristics and then failed spectral analysis should visibly update, because that
is the moment the app earns its keep.

**Implementation:** native module in the Python sidecar, per the note's own §3
preference — decode (ffmpeg or `soundfile`), FFT (`numpy`), spectrogram, lowpass
cutoff detection, then emit raw analysis data. Rendering is the frontend's job,
per the standing rule that Python formats nothing.

Do not vendor Spek. It is GPLv3 and therefore licence-compatible with this fork,
but we need decode + FFT, which is a few hundred lines against numpy, not an
application. Credit the approach; don't inherit a GUI.

---

## 7. Downloads as objects, not transfer rows

A download is a **release**, not a collection of cryptic rows.

```
ACTIVE

Burial — Untrue
████████████████░░░░  76%
8 / 10 files · 312 / 421 MB · ETA 00:42
```

Per-file detail is progressive disclosure — expand the release to see it. The
user should not think about individual files unless something goes wrong, and
when something does go wrong the failing file should surface itself.

Album-level download is first-class: one action, one folder, one peer.

**Corrected — "the app picks sources" is withdrawn.** This line once read "one
action, the app picks sources", and it was built: Get ranked every copy in the
results and quietly took the best one. Iva's instruction overrides it — "I don't
want the app to choose what to download, I need to see the data myself, and
decide what to download myself" — after it handed over a stranger's 13-track
copy when a 9-track card had been clicked. **Get downloads the copy that was
clicked.** The ranking is still computed and still shown; it orders the
comparison (`ui/CopiesSheet.tsx`) that the user picks from. See §8, which was
always right about this: rank, and SHOW the reasoning.

Note `RECON.md` §5: **upstream has no stall detection at all** — no event, no
timer, no status. Every "stalled" affordance in this spec is ours to build from
progress deltas.

---

## 8. Sources ranked, with the reasoning shown

Combined score from format quality, free slots, queue length, advertised speed,
album completeness, and our own historical success rate with that peer
(persisted locally). Default sort, descending.

```
● Recommended
  electronichead
  FLAC · 421 MB · 8.4 MB/s · complete album · 98% success with you
```

**Reliability stats must be derived from our own interaction history only.** The
note is explicit and correct about this: never pretend to know things the
protocol doesn't expose. "97% successful transfers" means *with us*, and the UI
should say so rather than implying a global reputation we cannot see.

---

## 9. Deferred, with reasons

**Collector Mode (note §24)** — the note itself is unsure, and it should be cut.
A mode toggle bifurcates the interface and forces a choice before the user knows
what they want. Progressive disclosure achieves the same goal without the fork:
the collector features are always present, just not always in front. This is
also what this document §10 and Apple's own patterns argue for.

**Boolean/rule-engine download preferences (note §26)** — the simple preference
list ("prefer FLAC", "reject below 256", "reject suspicious transcodes") is Tier
2 and worth building. The `IF format = FLAC AND sample_rate >= 96 THEN...` rule
builder is Tier 4 and is a product in itself. Ship the preference list; revisit
the rule engine only if the presets prove insufficient.

**Collection intelligence / "find missing albums" (note §13)** — genuinely one of
the best ideas here, and it needs a library index plus reliable MusicBrainz
release matching to exist first. Sequenced after both, not before.

---

## 9a. First run, credentials and shares — decided

**Credentials: explicit import, never automatic.** Iva already runs Nicotine+ on
this machine (`~/.config/nicotine/config`). Seek offers an **"Import from
Nicotine+"** action in Settings that reads server credentials and share
configuration from that file. It is triggered by the user, never on startup,
never silently, and the UI states plainly what it will read before it reads it.

Hard rule for development: **build the importer, do not run it against Iva's real
config.** Test it against synthetic config fixtures only. The user runs it on
their own data themselves.

**Shares: prompt on first run.** Not a silent default in either direction. First
run explains the reciprocity honestly — Soulseek peers deprioritise and ban
clients that share nothing — and asks the user to choose a folder. Nothing is
ever shared without an explicit choice, but the app actively steers toward being
a good peer rather than letting the user drift into leeching without realising.

If the user declines, Seek says so plainly in Settings and surfaces a quiet
persistent indicator, because the consequence (throttled transfers, refused
queues) would otherwise look like a bug in the app rather than the network
working as designed.

Seam: **core** owns the share-configuration API, the scan, and the importer.
**app** owns the first-run flow and the Settings surface.

---

## 10. Platform corrections that still apply

Restated because the vision note reintroduces two things already ruled out:

1. **SF Symbols cannot be used** (note §21). Licensed for Apple platforms only;
   this is a webview. Lucide behind a single wrapper, stroke width derived from
   render size. Settled — see this document.
2. **`NSVisualEffectView` is reachable, but not from CSS.** Tauri v2 exposes
   native macOS window vibrancy through its window-effects API. Use the real
   material for the window and sidebar where possible and `backdrop-filter` only
   for in-content layers. This is better than the pure-CSS approach previously
   planned and worth doing properly.
3. Everything else in note §21–22 — sidebar, toolbar, native context menus,
   sheets, popovers, drag & drop, Quick Look, native notifications, system
   appearance, "nothing bounces or animates simply because it can" — **agrees**
   with `apple-design` and the existing motion spec. No conflict.

---

## 11. Tiering

**Tier 1 — essential.** Native macOS shell, redesigned search, release grouping,
format/bit-depth/sample-rate filters, quality states incl. Unverified, download
manager, density modes, keyboard navigation, drag & drop, native notifications,
light/dark.

**Tier 2 — genuinely better.** Release recognition, MusicBrainz + artwork,
source ranking with shown reasoning, user browsing, saved searches, duplicate
detection, simple download preferences.

**Tier 3 — special.** Spectral analysis and post-download verification, album
completeness, audio preview, automatic organisation and tagging, collection
tracking.

**Tier 4 — power user.** Command palette (`⌘K`), boolean/regex search, custom
scoring weights, automation rules, plugins, collection statistics.

`⌘K` is Tier 4 by the note's own ranking, but it is cheap once the action
surface exists and it is the fastest route to "this feels like a real Mac app".
Build it as soon as there are enough commands to be worth palette-ing.

---

## 12. What changes for each agent

**app** — the sidebar is grouped, not four flat items (§2). Results are release
cards by default (§4). Quality has five states including Unverified, each with
glyph + label + explanation (§5). Grouping and density are separate controls in
separate places (§4). Downloads are release objects (§7). Use Tauri's native
vibrancy rather than CSS-only translucency (§10).

**core** — spectral analysis is a sidecar module and is promoted in importance,
because it is the only transcode check that works on lossless (§6). Emit raw
analysis data and format nothing. Stall detection is ours to build (§7). Peer
reliability is persisted from our own transfer history only (§8).
