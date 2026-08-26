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
use std::sync::Mutex;

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

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar produced no stdout".to_string())?;

    // `--print-endpoint` writes exactly one line and then goes quiet, so a
    // blocking read of the first line is the whole handshake.
    let mut line = String::new();
    let mut reader = BufReader::new(stdout);
    reader
        .read_line(&mut line)
        .map_err(|e| format!("could not read the sidecar endpoint: {e}"))?;

    if line.trim().is_empty() {
        let _ = child.kill();
        return Err("the sidecar exited before reporting an endpoint".into());
    }

    let endpoint: Endpoint = serde_json::from_str(line.trim())
        .map_err(|e| format!("could not parse the sidecar endpoint {line:?}: {e}"))?;

    Ok((child, endpoint))
}

/// The frontend asks for this on mount. Returning `Ok(None)` means "no sidecar,
/// stay on recorded data" — a normal state, not an error.
#[tauri::command]
fn sidecar_endpoint(state: tauri::State<'_, Option<Endpoint>>) -> Option<Endpoint> {
    let value = state.inner().clone();
    eprintln!("seek: sidecar_endpoint invoked -> {}",
              if value.is_some() { "Some" } else { "None" });
    value
}

/// Surfaced in the UI when the sidecar could not be started, so the failure is
/// explained rather than appearing as a silently offline app.
#[tauri::command]
fn sidecar_error(state: tauri::State<'_, Option<String>>) -> Option<String> {
    state.inner().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (child, endpoint, error) = match spawn_sidecar() {
        Ok((child, endpoint)) => (Some(child), Some(endpoint), None),
        Err(message) => {
            eprintln!("seek: {message}");
            (None, None, Some(message))
        }
    };

    tauri::Builder::default()
        // Native notifications for finished and failed downloads. macOS only
        // shows these when the app is in the background, which is exactly when
        // they are wanted.
        .plugin(tauri_plugin_notification::init())
        // The native folder chooser, for the download and shared folders. The
        // settings screen falls back to a plain path field when this is absent
        // — it has to, because the browser recipe in CLAUDE.md runs the same
        // frontend with no Tauri shell under it at all.
        .plugin(tauri_plugin_dialog::init())
        .manage(endpoint.clone())
        .manage(error)
        .manage(Sidecar(Mutex::new(child)))
        .invoke_handler(tauri::generate_handler![sidecar_endpoint, sidecar_error])
        .setup(move |app| {
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
            if let Some(endpoint) = endpoint.clone() {
                if let Ok(json) = serde_json::to_string(&endpoint) {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval(&format!("window.__SEEK_SIDECAR__={json};"));
                    }
                }
                let _ = app.emit("sidecar-ready", endpoint);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Seek")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Sidecar>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.as_mut() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
