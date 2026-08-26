# Seek — importing settings from an existing Nicotine+ install.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# EVERY config in this file is SYNTHETIC and written by these tests into tmp_path.
# Nothing here reads the real ~/.config/nicotine/config, and a guard test below
# asserts that no fixture path ever points at it. The user runs the import on
# their own data themselves; this suite proves the machinery, not their account.

import os

import pytest

from seek_sidecar import nicotine_import, protocol

REAL_CONFIG = os.path.expanduser("~/.config/nicotine/config")

# A synthetic config in upstream's actual on-disk format: ConfigParser INI whose
# values are Python reprs (upstream writes str(value), reads via literal_eval).
SYNTHETIC = """\
[server]
login = testuser_synthetic
passw = synthetic-password-not-real
portrange = (2234, 2234)
auto_connect_startup = True

[transfers]
downloaddir = /Volumes/Music/incoming
incompletedir = /Volumes/Music/.incomplete
uploadslots = 3
shared = [('Music', '/Volumes/Music/library'), ('Rips', '/Users/x/rips')]

[searches]
enable_history = True
"""


def write_config(tmp_path, text=SYNTHETIC, name="config"):
    path = os.path.join(str(tmp_path), name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return path


class FakeConfig:
    """Stand-in for the pynicotine config singleton."""

    def __init__(self):
        self.sections = {"server": {}, "transfers": {}}
        self.written = 0

    def write_configuration(self):
        self.written += 1


# ------------------------------------------------------------------ safety

def test_no_test_in_this_file_touches_the_real_config(tmp_path):
    """Guard rail. The importer must be provably exercised on synthetic data."""
    path = write_config(tmp_path)
    assert os.path.abspath(path) != os.path.abspath(REAL_CONFIG)
    assert str(tmp_path) in path
    assert "/.config/nicotine" not in path


def test_default_path_points_where_nicotine_actually_keeps_it():
    """Not read here — only that the lookup is right, so the UI can name the
    path before anything is read."""
    path = nicotine_import.default_config_path()
    assert path.endswith("config")
    assert "nicotine" in path


# ----------------------------------------------------------------- inspect

def test_inspect_reports_what_is_available(tmp_path):
    source = nicotine_import.inspect(write_config(tmp_path))
    assert source["available"] is True
    assert source["hasCredentials"] is True
    assert source["username"] == "testuser_synthetic"
    assert source["downloadFolder"] == "/Volumes/Music/incoming"
    assert source["error"] is None
    assert [f["virtualName"] for f in source["folders"]] == ["Music", "Rips"]
    assert [f["path"] for f in source["folders"]] == [
        "/Volumes/Music/library", "/Users/x/rips",
    ]
    protocol.validate_struct("ImportSource", source)


def test_inspect_NEVER_returns_the_password(tmp_path):
    """The single most important test in this file.

    The password exists in the source config and must not appear anywhere in
    the payload — not under its own key, not smuggled into another field.
    """
    source = nicotine_import.inspect(write_config(tmp_path))

    assert "passw" not in source
    assert "password" not in source
    # And the schema itself has no field for it, so it cannot be added by accident.
    fields = {f[0] for f in protocol.STRUCT_FIELDS["ImportSource"]}
    assert not any("pass" in f.lower() for f in fields)

    flattened = repr(source)
    assert "synthetic-password-not-real" not in flattened


def test_inspect_marks_missing_folders(tmp_path):
    """External volumes go missing. The UI should say so before importing."""
    real = os.path.join(str(tmp_path), "present")
    os.makedirs(real)
    path = write_config(tmp_path, SYNTHETIC.replace(
        "shared = [('Music', '/Volumes/Music/library'), ('Rips', '/Users/x/rips')]",
        f"shared = [('Here', {real!r}), ('Gone', '/nope/missing')]",
    ))
    folders = nicotine_import.inspect(path)["folders"]
    assert [f["exists"] for f in folders] == [True, False]


def test_inspect_handles_a_missing_config():
    source = nicotine_import.inspect("/nonexistent/nicotine/config")
    assert source["available"] is False
    assert source["hasCredentials"] is False
    assert source["username"] is None
    assert source["folders"] == []
    protocol.validate_struct("ImportSource", source)


def test_inspect_handles_a_config_with_no_credentials(tmp_path):
    path = write_config(tmp_path, SYNTHETIC.replace(
        "passw = synthetic-password-not-real", "passw = "
    ))
    source = nicotine_import.inspect(path)
    assert source["available"] is True
    assert source["hasCredentials"] is False
    # Username is still reported so the UI can explain what it found.
    assert source["username"] == "testuser_synthetic"


def test_inspect_handles_a_corrupt_config(tmp_path):
    path = write_config(tmp_path, "this is not an ini file\n\x00\x01garbage")
    source = nicotine_import.inspect(path)
    assert source["available"] is False
    assert source["error"] is not None
    protocol.validate_struct("ImportSource", source)


def test_inspect_tolerates_legacy_bare_string_shares(tmp_path):
    path = write_config(tmp_path, SYNTHETIC.replace(
        "shared = [('Music', '/Volumes/Music/library'), ('Rips', '/Users/x/rips')]",
        "shared = ['/Users/x/oldstyle']",
    ))
    folders = nicotine_import.inspect(path)["folders"]
    assert folders[0]["path"] == "/Users/x/oldstyle"
    assert folders[0]["virtualName"] == "oldstyle"


def test_inspect_handles_a_config_with_no_shares(tmp_path):
    path = write_config(tmp_path, SYNTHETIC.replace(
        "shared = [('Music', '/Volumes/Music/library'), ('Rips', '/Users/x/rips')]",
        "shared = []",
    ))
    assert nicotine_import.inspect(path)["folders"] == []


# ------------------------------------------------------------------- apply

def test_apply_imports_only_what_was_asked_for(tmp_path):
    path = write_config(tmp_path)
    config = FakeConfig()

    result = nicotine_import.apply(
        config, {"credentials": True, "shares": False, "downloadFolder": False}, path
    )
    assert result["importedCredentials"] is True
    assert result["importedShares"] == 0
    assert result["importedDownloadFolder"] is False
    assert config.sections["server"]["login"] == "testuser_synthetic"
    assert "shared" not in config.sections["transfers"]
    assert "downloaddir" not in config.sections["transfers"]
    protocol.validate_struct("ImportResult", result)


def test_apply_imports_nothing_when_nothing_is_opted_in(tmp_path):
    config = FakeConfig()
    result = nicotine_import.apply(
        config, {"credentials": False, "shares": False, "downloadFolder": False},
        write_config(tmp_path),
    )
    assert result == {"importedCredentials": False, "importedShares": 0,
                      "importedDownloadFolder": False, "username": None}
    assert config.sections["server"] == {}
    assert config.sections["transfers"] == {}


def test_apply_imports_shares_in_upstreams_tuple_format(tmp_path):
    config = FakeConfig()
    result = nicotine_import.apply(
        config, {"credentials": False, "shares": True, "downloadFolder": False},
        write_config(tmp_path),
    )
    assert result["importedShares"] == 2
    assert config.sections["transfers"]["shared"] == [
        ("Music", "/Volumes/Music/library"), ("Rips", "/Users/x/rips"),
    ]


def test_apply_copies_the_password_into_config_but_never_returns_it(tmp_path):
    config = FakeConfig()
    result = nicotine_import.apply(
        config, {"credentials": True, "shares": False, "downloadFolder": False},
        write_config(tmp_path),
    )
    # It lands where it must: Seek's own config, so login works.
    assert config.sections["server"]["passw"] == "synthetic-password-not-real"
    # And nowhere else.
    assert "synthetic-password-not-real" not in repr(result)
    fields = {f[0] for f in protocol.STRUCT_FIELDS["ImportResult"]}
    assert not any("pass" in f.lower() for f in fields)


def test_apply_skips_credentials_when_the_source_has_none(tmp_path):
    path = write_config(tmp_path, SYNTHETIC.replace(
        "passw = synthetic-password-not-real", "passw = "
    ))
    config = FakeConfig()
    result = nicotine_import.apply(
        config, {"credentials": True, "shares": False, "downloadFolder": False}, path
    )
    assert result["importedCredentials"] is False
    assert config.sections["server"] == {}


def test_apply_on_a_missing_config_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        nicotine_import.apply(
            FakeConfig(),
            {"credentials": True, "shares": True, "downloadFolder": True},
            "/nonexistent/config",
        )


def test_apply_everything(tmp_path):
    config = FakeConfig()
    result = nicotine_import.apply(
        config, {"credentials": True, "shares": True, "downloadFolder": True},
        write_config(tmp_path),
    )
    assert result["importedCredentials"] is True
    assert result["importedShares"] == 2
    assert result["importedDownloadFolder"] is True
    assert result["username"] == "testuser_synthetic"
    assert config.sections["transfers"]["downloaddir"] == "/Volumes/Music/incoming"
    protocol.validate_struct("ImportResult", result)
