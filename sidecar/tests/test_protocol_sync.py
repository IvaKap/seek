# Seek — the generated protocol outputs must match the schema.
# SPDX-License-Identifier: GPL-3.0-or-later

import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from seek_sidecar import protocol  # noqa: E402


def test_generated_outputs_are_current():
    """shared/protocol.ts and seek_sidecar/protocol.py must be regenerated
    whenever shared/schema.py changes. This is the whole mechanism keeping the
    two sides of the seam honest."""
    result = subprocess.run(
        [sys.executable, os.path.join(ROOT, "shared", "generate_protocol.py"), "--check"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, (
        f"generated protocol files are stale:\n{result.stderr}"
    )


def test_every_command_and_event_has_a_struct():
    for name, (params, result) in protocol.COMMANDS.items():
        for ref in (params, result):
            if ref is not None:
                assert ref in protocol.STRUCT_FIELDS, f"{name} -> {ref}"
    for name, payload in protocol.EVENTS.items():
        assert payload in protocol.STRUCT_FIELDS, f"{name} -> {payload}"


def test_every_struct_field_type_resolves():
    known = set(protocol.STRUCT_FIELDS) | set(protocol.ENUM_VALUES) | {
        "str", "int", "float", "bool", "json"
    }
    for name, fields in protocol.STRUCT_FIELDS.items():
        for field, base, _is_array, _nullable in fields:
            assert base in known, f"{name}.{field}: unknown type {base}"


def test_ts_and_py_agree_on_names():
    """Cheap textual cross-check: every command and event name in the Python
    output must literally appear in the TypeScript output."""
    with open(os.path.join(ROOT, "shared", "protocol.ts"), encoding="utf-8") as handle:
        ts = handle.read()
    for name in protocol.COMMAND_NAMES:
        assert f"'{name}'" in ts, f"command {name} missing from protocol.ts"
    for name in protocol.EVENT_NAMES:
        assert f"'{name}'" in ts, f"event {name} missing from protocol.ts"
    for name in protocol.STRUCT_FIELDS:
        assert f"interface {name} " in ts, f"struct {name} missing from protocol.ts"


# ---------------------------------------------------------------- validator

def _file_ref(**overrides):
    ref = {"path": "a\\b.flac", "size": 100, "bitrate": None, "duration": 200,
           "sampleRate": 44100, "bitDepth": 16, "isVbr": None}
    ref.update(overrides)
    return ref


def test_validator_accepts_a_good_struct():
    protocol.validate_struct("FileRef", _file_ref())


def test_validator_rejects_missing_field():
    ref = _file_ref()
    del ref["duration"]
    with pytest.raises(protocol.SchemaError, match="duration: missing"):
        protocol.validate_struct("FileRef", ref)


def test_validator_rejects_unknown_field():
    """The important one. A typo in an emitter is otherwise invisible until it
    reaches TypeScript."""
    with pytest.raises(protocol.SchemaError, match="unknown field"):
        protocol.validate_struct("FileRef", _file_ref(format="flac"))


def test_validator_rejects_null_in_non_nullable():
    with pytest.raises(protocol.SchemaError, match="null not allowed"):
        protocol.validate_struct("FileRef", _file_ref(size=None))


def test_validator_rejects_bool_as_int():
    """bool is a subclass of int in Python; a naive isinstance check would let
    True through as a file size."""
    with pytest.raises(protocol.SchemaError, match="expected int"):
        protocol.validate_struct("FileRef", _file_ref(size=True))


def test_validator_rejects_bad_enum_value():
    with pytest.raises(protocol.SchemaError, match="not a valid TransferState"):
        protocol.validate_event("transfer.added", {
            "id": "x", "direction": "download", "username": "u", "path": "p",
            "localFolder": None,
            "size": 1, "bytesDone": 0, "state": "sideways", "speed": 0,
            "averageSpeed": 0, "queuePosition": None, "secondsLeft": None,
            "secondsElapsed": 0, "stalled": False, "file": None, "error": None,
        })


def test_validator_recurses_into_arrays():
    with pytest.raises(protocol.SchemaError, match=r"files\[1\]"):
        protocol.validate_struct("FolderRef", {
            "path": "x", "private": False,
            "files": [_file_ref(), _file_ref(size="big")],
        })


def test_command_with_no_params_rejects_params():
    protocol.validate_command("transfer.list", {})
    protocol.validate_command("transfer.list", None)
    with pytest.raises(protocol.SchemaError):
        protocol.validate_command("transfer.list", {"nope": 1})


def test_unknown_command_and_event_rejected():
    with pytest.raises(protocol.SchemaError):
        protocol.validate_command("search.telepathy", {})
    with pytest.raises(protocol.SchemaError):
        protocol.validate_event("search.telepathy", {})
