"""
Seek — queueing a whole remote folder.

A folder Get is two steps: ask the peer what is in it, then queue what comes
back. Two bugs lived between the steps; these pin both fixes.

* The "this is a lot of files" check ran BEFORE the first step, on the files a
  search had shown, which is often a fraction of the folder. A 3,000-file
  folder could be queued without a question. The sidecar is the only side that
  ever sees the real count, so it holds a big folder back and says so.
* Waiting requests were kept one per user and folder, so a second Get on the
  same folder before the peer answered replaced the first, and a folder chosen
  with Download to… in the first was lost.

CoreHost.__init__ boots pynicotine's core, which cannot run twice in a process
(test_integration.py owns the one instance a run is allowed), so the methods
are driven on a bare instance with the engine stubbed.
"""

import types

from seek_sidecar import protocol
from seek_sidecar.core_host import CoreHost

FOLDER = "Music\\Burial - Untrue"


class Attrs:
    """FileAttributes stand-in. Upstream's uses __slots__: absent means absent."""


class Bridge:
    def __init__(self):
        self.events = []

    def broadcast(self, name, payload):
        protocol.validate_event(name, payload)
        self.events.append((name, payload))


class Downloads:
    """Upstream's downloads component, as far as a folder Get touches it."""

    def __init__(self):
        self.requested = []
        self.queued = {}   # virtual path -> local folder

    def request_folder(self, username, folder_path):
        self.requested.append((username, folder_path))

    def get_folder_destination(self, username, folder_path, root_folder_path=None,
                               download_folder_path=None):
        return download_folder_path or "/Downloads"

    def enqueue_download(self, username, virtual_path, folder_path=None, size=0):
        # Upstream keys a transfer by user + path and drops a duplicate.
        self.queued.setdefault(virtual_path, folder_path)


def _host():
    host = object.__new__(CoreHost)
    host.bridge = Bridge()
    host._folder_requests = {}
    host._require_online = lambda: None
    host.core = types.SimpleNamespace(downloads=Downloads())
    return host


def _ask(host, **params):
    params = {"username": "nightbus", "folderPath": FOLDER, "recurse": False,
              "destination": None, "confirmAbove": None, **params}
    protocol.validate_command("transfer.enqueueFolder", params)
    return host._cmd_transfer_enqueueFolder(params)


def _answer(host, files):
    host._on_folder_contents(types.SimpleNamespace(
        username="nightbus", dir=FOLDER,
        list={FOLDER: [(1, f"{i:04}.flac", 30_000_000, None, Attrs()) for i in range(files)]},
    ))
    return host.bridge.events[-1][1]


class TestABigFolderAsksFirst:
    def test_past_the_limit_it_is_held_not_queued(self):
        host = _host()
        _ask(host, confirmAbove=1000, destination="/Volumes/USB")
        event = _answer(host, 1200)

        assert host.core.downloads.queued == {}
        assert event["enqueued"] == 0
        assert event["held"] == {"count": 1200, "recurse": False, "destination": "/Volumes/USB"}

    def test_within_the_limit_it_is_queued_at_once(self):
        host = _host()
        _ask(host, confirmAbove=1000)
        event = _answer(host, 12)

        assert len(host.core.downloads.queued) == 12
        assert event["held"] is None

    def test_once_confirmed_the_whole_folder_is_queued(self):
        host = _host()
        _ask(host, confirmAbove=None)
        _answer(host, 1200)
        assert len(host.core.downloads.queued) == 1200


class TestASecondGetDoesNotReplaceTheFirst:
    def test_the_first_download_to_folder_survives(self):
        host = _host()
        _ask(host, destination="/Volumes/USB")
        _ask(host, destination=None)      # Get pressed again before the answer
        _answer(host, 3)

        assert set(host.core.downloads.queued.values()) == {"/Volumes/USB"}

    def test_the_first_held_request_is_the_one_asked_about(self):
        host = _host()
        _ask(host, confirmAbove=1000, destination="/Volumes/USB")
        _ask(host, confirmAbove=1000, destination="/Volumes/SSD")
        event = _answer(host, 1200)
        assert event["held"]["destination"] == "/Volumes/USB"

    def test_one_answer_settles_every_waiting_request(self):
        host = _host()
        _ask(host)
        _ask(host)
        _answer(host, 3)
        assert host._folder_requests == {}

    def test_a_failure_settles_every_waiting_request(self):
        host = _host()
        _ask(host)
        _ask(host)
        host._on_folder_contents_failed("nightbus", FOLDER)

        assert host._folder_requests == {}
        assert [name for name, _ in host.bridge.events] == ["folder.contents.failed"]
