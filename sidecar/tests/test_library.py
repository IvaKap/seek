# Seek — the library index, and the folders it is told to walk.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The library only ever scanned the download folder, because the one way to add
# another was a drag-and-drop handler that cannot fire in a Tauri v2 webview.
# With a real folder picker in front of it, OVERLAPPING roots stop being exotic
# and become the obvious thing a person does: the download folder is always
# included, and the first folder anyone adds is the music folder containing it.
#
# `os.walk` does not care that it has been here before, and `trackCount += 1`
# runs again — so the collection reports twice what you own, from a pair of
# folders that are both perfectly reasonable. These tests pin that it does not.

import os

from seek_sidecar.library import Library, dedupe_roots


def _track(folder, name):
    """A file the scanner will count. Contents are irrelevant — it reads the
    extension, the path, and the size."""
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name)
    with open(path, "wb") as handle:
        handle.write(b"\0" * 16)
    return path


class TestDedupeRoots:
    def test_the_same_folder_twice_is_one_root(self, tmp_path):
        d = str(tmp_path)
        assert dedupe_roots([d, d]) == [os.path.realpath(d)]

    def test_two_spellings_of_one_folder_are_one_root(self, tmp_path):
        """`~/Music` and `~/Music/../Music` are the same folder, and a picker
        returning one while the config holds the other is ordinary."""
        d = str(tmp_path / "Music")
        os.makedirs(d)
        awkward = os.path.join(d, "..", "Music")
        assert dedupe_roots([d, awkward]) == [os.path.realpath(d)]

    def test_a_nested_root_is_dropped_in_favour_of_its_parent(self, tmp_path):
        """The real case: download folder inside the music folder."""
        music = tmp_path / "Music"
        downloads = music / "Downloads"
        os.makedirs(downloads)
        kept = dedupe_roots([str(downloads), str(music)])
        assert kept == [os.path.realpath(str(music))]

    def test_a_sibling_sharing_a_prefix_is_NOT_dropped(self, tmp_path):
        """`/a/music` must not swallow `/a/music-old`. A plain `startswith`
        does exactly that, which is why containment is tested on the separator."""
        a = tmp_path / "music"
        b = tmp_path / "music-old"
        os.makedirs(a)
        os.makedirs(b)
        assert len(dedupe_roots([str(a), str(b)])) == 2

    def test_empty_and_missing_folders_are_dropped(self, tmp_path):
        real = str(tmp_path)
        assert dedupe_roots(
            ["", None, str(tmp_path / "does-not-exist"), real]
        ) == [os.path.realpath(real)]

    def test_a_file_is_not_a_root(self, tmp_path):
        path = _track(str(tmp_path), "01 - a.flac")
        assert dedupe_roots([path]) == []


class TestScanCountsEachFileOnce:
    """Assert on the PER-RELEASE figures, not on `state()`.

    `state()` reports `len(releases)` and `len(tracks)`, and both of those are
    dict sizes keyed by name — so a file walked twice overwrites its own entry
    and the totals look perfectly correct. A first version of these tests
    asserted on `state()` and passed with the dedupe removed, which is the
    fixture-agrees-with-the-bug trap docs/HANDOFF.md §3 records.

    What actually doubles is `trackCount` and `bytes` INSIDE each release —
    which is exactly what the Library screen prints on every row, and what its
    collection-size total sums.
    """

    def _release(self, index, name):
        return next(r for r in index.releases() if r["release"] == name)

    def test_nested_roots_do_not_double_count(self, tmp_path):
        """The real case: the download folder sits inside the music folder, and
        both are handed in — which is what the UI sends when a folder is added
        to the roots already scanned."""
        music = tmp_path / "Music"
        downloads = music / "Downloads"
        _track(str(music / "Burial - Untrue"), "01 - Archangel.flac")
        _track(str(downloads / "Actress - Splazsh"), "01 - Hubble.flac")

        index = Library(str(tmp_path / "index.json"))
        index.scan([str(downloads), str(music)], read_tags=False)

        # Splazsh lives under BOTH roots. Without the dedupe it is walked twice
        # and this reads 2 tracks and 32 bytes for a folder holding one file.
        splazsh = self._release(index, "Splazsh")
        assert splazsh["trackCount"] == 1
        assert splazsh["bytes"] == 16
        # Untrue is under the parent only, so it is the control: it must be
        # unaffected either way, which proves the assertion above is about the
        # overlap and not about the scan being broken generally.
        assert self._release(index, "Untrue")["trackCount"] == 1

    def test_the_same_root_twice_does_not_double_count(self, tmp_path):
        _track(str(tmp_path / "Burial - Untrue"), "01 - Archangel.flac")
        index = Library(str(tmp_path / "index.json"))
        index.scan([str(tmp_path), str(tmp_path)], read_tags=False)
        assert self._release(index, "Untrue")["trackCount"] == 1

    def test_the_stored_roots_are_the_deduped_ones(self, tmp_path):
        """What is stored is what the screen shows and what a rescan sends
        back, so storing the raw list would put the overlap back next time."""
        music = tmp_path / "Music"
        downloads = music / "Downloads"
        os.makedirs(downloads)
        index = Library(str(tmp_path / "index.json"))
        state = index.scan([str(downloads), str(music)], read_tags=False)
        assert state["roots"] == [os.path.realpath(str(music))]


class TestAnUnpluggedDriveIsNotForgotten:
    """A rescan with an external drive unplugged used to rebuild the index from
    the folders that were still there: every release on the drive vanished, the
    drive dropped out of the folder list, and plugging it back in did not bring
    it back. Unplugging is simulated by renaming the folder away."""

    def _scan_then_unplug(self, tmp_path):
        downloads = tmp_path / "Downloads"
        drive = tmp_path / "SSD"
        _track(str(downloads / "Burial - Untrue"), "01 - Archangel.flac")
        _track(str(drive / "Actress - Splazsh"), "01 - Hubble.flac")
        index = Library(str(tmp_path / "index.json"))
        index.scan([str(downloads), str(drive)], read_tags=False)
        os.rename(drive, tmp_path / "SSD-unplugged")
        return index, downloads, drive

    def test_its_releases_survive_a_rescan(self, tmp_path):
        index, downloads, drive = self._scan_then_unplug(tmp_path)
        state = index.scan([str(downloads), str(drive)], read_tags=False)

        names = {r["release"] for r in index.releases()}
        assert names == {"Untrue", "Splazsh"}
        assert state["offlineRoots"] == [os.path.realpath(str(drive))]
        # Still in the folder list, so the next Rescan asks for it again.
        assert os.path.realpath(str(drive)) in state["roots"]

    def test_it_comes_back_when_plugged_in(self, tmp_path):
        index, downloads, drive = self._scan_then_unplug(tmp_path)
        index.scan([str(downloads), str(drive)], read_tags=False)
        os.rename(tmp_path / "SSD-unplugged", drive)
        state = index.scan([str(downloads), str(drive)], read_tags=False)
        assert state["offlineRoots"] == []
        assert {r["release"] for r in index.releases()} == {"Untrue", "Splazsh"}

    def test_leaving_it_out_of_the_roots_forgets_it(self, tmp_path):
        """The way to say "that drive is gone for good"."""
        index, downloads, _drive = self._scan_then_unplug(tmp_path)
        state = index.scan([str(downloads)], read_tags=False)
        assert state["offlineRoots"] == []
        assert {r["release"] for r in index.releases()} == {"Untrue"}

    def test_a_copy_on_disk_wins_over_the_remembered_one(self, tmp_path):
        """The same release on both: counted once, from the copy that is here."""
        index, downloads, drive = self._scan_then_unplug(tmp_path)
        _track(str(downloads / "Actress - Splazsh"), "01 - Hubble.flac")
        _track(str(downloads / "Actress - Splazsh"), "02 - Maze.flac")
        index.scan([str(downloads), str(drive)], read_tags=False)
        splazsh = next(r for r in index.releases() if r["release"] == "Splazsh")
        assert splazsh["trackCount"] == 2


class TestNothingIsCappedOrHalfWritten:
    def test_every_release_is_listed(self, tmp_path):
        """It was cut at 2,000, so a large collection lost its tail of the
        alphabet from the Library screen with nothing saying so."""
        for n in range(2_100):
            _track(str(tmp_path / f"Artist {n:04d} - Record {n:04d}"), "01 - x.mp3")
        index = Library(str(tmp_path / "index.json"))
        index.scan([str(tmp_path)], read_tags=False)
        assert len(index.releases()) == 2_100

    def test_a_scan_that_fails_keeps_the_old_index(self, tmp_path, monkeypatch):
        _track(str(tmp_path / "Burial - Untrue"), "01 - Archangel.flac")
        path = str(tmp_path / "index.json")
        index = Library(path)
        index.scan([str(tmp_path)], read_tags=False)

        def boom(*_args, **_kwargs):
            raise RuntimeError("volume went away mid-walk")

        monkeypatch.setattr(os, "walk", boom)
        try:
            index.scan([str(tmp_path)], read_tags=False)
        except RuntimeError:
            pass
        assert {r["release"] for r in index.releases()} == {"Untrue"}
        assert not index.state()["scanning"]
        # And what is on disk still loads.
        assert {r["release"] for r in Library(path).releases()} == {"Untrue"}

    def test_the_index_is_written_whole(self, tmp_path):
        """Atomic: the temp file is gone and the real one parses."""
        _track(str(tmp_path / "Burial - Untrue"), "01 - Archangel.flac")
        path = str(tmp_path / "index.json")
        Library(path).scan([str(tmp_path)], read_tags=False)
        assert not os.path.exists(path + ".tmp")
        assert {r["release"] for r in Library(path).releases()} == {"Untrue"}


class TestAScanThatIsInterrupted:
    def test_a_drive_pulled_out_mid_walk_keeps_its_last_full_picture(self, tmp_path, monkeypatch):
        """os.walk swallows the errors of a vanished folder and just stops, so a
        drive ejected half way read as a smaller collection."""
        downloads = tmp_path / "Downloads"
        drive = tmp_path / "SSD"
        _track(str(downloads / "Burial - Untrue"), "01 - Archangel.flac")
        _track(str(drive / "Actress - Splazsh"), "01 - Hubble.flac")
        _track(str(drive / "Drexciya - Neptune's Lair"), "01 - Andreaen Sand Dunes.flac")
        index = Library(str(tmp_path / "index.json"))
        index.scan([str(downloads), str(drive)], read_tags=False)

        real_walk = os.walk

        def ejecting_walk(top, *args, **kwargs):
            for i, step in enumerate(real_walk(top, *args, **kwargs)):
                yield step
                if os.path.realpath(top) == os.path.realpath(str(drive)) and i == 1:
                    os.rename(drive, tmp_path / "SSD-ejected")
                    return

        monkeypatch.setattr(os, "walk", ejecting_walk)
        state = index.scan([str(downloads), str(drive)], read_tags=False)

        assert {r["release"] for r in index.releases()} == {"Untrue", "Splazsh", "Neptune's Lair"}
        assert state["offlineRoots"] == [os.path.realpath(str(drive))]

    def test_cancel_keeps_the_old_index(self, tmp_path, monkeypatch):
        _track(str(tmp_path / "Burial - Untrue"), "01 - Archangel.flac")
        index = Library(str(tmp_path / "index.json"))
        index.scan([str(tmp_path)], read_tags=False)
        _track(str(tmp_path / "Actress - Splazsh"), "01 - Hubble.flac")

        real_walk = os.walk

        def cancelling_walk(*args, **kwargs):
            index.cancel()
            yield from real_walk(*args, **kwargs)

        monkeypatch.setattr(os, "walk", cancelling_walk)
        state = index.scan([str(tmp_path)], read_tags=False)
        assert {r["release"] for r in index.releases()} == {"Untrue"}
        assert state["scanning"] is False
