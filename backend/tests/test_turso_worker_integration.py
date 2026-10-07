"""Regression checks for the direct Turso HTTP pipeline and Worker configuration."""
import json
import re
from pathlib import Path

import requests


ROOT = Path("/app")
WORKER = (ROOT / "cloudflare-worker.js").read_text(encoding="utf-8")
WRANGLER = (ROOT / "wrangler.toml").read_text(encoding="utf-8")


def _worker_credentials():
    url = re.search(r'const TURSO_DEFAULT_URL = "([^"]+)"', WORKER).group(1)
    token = re.search(r'const TURSO_DEFAULT_TOKEN = "([^"]+)"', WORKER).group(1)
    return url.rstrip("/") + "/v2/pipeline", token


def _query(sql):
    endpoint, token = _worker_credentials()
    payload = {"requests": [{"type": "execute", "stmt": {"sql": sql, "args": []}}, {"type": "close"}]}
    response = requests.post(endpoint, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, json=payload, timeout=30)
    assert response.status_code == 200, response.text[:500]
    result = response.json()["results"][0]["response"]["result"]
    return result["rows"]


def test_turso_has_271_populated_video_records():
    rows = _query("SELECT COUNT(*) AS count FROM links;")
    assert int(rows[0][0]["value"]) == 271


def test_turso_records_have_required_video_fields_and_hosts():
    rows = _query("SELECT title, slug, originalUrl, sources, hostType FROM links LIMIT 10;")
    assert len(rows) == 10
    for row in rows:
        values = [cell.get("value") for cell in row]
        assert all(values[:4])
        assert values[4] in {"vk", "ok", "okru", "sibnet", "other"}


def test_worker_has_pipeline_helper_and_wrangler_bindings():
    assert "async function queryTurso" in WORKER
    assert "/v2/pipeline" in WORKER
    assert "renderDashboardAppHtml" in WORKER
    assert 'TURSO_DATABASE_URL = "https://shindora-player-shindora-stream.aws-ap-northeast-1.turso.io"' in WRANGLER
    assert re.search(r'TURSO_AUTH_TOKEN\s*=\s*"[^"\n]+"', WRANGLER)