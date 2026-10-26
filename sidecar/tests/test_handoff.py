"""
Seek — the Rekordbox hand-off: copy finished downloads into one folder the DJ
imports into Rekordbox.

These pin the three rules (copy, never overwrite, never half a file), where a
file lands, and the command around them: the folder setting, the record of
what went, and the files it refuses.
"""

import os
import types

import pytest

from seek_sidecar import handoff
from seek_sidecar.core_host import CommandError, CoreHost
from seek_sidecar.registries import TransferRecord


def _file(path, data=b"\0" * 32):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)
    return str(path)


class TestWhereAFileGoes:
    def test_keeps_its_place_under_the_download_folder(self, tmp_path):
        """Two multi-disc releases both have CD1/01.flac; keeping only the last
        folder would put them at the same name."""
        root = tmp_path / "Downloads"
        src = _file(root / "Drexciya" / "Neptune's Lair" / "CD1" / "01.flac")
        assert handoff.destination("/RB", src, str(root)) == "/RB/Drexciya/Neptune's Lair/CD1/01.flac"

    def test_a_loose_file_lands_at_the_top(self, tmp_path):
        root = tmp_path / "Downloads"
        src = _file(root / "track.flac")
        assert handoff.destination("/RB", src, str(root)) == "/RB/track.flac"

    def test_a_file_outside_the_download_folder_keeps_its_folder_name(self, tmp_path):
        src = _file(tmp_path / "Elsewhere" / "Shed - The Traveller" / "01.flac")
        assert (handoff.destination("/RB", src, str(tmp_path / "Downloads"))
                == "/RB/Shed - The Traveller/01.flac")


class TestTheCopy:
    def test_copies_and_leaves_the_original(self, tmp_path):
        src = _file(tmp_path / "in" / "01.flac", b"music")
        dest = str(tmp_path / "RB" / "Release" / "01.flac")
        assert handoff.send_file(src, dest) == handoff.COPIED
        assert open(dest, "rb").read() == b"music"
        assert os.path.exists(src)
        assert os.listdir(os.path.dirname(dest)) == ["01.flac"]   # no partial left

    def test_never_overwrites_a_different_file(self, tmp_path):
        src = _file(tmp_path / "in" / "01.flac", b"new music")
        dest = _file(tmp_path / "RB" / "01.flac", b"old")
        assert handoff.send_file(src, dest) == handoff.EXISTS_DIFFERENT
        assert open(dest, "rb").read() == b"old"

    def test_the_same_file_sent_again_is_already_there(self, tmp_path):
        src = _file(tmp_path / "in" / "01.flac", b"music")
        dest = _file(tmp_path / "RB" / "01.flac", b"music")
        assert handoff.send_file(src, dest) == handoff.ALREADY_THERE

    def test_a_failed_copy_leaves_nothing_behind(self, tmp_path, monkeypatch):
        """An import running mid-copy must never find half a track, and the
        folders made for it do not stay behind empty."""
        (tmp_path / "RB").mkdir()
        src = _file(tmp_path / "in" / "01.flac")
        dest = str(tmp_path / "RB" / "Artist" / "Album" / "01.flac")

        def half(source, target, _stopping):
            with open(target, "wb") as handle:
                handle.write(b"\0")
            raise OSError("disk full")

        monkeypatch.setattr(handoff, "_copy", half)
        assert handoff.send_file(src, dest) == handoff.IO_ERROR
        assert os.listdir(tmp_path / "RB") == []

    def test_a_folder_already_there_is_kept_when_a_copy_fails(self, tmp_path, monkeypatch):
        (tmp_path / "RB" / "Artist").mkdir(parents=True)
        src = _file(tmp_path / "in" / "01.flac")
        monkeypatch.setattr(handoff, "_copy", lambda *a: (_ for _ in ()).throw(OSError("full")))
        assert handoff.send_file(src, str(tmp_path / "RB" / "Artist" / "Album" / "01.flac")) == handoff.IO_ERROR
        assert os.listdir(tmp_path / "RB") == ["Artist"]

    def test_a_source_gone_since_is_missing_not_a_drive_fault(self, tmp_path):
        assert (handoff.send_file(str(tmp_path / "in" / "gone.flac"), str(tmp_path / "RB" / "x.flac"))
                == handoff.FILE_MISSING)
        assert not (tmp_path / "RB").exists()

    def test_a_long_name_can_be_sent(self, tmp_path):
        """The hidden copy's name used to be the file's plus 14 bytes, so any
        name of 242 bytes or more ran past the 255-byte limit."""
        name = "a" * 245 + ".flac"
        src = _file(tmp_path / "in" / name, b"music")
        dest = str(tmp_path / "RB" / name)
        assert handoff.send_file(src, dest) == handoff.COPIED
        assert open(dest, "rb").read() == b"music"

    def test_quitting_mid_copy_stops_and_leaves_nothing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(handoff, "CHUNK", 4)
        src = _file(tmp_path / "in" / "01.flac", b"x" * 64)
        dest = str(tmp_path / "RB" / "Album" / "01.flac")
        asked = []
        assert handoff.send_file(src, dest, lambda: asked.append(1) or len(asked) > 3) == handoff.STOPPED
        assert not (tmp_path / "RB").exists()


class TestAFlushedCopy:
    def test_the_bytes_reach_the_drive_before_the_name_appears(self, tmp_path, monkeypatch):
        """A stick pulled the moment Seek says "copied" must hold the track."""
        order = []
        real_flush, real_replace = handoff._flush, os.replace
        monkeypatch.setattr(handoff, "_flush", lambda p: (order.append(("flush", os.path.basename(p))), real_flush(p)))
        monkeypatch.setattr(handoff.os, "replace", lambda a, b: (order.append(("rename", os.path.basename(b))), real_replace(a, b)))
        src = _file(tmp_path / "in" / "01.flac", b"music")
        assert handoff.send_file(src, str(tmp_path / "RB" / "01.flac")) == handoff.COPIED
        partial = os.path.basename(handoff.partial_name(str(tmp_path / "RB" / "01.flac")))
        assert order == [("flush", partial), ("rename", "01.flac"), ("flush", "RB")]


class ImmediatePool:
    def submit(self, fn, *args):
        fn(*args)


class Bridge:
    def __init__(self):
        self.events = []

    def broadcast(self, name, payload):
        self.events.append((name, payload))


def _host(tmp_path, monkeypatch, finished):
    """A host whose downloads are `finished`: {transfer id: local path or a
    CommandError code}. Upload ids are any whose path starts with 'up:'."""
    host = object.__new__(CoreHost)
    host.bridge = Bridge()
    host.data_folder = str(tmp_path / "data")
    host._post_pool = ImmediatePool()
    host._moved_paths = {}
    downloads = tmp_path / "Downloads"
    downloads.mkdir(exist_ok=True)
    host._download_root = lambda: str(downloads)
    records = {}
    for transfer_id in finished:
        direction = "upload" if transfer_id.startswith("up") else "download"
        record = TransferRecord(direction, "nightbus", f"Music\\{transfer_id}.flac")
        record.id = transfer_id
        records[transfer_id] = record
    host.transfers = types.SimpleNamespace(get=records.get)

    def resolve(params):
        found = finished[params["transferId"]]
        if found in ("bad_request", "not_found"):
            raise CommandError(found, "nope")
        return found

    monkeypatch.setattr(host, "_resolve_local_file", resolve)
    return host, downloads


class TestTheCommand:
    def test_refuses_without_a_folder(self, tmp_path, monkeypatch):
        host, _ = _host(tmp_path, monkeypatch, {})
        with pytest.raises(CommandError, match="no Rekordbox folder"):
            host._cmd_handoff_send({"transferIds": []})

    def test_refuses_a_folder_that_has_gone(self, tmp_path, monkeypatch):
        """An unplugged USB stick fails; it is not recreated on the internal
        disk. Looked at on the worker: a sleeping drive takes seconds."""
        good = _file(tmp_path / "Downloads" / "Release" / "01.flac")
        host, _ = _host(tmp_path, monkeypatch, {"a1": good})
        host._save_state(rekordbox_folder=str(tmp_path / "Volumes" / "USB" / "RB"))
        queued = []
        host._post_pool = types.SimpleNamespace(submit=lambda fn, *a: queued.append((fn, a)))
        assert host._cmd_handoff_send({"transferIds": ["a1"]}) == {}
        assert host.bridge.events == []            # nothing looked at yet
        fn, args = queued[0]
        fn(*args)
        assert host.bridge.events[0][1]["results"][0]["outcome"] == "folder_unavailable"
        assert not (tmp_path / "Volumes").exists()

    def test_quitting_stops_the_rest_and_keeps_what_landed(self, tmp_path, monkeypatch):
        rb = tmp_path / "RB"
        rb.mkdir()
        one = _file(tmp_path / "Downloads" / "Release" / "01.flac")
        two = _file(tmp_path / "Downloads" / "Release" / "02.flac")
        host, _ = _host(tmp_path, monkeypatch, {"a1": one, "b2": two})
        host._save_state(rekordbox_folder=str(rb))
        real = handoff.send_file

        def then_quit(source, dest, stopping):
            outcome = real(source, dest, stopping)
            host._quitting = True
            return outcome

        monkeypatch.setattr(handoff, "send_file", then_quit)
        host._cmd_handoff_send({"transferIds": ["a1", "b2"]})
        results = host.bridge.events[0][1]["results"]
        assert [r["outcome"] for r in results] == ["copied", "stopped"]
        assert [row["transferId"] for row in host._handoff_sent()] == ["a1"]

    def test_copies_records_and_refuses_file_by_file(self, tmp_path, monkeypatch):
        rb = tmp_path / "RB"
        rb.mkdir()
        downloads = tmp_path / "Downloads"
        good = _file(downloads / "Burial - Untrue" / "01.flac")
        host, _ = _host(tmp_path, monkeypatch, {
            "a1": good, "b2": "bad_request", "c3": "not_found", "up4": good,
        })
        host._save_state(rekordbox_folder=str(rb))

        assert host._cmd_handoff_send({"transferIds": ["a1", "b2", "c3", "up4"]}) == {}

        (done, done_payload), (state, state_payload) = host.bridge.events
        assert (done, state) == ("handoff.done", "handoff.state")
        assert [(r["transferId"], r["outcome"]) for r in done_payload["results"]] == [
            ("a1", "copied"), ("b2", "not_finished"), ("c3", "file_missing"), ("up4", "file_missing"),
        ]
        dest = os.path.realpath(rb) + "/Burial - Untrue/01.flac"
        assert os.path.isfile(dest)
        assert [(row["transferId"], row["user"], row["dest"]) for row in state_payload["sent"]] == [
            ("a1", "nightbus", dest),
        ]
        # The record survives a restart.
        assert host._cmd_handoff_list(None)["sent"] == state_payload["sent"]

    def test_sending_again_updates_the_record_rather_than_doubling_it(self, tmp_path, monkeypatch):
        rb = tmp_path / "RB"
        rb.mkdir()
        good = _file(tmp_path / "Downloads" / "Release" / "01.flac")
        host, _ = _host(tmp_path, monkeypatch, {"a1": good})
        host._save_state(rekordbox_folder=str(rb))
        host._cmd_handoff_send({"transferIds": ["a1"]})
        host._cmd_handoff_send({"transferIds": ["a1"]})
        assert host.bridge.events[2][1]["results"][0]["outcome"] == "already_there"
        assert len(host._cmd_handoff_list(None)["sent"]) == 1

    def test_follows_a_file_organise_moved_while_it_waited(self, tmp_path, monkeypatch):
        rb = tmp_path / "RB"
        rb.mkdir()
        old = str(tmp_path / "Downloads" / "rip" / "01.flac")
        new = _file(tmp_path / "Downloads" / "Burial" / "2007 - Untrue" / "01.flac")
        host, _ = _host(tmp_path, monkeypatch, {"a1": old})
        host._moved_paths[old] = new
        host._save_state(rekordbox_folder=str(rb))
        host._cmd_handoff_send({"transferIds": ["a1"]})
        assert host.bridge.events[0][1]["results"][0]["outcome"] == "copied"
        assert (rb / "Burial" / "2007 - Untrue" / "01.flac").is_file()

    def test_the_download_folder_is_read_when_asked_not_when_copied(self, tmp_path, monkeypatch):
        """A folder changed while the copy waits must not move where it lands."""
        rb = tmp_path / "RB"
        rb.mkdir()
        good = _file(tmp_path / "Downloads" / "Untrue" / "CD1" / "01.flac")
        host, _ = _host(tmp_path, monkeypatch, {"a1": good})
        host._save_state(rekordbox_folder=str(rb))
        queued = []
        host._post_pool = types.SimpleNamespace(submit=lambda fn, *a: queued.append((fn, a)))
        host._cmd_handoff_send({"transferIds": ["a1"]})
        host._download_root = lambda: str(tmp_path / "Elsewhere")
        fn, args = queued[0]
        fn(*args)
        assert (rb / "Untrue" / "CD1" / "01.flac").is_file()

    def test_a_malformed_record_is_dropped_not_sent(self, tmp_path, monkeypatch):
        """The validator drops a whole event over one bad row."""
        host, _ = _host(tmp_path, monkeypatch, {})
        host._save_handoff([{"transferId": "a1"}, "junk", {
            "transferId": "b2", "user": "u", "path": "p", "dest": "/d", "sentAt": 1,
        }])
        assert [row["transferId"] for row in host._handoff_sent()] == ["b2"]

    def test_the_record_keeps_out_of_seek_state(self, tmp_path, monkeypatch):
        """Every save of anything rewrites seek-state.json, so 5,000 rows there
        cost every finished download its share of 1.6 MB."""
        rb = tmp_path / "RB"
        rb.mkdir()
        good = _file(tmp_path / "Downloads" / "Release" / "01.flac")
        host, _ = _host(tmp_path, monkeypatch, {"a1": good})
        host._save_state(rekordbox_folder=str(rb))
        host._cmd_handoff_send({"transferIds": ["a1"]})
        assert "handoff_sent" not in host._load_state()
        assert [row["transferId"] for row in host._handoff_sent()] == ["a1"]

    def test_only_what_is_in_the_folder_now_is_sent(self, tmp_path, monkeypatch):
        """Another folder, or another stick under the same name, holds none of
        the old copies: they are sendable again, and the record is kept."""
        rb, other = tmp_path / "RB", tmp_path / "Other"
        rb.mkdir()
        other.mkdir()
        good = _file(tmp_path / "Downloads" / "Release" / "01.flac")
        host, _ = _host(tmp_path, monkeypatch, {"a1": good})
        host._save_state(rekordbox_folder=str(rb))
        host._cmd_handoff_send({"transferIds": ["a1"]})
        assert len(host._cmd_handoff_list(None)["sent"]) == 1

        host._save_state(rekordbox_folder=str(other))
        assert host._cmd_handoff_list(None)["sent"] == []
        host._save_state(rekordbox_folder=str(rb))
        assert len(host._cmd_handoff_list(None)["sent"]) == 1

        (rb / "Release" / "01.flac").unlink()             # the stick swapped
        assert host._cmd_handoff_list(None)["sent"] == []
        host._cmd_handoff_send({"transferIds": ["a1"]})
        assert host.bridge.events[-2][1]["results"][0]["outcome"] == "copied"
        assert len(host.bridge.events[-1][1]["sent"]) == 1
