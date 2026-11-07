"""docker compose 설정 확인(도커 없이 YAML만 읽는다)."""
from __future__ import annotations

from pathlib import Path

import yaml

SERVER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVER_DIR.parent
CONTAINER_GRAPH_DIR = "/data/common"


def load_service() -> dict:
    compose = yaml.safe_load((SERVER_DIR / "docker-compose.yml").read_text(encoding="utf-8"))
    return compose["services"]["analogy-api"]


def env_file_paths(service: dict) -> list[str]:
    raw = service.get("env_file")
    items = raw if isinstance(raw, list) else [raw]
    # 짧은 형식("./.env")과 긴 형식({path: ...}) 둘 다 받는다
    return [(i["path"] if isinstance(i, dict) else i) for i in items if i]


def test_공통_그래프를_읽기_전용으로_마운트한다():
    volumes = load_service()["volumes"]
    mounts = [v.split(":") for v in volumes]
    graph = [m for m in mounts if m[1] == CONTAINER_GRAPH_DIR]
    assert len(graph) == 1
    host, _, mode = graph[0]
    assert mode == "ro"
    assert (SERVER_DIR / host).resolve() == REPO_ROOT / "extension" / "data" / "common"


def test_컨테이너의_그래프_경로를_마운트한_파일로_지정한다():
    env = load_service()["environment"]
    assert env["COMMON_GRAPH_PATH"] == f"{CONTAINER_GRAPH_DIR}/maplestory.json"
    assert (REPO_ROOT / "extension" / "data" / "common" / "maplestory.json").is_file()


def test_포트_8000을_연다():
    assert "8000:8000" in load_service()["ports"]


def test_키는_env_파일에서_읽고_compose에_직접_쓰지_않는다():
    service = load_service()
    assert [Path(p).name for p in env_file_paths(service)] == [".env"]
    assert "GEMINI_API_KEY" not in (service.get("environment") or {})


def test_env_예시는_키가_비어_있고_env는_커밋하지_않는다():
    example = (SERVER_DIR / ".env.example").read_text(encoding="utf-8")
    key_lines = [l for l in example.splitlines() if l.startswith("GEMINI_API_KEY=")]
    assert key_lines == ["GEMINI_API_KEY="]
    ignored = (SERVER_DIR / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert ".env" in ignored
