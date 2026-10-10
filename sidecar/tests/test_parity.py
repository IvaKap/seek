"""
Seek — the 0.3.0 Nicotine+ parity commands.
SPDX-License-Identifier: GPL-3.0-or-later

Ignore and ban, away, scoped search, closing private chats, room members,
forgetting downloads whose files are gone, and the writes that must say when
they did not reach the disk. Each drives CoreHost's own handler over a fake
core, the same way test_chat_commands.py does.
"""

import os
import types

import pytest

from seek_sidecar.core_host import CommandError, CoreHost


class Recorder:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def record(*args, **kwargs):
            self.calls.append((name, args, kwargs))
        return record


class FakeConfig:
    def __init__(self, path=None):
        self.sections = {"server": {"ignorelist": [], "banlist": [], "away": False,
                                    "auto_connect_startup": True},
                         "transfers": {}}
        self.config_file_path = path
        self.writes = 0

    def write_configuration(self):
        self.writes += 1
        if self.config_file_path:
            with open(self.config_file_path, "w", encoding="utf-8") as handle:
                handle.write(str(self.writes))


class FakeFilter:
    """networkfilter's ignore/ban, writing the same config lists it does."""

    def __init__(self, config):
        self.config = config

    def _set(self, key, username, on):
        names = self.config.sections["server"][key]
        if on and username not in names:
            names.append(username)
        if not on and username in names:
            names.remove(username)

    def ignore_user(self, u): self._set("ignorelist", u, True)
    def unignore_user(self, u): self._set("ignorelist", u, False)
    def ban_user(self, u): self._set("banlist", u, True)
    def unban_user(self, u): self._set("banlist", u, False)


def _host(online=True, path=None):
    host = object.__new__(CoreHost)
    host.UserStatus = types.SimpleNamespace(OFFLINE=0, ONLINE=2, AWAY=1)
    host.config = FakeConfig(path)
    host.broadcasts = []
    host.bridge = types.SimpleNamespace(broadcast=lambda n, d: host.broadcasts.append((n, d)))
    host.core = types.SimpleNamespace(
        users=Recorder(),
        network_filter=FakeFilter(host.config),
        buddies=types.SimpleNamespace(users={}),
        privatechat=types.SimpleNamespace(users={"bob"}, removed=[]),
        chatrooms=types.SimpleNamespace(joined_rooms={"techno": object()}),
    )
    host.core.users.login_status = 2 if online else 0
    host.core.users.statuses = {"ana": 2, "bo": 1}
    host.core.users.watched = {"ana": types.SimpleNamespace(files=120)}
    host._connection = {"status": "online" if online else "offline", "username": "me"}
    return host


# -- ignore and ban ----------------------------------------------------------

def test_ignore_and_ban_reply_with_both_lists():
    host = _host()
    assert host._cmd_users_ignore({"username": "troll", "on": True}) == {
        "ignored": ["troll"], "banned": []}
    assert host._cmd_users_ban({"username": "leech", "on": True}) == {
        "ignored": ["troll"], "banned": ["leech"]}
    assert host._cmd_users_ignore({"username": "troll", "on": False})["ignored"] == []


def test_a_blank_name_is_refused():
    with pytest.raises(CommandError):
        _host()._cmd_users_ban({"username": "  ", "on": True})


def test_a_slash_command_change_is_announced():
    host = _host()
    host.config.sections["server"]["ignorelist"].append("x")
    host._on_user_lists_changed("x")
    assert host.broadcasts == [("users.lists", {"ignored": ["x"], "banned": []})]


# -- away ---------------------------------------------------------------------

def test_away_chosen_by_hand_is_remembered():
    host = _host()
    host._cmd_users_away({"on": True, "remember": True})
    assert host.config.sections["server"]["away"] is True and host.config.writes == 1
    assert host.core.users.calls == [("set_away_mode", (True,), {"save_state": False})]


def test_a_failed_save_leaves_the_status_alone(tmp_path):
    path = tmp_path / "config"
    path.write_text("x")
    host = _host(path=str(path))
    host.config.write_configuration = lambda: None
    with pytest.raises(CommandError):
        host._cmd_users_away({"on": True, "remember": True})
    assert host.core.users.calls == []


def test_auto_away_is_not_remembered():
    host = _host()
    host._cmd_users_away({"on": True, "remember": False})
    assert host.core.users.calls == [("set_away_mode", (True,), {"save_state": False})]


def test_away_while_signed_out_waits_for_the_next_login():
    host = _host(online=False)
    host._cmd_users_away({"on": True, "remember": True})
    assert host.core.users.calls == []
    assert host.config.sections["server"]["away"] is True


def test_our_own_away_status_reaches_the_connection_state():
    host = _host()
    host._on_user_status(types.SimpleNamespace(user="me", status=1, privileged=False))
    assert ("connection.state", {"status": "away", "username": "me"}) in host.broadcasts


def test_login_reports_a_restored_away():
    host = _host()
    host.core.users.login_status = 1
    host._on_server_login(types.SimpleNamespace(
        success=True, username="me", ip_address="1.2.3.4", rejection_reason=None))
    assert host._connection["status"] == "away"


# -- scoped search --------------------------------------------------------------

@pytest.mark.parametrize("params, why", [
    ({"mode": "rooms", "room": "", "users": []}, "room"),
    ({"mode": "user", "room": None, "users": [" "]}, "user"),
    ({"mode": "wishlist", "room": None, "users": []}, "wishlist"),
    ({"mode": "buddies", "room": None, "users": []}, "buddies"),
])
def test_a_scope_with_nothing_to_search_is_refused(params, why):
    host = _host()
    with pytest.raises(CommandError) as raised:
        host._cmd_search_start({"query": "burial", **params})
    assert raised.value.code == "bad_request", why


# -- private chats and rooms ----------------------------------------------------

def test_closing_a_chat_the_engine_never_had_is_harmless():
    host = _host()
    host.core.privatechat.remove_user = lambda u: host.core.privatechat.removed.append(u)
    host._cmd_chat_close({"username": "stranger"})
    host._cmd_chat_close({"username": "bob"})
    assert host.core.privatechat.removed == ["bob"]


def test_room_members_carry_status_and_shares():
    host = _host()
    host._emit_rooms = lambda *a: None
    host._on_join_room(types.SimpleNamespace(
        room="techno", users=[types.SimpleNamespace(username="ana")]))
    assert host.broadcasts[0] == ("chat.members", {
        "room": "techno",
        "members": [{"username": "ana", "status": "online", "files": 120}]})


def test_a_join_we_never_asked_for_is_ignored():
    host = _host()
    host._on_join_room(types.SimpleNamespace(room="spam", users=[]))
    assert host.broadcasts == []


def test_comings_and_goings_are_single_changes():
    host = _host()
    host._on_user_joined_room(types.SimpleNamespace(
        room="techno", userdata=types.SimpleNamespace(username="bo")))
    host._on_user_left_room(types.SimpleNamespace(room="techno", username="ana"))
    host._on_user_left_room(types.SimpleNamespace(room=None, username="x"))  # suppressed upstream
    assert [(n, d["present"], d["member"]["username"]) for n, d in host.broadcasts] == [
        ("chat.member", True, "bo"), ("chat.member", False, "ana")]


# -- downloads whose files are gone ---------------------------------------------

def _download(folder, virtual, status="Finished"):
    return types.SimpleNamespace(username="peer", virtual_path=virtual,
                                 folder_path=folder, status=status)


def test_missing_files_are_found_by_name(tmp_path):
    host = _host()
    root = tmp_path / "Downloads"
    (root / "Album").mkdir(parents=True)
    (root / "Album" / "01.flac").write_bytes(b"x")
    (root / "Album" / "02 (1).flac").write_bytes(b"x")      # upstream's clash rename
    present = _download(str(root / "Album"), "@@a\\Album\\01.flac")
    clashed = _download(str(root / "Album"), "@@a\\Album\\02.flac")
    gone = _download(str(root / "Album"), "@@a\\Album\\03.flac")
    unplugged = _download("/Volumes/NoSuchDrive-seek-test/Music", "@@a\\Music\\04.flac")
    running = _download(str(root / "Album"), "@@a\\Album\\05.flac", status="Transferring")
    host.core.downloads = types.SimpleNamespace(
        transfers={i: d for i, d in enumerate([present, clashed, gone, unplugged, running])},
        get_download_basename=lambda virtual, folder: virtual.rpartition("\\")[2],
    )
    host._download_root = lambda: str(root)
    host._moved_paths = {}
    host.transfers = types.SimpleNamespace(
        record_for=lambda d, u, p: types.SimpleNamespace(id=f"{u}:{p}"))
    assert host._cmd_transfer_findMissing({}) == {"transferIds": ["peer:@@a\\Album\\03.flac"]}


# -- writes that did not land -----------------------------------------------------

def test_a_config_write_that_changed_nothing_on_disk_is_an_error(tmp_path):
    path = tmp_path / "config"
    path.write_text("old")
    host = _host(path=str(path))
    host.config.write_configuration = lambda: None         # upstream logged and returned
    with pytest.raises(CommandError):
        host._persist_config()


def test_a_config_write_that_landed_is_fine(tmp_path):
    path = tmp_path / "config"
    path.write_text("old")
    os.utime(path, ns=(0, 0))
    host = _host(path=str(path))
    host._persist_config()
    assert host.config.writes == 1


def test_a_state_write_that_failed_is_an_error(tmp_path):
    host = _host()
    host.data_folder = str(tmp_path / "data")
    os.makedirs(host.data_folder)
    os.chmod(host.data_folder, 0o500)                    # read-only: the temp file cannot be made
    try:
        with pytest.raises(CommandError):
            host._store(app_settings={"x": 1})
    finally:
        os.chmod(host.data_folder, 0o700)


def test_signing_out_stops_signing_in_at_launch():
    host = _host()
    host.core.disconnect = lambda: None
    host._app_settings = lambda: {}
    host._cmd_connection_disconnect({})
    assert host.config.sections["server"]["auto_connect_startup"] is False
    assert ("app.settings", {}) in host.broadcasts
