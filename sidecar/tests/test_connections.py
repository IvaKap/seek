"""
Seek — who we are exchanging data with.
SPDX-License-Identifier: GPL-3.0-or-later

NOT a socket table, and that is the finding rather than a shortcut.
`slskproto._conns` is a dict of socket -> Connection living in the NETWORK
THREAD, private to it, and `upstream/` is not modified — so a real socket list
cannot be reached through the public API at all. The only thing upstream emits
about sockets is a COUNT, on `set-connection-stats`.

What IS public, on both `core.downloads` and `core.uploads`, is `active_users`
and `queued_users`. That answers "who, in both directions", which is the useful
half — and the upload side of it is invisible everywhere else in Seek today.

The socket count is reported beside the list precisely so the gap is visible:
72 sockets against two peers looks like a bug until you know that most of them
carry the distributed search network.
"""

import pytest

from seek_sidecar.core_host import CoreHost


class _Component:
    def __init__(self, active=None, queued=None):
        self.active_users = active or {}
        self.queued_users = queued or {}


class _Host:
    def __init__(self, downloads=None, uploads=None, sockets=0):
        self.core = self
        self.downloads = downloads
        self.uploads = uploads
        self._socket_count = sockets
        self._peer_extra = {}
        self.broadcasts = []
        self.bridge = self

    def broadcast(self, name, payload):
        self.broadcasts.append((name, payload))

    _blank_peer = CoreHost._blank_peer
    _connection_snapshot = CoreHost._connection_snapshot
    _cmd_connections_get = CoreHost._cmd_connections_get
    _publish_connections = CoreHost._publish_connections


def files(n):
    """`active_users[username]` is a dict of transfers; only its size matters."""
    return {f"path{i}": object() for i in range(n)}


# ------------------------------------------------------------------ the shape


def test_nothing_connected_is_an_empty_list_not_an_error():
    host = _Host(_Component(), _Component())
    assert host._cmd_connections_get({}) == {"socketCount": 0, "peers": []}


def test_a_missing_component_is_survivable():
    """`core.uploads` is None until components are up, and the connections view
    is reachable before then."""
    host = _Host(None, None)
    assert host._cmd_connections_get({})["peers"] == []


def test_a_download_puts_the_peer_on_the_list():
    host = _Host(_Component(active={"peer-beta": files(2)}), _Component())
    peers = host._cmd_connections_get({})["peers"]
    assert len(peers) == 1
    assert peers[0]["username"] == "peer-beta"
    assert peers[0]["downloading"] == 2
    assert peers[0]["uploading"] == 0


def test_an_upload_puts_the_peer_on_the_list():
    """The half of this that exists nowhere else in Seek."""
    host = _Host(_Component(), _Component(active={"peer-gamma": files(1)}))
    peers = host._cmd_connections_get({})["peers"]
    assert peers[0]["uploading"] == 1
    assert peers[0]["downloading"] == 0


def test_queued_and_active_are_counted_apart():
    host = _Host(
        _Component(active={"peer-alpha": files(1)}, queued={"peer-alpha": files(12)}),
        _Component(),
    )
    peer = host._cmd_connections_get({})["peers"][0]
    assert peer["downloading"] == 1
    assert peer["downloadQueued"] == 12


def test_one_peer_in_both_directions_is_one_row():
    """Trading with someone at the same time is the good case on Soulseek, and
    it must not read as two connections."""
    host = _Host(
        _Component(active={"mutual": files(1)}),
        _Component(active={"mutual": files(3)}),
    )
    peers = host._cmd_connections_get({})["peers"]
    assert len(peers) == 1
    assert peers[0]["downloading"] == 1
    assert peers[0]["uploading"] == 3


def test_peers_are_sorted_by_name_case_insensitively():
    host = _Host(
        _Component(active={"zed": files(1), "Alice": files(1), "bob": files(1)}),
        _Component(),
    )
    assert [p["username"] for p in host._cmd_connections_get({})["peers"]] == [
        "Alice", "bob", "zed",
    ]


def test_the_country_comes_from_the_search_cache_when_known():
    host = _Host(_Component(active={"peer-beta": files(1)}), _Component())
    host._peer_extra = {"peer-beta": {"country": "GB"}}
    assert host._cmd_connections_get({})["peers"][0]["country"] == "GB"


def test_an_unknown_country_is_null_never_a_guess():
    host = _Host(_Component(active={"stranger": files(1)}), _Component())
    host._peer_extra = {"stranger": {"country": ""}}
    assert host._cmd_connections_get({})["peers"][0]["country"] is None


# ------------------------------------------------------------- socket count


def test_the_socket_count_is_reported_beside_the_peers():
    """72 sockets against two peers looks like a bug until you know most of
    them carry the distributed search network. Stating both is the point."""
    host = _Host(_Component(active={"a": files(1), "b": files(1)}), _Component(), sockets=72)
    snapshot = host._cmd_connections_get({})
    assert snapshot["socketCount"] == 72
    assert len(snapshot["peers"]) == 2


# ---------------------------------------------------------------- publishing


def test_the_first_snapshot_is_published():
    host = _Host(_Component(active={"a": files(1)}), _Component())
    host._publish_connections()
    assert [name for name, _ in host.broadcasts] == ["connections.changed"]


def test_an_unchanged_picture_is_not_republished():
    """This is called from the once-a-second tick, and the list is usually
    identical from one second to the next."""
    host = _Host(_Component(active={"a": files(1)}), _Component())
    for _ in range(30):
        host._publish_connections()
    assert len(host.broadcasts) == 1


def test_a_changed_transfer_count_republishes():
    component = _Component(active={"a": files(1)})
    host = _Host(component, _Component())
    host._publish_connections()

    component.active_users["a"] = files(2)
    host._publish_connections()
    assert len(host.broadcasts) == 2


def test_a_peer_leaving_republishes():
    component = _Component(active={"a": files(1)})
    host = _Host(component, _Component())
    host._publish_connections()

    component.active_users.clear()
    host._publish_connections()
    assert len(host.broadcasts) == 2
    assert host.broadcasts[-1][1]["peers"] == []


def test_a_changed_socket_count_republishes():
    """The count moves without the peer list moving, and it is on screen."""
    host = _Host(_Component(), _Component(), sockets=10)
    host._publish_connections()
    host._socket_count = 11
    host._publish_connections()
    assert len(host.broadcasts) == 2
