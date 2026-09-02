# Seek — end-to-end: real pynicotine core, real socket, real frames.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This boots the ACTUAL Nicotine+ core headless, starts the ACTUAL WebSocket
# bridge, and drives it from a real client. Nothing here is stubbed except the
# Soulseek network itself.
#
# WHY THE NETWORK IS STUBBED: reaching the live network needs a registered
# Soulseek account. This build has no credentials and did not create one, so
# there is no live search here and no claim of one. What is proved instead is
# every link in the chain up to the socket: a synthetic FileSearchResponse is
# pushed through upstream's OWN event bus (pynicotine.events), translated by the
# real handlers, batched by the real registry, and read back off a real
# WebSocket by a real client. The only untested link is the peer socket that
# would have produced that message.
#
# core.init_components() mutates process-global singletons and cannot run twice,
# so the whole module shares one module-scoped host.

import asyncio
import json
import os
import shutil
import tempfile

import pytest
import pytest_asyncio
import websockets

from seek_sidecar.core_host import CoreHost
from seek_sidecar.protocol import PROTOCOL_VERSION
from seek_sidecar.server import Bridge

TOKEN = "integration-token"
USER_NICOTINE_CONFIG = os.path.expanduser("~/.config/nicotine/config")


@pytest.fixture(scope="module")
def app_folder():
    folder = tempfile.mkdtemp(prefix="seek-itest-")
    yield folder
    shutil.rmtree(folder, ignore_errors=True)


@pytest.fixture(scope="module")
def user_config_fingerprint():
    """Snapshot the user's real Nicotine+ config so we can prove we never
    touched it. This machine HAS one — isolation is not hypothetical."""
    if not os.path.exists(USER_NICOTINE_CONFIG):
        return None
    stat = os.stat(USER_NICOTINE_CONFIG)
    return (stat.st_mtime_ns, stat.st_size)


@pytest.fixture(scope="module")
def host(app_folder, user_config_fingerprint):
    bridge = Bridge(token=TOKEN, host="127.0.0.1", port=0)
    bridge.start()

    core_host = CoreHost(
        bridge,
        config_folder=os.path.join(app_folder, "config"),
        data_folder=os.path.join(app_folder, "data"),
    )
    core_host.start()
    yield core_host

    core_host.shutdown()
    bridge.stop()


@pytest_asyncio.fixture
async def client(host):
    """A connected client, plus a pump that runs the core's main-thread work.

    The real sidecar runs run_forever() on the main thread; under pytest the
    main thread is running the event loop, so the pump is driven explicitly.
    """
    async with websockets.connect(
        f"ws://127.0.0.1:{host.bridge.bound_port}/?token={TOKEN}"
    ) as ws:
        yield ws


async def pump(host, cycles=6, delay=0.05):
    """Advance the core the way run_forever() would."""
    for _ in range(cycles):
        host.events.process_thread_events()
        host._pump_commands()
        host._pump_searches()
        await asyncio.sleep(delay)


async def call(host, ws, command, params=None, cycles=6):
    request_id = f"req-{command}"
    await ws.send(json.dumps({"id": request_id, "cmd": command,
                              "params": params or {}}))
    await asyncio.sleep(0.05)
    await pump(host, cycles=cycles)
    # Skip any events that arrive before our reply.
    while True:
        frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if frame.get("id") == request_id:
            return frame


# ------------------------------------------------------------------ boot

def test_core_booted_with_gtk_absent(host):
    import sys
    assert "gi" not in sys.modules, "GTK was imported; it must never be"
    assert host.core.search is not None
    assert host.core.downloads is not None
    assert host.core.userbrowse is not None


def test_config_is_isolated_from_the_users_nicotine_install(host, app_folder):
    """The single most damaging thing this sidecar could do is rewrite a real
    user's Nicotine+ settings."""
    assert host.config.config_file_path.startswith(app_folder)
    assert host.config.data_folder_path.startswith(app_folder)
    assert ".config/nicotine" not in host.config.config_file_path


def test_user_nicotine_config_untouched(user_config_fingerprint):
    if user_config_fingerprint is None:
        pytest.skip("no existing ~/.config/nicotine/config on this machine")
    stat = os.stat(USER_NICOTINE_CONFIG)
    assert (stat.st_mtime_ns, stat.st_size) == user_config_fingerprint


def test_telemetry_component_is_disabled(host):
    """UpdateChecker calls out to pypi.org on start."""
    assert host.core.update_checker is None
    assert "update_checker" not in host.core.enabled_components
    assert host.core.now_playing is None


def test_shares_are_off_by_default(host):
    """Sharing exposes the user's filesystem to the network and must be an
    explicit choice. It also spawns a subprocess at startup (shares.py:1240)."""
    assert host.enable_shares is False
    assert "shares" not in host.core.enabled_components


# --------------------------------------------------------------- commands

async def test_hello_returns_real_versions(host, client):
    import pynicotine

    reply = await call(host, client, "hello", {
        "protocolVersion": PROTOCOL_VERSION, "client": "itest",
    })
    assert reply["ok"] is True
    result = reply["result"]
    assert result["protocolVersion"] == PROTOCOL_VERSION
    assert result["coreVersion"] == pynicotine.__version__
    assert result["connection"]["status"] == "offline"
    assert result["transfers"] == []


async def test_hello_rejects_a_version_mismatch(host, client):
    reply = await call(host, client, "hello", {
        "protocolVersion": PROTOCOL_VERSION + 99, "client": "itest",
    })
    assert reply["ok"] is False
    assert reply["error"]["code"] == "bad_request"


async def test_settings_round_trip_through_real_config(host, client):
    reply = await call(host, client, "settings.get")
    assert reply["ok"] is True
    before = reply["result"]["settings"]
    assert before["uploadSlots"] >= 0

    patch = {"uploadSlots": 7, "maxDownloadSpeed": 2_097_152,
             "stallSeconds": 90, "downloadFolder": None,
             "incompleteFolder": None, "listenPort": None,
             "maxUploadSpeed": None, "autoConnect": None}
    reply = await call(host, client, "settings.patch", {"settings": patch})
    assert reply["ok"] is True
    after = reply["result"]["settings"]

    assert after["uploadSlots"] == 7
    assert after["stallSeconds"] == 90
    # Wire is bytes/sec; upstream stores KiB/s. 2 MiB/s -> 2048 KiB/s.
    assert host.config.sections["transfers"]["uploadslots"] == 7
    assert host.config.sections["transfers"]["downloadlimit"] == 2048
    assert host.config.sections["transfers"]["use_download_speed_limit"] == "primary"
    assert after["maxDownloadSpeed"] == 2_097_152


async def test_a_bad_download_folder_is_refused_over_the_wire(host, client, tmp_path):
    """The path helpers are unit-tested in test_paths.py. What this adds is
    that the refusal survives the socket as a bad_request the UI can render,
    rather than a 500 or a dropped frame — and, critically, that the config is
    LEFT ALONE. A patch that half-applies is worse than one that fails."""
    before = host.config.sections["transfers"].get("downloaddir")

    missing = str(tmp_path / "does-not-exist")
    reply = await call(host, client, "settings.patch", {"settings": {
        "downloadFolder": missing, "incompleteFolder": None, "listenPort": None,
        "maxDownloadSpeed": None, "maxUploadSpeed": None, "uploadSlots": None,
        "autoConnect": None, "stallSeconds": None,
    }})

    assert reply["ok"] is False
    assert reply["error"]["code"] == "bad_request"
    assert missing in reply["error"]["message"]
    assert host.config.sections["transfers"].get("downloaddir") == before


async def test_a_good_download_folder_is_stored_expanded(host, client, tmp_path):
    folder = tmp_path / "muzik"
    folder.mkdir()

    reply = await call(host, client, "settings.patch", {"settings": {
        "downloadFolder": f"{folder}/", "incompleteFolder": None,
        "listenPort": None, "maxDownloadSpeed": None, "maxUploadSpeed": None,
        "uploadSlots": None, "autoConnect": None, "stallSeconds": None,
    }})

    assert reply["ok"] is True
    assert reply["result"]["settings"]["downloadFolder"] == str(folder)
    assert host.config.sections["transfers"]["downloaddir"] == str(folder)


async def test_fs_check_over_the_socket(host, client, tmp_path):
    reply = await call(host, client, "fs.check", {"path": str(tmp_path)})
    assert reply["ok"] is True
    assert reply["result"]["isDirectory"] is True
    assert reply["result"]["writable"] is True

    reply = await call(host, client, "fs.check", {"path": str(tmp_path / "nope")})
    assert reply["ok"] is True, "a missing path is a fact, not an error"
    assert reply["result"]["exists"] is False
    assert reply["result"]["parentWritable"] is True


async def test_fs_ensure_folder_over_the_socket(host, client, tmp_path):
    target = tmp_path / "new" / "nested"
    reply = await call(host, client, "fs.ensureFolder", {"path": str(target)})
    assert reply["ok"] is True
    assert reply["result"]["isDirectory"] is True
    assert os.path.isdir(target)


async def test_a_shared_folder_that_does_not_exist_is_refused(host, client, tmp_path):
    """Offering a folder that cannot be read advertises files to the network
    that every request for will then fail — worse for the people asking than
    not sharing at all."""
    reply = await call(host, client, "shares.set", {
        "consent": "granted",
        "folders": [{"virtualName": "Ghost", "path": str(tmp_path / "gone"),
                     "exists": False}],
    })
    assert reply["ok"] is False
    assert reply["error"]["code"] == "bad_request"


async def test_two_shared_folders_cannot_share_a_virtual_name(host, client, tmp_path):
    """Upstream keys shares on the virtual name, so a duplicate silently means
    peers can reach only one of the two folders."""
    first, second = tmp_path / "a", tmp_path / "b"
    first.mkdir()
    second.mkdir()

    reply = await call(host, client, "shares.set", {
        "consent": "granted",
        "folders": [
            {"virtualName": "Music", "path": str(first), "exists": True},
            {"virtualName": "Music", "path": str(second), "exists": True},
        ],
    })
    assert reply["ok"] is False
    assert "Music" in reply["error"]["message"]

    await call(host, client, "shares.set", {"consent": "unset", "folders": []})


async def test_a_shared_folder_with_no_name_is_named_after_its_folder(host, client, tmp_path):
    folder = tmp_path / "Deep Archive"
    folder.mkdir()

    reply = await call(host, client, "shares.set", {
        "consent": "granted",
        "folders": [{"virtualName": "", "path": str(folder), "exists": True}],
    })
    assert reply["ok"] is True
    assert reply["result"]["folders"][0]["virtualName"] == "Deep Archive"

    await call(host, client, "shares.set", {"consent": "unset", "folders": []})


def _settings_patch(**overrides):
    """A full AppSettingsPatch. Every key must be present — the validator
    rejects a missing field, and null is how a patch says 'leave this alone'."""
    patch = {
        "autoConnect": None, "externalLookups": None, "discogsToken": None,
        "artworkCacheMb": None, "embedArtwork": None, "writeCoverFile": None,
        "preferLossless": None, "minBitrate": None, "rejectTranscodes": None,
        "autoOrganise": None, "autoDigSessions": None,
        "stalledFailMinutes": None, "clearCompletedDays": None,
        "acoustidApiKey": None, "youtubeApiKey": None,
        "youtubeOauthClientId": None, "youtubeOauthClientSecret": None,
    }
    patch.update(overrides)
    return patch


async def test_switching_off_external_lookups_actually_stops_lookups(host, client):
    """The privacy toggle has to reach the gate the network calls consult.

    This is a regression test for a real bug: the gate read a top-level
    `external_lookups` key while the patch handler wrote
    `app_settings.externalLookups`, so the switch was decorative and every
    MusicBrainz/Cover Art Archive/Deezer request went out regardless. A gate
    that is always open looks identical to a working one from the outside,
    which is why it needs a test rather than an inspection.
    """
    try:
        reply = await call(host, client, "app.settings.patch",
                           _settings_patch(externalLookups=False))
        assert reply["ok"] is True
        assert reply["result"]["externalLookups"] is False
        assert host._lookups_allowed() is False

        # Every command that would leave the machine must refuse, and say why.
        for command, params in (
            ("artwork.get", {"artist": "Burial", "release": "Untrue", "key": "k"}),
            ("metadata.inspect", {"path": "/nonexistent.flac", "transferId": None}),
            ("library.gaps", {"artist": "Burial", "release": "Untrue", "key": "k"}),
        ):
            reply = await call(host, client, command, params)
            assert reply["ok"] is False, f"{command} ran with lookups switched off"
            assert reply["error"]["code"] == "unsupported"
    finally:
        reply = await call(host, client, "app.settings.patch",
                          _settings_patch(externalLookups=True))
        assert reply["result"]["externalLookups"] is True
        assert host._lookups_allowed() is True


async def test_discover_parse_url_answers_on_the_socket(host, client, monkeypatch):
    """Dispatch → worker pool → broadcast → wire, with the network stubbed.

    The provider call itself is covered by test_discover.py against recorded
    responses; what is proved here is the part those cannot reach — that the
    command is routed by name, that the reply comes back immediately rather
    than blocking the main thread on an HTTP request, and that the event the
    worker emits from ANOTHER THREAD survives schema validation and arrives.
    """
    from seek_sidecar import discover as discover_mod

    def fake_parse_url(url, discogs_token="", **_kwargs):
        return {
            "requestId": "", "url": url, "sourceKind": "youtube", "kind": "track",
            "rawTitle": "Burial, Archangel", "channel": "Hyperdub",
            "artist": "", "title": "", "album": None, "year": None,
            "label": None, "catalogNumber": None, "artworkUri": None,
            "duration": None, "genres": [], "tracklist": [], "providerUrl": None,
        }

    monkeypatch.setattr(discover_mod, "parse_url", fake_parse_url)

    # NOT the `call` helper: it drains frames looking for its reply and drops
    # everything else. The worker emits from another thread, so the event can
    # legitimately arrive BEFORE the reply is read — and `call` would swallow
    # it, leaving this test waiting for a frame that had already been thrown
    # away. Read both out of one stream instead of assuming an order.
    await client.send(json.dumps({
        "id": "req-discover", "cmd": "discover.parseUrl",
        "params": {"url": "https://youtu.be/8k_f2QK77ew"},
    }))

    reply = None
    frame = None
    for _ in range(60):
        await pump(host, cycles=1)
        try:
            received = json.loads(await asyncio.wait_for(client.recv(), timeout=0.2))
        except asyncio.TimeoutError:
            continue
        if received.get("id") == "req-discover":
            reply = received
        elif received.get("ev") == "discover.parsed":
            frame = received
        if reply is not None and frame is not None:
            break

    assert reply is not None, "no reply to discover.parseUrl"
    assert reply["ok"] is True
    request_id = reply["result"]["requestId"]
    assert request_id
    assert frame is not None, "discover.parsed never arrived"

    assert frame["data"]["requestId"] == request_id
    assert frame["data"]["rawTitle"] == "Burial, Archangel"
    assert frame["data"]["channel"] == "Hyperdub"
    # The sidecar must not have split the title. That is the seam.
    assert frame["data"]["artist"] == ""


async def test_discover_is_refused_when_external_lookups_are_off(host, client):
    try:
        await call(host, client, "app.settings.patch",
                   _settings_patch(externalLookups=False))
        reply = await call(host, client, "discover.parseUrl",
                           {"url": "https://youtu.be/8k_f2QK77ew"})
        assert reply["ok"] is False
        assert reply["error"]["code"] == "unsupported"
    finally:
        await call(host, client, "app.settings.patch",
                   _settings_patch(externalLookups=True))


async def test_search_while_offline_is_refused_by_the_real_core(host, client):
    """Proves dispatch reaches pynicotine: the refusal comes from
    core.users.login_status, not from a stub."""
    reply = await call(host, client, "search.start", {
        "query": "burial", "mode": "global", "room": None, "users": [],
        "resultCap": None, "timeoutSeconds": None,
    })
    assert reply["ok"] is False
    assert reply["error"]["code"] == "not_connected"


async def test_unknown_transfer_ids_are_a_no_op_not_a_crash(host, client):
    reply = await call(host, client, "transfer.pause",
                       {"transferIds": ["deadbeefdeadbeef"]})
    assert reply["ok"] is True


# ----------------------------------------------- the real event-bus pathway

async def test_search_response_flows_through_upstreams_event_bus_to_the_socket(
    host, client
):
    """The core evidence in this file.

    A FileSearchResponse is emitted on pynicotine's OWN event bus. Everything
    after that is production code: upstream's dispatch, our registered handler,
    the real translation layer, the real batching registry, the real WebSocket.
    Only the peer socket that would have delivered the message is absent.
    """
    from pynicotine.search import SearchRequest
    from pynicotine.slskmessages import FileAttributes, FileSearchResponse

    token = 424242

    # Register the search with UPSTREAM as well as with our registry. This is
    # not ceremony: pynicotine.search._file_search_response sets msg.token=None
    # for any token it does not recognise (search.py:632), and its handler is
    # connected before ours. Routing through upstream's real filter chain is
    # what makes this test meaningful rather than a mock of our own code.
    host.core.search.searches[token] = SearchRequest(
        token=token, term="burial", term_sanitized="burial",
        term_transmitted="burial", included_words=["burial"],
        excluded_words=[], mode="global",
    )
    host.searches.add(token, "burial", "burial", "global")

    msg = FileSearchResponse()
    msg.username = "some_peer"           # connection-authenticated name
    msg.search_username = "not_this_one"  # self-reported; must be ignored
    msg.token = token
    msg.addr = ("10.0.0.9", 2234)
    msg.freeulslots = True
    msg.ulspeed = 1_500_000
    msg.inqueue = 4
    msg.privatelist = []
    msg.list = [
        # lossless: duration + sample rate + bit depth, NO bitrate
        (1, "@@abc\\Music\\Burial - Untrue (2007) [FLAC]\\02 - Archangel.flac",
         28_000_000, None,
         FileAttributes(length=236, sample_rate=44100, bit_depth=16)),
        # lossy: bitrate + duration + vbr, NO sample rate or bit depth
        (1, "@@abc\\Music\\Burial - Untrue (2007) [FLAC]\\03 - Near Dark.mp3",
         8_560_000, None,
         FileAttributes(bitrate=320, length=214, vbr=0)),
        # a peer that sends no attributes at all
        (1, "@@abc\\Music\\Burial - Untrue (2007) [FLAC]\\cover.jpg",
         240_000, None, FileAttributes()),
    ]

    host.events.emit("file-search-response", msg)
    await pump(host, cycles=12)

    frame = None
    for _ in range(20):
        candidate = json.loads(await asyncio.wait_for(client.recv(), timeout=5))
        if candidate.get("ev") == "search.result":
            frame = candidate
            break
    assert frame is not None, "no search.result reached the client"

    data = frame["data"]
    assert data["searchId"] == token
    assert data["peer"]["username"] == "some_peer"
    assert data["peer"]["freeSlots"] is True
    # Raw, not normalised: upstream's GTK client would have zeroed this.
    assert data["peer"]["queueLength"] == 4
    assert data["peer"]["advertisedSpeed"] == 1_500_000

    flac, mp3, jpg = data["files"]

    assert flac["path"].endswith("02 - Archangel.flac")
    assert flac["bitrate"] is None, "lossless files carry no advertised bitrate"
    assert (flac["duration"], flac["sampleRate"], flac["bitDepth"]) == (236, 44100, 16)

    assert mp3["bitrate"] == 320
    assert mp3["isVbr"] is False
    assert mp3["sampleRate"] is None and mp3["bitDepth"] is None

    assert all(jpg[k] is None for k in
               ("bitrate", "duration", "sampleRate", "bitDepth", "isVbr"))
    assert jpg["size"] == 240_000


async def test_rejected_response_never_reaches_the_client(host, client):
    """search.py sets msg.token = None for ignored users and unknown tokens.
    Our handler must honour that — those results are filtered for a reason."""
    from pynicotine.slskmessages import FileAttributes, FileSearchResponse

    msg = FileSearchResponse()
    msg.username = "ignored_peer"
    msg.token = None
    msg.addr = ("10.0.0.9", 2234)
    msg.freeulslots = False
    msg.ulspeed = 0
    msg.inqueue = 0
    msg.privatelist = []
    msg.list = [(1, "x\\y.mp3", 1, None, FileAttributes())]

    host.events.emit("file-search-response", msg)
    await pump(host, cycles=8)

    with pytest.raises(asyncio.TimeoutError):
        while True:
            frame = json.loads(await asyncio.wait_for(client.recv(), timeout=0.6))
            assert frame.get("ev") != "search.result", "a filtered result leaked"


async def test_connection_stats_no_argument_reset_survives(host, client):
    """slskproto emits this with no arguments at all. If our handler lacked
    defaults, upstream's events.emit would call core.quit() and re-raise."""
    host.events.emit("set-connection-stats")
    host.events.emit("set-connection-stats", total_conns=5,
                     download_bandwidth=1024, upload_bandwidth=64)
    await pump(host, cycles=6)

    seen = []
    for _ in range(12):
        try:
            frame = json.loads(await asyncio.wait_for(client.recv(), timeout=1.0))
        except asyncio.TimeoutError:
            break
        if frame.get("ev") == "connection.stats":
            seen.append(frame["data"])

    assert {"connections": 0, "downloadBandwidth": 0, "uploadBandwidth": 0} in seen
    assert {"connections": 5, "downloadBandwidth": 1024, "uploadBandwidth": 64} in seen
    # And the core is still alive, which is the real assertion.
    assert host.core.search is not None


async def test_transfer_lifecycle_over_the_socket(host, client):
    """Drive a Transfer through the real event bus and watch added -> updated
    with a real stable id."""
    from pynicotine.transfers import Transfer

    transfer = Transfer("peer_x", "@@abc\\Music\\a.flac", "/tmp/dl", 1_000_000)
    transfer.status = "Queued"

    host.events.emit("update-download", transfer, True)
    await pump(host, cycles=6)

    added = None
    for _ in range(15):
        frame = json.loads(await asyncio.wait_for(client.recv(), timeout=3))
        if frame.get("ev") == "transfer.added":
            added = frame
            break
    assert added is not None
    transfer_id = added["data"]["id"]
    assert added["data"]["state"] == "queued"
    assert added["data"]["bytesDone"] == 0
    assert added["data"]["secondsLeft"] is None

    transfer.status = "Transferring"
    transfer.current_byte_offset = 250_000
    transfer.speed = 500_000
    transfer.time_left = 2
    transfer.time_elapsed = 1
    host.events.emit("update-download", transfer, True)
    await pump(host, cycles=6)

    updated = None
    for _ in range(15):
        frame = json.loads(await asyncio.wait_for(client.recv(), timeout=3))
        if frame.get("ev") == "transfer.updated":
            updated = frame
            break
    assert updated is not None
    assert updated["data"]["id"] == transfer_id, "the id must be stable"
    assert updated["data"]["state"] == "transferring"
    assert updated["data"]["bytesDone"] == 250_000
    assert updated["data"]["speed"] == 500_000
    assert updated["data"]["secondsLeft"] == 2
    assert updated["data"]["stalled"] is False


# ------------------------------------------------------ shares + import API
#
# The import command's default path is the user's REAL Nicotine+ config. These
# tests monkeypatch it to a synthetic file. Nothing here reads real credentials.

SYNTHETIC_CONFIG = """\
[server]
login = synthetic_user
passw = synthetic-secret-value

[transfers]
downloaddir = /tmp/seek-itest-downloads
shared = [('ITest', '/tmp/seek-itest-share')]
"""


async def test_a_search_response_carries_the_peers_country(host, client):
    """Flags cost nothing on the network, which is the only reason they are
    affordable. A search response arrives over a DIRECT peer connection, so
    slskproto has already stamped the peer's real address onto the message and
    the country is a bisect over a bundled CSV.

    The IPs here are measured, not invented: 8.8.8.8 resolves to US against
    pynicotine's own ip_country_data.csv.
    """
    from pynicotine.search import SearchRequest
    from pynicotine.slskmessages import FileAttributes, FileSearchResponse

    token = 424299
    host.core.search.searches[token] = SearchRequest(
        token=token, term="aphex", term_sanitized="aphex",
        term_transmitted="aphex", included_words=["aphex"],
        excluded_words=[], mode="global",
    )
    host.searches.add(token, "aphex", "aphex", "global")

    msg = FileSearchResponse()
    msg.username = "peer_in_the_states"
    msg.token = token
    msg.addr = ("8.8.8.8", 2234)
    msg.freeulslots = True
    msg.ulspeed = 900_000
    msg.inqueue = 0
    msg.privatelist = []
    msg.list = [(1, "@@x\\a\\b.mp3", 5_000_000, None, FileAttributes(bitrate=320))]

    host.events.emit("file-search-response", msg)
    await pump(host, cycles=12)

    frame = None
    for _ in range(20):
        candidate = json.loads(await asyncio.wait_for(client.recv(), timeout=5))
        if candidate.get("ev") == "search.result":
            frame = candidate
            break
    assert frame is not None
    assert frame["data"]["peer"]["country"] == "US"


def test_a_private_address_yields_no_country_rather_than_a_wrong_one(host):
    """A LAN peer has no country, and the schema says 'when known'. An empty
    string must reach the wire as null so nothing renders a flag for it."""
    from pynicotine.slskmessages import FileSearchResponse

    msg = FileSearchResponse()
    msg.username = "peer_on_the_lan"
    msg.addr = ("192.168.1.20", 2234)
    assert host._country_from_search(msg) == ""

    from seek_sidecar import translate
    msg.freeulslots, msg.ulspeed, msg.inqueue = True, 0, 0
    peer = translate.peer_stats_from_search(msg, country="")
    assert peer["country"] is None


def test_a_malformed_address_does_not_take_the_search_handler_down(host):
    """inet_aton raises on anything that is not dotted-quad. A missing flag is
    acceptable; a search handler that dies on one odd peer is not."""
    from pynicotine.slskmessages import FileSearchResponse

    for bad in (None, ("not-an-ip", 2234), ("", 0), ()):
        msg = FileSearchResponse()
        msg.username = f"peer_{bad}"
        msg.addr = bad
        assert host._country_from_search(msg) == ""


def test_the_country_is_resolved_once_per_peer(host):
    """One peer sends many responses; the lookup is cheap but not free, and the
    cache is also what lets `user.stats` answer with the same country.

    Proved by changing the address between calls: a second resolution would
    return AU, and the cached one returns US. (NetworkFilter uses __slots__, so
    counting calls by monkeypatching the method is not available.)
    """
    from pynicotine.slskmessages import FileSearchResponse

    host._peer_extra.pop("repeat_peer", None)

    first = FileSearchResponse()
    first.username = "repeat_peer"
    first.addr = ("8.8.8.8", 2234)
    assert host._country_from_search(first) == "US"

    moved = FileSearchResponse()
    moved.username = "repeat_peer"
    moved.addr = ("1.1.1.1", 2234)      # AU, if it were resolved again
    assert host._country_from_search(moved) == "US"


def test_an_unresolvable_peer_is_not_re_resolved_on_every_response(host):
    """The empty string is a real answer and has to be cached as one. Caching
    on truthiness instead would send every LAN peer back through the lookup on
    every one of its responses — and there can be thousands per search."""
    from pynicotine.slskmessages import FileSearchResponse

    host._peer_extra.pop("lan_peer", None)

    first = FileSearchResponse()
    first.username = "lan_peer"
    first.addr = ("10.0.0.9", 2234)
    assert host._country_from_search(first) == ""
    assert host._peer_extra["lan_peer"]["country"] == ""

    later = FileSearchResponse()
    later.username = "lan_peer"
    later.addr = ("8.8.8.8", 2234)
    assert host._country_from_search(later) == "", "the empty answer was not cached"


async def test_transfer_stats_over_the_socket(host, client):
    """Upstream's `statistics` component has been enabled since the beginning
    and never surfaced. This is the first thing that reads it."""
    reply = await call(host, client, "stats.get")
    assert reply["ok"] is True
    stats = reply["result"]

    assert set(stats) == {"sinceTimestamp", "session", "total"}
    for half in ("session", "total"):
        assert set(stats[half]) == {
            "startedDownloads", "completedDownloads", "downloadedSize",
            "startedUploads", "completedUploads", "uploadedSize",
        }
        assert all(isinstance(v, int) and v >= 0 for v in stats[half].values())


async def test_stats_carry_no_derived_figures(host, client):
    """No ratio, no completion rate, no percentages. Arithmetic for display is
    TypeScript's, here as everywhere else."""
    stats = (await call(host, client, "stats.get"))["result"]
    flat = {*stats["session"], *stats["total"], *stats}
    for banned in ("ratio", "percent", "rate", "average"):
        assert not any(banned.lower() in key.lower() for key in flat), banned


async def test_a_stat_change_reaches_the_client(host, client):
    host._stats_sent_at = 0.0
    host.core.statistics.append_stat_value("completed_downloads", 1)
    await pump(host, cycles=4)

    frame = None
    for _ in range(20):
        candidate = json.loads(await asyncio.wait_for(client.recv(), timeout=5))
        if candidate.get("ev") == "stats.changed":
            frame = candidate
            break
    assert frame is not None, "no stats.changed reached the client"
    assert frame["data"]["total"]["completedDownloads"] >= 1
    # The session counter is the one that proves this run did it.
    assert frame["data"]["session"]["completedDownloads"] >= 1


def test_the_broadcast_is_rate_limited(host):
    """Upstream emits `update-stat` once per fragment per transfer — several a
    second with a few downloads running. A statistics screen has no use for
    that resolution and neither does a websocket."""
    sent = []
    real = host.bridge.broadcast
    host.bridge.broadcast = lambda name, payload: sent.append(name)
    try:
        host._stats_sent_at = 0.0
        for _ in range(50):
            host._on_update_stat("downloaded_size", 1, 1)
    finally:
        host.bridge.broadcast = real

    assert sent.count("stats.changed") == 1, (
        f"{sent.count('stats.changed')} broadcasts for 50 events"
    )


async def test_profile_get_against_the_real_core(host, client):
    """This exists because a hand-written stub hid a real signature mismatch.

    `Uploads.get_upload_queue_size` takes a REQUIRED `username`; the stub in
    test_profile.py had given it a default, so 26 tests passed while the live
    core raised TypeError on the very first `profile.get`. Anything reading a
    pynicotine component needs at least one test against the real one.
    """
    reply = await call(host, client, "profile.get")
    assert reply["ok"] is True, reply.get("error")
    profile = reply["result"]

    assert set(profile) == {
        "username", "description", "picturePath", "pictureUri", "pictureError",
        "pictureBytes", "pictureVisible", "sharedFiles", "sharedFolders",
        "uploadSlots", "freeSlots", "queueSize",
    }
    assert isinstance(profile["uploadSlots"], int)
    assert isinstance(profile["queueSize"], int)
    assert isinstance(profile["freeSlots"], bool)


async def test_a_description_round_trips_through_the_real_config(host, client):
    """The backslash case, over the socket and through pynicotine's own config
    object — not just through the escape helper."""
    text = "Tbilisi. C:\\new stuff\\only, 'quoted' bits and a\nnewline."

    reply = await call(host, client, "profile.set", {
        "description": text, "picturePath": None, "pictureVisible": None,
    })
    assert reply["ok"] is True, reply.get("error")
    assert reply["result"]["description"] == text

    # And it survives a fresh read of the config section.
    reply = await call(host, client, "profile.get")
    assert reply["result"]["description"] == text

    await call(host, client, "profile.set", {
        "description": "", "picturePath": None, "pictureVisible": None,
    })


async def test_connections_get_against_the_real_core(host, client):
    reply = await call(host, client, "connections.get")
    assert reply["ok"] is True, reply.get("error")
    snapshot = reply["result"]
    assert set(snapshot) == {"socketCount", "peers"}
    assert isinstance(snapshot["socketCount"], int)
    assert isinstance(snapshot["peers"], list)


async def test_shares_default_to_unset_and_share_nothing(host, client):
    reply = await call(host, client, "shares.get")
    assert reply["ok"] is True
    state = reply["result"]
    assert state["consent"] == "unset"
    assert state["folders"] == []
    assert state["scanning"] is False


async def test_declining_persists_and_is_queryable(host, client, tmp_path):
    """The app surfaces a permanent indicator from this. If it reset on
    restart, throttled transfers would look like a Seek bug rather than the
    reciprocity rule working as designed."""
    reply = await call(host, client, "shares.set",
                       {"consent": "declined", "folders": []})
    assert reply["ok"] is True
    assert reply["result"]["consent"] == "declined"

    # Survives a fresh read of the on-disk state, i.e. a restart.
    assert host._stored_consent() == "declined"
    assert host._load_state()["share_consent"] == "declined"

    reply = await call(host, client, "shares.get")
    assert reply["result"]["consent"] == "declined"


async def test_granting_consent_records_folders(host, client, tmp_path):
    folder = str(tmp_path / "share")
    os.makedirs(folder, exist_ok=True)
    reply = await call(host, client, "shares.set", {
        "consent": "granted",
        "folders": [{"virtualName": "Music", "path": folder, "exists": True}],
    })
    assert reply["ok"] is True
    state = reply["result"]
    assert state["consent"] == "granted"
    assert state["folders"][0]["path"] == folder
    assert state["folders"][0]["exists"] is True
    # This session started without the shares component, so sharing begins next launch.
    assert state["restartRequired"] is True

    # Reset so later tests see a clean slate.
    await call(host, client, "shares.set", {"consent": "unset", "folders": []})


async def test_contradictory_share_settings_are_rejected(host, client):
    reply = await call(host, client, "shares.set",
                       {"consent": "granted", "folders": []})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "bad_request"

    reply = await call(host, client, "shares.set", {
        "consent": "declined",
        "folders": [{"virtualName": "x", "path": "/tmp", "exists": True}],
    })
    assert reply["ok"] is False


async def test_rescan_without_the_shares_component_says_so(host, client):
    reply = await call(host, client, "shares.rescan", {"force": False})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "unsupported"


async def test_import_inspect_over_the_socket(host, client, tmp_path, monkeypatch):
    synthetic = str(tmp_path / "nicotine-config")
    with open(synthetic, "w", encoding="utf-8") as handle:
        handle.write(SYNTHETIC_CONFIG)

    from seek_sidecar import nicotine_import
    monkeypatch.setattr(nicotine_import, "default_config_path", lambda: synthetic)

    reply = await call(host, client, "import.inspect")
    assert reply["ok"] is True
    source = reply["result"]
    assert source["available"] is True
    assert source["hasCredentials"] is True
    assert source["username"] == "synthetic_user"
    assert source["folders"][0]["virtualName"] == "ITest"

    # The password must not have travelled over the socket in any form.
    assert "synthetic-secret-value" not in json.dumps(reply)


async def test_import_apply_over_the_socket(host, client, tmp_path, monkeypatch):
    synthetic = str(tmp_path / "nicotine-config-2")
    with open(synthetic, "w", encoding="utf-8") as handle:
        handle.write(SYNTHETIC_CONFIG)

    from seek_sidecar import nicotine_import
    monkeypatch.setattr(nicotine_import, "default_config_path", lambda: synthetic)

    reply = await call(host, client, "import.apply", {
        "credentials": True, "shares": False, "downloadFolder": True,
    })
    assert reply["ok"] is True
    result = reply["result"]
    assert result["importedCredentials"] is True
    assert result["importedShares"] == 0
    assert result["importedDownloadFolder"] is True
    assert result["username"] == "synthetic_user"

    # Landed in Seek's own config, so login can work...
    assert host.config.sections["server"]["login"] == "synthetic_user"
    assert host.config.sections["server"]["passw"] == "synthetic-secret-value"
    # ...and nowhere on the wire.
    assert "synthetic-secret-value" not in json.dumps(reply)

    # Clean up so we do not leave synthetic credentials in the test config.
    host.config.sections["server"]["login"] = ""
    host.config.sections["server"]["passw"] = ""


async def test_import_from_a_missing_config_is_a_clean_error(host, client, monkeypatch):
    from seek_sidecar import nicotine_import
    monkeypatch.setattr(nicotine_import, "default_config_path",
                        lambda: "/nonexistent/nicotine/config")

    reply = await call(host, client, "import.inspect")
    assert reply["ok"] is True
    assert reply["result"]["available"] is False

    reply = await call(host, client, "import.apply", {
        "credentials": True, "shares": True, "downloadFolder": True,
    })
    assert reply["ok"] is False
    assert reply["error"]["code"] == "not_found"
