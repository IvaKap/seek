# sidecar/

Python sidecar: runs the Nicotine+ core headless and bridges it to the app over
a localhost WebSocket carrying newline-delimited JSON.

`upstream/` is **not modified**. Everything here works through pynicotine's
public event bus and the public methods on `core.*`, so upstream stays
trivially mergeable.

## Running

```bash
python -m seek_sidecar --token <secret> --print-endpoint
```

`--print-endpoint` writes `{"host","port","token"}` as JSON on stdout once
listening — that is how the Tauri shell learns where to connect. Omit `--token`
and one is generated (or read from `$SEEK_TOKEN`).

Config and data default to `~/Library/Application Support/Seek/`, never the
user's own Nicotine+ folder.

| Flag | Default | Note |
|---|---|---|
| `--host` | `127.0.0.1` | Non-loopback addresses are **refused**, not warned about |
| `--port` | `0` | 0 picks a free port |
| `--app-folder` | `~/Library/Application Support/Seek` | |
| `--enable-shares` | off | See "Shares" below — this is a product decision |

## Setup

```bash
python3.11 -m venv .venv          # upstream requires >= 3.10; system Python is 3.9
.venv/bin/pip install -r requirements-dev.txt
PYTHONPATH=../upstream:. .venv/bin/python -m pytest tests/ -q
```

## Layout

| File | Role |
|---|---|
| `protocol.py` | **Generated** from `shared/schema.py`. Never hand-edit. TypedDicts + a runtime validator. |
| `core_host.py` | Boots pynicotine, owns the main-thread pump, dispatches commands, translates events. |
| `translate.py` | Pure functions: upstream objects → wire structs. The only module that knows both shapes. |
| `registries.py` | Search batching / caps / close reasons; stable transfer ids; stall detection. No pynicotine imports. |
| `server.py` | Asyncio WebSocket server, auth, framing. Runs on its own thread. |
| `spectral.py` | Post-download decode → FFT → lowpass detection. |
| `__main__.py` | Entry point. Must stay a real file (see "Shares"). |

## Threading

```
main thread            pynicotine event bus, command execution, the pump (20 Hz)
SeekBridge             asyncio WebSocket server
NetworkThread          upstream's socket loop
SchedulerThread        upstream's timers
SeekSpectral           one worker, decode + FFT
```

Three rules, all derived from reading upstream rather than assumed:

1. **`events.emit()` is main-thread only.** It iterates callbacks synchronously
   with no lock. Inbound commands are queued and executed on the main thread;
   they are never run from the socket thread.
2. **A callback must never raise.** `events.emit` treats any exception from a
   non-plugin callback as fatal — it calls `core.quit()` and re-raises
   (`events.py:275`). Every sidecar callback is individually wrapped.
   `bridge.broadcast()` drops invalid payloads rather than raising for the same
   reason.
3. **Shutdown must emit `quit`.** The scheduler runs on a *non-daemon* thread
   whose loop is `while self._is_active`, and only the `quit` event clears that
   flag. Setting a local flag and returning leaves the interpreter hanging at
   exit. `CoreHost.shutdown()` does this properly and is idempotent.

## Security

The socket can enqueue downloads and rewrite settings, so it is not a debug
endpoint.

- **Loopback only.** `Bridge` raises on any non-loopback bind address.
- **Token required**, compared with `hmac.compare_digest`. Supply it as
  `Authorization: Bearer` (preferred — query strings end up in logs) or
  `?token=`.
- **Origin header rejected.** A desktop client sends none; a browser always
  does. Any page the user has open can reach `ws://127.0.0.1`, so this blocks
  drive-by connections even if the token leaked.
- Frames are size-capped at 4 MiB before parsing.
- Commands are schema-validated on the socket thread, so a malformed one never
  reaches pynicotine.

## Shares

**Off by default**, and that is a product decision as much as a technical one.

Technically, `Shares._start()` unconditionally calls `rescan_shares(init=True)`,
which spawns a subprocess using multiprocessing's *spawn* method
(`shares.py:1240`). Spawn re-imports `__main__` in the child, which is why the
entry point must stay a real file with an `if __name__ == "__main__"` guard.

The real reason is that enabling shares exposes the user's filesystem to the
Soulseek network, and Seek has no Settings UI yet where the user chooses what to
share. **There is a genuine cost to leaving it off:** Soulseek is a reciprocal
network, and a client that shares nothing gets deprioritised or banned by many
peers. This needs a deliberate decision before Seek is used for real.

## Components deliberately not enabled

- `update_checker` — calls `pypi.org` on start. The brief says no telemetry.
- `now_playing` — the only D-Bus/GTK surface in the core.
- `portmapper` — UPnP/NAT-PMP; should be a user setting, not a startup default.
- `cli` / `signal_handler` / `error_handler` — the sidecar owns its lifecycle.

## Protocol

`shared/schema.py` is the single source of truth. Both `shared/protocol.ts` and
`seek_sidecar/protocol.py` are generated from it:

```bash
python3 shared/generate_protocol.py           # write both
python3 shared/generate_protocol.py --check   # fail if either is stale
```

`tests/test_protocol_sync.py` runs `--check`, so the two sides of the seam
cannot drift.
