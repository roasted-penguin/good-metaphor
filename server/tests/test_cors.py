"""CORS(T-141): 기본은 닫힘. ALLOWED_ORIGINS(쉼표 구분)와 ALLOW_EXTENSION_ORIGINS(확장 id 형식 정규식)로만 연다."""
from pathlib import Path

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"

EXT_ORIGIN = "chrome-extension://" + "a" * 32
OTHER_EXT_ORIGIN = "chrome-extension://" + "b" * 32


def _settings(**over):
    from app.config import Settings

    return Settings(gemini_api_key=None, workspace="w", workspace_version="v", rate_limit_per_min=30,
                    common_graph_path=str(COMMON_GRAPH), **over)


def _client(**over):
    from app.main import create_app

    return TestClient(create_app(deps={"settings": _settings(**over)}))


def _preflight(client, origin, headers="content-type,x-install-token"):
    return client.options("/v1/analogy", headers={
        "Origin": origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": headers,
    })


def test_settings_cors_defaults_closed():
    from app.config import Settings

    s = Settings.from_env({})
    assert s.allowed_origins == ()
    assert s.allow_extension_origins is False


def test_settings_cors_from_env():
    from app.config import Settings

    s = Settings.from_env({"ALLOWED_ORIGINS": f" {EXT_ORIGIN} , https://x.example ,,", "ALLOW_EXTENSION_ORIGINS": "true"})
    assert s.allowed_origins == (EXT_ORIGIN, "https://x.example")
    assert s.allow_extension_origins is True
    for off in ("", "false", "0", "no", "아니요"):
        assert Settings.from_env({"ALLOW_EXTENSION_ORIGINS": off}).allow_extension_origins is False
    for on in ("1", "TRUE", "yes"):
        assert Settings.from_env({"ALLOW_EXTENSION_ORIGINS": on}).allow_extension_origins is True


def test_default_rejects_extension_preflight():
    res = _preflight(_client(), EXT_ORIGIN)
    assert "access-control-allow-origin" not in res.headers


def test_default_post_has_no_cors_header():
    res = _client().post("/v1/analogy", json={"sentence": "x"}, headers={"Origin": EXT_ORIGIN})
    assert res.status_code == 400  # 토큰 없음. 요청 자체는 처리하지만 브라우저가 읽지 못한다
    assert "access-control-allow-origin" not in res.headers


def test_allowed_origins_lets_listed_extension_through():
    client = _client(allowed_origins=(EXT_ORIGIN,))
    res = _preflight(client, EXT_ORIGIN)
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == EXT_ORIGIN
    assert "POST" in res.headers["access-control-allow-methods"]
    allowed = res.headers["access-control-allow-headers"].lower()
    assert "x-install-token" in allowed and "content-type" in allowed
    # 목록에 없는 확장은 막는다
    other = _preflight(client, OTHER_EXT_ORIGIN)
    assert "access-control-allow-origin" not in other.headers


def test_allowed_post_response_carries_cors_header():
    client = _client(allowed_origins=(EXT_ORIGIN,))
    res = client.post("/v1/analogy", json={"sentence": "x"}, headers={"Origin": EXT_ORIGIN})
    assert res.status_code == 400
    assert res.headers["access-control-allow-origin"] == EXT_ORIGIN


def test_extension_regex_flag_allows_any_extension_id_only():
    client = _client(allow_extension_origins=True)
    for origin in (EXT_ORIGIN, OTHER_EXT_ORIGIN):
        assert _preflight(client, origin).headers.get("access-control-allow-origin") == origin
    for origin in ("https://evil.example", "chrome-extension://short", "chrome-extension://" + "z" * 32,
                   EXT_ORIGIN + ".evil.example", "http://127.0.0.1:8766"):
        assert "access-control-allow-origin" not in _preflight(client, origin).headers, origin


def test_preflight_rejects_other_methods_and_headers():
    client = _client(allowed_origins=(EXT_ORIGIN,))
    res = client.options("/v1/analogy", headers={"Origin": EXT_ORIGIN, "Access-Control-Request-Method": "DELETE"})
    assert res.status_code == 400
    res = _preflight(client, EXT_ORIGIN, headers="content-type,x-other")
    assert res.status_code == 400
