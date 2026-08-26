"""
Seek — your own Soulseek profile.
SPDX-License-Identifier: GPL-3.0-or-later

THE TRAP, measured before anything was written: upstream stores the profile
description as a Python `repr()` and calls `unescape()` on it when sending it
to a peer. Only `gtkgui/dialogs/preferences.py:1287` writes the field, and it
writes `repr(text)`.

Storing the raw string instead is silently destructive, and only for some
inputs — which is the worst kind:

    stored `C:\\newfolder\\test`  ->  unescape ->  `C:` NEWLINE `ewfolder` TAB `est`
    stored `'quoted'`           ->  unescape ->  `quoted`   (quotes eaten)
    stored `plain text`         ->  unescape ->  `plain text`  (fine — so a
                                                  casual test would pass)

These pin the round trip on exactly those shapes.
"""

import os

import pytest

from pynicotine.utils import unescape

from seek_sidecar.core_host import CoreHost, CommandError


class _Uploads:
    """The three figures a profile reports about your upload side.

    `queued_transfers` rather than `get_upload_queue_size()`, and that is not a
    simplification: the real method takes a REQUIRED `username` because a
    privileged peer is told a different number, and a profile has no one
    requester to answer for. An earlier version of this stub gave that method a
    default argument the real one does not have, so these tests passed while
    the live core raised TypeError on the first `profile.get`.
    """

    def __init__(self, queued=7):
        self.queued_transfers = {f"t{i}": None for i in range(queued)}

    def get_total_uploads_allowed(self):
        return 3

    def is_new_upload_accepted(self):
        return True

    def get_upload_queue_size(self, username):
        raise AssertionError(
            "the profile must not call this — it answers per requesting peer"
        )


class _Host:
    """CoreHost's profile methods over an in-memory config.

    CoreHost.__init__ boots pynicotine's core, which cannot run twice in one
    process — test_integration.py owns the one instance a run is allowed.
    """

    def __init__(self):
        self.config = self
        self.sections = {
            "userinfo": {"descr": "''", "pic": "", "picture_visible": True},
            "server": {"login": "our-account"},
        }
        self.written = 0
        self.core = self
        self.users = self
        self.login_username = "our-account"
        self.uploads = _Uploads()
        self._share_stats = {"fileCount": 6472, "folderCount": 412}

    def write_configuration(self):
        self.written += 1

    def _share_state(self):
        return dict(self._share_stats)

    PICTURE_CAP = CoreHost.PICTURE_CAP
    _resolve_path = staticmethod(CoreHost._resolve_path)
    _profile_picture = CoreHost._profile_picture
    _profile = CoreHost._profile
    _cmd_profile_get = CoreHost._cmd_profile_get
    _cmd_profile_set = CoreHost._cmd_profile_set


@pytest.fixture
def host():
    return _Host()


def stored(host):
    return host.sections["userinfo"]["descr"]


# ------------------------------------------------------- the description trap


@pytest.mark.parametrize("text", [
    "Just a DJ from Tbilisi",
    "line one\nline two",
    r"C:\newfolder\test",
    'he said "hi"',
    "'quoted'",
    "",
    "emoji 🎧 and ünïcode",
    "tab\there",
    "trailing backslash \\",
])
def test_a_description_survives_the_round_trip(host, text):
    host._cmd_profile_set({
        "description": text, "picturePath": None, "pictureVisible": None,
    })
    assert host._cmd_profile_get({})["description"] == text


@pytest.mark.parametrize("text", [r"C:\newfolder\test", "'quoted'"])
def test_the_stored_form_is_what_upstream_will_decode(host, text):
    """Not just self-consistent — it has to match what UserInfo does when it
    sends the field, which is `unescape` and nothing else."""
    host._cmd_profile_set({
        "description": text, "picturePath": None, "pictureVisible": None,
    })
    assert unescape(stored(host)) == text


def test_storing_the_raw_string_would_have_corrupted_it(host):
    """The control. This is what the obvious implementation does, and it is why
    the round trip above is tested on backslashes and quotes rather than on
    'hello'."""
    raw = r"C:\newfolder\test"
    assert unescape(raw) != raw
    assert "\n" in unescape(raw), "the \\n became a real newline"


def test_the_shipped_default_reads_as_empty(host):
    """Upstream's default is the two-character string `''`, which is an empty
    string in repr form. A profile screen must not show two quote marks."""
    assert host._cmd_profile_get({})["description"] == ""


def test_a_description_is_only_written_when_given(host):
    host._cmd_profile_set({
        "description": "hello", "picturePath": None, "pictureVisible": None,
    })
    host._cmd_profile_set({
        "description": None, "picturePath": None, "pictureVisible": True,
    })
    assert host._cmd_profile_get({})["description"] == "hello"


# ------------------------------------------------------------------ picture


def test_no_picture_is_not_an_error(host):
    profile = host._cmd_profile_get({})
    assert profile["pictureUri"] is None
    assert profile["pictureError"] == ""
    assert profile["pictureBytes"] == 0


def test_a_real_picture_becomes_a_data_uri(host, tmp_path):
    png = tmp_path / "me.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)

    host._cmd_profile_set({
        "description": None, "picturePath": str(png), "pictureVisible": None,
    })
    profile = host._cmd_profile_get({})

    assert profile["pictureUri"].startswith("data:image/png;base64,")
    assert profile["pictureError"] == ""
    assert profile["pictureBytes"] == 72


def test_a_jpeg_is_labelled_as_one(host, tmp_path):
    jpg = tmp_path / "me.jpg"
    jpg.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 32)
    host._cmd_profile_set({
        "description": None, "picturePath": str(jpg), "pictureVisible": None,
    })
    assert host._cmd_profile_get({})["pictureUri"].startswith("data:image/jpeg;base64,")


def test_a_picture_that_has_gone_away_says_so_rather_than_failing(host, tmp_path):
    """The config keeps a PATH, and a path outlives the file. Reporting the
    profile has to keep working, because that is the screen where you would
    fix it."""
    png = tmp_path / "gone.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n")
    host.sections["userinfo"]["pic"] = str(png)
    png.unlink()

    profile = host._cmd_profile_get({})
    assert profile["pictureUri"] is None
    assert "not there" in profile["pictureError"]
    assert profile["picturePath"] == str(png), "the path is kept so it can be seen"


def test_an_enormous_picture_is_refused_with_its_size(host, tmp_path):
    big = tmp_path / "huge.jpg"
    big.write_bytes(b"\xff\xd8" + b"\x00" * (CoreHost.PICTURE_CAP + 1024))
    host.sections["userinfo"]["pic"] = str(big)

    profile = host._cmd_profile_get({})
    assert profile["pictureUri"] is None
    assert "MB" in profile["pictureError"]
    assert profile["pictureBytes"] > CoreHost.PICTURE_CAP


def test_setting_a_picture_that_does_not_exist_is_refused(host, tmp_path):
    with pytest.raises(CommandError) as error:
        host._cmd_profile_set({
            "description": None, "picturePath": str(tmp_path / "nope.png"),
            "pictureVisible": None,
        })
    assert error.value.code == "not_found"


def test_a_picture_path_is_stored_resolved(host, tmp_path, monkeypatch):
    """`~` must be expanded: upstream expands nothing, so a literal `~/me.png`
    becomes a folder called `~` beside wherever the process started."""
    home = tmp_path / "home"
    home.mkdir()
    png = home / "me.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n")
    monkeypatch.setenv("HOME", str(home))

    host._cmd_profile_set({
        "description": None, "picturePath": "~/me.png", "pictureVisible": None,
    })
    assert host.sections["userinfo"]["pic"] == str(png)
    assert "~" not in host.sections["userinfo"]["pic"]


def test_an_empty_path_removes_the_picture(host, tmp_path):
    png = tmp_path / "me.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n")
    host._cmd_profile_set({
        "description": None, "picturePath": str(png), "pictureVisible": None,
    })
    host._cmd_profile_set({
        "description": None, "picturePath": "", "pictureVisible": None,
    })
    assert host._cmd_profile_get({})["picturePath"] == ""


def test_the_visibility_flag_round_trips(host):
    host._cmd_profile_set({
        "description": None, "picturePath": None, "pictureVisible": False,
    })
    assert host._cmd_profile_get({})["pictureVisible"] is False


# --------------------------------------------------------- the rest of it


def test_the_profile_reports_what_a_peer_would_see(host):
    profile = host._cmd_profile_get({})
    assert profile["username"] == "our-account"
    assert profile["uploadSlots"] == 3
    assert profile["freeSlots"] is True
    assert profile["queueSize"] == 7
    assert profile["sharedFiles"] == 6472
    assert profile["sharedFolders"] == 412


def test_an_unscanned_share_is_null_not_zero(host):
    """Null means the index has not been built. Zero would claim you are
    sharing nothing, which is a different and much worse statement."""
    host._share_stats = {"fileCount": None, "folderCount": None}
    profile = host._cmd_profile_get({})
    assert profile["sharedFiles"] is None
    assert profile["sharedFolders"] is None


def test_every_change_is_persisted(host):
    before = host.written
    host._cmd_profile_set({
        "description": "x", "picturePath": None, "pictureVisible": None,
    })
    assert host.written == before + 1


# ------------------------------------------------- the shared folder count


class _Shares:
    """Upstream's share databases, keyed as upstream actually keys them.

    `public_streams` is one stream per FOLDER; `public_files` is one entry per
    file. There is no `public_folders` — `_share_state` asked for one for as
    long as it existed, `.get` returned the empty default every time, and the
    folder count was silently 0 beside a real file count. Nothing displayed it
    until the profile screen did.
    """

    def __init__(self, files=6474, folders=412):
        self.share_dbs = {
            "public_files": {f"f{i}": None for i in range(files)},
            "public_streams": {f"d{i}": None for i in range(folders)},
            "public_mtimes": {},
        }


class _ShareHost:
    def __init__(self, shares=None, ready=True):
        self.core = self
        self.shares = shares
        self._share_ready = ready
        self._share_scanning = False
        self._share_last_scan = None
        self._share_restart_required = False
        self.data_folder = "/tmp"

    def _stored_consent(self):
        return "granted"

    def _share_folders(self):
        return []

    _share_state = CoreHost._share_state


def test_the_folder_count_reads_public_streams():
    host = _ShareHost(_Shares())
    state = host._share_state()
    assert state["fileCount"] == 6474
    assert state["folderCount"] == 412, "0 here means the wrong key is being read"


def test_a_share_db_without_the_old_key_still_counts():
    """The regression, stated directly: `public_folders` does not exist, so a
    lookup for it can only ever yield 0."""
    host = _ShareHost(_Shares())
    assert "public_folders" not in host.core.shares.share_dbs
    assert host._share_state()["folderCount"] > 0


def test_counts_are_null_before_a_scan():
    """Null is "the index is not built". Zero would claim you share nothing,
    which is a different and much worse statement — it is what gets you
    throttled, and saying it falsely would send someone hunting a problem they
    do not have."""
    host = _ShareHost(_Shares(), ready=False)
    state = host._share_state()
    assert state["fileCount"] is None
    assert state["folderCount"] is None


def test_no_shares_component_is_null_not_zero():
    state = _ShareHost(None)._share_state()
    assert state["fileCount"] is None
    assert state["folderCount"] is None
