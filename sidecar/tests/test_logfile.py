"""
Seek — the diagnostic log, and what must never end up in it.
SPDX-License-Identifier: GPL-3.0-or-later

This file is written to be EMAILED TO A STRANGER. Every test below is a
property that has to hold for that to be safe advice, rather than a test that
logging works — logging working is not the risky part.

The log exists because a user reported "i pasted and saved the token, now the
search says discogs token needed", and finding the cause needed a live sidecar
and a hand-built websocket client. It should have needed one attached file.
"""

import logging
import os

import pytest

from seek_sidecar import logfile


@pytest.fixture
def attached(tmp_path):
    """Attach a handler, and take it off again however the test ends.

    Handlers are process-global; leaking one makes every later test in the run
    write into a deleted tmp_path.
    """
    seek = logging.getLogger("seek")
    before = list(seek.handlers)
    level = seek.level
    path = logfile.attach(str(tmp_path))
    yield path
    for handler in list(seek.handlers):
        if handler not in before:
            handler.close()
            seek.removeHandler(handler)
    seek.setLevel(level)


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


# ------------------------------------------------------------ where it lives


def test_the_log_sits_beside_seek_state_not_in_upstreams_log_folder(tmp_path):
    """`<data>/logs/` is upstream's, and holds `logs/private/<peer>.log` —
    real chat transcripts. A file we ask people to send must not sit next to
    those, or someone will helpfully zip the folder."""
    path = logfile.log_path(str(tmp_path))
    assert path == os.path.join(str(tmp_path), "data", "seek.log")
    assert os.path.join("data", "logs") not in path


def test_log_path_creates_nothing(tmp_path):
    """The hello reply asks for the path on every connect. Answering must not
    have side effects."""
    logfile.log_path(str(tmp_path))
    assert not os.listdir(str(tmp_path))


def test_attaching_creates_the_file_and_writes_to_it(attached):
    logging.getLogger("seek.core").info("hello from the engine")
    assert os.path.exists(attached)
    assert "hello from the engine" in read(attached)


# ------------------------------------------------- what must NOT be captured


def test_only_seek_loggers_are_captured(attached):
    """The handler is on `seek`, not on root. That is what keeps peer handles,
    filenames and search terms — none of which Seek's own loggers emit, but all
    of which pass through the root logger — out of a file people attach."""
    logging.getLogger("seek.discover").info("ours")
    logging.getLogger("pynicotine.transfers").info("SOMEONE ELSES PEER DATA")
    logging.getLogger("urllib3").warning("A THIRD PARTY")

    body = read(attached)
    assert "ours" in body
    assert "SOMEONE ELSES PEER DATA" not in body
    assert "A THIRD PARTY" not in body


def test_the_handler_is_not_on_the_root_logger(attached):
    """Stated directly, because the test above would also pass if root simply
    had no handlers at that moment."""
    seek = logging.getLogger("seek")
    added = [h for h in seek.handlers if isinstance(h, logging.FileHandler)]
    assert added, "nothing was attached to the seek logger"
    assert not [h for h in logging.getLogger().handlers if h in added]


def test_the_home_directory_never_appears(attached):
    """`core_host.start` logs three absolute paths on every launch, and the
    first carries the user's real name. The most likely accidental PII in a bug
    report, removed once rather than audited at every call site."""
    home = os.path.expanduser("~")
    logging.getLogger("seek.core").info("config  -> %s/Library/Whatever", home)

    body = read(attached)
    assert home not in body
    assert "~/Library/Whatever" in body


def test_redaction_survives_a_path_passed_as_an_argument(attached):
    """Applied at format time, so `%s` arguments are covered too — which is how
    every one of the real call sites passes its paths."""
    home = os.path.expanduser("~")
    logging.getLogger("seek.library").warning("could not read %s", f"{home}/Music/x.flac")
    assert home not in read(attached)


def test_debug_records_are_dropped_unless_asked_for(attached):
    """The DEBUG call sites are the ones that log search terms and browsed
    URLs. At the default level they never reach the file at all."""
    logging.getLogger("seek.enrich").debug("MusicBrainz miss for %s", "Some Artist")
    assert "Some Artist" not in read(attached)


# ------------------------------------------------------------- robustness


def test_a_failure_to_open_does_not_stop_the_sidecar(tmp_path):
    """A diagnostic aid that prevents the app starting is worse than none."""
    blocker = tmp_path / "data"
    blocker.write_text("I am a file where a directory should be")
    # Must not raise, and must still say where the log would have been.
    assert logfile.attach(str(tmp_path)) == logfile.log_path(str(tmp_path))


def test_the_file_is_capped(attached):
    """Small enough to paste into an issue; `RotatingFileHandler` keeps one
    previous file, the same shape as upstream's own config/config.old."""
    assert logfile.MAX_BYTES <= 2 * 1024 * 1024
    handler = next(h for h in logging.getLogger("seek").handlers
                   if isinstance(h, logging.FileHandler))
    assert handler.maxBytes == logfile.MAX_BYTES
    assert handler.backupCount == logfile.BACKUPS


def test_logging_handlers_is_importable_at_all():
    """Guards the FROZEN build, not this one. `logging.handlers` is a separate
    module that PyInstaller only bundles if something imports it — nothing did,
    so it was absent from the freeze. The failure mode is the expensive one:
    fine from the venv, dead in the shipped app, exactly as the missing CA
    bundle was. `release.sh` cannot check this one, so the import is explicit
    in logfile.py and named in the spec."""
    import logging.handlers
    assert logging.handlers.RotatingFileHandler
