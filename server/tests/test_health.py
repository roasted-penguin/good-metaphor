"""서버 뼈대: /health와 설정 기본값 테스트. 실제 키 없이 돈다."""
import json
from pathlib import Path

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"


def _clear_env(monkeypatch):
    for name in ("GEMINI_API_KEY", "WORKSPACE", "WORKSPACE_VERSION",
                 "RATE_LIMIT_PER_MIN", "COMMON_GRAPH_PATH"):
        monkeypatch.delenv(name, raising=False)


def test_create_app_without_key(monkeypatch):
    _clear_env(monkeypatch)
    from app.main import create_app

    app = create_app()
    assert app is not None


def test_health_returns_ok_and_version(monkeypatch):
    _clear_env(monkeypatch)
    from app import __version__
    from app.main import create_app

    client = TestClient(create_app())
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "version": __version__}
    assert isinstance(__version__, str) and __version__


def test_settings_defaults(monkeypatch):
    _clear_env(monkeypatch)
    from app.config import Settings

    s = Settings.from_env()
    assert s.gemini_api_key is None
    assert s.workspace == "common_maplestory"
    assert s.rate_limit_per_min == 30
    assert Path(s.common_graph_path).resolve() == COMMON_GRAPH.resolve()
    expected_version = json.loads(COMMON_GRAPH.read_text(encoding="utf-8"))["version"]
    assert s.workspace_version == expected_version


def test_settings_from_env(monkeypatch, tmp_path):
    _clear_env(monkeypatch)
    graph = tmp_path / "g.json"
    graph.write_text(json.dumps({"version": "test-1"}), encoding="utf-8")
    monkeypatch.setenv("GEMINI_API_KEY", "dummy-not-a-key")
    monkeypatch.setenv("WORKSPACE", "ws2")
    monkeypatch.setenv("RATE_LIMIT_PER_MIN", "5")
    monkeypatch.setenv("COMMON_GRAPH_PATH", str(graph))
    from app.config import Settings

    s = Settings.from_env()
    assert s.gemini_api_key == "dummy-not-a-key"
    assert s.workspace == "ws2"
    assert s.rate_limit_per_min == 5
    assert s.common_graph_path == str(graph)
    # WORKSPACE_VERSION이 없으면 지정한 그래프 파일의 version을 쓴다
    assert s.workspace_version == "test-1"

    monkeypatch.setenv("WORKSPACE_VERSION", "override-2")
    assert Settings.from_env().workspace_version == "override-2"


def test_create_app_uses_injected_settings(monkeypatch):
    _clear_env(monkeypatch)
    from app.config import Settings
    from app.main import create_app

    s = Settings(gemini_api_key=None, workspace="w", workspace_version="v",
                 rate_limit_per_min=1, common_graph_path=str(COMMON_GRAPH))
    app = create_app(deps={"settings": s})
    assert app.state.settings is s
