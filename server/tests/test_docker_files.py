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


def test_포트_8000은_기본으로_127_0_0_1에만_연다():
    # 맥에서 돌릴 때 인터넷(같은 망)에 포트를 열지 않는다(규칙 10). EC2에서는 BIND_ADDR로 바꾼다
    assert load_service()["ports"] == ["${BIND_ADDR:-127.0.0.1}:8000:8000"]


def test_인덱스는_이름_있는_볼륨에_두고_서버와_시드가_같은_경로를_쓴다():
    compose = yaml.safe_load((SERVER_DIR / "docker-compose.yml").read_text(encoding="utf-8"))
    service = compose["services"]["analogy-api"]
    assert "rag_storage" in compose["volumes"]
    assert "rag_storage:/data/rag_storage" in service["volumes"]
    assert service["environment"]["LIGHTRAG_WORKING_DIR"] == "/data/rag_storage"


def test_README에_도커_시드_절차가_있다():
    readme = (SERVER_DIR / "README.md").read_text(encoding="utf-8")
    assert "docker compose run --rm analogy-api python -m app.seed" in readme


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


def test_dockerignore가_비밀값과_가상환경을_뺀다():
    ignored = [l.strip().rstrip("/") for l in
               (SERVER_DIR / ".dockerignore").read_text(encoding="utf-8").splitlines()]
    for name in (".env", ".venv", "__pycache__", ".pytest_cache", "tests"):
        assert name in ignored, name


def test_종료_유예가_추출_워커_대기_상한보다_길다():
    # 서버 종료 때 추출 워커가 진행 중 큐 작업을 최대 THREAD_DRAIN_TIMEOUT_S 기다린다(T-161). 도커가 그 전에 죽이지 않게
    from app.extract_worker import THREAD_DRAIN_TIMEOUT_S

    grace = load_service()["stop_grace_period"]
    assert grace.endswith("s") and int(grace[:-1]) > THREAD_DRAIN_TIMEOUT_S
