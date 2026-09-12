# Seek — seek-state.json is written atomically and never silently discarded.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Regression guard for "Seek forgot my Discogs key". The token lives in
# seek-state.json under app_settings; a non-atomic truncate-then-dump write,
# interrupted by a crash or the app killing the sidecar on exit, left the file
# truncated. _load_state then read it as {} and the next _save_state rebuilt the
# file from empty — keeping only the keys written that session (peers, history,
# wish_auto, auto_claims) and dropping everything written only on user action
# (the Discogs token, wish filters, saved searches, share consent).

import glob
import json
import os

from seek_sidecar.core_host import CoreHost


class Host:
    METHODS = ("_state_path", "_load_state", "_save_state")

    def __init__(self, folder):
        self.data_folder = str(folder)
        for name in self.METHODS:
            setattr(self, name, getattr(CoreHost, name).__get__(self))


def test_save_state_writes_atomically_leaving_no_temp(tmp_path):
    h = Host(tmp_path)
    h._save_state(app_settings={"discogsToken": "abc"})
    path = h._state_path()
    assert json.load(open(path))["app_settings"]["discogsToken"] == "abc"
    # The temp file must be gone — a leftover .tmp means the rename never happened.
    assert not glob.glob(path + ".tmp")


def test_save_state_preserves_keys_written_in_earlier_calls(tmp_path):
    h = Host(tmp_path)
    h._save_state(app_settings={"discogsToken": "abc"})
    h._save_state(wish_auto=["burial untrue"])          # a later, unrelated write
    data = h._load_state()
    assert data["app_settings"]["discogsToken"] == "abc"   # not clobbered
    assert data["wish_auto"] == ["burial untrue"]


def test_a_corrupt_state_file_is_preserved_not_silently_dropped(tmp_path):
    h = Host(tmp_path)
    h._save_state(app_settings={"discogsToken": "abc"})
    # Simulate a write torn off mid-dump (a crash / kill between truncate and
    # flush): the file exists but is not valid JSON.
    with open(h._state_path(), "w", encoding="utf-8") as f:
        f.write('{"app_settings": {"discogsToken": "ab')   # truncated

    assert h._load_state() == {}                           # unreadable -> empty
    # …but the damaged file is kept aside, so the loss is recoverable, not silent.
    assert glob.glob(h._state_path() + ".corrupt-*")


def test_a_missing_file_is_just_empty_state(tmp_path):
    h = Host(tmp_path)
    assert h._load_state() == {}
    # A genuinely absent file must NOT be preserved-as-corrupt.
    assert not glob.glob(h._state_path() + ".corrupt-*")
