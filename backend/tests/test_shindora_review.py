import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
pytestmark = pytest.mark.skipif(not BASE_URL, reason="REACT_APP_BACKEND_URL is required")

def test_auth_session_and_cookie():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"username": "admin", "password": "admin123"}, timeout=20)
    assert r.status_code == 200
    assert r.json().get("success") is True
    assert "session_token" in s.cookies and "refresh_token" in s.cookies
    assert s.cookies.get("session_token")
    me = s.get(f"{BASE_URL}/api/auth/session", timeout=20)
    assert me.status_code == 200 and me.json().get("authenticated") is True

def test_public_dashboard_endpoints_are_rejected_without_auth():
    s = requests.Session()
    for path in ("/api/stats", "/api/links", "/api/settings"):
        r = s.get(f"{BASE_URL}{path}", timeout=20)
        assert r.status_code in (401, 403), f"{path} returned {r.status_code}: {r.text[:200]}"

def test_vast_invalid_input_and_worker_files():
    r = requests.post(f"{BASE_URL}/api/vast-test", json={"url": "https://example.invalid/no-vast"}, timeout=20)
    assert r.status_code == 422
    assert os.path.exists("/app/cloudflare-worker.js")
    assert os.path.exists("/app/cloudflare-worker-download.js")
    assert os.path.exists("/app/cloudflare-worker-all-in-one.js")
    assert os.path.exists("/app/wrangler.toml")