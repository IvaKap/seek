// Seek — Tauri shell.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The window uses the REAL macOS material, not a CSS approximation. Tauri v2's
// `windowEffects` maps onto NSVisualEffectView, so the sidebar picks up genuine
// desktop-sampling vibrancy that `backdrop-filter` cannot reproduce — CSS can
// only blur what is inside the web page, never what is behind the window.
//
// `backdrop-filter` is still used, but only for in-content layers (popovers,
// the search header) where the thing being blurred really is page content.
//
// This file also owns the sidecar's lifetime. The Python process is started
// here, its endpoint is read from its stdout, and it is killed when the app
// exits — an orphaned sidecar holds a Soulseek connection and a port, and the
// next launch would pick a different port and leave the old one running.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub token: String,
}

/// Kept so the child can be killed on exit. `Drop` is not enough — the app can
/// be terminated in ways that never unwind — so `RunEvent::Exit` kills it too.
struct Sidecar(Mutex<Option<Child>>);

/// Where the sidecar is NOW. A restarted sidecar has a new port and token, and
/// a page that reloads after that asks `sidecar_endpoint` for it.
struct CurrentEndpoint(Mutex<Option<Endpoint>>);

/// Why there is no sidecar, when there is none.
struct StartupError(Mutex<Option<String>>);

/// Set once the app is quitting, so the supervisor never restarts a sidecar
/// that `stop_sidecar` is deliberately stopping.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// The pid of a sidecar that has been spawned but not yet handed to `Sidecar`
/// (it is still printing its endpoint). Quitting in that window would otherwise
/// leave it running, holding the Soulseek login, after the app is gone.
static STARTING: AtomicU32 = AtomicU32::new(0);

/// At most this many restarts inside `RESTART_WINDOW`. A sidecar that dies on
/// every start (a corrupt state file, a broken build) would otherwise be
/// restarted for ever, each time signing in to Soulseek again.
const RESTART_LIMIT: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(300);

/// The frozen sidecar carried inside the bundle, if there is one.
///
/// A packaged build ships a PyInstaller one-dir build at
/// `Seek.app/Contents/Resources/sidecar/seek-sidecar/`. Resolving it from the
/// executable rather than through Tauri's resource API keeps this callable
/// before the app handle exists, which is when the sidecar has to start.
fn bundled_sidecar() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // Contents/MacOS/seek -> Contents/Resources/sidecar/seek-sidecar
    //
    // Tauri copies the CONTENTS of a mapped resource directory, not the
    // directory itself, so the binary sits beside `_internal` rather than in a
    // nested folder of its own.
    let candidate = exe
        .parent()?
        .parent()?
        .join("Resources/sidecar/seek-sidecar");
    candidate.exists().then_some(candidate)
}

/// Run the frozen binary. Self-contained: its own Python, pynicotine, numpy,
/// libsndfile and mutagen are all inside it, so this works on a machine that
/// has never seen the repository.
fn frozen_command(binary: &std::path::Path) -> Command {
    let mut cmd = Command::new(binary);
    cmd.arg("--print-endpoint");
    common_args(&mut cmd);
    cmd
}

/// Development fallback: the repo's virtualenv. Not redistributable — the .app
/// only works where that venv exists — but it is what `tauri dev` and a
/// source checkout use, and it avoids re-freezing on every code change.
fn sidecar_command(repo: &std::path::Path) -> Command {
    let mut cmd = Command::new(repo.join("sidecar/.venv/bin/python"));
    cmd.arg("-m")
        .arg("seek_sidecar")
        .arg("--print-endpoint")
        // The webview DOES send an Origin, contrary to the assumption the
        // sidecar was written with — WKWebView reports `tauri://localhost` for
        // a bundled app. Without this the sidecar 403s its own frontend and
        // retries forever, which presents as a permanently offline app.
        .arg("--allow-origin")
        .arg("tauri://localhost")
        .current_dir(repo.join("sidecar"))
        .env("PYTHONPATH", format!("{}:.", repo.join("upstream").display()));
    common_args(&mut cmd);
    cmd
}

/// Everything both paths need. Kept in one place so the frozen build and the
/// dev build cannot drift on the arguments that matter — particularly the
/// allowed origin, where a mismatch presents as a permanently offline app with
/// no error anywhere.
fn common_args(cmd: &mut Command) {
    cmd
        // The webview DOES send an Origin, contrary to the assumption the
        // sidecar was written with — WKWebView reports `tauri://localhost` for
        // a bundled app. Without this the sidecar 403s its own frontend and
        // retries forever.
        .arg("--allow-origin")
        .arg("tauri://localhost")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    // `tauri dev` loads the page from the Vite server, so the origin is that
    // server's, not tauri://. Debug builds only — a release build must never
    // trust a localhost web origin.
    #[cfg(debug_assertions)]
    cmd.arg("--allow-origin").arg("http://localhost:5273");
}

/// Walk up from the executable to find the repo. In `tauri dev` the binary sits
/// in `app/src-tauri/target/debug/`; in a bundle it is inside `Seek.app`. Both
/// are located by looking for the marker directories rather than by counting
/// `..`s, which silently breaks whenever the layout changes.
fn find_repo() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    for _ in 0..8 {
        if dir.join("sidecar/.venv/bin/python").exists() && dir.join("upstream").is_dir() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// Start the sidecar and read the one JSON line it prints once it is listening.
fn spawn_sidecar() -> Result<(Child, Endpoint), String> {
    // Prefer the frozen binary. A packaged app has one; a source checkout does
    // not, and falls back to the virtualenv so development needs no re-freeze.
    let mut command = match bundled_sidecar() {
        Some(binary) => frozen_command(&binary),
        None => {
            let repo = find_repo().ok_or_else(|| {
                "no bundled sidecar, and could not locate the Seek repository \
                 (looked for sidecar/.venv and upstream/)"
                    .to_string()
            })?;
            sidecar_command(&repo)
        }
    };

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start the sidecar: {e}"))?;
    STARTING.store(child.id(), Ordering::SeqCst);
    // Quit began between the supervisor's check and the store above: the
    // exit handler may already have looked for a starting pid and found none.
    if QUITTING.load(Ordering::SeqCst) {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Seek is quitting".into());
    }

    match read_endpoint(&mut child) {
        Ok(endpoint) => Ok((child, endpoint)),
        Err(message) => {
            // Child does not stop on drop: without this a sidecar that printed
            // something unexpected kept running with nothing watching it.
            let _ = child.kill();
            let _ = child.wait();
            Err(message)
        }
    }
}

/// `--print-endpoint` writes exactly one line and then goes quiet, so a
/// blocking read of the first line is the whole handshake.
fn read_endpoint(child: &mut Child) -> Result<Endpoint, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar produced no stdout".to_string())?;
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .map_err(|e| format!("could not read the sidecar endpoint: {e}"))?;
    if line.trim().is_empty() {
        return Err("the sidecar exited before reporting an endpoint".into());
    }
    serde_json::from_str(line.trim())
        .map_err(|e| format!("could not parse the sidecar endpoint {line:?}: {e}"))
}

/// Start the sidecar, then forget it was starting — whoever called this now
/// owns the child and stops it on exit.
fn start_sidecar() -> Result<(Child, Endpoint), String> {
    let result = spawn_sidecar();
    STARTING.store(0, Ordering::SeqCst);
    result
}

/// How long a quitting sidecar gets to save before it is killed. Its own
/// shutdown pumps the core for at most 5 s (`CoreHost.shutdown`), so this
/// covers that with a little to spare.
const SIDECAR_STOP_GRACE: Duration = Duration::from_secs(6);

/// Ask the sidecar to shut down, and kill it only if it will not.
///
/// This used to be `child.kill()`, which is SIGKILL — and SIGKILL skips the
/// sidecar's SIGTERM handler, which is what runs `core.quit()`. Upstream saves
/// the transfer list on quit and otherwise only every 180 s
/// (`transfers.py:129`), so every quit threw away whatever had been queued in
/// the last three minutes: the downloads, and the queue places with them.
fn stop_sidecar(child: &mut Child) {
    #[cfg(unix)]
    {
        // SAFETY: `kill` with a pid we spawned and still own (it has not been
        // waited on, so the pid cannot have been reused) and a valid signal.
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        let deadline = Instant::now() + SIDECAR_STOP_GRACE;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The frontend asks for this on mount. Returning `Ok(None)` means "no sidecar,
/// stay on recorded data" — a normal state, not an error.
#[tauri::command]
fn sidecar_endpoint(state: tauri::State<'_, CurrentEndpoint>) -> Option<Endpoint> {
    let value = state.0.lock().ok().and_then(|guard| guard.clone());
    eprintln!("seek: sidecar_endpoint invoked -> {}",
              if value.is_some() { "Some" } else { "None" });
    value
}

/// Surfaced in the UI when the sidecar could not be started, so the failure is
/// explained rather than appearing as a silently offline app.
#[tauri::command]
fn sidecar_error(state: tauri::State<'_, StartupError>) -> Option<String> {
    state.0.lock().ok().and_then(|guard| guard.clone())
}

/// Tell the page about a new sidecar, the same way the first one was: a window
/// global, plus a DOM event so a page that is already running swaps over.
fn announce_endpoint(app: &tauri::AppHandle, endpoint: &Endpoint) {
    if let (Ok(json), Some(window)) =
        (serde_json::to_string(endpoint), app.get_webview_window("main"))
    {
        let _ = window.eval(&format!(
            "window.__SEEK_SIDECAR__={json};\
             window.dispatchEvent(new CustomEvent('seek-sidecar-restarted'));"
        ));
    }
}

fn announce_failure(app: &tauri::AppHandle, message: &str) {
    eprintln!("seek: {message}");
    if let Ok(mut guard) = app.state::<StartupError>().0.lock() {
        *guard = Some(message.to_string());
    }
    // A page that reloads now must not be handed the dead sidecar's address.
    if let Ok(mut guard) = app.state::<CurrentEndpoint>().0.lock() {
        *guard = None;
    }
    if let (Ok(json), Some(window)) =
        (serde_json::to_string(message), app.get_webview_window("main"))
    {
        let _ = window.eval(&format!(
            "window.dispatchEvent(new CustomEvent('seek-sidecar-failed',{{detail:{json}}}));"
        ));
    }
}

/// Restart the sidecar when it dies.
///
/// Before this, a crashed sidecar left the app retrying a port nobody was
/// listening on, every 8 s, until it was quit and reopened.
///
/// Only an ABNORMAL exit is restarted. A sidecar exits 0 when it is asked to —
/// SIGTERM runs its shutdown — and the one thing that asks, besides this file,
/// is a second sidecar taking over (`singleton.py`). Restarting that one would
/// evict the newcomer, which would restart and evict this one, for ever.
fn supervise(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut restarts: Vec<Instant> = Vec::new();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            let sidecar = app.state::<Sidecar>();
            let status = {
                let Ok(mut guard) = sidecar.0.lock() else { return };
                match guard.as_mut().map(|child| child.try_wait()) {
                    Some(Ok(None)) => continue,
                    Some(Ok(Some(status))) => {
                        *guard = None;
                        status
                    }
                    // No child, or the OS will not say: nothing to watch.
                    _ => return,
                }
            };
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            if status.success() {
                announce_failure(
                    &app,
                    "The engine was stopped from outside Seek. Quit and reopen Seek to start it again.",
                );
                return;
            }
            restarts.retain(|at| at.elapsed() < RESTART_WINDOW);
            if restarts.len() >= RESTART_LIMIT {
                announce_failure(
                    &app,
                    &format!("The engine keeps stopping ({status}). Quit and reopen Seek."),
                );
                return;
            }
            restarts.push(Instant::now());
            eprintln!("seek: the sidecar exited ({status}); restarting it");
            match start_sidecar() {
                Ok((mut child, endpoint)) => {
                    let Ok(mut guard) = sidecar.0.lock() else { return };
                    // Quit began while it was starting: stop it here, or it
                    // outlives the app holding the Soulseek login.
                    if QUITTING.load(Ordering::SeqCst) {
                        stop_sidecar(&mut child);
                        return;
                    }
                    *guard = Some(child);
                    drop(guard);
                    if let Ok(mut current) = app.state::<CurrentEndpoint>().0.lock() {
                        *current = Some(endpoint.clone());
                    }
                    announce_endpoint(&app, &endpoint);
                }
                Err(message) => {
                    announce_failure(&app, &message);
                    return;
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // One Seek at a time: a second launch focuses this window and exits.
    // Registered first, and the sidecar is started in `setup` rather than
    // before the builder, so a second copy quits before it starts an engine —
    // whose singleton guard would otherwise evict this one's.
    //
    // Release builds only. `tauri dev` shares the bundle's identifier, so with
    // Seek.app open a dev build would find its socket and exit at once, with
    // no window and no error.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        // ⌘W has to reach the WEBVIEW, and by default it never does.
        //
        // Tauri installs the standard macOS menu, whose Window → Close owns
        // ⌘W — so the key is swallowed by AppKit before any JavaScript sees it,
        // and pressing it closed the whole app while the frontend's handler sat
        // there doing nothing. No amount of `preventDefault` can win that; the
        // menu item itself has to go.
        //
        // So: the default menu, minus that one item. Everything else is kept
        // deliberately — removing the menu wholesale would take Edit → Copy and
        // Paste with it, and a Soulseek client where ⌘C does nothing is a far
        // worse bug than the one being fixed.
        //
        // The frontend then decides what ⌘W means: close the tab, or, when
        // there is only one left, let the window close — which is Safari's
        // behaviour and the one the muscle memory expects.
        .menu(|handle| {
            let menu = tauri::menu::Menu::default(handle)?;
            // Found by ID and POSITION, never by title. Tauri builds the Window
            // submenu as [minimize, maximize, separator, close_window], so the
            // close item is its last entry — and matching on the string "Close"
            // would quietly stop working for anyone running macOS in another
            // language, which is the kind of bug nobody here would ever see.
            if let Some(item) = menu.get(tauri::menu::WINDOW_SUBMENU_ID) {
                if let Some(window_menu) = item.as_submenu() {
                    let last = window_menu.items()?.len().saturating_sub(1);
                    window_menu.remove_at(last)?;
                }
            }
            Ok(menu)
        })
        // Native notifications for finished and failed downloads. macOS only
        // shows these when the app is in the background, which is exactly when
        // they are wanted.
        .plugin(tauri_plugin_notification::init())
        // The native folder chooser, for the download and shared folders. The
        // settings screen falls back to a plain path field when this is absent
        // — it has to, because the browser recipe in CLAUDE.md runs the same
        // frontend with no Tauri shell under it at all.
        .plugin(tauri_plugin_dialog::init())
        // Self-update. The reason this earns its place: the Open Anyway
        // approval macOS records lives in the quarantine attribute of one
        // specific bundle, so a hand-installed update repeats the whole dance
        // every time. A download the app makes itself is never quarantined —
        // verified — so after the first install, updates are silent.
        //
        // Nothing is installed without being asked. The plugin only fetches and
        // verifies; the frontend decides when to say so and the user decides
        // whether to restart.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Only for relaunching into the version just installed. An update
        // that needs the user to quit and reopen by hand is most of the
        // friction the updater exists to remove.
        .plugin(tauri_plugin_process::init())
        // Copy diagnostics, and the right-click Copy items. NOT a convenience
        // over `navigator.clipboard`: that API is UNDEFINED in the shipped app
        // and present in dev, which is how it shipped broken. It is gated on a
        // secure context, and a bundle runs at `tauri://localhost` — a custom
        // scheme, which WKWebView does not treat as one — while `npm run tauri
        // dev` runs at `http://localhost:5273`, which it does. So the bug is
        // invisible to every test that does not drive a real bundle.
        //
        // The same call is refused for a second, independent reason: WebKit
        // requires live user activation for a clipboard write, and Copy
        // diagnostics awaits the engine before writing. Both problems belong to
        // the webview; this plugin writes from Rust and has neither.
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![sidecar_endpoint, sidecar_error])
        .setup(|app| {
            let (child, endpoint, error) = match start_sidecar() {
                Ok((child, endpoint)) => (Some(child), Some(endpoint), None),
                Err(message) => {
                    eprintln!("seek: {message}");
                    (None, None, Some(message))
                }
            };
            app.manage(CurrentEndpoint(Mutex::new(endpoint.clone())));
            app.manage(StartupError(Mutex::new(error)));
            app.manage(Sidecar(Mutex::new(child)));

            // Inject the endpoint straight into the page.
            //
            // This is deliberately NOT done over IPC. `invoke` depends on the
            // capability system, runs asynchronously, and fails in ways the
            // frontend can only discover after mounting — so a misconfigured
            // shell looks identical to "no sidecar", and the app appears to
            // work while silently serving recorded data. A window global set
            // before any page script runs has none of those failure modes.
            //
            // `sidecar_endpoint` remains as a fallback for a window created
            // after startup.
            if let Some(endpoint) = endpoint {
                if let Ok(json) = serde_json::to_string(&endpoint) {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval(&format!("window.__SEEK_SIDECAR__={json};"));
                    }
                }
                let _ = app.emit("sidecar-ready", endpoint);
                supervise(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Seek")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                QUITTING.store(true, Ordering::SeqCst);
                #[cfg(unix)]
                {
                    let starting = STARTING.swap(0, Ordering::SeqCst);
                    if starting != 0 {
                        // SAFETY: a pid we spawned and have not waited on.
                        unsafe {
                            libc::kill(starting as libc::pid_t, libc::SIGTERM);
                        }
                    }
                }
                if let Some(state) = app.try_state::<Sidecar>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.as_mut() {
                            stop_sidecar(child);
                        }
                    }
                }
            }
        });
}
