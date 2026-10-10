"""
Seek — slash commands in chat.
SPDX-License-Identifier: GPL-3.0-or-later

`chat.say` sent every line verbatim, so a Nicotine+ habit like "/away" or
"/msg bob hi" was posted to everyone in the room. A line starting with one
slash is now a command, run by upstream's own handler; "//" sends a literal
slash; and the few commands that would act behind Seek's back are refused with
a reply in the conversation instead.
"""

import types

from seek_sidecar.core_host import CoreHost


class Recorder:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def record(*args, **kwargs):
            self.calls.append((name, args, kwargs))
        return record


def _host():
    host = object.__new__(CoreHost)
    host.UserStatus = types.SimpleNamespace(OFFLINE=0)
    host.core = types.SimpleNamespace(
        users=types.SimpleNamespace(login_status=1),
        chatrooms=Recorder(),
        privatechat=Recorder(),
        pluginhandler=Recorder(),
    )
    return host


def _say(host, message, scope="room", target="techno"):
    return host._cmd_chat_say({
        "scope": scope, "target": target, "message": message, "automatic": None,
    })


def test_a_command_is_run_not_posted():
    host = _host()
    _say(host, "/away")
    assert host.core.chatrooms.calls == []                 # nothing said aloud
    assert host.core.pluginhandler.calls == [
        ("trigger_chatroom_command_event", ("techno", "away", ""), {}),
    ]


def test_arguments_reach_the_command():
    host = _host()
    _say(host, "/msg bob see you at the club ", scope="private", target="alice")
    name, args, _ = host.core.pluginhandler.calls[0]
    assert name == "trigger_private_chat_command_event"
    assert args == ("alice", "msg", "bob see you at the club")


def test_a_double_slash_sends_one_slash():
    host = _host()
    _say(host, "//shrug")
    assert host.core.chatrooms.calls == [("send_message", ("techno", "/shrug"), {})]
    assert host.core.pluginhandler.calls == []


def test_quit_is_refused_with_a_reason():
    """It would stop the engine and leave the window with nothing behind it."""
    host = _host()
    _say(host, "/quit")
    assert host.core.pluginhandler.calls == []
    name, args, _ = host.core.chatrooms.calls[0]
    assert name == "echo_message"
    assert args[0] == "techno" and "menu" in args[1]


def test_share_is_refused_in_a_private_chat_too():
    host = _host()
    _say(host, "/share ~/Music", scope="private", target="bob")
    assert host.core.pluginhandler.calls == []
    name, args, _ = host.core.privatechat.calls[0]
    assert name == "echo_message" and args[0] == "bob"


def test_an_ordinary_line_is_still_sent():
    host = _host()
    _say(host, "anyone got the Drexciya repress?")
    assert host.core.chatrooms.calls == [
        ("send_message", ("techno", "anyone got the Drexciya repress?"), {}),
    ]
