"""
Seek — why we are signed out.
SPDX-License-Identifier: GPL-3.0-or-later

A person was signed out "randomly" and Seek would not sign back in, and the
log said nothing either way. The cause was a second Seek on the same account:
the server signs the older session out and upstream, rightly, does not fight
back. These pin that the reason now reaches the app and the log.
"""

import logging
import os
import types

import pynicotine  # noqa: F401  — installs the gettext `_` the host compares with

from seek_sidecar.core_host import CoreHost

RELOGGED = "Someone logged in to your Soulseek account elsewhere"


def _host():
    host = object.__new__(CoreHost)
    host.broadcasts = []
    host.bridge = types.SimpleNamespace(broadcast=lambda n, d: host.broadcasts.append((n, d)))
    host.searches = types.SimpleNamespace(close_all=lambda _reason: [])
    host.core = types.SimpleNamespace(users=types.SimpleNamespace(login_status=2), disconnect=lambda: None)
    host.config = types.SimpleNamespace(sections={"server": {}}, write_configuration=lambda: None)
    host.UserStatus = types.SimpleNamespace(OFFLINE=0, ONLINE=2, AWAY=1)
    host._connection = {"status": "online", "username": "me", "publicAddress": "1.2.3.4", "error": None}
    return host


def _last_state(host):
    return [d for n, d in host.broadcasts if n == "connection.state"][-1]


def test_signed_in_elsewhere_is_said_and_logged(caplog):
    host = _host()
    host._on_upstream_log("%x %X", _(RELOGGED), None, 0)  # noqa: F821
    with caplog.at_level(logging.INFO, logger="seek.core"):
        host._on_server_disconnect(types.SimpleNamespace(manual_disconnect=True))
    assert _last_state(host)["error"] == "relogged"
    assert _last_state(host)["status"] == "offline"
    assert "relogged" in caplog.text


def test_any_other_log_line_is_not_taken_for_it():
    host = _host()
    host._on_upstream_log("%x %X", "Disconnected from server", None, 0)
    host._on_server_disconnect(types.SimpleNamespace(manual_disconnect=False))
    assert _last_state(host)["error"] is None


def test_the_server_ending_the_session_otherwise_is_still_an_error():
    host = _host()
    host._on_server_disconnect(types.SimpleNamespace(manual_disconnect=True))
    assert _last_state(host)["error"] == "server_closed"


def test_signing_out_ourselves_is_not_an_error():
    host = _host()
    host._persist_config = lambda: None
    host._app_settings = lambda: {}
    host._cmd_connection_disconnect({})
    host._on_server_disconnect(types.SimpleNamespace(manual_disconnect=True))
    assert _last_state(host)["error"] is None


def test_a_dropped_connection_is_not_an_error_because_upstream_retries_it(caplog):
    host = _host()
    with caplog.at_level(logging.INFO, logger="seek.core"):
        host._on_server_disconnect(types.SimpleNamespace(manual_disconnect=False))
    assert _last_state(host)["error"] is None
    assert "reconnect" in caplog.text


def test_a_refused_login_keeps_its_reason_through_the_disconnect(caplog):
    host = _host()
    with caplog.at_level(logging.INFO, logger="seek.core"):
        host._on_server_login(types.SimpleNamespace(
            success=False, username=None, ip_address=None, rejection_reason="INVALIDPASS"))
        host._on_server_disconnect(types.SimpleNamespace(manual_disconnect=True))
    assert _last_state(host)["error"] == "INVALIDPASS"
    assert "INVALIDPASS" in caplog.text


def test_a_later_sign_in_forgets_the_last_reason():
    host = _host()
    host._on_upstream_log("%x %X", _(RELOGGED), None, 0)  # noqa: F821
    host._on_server_login(types.SimpleNamespace(
        success=True, username="me", ip_address="1.2.3.4", rejection_reason=None))
    host._on_server_disconnect(types.SimpleNamespace(manual_disconnect=False))
    assert _last_state(host)["error"] is None


def test_upstream_still_says_it_in_these_words():
    """The flag hangs on this exact line. If upstream rewords it, this fails
    and the host's comparison must follow, or `relogged` is never reported."""
    import pynicotine.slskproto as proto
    with open(proto.__file__, encoding="utf-8") as handle:
        assert f'_("{RELOGGED}")' in handle.read()
    assert os.path.basename(proto.__file__) == "slskproto.py"
