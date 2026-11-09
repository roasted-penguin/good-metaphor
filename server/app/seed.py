"""공통 그래프(maplestory.json + tags.json, config.load_common_graph로 합친 것)를 LightRAG 사용자 정의 KG(insert_custom_kg 입력)로 바꾸는 순수 함수.

모양은 lightrag-hku 1.5.7 ainsert_custom_kg 기준이다.
- chunks: {content, source_id, file_path}. 엔티티·관계의 source_id는 청크의 source_id를 가리켜야 한다
  (없으면 LightRAG가 UNKNOWN으로 바꾼다). 그래서 노드·태그마다 청크를 하나씩 만든다.
- entities: {entity_name, entity_type, description, source_id, file_path}
- relationships: {src_id, tgt_id, description, keywords, weight, source_id, file_path}.
  LightRAG는 방향 없는 (src, tgt) 쌍으로 중복을 지운다. weight는 근거 수(source_id 1개 = 1) 이상.

이름 규칙(T-402): 노드 엔티티 이름 = 노드 label. retriever.context_to_candidates가 label(또는 id)로 노드를 찾는다.
label은 사람이 읽는 이름이라 엔티티 벡터(이름 + 설명)에도 id보다 낫다. 태그 엔티티 이름 = 태그 label.
설명에는 facts·desc를 그대로 쓰고 새 사실을 만들지 않는다(규칙 1·2). 노드 별칭(aliases)은 라벨 뒤 괄호로만 붙인다(T-114). 태그는 graph["tags"](원본 tags.json)만 쓴다(규칙 9).
"""
from __future__ import annotations

import shutil
from contextlib import ExitStack
from typing import Any

TAG_ENTITY_TYPE = "추상구조"
NODE_ENTITY_TYPE = "게임시스템"
FILE_PATH = "common/maplestory.json"


def _node_source(node_id: str) -> str:
    return f"seed:{node_id}"


def _tag_source(tag_id: str) -> str:
    return f"seed:tag:{tag_id}"


def label_with_aliases(node: dict[str, Any]) -> str:
    """라벨 뒤 괄호에 별칭(게임 은어)을 붙인다: "스타포스 강화(펑, 프텍)" (T-114).

    서버는 별칭을 엔티티 설명·청크 글에 넣어 LightRAG가 검색하게 한다. 확장은 nodeText에 넣지 않고
    검색 어휘 가산(retrieval.js aliasBoost)으로 쓴다(임베딩 벡터·기존 검색 결과를 바꾸지 않으려고).
    약한 별칭(weakAliases: 펑·세금처럼 일상어와 겹치는 은어)은 넣지 않는다. 텍스트에 넣으면 일상어 문장이 서버 검색에서
    그 노드로 끌린다(T-149). 확장은 메이플 단서가 있을 때만 가산한다.
    """
    aliases = node.get("aliases") or []
    return f"{node['label']}({', '.join(aliases)})" if aliases else node["label"]


def _entity_key(name: str) -> str:
    """LightRAG ainsert_custom_kg가 엔티티 이름에 쓰는 정규화(1.5.7 normalize_entity_name)와 같은 키."""
    from lightrag.utils import normalize_entity_name  # 무거운 패키지라 쓸 때만 불러온다

    return normalize_entity_name(name)


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
        head = label_with_aliases(n)
        chunks.append({"content": "\n".join([head, *facts]), "source_id": sid, "file_path": FILE_PATH})
        # 별칭이 있으면 설명 첫 줄에 "라벨(별칭들)"을 둔다. 없으면 예전처럼 facts만(T-114)
        entities.append({
            "entity_name": n["label"],
            "entity_type": NODE_ENTITY_TYPE,
            "description": "\n".join([head, *facts] if n.get("aliases") else facts),
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
        # 자기 자신 엣지: LightRAG가 예외로 주입 전체를 멈춘다. id가 달라도 라벨(엔티티 이름)이 LightRAG 정규화
        # (앞뒤 공백·따옴표·전각 괄호 등) 뒤 같으면 같은 엔티티라 자기 자신 관계가 된다. 그래서 정규화 이름으로 비교한다(T-140)
        if _entity_key(src) == _entity_key(tgt):
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


RESET_WORKER_RUNNING = "추출 워커가 돌고 있어 리셋할 수 없어요. 서버를 멈춘 뒤 다시 해 주세요."


def _hold_worker_lock(stack: ExitStack, settings: Any) -> None:
    """리셋 동안 worker.lock을 기다리지 않고 쥔다(stack이 닫힐 때 푼다). 워커(서버 안 루프·--once)가 돌고 있으면 SeedRefused(T-161)."""
    from app.extract_worker import WorkerLocked, worker_lock
    from app.seedmeta import SeedRefused

    try:
        stack.enter_context(worker_lock(settings))
    except WorkerLocked as e:
        raise SeedRefused(RESET_WORKER_RUNNING) from e


def _read_queue_or_refuse(settings: Any) -> list[dict[str, Any]]:
    """리셋 전 추출 큐. 깨졌으면 지우면 처리 전 문서를 잃으니 SeedRefused(파일 경로를 알려 준다)."""
    from app.extract_worker import QueueError, queue_path, read_queue_for_reset
    from app.seedmeta import SeedRefused

    try:
        return read_queue_for_reset(settings, settings.workspace)
    except QueueError as e:
        raise SeedRefused(f"추출 큐 파일이 깨져 리셋하지 않았어요(지우면 처리 전 문서를 잃어요): "
                          f"{queue_path(settings, settings.workspace)}. 고치거나 옮긴 뒤 다시 해 주세요.") from e


def seed_counts(custom_kg: dict[str, Any]) -> dict[str, int]:
    """주입할 엔티티·관계 수."""
    return {
        "entities": len(custom_kg.get("entities", [])),
        "relationships": len(custom_kg.get("relationships", [])),
    }


async def seed(settings: Any, reset: bool = False) -> dict[str, Any]:
    """공통 그래프를 LightRAG 워크스페이스에 넣고, 그래프 저장소에 실제로 있는 엔티티·관계 수를 돌려준다.

    멱등: ainsert_custom_kg(1.5.7)는 엔티티·관계·청크를 이름/쌍/내용 해시로 덮어쓴다(설명을 이어 붙이지 않는다).
    그래서 같은 그래프를 다시 넣어도 수와 설명이 그대로다(test_seed_inject가 확인).

    reset=True면 워크스페이스 폴더를 지우고 새로 넣는다(그래프 판본·임베딩이 바뀌었을 때, 시드는 덮어쓰기만 해서).
    시작할 때 옛 seed-meta.json을 지우고, 끝까지 성공하면 새로 쓴다(T-140). 중간에 실패하면 메타가 없어
    서버가 이 인덱스를 열지 않는다.

    리셋은 추출 큐(extract-queue.json)를 지우지 않는다(T-161): 폴더를 지우기 전에 읽어 두고, 새 폴더에 되돌려 쓴다.
    인덱스가 지워졌으니 done 청크는 pending(시도 0)으로, failed는 그대로. extract-results/는 인덱스와 함께 지워진다.
    추출 워커가 돌고 있으면(worker.lock) 거절하고, 시드가 끝날 때까지 잠금을 쥐어 워커가 끼어들지 못하게 한다.
    큐 파일이 깨졌으면 처리 전 문서를 잃지 않게 거절한다. 둘 다 아무것도 지우지 않는다.
    """
    from app.config import load_common_graph
    from app.rag import open_rag  # LightRAG는 무거워서 실제로 넣을 때만 불러온다
    from app.seedmeta import check_can_seed, remove_seed_meta, safe_workspace_dir, write_seed_meta

    # 태그는 tags.json에서 온다(T-304, 규칙 9). 합치는 곳은 load_common_graph 하나
    graph = load_common_graph(settings.common_graph_path, getattr(settings, "tags_path", None))
    custom_kg = graph_to_custom_kg(graph)
    # 판본을 모르거나, --reset 없이 옛·다른 설정의 인덱스 위에 넣으려 하면 SeedRefused(아무것도 건드리지 않는다)
    check_can_seed(settings, reset)
    with ExitStack() as stack:
        if reset:
            _hold_worker_lock(stack, settings)
            # 처리 전 문서를 잃지 않게 큐를 먼저 읽는다(깨졌으면 여기서 거절, 아직 아무것도 안 지움)
            queue = _read_queue_or_refuse(settings)
            # 작업 디렉터리 바로 아래 폴더만(심볼릭 링크·밖 경로는 WorkspaceError). 없는 것만 괜찮고 다른 오류는 시드를 멈춘다
            try:
                shutil.rmtree(safe_workspace_dir(settings))
            except FileNotFoundError:
                pass
            from app.extract_worker import restore_queue_after_reset

            restore_queue_after_reset(settings, settings.workspace, queue)
        remove_seed_meta(settings)
        rag = await open_rag(settings)
        try:
            await rag.ainsert_custom_kg(custom_kg)
            store = rag.chunk_entity_relation_graph
            nodes = await store.get_all_nodes()
            edges = await store.get_all_edges()
        finally:
            await rag.finalize_storages()
        # 저장소를 다 닫은(파일에 쓴) 뒤에 기록한다
        write_seed_meta(settings)
    return {
        "entities": len(nodes),
        "relationships": len(edges),
        "workspace": settings.workspace,
        "working_dir": settings.lightrag_working_dir,
    }


def main(argv: list[str] | None = None) -> None:
    import argparse
    import asyncio
    import logging
    import sys

    import lightrag.utils  # noqa: F401  불러올 때 로거를 INFO로 다시 맞추므로 먼저 불러 둔다

    from app.config import Settings

    # LightRAG·nano-vectordb의 INFO 로그는 줄이고 경고 이상만 남긴다(출력은 요약 한 줄)
    for name in ("lightrag", "nano-vectordb"):
        logging.getLogger(name).setLevel(logging.WARNING)

    parser = argparse.ArgumentParser(prog="python -m app.seed", description="공통 그래프를 LightRAG 인덱스에 넣어요.")
    parser.add_argument("--reset", action="store_true",
                        help="워크스페이스 폴더를 지우고 새로 넣어요(그래프 판본·임베딩이 바뀌었을 때)")
    args = parser.parse_args(argv)
    from app.seedmeta import SeedRefused, WorkspaceError

    try:
        out = asyncio.run(seed(Settings.from_env(), reset=args.reset))
    except (SeedRefused, WorkspaceError) as e:
        # 설정·상태 문제는 한 줄 한국어로(트레이스백 없이) 알리고 0이 아닌 코드로 끝낸다
        print(f"시드하지 않았어요: {e}", file=sys.stderr)
        raise SystemExit(2) from None
    print(f"시드 주입 완료: 엔티티 {out['entities']}, 관계 {out['relationships']}, "
          f"워크스페이스 {out['workspace']}, 작업 디렉터리 {out['working_dir']}")


if __name__ == "__main__":
    main()
