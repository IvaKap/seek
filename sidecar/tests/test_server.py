# Seek — the WebSocket bridge, against a real loopback socket.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# These run a genuine websockets server on 127.0.0.1 and connect to it with a
# genuine client. Nothing is mocked: the handshake, the token check, the Origin
# rejection and the JSON framing are all exercised for real. What is stubbed is
# the pynicotine core — these tests are about the bridge, not the protocol
# engine, and a real core would need network credentials.

import asyncio
import json

import pytest
import websockets
from websockets.exceptions import InvalidStatus

from seek_sidecar import protocol
from seek_sidecar.server import Bridge, generate_token

TOKEN = "test-token-do-not-reuse"


@pytest.fixture
def bridge():
    b = Bridge(token=TOKEN, host="127.0.0.1", port=0)
    b.start()
    yield b
    b.stop()


def url(bridge, token=TOKEN):
    return f"ws://127.0.0.1:{bridge.bound_port}/?token={token}"


# ---------------------------------------------------------------- binding

def test_refuses_to_bind_to_a_public_address():
    """The socket accepts commands that download files and rewrite settings.
    Binding it off-machine is not a configuration choice we offer."""
    with pytest.raises(ValueError, match="loopback"):
        Bridge(token=TOKEN, host="0.0.0.0")
    with pytest.raises(ValueError, match="loopback"):
        Bridge(token=TOKEN, host="192.168.1.50")


def test_loopback_forms_are_accepted():
    for host in ("127.0.0.1", "localhost", "::1", "127.0.0.5"):
        Bridge(token=TOKEN, host=host)


def test_generated_tokens_are_unique_and_long():
    a, b = generate_token(), generate_token()
    assert a != b
    assert len(a) >= 40


# ------------------------------------------------------------------- auth

async def test_connection_without_a_token_is_rejected(bridge):
    with pytest.raises(InvalidStatus) as info:
        async with websockets.connect(f"ws://127.0.0.1:{bridge.bound_port}/"):
            pass
    assert info.value.response.status_code == 401


async def test_connection_with_a_wrong_token_is_rejected(bridge):
    with pytest.raises(InvalidStatus) as info:
        async with websockets.connect(url(bridge, "wrong-token")):
            pass
    assert info.value.response.status_code == 403


async def test_connection_with_the_right_token_succeeds(bridge):
    async with websockets.connect(url(bridge)) as ws:
        assert ws.state.name == "OPEN"


async def test_bearer_header_is_accepted(bridge):
    async with websockets.connect(
        f"ws://127.0.0.1:{bridge.bound_port}/",
        additional_headers={"Authorization": f"Bearer {TOKEN}"},
    ) as ws:
        assert ws.state.name == "OPEN"


async def test_browser_origin_is_rejected_even_with_a_valid_token(bridge):
    """Any page the user has open can reach ws://127.0.0.1. A real desktop
    client sends no Origin; a browser always does."""
    with pytest.raises(InvalidStatus) as info:
        async with websockets.connect(
            url(bridge), additional_headers={"Origin": "https://evil.example"},
        ):
            pass
    assert info.value.response.status_code == 403


# ----------------------------------------------------------------- framing

async def test_valid_command_reaches_the_main_thread_queue(bridge):
    async with websockets.connect(url(bridge)) as ws:
        await ws.send(json.dumps({
            "id": "r1", "cmd": "search.start",
            "params": {"query": "burial", "mode": "global", "room": None,
                       "users": [], "resultCap": None, "timeoutSeconds": None},
        }))
        await asyncio.sleep(0.15)

        pending = bridge.drain()
        assert len(pending) == 1
        _ws, request_id, command, params = pending[0]
        assert (request_id, command) == ("r1", "search.start")
        assert params["query"] == "burial"


async def test_reply_round_trips(bridge):
    async with websockets.connect(url(bridge)) as ws:
        await ws.send(json.dumps({"id": "r2", "cmd": "transfer.list", "params": {}}))
        await asyncio.sleep(0.15)

        client_ws, request_id, _cmd, _params = bridge.drain()[0]
        bridge.reply(client_ws, request_id, {"transfers": []})

        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert reply == {"id": "r2", "ok": True, "result": {"transfers": []}}


async def test_malformed_json_is_rejected_without_dropping_the_connection(bridge):
    async with websockets.connect(url(bridge)) as ws:
        await ws.send("{not json")
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert reply["ok"] is False
        assert reply["error"]["code"] == "bad_request"

        # Still usable afterwards.
        await ws.send(json.dumps({"id": "ok", "cmd": "transfer.list", "params": {}}))
        await asyncio.sleep(0.15)
        assert bridge.drain()[0][1] == "ok"


async def test_unknown_command_is_rejected(bridge):
    async with websockets.connect(url(bridge)) as ws:
        await ws.send(json.dumps({"id": "r3", "cmd": "rm.-rf", "params": {}}))
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert reply["error"]["code"] == "unknown_command"
        assert bridge.drain() == []


async def test_command_with_invalid_params_never_reaches_the_core(bridge):
    """Schema validation happens on the socket thread, so a malformed command
    is rejected before it can touch pynicotine at all."""
    async with websockets.connect(url(bridge)) as ws:
        await ws.send(json.dumps({
            "id": "r4", "cmd": "transfer.enqueue",
            "params": {"username": "u"},  # missing path/size/file/...
        }))
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert reply["ok"] is False
        assert reply["error"]["code"] == "bad_request"
        assert bridge.drain() == []


async def test_frame_without_an_id_is_rejected(bridge):
    async with websockets.connect(url(bridge)) as ws:
        await ws.send(json.dumps({"cmd": "transfer.list", "params": {}}))
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert reply["error"]["code"] == "bad_request"


async def test_non_object_frame_is_rejected(bridge):
    async with websockets.connect(url(bridge)) as ws:
        await ws.send(json.dumps([1, 2, 3]))
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert reply["error"]["code"] == "bad_request"


# --------------------------------------------------------------- broadcast

async def test_broadcast_reaches_every_client(bridge):
    async with websockets.connect(url(bridge)) as a, \
               websockets.connect(url(bridge)) as b:
        await asyncio.sleep(0.15)
        bridge.broadcast("connection.stats", {
            "connections": 3, "downloadBandwidth": 100, "uploadBandwidth": 20,
        })
        for ws in (a, b):
            frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
            assert frame["ev"] == "connection.stats"
            assert frame["data"]["connections"] == 3


async def test_invalid_broadcast_is_dropped_not_raised(bridge):
    """broadcast() runs inside a pynicotine event callback. Upstream treats any
    exception escaping a callback as fatal — it calls core.quit() and re-raises
    (events.py:275). A bad payload must never get that far."""
    async with websockets.connect(url(bridge)) as ws:
        bridge.broadcast("connection.stats", {"connections": "three"})  # bad type
        bridge.broadcast("connection.stats", {
            "connections": 1, "downloadBandwidth": 0, "uploadBandwidth": 0,
        })
        frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert frame["data"]["connections"] == 1, "the invalid frame was sent"


async def test_broadcast_with_no_clients_is_harmless(bridge):
    bridge.broadcast("connection.stats", {
        "connections": 0, "downloadBandwidth": 0, "uploadBandwidth": 0,
    })


async def test_every_event_in_the_schema_can_be_broadcast(bridge):
    """Guards against an event that validates in isolation but is not JSON
    serialisable."""
    samples = _event_samples()
    missing = set(protocol.EVENT_NAMES) - set(samples)
    assert not missing, f"no sample payload for: {sorted(missing)}"

    async with websockets.connect(url(bridge)) as ws:
        for name in protocol.EVENT_NAMES:
            bridge.broadcast(name, samples[name])
        received = []
        for _ in protocol.EVENT_NAMES:
            received.append(json.loads(await asyncio.wait_for(ws.recv(), timeout=2)))
    assert [f["ev"] for f in received] == list(protocol.EVENT_NAMES)


def _file():
    return {"path": "a\\b.flac", "size": 1, "bitrate": None, "duration": 10,
            "sampleRate": 44100, "bitDepth": 16, "isVbr": None}


def _peer():
    return {"username": "u", "freeSlots": True, "advertisedSpeed": 1,
            "queueLength": 0, "files": None, "folders": None, "country": None}


def _transfer(direction="download"):
    return {"id": "abc", "direction": direction,
            "username": "u", "path": "p", "localFolder": None,
            "size": 1, "bytesDone": 0, "state": "queued", "speed": 0,
            "averageSpeed": 0, "queuePosition": None, "secondsLeft": None,
            "secondsElapsed": 0, "stalled": False, "file": None, "error": None}


def _folder():
    return {"path": "A\\B", "files": [_file()], "private": False}


def _event_samples():
    return {
        "connection.state": {"status": "online", "username": "me",
                             "publicAddress": "1.2.3.4", "error": None},
        "connection.stats": {"connections": 1, "downloadBandwidth": 0,
                             "uploadBandwidth": 0},
        "search.started": {"searchId": 1, "query": "q", "termTransmitted": "q",
                           "mode": "global", "startedAt": 1.0, "resultCount": 0},
        "search.result": {"searchId": 1, "peer": _peer(), "files": [_file()],
                          "private": False, "receivedAt": 1.0},
        "search.closed": {"searchId": 1, "reason": "timeout",
                          "resultCount": 1, "peerCount": 1},
        "search.failed": {"searchId": 1, "reason": "offline"},
        "user.stats": _peer(),
        "user.status": {"username": "u", "status": "online", "privileged": None},
        "user.browse.result": {"username": "u", "folders": [_folder()],
                               "fileCount": 1, "totalSize": 1},
        "user.browse.failed": {"username": "u", "reason": "offline"},
        "folder.contents": {"requestId": "r", "username": "u", "folderPath": "A\\B",
                            "folders": [_folder()], "enqueued": 1},
        "folder.contents.failed": {"requestId": None, "username": "u",
                                   "folderPath": "A\\B", "reason": "offline"},
        "transfer.added": _transfer(),
        # An upload goes down the same event, so it has to validate on the
        # same path — this is the only place that proves it does.
        "transfer.updated": _transfer("upload"),
        "transfer.removed": {"transferIds": ["abc"]},
        "folder.finished": {"localFolder": "/tmp/x"},
        "log": {"level": "info", "message": "hello", "at": 1.0},
        "analysis.result": {
            "requestId": "r", "path": "/tmp/a.flac", "transferId": None,
            "sampleRate": 44100, "channels": 2, "durationSeconds": 236.0,
            "decodedWith": "soundfile", "nyquistHz": 22050.0,
            "cutoffHz": 16000.0, "shelfDropDb": 62.0, "shelfWidthHz": 300.0,
            "confidence": 0.82, "assessment": "strong_signs_of_lossy_source",
            "declaredLossless": True, "impliedSourceKbps": 160,
            "spectrumHz": [20.0, 1000.0, 16000.0],
            "spectrumDb": [-3.0, -0.5, -62.0],
            "heatmapDb": [-4.0, -9.0, -40.0, -61.0],
            "heatmapTimeBins": 2, "heatmapFreqBins": 2,
            "fftSize": 8192, "windowCount": 96, "analysedSeconds": 17.8,
        },
        "analysis.failed": {
            "requestId": "r", "path": "/tmp/a.flac", "reason": "decode failed",
        },
        "chat.message": {
            "scope": "room", "target": "electronic", "username": "someone",
            "message": "anyone got the Hyperdub reissue", "outgoing": False,
            "kind": "message", "mentioned": False, "timestamp": 1786300000,
        },
        "chat.rooms": {
            "rooms": [
                {"name": "electronic", "userCount": 412, "joined": True,
                 "private": False},
            ],
        },
        "chat.members": {"room": "electronic", "users": ["someone", "another"]},
        "wishlist.state": {"items": ["burial untrue"], "intervalSeconds": 720},
        "buddies.state": {"items": ["metalheadz2003"]},
        "library.gaps": {
            "key": "burial|untrue", "matched": True, "releaseTitle": "Untrue",
            "releaseArtist": "Burial", "score": 100,
            "tracks": [{"position": 1, "title": "Archangel", "artist": "Burial", "have": True}],
        },
        "app.settings": {
            "autoConnect": True, "hasCredentials": True, "username": "iva",
            "preferLossless": False, "minBitrate": 0,
            "rejectTranscodes": False, "autoOrganise": False,
            "externalLookups": True, "discogsToken": False,
            "artworkCacheMb": 500, "embedArtwork": True, "writeCoverFile": False,
            "autoDigSessions": True, "acoustidApiKey": False,
            "youtubeApiKey": False,
        },
        "peers.stats": {
            "items": [{"username": "metalheadz2003", "ok": 12, "failed": 1,
                       "lastSeen": 1786000000}],
        },
        "library.state": {
            "scannedAt": 1786000000, "roots": ["/Users/x/Music"],
            "releaseCount": 412, "trackCount": 5140, "scanning": False,
        },
        "preview.result": {
            "requestId": "p1", "path": "/tmp/a.flac",
            "dataUri": "data:audio/wav;base64,UklGRg==",
            "startSeconds": 30, "seconds": 15.0, "durationSeconds": 341.0,
        },
        "preview.failed": {"requestId": "p1", "reason": "could not decode"},
        "artwork.result": {
            "key": "k1", "requestId": "r1",
            "dataUri": "data:image/jpeg;base64,AA==", "source": "cache",
            "trackCount": 13, "date": "2007-11-05", "label": "Hyperdub",
            "mbid": "d84892a9-0000-0000-0000-000000000000",
        },
        "artwork.failed": {"key": "k1", "requestId": "r1", "reason": "not found"},
        "metadata.proposal": {
            "requestId": "r1", "path": "/tmp/a.flac", "transferId": None,
            "matched": True, "score": 100, "query": "burial untrue",
            "trackMatched": True,
            "releaseTitle": "Untrue", "releaseArtist": "Burial",
            "date": "2007-11-05", "label": "Hyperdub",
            "mbid": "d84892a9-0000-0000-0000-000000000000",
            "changes": [{"field": "album", "current": "untrue", "proposed": "Untrue"}],
        },
        "shares.state": {
            "consent": "declined", "folders": [], "scanning": False,
            "ready": False, "fileCount": None, "folderCount": None,
            "totalSize": None, "lastScanAt": None, "restartRequired": False,
        },
        "discover.parsed": {
            "requestId": "r1", "url": "https://www.youtube.com/watch?v=8k_f2QK77ew",
            "sourceKind": "youtube", "kind": "track",
            "rawTitle": "Burial, Archangel", "channel": "Hyperdub",
            # Empty for YouTube on purpose: the provider states neither, and
            # deriving them is the frontend's job.
            "artist": "", "title": "",
            "album": None, "year": None, "label": None, "catalogNumber": None,
            "artworkUri": "data:image/jpeg;base64,AA==", "duration": None,
            "genres": [], "tracklist": [], "providerUrl": None,
        },
        "want.changed": {
            "entries": [{
                "id": "abc123", "artist": "Burial", "title": "Archangel",
                "album": None, "year": None, "label": None,
                "catalogNumber": None, "sourceKind": "youtube",
                "sourceUrl": "https://www.youtube.com/watch?v=8k_f2QK77ew",
                "sourceTitle": "Burial, Archangel", "artworkUri": None,
                "status": "pending", "addedAt": 1_760_000_000.0,
                "searchedAt": None, "notes": None, "duration": None,
                "tracklist": [], "sessionId": None,
            }],
        },
        "session.changed": {
            "sessions": [{
                "id": "s1", "name": "", "createdAt": 1_760_000_000.0,
                "lastActiveAt": 1_760_000_600.0, "closed": False,
            }],
        },
        "discover.parseFailed": {
            "requestId": "r1", "url": "https://www.discogs.com/release/1125103",
            "reason": "a Discogs personal access token is required",
            "needs": "discogsToken", "unreachable": False, "unauthorised": False,
        },
        "discover.tracklistParsed": {
            "requestId": "r4", "url": "https://youtu.be/x",
            "videoTitle": "Boiler Room - Ben UFO", "channel": "Boiler Room",
            "lines": [{"position": 1, "offsetSeconds": 0, "text": "Burial - Archangel"}],
        },
        "discover.identified": {
            "requestId": "r5", "path": "/tmp/a.mp3", "matched": True,
            "artist": "Burial", "title": "Archangel", "album": "Untrue",
            "year": 2007, "mbid": None, "score": 0.91, "durationSeconds": 235.0,
        },
        "discover.relatedResults": {
            "requestId": "r6", "labelName": "Hyperdub",
            "byArtist": [], "byLabel": [],
        },
        "discover.browseFailed": {
            "requestId": "r2", "url": "", "reason": "not found", "needs": "",
            "unreachable": False, "unauthorised": False,
        },
        "discover.catalog": {
            "requestId": "r3", "sourceKind": "discogs", "kind": "label",
            "name": "Hyperdub", "id": 25386,
            "url": "https://www.discogs.com/label/25386",
            "complete": True,
            "releases": [{
                "discogsId": 1125103, "title": "Untrue", "artist": "Burial",
                "year": 2007, "format": "CD, Album", "catno": "HDBCD002",
                "role": "", "url": "https://www.discogs.com/release/1125103",
            }],
        },
        # Values copied from a real playlistItems response, including the
        # comma-in-title and the uploader-not-playlist-owner channel.
        "discover.playlistItems": {
            "requestId": "r4",
            "playlistId": "PLuMh5bnyEbtGKPLBBFEWAJ8WSpTmxGkfR",
            "total": 13,
            "complete": True,
            "items": [{
                "videoId": "8k_f2QK77ew",
                "title": "Burial, Archangel",
                "channel": "Hyperdub",
                "position": 1,
                "available": True,
            }],
        },
        # Values copied from a real /users/{u}/wants response, including the
        # trailing space Discogs actually sends in a title and the release with
        # no master (which arrives as 0, normalised to null before it gets here).
        "connections.changed": {
            # socketCount dwarfs the peer list on purpose: most sockets carry
            # the distributed search network, not a transfer.
            "socketCount": 72,
            "peers": [{
                "username": "peer-gamma",
                "country": "US",
                "downloading": 1,
                "downloadQueued": 12,
                "uploading": 0,
                "uploadQueued": 0,
            }],
        },
        # Values copied from a real config: bytes MOVED, so downloadedSize
        # exceeds what the completed count would imply.
        "stats.changed": {
            "sinceTimestamp": 1_786_472_129,
            "session": {
                "startedDownloads": 2, "completedDownloads": 1,
                "downloadedSize": 41_000_000, "startedUploads": 0,
                "completedUploads": 0, "uploadedSize": 0,
            },
            "total": {
                "startedDownloads": 381, "completedDownloads": 261,
                "downloadedSize": 7_086_835_876, "startedUploads": 26,
                "completedUploads": 18, "uploadedSize": 804_009_811,
            },
        },
        "labels.changed": {
            "labels": [{
                "id": "lbl1",
                "sourceKind": "discogs",
                "kind": "label",
                "name": "Hyperdub",
                "url": "https://www.discogs.com/label/1119",
                "entityId": 1119,
                "addedAt": 1_756_000_000.0,
                # Null, not zero: never read is not the same as read and empty.
                "lastSeenAt": None,
                "releaseCount": None,
                "ownedCount": None,
                "wantedCount": None,
                "note": "",
            }],
        },
        "discover.wantlistItems": {
            "requestId": "r5",
            "username": "a-collector",
            "total": 3,
            "complete": True,
            "items": [{
                "discogsId": 9226618,
                "masterId": None,
                "title": "Aline Brooklyn 001",
                "artist": "Aline Brooklyn",
                "year": 2016,
                "label": "Aline Brooklyn",
                "catno": "ALN 001",
                "format": "Vinyl",
                "url": "https://www.discogs.com/release/9226618",
                "addedAt": "2025-06-12T16:17:31-07:00",
                "notes": "",
            }],
        },
    }
