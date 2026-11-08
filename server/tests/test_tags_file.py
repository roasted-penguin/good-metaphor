"""T-304: 추상 태그는 공통 파일 data/common/tags.json이 원본이다. 서버는 load_common_graph 한 곳에서 합친다."""
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_DIR = REPO_ROOT / "extension" / "data" / "common"
COMMON_GRAPH = COMMON_DIR / "maplestory.json"
TAGS_FILE = COMMON_DIR / "tags.json"

# 분리 전 maplestory.json tags 순서(확장 tests/unit/tags-file.test.mjs와 같다)
TAG_ORDER = [
    "prob_upgrade", "escalating_cost", "loss_risk", "threshold_req", "progression_gate", "market_price",
    "inflation", "scarcity_value", "periodic_cap", "daily_accumulation", "diminishing_returns", "temporary_multiplier",
    "cooldown", "random_reroll", "expected_value", "shared_bonus", "role_division", "efficiency_metric",
]
PROV = {"sources": ["https://maplestory.nexon.com/News/Update/799"], "verifiedAt": "2026-10-11"}


def _write(path: Path, data) -> Path:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def test_graph_file_has_no_tags_and_tags_file_is_source():
    raw = json.loads(COMMON_GRAPH.read_text(encoding="utf-8"))
    tags = json.loads(TAGS_FILE.read_text(encoding="utf-8"))
    assert "tags" not in raw
    assert isinstance(tags["version"], str) and [t["id"] for t in tags["tags"]] == TAG_ORDER


def test_load_common_graph_merges_sibling_tags_in_order():
    from app.config import load_common_graph

    g = load_common_graph(COMMON_GRAPH)
    tags = json.loads(TAGS_FILE.read_text(encoding="utf-8"))["tags"]
    assert g["tags"] == tags
    assert [t["id"] for t in g["tags"]] == TAG_ORDER
    assert g["nodes"] == json.loads(COMMON_GRAPH.read_text(encoding="utf-8"))["nodes"]


def test_load_common_graph_tags_path_override(tmp_path):
    from app.config import load_common_graph

    graph = _write(tmp_path / "g.json", {"domain": "d", "nodes": [{"id": "n", "label": "N", "facts": ["f"], "tags": ["x"], **PROV}]})
    other = _write(tmp_path / "other.json", {"version": "v", "tags": [{"id": "x", "label": "엑스"}]})
    assert load_common_graph(graph, other)["tags"] == [{"id": "x", "label": "엑스"}]


def test_load_common_graph_rejects_unknown_tag_id(tmp_path):
    from app.config import load_common_graph

    graph = _write(tmp_path / "g.json", {"domain": "d", "nodes": [{"id": "n", "label": "N", "facts": ["f"], "tags": ["x", "no_such_tag"]}]})
    _write(tmp_path / "tags.json", {"version": "v", "tags": [{"id": "x", "label": "엑스"}]})
    with pytest.raises(ValueError, match="no_such_tag"):
        load_common_graph(graph)


def test_load_common_graph_rejects_bad_tags_file(tmp_path):
    from app.config import load_common_graph

    graph = _write(tmp_path / "g.json", {"domain": "d", "nodes": []})
    _write(tmp_path / "tags.json", {"version": "v", "tags": [{"id": "x", "label": "A"}, {"id": "x", "label": "B"}]})
    with pytest.raises(ValueError, match="중복"):
        load_common_graph(graph)
    _write(tmp_path / "tags.json", {"version": "v", "tags": [{"id": "x"}]})
    with pytest.raises(ValueError, match="label"):
        load_common_graph(graph)
    _write(tmp_path / "tags.json", {"tags": []})
    with pytest.raises(ValueError, match="version"):
        load_common_graph(graph)
    (tmp_path / "tags.json").unlink()
    with pytest.raises(OSError):
        load_common_graph(graph)


def test_load_common_graph_keeps_inline_tags_for_compat(tmp_path):
    # 하위 호환: 그래프에 tags가 이미 있으면 태그 파일 없이 그대로 쓴다
    from app.config import load_common_graph

    graph = _write(tmp_path / "g.json", {"domain": "d", "tags": [{"id": "x", "label": "엑스"}], "nodes": []})
    assert load_common_graph(graph)["tags"] == [{"id": "x", "label": "엑스"}]


def test_settings_tags_path_default_next_to_graph_and_env_override():
    from app.config import Settings

    assert Settings.from_env({}).tags_path == str(TAGS_FILE)
    assert Settings.from_env({"COMMON_GRAPH_PATH": "/x/maplestory.json"}).tags_path == "/x/tags.json"
    assert Settings.from_env({"COMMON_GRAPH_PATH": "/x/maplestory.json", "TAGS_PATH": "/y/t.json"}).tags_path == "/y/t.json"
    s = Settings(gemini_api_key=None, workspace="w", workspace_version="v", rate_limit_per_min=1,
                 common_graph_path="/z/maplestory.json")
    assert s.tags_path == "/z/tags.json"


def test_settings_common_graph_uses_loader():
    from app.config import Settings

    g = Settings.from_env({}).common_graph()
    assert [t["id"] for t in g["tags"]] == TAG_ORDER


def test_rule9_extract_and_keyword_vocab_come_from_tags_file():
    """규칙 9: 추출 어휘와 질의 키워드 프롬프트 어휘가 같은 tags.json에서 나온다."""
    from app.config import load_common_graph
    from app.extract import controlled_vocabulary
    from app.prompts import build_keyword_prompt

    g = load_common_graph(COMMON_GRAPH)
    labels = [t["label"] for t in json.loads(TAGS_FILE.read_text(encoding="utf-8"))["tags"]]
    assert controlled_vocabulary(g) == labels
    system, user = build_keyword_prompt("문장", None, g["tags"])
    prompt = system + user
    for label in labels:
        assert f"- {label}" in prompt


def test_app_pipeline_reads_graph_through_loader(monkeypatch, tmp_path):
    """그래프를 주입하지 않으면 main이 load_common_graph로 읽는다(태그 파일까지)."""
    from fastapi.testclient import TestClient

    from app import main as main_mod
    from app.config import Settings, load_common_graph
    from fakes import FakeLLM, FakeRetriever

    calls = []

    def spy(path, tags_path=None):
        calls.append((str(path), tags_path))
        return load_common_graph(path, tags_path)

    monkeypatch.setattr(main_mod, "load_common_graph", spy)
    s = Settings(gemini_api_key=None, workspace="w", workspace_version="v", rate_limit_per_min=30,
                 common_graph_path=str(COMMON_GRAPH))
    graph = load_common_graph(COMMON_GRAPH)
    app = main_mod.create_app(deps={"settings": s, "llm": FakeLLM(), "retriever": FakeRetriever(graph)})
    TestClient(app).post("/v1/analogy", json={"sentence": "강화할수록 확률이 낮아져요."},
                         headers={"X-Install-Token": "install-tags"})
    assert calls == [(str(COMMON_GRAPH), str(TAGS_FILE))]


def test_docker_compose_sets_tags_path_in_mounted_dir():
    compose = (REPO_ROOT / "server" / "docker-compose.yml").read_text("utf-8")
    assert "TAGS_PATH: /data/common/tags.json" in compose
    assert "../extension/data/common:/data/common:ro" in compose
    assert TAGS_FILE.is_file()
