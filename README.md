# Seek

A Mac client for the [Soulseek](https://www.slsknet.org/) network, built on
[Nicotine+](https://nicotine-plus.org/).

**Unofficial.** Not affiliated with, endorsed by, or connected to Soulseek or
the Nicotine+ project. It uses Nicotine+ as a library and is grateful for it.

---

## What it does differently

**You choose the copy.** Search results group into albums, and where several
people have the same record you get a comparison — track count, format, size,
whether their upload slot is free, how long their queue is, and your own
transfer history with them. Then you pick. The app never quietly swaps your
choice for one it prefers.

**It refuses to guess.** Where no single person has the whole album, it says
so and shows you what each person actually has, file by file, exactly as they
sent it. It will not claim that one person's "track 4" is the same recording
as another's, because that guess was measured on real data and was wrong more
often than it was right.

**Quality is explained, not asserted.** An MP3 whose size contradicts its
claimed bitrate gets flagged as a probable transcode, and the reasoning is
shown rather than reduced to a badge.

**Reliability means your own history.** "9 of 19 with you" is a fact from your
own transfer log. The protocol exposes nothing about how a stranger treats
anyone else, so nothing here pretends otherwise.

**Sharing is treated as the point, not a setting.** Soulseek is reciprocal —
peers deprioritise and ban clients that take without giving — so Seek shows
what you are uploading, what your share ratio actually is, and says plainly
when a slow queue is the consequence of sharing nothing.

Plus a discovery layer: paste a YouTube, Bandcamp or Discogs link and it
becomes a search; import a YouTube playlist or your Discogs wantlist onto a
want list; keep a watchlist of labels and work through their back catalogues;
identify a local file by its sound.

## Requirements

- macOS (Apple silicon or Intel)
- To build: [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/) 20+,
  Python 3.11+

## Install

### From a release

Download the `.app` from [Releases](../../releases), and drag it to
Applications.

**macOS will refuse to open it the first time.** The app is not signed with a
paid Apple Developer certificate, so macOS quarantines anything arriving from
the internet or AirDrop and declines to run it.

Clear the quarantine flag once, in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Seek.app
```

It prints nothing when it works. Seek then opens by double-clicking, for good.
The command removes the "came from the internet" tag macOS attached to the
download; it changes nothing about the app.

You may instead be offered **System Settings → Privacy & Security → Open
Anyway**, which does the same thing. That button is not always present, which
is why the command above is the instruction that ships with the app.

> **If you see "Seek is damaged and can't be opened"** on a build from before
> 25 Aug 2026, that build is the problem rather than your Mac. Its bundle was
> linker-signed — the signature covered the executable but sealed none of the
> resources — and Gatekeeper reads that as corruption rather than as an
> untrusted app, which is why no Open Anyway appears. Get a newer build;
> `release.sh` now refuses to produce one that way.

Building from source avoids all of this — an app you build yourself is never
quarantined.

### From source

```bash
git clone --recurse-submodules <this repo>
cd seek

# the Python engine
cd sidecar
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ..

# the app
cd app
npm install
npm run tauri build
```

The finished app lands in
`app/src-tauri/target/release/bundle/macos/Seek.app`.

`--recurse-submodules` matters: Nicotine+ is pinned as a submodule so that a
build is reproducible. Without it the engine has nothing to talk to.

## Optional extras

Everything below is off until you supply your own key, in **Settings →
External lookups**. Keys are stored in the app's own data folder, never in
this repository, and only ever leave your machine to reach the service they
belong to.

| Feature | Needs |
|---|---|
| Artwork, release data | Nothing — MusicBrainz and Cover Art Archive are open |
| Label and artist catalogues, related releases | A free [Discogs](https://www.discogs.com/settings/developers) token |
| Identify a file by its sound | A free [AcoustID](https://acoustid.org/new-application) key, plus `brew install chromaprint` |
| Import a YouTube playlist | A free [YouTube Data API v3](https://console.cloud.google.com/) key |

`chromaprint` is a separate install because the fingerprinting tool it
provides links against Homebrew's ffmpeg and cannot simply be copied into the
app. Everything else works without it.

## Development

```bash
cd sidecar && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=../upstream:. \
  .venv/bin/python -m seek_sidecar --print-endpoint --allow-origin http://localhost:5273
cd app && npm run dev
```

The engine prints a host, port and token; open
`http://localhost:5273/?sidecar=127.0.0.1:<port>&token=<token>`.

```bash
cd app && npm test          # 335 tests
cd app && npm run typecheck
cd sidecar && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=../upstream:. \
  .venv/bin/pytest tests/ -q # 483 tests
```

`./release.sh` does a full release build, and refuses to continue if the
frozen engine would ship stale code.

`RECON.md` documents what the Soulseek protocol actually provides — several
things the obvious assumption gets wrong — and `docs/PRODUCT.md` is the product
spec. Both are worth reading before changing anything at the seam between the
Python engine and the TypeScript frontend.

## Your responsibility

Seek is a client. What you search for, share and download is up to you, and so
is complying with the law where you live.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).

Seek uses [Nicotine+](https://github.com/nicotine-plus/nicotine-plus)
(GPL-3.0-or-later) as its protocol engine, pinned as a submodule. Because a
packaged build embeds Nicotine+, the corresponding source for everything in
the app is this repository plus that pinned submodule.
