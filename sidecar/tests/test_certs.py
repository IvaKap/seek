"""
Seek — outbound HTTPS is verified against a trust store we ship.
SPDX-License-Identifier: GPL-3.0-or-later

THE BUG THIS PINS: the shipped bundle had no CA certificates, so every Bandcamp,
Discogs and YouTube lookup failed with CERTIFICATE_VERIFY_FAILED — while the
same code passed every test, because tests run from the venv, where OpenSSL's
default path is real. Dev was the configuration that hid it.

A test that only asserts "lookups work" would therefore have stayed green
throughout. So these assert the two things that were actually untrue in the
frozen build: that certifi is present to be frozen, and that both call sites
pass its context rather than letting urlopen build the default one.
"""

import ssl

import pytest

from seek_sidecar import certs, discover, enrich


def test_certifi_is_installed():
    """It is a runtime dependency, not an optional extra: the freeze can only
    bundle a trust store that exists at build time."""
    certifi = pytest.importorskip("certifi")
    assert certifi.where()


def test_the_context_carries_loaded_roots():
    ctx = certs.ssl_context()
    assert isinstance(ctx, ssl.SSLContext)
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.get_ca_certs(), "a context with no roots verifies nothing"


def test_the_context_is_built_once():
    """`urlopen` runs per artwork fetch and per tracklist row; re-parsing the CA
    bundle each time is waste, and re-parsing it under threads is a race."""
    assert certs.ssl_context() is certs.ssl_context()


def test_verification_is_not_disabled():
    """The other way to make CERTIFICATE_VERIFY_FAILED go away is to stop
    checking. That would silently accept any certificate on the network, so it
    is pinned as a thing this must never become."""
    ctx = certs.ssl_context()
    assert ctx.check_hostname is True
    assert ctx.verify_mode is not ssl.CERT_NONE


@pytest.mark.parametrize("module,func", [
    (discover, "_fetch"),
    (enrich, "_get"),
])
def test_every_fetch_site_passes_the_context(module, func, monkeypatch):
    """The regression itself: a call site that omits `context=` silently falls
    back to the default one and breaks again in the bundle only."""
    seen = {}

    class _Response:
        headers = {"Content-Type": "application/json"}

        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def fake_urlopen(request, timeout=None, context=None):
        seen["context"] = context
        return _Response()

    monkeypatch.setattr(module.urllib.request, "urlopen", fake_urlopen)
    getattr(module, func)("https://example.invalid/thing")

    assert seen["context"] is certs.ssl_context(), (
        f"{module.__name__}.{func} did not pass the bundled trust store"
    )
