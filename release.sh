#!/usr/bin/env bash
#
# Seek — build a release .app, and refuse to ship stale code.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The whole reason this exists: the Python engine is FROZEN into the bundle by
# PyInstaller, and freezing is a separate manual step. Change Python, forget to
# re-freeze, and the .app silently ships whatever was frozen last time. That is
# not hypothetical — a build was found carrying an engine four days old that was
# missing an entire feature (seek_sidecar.discover), while looking perfectly
# healthy from the outside.
#
# So this script freezes FIRST, then checks that every module in the source tree
# actually made it into the frozen binary, and stops if any did not.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$PWD"
say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -d upstream/pynicotine ] || die "upstream/ is empty — run: git submodule update --init"
[ -x sidecar/.venv/bin/python ] || die "no sidecar venv — see README, Build from source"

say "Submodule pinned at $(git -C upstream rev-parse --short HEAD)"

# The version is declared in four places that have no way of checking each
# other: the npm package (which the About screen now reads), the Tauri bundle,
# the Rust crate, and the sidecar's hello reply. A build whose About screen and
# filename disagree is a build nobody can identify afterwards — which matters
# most when someone is trying to say which one is broken.
say "Checking the version is consistent"
V_NPM=$(node -p "require('./app/package.json').version")
V_TAURI=$(node -p "require('./app/src-tauri/tauri.conf.json').version")
V_CARGO=$(grep -m1 '^version = ' app/src-tauri/Cargo.toml | sed 's/.*"\(.*\)"/\1/')
V_SIDECAR=$(grep -m1 '^SIDECAR_VERSION' sidecar/seek_sidecar/core_host.py | sed 's/.*"\(.*\)"/\1/')
for pair in "tauri:$V_TAURI" "cargo:$V_CARGO" "sidecar:$V_SIDECAR"; do
  [ "${pair#*:}" = "$V_NPM" ] || die "version drift: package.json is $V_NPM but ${pair%%:*} is ${pair#*:}"
done
printf '  all four agree on %s\n' "$V_NPM"

say "Engine tests"
( cd sidecar && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=../upstream:. \
    .venv/bin/pytest tests/ -q ) || die "engine tests failed"

say "App tests and type check"
( cd app && npm test --silent && npm run typecheck --silent ) || die "app checks failed"

say "Freezing the engine"
( cd sidecar && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=../upstream:. \
    .venv/bin/pyinstaller seek-sidecar.spec --noconfirm >/dev/null ) \
    || die "pyinstaller failed"

# --- the guard this script exists for -------------------------------------
say "Checking the freeze is not stale"
TOC="sidecar/build/seek-sidecar/PYZ-00.toc"
[ -f "$TOC" ] || die "no $TOC — cannot verify what was frozen"

missing=""
for f in sidecar/seek_sidecar/*.py; do
  mod="$(basename "$f" .py)"
  [ "$mod" = "__init__" ] && continue
  grep -q "seek_sidecar\.$mod" "$TOC" || missing="$missing $mod"
done
[ -z "$missing" ] || die "frozen engine is missing:$missing
The freeze did not pick up the current source. Do not ship this."

frozen_at=$(date -r sidecar/dist/seek-sidecar/seek-sidecar +%s)
newest_src=$(find sidecar/seek_sidecar -name '*.py' -exec stat -f %m {} \; | sort -rn | head -1)
[ "$frozen_at" -ge "$newest_src" ] || die "a source file is newer than the frozen binary"

count=$(ls sidecar/seek_sidecar/*.py | grep -vc __init__ || true)
printf '  all %s modules present, binary newer than every source file\n' "$count"

# The trust store is a DATA file, so none of the checks above would notice it
# missing: every module is present, the binary is fresh, and the app then fails
# every HTTPS lookup on the user's machine while working perfectly here. That
# shipped as 0.2.0. One `find` is cheaper than another release.
say "Checking the CA bundle was frozen"
CACERT="$(find sidecar/dist/seek-sidecar -name cacert.pem | head -1)"
[ -n "$CACERT" ] || die "no cacert.pem in the freeze — every Bandcamp, Discogs and
YouTube lookup will fail with CERTIFICATE_VERIFY_FAILED on any machine but this
one. Check that certifi is installed and that the spec collects its data files."
printf '  trust store at %s\n' "${CACERT#sidecar/dist/seek-sidecar/}"

say "Building the app"
( cd app && npm run tauri build ) || die "tauri build failed"

APP="app/src-tauri/target/release/bundle/macos/Seek.app"
[ -d "$APP" ] || die "no bundle produced"

say "Built $ROOT/$APP ($(du -sh "$APP" | cut -f1))"

# --- the second guard, and it exists for the same reason as the first ------
#
# A build shipped that was LINKER-SIGNED: the Rust linker's own signature,
# covering the Mach-O and nothing else, with the Info.plist unbound and no
# CodeResources sealing Contents/Resources — which this bundle definitely has,
# since the frozen engine lives there.
#
# It ran perfectly on the machine that built it, because a locally built app is
# not quarantined. The moment it was zipped and opened on another Mac,
# Gatekeeper read the mismatch as a BROKEN signature rather than an untrusted
# one and said "Seek is damaged and can't be opened" — with no Open Anyway,
# because that is only offered for an unidentified DEVELOPER, not for code that
# appears corrupt.
#
# `codesign --verify` catches it in one line. Nothing was checking.
say "Checking the signature is valid"
codesign --verify --deep --strict "$APP" 2>/dev/null \
  || die "the bundle's signature does not verify.
$(codesign --verify --deep --strict "$APP" 2>&1 | head -3)

Gatekeeper will call this 'damaged' on any machine but this one. Check that
bundle.macOS.signingIdentity is set in app/src-tauri/tauri.conf.json."

if codesign -dv "$APP" 2>&1 | grep -q "linker-signed"; then
  die "the bundle is LINKER-SIGNED, not codesigned. See the note above."
fi
printf '  signature verifies, resources sealed\n'

# Say plainly what this build is and is not, so nobody assumes otherwise.
if codesign -dv "$APP" 2>&1 | grep -q "Signature=adhoc"; then
  cat <<'NOTE'

  This build is AD-HOC SIGNED, which is valid but not TRUSTED: there is no
  Apple Developer identity behind it. A recipient sees "Apple could not verify
  Seek is free of malware" and has to allow it once — Privacy & Security →
  Open Anyway, or `xattr -dr com.apple.quarantine` on the app, which is the
  reliable route and the one the shipped READ ME uses. Removing the step
  entirely needs a paid Developer identity and a notarisation pass.
NOTE
fi

printf '\n  Version %s. Zip it with:\n' "$V_NPM"
printf '    ditto -c -k --sequesterRsrc --keepParent <staging dir> Seek-%s-macOS.zip\n' "$V_NPM"

if ! command -v fpcalc >/dev/null 2>&1; then
  echo "  Note: fpcalc not found; audio fingerprinting will be inert for users"
  echo "  who lack it too. It is not bundled — see README.md."
fi
