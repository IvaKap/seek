"""
Seek — reading the checksum sidecar a release shipped with.

WHY THESE ARE PICKY. This is the only HARD fact Seek can offer about a
downloaded file — the protocol carries no hashes at all — so a checker that is
subtly wrong is worse than none. A false mismatch accuses a good file; a false
match is a promise the app cannot keep.

The FLAC header parsing is cross-checked against mutagen on 400 real files from
a live library: 400 agreements, 0 disagreements, and 17 of the 400 carried no
STREAMINFO signature at all — which is why `no_signature` is a first-class
outcome here and not an afterthought. The headers below are synthetic because a
synthetic header is the only way to test the cases a real library does not
happen to contain.
"""

import hashlib
import os

import pytest

from seek_sidecar import checksums


# -- building FLAC headers ---------------------------------------------------
#
# Only the first 42 bytes of a FLAC are ever read, so that is all we build. The
# STREAMINFO block is 34 bytes and the MD5 signature is the last 16 of them.

SIG = bytes(range(16))
SIG_HEX = SIG.hex()


def flac(signature=SIG, *, magic=b"fLaC", block_type=0, declared=34, id3=None,
         truncate=None):
    streaminfo = bytes(18) + signature
    header = bytes([block_type]) + declared.to_bytes(3, "big")
    out = magic + header + streaminfo
    if id3 is not None:
        # 10-byte ID3v2 header, then `id3` bytes of tag, then the FLAC.
        size = bytes([(id3 >> 21) & 0x7F, (id3 >> 14) & 0x7F,
                      (id3 >> 7) & 0x7F, id3 & 0x7F])
        out = b"ID3\x04\x00\x00" + size + (b"\x00" * id3) + out
    return out[:truncate] if truncate is not None else out


def write(folder, name, data):
    path = os.path.join(str(folder), name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data if isinstance(data, bytes) else data.encode("utf-8"))
    return path


# -- flac_signature ----------------------------------------------------------

def test_the_signature_is_read_from_the_right_place(tmp_path):
    path = write(tmp_path, "a.flac", flac())
    assert checksums.flac_signature(path) == (SIG_HEX, None)


def test_a_different_signature_reads_differently(tmp_path):
    # Guards the offset: a parser reading a fixed 16 bytes of the padding
    # would return the same answer for both of these.
    a = write(tmp_path, "a.flac", flac(b"\xaa" * 16))
    b = write(tmp_path, "b.flac", flac(b"\xbb" * 16))
    assert checksums.flac_signature(a)[0] == "aa" * 16
    assert checksums.flac_signature(b)[0] == "bb" * 16


def test_an_unset_signature_is_not_a_failed_check(tmp_path):
    # 4% of a real 3,900-file library. Reporting "mismatch" here would accuse
    # one file in twenty-three of being something it is not.
    path = write(tmp_path, "a.flac", flac(bytes(16)))
    assert checksums.flac_signature(path) == (None, "no_signature")


def test_something_that_is_not_a_flac(tmp_path):
    path = write(tmp_path, "a.flac", flac(magic=b"OggS"))
    assert checksums.flac_signature(path) == (None, "not_flac")


def test_an_id3_tag_in_front_is_skipped(tmp_path):
    # Wrong, rare, and real. Without the skip a perfectly good file reports
    # "not a FLAC" and its checksum is never checked.
    path = write(tmp_path, "a.flac", flac(id3=57))
    assert checksums.flac_signature(path) == (SIG_HEX, None)


def test_a_truncated_id3_header_does_not_explode(tmp_path):
    path = write(tmp_path, "a.flac", b"ID3\x04\x00")
    assert checksums.flac_signature(path) == (None, "not_flac")


def test_streaminfo_must_come_first(tmp_path):
    # Block type 4 is VORBIS_COMMENT. The format requires STREAMINFO first, so
    # reading 34 bytes of a comment block as a signature would be nonsense.
    path = write(tmp_path, "a.flac", flac(block_type=4))
    assert checksums.flac_signature(path) == (None, "not_flac")


def test_the_last_block_flag_is_not_mistaken_for_a_block_type(tmp_path):
    # Bit 7 marks the final metadata block. A one-block FLAC sets it on
    # STREAMINFO, so masking it off is what makes such a file readable.
    path = write(tmp_path, "a.flac", flac(block_type=0x80))
    assert checksums.flac_signature(path) == (SIG_HEX, None)


def test_a_block_too_short_to_hold_a_signature(tmp_path):
    path = write(tmp_path, "a.flac", flac(declared=18))
    assert checksums.flac_signature(path) == (None, "not_flac")


def test_a_file_that_stops_mid_signature(tmp_path):
    path = write(tmp_path, "a.flac", flac(truncate=40))
    assert checksums.flac_signature(path) == (None, "not_flac")


# -- parse_ffp ---------------------------------------------------------------

def test_ffp_lines_parse():
    text = f"01 Intro.flac:{SIG_HEX}\n02 Outro.flac:{'ab' * 16}\n"
    pairs, unparsed = checksums.parse_ffp(text)
    assert pairs == [("01 Intro.flac", SIG_HEX), ("02 Outro.flac", "ab" * 16)]
    assert unparsed == 0


def test_ffp_splits_on_the_last_colon():
    # A Windows path has one of its own, and splitting on the first would give
    # a name of "C" and a digest of the rest.
    pairs, _ = checksums.parse_ffp(f"C:\\rips\\01.flac:{SIG_HEX}\n")
    assert pairs == [("C:\\rips\\01.flac", SIG_HEX)]


def test_ffp_uppercase_hex_is_normalised():
    pairs, _ = checksums.parse_ffp(f"a.flac:{SIG_HEX.upper()}\n")
    assert pairs == [("a.flac", SIG_HEX)]


def test_ffp_comments_and_blanks_are_not_counted_as_damage():
    text = f"; made by foo\n\n# note\na.flac:{SIG_HEX}\n"
    pairs, unparsed = checksums.parse_ffp(text)
    assert len(pairs) == 1
    assert unparsed == 0


def test_ffp_garbage_is_counted_rather_than_dropped():
    # A half-understood sidecar must not look like one that verified cleanly.
    text = f"a.flac:{SIG_HEX}\nwhat is this\nb.flac:tooshort\n:{SIG_HEX}\n"
    pairs, unparsed = checksums.parse_ffp(text)
    assert len(pairs) == 1
    assert unparsed == 3


def test_ffp_tolerates_crlf_and_a_byte_order_mark():
    pairs, unparsed = checksums.parse_ffp(f"\ufeffa.flac:{SIG_HEX}\r\n")
    assert pairs == [("a.flac", SIG_HEX)]
    assert unparsed == 0


# -- parse_md5 ---------------------------------------------------------------

def test_md5_binary_and_text_forms_both_parse():
    text = f"{SIG_HEX} *a.flac\n{'cd' * 16}  b.flac\n"
    pairs, unparsed = checksums.parse_md5(text)
    assert pairs == [("a.flac", SIG_HEX), ("b.flac", "cd" * 16)]
    assert unparsed == 0


def test_md5_keeps_a_name_containing_spaces():
    pairs, _ = checksums.parse_md5(f"{SIG_HEX} *01 - The Track Name.flac\n")
    assert pairs == [("01 - The Track Name.flac", SIG_HEX)]


def test_md5_accepts_a_tab_separator():
    pairs, unparsed = checksums.parse_md5(f"{SIG_HEX}\ta.flac\n")
    assert pairs == [("a.flac", SIG_HEX)]
    assert unparsed == 0


def test_md5_garbage_is_counted():
    text = f"{SIG_HEX} *a.flac\nnot a checksum line\ndeadbeef  b.flac\n"
    pairs, unparsed = checksums.parse_md5(text)
    assert len(pairs) == 1
    assert unparsed == 2


def test_md5_uppercase_hex_is_normalised():
    # `md5sum` writes lowercase; several Windows tools write uppercase. Left
    # as-is this compares unequal against the digest we compute and produces a
    # FALSE MISMATCH, which is the worst thing this feature could do.
    pairs, _ = checksums.parse_md5(f"{SIG_HEX.upper()} *a.flac\n")
    assert pairs == [("a.flac", SIG_HEX)]


def test_md5_does_not_accept_a_digest_with_no_name():
    pairs, unparsed = checksums.parse_md5(f"{SIG_HEX}\n")
    assert pairs == []
    assert unparsed == 1


# -- resolving a name to a local file ----------------------------------------

def test_a_plain_name_resolves(tmp_path):
    write(tmp_path, "a.flac", flac())
    assert checksums._resolve(str(tmp_path), "a.flac").endswith("a.flac")


@pytest.mark.parametrize("written", ["CD1/a.flac", "CD1\\a.flac"])
def test_a_subfolder_resolves_in_either_slash(tmp_path, written):
    # The multi-disc case: one fingerprint at the release root, audio in CD1/.
    write(tmp_path, os.path.join("CD1", "a.flac"), flac())
    got = checksums._resolve(str(tmp_path), written)
    assert got == os.path.join(str(tmp_path), "CD1", "a.flac")


def test_the_rippers_own_directory_falls_back_to_the_basename(tmp_path):
    write(tmp_path, "a.flac", flac())
    got = checksums._resolve(str(tmp_path), "D:\\rips\\2004\\a.flac")
    assert got == os.path.join(str(tmp_path), "a.flac")


def test_a_path_out_of_the_folder_is_refused(tmp_path):
    # THE SIDECAR CAME FROM A STRANGER. We only ever read and report a digest,
    # but reporting the digest of a file outside the folder still tells that
    # stranger something about this machine.
    outside = write(tmp_path, "secret.key", b"sensitive")
    folder = os.path.join(str(tmp_path), "release")
    os.makedirs(folder)
    assert checksums._resolve(folder, "../secret.key") == ""
    assert checksums._resolve(folder, "..\\secret.key") == ""
    assert checksums._resolve(folder, outside) == ""


def test_a_name_that_normalises_back_inside_is_still_allowed(tmp_path):
    folder = os.path.join(str(tmp_path), "release")
    write(tmp_path, os.path.join("release", "a.flac"), flac())
    assert checksums._resolve(folder, "../release/a.flac").endswith("a.flac")


def test_a_missing_file_resolves_to_nothing(tmp_path):
    assert checksums._resolve(str(tmp_path), "nope.flac") == ""


# -- verify_folder -----------------------------------------------------------

def test_a_folder_with_no_sidecars_is_an_answer_not_a_failure(tmp_path):
    write(tmp_path, "a.flac", flac())
    report = checksums.verify_folder(str(tmp_path))
    assert report["sidecars"] == []
    assert report["entries"] == []


def test_an_ffp_that_agrees(tmp_path):
    write(tmp_path, "a.flac", flac())
    write(tmp_path, "album.ffp", f"a.flac:{SIG_HEX}\n")

    report = checksums.verify_folder(str(tmp_path))
    (entry,) = report["entries"]
    assert entry["kind"] == "ffp"
    assert entry["expected"] == SIG_HEX
    assert entry["actual"] == SIG_HEX
    assert entry["issue"] is None


def test_an_ffp_that_disagrees_reports_both_values(tmp_path):
    # No verdict here on purpose — expected and actual are both carried and the
    # comparison is the frontend's, because the WORDING of a mismatch depends
    # on which kind of sidecar it came from.
    write(tmp_path, "a.flac", flac(b"\xff" * 16))
    write(tmp_path, "album.ffp", f"a.flac:{SIG_HEX}\n")

    (entry,) = checksums.verify_folder(str(tmp_path))["entries"]
    assert entry["expected"] == SIG_HEX
    assert entry["actual"] == "ff" * 16
    assert entry["issue"] is None


def test_an_md5_hashes_the_whole_file(tmp_path):
    body = flac() + b"payload"
    write(tmp_path, "a.flac", body)
    digest = hashlib.md5(body).hexdigest()
    write(tmp_path, "album.md5", f"{digest} *a.flac\n")

    (entry,) = checksums.verify_folder(str(tmp_path))["entries"]
    assert entry["kind"] == "md5"
    assert entry["actual"] == digest
    assert entry["issue"] is None


def test_the_two_kinds_answer_separately_for_one_file(tmp_path):
    # The point of carrying both: an .md5 changes when a tag is edited and an
    # .ffp does not, so a file can legitimately fail one and pass the other.
    body = flac() + b"tags were edited"
    write(tmp_path, "a.flac", body)
    write(tmp_path, "album.ffp", f"a.flac:{SIG_HEX}\n")
    write(tmp_path, "album.md5", f"{'00' * 16} *a.flac\n")

    entries = {e["kind"]: e for e in checksums.verify_folder(str(tmp_path))["entries"]}
    assert entries["ffp"]["actual"] == SIG_HEX
    assert entries["md5"]["actual"] == hashlib.md5(body).hexdigest()
    assert entries["md5"]["expected"] == "00" * 16


def test_a_file_the_sidecar_names_but_the_folder_lacks(tmp_path):
    # How you learn a release is incomplete, which is worth more than silence.
    write(tmp_path, "album.ffp", f"a.flac:{SIG_HEX}\nb.flac:{'ab' * 16}\n")
    write(tmp_path, "a.flac", flac())

    entries = {e["name"]: e for e in checksums.verify_folder(str(tmp_path))["entries"]}
    assert entries["a.flac"]["issue"] is None
    assert entries["b.flac"]["issue"] == "missing"
    assert entries["b.flac"]["actual"] is None
    assert entries["b.flac"]["localPath"] == ""


def test_an_ffp_naming_something_that_is_not_a_flac(tmp_path):
    write(tmp_path, "a.flac", b"this is not a flac at all")
    write(tmp_path, "album.ffp", f"a.flac:{SIG_HEX}\n")

    (entry,) = checksums.verify_folder(str(tmp_path))["entries"]
    assert entry["issue"] == "not_flac"
    assert entry["actual"] is None


def test_the_sidecar_itself_is_reported_with_its_counts(tmp_path):
    write(tmp_path, "a.flac", flac())
    write(tmp_path, "album.ffp", f"a.flac:{SIG_HEX}\nrubbish\n")

    (sidecar,) = checksums.verify_folder(str(tmp_path))["sidecars"]
    assert sidecar["kind"] == "ffp"
    assert sidecar["entryCount"] == 1
    assert sidecar["unparsedLines"] == 1
    assert sidecar["error"] == ""
    assert sidecar["path"].endswith("album.ffp")


def test_an_oversized_sidecar_is_refused_without_killing_the_rest(tmp_path):
    write(tmp_path, "a.flac", flac())
    write(tmp_path, "huge.md5", b"x" * (checksums.MAX_SIDECAR_BYTES + 1))
    write(tmp_path, "album.ffp", f"a.flac:{SIG_HEX}\n")

    report = checksums.verify_folder(str(tmp_path))
    bad = next(s for s in report["sidecars"] if s["path"].endswith("huge.md5"))
    assert bad["error"] != ""
    assert bad["entryCount"] == 0
    # The good one still ran.
    assert len(report["entries"]) == 1


def test_extensions_are_matched_case_insensitively(tmp_path):
    write(tmp_path, "a.flac", flac())
    write(tmp_path, "ALBUM.FFP", f"a.flac:{SIG_HEX}\n")
    assert len(checksums.verify_folder(str(tmp_path))["entries"]) == 1


def test_find_sidecars_ignores_everything_else(tmp_path):
    for name in ("album.ffp", "album.md5", "album.sfv", "album.nfo",
                 "album.log", "a.flac"):
        write(tmp_path, name, b"x")
    found = [os.path.basename(p) for p in checksums.find_sidecars(str(tmp_path))]
    assert found == ["album.ffp", "album.md5"]


def test_a_folder_that_is_not_there(tmp_path):
    missing = os.path.join(str(tmp_path), "gone")
    assert checksums.verify_folder(missing) == {
        "folderPath": missing, "sidecars": [], "entries": [],
    }


# -- which folder gets checked -----------------------------------------------
#
# CoreHost._checksum_folder, driven directly. CoreHost.__init__ boots
# pynicotine's core, which cannot run twice in a process (test_integration.py
# owns the one instance a run is allowed), so the method is bound to a stub.

from seek_sidecar.core_host import CoreHost


class _Host:
    def __init__(self, root=""):
        self.root = root
        self.broadcasts = []
        self.bridge = self

    def broadcast(self, name, payload):
        self.broadcasts.append((name, payload))

    def _download_root(self):
        return self.root

    _checksum_folder = CoreHost._checksum_folder
    _run_checksums = CoreHost._run_checksums


def test_the_files_own_folder_wins(tmp_path):
    write(tmp_path, os.path.join("release", "a.flac"), flac())
    write(tmp_path, os.path.join("release", "album.ffp"), f"a.flac:{SIG_HEX}\n")
    write(tmp_path, "stray.ffp", f"a.flac:{SIG_HEX}\n")

    host = _Host(root=str(tmp_path))
    folder = host._checksum_folder(os.path.join(str(tmp_path), "release", "a.flac"))
    assert folder == os.path.join(str(tmp_path), "release")


def test_a_multi_disc_fingerprint_one_level_up_is_found(tmp_path):
    # One .ffp at the release root, audio in CD1/. Looking only beside the file
    # finds nothing on exactly the releases most likely to carry one.
    write(tmp_path, os.path.join("release", "CD1", "a.flac"), flac())
    write(tmp_path, os.path.join("release", "album.ffp"), f"CD1/a.flac:{SIG_HEX}\n")

    host = _Host(root=str(tmp_path))
    folder = host._checksum_folder(
        os.path.join(str(tmp_path), "release", "CD1", "a.flac"))
    assert folder == os.path.join(str(tmp_path), "release")

    (entry,) = checksums.verify_folder(folder)["entries"]
    assert entry["actual"] == SIG_HEX


def test_a_stray_sidecar_in_the_download_root_is_never_borrowed(tmp_path):
    # Someone else's .md5 sitting loose in the downloads folder has nothing to
    # do with this release, and every file in it would report "missing".
    write(tmp_path, os.path.join("release", "a.flac"), flac())
    write(tmp_path, "someone-elses.md5", f"{SIG_HEX} *b.flac\n")

    host = _Host(root=str(tmp_path))
    folder = host._checksum_folder(os.path.join(str(tmp_path), "release", "a.flac"))
    assert folder == os.path.join(str(tmp_path), "release")


def test_the_parent_is_left_alone_when_it_has_nothing_either(tmp_path):
    write(tmp_path, os.path.join("release", "CD1", "a.flac"), flac())
    host = _Host(root=str(tmp_path))
    child = os.path.join(str(tmp_path), "release", "CD1")
    assert host._checksum_folder(os.path.join(child, "a.flac")) == child


def test_no_configured_download_root_still_allows_the_parent(tmp_path):
    # An unset root must not disable the multi-disc case; it only removes the
    # one guard that stops us borrowing from the root itself.
    write(tmp_path, os.path.join("release", "CD1", "a.flac"), flac())
    write(tmp_path, os.path.join("release", "album.ffp"), f"CD1/a.flac:{SIG_HEX}\n")

    host = _Host(root="")
    folder = host._checksum_folder(
        os.path.join(str(tmp_path), "release", "CD1", "a.flac"))
    assert folder == os.path.join(str(tmp_path), "release")


def test_the_report_carries_the_request_and_transfer_back(tmp_path):
    write(tmp_path, "a.flac", flac())
    write(tmp_path, "album.ffp", f"a.flac:{SIG_HEX}\n")

    host = _Host()
    host._run_checksums("req-1", str(tmp_path), "/x/a.flac", "tr-9")

    (name, payload) = host.broadcasts[0]
    assert name == "checksums.result"
    assert payload["requestId"] == "req-1"
    assert payload["transferId"] == "tr-9"
    assert payload["folderPath"] == str(tmp_path)


def test_a_transfer_id_of_none_stays_none(tmp_path):
    # `str(None)` here would put the literal "None" on the wire, and the app
    # would key a report against a transfer that does not exist.
    host = _Host()
    host._run_checksums("req-1", str(tmp_path), None, None)
    assert host.broadcasts[0][1]["transferId"] is None


def test_a_folder_that_cannot_be_read_fails_the_request_not_the_pool(tmp_path, monkeypatch):
    monkeypatch.setattr(checksums, "verify_folder",
                        lambda _f: (_ for _ in ()).throw(RuntimeError("disk on fire")))
    host = _Host()
    host._run_checksums("req-1", str(tmp_path), "/x/a.flac", None)

    (name, payload) = host.broadcasts[0]
    assert name == "checksums.failed"
    assert payload["requestId"] == "req-1"
    assert "disk on fire" in payload["reason"]
