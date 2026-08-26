# RECON — what upstream Nicotine+ actually gives us

Written before any IPC design, per `docs/PRODUCT.md` §"Before you write any code" item 3.
Every claim here was checked against the code in `upstream/` and, where marked
**[verified at runtime]**, executed.

**Verdict: the plan is sound. The core runs headless with GTK entirely absent, and
Seek needs zero patches to `upstream/`.** Two things in the brief are factually wrong
about the data model and are corrected in §4 — one of them materially changes the
transcode-detection feature.

---

## 0. What we are actually forked from

`docs/PRODUCT.md` says "git tag 3.3.10". That is not what is checked out.

```
$ git -C upstream describe --tags
3.3.10-1037-gd8f074574
$ grep __version__ upstream/pynicotine/__init__.py
__version__ = "3.4.0.dev1"
```

We are on **master, 1037 commits past the 3.3.10 tag**, self-identifying as
`3.4.0.dev1`. This matters for two reasons:

- Everything below describes master. Some of it (e.g. `Login.is_supporter`,
  `RoomMembers`, the `search_username`/`username` split on `FileSearchResponse`)
  does not exist or differs in the 3.3.10 release.
- Master is a moving target. If mergeability with upstream is the priority, pin to
  the 3.3.10 tag and re-run this recon; if being current is the priority, stay here
  but treat `d8f074574` as the pinned commit and record it.

**Recommendation: leave it as-is, but pin the submodule/commit explicitly and note
in the README that Seek tracks `3.4.0.dev1 @ d8f074574`, not a release.** No
decision needed from me — flagging it because the coordination doc is wrong.

Python: upstream declares `python_requires = >=3.10` (`setup.cfg`) and enforces it
at runtime in `check_python_version()`. System Python here is 3.9.6, so the sidecar
venv uses the uv-managed CPython **3.11.15 arm64** already present at
`~/.local/share/uv/python/`. No Homebrew install was needed — that saves ~150 MB on
a disk at 98%.

---

## 1. Core / GTK separation — clean, and the GTK imports are lazy

**[verified at runtime]** Every GTK reference outside `pynicotine/gtkgui/` lives in
exactly three places, and all of them are function-local imports that only execute
on non-Darwin platforms or on explicit user action:

| File | Line | Context | Reachable in Seek? |
|---|---|---|---|
| `pynicotine/utils.py` | 512 | `_try_open_uri()`, inside `if sys.platform not in {"darwin","win32"}` — and wrapped in `try/except` with a `webbrowser` fallback | No. We're on macOS, and it's guarded twice over. |
| `pynicotine/nowplaying.py` | 201, 234 | `NowPlaying._mpris()` — MPRIS/D-Bus "now playing" lookup | Only if we call it. We don't enable the `now_playing` component. |
| `pynicotine/plugins/now_playing_sender/__init__.py` | 11, 59, 85 | plugin `loaded_notification` | Only if that plugin is enabled. It isn't by default on macOS. |

Proof that the separation holds, run in a venv with **no PyGObject installed at all**:

```
$ .venv/bin/python -c "import gi"
ModuleNotFoundError: No module named 'gi'

$ .venv/bin/python <import every .py under pynicotine/ except gtkgui/ and tests/>
gi absent (good)
imported 52/52 non-gtkgui modules with GTK absent
```

52 of 52. Nothing outside `gtkgui/` needs GTK at import time.

The only thing that *does* hard-fail is importing `pynicotine.gtkgui` itself, which
prints `Cannot find PyGObject >=3.42.1, please install it` and exits. That is
correct behaviour and we never import it.

**Conclusion: no patches to `upstream/` are required.** Seek adds `upstream/` to
`sys.path`, calls `core.init_components()` with a component subset, and subscribes
to `events`. Upstream stays byte-identical and trivially mergeable.

---

## 2. `pynicotine/headless/application.py` — a daemon entry point, but trivially
   replaceable as a library

Read in full. It is 110 lines and does four things:

1. Installs `sys.excepthook`.
2. Registers `add_log_level("download"/"upload")`.
3. Connects five interactive CLI callbacks (`confirm-quit`, `invalid-password`,
   `invalid-username`, `setup`, `shares-unavailable`) that all call
   `cli.prompt(...)` — i.e. they **block on stdin**.
4. `run()`: `core.start()`, optional `core.connect()`, then

```python
while events.process_thread_events():
    time.sleep(0.1)
config.write_configuration()
```

**It is not usable as-is for embedding**, because of (3): its answer to "you have no
credentials" is to prompt on stdin, which would hang a GUI-launched sidecar forever.
But it is also not something we need. The pattern it demonstrates — a 10 Hz pump of
`events.process_thread_events()` on the main thread — *is* the whole contract, and
we reimplement it in ~20 lines with our own callbacks that emit onto the WebSocket
instead of prompting. That is what `sidecar/seek_sidecar/app.py` does.

Two consequences worth stating plainly:

- **`events.emit()` must only be called from the main thread.** Background threads
  use `events.emit_main_thread()` / `events.invoke_main_thread()`, which enqueue onto
  a `SimpleQueue` drained by `process_thread_events()`. Our WebSocket server
  therefore cannot call into `core` directly from its own thread — inbound commands
  are marshalled onto the main loop. (See §7.)
- **Callback registration order is load-bearing.** `pynicotine.search.Search`
  connects `file-search-response` in its constructor and uses `msg.token = None` as
  its "reject this result" signal for ignored users/tokens. Any consumer must
  connect *after* `core.init_components()` so it observes the already-filtered
  message. Same pattern on `folder-contents-response` (`msg.token = msg.dir = None`)
  and `user-status` (`msg.user = None`).

**[verified at runtime]** Boot with `enabled_components={network_thread, users,
network_filter, notifications, statistics, search, downloads, uploads, userbrowse,
userinfo, shares, pluginhandler}` and `isolated_mode=True`:

```
config file  -> <scratch>/nconf/config
data folder  -> <scratch>/nconf/data
need_config  -> True
components   -> ['downloads', 'network_filter', 'network_thread', 'notifications',
                 'pluginhandler', 'search', 'shares', 'statistics', 'uploads',
                 'userbrowse', 'userinfo', 'users']
search obj   -> <pynicotine.search.Search object at 0x10a86cdd0>
events observed: [('start', {}),
                  ('set-connection-stats', {}),
                  ('set-connection-stats', {'total_conns': 0, 'download_bandwidth': 0,
                                            'upload_bandwidth': 0}),
                  ('shares-ready', {}), ...]
clean exit
```

Components we deliberately **do not** enable:

- `update_checker` — `UpdateChecker._check()` calls
  `urlopen("https://pypi.org/pypi/nicotine-plus/json")`. That is an unsolicited
  outbound request tied to app startup. The brief says no telemetry; this is close
  enough to the line that it goes off.
- `now_playing` — the only D-Bus/GTK surface in the core.
- `cli` / `signal_handler` / `error_handler` — the sidecar owns its own lifecycle.
- `portmapper` — UPnP/NAT-PMP. Off by default in `isolated_mode`; should become a
  user setting later, not a startup default.

One sharp edge: `pynicotine/shares.py` scans shares via `multiprocessing` with the
**spawn** start method, which re-imports `__main__`. The sidecar entry point must
therefore be a real file (it is) — running the core from `python - <<EOF` produces a
`FileNotFoundError: .../<stdin>` in the spawned child. Harmless in our layout, but
it will bite anyone who tries to prototype the core from a heredoc.

---

## 3. The real event surface

`pynicotine/events.py` is a `defaultdict(list)` of name → callbacks, with 190 event
names in `EVENT_NAMES` and a `ValueError` on unknown names. There is no wildcard
subscription and no introspection of payload shape — signatures are whatever the
emitter passes, so each one below was read at its emit site.

Two dispatch styles coexist and the difference matters:

- **Message events** — `NETWORK_MESSAGE_EVENTS` (`slskmessages.py:4233`) maps a
  message class to an event name. The callback receives **one positional argument**,
  the parsed message object.
- **Ad-hoc events** — emitted by hand with arbitrary positional and/or keyword args.

### Events Seek consumes

| Event | Emitted at | Signature | Payload notes |
|---|---|---|---|
| `server-login` | `NETWORK_MESSAGE_EVENTS[Login]` | `(msg)` | `msg.success: bool`, `.username`, `.rejection_reason`, `.rejection_detail`, `.banner`, `.ip_address`, `.local_address`, `.server_address`, `.is_supporter`. On failure `success` is False and `rejection_reason` is set. |
| `server-disconnect` | `NETWORK_MESSAGE_EVENTS[ServerDisconnect]` | `(msg)` | Internal message. Treat as "we are offline"; `core.users.login_status` is the authority. |
| `set-connection-stats` | `slskproto.py:1264, 1624, 2921, 2957` | **kwargs, and sometimes none at all** | Full form: `total_conns=int, download_bandwidth=int, upload_bandwidth=int`, emitted once per second from the network loop. Reset form: **emitted with zero arguments** (lines 1264, 1624, 2957). A consumer *must* be `def cb(self, total_conns=0, download_bandwidth=0, upload_bandwidth=0)` — upstream's own GTK handler is `def set_connection_stats(self, total_conns=0, **_kwargs)`. Getting this wrong is a `TypeError` inside `events.emit`, which upstream escalates by calling `core.quit()` and re-raising. |
| `add-search` | `search.py:255` | `(token, search, switch_page)` | `token: int`, `search: SearchRequest` with `.term`, `.term_sanitized`, `.term_transmitted`, `.included_words`, `.excluded_words`, `.mode`, `.room`, `.users`. |
| `remove-search` | `search.py:296` | `(token)` | |
| `search-failed` | `search.py:266` | `(token, is_offline=True)` | Keyword arg. Only ever emitted for the offline case. |
| `file-search-response` | `NETWORK_MESSAGE_EVENTS[FileSearchResponse]` | `(msg)` | The main event. See §4. |
| `user-stats` | `NETWORK_MESSAGE_EVENTS[GetUserStats]`, re-emitted at `users.py:331` | `(msg)` | `msg.user`, `.avgspeed` (bytes/sec, server's long-run average), `.uploadnum`, `.files`, `.dirs`. **Not** free slots or queue length — those only arrive on a search response. |
| `user-status` | `NETWORK_MESSAGE_EVENTS[GetUserStatus]`, also `users.py:103` | `(msg)` | `msg.user`, `.status` (0 offline / 1 away / 2 online), `.privileged`. **`msg.user` is set to `None` by `users.py:355`** for stale self-status updates — check for it. |
| `update-download` | `downloads.py:327` | `(transfer, update_parent: bool)` | The single most important transfer event. Fires on enqueue, every state change, and every progress tick. See §5. |
| `abort-download` | `downloads.py:541` | `(transfer, status, update_parent)` | |
| `abort-downloads` | `downloads.py:889` | `(downloads: list, status)` | Batch form. |
| `clear-download` | `downloads.py:551` | `(transfer, update_parent)` | |
| `clear-downloads` | `downloads.py:915` | `(downloads, statuses, clear_deleted)` | |
| `folder-download-finished` | `downloads.py:465` | `(folder_path)` | Local destination path, not the remote path. |
| `folder-contents-response` | `NETWORK_MESSAGE_EVENTS[FolderContentsResponse]` | `(msg)` | `msg.username`, `msg.dir`, `msg.list: dict[folder → files]`. See §6. |
| `folder-contents-failed` | `downloads.py:799, 1029` | `(username, folder_path, is_offline=bool)` | |
| `download-large-folder` | `userbrowse.py:361` | `(username, folder_path, num_files, callback, callback_args)` | Confirmation hook for >1000 files; upstream expects you to call the callback to proceed. |
| `shared-file-list-response` | `NETWORK_MESSAGE_EVENTS[SharedFileListResponse]` | `(msg)` | User browse payload. See §6. |
| `shared-file-list-failed` | `userbrowse.py:143, 448` | `(username, is_offline=bool)` | |
| `shares-ready` / `shares-scanning` | `shares.py` | `()` / `()` | Our own share index state. |
| `log-message` | `logfacility.py` | `(timestamp, level, msg, title)` | Useful to forward at debug level. |
| `quit` | `core.py` | `()` | |

### Events the brief assumed but which do not exist

- There is **no `search-complete` event.** Soulseek has no completion signal — peers
  answer a broadcast whenever they feel like it, and stragglers arrive minutes later.
  Upstream's model is `search.remove_allowed_token(token)`, which makes the network
  thread *stop parsing* further responses for that token. So "complete" is a
  client-side decision, not a network fact. Seek's sidecar synthesises
  `search.closed` when it stops accepting, and reports `reason: "timeout" |
  "result_cap" | "stopped"`. The frontend must not wait for a server-side "done".
- There is **no `transfer.progress` / `transfer.state` split.** Upstream emits one
  event, `update-download`, for both. The sidecar does the splitting (§5).
- `file-download-progress` exists but is an *internal* network→core event
  (`username, token, bytes_left, speed`) keyed by transfer token, not by anything
  the frontend knows about. Consume `update-download` instead.

---

## 4. `FileSearchResponse` and file attributes — **the brief is wrong here**

### The message

`slskmessages.py:3436`. Per-response fields:

| Field | Type | Meaning |
|---|---|---|
| `msg.username` | str | The **connection-authenticated** peer name, assigned by `slskproto.py:719`. This is the one to trust. |
| `msg.search_username` | str | The username *inside the message payload*, i.e. self-reported by the peer. Present for historical reasons. Do not use it for identity. |
| `msg.token` | int | Search token. Set to `None` by `search.py:626/633/637/643/647` when the response is rejected (unknown token, ignored user, ignored IP, ignored wishlist user). |
| `msg.addr` | `(ip: str, port: int)` | Assigned by `slskproto.py:716`. |
| `msg.list` | list of file tuples | Public results. **`None` if the response was rejected before parsing.** |
| `msg.privatelist` | list of file tuples | Buddy-only results, often empty/absent. |
| `msg.freeulslots` | bool | Peer has a free upload slot right now. |
| `msg.ulspeed` | int | Peer's advertised average upload speed, bytes/sec. A **claim**, not a measurement. |
| `msg.inqueue` | int | Number of files queued on that peer. |

Note upstream's own normalisation in `gtkgui/search.py:942`: when `freeulslots` is
true it forces `inqueue = 0`, otherwise `inqueue = msg.inqueue or 1`. That is a
*display* decision; per the brief's "Python formats nothing", Seek's sidecar emits
`freeSlots` and `queueLength` raw and lets TypeScript decide.

### The file tuple

`_parse_result_list()` (line 3515) yields:

```python
(code, name, size, ext, attrs)
```

- `code` — uint8, always 1 in practice, meaningless.
- `name` — **full virtual path**, backslash-separated, `/` rewritten to `\`.
- `size` — uint64, with a documented workaround for the Soulseek NS >2 GiB bug
  (`unpack_file_size`, line 3209) where the top 4 bytes are garbage.
- `ext` — **always `None`.** The extension field is on the wire but upstream skips
  it as obsolete (`ext_len = self.unpack_uint32(); self._offset += ext_len`). Do not
  expect a format hint here; derive it from the filename.
- `attrs` — a `FileAttributes` **object** (not a dict) with slots
  `bitrate, length, vbr, sample_rate, bit_depth`.

### Correction 1 — attributes are two disjoint sets, not one

> The brief claims: *"Soulseek gives you only: username, full file path, file size,
> and — for audio — bitrate, duration, sample rate, bit depth, and a VBR flag."*

You do not get all of those for any single file. `FileListMessage.pack_file_info()`
(line 399) is explicit about the convention every client follows:

```python
is_lossless = bitdepth is not None

if is_lossless:
    # sends attr 1 (LENGTH), attr 4 (SAMPLE_RATE), attr 5 (BIT_DEPTH)
else:
    # sends attr 0 (BITRATE), attr 1 (LENGTH), attr 2 (VBR)
```

So in practice:

| | bitrate | duration | vbr | sample rate | bit depth |
|---|---|---|---|---|---|
| **Lossless** (FLAC/WAV/AIFF) | ✗ | ✓ | ✗ | ✓ | ✓ |
| **Lossy** (MP3/AAC/OGG) | ✓ | ✓ | ✓ | ✗ | ✗ |

And that is the *best* case. These are unauthenticated fields from arbitrary
third-party clients; every one of them can be absent (`None`) or a lie. Roughly:
Nicotine+ and SoulseekQt fill them in, older/odd clients often send zero attributes
at all.

**This directly changes the brief's §"The hard part" item 4.** The proposed
transcode check —

> `expectedSize ≈ bitrate × duration / 8` — a file advertising 320kbps whose size
> implies ~192 is an upscaled transcode

— **cannot run on lossless files, because lossless files carry no advertised
bitrate.** It is a lossy-only check. The correct treatment is two different checks:

- **Lossy:** compare `size × 8 / duration` (the *actual* bitrate implied by the
  bytes) against the advertised `bitrate`. If actual is materially below advertised,
  the claim is a lie. This is exactly the brief's intent, just computed in the
  honest direction.
- **Lossless:** there is nothing to contradict, so instead compare the file against
  what its *own* declared `sample_rate × bit_depth × 2 channels` would produce
  uncompressed. A "FLAC" whose bytes imply ~250 kbps is a transcode from lossy, but
  you infer that from implied-vs-uncompressed compression ratio, not from a
  contradicted claim. Lower confidence; flag it more quietly.
- **Neither:** if `duration` is missing (common), *no* check is possible. The UI
  must have an "unknown" state and must not silently render it as "clean".

The sidecar therefore emits raw `bitrate | null`, `duration | null`,
`sampleRate | null`, `bitDepth | null`, `isVbr | null` and computes nothing. The
arithmetic is the app agent's, in TypeScript, per the seam.

### Correction 2 — the ENCODER attribute is defined and silently discarded

`FileAttribute` (line 120) declares six indices:

```python
BITRATE = 0; LENGTH = 1; VBR = 2; ENCODER = 3; SAMPLE_RATE = 4; BIT_DEPTH = 5
```

But `unpack_file_attributes()` (line 3226) has branches for 0, 1, 2, 4, 5 — **not
3** — and `FileAttributes.__slots__` has no `encoder` field. Any encoder string a
peer sends is parsed off the wire and dropped on the floor.

This is worth knowing because encoder ID (`LAME 3.100`, etc.) would be *the* highest-
signal transcode tell, far better than size arithmetic. Recovering it would mean
patching `slskmessages.py`, which violates "keep upstream mergeable". **Not doing it.**
Recorded here as the one genuinely valuable thing we are leaving on the table; if it
ever becomes worth it, it is a 4-line upstream patch and would be a reasonable
upstream PR rather than a fork-local hack.

---

## 5. Transfers

`Transfer` (`transfers.py:47`) — the object handed to every download event:

| Field | Notes |
|---|---|
| `username`, `virtual_path` | Remote identity. |
| `folder_path` | **Local** destination folder. |
| `size`, `current_byte_offset` | `current_byte_offset` is `None` until transfer starts. |
| `status` | One of `TransferStatus` (§below). |
| `speed`, `avg_speed` | bytes/sec. `speed` is the instantaneous figure from the network thread; `avg_speed = transferred_bytes_total // elapsed`. Set in `_update_transfer_progress` (`transfers.py:436`). |
| `time_elapsed`, `time_left` | Seconds. `time_left = (size - offset) // speed`, 0 when speed is 0. |
| `queue_position` | Set from `PlaceInQueueResponse` (`downloads.py:1376`). 0 = unknown/not queued. |
| `file_attributes` | The same `FileAttributes` object from the search result, carried through. |
| `token` | Per-transfer network token — **changes across retries**, not a stable id. |

`TransferStatus` (`transfers.py:33`) is a closed set of 13 strings:
`Queued`, `Getting status`, `Transferring`, `Paused`, `Cancelled`, `Filtered`,
`Finished`, `User logged off`, `Connection closed`, `Connection timeout`,
`Download folder error`, `Local file error`.

**There is no stable transfer id.** `Transfers.transfers` is keyed by
`transfer.username + transfer.virtual_path` — bare string concatenation, no
separator (`transfers.py:396`). That is theoretically ambiguous (`"ab"+"c"` vs
`"a"+"bc"`) though harmless in practice since virtual paths always start with a
backslash-ish prefix. Seek does **not** adopt that key. The sidecar mints
`sha1(username + "\x00" + virtual_path)[:16]` as the wire `id` and keeps a
bidirectional map, so the frontend gets a stable opaque handle and the ambiguity
cannot leak.

Control API on `core.downloads`, all of which must be called on the main thread:

```python
enqueue_download(username, virtual_path, folder_path=None, size=0,
                 file_attributes=None, bypass_filter=False, paused=False)
retry_download(transfer, bypass_filter=False)
retry_downloads(downloads)
abort_downloads(downloads, status=TransferStatus.PAUSED)   # pause == abort(PAUSED)
clear_downloads(downloads=None, statuses=None, clear_deleted=False)
request_folder(username, folder_path)                      # fetches contents only
```

Notes that shape the protocol:

- **Pause and cancel are the same call**, differing only in `status` —
  `abort_downloads(x, PAUSED)` vs `abort_downloads(x, CANCELLED)`. Resume is
  `retry_download`.
- `enqueue_download` **silently returns** if `username + virtual_path` is already
  present. Duplicate enqueues are a no-op, not an error; the sidecar has to detect
  that itself and reply `alreadyQueued` rather than leaving the caller hanging.
- `request_folder()` only *fetches* folder contents; it does not enqueue anything.
  Folder download from a search result is therefore two-phase: `request_folder` →
  wait for `folder-contents-response` → `enqueue_download` per file. Upstream's GTK
  client does this in `gtkgui/dialogs/download.py`. The sidecar owns this
  orchestration so the app agent gets a single `transfer.enqueueFolder`.
- **Stall detection does not exist upstream.** No event, no timer, no status. The
  closest signals are `Connection timeout`/`Connection closed` statuses and the
  absence of `update-download` ticks. The sidecar implements stall detection itself:
  a transfer in `Transferring` whose `current_byte_offset` has not advanced for N
  seconds is reported as `stalled: true` on `transfer.progress`. This is a Seek
  invention and is labelled as such on the wire, not presented as upstream truth.

---

## 6. User browse and folder contents — two different tuple shapes

Both carry `(code, name, size, ext, attrs)`, but **`name` means different things**:

| Source | `list` shape | `name` is |
|---|---|---|
| `FileSearchResponse` | `list[(code, name, size, ext, attrs)]` | **full virtual path** |
| `SharedFileListResponse` (browse) | `list[(folder_path, list[file tuples])]` | **basename only** |
| `FolderContentsResponse` | `dict[folder_path → list[file tuples]]` | **basename only** |

Reconstructing a full path from the latter two is `"\\".join([folder_path, name])` —
exactly what `userbrowse.download_file` does at line 338. Conflating these is an easy
way to enqueue a nonexistent path, so the sidecar normalises all three into one
`FileRef` with an explicit full `path` before anything reaches the wire.

`core.userbrowse.browse_user(username, path=None, new_request=False, switch_page=True)`
is the entry point; results arrive on `shared-file-list-response`. Note it also calls
`core.users.watch_user(username, context="userbrowse")`, which means browsing a user
implicitly subscribes to their `user-status`/`user-stats` updates — free peer stats,
worth using.

---

## 7. Config and state — isolation works, and it is mandatory here

`Config.__init__` picks `~/.config/nicotine` (XDG) on macOS, or `~/.nicotine` if that
legacy folder exists. Two setters override it, and both are called *before*
`core.init_components()` (which is what calls `config.load_config()`):

```python
config.set_config_file("<path>/config")   # config.py:92
config.set_data_folder("<path>/data")     # config.py:95 — also sets $NICOTINE_DATA_HOME
```

This is the same mechanism upstream's own `--config` / `--user-data` flags use
(`__init__.py:91-98`), and upstream explicitly treats a custom config path as
permission to run a second instance (`multi_instance = True`). So running Seek
alongside Nicotine+ is a supported configuration, not a hack.

**[verified at runtime]** With the overrides applied, a full boot wrote only:

```
<scratch>/nconf/config
<scratch>/nconf/config.old
<scratch>/nconf/data/wishlist.json
<scratch>/nconf/data/downloads.json
<scratch>/nconf/data/uploads.json
```

**This is not hypothetical: the user has an existing Nicotine+ config at
`~/.config/nicotine/config`.** Its mtimes were unchanged by the test boot. Seek uses
`~/Library/Application Support/Seek/` and must never fall back to the default path —
a bug there would rewrite a real user's real settings. Treated as a hard invariant
in the sidecar, with the paths set before any `pynicotine` import that could touch
config.

`config.need_config()` is just `not login or not passw`. Seek supplies credentials
programmatically via `config.sections["server"]["login"]/["passw"]` before
`core.connect()`, so upstream's interactive `setup` event never fires.

Two things intentionally left alone: I did **not** read the user's existing
credentials out of `~/.config/nicotine/config`, and Seek should not silently import
them either. If reusing an existing Nicotine+ login is wanted, it should be an
explicit, visible "import settings from Nicotine+" action in Settings.

---

## 8. Threading contract (the thing most likely to cause a heisenbug)

```
┌─ main thread ──────────────────────────────────────────┐
│  while True:                                           │
│      events.process_thread_events()   # drains queue,  │
│      drain inbound command queue      # emits events   │
│      sleep(0.05)                                       │
└────────────────────────────────────────────────────────┘
        ▲                                    │
        │ events.emit_main_thread(...)       │ outbound queue
        │                                    ▼
┌─ NetworkThread ────────┐        ┌─ WebSocket thread (asyncio) ─┐
│  slskproto socket loop │        │  serve, auth, ndjson frames   │
└────────────────────────┘        └───────────────────────────────┘
┌─ SchedulerThread ──────┐
│  events.schedule(...)  │
└────────────────────────┘
```

Rules, all derived from the code rather than assumed:

1. `events.emit()` is main-thread only. `events.py:269` iterates callbacks
   synchronously with no lock.
2. Any exception raised inside a callback that is not from a loaded plugin causes
   `core.quit()` **and re-raises** (`events.py:275-284`). A single malformed payload
   in our event translation takes the whole core down. Every sidecar callback is
   therefore individually wrapped, logs, and never propagates.
3. Inbound WebSocket commands are pushed onto a `queue.SimpleQueue` and executed on
   the main thread. Calling `core.search.do_search()` from the asyncio thread would
   emit `add-search` off-thread and corrupt callback iteration.
4. Outbound events are pushed to the asyncio loop with
   `loop.call_soon_threadsafe()`.
5. The main loop's `sleep` is 0.05 s, not upstream's 0.1 s — the brief's budget is
   "first result on screen < 100 ms after it arrives from the sidecar", and a 100 ms
   pump alone would eat that entire budget.

---

## 9. Summary of corrections to `docs/PRODUCT.md`

| # | Brief says | Reality | Impact |
|---|---|---|---|
| 1 | You get "bitrate, duration, sample rate, bit depth, VBR" per audio file | Two **disjoint** attribute sets: lossless gets duration/sample-rate/bit-depth, lossy gets bitrate/duration/VBR. Any of them may be absent entirely. | **High.** Rewrites the transcode check (§4). |
| 2 | Transcode detection = `expectedSize ≈ bitrate × duration / 8` | Only valid for lossy. Lossless needs a different, weaker heuristic; files without duration admit no check at all and need an explicit "unknown" state. | **High.** This is the feature the brief calls the project's justification. |
| 3 | `← search.complete { searchId }` | No such network event exists. Completion is a client-side decision. | Medium — frontend must not block on it. |
| 4 | `← transfer.progress` and `← transfer.state` as separate streams | Upstream emits one `update-download` for both. Sidecar splits them. | Low — sidecar absorbs it. |
| 5 | `transfer.pause \| resume \| cancel \| retry { id }` implies a native id | No stable transfer id upstream; key is `username + virtual_path` concatenated without a separator. | Low — sidecar mints stable ids. |
| 6 | (unstated) | `FileAttribute.ENCODER = 3` is defined but never parsed; encoder strings are discarded. | Low, but it is the best transcode signal we're forgoing. |
| 7 | `docs/PRODUCT.md`: "git tag 3.3.10" | Actually master `d8f074574`, 1037 commits later, `3.4.0.dev1`. | Low, but the coordination doc should be corrected. |
| 8 | (unstated) | Stall detection has no upstream support at all. | Medium — Phase 3 item is entirely ours to build. |

Nothing here breaks the plan. No hacking around GTK was required, and `upstream/`
remains unmodified.

---

## 10. Addenda found while building the sidecar

Three things the initial read did not surface, all discovered by running the
code rather than reading it.

### `Shares` spawns a subprocess at startup, unconditionally

`Shares._start()` runs on the `start` event and always calls
`rescan_shares(init=True)` (`shares.py:800`), which builds a scanner with
`multiprocessing.get_context(method="spawn")` (`shares.py:1240`). Spawn
re-imports `__main__` in the child, so:

- The sidecar entry point must be a **real file** with an
  `if __name__ == "__main__"` guard. `python -c`, a heredoc, or a test runner as
  `__main__` all break — the child either dies with `FileNotFoundError` or, under
  pytest, tries to re-run the entire suite.
- Seek leaves the `shares` component **off by default**. That is mostly a product
  call (sharing exposes the user's filesystem, and there is no Settings UI yet to
  choose what), but note the real cost: Soulseek is reciprocal, and a client that
  shares nothing is deprioritised or banned by many peers. Needs a decision.

### Shutting down requires emitting `quit`, not just stopping the loop

`events._run_scheduler` loops on `while self._is_active`, and `_is_active` is
only cleared by the `quit` event. The scheduler thread is created **non-daemon**
(`events.py:386`). So a host that merely stops its own loop leaves the
interpreter hanging forever at exit, waiting on a thread that will never return.

Correct shutdown is `core.quit()` followed by pumping
`events.process_thread_events()` until it returns False. Upstream's headless
`run()` gets this for free because its loop condition *is* that call; anything
with its own exit condition has to do it explicitly.

### Callback registration order is load-bearing in a way that bites in tests

Already noted in §2, but worth restating with the concrete consequence:
`pynicotine.search._file_search_response` sets `msg.token = None` for any token
it does not recognise (`search.py:632`), and its handler runs first. A synthetic
`FileSearchResponse` emitted on the bus for a token upstream has never heard of
is therefore silently dropped before any downstream consumer sees it — which is
correct behaviour, and also means an integration test has to register the search
in `core.search.searches` for the message to survive the filter chain.

### Correction to §4: `impliedSourceKbps` is weaker than the textbook table

The cutoff→bitrate mapping in the standard transcode-detection literature
(128k ≈ 16 kHz, 320k ≈ 20.5 kHz) does not hold up against real encoder output on
broadband material. Measured on `libmp3lame` 8.1.2, encoding white noise and
re-encoding to FLAC:

| source | cutoff | drop | width | sharpness |
|---|---|---|---|---|
| MP3 128k → FLAC | 20,279 Hz | 99 dB | 770 Hz | 128 dB/kHz |
| MP3 192k → FLAC | 20,274 Hz | 98 dB | 694 Hz | 142 dB/kHz |
| MP3 320k → FLAC | 20,263 Hz | 98 dB | 495 Hz | 199 dB/kHz |
| genuine FLAC | none | — | — | — |

All three bitrates lowpass at essentially the same frequency. What *does*
separate them from genuine lossless is the **sharpness** of the shelf, not its
position — which is why `spectral.assess()` is sharpness-first. `impliedSourceKbps`
is retained as a hint but must not be presented as a measurement.

(White noise is a harder case than real music, which allocates bits differently
and does show more bitrate-dependent variation. The conclusion stands either
way: sharpness discriminates, frequency alone does not.)
