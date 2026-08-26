# fixtures/

A recorded search session, for building and tuning the frontend without a
network, a sidecar, or a Soulseek account.

| File | What |
|---|---|
| `search-burial.ndjson` | One global search for `burial`. 1062 files from 46 peers across 127 frames, spanning 35.1 s. |
| `build_search_fixture.py` | Deterministic generator. Rebuild with `python3 fixtures/build_search_fixture.py`. |

## Provenance — read this

**Hand-authored, not captured live.** Reaching the real Soulseek network requires
a registered account, and this build has no credentials and did not create one.
Nothing here came off the wire.

What *is* real: the path conventions, the format mix, the peer-stat ranges, the
size arithmetic, and the arrival timing are all modelled on how Soulseek actually
behaves, and the file/attribute semantics are taken from reading
`upstream/pynicotine/slskmessages.py` (see `RECON.md` §4). What is *not* real: the
specific usernames, and the fact that a generator produced it rather than 46
strangers.

When a real capture becomes possible, `sidecar/seek_sidecar/record.py` writes this
exact format from a live session — swap the file and nothing downstream changes.

## Format

Newline-delimited JSON. One frame per line:

```json
{"offsetMs": 1840, "frame": {"ev": "search.result", "data": { ... }}}
```

- `offsetMs` — milliseconds since the search started. Replay by scheduling each
  line at its offset. This is the only field that is not part of the wire
  protocol; it exists because the protocol carries absolute timestamps and a
  replay needs relative ones.
- `frame` — a `Frame` exactly as defined in `shared/protocol.ts`. Every frame in
  the file is validated against the generated schema at build time, so the
  fixture cannot drift from the protocol.

Frames appear in `offsetMs` order: one `search.started`, then `search.result`
batches, then a final `search.closed`.

## What it deliberately exercises

Built so the hard cases in `docs/PRODUCT.md` §"The hard part" are all reachable
without waiting for the right stranger to show up.

**Arrival shape.** Nothing before 380 ms; a heavy burst of ~480 files in the
first 5 s; ~200/s tapering through 15 s; a thin straggler tail out to 35 s. Peers
with many matches send 2–3 separate responses rather than one. This is what the
"batch into 250 ms ticks" and "freeze insertions while scrolling" rules exist
for.

**Path messiness.** Twelve naming conventions across the peers, so the same
release looks like a different thing from each one:

```
@@ilqxr\Music\Burial - Untrue (2007) [FLAC]\02 - Archangel.flac
D:\Soulseek\Complete\Burial-Untrue-2007-320-XXL\02-burial-archangel.mp3
C:\Users\dan\Music\Hyperdub\HDBLP002 - Burial - Untrue\02. Burial - Archangel.mp3
@@vhtnp\Shared\Burial - Untrue [HDBLP002]\A2 Archangel.flac
share\_dubstep_uk\Burial - Untrue (2007) [HDBLP002] [FLAC]\02.flac
E:\DJ\_incoming\Dubstep\Burial - Archangel.mp3
```

Covered: `Artist - Title`, `NN. Title`, `NN - Artist - Title`, catalogue-number
prefixes, vinyl positions (`A2`, `B1`), scene-style underscored lowercase,
artist/year trees, label/catalogue trees, shouty `!!! ... !!!` folders, flat
dumps with no release folder at all, and — the hard one — **folders where the
file is nothing but a track number** (`02.flac`), so the artist and release exist
only in the parent folder name.

All paths are backslash-separated. Upstream rewrites `/` to `\` on parse, so a
forward slash can never reach the frontend; the generator asserts this.

**VA compilations.** Three, with `VA` as the folder artist and `NN. Artist -
Title` files. These break naive artist grouping — the folder says VA, the file
says Marcel Dettmann.

**Search-term false positives.** Soulseek matches query words against the whole
path, so `burial` also returns Deathspell Omega's *Burial At Sea*, a Gravediggaz
track, and a Miles Davis "Burial Mix". Any UI that assumes every result is by the
searched artist will look silly here, which is the point.

**Duplicates across users.** 20–22 distinct peers have each of the popular
tracks (`Archangel`, `Near Dark`, `Ghost Hardware`), in different formats, at
different sizes, from different folder layouts. Release sharing is power-law
weighted, so *Untrue* is nearly everywhere and *Antidawn* is on a handful.

**Peer variety.** Six archetypes: fast-and-free (8 MB/s, 0 queued), fast-but-
busy, modest, slow (11 KB/s), hoarders (1.4 M files, 300 queued), and tiny
shares. Countries vary and are sometimes null.

**Missing attributes.** Roughly 23 % of files carry **no audio attributes at
all** — no bitrate, no duration, nothing — because that is what peers on old
clients send. The remainder split into the two disjoint sets described in
`RECON.md` §4: lossless files carry duration + sample rate + bit depth and **no
bitrate**; lossy files carry bitrate + duration + VBR flag and **no sample rate
or bit depth**. There is no file with both. Any UI that assumes it always has a
bitrate will render blanks on a quarter of this fixture.

**Non-audio files.** 66 `.jpg` / `.cue` / `.log` / `.m3u` / `.nfo` files, all with
every attribute null, because real shared folders contain them and real searches
return them.

**Liars — the transcode cases.** Two distinct kinds, and they need two different
checks:

- **15 lossy upscales** across 6 peers. Advertised as `320`, but the byte size
  implies 128–192 kbps. `size × 8 / duration` contradicts the claim directly.
  This is the case `docs/PRODUCT.md` describes.
- **13 fake losslessness** from one peer (`shell_nyc` — realistic: one bad
  uploader poisons a whole batch). `.flac` extension, advertising 44100/16, but
  the size implies ~250 kbps, which no real 44.1/16 lossless file can be. Note
  these carry **no advertised bitrate to contradict** — lossless files never do.
  The check has to compare implied bitrate against
  `sampleRate × bitDepth × 2 channels`, not against a claim.

Some of `shell_nyc`'s fakes land in a `NN.flac`-style folder, so they exercise
low-confidence path parsing and transcode detection at the same time.

## Rebuilding

```
python3 fixtures/build_search_fixture.py
```

Seeded (`SEED = 20260810`), so it is byte-identical every run. Current output is
`sha256[:16] = 58b68af145ad92f2`. Every frame is passed through
`seek_sidecar.protocol.validate_event` before it is written — if the protocol
changes and the generator does not, the build fails rather than emitting a
fixture the frontend cannot parse.
