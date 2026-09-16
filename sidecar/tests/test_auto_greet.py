# Seek — the upload-greeting ledger, and the settings that drive it.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# WHAT THESE PIN, and why this ledger is treated more carefully than the others:
# a lost entry here means messaging a stranger a SECOND time, and a private
# message cannot be unsent. So: it survives a restart, it cannot be bloated or
# duplicated by a client bug, and it is bounded.
#
# The sidecar stores and nothing more — deciding who is new is the frontend's,
# exactly as with wish_seen and the auto-download claim ledger.

import pytest

from seek_sidecar.core_host import DEFAULT_UPLOAD_GREETING, GREETED_CAP, CoreHost


class FakeBridge:
    def __init__(self):
        self.events = []

    def broadcast(self, name, data):
        self.events.append((name, data))


class FakePrivateChat:
    """Just enough of `core.privatechat` to see which send was used."""

    def __init__(self):
        self.shown = []
        self.plain = []
        self.automatic = []

    def show_user(self, username, switch_page=True):
        self.shown.append((username, switch_page))

    def send_message(self, username, message):
        self.plain.append((username, message))

    def send_automatic_message(self, username, message):
        self.automatic.append((username, message))


class FakeChatRooms:
    def __init__(self):
        self.said = []

    def send_message(self, room, message):
        self.said.append((room, message))


class FakeCore:
    def __init__(self):
        self.privatechat = FakePrivateChat()
        self.chatrooms = FakeChatRooms()


class Host:
    METHODS = (
        "_state_path", "_load_state", "_save_state",
        "_greeted_peers", "_cmd_greeting_sent", "_cmd_greeting_sentList",
        "_cmd_chat_say",
    )

    def __init__(self, folder):
        self.data_folder = str(folder)
        self.bridge = FakeBridge()
        self.core = FakeCore()
        for name in self.METHODS:
            setattr(self, name, getattr(CoreHost, name).__get__(self))

    # The online check is a one-liner on the real host and needs a whole
    # users/UserStatus stub to satisfy; these tests are about the ledger.
    def _require_online(self):
        return None


@pytest.fixture
def host(tmp_path):
    return Host(tmp_path)


# ------------------------------------------------------------------ the ledger

def test_nobody_is_greeted_to_begin_with(host):
    assert host._cmd_greeting_sentList({}) == {"users": []}


def test_a_greeted_set_round_trips(host):
    host._cmd_greeting_sent({"users": ["jazzcat", "raspberry"]})
    assert host._cmd_greeting_sentList({})["users"] == ["jazzcat", "raspberry"]


def test_it_survives_a_restart(tmp_path):
    """The whole reason this is on disk. A second Host on the same folder is
    what a relaunch looks like — an in-memory set would greet everyone again."""
    first = Host(tmp_path)
    first._cmd_greeting_sent({"users": ["jazzcat"]})

    second = Host(tmp_path)
    assert second._cmd_greeting_sentList({})["users"] == ["jazzcat"]


def test_duplicates_collapse(host):
    """A double-send from a racing frontend must not make the file grow."""
    host._cmd_greeting_sent({"users": ["jazzcat", "jazzcat", "raspberry"]})
    assert host._cmd_greeting_sentList({})["users"] == ["jazzcat", "raspberry"]


def test_blank_and_non_string_entries_are_dropped(host):
    host._cmd_greeting_sent({"users": ["jazzcat", "", None, "  ", "raspberry"]})
    assert host._cmd_greeting_sentList({})["users"] == ["jazzcat", "raspberry"]


def test_names_are_trimmed(host):
    host._cmd_greeting_sent({"users": ["  jazzcat  "]})
    assert host._cmd_greeting_sentList({})["users"] == ["jazzcat"]


def test_the_set_is_capped_keeping_the_newest(host):
    """Unbounded, this only ever grows. The tail is what matters: those are the
    people most recently greeted and so most likely to come back."""
    host._cmd_greeting_sent({"users": [f"user{i}" for i in range(GREETED_CAP + 50)]})
    stored = host._cmd_greeting_sentList({})["users"]
    assert len(stored) == GREETED_CAP
    assert stored[-1] == f"user{GREETED_CAP + 49}"
    assert "user0" not in stored


def test_writing_the_ledger_leaves_other_state_alone(host):
    host._save_state(wish_auto={"burial": True})
    host._cmd_greeting_sent({"users": ["jazzcat"]})
    assert host._load_state()["wish_auto"] == {"burial": True}


# ------------------------------------------------------- the automatic prefix

def test_an_automatic_message_goes_through_upstreams_own_method(host):
    """`send_automatic_message` is what prefixes '[Automatic Message]'. Calling
    it rather than pasting the prefix in ourselves is what keeps Seek's bot
    messages looking like every other client's."""
    host._cmd_chat_say({
        "scope": "private", "target": "jazzcat", "message": "hello",
        "automatic": True,
    })
    assert host.core.privatechat.automatic == [("jazzcat", "hello")]
    assert host.core.privatechat.plain == []


def test_an_automatic_message_needs_no_open_conversation(host):
    """A greeting goes to someone the user has never messaged, so the send has
    to open the conversation itself."""
    host._cmd_chat_say({
        "scope": "private", "target": "jazzcat", "message": "hello",
        "automatic": True,
    })
    assert host.core.privatechat.shown == [("jazzcat", False)]


def test_an_ordinary_private_message_is_not_marked_automatic(host):
    host._cmd_chat_say({
        "scope": "private", "target": "jazzcat", "message": "hello",
        "automatic": None,
    })
    assert host.core.privatechat.plain == [("jazzcat", "hello")]
    assert host.core.privatechat.automatic == []


def test_a_room_message_ignores_the_flag(host):
    """`automatic` is private-scope only — there is no automatic-message form
    for a room, and a greeting must never be able to land in one."""
    host._cmd_chat_say({
        "scope": "room", "target": "#jazz", "message": "hello", "automatic": True,
    })
    assert host.core.chatrooms.said == [("#jazz", "hello")]
    assert host.core.privatechat.automatic == []


# ------------------------------------------------------------------- settings

def test_the_greeting_is_off_by_default():
    assert CoreHost.DEFAULT_APP_SETTINGS["uploadGreetingEnabled"] is False


def test_the_default_greeting_is_one_line():
    """The server strips line breaks out of a private message, so a default
    carrying one would be delivered differently from how it reads here."""
    assert "\n" not in DEFAULT_UPLOAD_GREETING
    assert "\r" not in DEFAULT_UPLOAD_GREETING
