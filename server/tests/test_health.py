"""서버 뼈대: /health와 설정 기본값 테스트. 실제 키 없이 돈다."""
import json
from pathlib import Path

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"


def _clear_env(monkeypatch):
    for name in ("GEMINI_API_KEY", "WORKSPACE", "WORKSPACE_VERSION",
                 "RATE_LIMIT_PER_MIN", "COMMON_GRAPH_PATH", "BLOCKLIST_PATH", "TAGS_PATH"):
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
    body = res.json()
    assert body["ok"] is True and body["version"] == __version__
    assert set(body) == {"ok", "version", "blocklist"}
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


# --- 금칙어 목록 경로·상태(T-114 최종 리뷰) ---

def test_blocklist_path_follows_common_graph_dir(monkeypatch):
    # 도커 이미지 안에서는 REPO_ROOT가 / 라서, 공통 그래프 옆 파일을 기본값으로 쓴다
    _clear_env(monkeypatch)
    from app.config import Settings

    assert Settings.from_env({"COMMON_GRAPH_PATH": "/x/maplestory.json"}).blocklist_path == "/x/blocklist.json"
    assert Settings.from_env({"COMMON_GRAPH_PATH": "/x/maplestory.json", "BLOCKLIST_PATH": "/y/b.json"}).blocklist_path == "/y/b.json"
    s = Settings(gemini_api_key=None, workspace="w", workspace_version="v", rate_limit_per_min=1,
                 common_graph_path="/z/maplestory.json")
    assert s.blocklist_path == "/z/blocklist.json"


def test_health_reports_blocklist_loaded(monkeypatch):
    _clear_env(monkeypatch)
    from app.main import create_app

    approved = sum(1 for c in json.loads((COMMON_GRAPH.parent / "blocklist.json").read_text("utf-8"))["terms"]
                   if c["status"] == "승인")
    body = TestClient(create_app()).get("/health").json()
    assert body["blocklist"] == {"loaded": True, "approved": approved}
    assert approved >= 1


def test_health_reports_missing_blocklist(monkeypatch, tmp_path):
    _clear_env(monkeypatch)
    monkeypatch.setenv("BLOCKLIST_PATH", str(tmp_path / "없음.json"))
    from app.main import create_app

    res = TestClient(create_app()).get("/health")
    assert res.status_code == 200  # 프로세스는 살아 있다(비유 요청만 503으로 막는다)
    assert res.json()["blocklist"] == {"loaded": False, "approved": 0}


def test_docker_compose_sets_blocklist_path_next_to_graph():
    compose = (REPO_ROOT / "server" / "docker-compose.yml").read_text("utf-8")
    assert "COMMON_GRAPH_PATH: /data/common/maplestory.json" in compose
    assert "BLOCKLIST_PATH: /data/common/blocklist.json" in compose
    # 볼륨이 확장 data/common 폴더 전체를 마운트하므로 blocklist.json도 들어간다
    assert "../extension/data/common:/data/common:ro" in compose
    assert (REPO_ROOT / "extension" / "data" / "common" / "blocklist.json").is_file()
