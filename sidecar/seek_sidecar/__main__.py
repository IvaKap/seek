# Seek — sidecar entry point.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
#   python -m seek_sidecar --token <token> [--port 0] [--print-endpoint]
#
# This MUST stay a real importable file rather than a `-c` snippet or a heredoc:
# pynicotine.shares scans shares via multiprocessing with the *spawn* start
# method, which re-imports __main__ in the child. A non-file __main__ makes that
# child die with FileNotFoundError (RECON.md §2).

import argparse
import json
import logging
import os
import signal
import sys

from .core_host import CoreHost
from .server import Bridge, generate_token

DEFAULT_APP_SUPPORT = os.path.expanduser("~/Library/Application Support/Seek")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="seek-sidecar")
    parser.add_argument(
        "--token",
        help="shared secret the client must present. Read from SEEK_TOKEN if "
             "unset; generated and printed if neither is given.",
    )
    parser.add_argument("--host", default="127.0.0.1",
                        help="loopback address to bind (default 127.0.0.1). "
                             "Non-loopback addresses are refused.")
    parser.add_argument("--port", type=int, default=0,
                        help="port to bind; 0 picks a free one (default)")
    parser.add_argument("--app-folder", default=DEFAULT_APP_SUPPORT,
                        help="where Seek keeps its own config and data. Must "
                             "NOT be the user's Nicotine+ folder.")
    parser.add_argument("--print-endpoint", action="store_true",
                        help="print {host, port, token} as JSON on stdout once "
                             "listening, for the Tauri shell to read")
    parser.add_argument(
        "--enable-shares", action="store_true",
        help="share files back to the Soulseek network. OFF by default: it "
             "exposes the user's filesystem, and Soulseek is a reciprocal "
             "network, so this belongs to a deliberate Settings choice rather "
             "than a sidecar default.",
    )
    parser.add_argument(
        "--allow-origin", action="append", default=[], metavar="ORIGIN",
        help="permit a browser Origin to connect, e.g. http://localhost:5273 "
             "for the Vite dev server. Repeatable. Omitted by default, which "
             "refuses every Origin — a packaged desktop client sends none. "
             "Exact match; wildcards are ignored.",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
        stream=sys.stderr,
    )

    token = args.token or os.environ.get("SEEK_TOKEN") or generate_token()

    bridge = Bridge(token=token, host=args.host, port=args.port,
                    allowed_origins=args.allow_origin)
    port = bridge.start()
    if args.allow_origin:
        logging.getLogger("seek.main").warning(
            "browser origins permitted: %s — the token remains the only real "
            "gate", ", ".join(args.allow_origin))

    host = CoreHost(
        bridge,
        config_folder=os.path.join(args.app_folder, "config"),
        data_folder=os.path.join(args.app_folder, "data"),
        enable_shares=args.enable_shares,
    )
    host.start()

    if args.print_endpoint:
        print(json.dumps({"host": args.host, "port": port, "token": token}),
              flush=True)

    def shutdown(_signum, _frame):
        host.stop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, shutdown)

    try:
        host.run_forever()
    finally:
        bridge.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
