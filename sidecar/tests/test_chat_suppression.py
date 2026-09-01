"""
Seek — upstream suppresses a chat line by NULLING its identifying field.

THE BUG THIS PINS, found by reading a production log rather than by a test:

    2026-08-31 23:06:43 ERROR seek.server
        refusing to emit invalid chat.message: ChatMessage.target: null not allowed

`pynicotine.events.emit` runs callbacks in registration order, and the core
registers its own during init, so ours ALWAYS runs second. Upstream's handler
uses that: when it has decided a message should not be displayed it sets the
identifying field on the message object to None IN PLACE and returns, and every
later handler is expected to notice.

    chatrooms._say_chat_room   msg.room = None   x4   (lines 559, 570, 574, 579)
    privatechat._message_user  msg.user = None   x5   (lines 408, 413, 420, 429, 434)

Seek's two chat handlers did not notice, and emitted anyway. Nothing showed —
but only because `ChatMessage.target` is non-nullable and the event validator
refused the payload. That is luck, and it aims the obvious fix at exactly the
wrong thing: making `target` nullable would have started rendering messages
from people the user had ignored.

Two of Seek's handlers already got this right — `_on_user_status` even cites the
upstream line. These two were missed.

The cases matter and are not all the same:

  * ignored user, ignored IP, plugin ate it  -> must never be shown
  * a room we are not in                     -> must never be shown
  * a server message turned into something else -> must never be shown
  * QUEUED pending the sender's IP           -> must not be shown YET; it is
    re-emitted for real from `_get_peer_address` once the address arrives

The last one is why "just drop it" is right rather than lossy: the message is
not lost, it arrives on the second emit with `user` restored.

These drive the handlers directly. CoreHost.__init__ boots pynicotine's core,
which cannot run twice in a process (test_integration.py owns the one instance
a run is allowed), so the handlers are bound to a stub.
"""

import pytest

from seek_sidecar.core_host import CoreHost


class _Msg:
    """A upstream message object, after upstream's handler has had it."""

    def __init__(self, **fields):
        self.__dict__.update(fields)


class _Host:
    def __init__(self):
        self.broadcasts = []
        self.bridge = self

    def broadcast(self, name, payload):
        self.broadcasts.append((name, payload))

    def _own_username(self):
        return "me"

    _chat_line = CoreHost._chat_line
    _chat_kind = CoreHost._chat_kind
    CHAT_KINDS = CoreHost.CHAT_KINDS
    _on_room_message = CoreHost._on_room_message
    _on_private_message = CoreHost._on_private_message


def room_msg(room="electronic", user="someone", message="anyone got the reissue"):
    return _Msg(room=room, user=user, message=message,
                message_type="remote", mention_type=None)


def private_msg(user="someone", message="hello", message_id=42):
    return _Msg(user=user, message=message, message_id=message_id,
                message_type="remote", timestamp=1786300000)


# -- rooms -------------------------------------------------------------------

def test_an_ordinary_room_message_is_emitted():
    h = _Host()
    h._on_room_message(room_msg())
    assert [n for n, _ in h.broadcasts] == ["chat.message"]
    payload = h.broadcasts[0][1]
    assert payload["scope"] == "room"
    assert payload["target"] == "electronic"
    assert payload["username"] == "someone"


def test_a_suppressed_room_message_is_not_emitted():
    # `msg.room = None` is upstream saying it has handled this one: the room is
    # not joined, the user is ignored, their IP is ignored, or a plugin ate it.
    h = _Host()
    h._on_room_message(room_msg(room=None))
    assert h.broadcasts == []


def test_suppression_does_not_depend_on_the_user_being_present():
    # Upstream nulls the ROOM, never the user, on this event. A guard written
    # against the wrong field would let every one of these through.
    h = _Host()
    h._on_room_message(room_msg(room=None, user="someone"))
    assert h.broadcasts == []


def test_a_room_message_from_ourselves_is_still_marked_outgoing():
    h = _Host()
    h._on_room_message(room_msg(user="me"))
    assert h.broadcasts[0][1]["outgoing"] is True


# -- private -----------------------------------------------------------------

def test_an_ordinary_private_message_is_emitted():
    h = _Host()
    h._on_private_message(private_msg())
    payload = h.broadcasts[0][1]
    assert payload["scope"] == "private"
    assert payload["target"] == "someone"
    assert payload["username"] == "someone"
    assert payload["outgoing"] is False


def test_a_suppressed_private_message_is_not_emitted():
    # THE ONE FROM THE LOG. Every one of upstream's five paths looks like this.
    h = _Host()
    h._on_private_message(private_msg(user=None))
    assert h.broadcasts == []


def test_a_message_queued_for_an_ip_arrives_on_the_second_emit():
    """Not a suppression at all, and the reason dropping is safe rather than
    lossy. Upstream queues a message from someone whose address it does not
    have, nulls the user, and re-emits with it restored once the address
    arrives — `privatechat._get_peer_address`."""
    h = _Host()
    msg = private_msg(user=None)          # first emit: queued, suppressed
    h._on_private_message(msg)
    assert h.broadcasts == []

    msg.user = "someone"                  # what _get_peer_address does
    h._on_private_message(msg)
    assert len(h.broadcasts) == 1
    assert h.broadcasts[0][1]["target"] == "someone"


def test_an_outgoing_private_message_is_still_attributed_to_us():
    # No message_id means we sent it; `user` is then the RECIPIENT, and it is
    # never nulled — upstream's five paths are all inside `if not outgoing`.
    h = _Host()
    h._on_private_message(private_msg(user="someone", message_id=None))
    payload = h.broadcasts[0][1]
    assert payload["outgoing"] is True
    assert payload["target"] == "someone"
    assert payload["username"] == "me"


def test_suppression_is_checked_before_the_outgoing_test():
    # A null user with no message_id would otherwise be read as "we sent this",
    # and emitted with our own name and a null target.
    h = _Host()
    h._on_private_message(private_msg(user=None, message_id=None))
    assert h.broadcasts == []


# -- the payload the validator refused ---------------------------------------

@pytest.mark.parametrize("msg,handler", [
    (room_msg(room=None), "_on_room_message"),
    (private_msg(user=None), "_on_private_message"),
])
def test_nothing_reaches_the_wire_with_a_null_target(msg, handler):
    """The direct regression: whatever else changes, a null identifying field
    must never become a `chat.message` payload. Under test `Bridge.broadcast`
    RAISES on an invalid event (conftest sets STRICT_VALIDATION), so this would
    now fail loudly at the socket too — but the handler is where it belongs."""
    h = _Host()
    getattr(h, handler)(msg)
    assert h.broadcasts == []
