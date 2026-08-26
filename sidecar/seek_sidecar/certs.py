# Seek — the CA certificates outbound HTTPS is verified against.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# WHY THIS FILE EXISTS: a frozen build has no certificate store, and the failure
# does not look like one.
#
# `urllib.request.urlopen` with no explicit context builds one with
# `ssl.create_default_context()`, which asks OpenSSL where the trusted roots
# live. Running from the venv that answer is a real path on this machine and
# everything verifies. Inside the PyInstaller bundle it is a path baked in at
# BUILD time that need not exist on the machine the app was copied to, so every
# HTTPS request dies with:
#
#     [SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate
#
# Measured 2026-08-26 against the shipped bundle. What makes it expensive to
# diagnose is where it surfaces: Bandcamp, Discogs and YouTube all stop working
# at once, and the frontend reports the refusal as "Not a link Seek recognises".
# That reads as three broken parsers rather than one missing file — and the
# parsers pass their tests, because tests run from the venv where the default
# context works. Dev is the configuration that hides it.
#
# So the trust store is carried in the bundle rather than borrowed from the host:
# `certifi` is a dependency, PyInstaller collects its `cacert.pem`, and
# `certifi.where()` resolves inside the bundle at runtime.
#
# Every outbound request in the sidecar goes through this. There are two call
# sites — `discover._fetch` and `enrich._get` — and a third would be a bug.

import logging
import ssl
import threading

log = logging.getLogger("seek.certs")

_lock = threading.Lock()
_context = None


def ssl_context():
    """The SSL context for every outbound request. Built once, then reused.

    Parsing a CA bundle is not free and the roots do not change while the
    process runs, so this is cached — `urlopen` is called per artwork fetch and
    per tracklist row, not once.

    Falls back to the stock context when `certifi` is absent. That is the
    from-source case, where the host's own store is what dev has always used and
    is known to work; a hard failure there would break a working setup to guard
    against a problem it does not have.
    """
    global _context
    if _context is not None:
        return _context
    with _lock:
        if _context is not None:
            return _context
        try:
            import certifi
        except ImportError:
            log.debug("certifi absent; using the system trust store")
            _context = ssl.create_default_context()
        else:
            _context = ssl.create_default_context(cafile=certifi.where())
        return _context
