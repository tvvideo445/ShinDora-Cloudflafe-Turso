import os

import pytest
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
pytestmark = pytest.mark.skipif(not BASE_URL, reason="REACT_APP_BACKEND_URL is required")


def test_worker_dashboard_routes_serve_html():
    for path in ("/", "/dashboard"):
        response = requests.get(f"{BASE_URL}{path}", timeout=20)
        assert response.status_code == 200
        assert "text/html" in response.headers.get("content-type", "")
        body = response.text.lower()
        assert "shindora stream" in body
        assert "viewdashboard" in body
        assert "fetch('/api/links')" in body


def test_worker_source_contains_player_and_api_dispatch():
    source = open("/app/cloudflare-worker-d1.js", encoding="utf-8").read()
    assert "function renderPlayerHtml" in source
    assert "content.jwplatform.com/libraries" in source
    assert "pathname.match(/^\\/v\\/([^\\/]+)$/)" in source
    for route in ("/api/links", "/api/stats", "/api/settings", "/api/stream", "/api/download"):
        assert route in source


def test_worker_api_smoke_and_missing_proxy_validation():
    checks = {
        "/api/links": ("GET", (200, 401, 403, 500)),
        "/api/stats": ("GET", (200, 401, 403, 500)),
        "/api/settings": ("GET", (200, 401, 403, 500)),
    }
    for path, (method, allowed) in checks.items():
        response = requests.request(method, f"{BASE_URL}{path}", timeout=20)
        assert response.status_code in allowed, f"{path}: {response.status_code} {response.text[:200]}"
        assert response.headers.get("content-type", "").startswith("application/json")

    for path in ("/api/stream", "/api/download"):
        response = requests.get(f"{BASE_URL}{path}", timeout=20)
        assert response.status_code == 400
        assert "Missing" in response.text
