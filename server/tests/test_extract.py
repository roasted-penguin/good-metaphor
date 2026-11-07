"""추출 설정(T-412) 테스트: 통제 어휘·용어 사전·LightRAG 설정 조각·목록 밖 추상구조 후처리.

네트워크·LLM 호출 없이 돈다. LightRAG는 생성만 하고(LLM 금지 함수) 추출은 부르지 않는다.
"""
import json
from pathlib import Path

import pytest
from lightrag.prompt import PROMPTS

from app.extract import (
    ENTITY_TYPES,
    build_extraction_config,
    controlled_vocabulary,
    extraction_prompts,
    filter_extraction,
    glossary,
)
from app.prompts import build_keyword_prompt

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"

# 규칙 11 금칙 단어(docs/naming-meme.md의 멸칭·실존 인물). 테스트 안에만 둔다.
BANNED_WORDS = ["쌀숭이", "리선족", "신창섭"]


@pytest.fixture(scope="module")
def graph() -> dict:
    return json.loads(COMMON_GRAPH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def config(graph) -> dict:
    return build_extraction_config(graph)


def _all_text(config: dict) -> str:
    """설정에 들어간 모든 문자열(지시·예시)을 한 덩어리로."""
    return json.dumps(config, ensure_ascii=False)


# --- 통제 어휘(규칙 9) ---

def test_vocabulary_is_graph_tag_labels_in_file_order(graph):
    vocab = controlled_vocabulary(graph)
    assert vocab == [t["label"] for t in graph["tags"]]
    assert len(vocab) == 18


def test_vocabulary_matches_keyword_prompt_tag_list(graph):
    """추출 어휘와 질의 키워드 프롬프트의 [추상 태그] 목록이 같은 목록·같은 순서여야 한다."""
    system, _ = build_keyword_prompt("문장", "", graph["tags"])
    section = system.split("[추상 태그]\n", 1)[1]
    labels_in_prompt = [line[2:].split(":", 1)[0] for line in section.splitlines() if line.startswith("- ")]
    assert labels_in_prompt == controlled_vocabulary(graph)


def test_vocabulary_follows_graph_not_hardcoded():
    fake = {"tags": [{"id": "x", "label": "가짜 태그", "desc": "설명"}], "nodes": []}
    assert controlled_vocabulary(fake) == ["가짜 태그"]


# --- 용어 사전 ---

def test_glossary_one_line_per_node_with_first_fact(graph):
    lines = glossary(graph)
    assert len(lines) == len(graph["nodes"]) == 18
    for line, node in zip(lines, graph["nodes"]):
        assert line == f"{node['label']}: {node['facts'][0]}"


def test_glossary_and_config_have_no_banned_words(graph, config):
    text = "\n".join(glossary(graph)) + _all_text(config)
    for word in BANNED_WORDS:
        assert word not in text


# --- LightRAG 설정 조각 ---

def test_entity_types_exact():
    from app.seed import TAG_ENTITY_TYPE

    assert ENTITY_TYPES == ["게임시스템", "재화", "아이템", "보스", "지역", "추상구조"]
    assert TAG_ENTITY_TYPE in ENTITY_TYPES


def test_config_json_mode_and_language(config):
    assert config["entity_extraction_use_json"] is True
    assert config["addon_params"]["language"] == "Korean"


def test_guidance_lists_entity_types_vocabulary_glossary_and_ban(graph, config):
    guidance = config["addon_params"]["entity_types_guidance"]
    for t in ENTITY_TYPES:
        assert f"- {t}" in guidance
    for label in controlled_vocabulary(graph):
        assert f"- {label}" in guidance
    for line in glossary(graph):
        assert line in guidance
    assert "목록 밖" in guidance and "추상구조" in guidance
    # 키워드 프롬프트처럼 통제 어휘에는 태그 설명도 붙는다
    first = graph["tags"][0]
    assert f"- {first['label']}: {first['desc']}" in guidance


def test_config_has_two_examples_using_allowed_types_and_vocabulary(graph, config):
    examples = config["prompt_overrides"]["entity_extraction_json_examples"]
    assert len(examples) == 2
    vocab = set(controlled_vocabulary(graph))
    for ex in examples:
        body = json.loads(ex[ex.index("{"):])
        assert body["entities"] and body["relationships"]
        names = {e["name"] for e in body["entities"]}
        for e in body["entities"]:
            assert e["type"] in ENTITY_TYPES
            if e["type"] == "추상구조":
                assert e["name"] in vocab
        assert any(e["type"] == "추상구조" for e in body["entities"])
        for r in body["relationships"]:
            assert r["source"] in names and r["target"] in names


def test_extraction_prompts_restores_global_prompts(config):
    before = {k: (list(v) if isinstance(v, list) else v) for k, v in PROMPTS.items()}
    with extraction_prompts(config):
        assert PROMPTS["entity_extraction_json_examples"] == config["prompt_overrides"]["entity_extraction_json_examples"]
    assert PROMPTS == before


def test_extraction_prompts_restores_on_error(config):
    before = list(PROMPTS["entity_extraction_json_examples"])
    with pytest.raises(RuntimeError):
        with extraction_prompts(config):
            raise RuntimeError("중간 실패")
    assert PROMPTS["entity_extraction_json_examples"] == before


def test_lightrag_accepts_config_and_formats_system_prompt(tmp_path, config):
    """실제 LightRAG 1.5.7이 설정을 받아 프롬프트 프로필에 반영하는지(LLM 호출 없음)."""
    from lightrag import LightRAG

    from app.config import Settings
    from app.rag import forbidden_llm, make_embedding_func, make_tokenizer

    settings = Settings.from_env({"LIGHTRAG_WORKING_DIR": str(tmp_path)})
    with extraction_prompts(config):
        rag = LightRAG(
            working_dir=str(tmp_path),
            workspace="t412",
            llm_model_func=forbidden_llm,
            embedding_func=make_embedding_func(settings),
            tokenizer=make_tokenizer(),
            entity_extraction_use_json=config["entity_extraction_use_json"],
            addon_params=config["addon_params"],
        )
    profile = rag._entity_extraction_prompt_profile
    assert profile["entity_types_guidance"] == config["addon_params"]["entity_types_guidance"].rstrip()
    assert profile["entity_extraction_json_examples"] == [
        ex.rstrip() for ex in config["prompt_overrides"]["entity_extraction_json_examples"]
    ]
    # operate.extract_entities가 하는 것처럼 system 프롬프트를 채워도 깨지지 않는다
    system = PROMPTS["entity_extraction_json_system_prompt"].format(
        entity_types_guidance=profile["entity_types_guidance"],
        examples="\n".join(profile["entity_extraction_json_examples"]),
        language="Korean",
        max_total_records=40,
        max_entity_records=20,
    )
    assert "확률형 강화" in system and "스타포스 강화" in system


# --- 후처리: 목록 밖 추상구조 제거 ---

VOCAB = ["확률형 강화", "단계별 비용 증가"]


def _ent(name, etype):
    return {"entity_name": name, "entity_type": etype, "description": "설명"}


def _rel(src, tgt):
    return {"src_id": src, "tgt_id": tgt, "description": "관계", "keywords": "k"}


def test_filter_drops_off_vocabulary_abstract_entity_and_its_relationships():
    entities = [_ent("스타포스 강화", "게임시스템"), _ent("확률형 강화", "추상구조"), _ent("지어낸 구조", "추상구조")]
    relationships = [
        _rel("스타포스 강화", "확률형 강화"),
        _rel("스타포스 강화", "지어낸 구조"),
        _rel("지어낸 구조", "확률형 강화"),
    ]
    ents, rels = filter_extraction(entities, relationships, VOCAB)
    assert [e["entity_name"] for e in ents] == ["스타포스 강화", "확률형 강화"]
    assert [(r["src_id"], r["tgt_id"]) for r in rels] == [("스타포스 강화", "확률형 강화")]


def test_filter_keeps_other_types_even_if_not_in_vocabulary():
    entities = [_ent("메소", "재화"), _ent("결정석", "아이템"), _ent("아케인리버", "지역")]
    relationships = [_rel("메소", "결정석")]
    ents, rels = filter_extraction(entities, relationships, VOCAB)
    assert ents == entities
    assert rels == relationships


def test_filter_uses_lightrag_name_normalization():
    """따옴표·전각 공백·대소문자 정규화 뒤 어휘와 같으면 남긴다(LightRAG는 유형을 소문자로 바꾼다)."""
    entities = [_ent('"확률형 강화"', "추상구조"), _ent("단계별　비용 증가", " 추상구조 ")]
    relationships = [_rel('"확률형 강화"', "단계별　비용 증가")]
    ents, rels = filter_extraction(entities, relationships, VOCAB)
    assert len(ents) == 2
    assert len(rels) == 1


def test_filter_accepts_raw_json_shape():
    """LLM JSON 응답 모양(name/type, source/target)도 받는다."""
    entities = [{"name": "스타포스 강화", "type": "게임시스템"}, {"name": "운빨", "type": "추상구조"}]
    relationships = [{"source": "스타포스 강화", "target": "운빨"}]
    ents, rels = filter_extraction(entities, relationships, VOCAB)
    assert ents == [entities[0]]
    assert rels == []


def test_filter_does_not_mutate_inputs():
    entities = [_ent("지어낸 구조", "추상구조")]
    relationships = [_rel("a", "지어낸 구조")]
    filter_extraction(entities, relationships, VOCAB)
    assert len(entities) == 1 and len(relationships) == 1
