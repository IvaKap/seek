# Seek — local path checking, and the folder settings that depend on it.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# `settings.patch` used to write whatever string it was handed into
# `transfers/downloaddir`. Nothing downstream re-checks it, so a mistyped
# folder surfaces as every transfer failing with upstream's
# `download_folder_error`, one file at a time, with nothing on the settings
# screen connecting the two. These tests pin the refusal.
#
# They run against CoreHost's path helpers directly rather than over the
# socket: the socket path is covered in test_integration.py, and the cases
# worth having many of are the filesystem shapes, not the framing.

import os
import stat

import pytest

from seek_sidecar.core_host import CoreHost, CommandError


@pytest.fixture
def host():
    """A real CoreHost with __init__ deliberately not run.

    CoreHost.__init__ boots pynicotine's core, which mutates process-global
    singletons and cannot run twice in one process — test_integration.py owns
    the one instance a run is allowed. None of the path helpers touch instance
    state, so an uninitialised instance exercises the real methods; borrowing
    them onto a stand-in class would not, because assigning a staticmethod read
    off a class rebinds it as an ordinary method and every call gains a `self`.
    """
    return CoreHost.__new__(CoreHost)


# ------------------------------------------------------------------ resolve


def test_tilde_is_expanded_before_anything_else_sees_it(host):
    """Upstream expands nothing. A literal `~/Music` in the config creates a
    directory actually called `~` beside wherever the process started."""
    check = host._path_check("~/Music")
    assert check["resolved"] == os.path.join(os.path.expanduser("~"), "Music")
    assert "~" not in check["resolved"]


def test_the_path_as_given_is_reported_unchanged(host, tmp_path):
    """The UI echoes what the user typed; only `resolved` is the config value."""
    check = host._path_check("~/Music")
    assert check["path"] == "~/Music"


def test_an_empty_path_stays_empty_rather_than_becoming_the_cwd(host):
    """os.path.abspath("") returns the CURRENT WORKING DIRECTORY. Without a
    guard, an empty settings field resolves to whatever folder the sidecar was
    launched from, and then reports itself as an existing, writable, perfectly
    acceptable download folder — a wrong answer that looks like a right one."""
    for empty in ("", "   ", None):
        check = host._path_check(empty)
        assert check["resolved"] == ""
        assert check["exists"] is False
        assert check["isDirectory"] is False
        assert check["writable"] is False
        assert check["parentExists"] is False


def test_a_config_path_variable_is_expanded(host, tmp_path, monkeypatch):
    """Upstream's shipped default for the in-progress folder is literally
    `${NICOTINE_DATA_HOME}/incomplete`, and pynicotine expands it with
    os.path.expandvars at the point of use. Checking the raw string reports
    that a perfectly good folder does not exist."""
    monkeypatch.setenv("NICOTINE_DATA_HOME", str(tmp_path))
    target = tmp_path / "incomplete"
    target.mkdir()

    check = host._path_check("${NICOTINE_DATA_HOME}/incomplete")

    assert check["resolved"] == str(target)
    assert check["isDirectory"] is True
    assert check["writable"] is True


def test_an_unset_variable_fails_honestly_rather_than_silently(host, monkeypatch):
    """os.path.expandvars leaves an unknown variable in place. The path then
    does not exist, which is the truth — better than quietly dropping the
    segment and checking some shorter path the user never named."""
    monkeypatch.delenv("SEEK_NO_SUCH_VAR", raising=False)
    check = host._path_check("${SEEK_NO_SUCH_VAR}/music")
    assert check["exists"] is False
    assert "SEEK_NO_SUCH_VAR" in check["resolved"]


def test_a_relative_path_becomes_absolute(host):
    check = host._path_check("Downloads")
    assert os.path.isabs(check["resolved"])


def test_surrounding_whitespace_is_dropped(host, tmp_path):
    """A path pasted from Finder or a terminal routinely arrives with a
    trailing space or newline, and a folder named "Music " is not the folder
    the user meant."""
    check = host._path_check(f"  {tmp_path}  ")
    assert check["resolved"] == str(tmp_path)


# -------------------------------------------------------------------- facts


def test_an_ordinary_writable_folder_reports_every_fact_true(host, tmp_path):
    check = host._path_check(str(tmp_path))
    assert check["exists"] is True
    assert check["isDirectory"] is True
    assert check["writable"] is True
    assert check["parentExists"] is True


def test_a_missing_folder_whose_parent_exists_says_it_could_be_created(host, tmp_path):
    check = host._path_check(str(tmp_path / "not-yet"))
    assert check["exists"] is False
    assert check["isDirectory"] is False
    assert check["writable"] is False
    assert check["parentExists"] is True
    assert check["parentWritable"] is True


def test_a_missing_folder_several_levels_deep_reports_no_parent(host, tmp_path):
    check = host._path_check(str(tmp_path / "a" / "b" / "c"))
    assert check["exists"] is False
    assert check["parentExists"] is False
    assert check["parentWritable"] is False


def test_a_file_is_not_a_directory(host, tmp_path):
    target = tmp_path / "a-file.txt"
    target.write_text("not a folder")
    check = host._path_check(str(target))
    assert check["exists"] is True
    assert check["isDirectory"] is False
    assert check["writable"] is False


def test_writability_is_tested_by_writing_not_by_reading_the_mode(host, tmp_path):
    """os.access() answers from the permission bits, and this is the case that
    separates the two: chmod 500 leaves the directory readable and executable
    but not writable, and only an actual write finds out."""
    locked = tmp_path / "read-only"
    locked.mkdir()
    locked.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        check = host._path_check(str(locked))
        assert check["exists"] is True
        assert check["isDirectory"] is True
        assert check["writable"] is False
    finally:
        locked.chmod(stat.S_IRWXU)


def test_the_write_probe_leaves_nothing_behind(host, tmp_path):
    before = set(os.listdir(tmp_path))
    assert host._path_check(str(tmp_path))["writable"] is True
    assert set(os.listdir(tmp_path)) == before


# ------------------------------------------------------------- fs.check cmd


def test_fs_check_returns_the_facts_and_no_verdict(host, tmp_path):
    """The seam: which facts matter is the frontend's decision. A download
    folder must be writable; a shared folder only has to be readable. The
    sidecar must not collapse that into one boolean or one message."""
    result = host._cmd_fs_check({"path": str(tmp_path)})
    assert set(result) == {
        "path", "resolved", "exists", "isDirectory", "writable",
        "parentExists", "parentWritable",
    }
    assert not any(isinstance(v, str) and " " in v for k, v in result.items()
                   if k not in ("path", "resolved"))


# ------------------------------------------------------- fs.ensureFolder cmd


def test_ensure_folder_creates_missing_parents(host, tmp_path):
    target = tmp_path / "one" / "two" / "three"
    result = host._cmd_fs_ensureFolder({"path": str(target)})
    assert result["isDirectory"] is True
    assert result["writable"] is True
    assert os.path.isdir(target)


def test_ensure_folder_on_an_existing_folder_is_a_no_op(host, tmp_path):
    existing = tmp_path / "already"
    existing.mkdir()
    (existing / "keep.txt").write_text("do not lose me")

    result = host._cmd_fs_ensureFolder({"path": str(existing)})

    assert result["isDirectory"] is True
    assert (existing / "keep.txt").read_text() == "do not lose me"


def test_ensure_folder_refuses_rather_than_clobbering_a_file(host, tmp_path):
    target = tmp_path / "a-file.txt"
    target.write_text("mine")
    with pytest.raises(CommandError) as error:
        host._cmd_fs_ensureFolder({"path": str(target)})
    assert error.value.code == "bad_request"
    assert target.read_text() == "mine"


def test_ensure_folder_needs_a_path(host):
    for empty in ("", "   ", "/"):
        with pytest.raises(CommandError) as error:
            host._cmd_fs_ensureFolder({"path": empty})
        assert error.value.code == "bad_request"


def test_ensure_folder_reports_a_permission_failure_rather_than_raising_oserror(
    host, tmp_path,
):
    locked = tmp_path / "read-only"
    locked.mkdir()
    locked.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        with pytest.raises(CommandError) as error:
            host._cmd_fs_ensureFolder({"path": str(locked / "child")})
        assert error.value.code == "bad_request"
        # The reason has to name the path — "could not create" alone leaves the
        # user with nothing to act on.
        assert str(locked) in str(error.value)
    finally:
        locked.chmod(stat.S_IRWXU)


# --------------------------------------------------- the settings guard rail


def test_a_writable_folder_is_accepted_and_stored_resolved(host, tmp_path):
    stored = host._require_writable_dir("the download folder", f"{tmp_path}/")
    assert stored == str(tmp_path)


def test_a_missing_download_folder_is_refused_by_name(host, tmp_path):
    missing = tmp_path / "nope"
    with pytest.raises(CommandError) as error:
        host._require_writable_dir("the download folder", str(missing))
    assert error.value.code == "bad_request"
    assert "does not exist" in str(error.value)
    assert str(missing) in str(error.value)


def test_a_file_given_as_a_download_folder_is_refused(host, tmp_path):
    target = tmp_path / "a-file.txt"
    target.write_text("x")
    with pytest.raises(CommandError) as error:
        host._require_writable_dir("the download folder", str(target))
    assert "not a folder" in str(error.value)


def test_an_unwritable_download_folder_is_refused(host, tmp_path):
    locked = tmp_path / "read-only"
    locked.mkdir()
    locked.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        with pytest.raises(CommandError) as error:
            host._require_writable_dir("the download folder", str(locked))
        assert "not writable" in str(error.value)
    finally:
        locked.chmod(stat.S_IRWXU)


def test_the_label_reaches_the_message_so_two_fields_read_differently(host, tmp_path):
    """Two folder settings share this guard. "the folder does not exist" would
    not say which one."""
    missing = str(tmp_path / "nope")
    with pytest.raises(CommandError) as error:
        host._require_writable_dir("the in-progress folder", missing)
    assert "the in-progress folder" in str(error.value)
