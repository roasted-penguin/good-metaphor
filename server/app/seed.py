"""공통 그래프(maplestory.json)를 LightRAG 사용자 정의 KG(insert_custom_kg 입력)로 바꾸는 순수 함수.

모양은 lightrag-hku 1.5.7 ainsert_custom_kg 기준이다.
- chunks: {content, source_id, file_path}. 엔티티·관계의 source_id는 청크의 source_id를 가리켜야 한다
  (없으면 LightRAG가 UNKNOWN으로 바꾼다). 그래서 노드·태그마다 청크를 하나씩 만든다.
- entities: {entity_name, entity_type, description, source_id, file_path}
- relationships: {src_id, tgt_id, description, keywords, weight, source_id, file_path}.
  LightRAG는 방향 없는 (src, tgt) 쌍으로 중복을 지운다. weight는 근거 수(source_id 1개 = 1) 이상.

이름 규칙(T-402): 노드 엔티티 이름 = 노드 label. retriever.context_to_candidates가 label(또는 id)로 노드를 찾는다.
label은 사람이 읽는 이름이라 엔티티 벡터(이름 + 설명)에도 id보다 낫다. 태그 엔티티 이름 = 태그 label.
설명에는 facts·desc를 그대로 쓰고 새 사실을 만들지 않는다(규칙 1·2). 태그는 graph["tags"]만 쓴다(규칙 9).
"""
from __future__ import annotations

from typing import Any

TAG_ENTITY_TYPE = "추상구조"
NODE_ENTITY_TYPE = "게임시스템"
FILE_PATH = "common/maplestory.json"


def _node_source(node_id: str) -> str:
    return f"seed:{node_id}"


def _tag_source(tag_id: str) -> str:
    return f"seed:tag:{tag_id}"


def graph_to_custom_kg(graph: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """공통 그래프 → {chunks, entities, relationships}. 같은 입력이면 같은 출력(재실행해도 같은 이름·청크)."""
    tags = list(graph.get("tags", []))
    nodes = list(graph.get("nodes", []))
    tag_by_id = {t["id"]: t for t in tags}
    node_label = {n["id"]: n["label"] for n in nodes}

    chunks: list[dict[str, Any]] = []
    entities: list[dict[str, Any]] = []
    relationships: list[dict[str, Any]] = []

    for t in tags:
        sid = _tag_source(t["id"])
        chunks.append({"content": f"{t['label']}\n{t['desc']}", "source_id": sid, "file_path": FILE_PATH})
        entities.append({
            "entity_name": t["label"],
            "entity_type": TAG_ENTITY_TYPE,
            "description": t["desc"],
            "source_id": sid,
            "file_path": FILE_PATH,
        })

    for n in nodes:
        sid = _node_source(n["id"])
        facts = list(n.get("facts", []))
        chunks.append({"content": "\n".join([n["label"], *facts]), "source_id": sid, "file_path": FILE_PATH})
        entities.append({
            "entity_name": n["label"],
            "entity_type": NODE_ENTITY_TYPE,
            "description": "\n".join(facts),
            "source_id": sid,
            "file_path": FILE_PATH,
        })
        for tid in n.get("tags", []):
            t = tag_by_id.get(tid)
            if t is None:  # 통제 어휘 밖 태그는 버린다
                continue
            relationships.append({
                "src_id": n["label"],
                "tgt_id": t["label"],
                "description": t["desc"],
                "keywords": t["label"],
                "weight": 1.0,
                "source_id": sid,
                "file_path": FILE_PATH,
            })

    for e in graph.get("edges", []):
        src, tgt = node_label.get(e.get("from")), node_label.get(e.get("to"))
        if src is None or tgt is None:  # 그래프에 없는 노드를 가리키는 엣지는 버린다
            continue
        relationships.append({
            "src_id": src,
            "tgt_id": tgt,
            "description": e["rel"],
            "keywords": e["rel"],
            "weight": 1.0,
            "source_id": _node_source(e["from"]),
            "file_path": FILE_PATH,
        })

    return {"chunks": chunks, "entities": entities, "relationships": relationships}


def seed_counts(custom_kg: dict[str, Any]) -> dict[str, int]:
    """주입할 엔티티·관계 수."""
    return {
        "entities": len(custom_kg.get("entities", [])),
        "relationships": len(custom_kg.get("relationships", [])),
    }
