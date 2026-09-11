# Seek — the shares component must always be enabled.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Regression guard for the "Sidecar unreachable" crash. Upstream's download
# re-enqueue path dereferences `core.shares.initialized` unconditionally
# (downloads.py `_enqueue_transfer`), so if Seek boots without the shares
# component, `core.shares` is None and the engine dies the instant a restored
# queued download's peer comes online. `start()` must add it every time,
# whatever the sharing consent.
#
# `CoreHost.start()` is tiny and touches only core/init_components/start plus
# _connect_events, so we drive it on a bare instance rather than booting the
# real pynicotine core (test_integration.py owns the one allowed instance).

from seek_sidecar.core_host import CoreHost, BASE_COMPONENTS, SHARES_COMPONENT


class _FakeCore:
    shares = object()   # a real object once init_components ran; never None

    def __init__(self):
        self.enabled = None
        self.started = False

    def init_components(self, enabled_components=None):
        self.enabled = set(enabled_components or ())

    def start(self):
        self.started = True


class _FakeConfig:
    # No stored login, so start() logs "staying signed out" and never connects.
    sections = {"server": {"auto_connect_startup": False}}


def _host():
    host = CoreHost.__new__(CoreHost)   # bypass __init__ (which boots upstream)
    host.core = _FakeCore()
    host.config = _FakeConfig()
    host._connect_events = lambda: None
    host._running = False
    host.enable_shares = False
    host._stored_consent = lambda: "declined"
    return host


def test_shares_is_enabled_even_when_not_sharing():
    host = _host()
    host.start()
    assert SHARES_COMPONENT in host.core.enabled
    assert host.core.started is True


def test_shares_is_enabled_when_sharing_too():
    host = _host()
    host._stored_consent = lambda: "granted"
    host.start()
    assert SHARES_COMPONENT in host.core.enabled


def test_the_base_components_are_still_all_there():
    host = _host()
    host.start()
    assert BASE_COMPONENTS <= host.core.enabled
