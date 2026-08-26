"""
Seek — telling a private message you SENT from one you RECEIVED.
SPDX-License-Identifier: GPL-3.0-or-later

Found against the live server, not in review. Nicotine+ reports both directions
on the same `message-user` event: `privatechat.send_message()` finishes with
`events.emit("message-user", MessageUser(username, message))`, where `username`
is the RECIPIENT — the very field that carries the SENDER when a message
arrives. Read naively, everything you say is displayed in your own window under
the other person's name.

The first live test messaged our own account, where sender and recipient are the
same string, so it looked perfect. That is why the case below uses two DIFFERENT
names: it is the only shape that can fail.
"""

import types

from seek_sidecar.core_host import CoreHost


class FakeBridge:
    def __init__(self):
        self.sent = []

    def broadcast(self, event, payload):
        self.sent.append((event, payload))


def _host(own="our-account"):
    """A CoreHost with nothing started — this handler needs no live core."""
    host = object.__new__(CoreHost)
    host.bridge = FakeBridge()
    host.core = types.SimpleNamespace(
        users=types.SimpleNamespace(login_username=own)
    )
    return host


def _incoming(sender, text, message_id=17):
    """What the server hands us: parsed off the wire, so it has an id."""
    return types.SimpleNamespace(
        user=sender, message=text, message_id=message_id,
        timestamp=1700000000, message_type=None, mention_type=None,
    )


def _our_own_send(recipient, text):
    """What upstream emits after WE send: built in memory, so no id."""
    return types.SimpleNamespace(
        user=recipient, message=text, message_id=None,
        timestamp=None, message_type=None, mention_type=None,
    )


def test_a_message_we_sent_is_ours_not_theirs():
    host = _host()
    host._on_private_message(_our_own_send("bob", "meet you there"))

    _, line = host.bridge.sent[0]
    assert line["outgoing"] is True
    # The bug: this read "bob", so your own words wore the other person's name.
    assert line["username"] == "our-account"
    # It still belongs in the conversation WITH bob.
    assert line["target"] == "bob"
    assert line["message"] == "meet you there"


def test_a_message_they_sent_is_theirs():
    host = _host()
    host._on_private_message(_incoming("bob", "on my way"))

    _, line = host.bridge.sent[0]
    assert line["outgoing"] is False
    assert line["username"] == "bob"
    assert line["target"] == "bob"


def test_you_cannot_be_mentioned_by_yourself():
    host = _host()
    msg = _our_own_send("bob", "hey our-account")
    msg.mention_type = "highlight"
    host._on_private_message(msg)
    assert host.bridge.sent[0][1]["mentioned"] is False


def test_messaging_yourself_still_makes_sense():
    """The shape that hid the bug. Both lines are legitimate: one is the send,
    one is the server delivering it back, and they must not be conflated."""
    host = _host()
    host._on_private_message(_our_own_send("our-account", "note to self"))
    host._on_private_message(_incoming("our-account", "note to self"))

    sent, received = (p for _, p in host.bridge.sent)
    assert sent["outgoing"] is True
    assert received["outgoing"] is False


# --------------------------------------------------------------------------
# The kind vocabulary. Upstream and the wire disagreed, and the generated
# validator resolved the disagreement by binning every message from another
# person. Five real replies were lost to this before it was noticed.

def test_a_message_from_someone_else_survives_validation():
    """upstream says "remote"; the wire has no such kind. Unmapped, the whole
    event is dropped and the conversation looks empty."""
    host = _host()
    msg = _incoming("bob", "hello")
    msg.message_type = "remote"
    host._on_private_message(msg)

    line = host.bridge.sent[0][1]
    assert line["kind"] == "message"
    assert line["message"] == "hello"


def test_a_room_message_from_someone_else_survives_validation():
    host = _host()
    host._on_room_message(types.SimpleNamespace(
        room="nicotine", user="bob", message="hello",
        message_type="remote", mention_type=None,
    ))
    assert host.bridge.sent[0][1]["kind"] == "message"


def test_an_action_keeps_its_kind():
    host = _host()
    msg = _incoming("bob", "/me waves")
    msg.message_type = "action"
    host._on_private_message(msg)
    assert host.bridge.sent[0][1]["kind"] == "action"


def test_an_unknown_kind_degrades_instead_of_dropping_the_message():
    """The rule that keeps this from happening twice. A future upstream value
    should cost us a style, never a line of someone's conversation."""
    host = _host()
    msg = _incoming("bob", "hello")
    msg.message_type = "something-invented-later"
    host._on_private_message(msg)
    assert host.bridge.sent[0][1]["kind"] == "message"


def test_every_kind_emitted_is_one_the_wire_accepts():
    from seek_sidecar import protocol

    valid = set(protocol.ENUMS["ChatMessageKind"]) if hasattr(protocol, "ENUMS") else {
        "message", "action", "local", "hilite",
    }
    for raw in ("remote", "local", "action", "hilite", None, "", "nonsense"):
        assert CoreHost._chat_kind(raw) in valid, raw
