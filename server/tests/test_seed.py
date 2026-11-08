"""공통 그래프 → LightRAG 사용자 정의 KG(insert_custom_kg 입력) 변환 테스트. 실제 maplestory.json으로 확인한다."""
import copy
import json
from pathlib import Path

import pytest

from app.config import load_common_graph
from app.retriever import context_to_candidates
from app.seed import graph_to_custom_kg, seed_counts

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"


@pytest.fixture(scope="module")
def graph() -> dict:
    return load_common_graph(COMMON_GRAPH)


@pytest.fixture(scope="module")
def kg(graph) -> dict:
    return graph_to_custom_kg(graph)


def _entities_by_name(kg: dict) -> dict[str, dict]:
    return {e["entity_name"]: e for e in kg["entities"]}


def test_shape_matches_insert_custom_kg_keys(kg):
    assert set(kg) == {"chunks", "entities", "relationships"}
    for c in kg["chunks"]:
        assert {"content", "source_id"} <= set(c)
    for e in kg["entities"]:
        assert {"entity_name", "entity_type", "description", "source_id"} <= set(e)
    for r in kg["relationships"]:
        assert {"src_id", "tgt_id", "description", "keywords", "weight", "source_id"} <= set(r)


def test_entity_count_is_tags_plus_nodes_without_duplicates(graph, kg):
    names = [e["entity_name"] for e in kg["entities"]]
    assert len(names) == len(graph["tags"]) + len(graph["nodes"]) == 36
    assert len(set(names)) == len(names)


def test_tag_entities_use_controlled_vocabulary_and_desc(graph, kg):
    by_name = _entities_by_name(kg)
    tag_entities = [e for e in kg["entities"] if e["entity_type"] == "추상구조"]
    assert len(tag_entities) == len(graph["tags"])
    for t in graph["tags"]:
        e = by_name[t["label"]]
        assert e["entity_type"] == "추상구조"
        assert e["description"] == t["desc"]
        assert e["source_id"] == f"seed:tag:{t['id']}"


def test_node_entities_named_by_label_and_hold_only_facts(graph, kg):
    by_name = _entities_by_name(kg)
    for n in graph["nodes"]:
        e = by_name[n["label"]]
        assert e["entity_type"] == "게임시스템"
        assert e["source_id"] == f"seed:{n['id']}"
        for fact in n["facts"]:
            assert fact in e["description"]
        # 새 문장을 지어내지 않는다: facts(와 별칭 머리줄)를 빼고 나면 남는 글자가 없어야 한다
        rest = e["description"]
        if n.get("aliases"):
            head = f"{n['label']}({', '.join(n['aliases'])})"
            assert rest.startswith(head + "\n")
            rest = rest[len(head):]
        for fact in n["facts"]:
            rest = rest.replace(fact, "")
        assert rest.strip() == ""


def test_node_without_aliases_unchanged():
    """T-114: 별칭이 없는 노드는 설명·청크가 예전과 같다(facts만, 청크는 라벨 + facts)."""
    g = {"tags": [], "nodes": [{"id": "x", "label": "라벨", "facts": ["가.", "나."], "tags": []}], "edges": []}
    kg = graph_to_custom_kg(g)
    assert kg["entities"][0]["description"] == "가.\n나."
    assert kg["chunks"][0]["content"] == "라벨\n가.\n나."
    g["nodes"][0]["aliases"] = []
    assert graph_to_custom_kg(g) == kg


def test_node_aliases_go_after_label_in_description_and_chunk():
    """T-114: 별칭은 확장 nodeText와 같은 방식(라벨 뒤 괄호, 쉼표)으로 설명·청크 첫 줄에 붙는다. 엔티티 이름은 라벨 그대로."""
    g = {"tags": [], "nodes": [{"id": "x", "label": "스타포스 강화", "facts": ["가."], "tags": [], "aliases": ["펑", "프텍"]}], "edges": []}
    kg = graph_to_custom_kg(g)
    e = kg["entities"][0]
    assert e["entity_name"] == "스타포스 강화"
    assert e["description"] == "스타포스 강화(펑, 프텍)\n가."
    assert kg["chunks"][0]["content"] == "스타포스 강화(펑, 프텍)\n가."


def test_weak_aliases_are_left_out_of_seed():
    """T-149: 약한 별칭(weakAliases)은 설명·청크에 넣지 않는다. 약한 별칭만 있는 노드는 별칭 없는 노드와 같다."""
    g = {"tags": [], "nodes": [{"id": "x", "label": "아케인 심볼", "facts": ["가."], "tags": []}], "edges": []}
    plain = graph_to_custom_kg(g)
    g["nodes"][0]["weakAliases"] = ["세금"]
    assert graph_to_custom_kg(g) == plain
    g2 = {"tags": [], "nodes": [{"id": "y", "label": "스타포스 강화", "facts": ["가."], "tags": [], "aliases": ["프텍"], "weakAliases": ["펑"]}], "edges": []}
    kg = graph_to_custom_kg(g2)
    assert kg["entities"][0]["description"] == "스타포스 강화(프텍)\n가."
    assert "펑" not in kg["chunks"][0]["content"]


def test_common_graph_seed_has_no_weak_alias(kg):
    """공통 그래프 시드 어디에도 약한 별칭 '세금'이 없다(펑은 '펑'만 따로 보지 않고 머리줄로 확인)."""
    text = json.dumps(kg, ensure_ascii=False)
    assert "세금" not in text
    assert "스타포스 강화(프텍)" in text and "스타포스 강화(펑" not in text


def test_node_entity_names_are_found_by_retriever(graph, kg):
    """노드 엔티티 이름을 LightRAG 맥락에 넣으면 retriever가 같은 노드로 되찾는다."""
    from lightrag.utils import normalize_entity_name

    node_names = [e["entity_name"] for e in kg["entities"] if e["entity_type"] == "게임시스템"]
    # insert_custom_kg가 이름을 정규화해도 바뀌지 않아야 맥락 속 이름이 그대로 나온다
    assert all(normalize_entity_name(name) == name for name in node_names)
    lines = "\n".join(json.dumps({"entity": name}, ensure_ascii=False) for name in node_names)
    context = f"Knowledge Graph Data (Entity):\n\n```json\n{lines}\n```\n"
    found = context_to_candidates(context, graph, hl=[], top_k=len(node_names))
    assert [c.id for c in found] == [n["id"] for n in graph["nodes"]]


def test_tag_entities_are_not_mistaken_for_nodes(graph, kg):
    tag_names = [e["entity_name"] for e in kg["entities"] if e["entity_type"] == "추상구조"]
    lines = "\n".join(json.dumps({"entity": name}, ensure_ascii=False) for name in tag_names)
    context = f"Knowledge Graph Data (Entity):\n\n```json\n{lines}\n```\n"
    assert context_to_candidates(context, graph, hl=[], top_k=50) == []


def test_relationship_count_is_node_tags_plus_edges(graph, kg):
    expected = sum(len(n["tags"]) for n in graph["nodes"]) + len(graph["edges"])
    assert len(kg["relationships"]) == expected
    # LightRAG는 방향 없는 (src, tgt) 쌍으로 중복을 지우므로 쌍이 겹치면 관계가 사라진다
    pairs = {tuple(sorted((r["src_id"], r["tgt_id"]))) for r in kg["relationships"]}
    assert len(pairs) == expected


def test_node_tag_relationships_carry_tag_label(graph, kg):
    node_label = {n["id"]: n["label"] for n in graph["nodes"]}
    tag_by_id = {t["id"]: t for t in graph["tags"]}
    rels = {(r["src_id"], r["tgt_id"]): r for r in kg["relationships"]}
    for n in graph["nodes"]:
        for tid in n["tags"]:
            r = rels[(node_label[n["id"]], tag_by_id[tid]["label"])]
            assert tag_by_id[tid]["label"] in r["keywords"]
            assert r["source_id"] == f"seed:{n['id']}"


def test_edge_relationships_use_rel_as_description(graph, kg):
    node_label = {n["id"]: n["label"] for n in graph["nodes"]}
    rels = {(r["src_id"], r["tgt_id"]): r for r in kg["relationships"]}
    for e in graph["edges"]:
        r = rels[(node_label[e["from"]], node_label[e["to"]])]
        assert r["description"] == e["rel"]
        assert r["source_id"] == f"seed:{e['from']}"


def test_every_source_id_is_seed_and_backed_by_a_chunk(kg):
    chunk_ids = [c["source_id"] for c in kg["chunks"]]
    assert len(set(chunk_ids)) == len(chunk_ids)
    used = [x["source_id"] for x in kg["entities"] + kg["relationships"]]
    for sid in chunk_ids + used:
        assert sid.startswith("seed:")
    # 청크가 없는 source_id는 LightRAG가 UNKNOWN으로 바꾼다
    assert set(used) <= set(chunk_ids)


def test_node_chunk_holds_label_and_facts(graph, kg):
    chunks = {c["source_id"]: c for c in kg["chunks"]}
    for n in graph["nodes"]:
        content = chunks[f"seed:{n['id']}"]["content"]
        assert n["label"] in content
        for fact in n["facts"]:
            assert fact in content


def test_relationship_weights_meet_evidence_floor(kg):
    # source_id 하나 = 근거 1개라 weight는 1 이상이어야 insert_custom_kg가 받는다
    assert all(r["weight"] >= 1.0 for r in kg["relationships"])


def test_deterministic_and_input_untouched(graph):
    before = copy.deepcopy(graph)
    assert graph_to_custom_kg(graph) == graph_to_custom_kg(graph)
    assert graph == before


def test_unknown_node_tag_is_dropped():
    """규칙 9: tags 목록 밖 태그는 엔티티도 관계도 만들지 않는다."""
    g = {
        "tags": [{"id": "t1", "label": "태그1", "desc": "설명1"}],
        "nodes": [{"id": "n1", "label": "노드1", "facts": ["사실1."], "tags": ["t1", "zz"]}],
        "edges": [],
    }
    kg = graph_to_custom_kg(g)
    assert seed_counts(kg) == {"entities": 2, "relationships": 1}


def test_seed_counts(graph, kg):
    expected_rels = sum(len(n["tags"]) for n in graph["nodes"]) + len(graph["edges"])
    assert seed_counts(kg) == {"entities": 36, "relationships": expected_rels}


def test_self_loop_edge_is_dropped():
    """LightRAG는 src == tgt 관계를 받지 않고 주입 전체를 멈춘다. 자기 자신을 가리키는 엣지는 버린다."""
    g = {
        "tags": [],
        "nodes": [{"id": "n1", "label": "노드1", "facts": ["사실1."], "tags": []},
                  {"id": "n2", "label": "노드2", "facts": ["사실2."], "tags": []}],
        "edges": [{"from": "n1", "to": "n1", "rel": "자기"}, {"from": "n1", "to": "n2", "rel": "이어짐"}],
    }
    kg = graph_to_custom_kg(g)
    assert [(r["src_id"], r["tgt_id"]) for r in kg["relationships"]] == [("노드1", "노드2")]


# --- T-118 출처(sources)·검수 날짜(verifiedAt) ---

def test_provenance_fields_do_not_change_seed(graph):
    """sources·verifiedAt은 사실이 아니라 메타데이터다. 있어도 없어도 KG가 똑같다(URL이 설명·청크에 섞이지 않음)."""
    with_prov = copy.deepcopy(graph)
    for n in with_prov["nodes"]:
        n["sources"] = ["https://maplestory.nexon.com/News/Update/799"]
        n["verifiedAt"] = "2026-10-11"
    without = copy.deepcopy(graph)
    for n in without["nodes"]:
        n.pop("sources", None)
        n.pop("verifiedAt", None)
    assert graph_to_custom_kg(with_prov) == graph_to_custom_kg(without)
    text = json.dumps(graph_to_custom_kg(with_prov), ensure_ascii=False)
    assert "maplestory.nexon.com" not in text and "2026-10-11" not in text


def test_real_graph_nodes_have_provenance(graph):
    """확장 validateGraph와 같은 규칙: 공통 노드마다 공식 출처 1개 이상 + YYYY-MM-DD 검수 날짜."""
    import re
    from datetime import date

    for n in graph["nodes"]:
        assert n.get("sources"), n["id"]
        assert all(u.startswith("https://maplestory.nexon.com/") for u in n["sources"]), n["id"]
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", n["verifiedAt"]), n["id"]
        date.fromisoformat(n["verifiedAt"])
