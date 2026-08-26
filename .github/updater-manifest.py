#!/usr/bin/env python3
"""
Seek — write the `latest.json` the in-app updater polls.

SPDX-License-Identifier: GPL-3.0-or-later

A separate script rather than a heredoc inside release.yml, because a Python
heredoc nested in a YAML block scalar has two competing indentation rules and
gets silently mangled the first time someone reindents the workflow.

WHAT THE UPDATER DOES WITH THIS. The app has one URL baked in — the manifest on
the newest published release — and the public half of a keypair baked into
`tauri.conf.json`. It fetches this file, compares `version` against its own, and
if it is newer downloads `url` and checks it against `signature` BEFORE writing
anything. So a compromised release endpoint cannot push a build: without the
private key the signature does not verify and the update is refused.

Both macOS entries point at the same file. Tauri builds a universal bundle here,
so `darwin-aarch64` and `darwin-x86_64` are the same bytes; listing both is how
the manifest format spells "either architecture".
"""

import argparse
import json
import sys


def build(version, signature, repo, pub_date, notes):
    url = (
        f"https://github.com/{repo}/releases/download/v{version}/Seek.app.tar.gz"
    )
    platform = {"signature": signature, "url": url}
    return {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": {
            "darwin-aarch64": platform,
            "darwin-x86_64": platform,
        },
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--version", required=True, help='e.g. "0.2.2", no leading v')
    ap.add_argument("--signature-file", required=True,
                    help="the .app.tar.gz.sig Tauri produced")
    ap.add_argument("--repo", required=True, help='"owner/name"')
    ap.add_argument("--pub-date", required=True, help="RFC 3339")
    ap.add_argument("--notes", default="See the release notes on GitHub.")
    ap.add_argument("--out", default="latest.json")
    args = ap.parse_args(argv)

    version = args.version.lstrip("v")

    with open(args.signature_file) as handle:
        signature = handle.read().strip()
    if not signature:
        # An empty .sig means the build ran without TAURI_SIGNING_PRIVATE_KEY.
        # Shipping that produces a manifest every client rejects, which looks
        # like "updates are broken" rather than "a secret is missing", so it
        # fails here instead.
        sys.exit("signature file is empty — was TAURI_SIGNING_PRIVATE_KEY set?")

    manifest = build(version, signature, args.repo, args.pub_date, args.notes)
    with open(args.out, "w") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
