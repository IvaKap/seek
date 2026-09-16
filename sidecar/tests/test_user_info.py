# Seek — asking a peer directly for their profile (description, picture).
# SPDX-License-Identifier: GPL-3.0-or-later
#
# `_cmd_user_info_get` goes through upstream's own `UserInfo.show_user`, the
# same way `_cmd_user_browse` goes through `userbrowse.browse_user` — these
# pin that it is actually called, and that the response/failure events it
# triggers reach the bridge translated, without booting a real core.

import pytest
from pynicotine.slskmessages import UserStatus

from seek_sidecar import translate
from seek_sidecar.core_host import CommandError, CoreHost


class _Users:
    def __init__(self, status=UserStatus.ONLINE):
        self.login_status = status


class _UserInfo:
    def __init__(self):
        self.calls = []

    def show_user(self, username, switch_page=True):
        self.calls.append((username, switch_page))


class _Core:
    def __init__(self):
        self.users = _Users()
        self.userinfo = _UserInfo()


class _Bridge:
    def __init__(self):
        self.broadcasts = []

    def broadcast(self, name, payload):
        self.broadcasts.append((name, payload))


class _Host:
    def __init__(self):
        self.core = _Core()
        self.bridge = _Bridge()
        self.UserStatus = UserStatus

    _require_online = CoreHost._require_online
    _cmd_user_info_get = CoreHost._cmd_user_info_get
    _on_user_info_response = CoreHost._on_user_info_response
    _on_user_info_failed = CoreHost._on_user_info_failed


class _Msg:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def test_requesting_a_peers_info_goes_through_show_user():
    host = _Host()
    host._cmd_user_info_get({"username": "jazzcat"})
    assert host.core.userinfo.calls == [("jazzcat", False)]


def test_requesting_info_while_offline_is_refused():
    host = _Host()
    host.core.users.login_status = UserStatus.OFFLINE
    with pytest.raises(CommandError):
        host._cmd_user_info_get({"username": "jazzcat"})
    assert host.core.userinfo.calls == [], "must not touch upstream before the online check"


def test_a_peers_response_is_broadcast_translated():
    host = _Host()
    msg = _Msg(username="jazzcat", descr="hi", pic=None,
               totalupl=2, queuesize=0, slotsavail=True)
    host._on_user_info_response(msg)
    assert host.bridge.broadcasts == [("user.info.result", translate.user_info(msg))]


def test_a_response_with_no_username_is_ignored():
    """The same upstream event also fires for OUR OWN profile if
    `show_user()` is ever called with no username. Seek never does that, but
    the guard is what makes it safe to trust `msg.username` unconditionally
    downstream instead of every future reader re-deriving this."""
    host = _Host()
    host._on_user_info_response(_Msg(username=None))
    assert host.bridge.broadcasts == []


def test_a_failed_request_is_broadcast():
    host = _Host()
    host._on_user_info_failed("jazzcat", is_offline=True)
    assert host.bridge.broadcasts == [
        ("user.info.failed", {"username": "jazzcat", "reason": "offline"}),
    ]


def test_a_failed_request_not_from_being_offline():
    host = _Host()
    host._on_user_info_failed("jazzcat")
    assert host.bridge.broadcasts[0][1]["reason"] == "failed"
