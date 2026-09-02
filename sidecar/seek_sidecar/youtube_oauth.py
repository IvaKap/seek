# Seek — signing in to Google, to read what an API key cannot.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# WHY THIS EXISTS
#
# A plain YouTube Data API key reads only PUBLIC data. A user's liked videos are
# the private `LL` playlist, and their own private playlists are private, and
# neither is reachable with a key — they need OAuth 2.0 user authorization with
# the `youtube.readonly` scope. This is the sign-in the YouTube tab offers as an
# optional layer on top of the key-only path.
#
# THE FLOW: OAuth 2.0 for installed apps — the loopback redirect with PKCE.
#   1. The sidecar opens the system browser to Google's consent screen, with a
#      redirect_uri of http://127.0.0.1:<ephemeral port> and a PKCE challenge.
#   2. Google, after the user consents, redirects the browser to that loopback,
#      where a transient one-request HTTP server catches the `?code=`.
#   3. The sidecar exchanges the code (plus the PKCE verifier) at Google's token
#      endpoint for a refresh token, which it keeps on its own side.
#
# A "Desktop app" OAuth client is what the user creates in Google Cloud. Google
# issues it a client secret and its own docs say that for an installed app the
# secret "is obviously not treated as a secret" — but Seek holds it like one
# anyway (never echoed across the socket). PKCE is what actually protects the
# exchange. Google auto-allows any 127.0.0.1 port for a Desktop client, so no
# per-port redirect registration is needed.
#
# Everything here is stdlib: urllib for the token POSTs, http.server for the
# loopback, webbrowser to open the consent page. No new dependency, same as the
# rest of the sidecar's outbound HTTP.

import base64
import hashlib
import http.server
import json
import logging
import os
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

from . import certs

log = logging.getLogger("seek.youtube.oauth")

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/youtube.readonly"

#: How long to wait for the user to finish consenting in their browser.
CONSENT_TIMEOUT = 300


class OAuthError(Exception):
    """A sign-in that could not complete. Message is developer-facing."""


def open_in_browser(url):
    """Open the consent page, robustly, from a frozen background process.

    `webbrowser.open` is the first try, but in a PyInstaller build with no
    controlling terminal it can pick a text browser or quietly do nothing, so
    the platform opener is the fallback that actually works — `open` on macOS,
    `xdg-open` on Linux, `os.startfile` on Windows. Returns True if any path
    reported success.
    """
    try:
        if webbrowser.open(url, new=2):
            return True
    except Exception:                                     # noqa: BLE001
        pass
    try:
        if sys.platform == "darwin":
            return subprocess.run(["/usr/bin/open", url], check=False).returncode == 0
        if sys.platform.startswith("win"):
            os.startfile(url)                             # noqa: S606 - platform opener
            return True
        return subprocess.run(["xdg-open", url], check=False).returncode == 0
    except Exception as error:                            # noqa: BLE001
        log.warning("could not open a browser: %s", error)
        return False


def _b64url(raw):
    """URL-safe base64 with no padding — the encoding PKCE and JWTs use."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def new_verifier():
    """A fresh PKCE code_verifier: 43-128 chars of unreserved characters."""
    return _b64url(os.urandom(64))


def challenge_for(verifier):
    """The S256 code_challenge for a verifier."""
    return _b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def auth_url(client_id, redirect_uri, challenge, state):
    """The Google consent URL to open in the browser.

    `access_type=offline` with `prompt=consent` is what makes Google return a
    refresh token — without the prompt it withholds one on every consent after
    the first, and a sign-in that yields no refresh token is a sign-in that
    forgets itself the moment the access token expires.
    """
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "access_type": "offline",
        "prompt": "consent",
    }
    return AUTH_URL + "?" + urllib.parse.urlencode(params)


def _post(url, params):
    """Form-POST to the token endpoint, returning parsed JSON.

    Google reports token errors as a non-200 with a JSON body naming the error;
    urlopen raises on those, so the body is read back and re-raised as an
    OAuthError with the reason rather than a bare HTTP code.
    """
    data = urllib.parse.urlencode(params).encode("ascii")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=certs.ssl_context()) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            body = json.loads(error.read().decode("utf-8", "replace"))
            detail = body.get("error_description") or body.get("error") or ""
        except Exception:                                 # noqa: BLE001
            detail = ""
        raise OAuthError(f"token endpoint {error.code}: {detail or 'refused'}") from error
    except urllib.error.URLError as error:
        raise OAuthError(f"could not reach Google: {error.reason}") from error


def exchange_code(client_id, client_secret, code, verifier, redirect_uri, post=_post):
    """Trade an authorization code for tokens. Returns the raw token payload."""
    payload = post(TOKEN_URL, {
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "code_verifier": verifier,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    })
    if not payload.get("refresh_token"):
        # Without prompt=consent Google withholds this; with it, absence means
        # something is wrong and a session that cannot refresh is not one to keep.
        raise OAuthError("Google returned no refresh token")
    return payload


def refresh_token(client_id, client_secret, refresh, post=_post):
    """Trade a refresh token for a fresh access token."""
    payload = post(TOKEN_URL, {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh,
        "grant_type": "refresh_token",
    })
    if not payload.get("access_token"):
        raise OAuthError("Google returned no access token on refresh")
    return payload


def _loopback_server(host="127.0.0.1"):
    """A one-shot HTTP server that captures the OAuth redirect's query.

    Returns (server, result) where `result` is a dict the handler fills with
    `code`/`state` or `error` on the first real request. Binds an ephemeral
    port on loopback only, so nothing off the machine can reach it.
    """
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):                                 # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/favicon.ico":
                self.send_response(404)
                self.end_headers()
                return
            query = urllib.parse.parse_qs(parsed.query)
            result["code"] = (query.get("code") or [""])[0]
            result["state"] = (query.get("state") or [""])[0]
            result["error"] = (query.get("error") or [""])[0]
            body = (b"<!doctype html><meta charset=utf-8>"
                    b"<body style='font:15px system-ui;padding:3rem;color:#333'>"
                    b"<h2>Signed in to Seek.</h2>"
                    b"<p>You can close this tab and return to the app.</p>")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):                    # silence the default stderr spam
            pass

    server = http.server.HTTPServer((host, 0), Handler)
    return server, result


def run_loopback(client_id, client_secret, *, open_browser=open_in_browser,
                 post=_post, timeout=CONSENT_TIMEOUT, host="127.0.0.1"):
    """The whole sign-in: consent in the browser, then exchange the code.

    `open_browser` and `post` are injectable so the flow can be driven in a test
    without a real browser or a real Google. Returns the token payload
    (refresh_token, access_token, expires_in).
    """
    if not client_id or not client_secret:
        raise OAuthError("a Google OAuth client id and secret are required")

    verifier = new_verifier()
    state = secrets.token_urlsafe(24)
    server, result = _loopback_server(host)
    try:
        port = server.server_address[1]
        redirect_uri = f"http://{host}:{port}"
        opened = open_browser(auth_url(client_id, redirect_uri, challenge_for(verifier), state))
        if opened is False:
            raise OAuthError("could not open a browser for the Google sign-in")

        # Serve exactly one meaningful request, or give up. handle_request obeys
        # the socket timeout, so this loop cannot outlive the deadline.
        server.timeout = 1
        deadline = time.monotonic() + timeout
        while not result and time.monotonic() < deadline:
            server.handle_request()
        # A favicon hit leaves result empty; keep serving until code/error/state.
        while not (result.get("code") or result.get("error")) and time.monotonic() < deadline:
            server.handle_request()
    finally:
        server.server_close()

    if result.get("error"):
        raise OAuthError(f"Google refused: {result['error']}")
    if not result.get("code"):
        raise OAuthError("timed out waiting for the Google sign-in")
    if result.get("state") != state:
        # A redirect whose state does not match the one we sent is not our flow.
        raise OAuthError("sign-in state did not match; ignored")

    return exchange_code(client_id, client_secret, result["code"], verifier,
                         redirect_uri, post=post)
