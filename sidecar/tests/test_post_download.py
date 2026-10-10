"""
Seek — what happens to a file after it downloads, and the commands that move
or rewrite one.

The three switches under Settings → After downloading were stored and never
read. Organise and Fix tags called MusicBrainz on the engine's own thread, so a
slow lookup froze every transfer. A moved file then read as missing to Verify.
These pin the replacements, with the network stubbed: what is under test is
which files get touched, and which never do.
"""

import os
import stat
import types

import pytest

from seek_sidecar import enrich
from seek_sidecar.core_host import DEFERRED, CommandError, CoreHost


class ImmediatePool:
    """Runs submitted work at once, so a test can read the outcome."""

    def submit(self, fn, *args, **kwargs):
        fn(*args, **kwargs)


class Bridge:
    def __init__(self):
        self.replies = []
        self.errors = []
        self.events = []

    def reply(self, ws, rid, result=None):
        self.replies.append((rid, result))

    def reply_error(self, ws, rid, code, message):
        self.errors.append((rid, code, message))

    def broadcast(self, name, payload):
        self.events.append((name, payload))


SUMMARY = {"artist": "Drexciya", "title": "Neptune's Lair", "date": "1999-11-01"}


def _host(tmp_path, monkeypatch, settings=None):
    host = object.__new__(CoreHost)
    host.bridge = Bridge()
    host.data_folder = str(tmp_path / "data")
    host._post_pool = ImmediatePool()
    host._moved_paths = {}
    host._replying = None
    main_calls = []
    host.events = types.SimpleNamespace(invoke_main_thread=lambda fn, *a: main_calls.append((fn, a)))
    host._main_calls = main_calls
    downloads = tmp_path / "Downloads"
    downloads.mkdir()
    host._download_root = lambda: str(downloads)
    host._lookups_allowed = lambda: True
    host._art_cache = lambda: None
    stored = {"embedArtwork": False, "writeCoverFile": False, "autoOrganise": False}
    stored.update(settings or {})
    host._app_settings = lambda: dict(stored)
    monkeypatch.setattr(CoreHost, "_release_summary_for", lambda self, path: dict(SUMMARY))
    return host, downloads


def _file(folder, name, data=b"\0" * 32):
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name)
    with open(path, "wb") as handle:
        handle.write(data)
    return path


class TestOrganiseAReleaseAsOne:
    def test_moves_the_audio_and_everything_beside_it(self, tmp_path, monkeypatch):
        """A release's .ffp, .md5 and cover only mean anything next to its
        audio; moving tracks one by one left them behind and broke the
        checksum check on every organised release."""
        host, downloads = _host(tmp_path, monkeypatch, {"autoOrganise": True})
        release = downloads / "drexciya-neptunes_lair-1999-FLAC"
        for name in ("01 - Andreaen Sand Dunes.flac", "02 - Bubble Metropolis.flac",
                     "release.ffp", "release.md5", "cover.jpg"):
            _file(str(release), name)

        moves = host._organise_folder(str(release), os.path.realpath(downloads))

        target = os.path.realpath(downloads) + "/Drexciya/1999 - Neptune's Lair"
        assert sorted(os.listdir(target)) == sorted([
            "01 - Andreaen Sand Dunes.flac", "02 - Bubble Metropolis.flac",
            "release.ffp", "release.md5", "cover.jpg",
        ])
        assert not release.exists()                  # the empty folder is gone
        assert len(moves) == 5
        assert host._main_calls, "the core was not told where the files went"

    def test_never_overwrites(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        release = downloads / "rip"
        _file(str(release), "01.flac", b"new")
        existing = _file(str(downloads / "Drexciya" / "1999 - Neptune's Lair"), "01.flac", b"old")

        host._organise_folder(str(release), os.path.realpath(downloads))

        assert open(existing, "rb").read() == b"old"
        assert (release / "01.flac").exists()        # left where it was

    def test_never_moves_the_download_folder_itself(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        _file(str(downloads), "loose.flac")
        assert host._organise_folder(str(downloads), os.path.realpath(downloads)) == []
        assert (downloads / "loose.flac").exists()

    def test_never_moves_without_a_match(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        monkeypatch.setattr(CoreHost, "_release_summary_for", lambda self, path: None)
        release = downloads / "white label"
        _file(str(release), "A1.flac")
        assert host._organise_folder(str(release), os.path.realpath(downloads)) == []
        assert (release / "A1.flac").exists()


class TestArtworkAfterDownload:
    def _fetch(self, monkeypatch):
        calls = []
        monkeypatch.setattr(enrich, "read_tags", lambda path: {"artist": "Drexciya", "album": "x"})
        monkeypatch.setattr(enrich, "fetch_artwork",
                            lambda a, r, c: (calls.append((a, r)) or (b"JPEGDATA", "image/jpeg", "caa")))
        written = []
        monkeypatch.setattr(enrich, "write_tags", lambda path, tags, art=None, clear=(): written.append(path))
        monkeypatch.setattr(enrich, "has_artwork", lambda path: False)
        return calls, written

    def test_embeds_and_writes_a_cover(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        _calls, written = self._fetch(monkeypatch)
        track = _file(str(downloads / "rel"), "01.flac")
        host._add_artwork(track, os.path.dirname(track), embed=True, cover=True)
        assert written == [track]
        assert open(downloads / "rel" / "cover.jpg", "rb").read() == b"JPEGDATA"

    def test_leaves_a_release_with_an_md5_untouched(self, tmp_path, monkeypatch):
        """Rewriting tags breaks the uploader's whole-file checksum, the only
        hard fact about those bytes."""
        host, downloads = _host(tmp_path, monkeypatch)
        _calls, written = self._fetch(monkeypatch)
        track = _file(str(downloads / "rel"), "01.flac")
        _file(str(downloads / "rel"), "rel.md5")
        host._add_artwork(track, os.path.dirname(track), embed=True, cover=False)
        assert written == []

    def test_never_replaces_existing_artwork_or_cover(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        calls, written = self._fetch(monkeypatch)
        monkeypatch.setattr(enrich, "has_artwork", lambda path: True)
        track = _file(str(downloads / "rel"), "01.flac")
        _file(str(downloads / "rel"), "Folder.JPG", b"theirs")
        host._add_artwork(track, os.path.dirname(track), embed=True, cover=True)
        assert written == [] and calls == []         # nothing to do, nothing fetched

    def test_all_switches_off_does_nothing(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        ran = []
        host._post_pool = types.SimpleNamespace(submit=lambda *a, **k: ran.append(a))
        host.core = types.SimpleNamespace(downloads=types.SimpleNamespace(
            get_current_download_file_path=lambda t: str(downloads / "x.flac")))
        host._after_download(object())
        assert ran == []


class TestMovesAreFollowed:
    def test_the_core_points_at_the_new_folder(self, tmp_path, monkeypatch):
        """A moved file read as missing: Verify and Fix tags said "no such
        file" and the row pointed at an empty folder."""
        host, downloads = _host(tmp_path, monkeypatch)
        old = str(downloads / "rel" / "01.flac")
        new = str(downloads / "Drexciya" / "1999 - x" / "01.flac")
        transfer = types.SimpleNamespace(status="Finished", folder_path=str(downloads / "rel"))
        emitted = []
        host._emit_transfer = lambda t, direction, file=None: emitted.append(t)
        host.core = types.SimpleNamespace(downloads=types.SimpleNamespace(
            transfers={"k": transfer},
            get_current_download_file_path=lambda t: os.path.join(t.folder_path, "01.flac"),
        ))
        host._apply_moves([(old, new)])
        assert transfer.folder_path == os.path.dirname(new)
        assert emitted == [transfer]

    def test_a_moved_path_still_resolves(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        new = _file(str(downloads / "Drexciya"), "01.flac")
        host._moved_paths[str(downloads / "rel" / "01.flac")] = new
        assert host._resolve_local_file({"path": str(downloads / "rel" / "01.flac"),
                                         "transferId": None}) == new


class TestSlowCommandsDoNotBlock:
    def test_organise_answers_from_the_worker(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        track = _file(str(downloads / "rel"), "01.flac")
        host._replying = ("ws", "r7", "organise.file")
        assert host._cmd_organise_file({"path": track, "transferId": None}) is DEFERRED
        rid, result = host.bridge.replies[0]
        assert rid == "r7" and result["moved"] is True

    def test_fix_tags_writes_even_when_no_cover_exists(self, tmp_path, monkeypatch):
        """It used to refuse the whole write, losing every checked correction,
        on exactly the obscure releases no cover service has."""
        host, downloads = _host(tmp_path, monkeypatch)
        track = _file(str(downloads), "01.flac")
        written = []
        monkeypatch.setattr(enrich, "fetch_artwork",
                            lambda *a: (_ for _ in ()).throw(enrich.EnrichError("no cover")))
        monkeypatch.setattr(enrich, "write_tags", lambda path, tags, art=None, clear=(): written.append((tags, art)))
        host._replying = ("ws", "r8", "metadata.apply")
        host._cmd_metadata_apply({
            "path": track, "fields": [{"field": "album", "proposed": "Neptune's Lair"}],
            "embedArtwork": True, "artist": "Drexciya", "release": "x",
        })
        assert written == [({"album": "Neptune's Lair"}, None)]
        assert host.bridge.replies[0][1]["artworkEmbedded"] is False

    def test_fix_tags_offers_the_old_values_back(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        track = _file(str(downloads), "01.flac")
        monkeypatch.setattr(enrich, "read_tags", lambda p: {"album": "untrue", "date": ""})
        calls = []
        monkeypatch.setattr(enrich, "write_tags",
                            lambda path, tags, art=None, clear=(): calls.append((tags, list(clear))))
        host._replying = ("ws", "r10", "metadata.apply")
        host._cmd_metadata_apply({
            "path": track, "embedArtwork": False, "artist": "", "release": "", "clear": None,
            "fields": [{"field": "album", "proposed": "Untrue"}, {"field": "date", "proposed": "2007"}],
        })
        previous = host.bridge.replies[0][1]["previous"]
        assert {p["field"]: p["proposed"] for p in previous} == {"album": "untrue", "date": ""}
        # Undo: the old album back, and the date that was empty removed again.
        host._replying = ("ws", "r11", "metadata.apply")
        host._cmd_metadata_apply({
            "path": track, "embedArtwork": False, "artist": "", "release": "",
            "fields": [{"field": "album", "proposed": "untrue"}], "clear": ["date"],
        })
        assert calls[-1] == ({"album": "untrue"}, ["date"])

    def test_an_outage_is_not_a_miss(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        track = _file(str(downloads), "01.flac")
        monkeypatch.setattr(enrich, "read_tags", lambda p: {"album": "x"})
        monkeypatch.setattr(enrich, "mb_search_release",
                            lambda *a: (_ for _ in ()).throw(enrich.EnrichError("timed out")))
        sent = []
        host.bridge.broadcast = lambda name, data: sent.append((name, data))
        host._run_metadata("m1", track, None)
        assert sent[0][1]["lookupFailed"] is True and sent[0][1]["matched"] is False
        monkeypatch.setattr(enrich, "mb_search_release", lambda *a: None)
        host._run_metadata("m2", track, None)
        assert sent[1][1]["lookupFailed"] is False

    def test_a_folder_with_an_md5_is_flagged_before_a_tag_change(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        track = _file(str(downloads / "Album"), "01.flac")
        (downloads / "Album" / "album.md5").write_text("x")
        monkeypatch.setattr(enrich, "read_tags", lambda p: {})
        monkeypatch.setattr(enrich, "mb_search_release", lambda *a: None)
        sent = []
        host.bridge.broadcast = lambda name, data: sent.append(data)
        host._run_metadata("m3", track, None)
        assert sent[0]["md5Sibling"] is True

    def test_a_failing_deferred_command_still_answers(self, tmp_path, monkeypatch):
        host, _downloads = _host(tmp_path, monkeypatch)
        host._replying = ("ws", "r9", "organise.file")

        def boom():
            raise CommandError("internal", "disk full")

        host._defer(boom)
        assert host.bridge.errors == [("r9", "internal", "disk full")]


class TestSettingsThatStick:
    def test_the_state_file_is_private(self, tmp_path):
        """It holds the Discogs token and the Google refresh token."""
        host = object.__new__(CoreHost)
        host.data_folder = str(tmp_path)
        host._save_state(discogsToken="x")
        mode = stat.S_IMODE(os.stat(tmp_path / "seek-state.json").st_mode)
        assert mode == 0o600

    def test_the_stall_timeout_survives_a_restart(self, tmp_path):
        host = object.__new__(CoreHost)
        host.data_folder = str(tmp_path)
        host._save_state(stall_seconds=300)
        fresh = CoreHost.__new__(CoreHost)
        fresh.data_folder = str(tmp_path)
        assert fresh._load_state()["stall_seconds"] == 300


class TestOpenAndReveal:
    def test_only_audio_is_ever_opened(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        launched = []
        monkeypatch.setattr(CoreHost, "_system_open", staticmethod(lambda args: launched.append(args)))
        script = _file(str(downloads), "run.command")
        with pytest.raises(CommandError):
            host._cmd_fs_open({"path": script, "transferId": None})
        track = _file(str(downloads), "01.flac")
        host._cmd_fs_open({"path": track, "transferId": None})
        host._cmd_fs_reveal({"path": track, "transferId": None})
        assert len(launched) == 2 and launched[0][-1] == track


def test_the_log_never_names_a_wish(tmp_path, caplog):
    """Settings promises the log holds "not what you searched for"."""
    host = object.__new__(CoreHost)
    host.searches = types.SimpleNamespace(get=lambda t: None, add=lambda *a: types.SimpleNamespace(info=lambda: {}))
    wish = types.SimpleNamespace(mode="wishlist", term="Drexciya Neptune", term_transmitted="Drexciya Neptune")
    host.core = types.SimpleNamespace(search=types.SimpleNamespace(wishlist={wish.term: wish}, searches={
        5: wish,
    }))
    host.bridge = Bridge()
    with caplog.at_level("INFO", logger="seek.core"):
        host._adopt_wishlist_search(5)
    assert "Drexciya" not in caplog.text


class TestReviewFixes:
    def test_the_default_download_folder_is_expanded(self, tmp_path, monkeypatch):
        """Upstream's default is "${NICOTINE_DATA_HOME}/downloads", unexpanded.
        Read raw, it is not a folder, and every after-download step skipped."""
        monkeypatch.setenv("NICOTINE_DATA_HOME", str(tmp_path))
        host = object.__new__(CoreHost)
        host.config = types.SimpleNamespace(sections={"transfers": {
            "downloaddir": "${NICOTINE_DATA_HOME}/downloads"}})
        assert host._download_root() == str(tmp_path / "downloads")

    def test_a_share_missing_at_launch_is_still_reported(self):
        """At launch upstream reports the missing share and then scans anyway;
        that scan used to wipe the report it came with."""
        host = object.__new__(CoreHost)
        host.bridge = Bridge()
        host._share_state = lambda: {}
        host._share_unavailable = []
        host._on_shares_unavailable([("SSD", "/Volumes/SSD")])
        host._on_shares_scanning()
        assert host._share_unavailable == ["/Volumes/SSD"]
        host._on_shares_scanning()                    # a later scan, no report
        assert host._share_unavailable == []

    def test_an_automatic_greeting_starting_with_a_slash_is_just_text(self):
        host = object.__new__(CoreHost)
        host.UserStatus = types.SimpleNamespace(OFFLINE=0)
        sent = []
        host.core = types.SimpleNamespace(
            users=types.SimpleNamespace(login_status=1),
            privatechat=types.SimpleNamespace(
                show_user=lambda *a, **k: None,
                send_automatic_message=lambda user, text: sent.append(text)),
            pluginhandler=types.SimpleNamespace(
                trigger_private_chat_command_event=lambda *a: sent.append("COMMAND")),
        )
        host._cmd_chat_say({"scope": "private", "target": "bob",
                            "message": "/ thanks for stopping by", "automatic": True})
        assert sent == ["/ thanks for stopping by"]

    def test_a_command_reply_is_not_drawn_as_your_own_line(self):
        host = object.__new__(CoreHost)
        host.bridge = Bridge()
        host.core = types.SimpleNamespace(users=types.SimpleNamespace(login_username="iva"))
        host._on_room_echo("techno", "Unknown command: /foo", "command")
        _name, line = host.bridge.events[0]
        assert line["outgoing"] is False and line["username"] == ""

    def test_a_new_file_at_the_old_name_is_not_redirected(self, tmp_path, monkeypatch):
        host, downloads = _host(tmp_path, monkeypatch)
        old = _file(str(downloads), "01.flac")        # a new download landed here
        host._moved_paths[old] = str(downloads / "Drexciya" / "01.flac")
        assert host._follow_move(old) == old
