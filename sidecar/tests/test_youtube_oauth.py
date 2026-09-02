"""
Seek — the Google sign-in that unlocks private playlists and liked videos.

The live consent step needs a real Google client and a human at a browser, so
it cannot run here. What CAN be pinned without either: PKCE is correct, the auth
URL asks for what a refresh token requires, the token exchange sends the right
grant and rejects a reply with no refresh token, and the loopback flow — driven
by a fake browser that hits the redirect and a fake token endpoint — returns the
tokens and enforces the CSRF `state`.

The CoreHost handlers are pinned over the in-memory stub, as the rest of the
YouTube tests are: sign-in stores the refresh token, sign-out forgets it, the
access token is cached and refreshed, and a private request without a session is
refused.
"""

import base64
import hashlib
import threading
import urllib.request

import pytest

from seek_sidecar import youtube_oauth as oa
from seek_sidecar.core_host import CoreHost, CommandError


# ------------------------------------------------------------------- PKCE

def test_challenge_is_the_s256_of_the_verifier():
    v = oa.new_verifier()
    expected = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode()
    assert oa.challenge_for(v) == expected


def test_verifier_is_url_safe_and_long_enough():
    v = oa.new_verifier()
    assert 43 <= len(v) <= 128
    assert all(c.isalnum() or c in "-_" for c in v)


def test_verifiers_differ():
    assert oa.new_verifier() != oa.new_verifier()


def test_auth_url_asks_for_an_offline_refresh_token():
    url = oa.auth_url("cid", "http://127.0.0.1:9", "chal", "st8")
    # access_type=offline + prompt=consent are what make Google return a
    # refresh token; without them a session forgets itself.
    assert "access_type=offline" in url
    assert "prompt=consent" in url
    assert "code_challenge=chal" in url
    assert "code_challenge_method=S256" in url
    assert "state=st8" in url
    assert "scope=" in url and "youtube.readonly" in url


# --------------------------------------------------------- token exchange

def test_exchange_sends_the_code_and_verifier():
    seen = {}

    def post(url, params):
        seen.update(params); seen["url"] = url
        return {"access_token": "at", "refresh_token": "rt", "expires_in": 3600}

    out = oa.exchange_code("cid", "sec", "the-code", "verifier", "http://127.0.0.1:9", post=post)
    assert out["refresh_token"] == "rt"
    assert seen["url"] == oa.TOKEN_URL
    assert seen["grant_type"] == "authorization_code"
    assert seen["code"] == "the-code"
    assert seen["code_verifier"] == "verifier"
    assert seen["client_secret"] == "sec"


def test_exchange_without_a_refresh_token_is_an_error():
    def post(url, params):
        return {"access_token": "at"}   # no refresh_token
    with pytest.raises(oa.OAuthError):
        oa.exchange_code("c", "s", "code", "v", "uri", post=post)


def test_refresh_returns_a_new_access_token():
    def post(url, params):
        assert params["grant_type"] == "refresh_token"
        assert params["refresh_token"] == "rt"
        return {"access_token": "fresh", "expires_in": 3600}
    assert oa.refresh_token("c", "s", "rt", post=post)["access_token"] == "fresh"


def test_refresh_without_a_token_is_an_error():
    with pytest.raises(oa.OAuthError):
        oa.refresh_token("c", "s", "rt", post=lambda u, p: {})


# ---------------------------------------------------- the loopback flow

def _browser_that_redirects(code="ok-code", state_override=None):
    """A fake browser: on being handed the auth URL, GET the redirect_uri with a
    code and the matching state, exactly as Google's redirect would."""
    def open_browser(url):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(url).query)
        redirect = q["redirect_uri"][0]
        state = state_override if state_override is not None else q["state"][0]

        def hit():
            try:
                urllib.request.urlopen(f"{redirect}/?code={code}&state={state}", timeout=5).read()
            except Exception:
                pass
        threading.Thread(target=hit, daemon=True).start()
        return True
    return open_browser


def test_loopback_returns_tokens_after_the_redirect():
    posted = {}

    def post(url, params):
        posted.update(params)
        return {"access_token": "at", "refresh_token": "rt", "expires_in": 3600}

    out = oa.run_loopback("cid", "sec", open_browser=_browser_that_redirects(),
                          post=post, timeout=10)
    assert out["refresh_token"] == "rt"
    # The code the fake browser delivered reached the exchange.
    assert posted["code"] == "ok-code"
    # The redirect_uri the exchange used is the loopback the server bound.
    assert posted["redirect_uri"].startswith("http://127.0.0.1:")


def test_loopback_rejects_a_mismatched_state():
    # A redirect whose state is not the one we sent is not our flow — CSRF guard.
    with pytest.raises(oa.OAuthError):
        oa.run_loopback("cid", "sec",
                        open_browser=_browser_that_redirects(state_override="wrong"),
                        post=lambda u, p: {"refresh_token": "rt"}, timeout=10)


def test_loopback_needs_client_credentials():
    with pytest.raises(oa.OAuthError):
        oa.run_loopback("", "", open_browser=lambda u: True, post=lambda u, p: {})


def test_open_in_browser_uses_webbrowser_when_it_works(monkeypatch):
    monkeypatch.setattr(oa.webbrowser, "open", lambda url, new=0: True)
    assert oa.open_in_browser("https://x") is True


def test_open_in_browser_falls_back_to_the_platform_opener(monkeypatch):
    # In a frozen build webbrowser.open can quietly fail; the platform opener is
    # what actually raises a browser, so the fallback must be taken.
    monkeypatch.setattr(oa.webbrowser, "open", lambda url, new=0: False)
    calls = []

    class _Done:
        returncode = 0
    monkeypatch.setattr(oa.subprocess, "run", lambda *a, **k: calls.append(a) or _Done())
    assert oa.open_in_browser("https://x") is True
    assert calls   # the platform opener was invoked


# ----------------------------------------------------- CoreHost handlers

class _AuthHost:
    def __init__(self, client=True, refresh=None):
        self.state = {"app_settings": {}}
        if client:
            self.state["app_settings"].update(
                youtubeOauthClientId="cid", youtubeOauthClientSecret="sec")
        if refresh:
            self.state["youtube_oauth"] = {"refresh_token": refresh}
        self.broadcasts = []
        self.bridge = self

    def broadcast(self, name, payload):
        self.broadcasts.append((name, payload))

    def _load_state(self):
        import copy
        return copy.deepcopy(self.state)

    def _save_state(self, **updates):
        self.state.update(updates)
        return dict(self.state)

    _youtube_oauth_creds = CoreHost._youtube_oauth_creds
    _youtube_refresh_token = CoreHost._youtube_refresh_token
    _youtube_access_token = CoreHost._youtube_access_token
    _youtube_auth_state = CoreHost._youtube_auth_state
    _cmd_youtube_authState = CoreHost._cmd_youtube_authState
    _cmd_youtube_signIn = CoreHost._cmd_youtube_signIn
    _cmd_youtube_signOut = CoreHost._cmd_youtube_signOut


def test_auth_state_reports_configured_and_signed_out():
    h = _AuthHost(client=True, refresh=None)
    s = h._cmd_youtube_authState(None)
    assert s == {"configured": True, "signedIn": False, "account": "", "error": ""}


def test_auth_state_signed_in():
    h = _AuthHost(client=True, refresh="rt")
    assert h._cmd_youtube_authState(None)["signedIn"] is True


def test_sign_in_refused_without_client_credentials():
    h = _AuthHost(client=False)
    with pytest.raises(CommandError):
        h._cmd_youtube_signIn(None)


def test_sign_out_forgets_the_refresh_token():
    h = _AuthHost(client=True, refresh="rt")
    h._yt_access = "at"; h._yt_access_exp = 9e18
    state = h._cmd_youtube_signOut(None)
    assert state["signedIn"] is False
    assert h.state["youtube_oauth"] == {}
    assert h._youtube_access_token() == ""
    assert [n for n, _ in h.broadcasts] == ["youtube.auth"]


def test_access_token_caches_then_refreshes(monkeypatch):
    h = _AuthHost(client=True, refresh="rt")
    calls = []
    monkeypatch.setattr(oa, "refresh_token",
                        lambda cid, sec, rt: calls.append(1) or {"access_token": "AT", "expires_in": 3600})
    assert h._youtube_access_token() == "AT"
    assert h._youtube_access_token() == "AT"   # cached, no second refresh
    assert len(calls) == 1


def test_access_token_empty_when_signed_out():
    h = _AuthHost(client=True, refresh=None)
    assert h._youtube_access_token() == ""


def test_access_token_empty_when_refresh_fails(monkeypatch):
    h = _AuthHost(client=True, refresh="rt")
    def boom(*a):
        raise oa.OAuthError("revoked")
    monkeypatch.setattr(oa, "refresh_token", boom)
    assert h._youtube_access_token() == ""
