"""시드 인덱스 다듬기(T-140): seed-meta.json 기록·비교, 열기 실패 정리, Ollama 차원 확인, 이름 기준 자기 엣지.

네트워크 없이 해시 임베딩, 임시 작업 디렉터리에서 돈다.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import rag as rag_mod
from app import seedmeta
from app.config import Settings, load_common_graph
from app.seed import graph_to_custom_kg, seed
from fakes import FakeLLM

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"
TOKEN = {"X-Install-Token": "install-meta"}
SENTENCE = "강화할 때마다 확률이 낮아지는 구조예요."
UNAVAILABLE = "검색 인덱스가 아직 준비되지 않았어요."


def make_settings(working_dir: Path, **env: str) -> Settings:
    base = {"LIGHTRAG_WORKING_DIR": str(working_dir), "EMBEDDING_PROVIDER": "hash", "EMBEDDING_DIM": "64",
            "COMMON_GRAPH_PATH": str(COMMON_GRAPH)}
    base.update(env)
    return Settings.from_env(base)


@pytest.fixture(scope="module")
def seeded_dir(tmp_path_factory) -> Path:
    wd = tmp_path_factory.mktemp("meta") / "rag"
    asyncio.run(seed(make_settings(wd)))
    return wd


def _app(settings: Settings):
    from app.main import create_app

    return create_app(deps={"settings": settings, "llm": FakeLLM()})


# ── 시드가 seed-meta.json을 남긴다 ─────────────────────────


def test_seed_writes_meta_with_graph_version_and_embedding(seeded_dir):
    s = make_settings(seeded_dir)
    meta = json.loads((seeded_dir / "common_maplestory" / "seed-meta.json").read_text("utf-8"))
    assert meta["graphVersion"] == s.workspace_version
    assert "+" in meta["graphVersion"]  # 그래프 판본 + 태그 판본(T-304)
    assert meta["embedding"] == {"provider": "hash", "model": rag_mod.HASH_MODEL_NAME, "dim": 64}
    assert isinstance(meta["seededAt"], str) and meta["seededAt"]


def test_meta_write_is_atomic_and_leaves_no_temp_files(tmp_path):
    s = make_settings(tmp_path / "rag")
    seedmeta.workspace_dir(s).mkdir(parents=True)
    seedmeta.write_seed_meta(s)
    seedmeta.write_seed_meta(s)  # 덮어쓰기
    names = sorted(p.name for p in seedmeta.workspace_dir(s).iterdir())
    assert names == ["seed-meta.json"]


def test_meta_write_failure_keeps_previous_meta(tmp_path, monkeypatch):
    s = make_settings(tmp_path / "rag")
    seedmeta.workspace_dir(s).mkdir(parents=True)
    seedmeta.write_seed_meta(s)
    before = (seedmeta.workspace_dir(s) / "seed-meta.json").read_text("utf-8")

    def boom(*args, **kwargs):
        raise OSError("디스크 가득")

    monkeypatch.setattr(seedmeta.os, "replace", boom)
    with pytest.raises(OSError):
        seedmeta.write_seed_meta(make_settings(tmp_path / "rag", EMBEDDING_DIM="32"))
    assert (seedmeta.workspace_dir(s) / "seed-meta.json").read_text("utf-8") == before
    assert sorted(p.name for p in seedmeta.workspace_dir(s).iterdir()) == ["seed-meta.json"]


def test_failed_seed_leaves_no_meta(tmp_path, monkeypatch):
    """시드가 중간에 실패하면 옛 메타도 지운다(반쯤 넣은 인덱스를 준비됨으로 보지 않는다)."""
    s = make_settings(tmp_path / "rag")
    asyncio.run(seed(s))
    assert seedmeta.read_seed_meta(s) is not None

    from lightrag import LightRAG

    async def broken(self, *args, **kwargs):
        raise RuntimeError("주입 실패")

    monkeypatch.setattr(LightRAG, "ainsert_custom_kg", broken)
    with pytest.raises(RuntimeError):
        asyncio.run(seed(s))
    assert seedmeta.read_seed_meta(s) is None
    ready, reason = seedmeta.index_status(s)
    assert ready is False and "다시 시드" in reason


def test_seed_reset_removes_old_workspace_files(tmp_path):
    s = make_settings(tmp_path / "rag")
    asyncio.run(seed(s))
    stale = seedmeta.workspace_dir(s) / "남은파일.json"
    stale.write_text("{}", "utf-8")
    asyncio.run(seed(s, reset=True))
    assert not stale.exists()
    assert seedmeta.index_status(s) == (True, None)


# ── 열 때 비교 ──────────────────────────────────────────────


def test_index_status_ready_when_meta_matches(seeded_dir):
    assert seedmeta.index_status(make_settings(seeded_dir)) == (True, None)


def test_index_status_missing_index(tmp_path):
    ready, reason = seedmeta.index_status(make_settings(tmp_path / "없음"))
    assert ready is False
    assert "시드" in reason and "python -m app.seed" in reason
    assert str(tmp_path) not in reason  # 절대 경로는 응답에 넣지 않는다(로그에만)


def test_index_status_old_index_without_meta(tmp_path, seeded_dir):
    import shutil

    wd = tmp_path / "rag"
    shutil.copytree(seeded_dir, wd)
    (wd / "common_maplestory" / "seed-meta.json").unlink()
    ready, reason = seedmeta.index_status(make_settings(wd))
    assert ready is False
    assert "seed-meta.json" in reason and "다시 시드" in reason


def test_index_status_broken_meta(tmp_path, seeded_dir):
    import shutil

    wd = tmp_path / "rag"
    shutil.copytree(seeded_dir, wd)
    (wd / "common_maplestory" / "seed-meta.json").write_text("{깨짐", "utf-8")
    ready, reason = seedmeta.index_status(make_settings(wd))
    assert ready is False and "다시 시드" in reason


@pytest.mark.parametrize("env, word", [
    ({"WORKSPACE_VERSION": "다른판본"}, "그래프 판본"),
    ({"EMBEDDING_DIM": "32"}, "임베딩"),
    ({"EMBEDDING_PROVIDER": "ollama", "EMBEDDING_DIM": "64"}, "임베딩"),
    ({"EMBEDDING_PROVIDER": "ollama", "EMBEDDING_MODEL": "다른모델", "EMBEDDING_DIM": "64"}, "임베딩"),
])
def test_index_status_mismatch(seeded_dir, env, word):
    ready, reason = seedmeta.index_status(make_settings(seeded_dir, **env))
    assert ready is False
    assert word in reason
    assert "--reset" in reason  # 무엇을 해야 하는지(다시 시드 명령)


def test_ollama_model_change_is_detected(tmp_path):
    """ollama는 공급자·차원이 같아도 모델이 다르면 다르다."""
    s = make_settings(tmp_path / "rag", EMBEDDING_PROVIDER="ollama", EMBEDDING_MODEL="bge-m3", EMBEDDING_DIM="8")
    seedmeta.workspace_dir(s).mkdir(parents=True)
    for name in seedmeta.INDEX_FILES:
        (seedmeta.workspace_dir(s) / name).write_text("", "utf-8")
    seedmeta.write_seed_meta(s)
    assert seedmeta.index_status(s) == (True, None)
    other = make_settings(tmp_path / "rag", EMBEDDING_PROVIDER="ollama", EMBEDDING_MODEL="e5", EMBEDDING_DIM="8")
    ready, reason = seedmeta.index_status(other)
    assert ready is False and "bge-m3" in reason and "e5" in reason


def test_mismatch_returns_503_with_reason_and_does_not_open(seeded_dir, monkeypatch):
    def boom(settings):
        raise AssertionError("메타가 다르면 LightRAG를 열지 않아요")

    monkeypatch.setattr(rag_mod, "open_rag", boom)
    with TestClient(_app(make_settings(seeded_dir, EMBEDDING_DIM="32"))) as client:
        res = client.post("/v1/analogy", json={"sentence": SENTENCE}, headers=TOKEN)
    assert res.status_code == 503
    # 사용자에게는 짧은 문구만. 자세한 이유(할 일)는 /health·로그에(fix 1)
    assert res.json() == {"error": UNAVAILABLE}


def test_matching_meta_returns_200(seeded_dir):
    with TestClient(_app(make_settings(seeded_dir))) as client:
        res = client.post("/v1/analogy", json={"sentence": SENTENCE}, headers=TOKEN)
    assert res.status_code == 200, res.text


# ── /health ─────────────────────────────────────────────


def test_health_reports_index_ready(seeded_dir):
    body = TestClient(_app(make_settings(seeded_dir))).get("/health").json()
    assert body["index"] == {"ready": True, "reason": None}


def test_health_reports_index_reason(seeded_dir, tmp_path):
    body = TestClient(_app(make_settings(seeded_dir, WORKSPACE_VERSION="다른판본"))).get("/health").json()
    assert body["ok"] is True  # 프로세스는 살아 있다
    assert body["index"]["ready"] is False and "그래프 판본" in body["index"]["reason"]
    body = TestClient(_app(make_settings(tmp_path / "없음"))).get("/health").json()
    assert body["index"]["ready"] is False and "python -m app.seed" in body["index"]["reason"]


def test_health_does_not_open_lightrag(seeded_dir, monkeypatch):
    def boom(settings):
        raise AssertionError("/health는 LightRAG를 열지 않아요")

    monkeypatch.setattr(rag_mod, "open_rag", boom)
    assert TestClient(_app(make_settings(seeded_dir))).get("/health").status_code == 200


# ── initialize_storages 실패 정리 ─────────────────────────


def test_open_rag_finalizes_when_initialize_fails(tmp_path, monkeypatch):
    from lightrag import LightRAG

    finalized: list = []

    async def broken_init(self):
        raise OSError("저장소 중간 실패")

    async def spy_finalize(self):
        finalized.append(self)

    monkeypatch.setattr(LightRAG, "initialize_storages", broken_init)
    monkeypatch.setattr(LightRAG, "finalize_storages", spy_finalize)
    with pytest.raises(OSError, match="저장소 중간 실패"):
        asyncio.run(rag_mod.open_rag(make_settings(tmp_path / "rag")))
    assert len(finalized) == 1


def test_open_rag_keeps_original_error_when_finalize_also_fails(tmp_path, monkeypatch):
    from lightrag import LightRAG

    async def broken_init(self):
        raise OSError("처음 오류")

    async def broken_finalize(self):
        raise RuntimeError("정리도 실패")

    monkeypatch.setattr(LightRAG, "initialize_storages", broken_init)
    monkeypatch.setattr(LightRAG, "finalize_storages", broken_finalize)
    with pytest.raises(OSError, match="처음 오류"):
        asyncio.run(rag_mod.open_rag(make_settings(tmp_path / "rag")))


# ── Ollama 응답 차원 ───────────────────────────────────────


def _ollama(tmp_path, vectors):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": vectors(len(json.loads(request.content)["input"]))})

    s = make_settings(tmp_path / "rag", EMBEDDING_PROVIDER="ollama", EMBEDDING_DIM="8")
    return rag_mod.make_embedding_func(s, transport=httpx.MockTransport(handler))


def test_ollama_wrong_dim_raises_korean_error(tmp_path):
    ef = _ollama(tmp_path, lambda n: [[0.1] * 4 for _ in range(n)])
    with pytest.raises(ValueError, match="차원.*EMBEDDING_DIM"):
        asyncio.run(ef(["가", "나"]))


def test_ollama_wrong_count_raises(tmp_path):
    ef = _ollama(tmp_path, lambda n: [[0.1] * 8])
    with pytest.raises(ValueError, match="개수"):
        asyncio.run(ef(["가", "나"]))


def test_ollama_right_dim_passes(tmp_path):
    out = asyncio.run(_ollama(tmp_path, lambda n: [[0.1] * 8 for _ in range(n)])(["가", "나"]))
    assert out.shape == (2, 8)


# ── 자기 자신 엣지: 해석된 엔티티 이름 기준 ──────────────────


def test_edge_between_distinct_nodes_with_same_label_is_dropped():
    """id는 달라도 LightRAG에 들어가는 이름(라벨)이 같으면 자기 자신 관계라 주입이 멈춘다. 버린다."""
    g = {
        "tags": [],
        "nodes": [{"id": "a", "label": "같은이름", "facts": ["사실1."], "tags": []},
                  {"id": "b", "label": "같은이름", "facts": ["사실2."], "tags": []},
                  {"id": "c", "label": "다른이름", "facts": ["사실3."], "tags": []}],
        "edges": [{"from": "a", "to": "b", "rel": "겹침"}, {"from": "a", "to": "c", "rel": "이어짐"}],
    }
    kg = graph_to_custom_kg(g)
    assert [(r["src_id"], r["tgt_id"]) for r in kg["relationships"]] == [("같은이름", "다른이름")]


def test_real_graph_has_no_self_relationships():
    kg = graph_to_custom_kg(load_common_graph(COMMON_GRAPH))
    assert all(r["src_id"] != r["tgt_id"] for r in kg["relationships"])


# ── fix 1: 워크스페이스 경로 검증(--reset이 아무 경로나 지우지 않게) ─────────


@pytest.mark.parametrize("bad", ["/", "/etc", "..", ".", "../..", "a/b", "공백 있음", "x/../y"])
def test_bad_workspace_is_rejected_at_settings_load(tmp_path, bad):
    with pytest.raises(seedmeta.WorkspaceError, match="WORKSPACE"):
        make_settings(tmp_path / "rag", WORKSPACE=bad)


def test_bad_workspace_is_rejected_by_safe_workspace_dir(tmp_path):
    """Settings 검증을 건너뛴 객체가 와도 safe_workspace_dir가 막는다."""
    import types

    for bad in ("/", "/etc", "..", ".", str(tmp_path)):
        fake = types.SimpleNamespace(lightrag_working_dir=str(tmp_path / "rag"), workspace=bad)
        with pytest.raises(seedmeta.WorkspaceError):
            seedmeta.safe_workspace_dir(fake)


def test_safe_workspace_dir_is_child_of_working_dir(tmp_path):
    s = make_settings(tmp_path / "rag")
    d = seedmeta.safe_workspace_dir(s)
    assert d.parent == (tmp_path / "rag").resolve() and d.name == "common_maplestory"
    assert seedmeta.workspace_dir(s) == d


def test_reset_refuses_symlinked_workspace_and_keeps_target(tmp_path):
    victim = tmp_path / "지키는폴더"
    victim.mkdir()
    (victim / "중요.txt").write_text("x", "utf-8")
    base = tmp_path / "rag"
    base.mkdir()
    (base / "common_maplestory").symlink_to(victim, target_is_directory=True)
    s = make_settings(base)
    with pytest.raises(seedmeta.WorkspaceError, match="심볼릭"):
        asyncio.run(seed(s, reset=True))
    assert (victim / "중요.txt").is_file()


def test_reset_with_missing_workspace_is_ok(tmp_path):
    s = make_settings(tmp_path / "rag")
    asyncio.run(seed(s, reset=True))
    assert seedmeta.index_status(s) == (True, None)


def test_reset_permission_error_aborts_seed(tmp_path, monkeypatch):
    s = make_settings(tmp_path / "rag")
    asyncio.run(seed(s))
    import app.seed as seed_mod

    def denied(path, *a, **k):
        raise PermissionError("권한 없음")

    monkeypatch.setattr(seed_mod.shutil, "rmtree", denied)
    with pytest.raises(PermissionError):
        asyncio.run(seed(s, reset=True))


def test_health_with_symlinked_workspace_is_not_ready(tmp_path):
    other = tmp_path / "다른곳"
    other.mkdir()
    base = tmp_path / "rag"
    base.mkdir()
    (base / "common_maplestory").symlink_to(other, target_is_directory=True)
    body = TestClient(_app(make_settings(base))).get("/health").json()
    assert body["index"]["ready"] is False and str(tmp_path) not in body["index"]["reason"]


# ── fix 2: 자기 엣지를 LightRAG 정규화 이름으로 ─────────────────


@pytest.mark.parametrize("a, b", [("같은이름 ", "같은이름"), ('"같은이름"', "같은이름"), ("노드（가）", "노드(가)")])
def test_self_edge_detected_after_lightrag_normalization(a, b):
    g = {
        "tags": [],
        "nodes": [{"id": "a", "label": a, "facts": ["사실1."], "tags": []},
                  {"id": "b", "label": b, "facts": ["사실2."], "tags": []},
                  {"id": "c", "label": "다른이름", "facts": ["사실3."], "tags": []}],
        "edges": [{"from": "a", "to": "b", "rel": "겹침"}, {"from": "a", "to": "c", "rel": "이어짐"}],
    }
    rels = graph_to_custom_kg(g)["relationships"]
    assert [r["tgt_id"] for r in rels] == ["다른이름"]


# ── fix 3: --reset 없이 옛·다른 인덱스 위에 시드하지 않는다 ──────────


def test_seed_without_reset_refuses_index_with_different_meta(tmp_path):
    s = make_settings(tmp_path / "rag")
    asyncio.run(seed(s))
    other = make_settings(tmp_path / "rag", EMBEDDING_DIM="32")
    with pytest.raises(seedmeta.SeedRefused, match="--reset"):
        asyncio.run(seed(other))
    # 옛 메타는 그대로(다른 설정으로 준비됨 도장이 찍히지 않는다)
    assert seedmeta.index_status(s) == (True, None)
    assert seedmeta.index_status(other)[0] is False
    asyncio.run(seed(other, reset=True))
    assert seedmeta.index_status(other) == (True, None)


def test_seed_without_reset_refuses_old_index_without_meta(tmp_path):
    s = make_settings(tmp_path / "rag")
    asyncio.run(seed(s))
    seedmeta.meta_path(s).unlink()
    with pytest.raises(seedmeta.SeedRefused, match="--reset"):
        asyncio.run(seed(s))
    assert seedmeta.read_seed_meta(s) is None


def test_seed_without_reset_over_same_meta_is_ok(tmp_path):
    s = make_settings(tmp_path / "rag")
    asyncio.run(seed(s))
    asyncio.run(seed(s))
    assert seedmeta.index_status(s) == (True, None)


def test_seed_cli_refusal_is_korean_one_line_and_nonzero(tmp_path):
    import subprocess
    import sys

    env = {"PATH": "/usr/bin:/bin", "LIGHTRAG_WORKING_DIR": str(tmp_path / "rag"),
           "EMBEDDING_PROVIDER": "hash", "EMBEDDING_DIM": "32"}
    server = Path(__file__).resolve().parents[1]
    run = lambda e: subprocess.run([sys.executable, "-m", "app.seed"], cwd=server, env=e,
                                   capture_output=True, text=True, timeout=120)
    assert run(env).returncode == 0
    r = run({**env, "EMBEDDING_DIM": "16"})
    assert r.returncode != 0
    assert "--reset" in r.stderr and "Traceback" not in r.stderr


# ── fix 4: 판본을 모르면 준비 안 됨 ───────────────────────────


def test_unknown_graph_version_is_not_ready(seeded_dir):
    import dataclasses

    s = dataclasses.replace(make_settings(seeded_dir), workspace_version=None)
    ready, reason = seedmeta.index_status(s)
    assert ready is False and "판본" in reason


def test_seed_refuses_unknown_graph_version(tmp_path):
    import dataclasses

    s = dataclasses.replace(make_settings(tmp_path / "rag"), workspace_version=None)
    with pytest.raises(seedmeta.SeedRefused, match="판본"):
        asyncio.run(seed(s))
