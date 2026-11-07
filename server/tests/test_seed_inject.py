"""시드 주입(LightRAG) 테스트. 네트워크 없이 해시 임베딩, 임시 작업 디렉터리에서 돈다."""
from __future__ import annotations

import asyncio
import dataclasses
import json
import subprocess
import sys
from pathlib import Path

import httpx
import numpy as np
import pytest

from app import rag as rag_mod
from app.config import Settings
from app.seed import graph_to_custom_kg, seed, seed_counts

SERVER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVER_DIR.parent
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"


@pytest.fixture(scope="module")
def kg() -> dict:
    return graph_to_custom_kg(json.loads(COMMON_GRAPH.read_text(encoding="utf-8")))


def make_settings(tmp_path: Path, **env: str) -> Settings:
    base = {"LIGHTRAG_WORKING_DIR": str(tmp_path / "rag"), "EMBEDDING_PROVIDER": "hash", "EMBEDDING_DIM": "64"}
    base.update(env)
    return Settings.from_env(base)


@pytest.fixture
def llm_calls(monkeypatch) -> list:
    """open_rag가 넘기는 llm_model_func를 감시한다. 시드 주입 중 한 번이라도 불리면 실패."""
    calls: list = []
    real = rag_mod.forbidden_llm

    async def spy(*args, **kwargs):
        calls.append((args, kwargs))
        return await real(*args, **kwargs)

    monkeypatch.setattr(rag_mod, "forbidden_llm", spy)
    return calls


async def read_graph(settings: Settings) -> tuple[list[dict], list[dict]]:
    rag = await rag_mod.open_rag(settings)
    try:
        g = rag.chunk_entity_relation_graph
        return await g.get_all_nodes(), await g.get_all_edges()
    finally:
        await rag.finalize_storages()


# ── 설정 ──────────────────────────────────────────────


def test_settings_defaults():
    s = Settings.from_env({})
    assert Path(s.lightrag_working_dir) == SERVER_DIR / "rag_storage"
    assert s.embedding_provider == "hash"
    assert s.ollama_url == "http://127.0.0.1:11434"
    assert s.embedding_model == "bge-m3"
    assert s.embedding_dim == 1024


def test_settings_from_env():
    s = Settings.from_env({"LIGHTRAG_WORKING_DIR": "/x", "EMBEDDING_PROVIDER": "ollama",
                           "OLLAMA_URL": "http://mac:11434", "EMBEDDING_MODEL": "m", "EMBEDDING_DIM": "8"})
    assert (s.lightrag_working_dir, s.embedding_provider, s.ollama_url, s.embedding_model, s.embedding_dim) == \
        ("/x", "ollama", "http://mac:11434", "m", 8)


# ── 임베딩 ──────────────────────────────────────────────


def test_hash_embedding_is_deterministic_normalized_and_sized(tmp_path):
    ef = rag_mod.make_embedding_func(make_settings(tmp_path))
    assert ef.embedding_dim == 64
    a = asyncio.run(ef(["재화가 돌아요", "재화가 돌아요", "전혀 다른 문장"]))
    assert isinstance(a, np.ndarray) and a.shape == (3, 64)
    assert np.allclose(np.linalg.norm(a, axis=1), 1.0)
    assert np.array_equal(a[0], a[1])
    assert not np.array_equal(a[0], a[2])
    # 프로세스가 바뀌어도 같은 벡터(파이썬 hash() 무작위화에 기대지 않음)
    b = asyncio.run(rag_mod.make_embedding_func(make_settings(tmp_path))(["재화가 돌아요"]))
    assert np.array_equal(a[0], b[0])


def test_hash_embedding_handles_empty_text(tmp_path):
    a = asyncio.run(rag_mod.make_embedding_func(make_settings(tmp_path))([""]))
    assert a.shape == (1, 64) and np.all(np.isfinite(a))


def test_ollama_embedding_posts_to_api_embed(tmp_path):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), json.loads(request.content)))
        n = len(json.loads(request.content)["input"])
        return httpx.Response(200, json={"embeddings": [[0.5] * 8 for _ in range(n)]})

    s = make_settings(tmp_path, EMBEDDING_PROVIDER="ollama", OLLAMA_URL="http://mac:11434",
                      EMBEDDING_MODEL="bge-m3", EMBEDDING_DIM="8")
    ef = rag_mod.make_embedding_func(s, transport=httpx.MockTransport(handler))
    out = asyncio.run(ef(["가", "나"]))
    assert out.shape == (2, 8)
    assert seen == [("http://mac:11434/api/embed", {"model": "bge-m3", "input": ["가", "나"]})]


def test_unknown_embedding_provider_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="EMBEDDING_PROVIDER"):
        rag_mod.make_embedding_func(make_settings(tmp_path, EMBEDDING_PROVIDER="openai"))


# ── LLM 금지 ──────────────────────────────────────────────


def test_forbidden_llm_raises_korean_error():
    with pytest.raises(RuntimeError, match="LLM"):
        asyncio.run(rag_mod.forbidden_llm("프롬프트"))


# ── 주입 ──────────────────────────────────────────────


def test_seed_loads_all_entities_and_relationships(tmp_path, kg, llm_calls):
    s = make_settings(tmp_path)
    out = asyncio.run(seed(s))
    expected = seed_counts(kg)
    assert out["entities"] == expected["entities"] == 36
    assert out["relationships"] == expected["relationships"]
    assert out["workspace"] == "common_maplestory"
    assert Path(out["working_dir"]) == tmp_path / "rag"
    assert llm_calls == []
    # 워크스페이스 폴더 아래에 저장된다
    assert (tmp_path / "rag" / "common_maplestory").is_dir()


def test_seed_twice_keeps_counts_and_does_not_repeat_descriptions(tmp_path, kg, llm_calls):
    s = make_settings(tmp_path)
    first = asyncio.run(seed(s))
    second = asyncio.run(seed(s))
    assert (second["entities"], second["relationships"]) == (first["entities"], first["relationships"])

    nodes, edges = asyncio.run(read_graph(s))
    assert len(nodes) == 36 and len(edges) == seed_counts(kg)["relationships"]
    want = {e["entity_name"]: e for e in kg["entities"]}
    for n in nodes:
        e = want[n["entity_id"]]
        # 같은 사실이 두 번 붙지 않고, 근거(source_id)도 하나뿐이다
        assert n["description"] == e["description"]
        assert n["entity_type"] == e["entity_type"]
        assert "<SEP>" not in n["source_id"]
    for ed in edges:
        assert "<SEP>" not in ed["description"]
        assert "<SEP>" not in ed["source_id"]
    assert llm_calls == []


def test_seed_does_not_need_tiktoken_download(tmp_path, monkeypatch):
    """기본 토크나이저(tiktoken)는 처음 쓸 때 인코딩 파일을 인터넷에서 받는다. 주입은 네트워크 없이 돌아야 한다."""
    import tiktoken

    def no_network(*args, **kwargs):
        raise AssertionError("tiktoken을 쓰면 안 돼요(인코딩 다운로드)")

    monkeypatch.setattr(tiktoken, "encoding_for_model", no_network)
    monkeypatch.setattr(tiktoken, "get_encoding", no_network)
    out = asyncio.run(seed(make_settings(tmp_path)))
    assert out["entities"] == 36


def test_seed_does_not_create_unknown_placeholder_nodes(tmp_path):
    s = make_settings(tmp_path)
    asyncio.run(seed(s))
    nodes, _ = asyncio.run(read_graph(s))
    assert all(n["entity_type"] != "UNKNOWN" for n in nodes)


def test_seed_cli_prints_one_line_summary(tmp_path, kg):
    env = {"PATH": "/usr/bin:/bin", "LIGHTRAG_WORKING_DIR": str(tmp_path / "rag"),
           "EMBEDDING_PROVIDER": "hash", "EMBEDDING_DIM": "32"}
    r = subprocess.run([sys.executable, "-m", "app.seed"], cwd=SERVER_DIR, env=env,
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    assert r.stderr.strip() == ""  # LightRAG INFO 로그는 감춘다
    lines = r.stdout.strip().splitlines()
    assert len(lines) == 1
    line = lines[0]
    assert "엔티티 36" in line
    assert f"관계 {seed_counts(kg)['relationships']}" in line
    assert "common_maplestory" in line
    assert str(tmp_path / "rag") in line


# ── 커밋·이미지에 인덱스를 넣지 않는다 ──────────────────


def test_index_dir_is_git_and_docker_ignored():
    git = [l.strip().rstrip("/") for l in (SERVER_DIR / ".gitignore").read_text(encoding="utf-8").splitlines()]
    docker = [l.strip().rstrip("/") for l in (SERVER_DIR / ".dockerignore").read_text(encoding="utf-8").splitlines()]
    assert "rag_storage" in git
    assert "rag_storage" in docker


def test_settings_is_still_frozen(tmp_path):
    with pytest.raises(dataclasses.FrozenInstanceError):
        make_settings(tmp_path).embedding_dim = 1  # type: ignore[misc]
