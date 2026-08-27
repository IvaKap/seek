#!/usr/bin/env bash
# Seek — fetch the fpcalc that ships inside the app.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# WHY A DOWNLOAD AND NOT `brew install`. Homebrew's fpcalc is not portable:
# `otool -L` on it lists @rpath/libchromaprint.1.dylib plus four Homebrew ffmpeg
# dylibs, so copying that binary into the bundle produces something that dies on
# any machine without an identical Homebrew tree. Measured, not assumed.
#
# The official release from acoustid links only OS libraries — libSystem,
# Accelerate, libz, libc++ — and is universal, so one file covers both
# architectures of a universal app. Verified with `otool -L` and `lipo -archs`.
#
# WHY IT IS NOT COMMITTED. A 2.6 MB binary in git, re-downloaded by every clone
# for ever, to save one scripted fetch at release time. The checksum below is
# what makes the fetch trustworthy; committing the file would only move the
# trust decision, not remove it.
#
# LICENSING, since this ships to other people:
#   * Chromaprint is LGPL-2.1-or-later.
#   * The binary statically links FFmpeg, which is LGPL-2.1-or-later by default
#     and GPL-2-or-later when built --enable-gpl. Both are compatible with
#     Seek's GPL-3.0-or-later. Inspected: no libx264/libx265/postproc wrapper
#     strings, and the x264/xvid hits are decoder FOURCCs, which are LGPL.
#   * It is shipped UNMODIFIED and invoked as a separate process, never linked
#     into Seek. README credits it and links the exact source tarball.

set -euo pipefail

VERSION="1.6.1"
ARCHIVE="chromaprint-fpcalc-${VERSION}-macos-universal.tar.gz"
URL="https://github.com/acoustid/chromaprint/releases/download/v${VERSION}/${ARCHIVE}"

# Pinned. The whole point of fetching rather than committing: if this does not
# match, the build stops rather than bundling something nobody looked at.
SHA256="240aeb5a8c8205af458e3625cb7487b826b711a999e491ef00111f3cebd76f00"

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/vendor/fpcalc"

die() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }

# Idempotent: a correct copy is left alone, so `release.sh` can call this every
# time without a network round trip on every build.
if [ -x "$DEST" ]; then
  if [ "$("$DEST" -version 2>/dev/null | head -1)" != "" ]; then
    printf '  fpcalc %s already vendored\n' "$VERSION"
    exit 0
  fi
fi

mkdir -p "$HERE/vendor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

printf '  fetching %s\n' "$ARCHIVE"
curl -fsSL -o "$TMP/$ARCHIVE" "$URL" || die "could not download $URL"

GOT="$(shasum -a 256 "$TMP/$ARCHIVE" | cut -d' ' -f1)"
[ "$GOT" = "$SHA256" ] || die "checksum mismatch for $ARCHIVE
  expected $SHA256
  got      $GOT
This is either a corrupted download or a changed upstream artifact. Do not
bundle it until someone has worked out which."

tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
FOUND="$(find "$TMP" -name fpcalc -type f | head -1)"
[ -n "$FOUND" ] || die "no fpcalc inside $ARCHIVE"

# Refuse anything that would die on a machine other than this one — the exact
# failure that kept Homebrew's copy out of the bundle.
# On a universal binary `otool -L` prints a header line per slice
# ("path (architecture arm64):"), so match only real dependency lines — those
# are the tab-indented ones — before deciding what is external.
deps() { otool -L "$1" | grep $'^\t' | sed 's/^\t//; s/ (compatibility.*//'; }
EXTERNAL="$(deps "$FOUND" | grep -vE '^/usr/lib/|^/System/Library/' | grep -c . || true)"
[ "$EXTERNAL" -eq 0 ] || die "fpcalc links libraries outside the OS, so it would
die on any machine without them:
$(deps "$FOUND" | grep -vE '^/usr/lib/|^/System/Library/' | sed 's/^/    /')"

ARCHS="$(lipo -archs "$FOUND" 2>/dev/null || echo "?")"
case "$ARCHS" in
  *arm64*x86_64*|*x86_64*arm64*) ;;
  *) die "fpcalc is not universal (got: $ARCHS) — half the users would get nothing" ;;
esac

install -m 755 "$FOUND" "$DEST"
printf '  vendored fpcalc %s (%s) -> %s\n' "$VERSION" "$ARCHS" "${DEST#"$HERE/"}"
