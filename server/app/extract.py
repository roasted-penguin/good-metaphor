"""맥 Ollama 추출 노드용 LightRAG 추출 설정(T-412)과 목록 밖 추상구조 후처리.

lightrag-hku 1.5.7 기준(설치된 소스로 확인).
- 엔티티 유형: 1.5.7에는 `addon_params["entity_types"]`가 없다(ENTITY_TYPES 환경변수는 오히려 SystemExit).
  유형 안내는 `addon_params["entity_types_guidance"]` 문자열 하나로 넘기고, 추출 system·user 프롬프트의
  `---Entity Types---` 자리에 그대로 들어간다. 그래서 통제 어휘·용어 사전·"목록 밖 추상구조 금지" 지시도 여기에 싣는다.
- 출력 언어: `addon_params["language"]`(기본 "English").
- JSON 모드: `LightRAG(entity_extraction_use_json=True)`(환경변수 `ENTITY_EXTRACTION_USE_JSON=true`와 같다).
  이때 프롬프트는 `PROMPTS["entity_extraction_json_system_prompt"]`와 `PROMPTS["entity_extraction_json_examples"]`를 쓴다.
- 예시: addon_params로는 못 넘긴다(ENTITY_TYPE_PROMPT_FILE YAML 또는 전역 PROMPTS뿐). 전역을 잠깐 바꾸는
  `extraction_prompts()` 컨텍스트 매니저로 감싸고, 나갈 때 되돌린다.

규칙 9: 통제 어휘는 공통 그래프 tags에서만 만든다(app.prompts.vocabulary_tags, 질의 키워드 프롬프트와 같은 함수).
규칙 2·11: 예시는 공통 그래프 facts 범위 안 사실만 쓰고, 수치·확률·멸칭·실존 인물을 넣지 않는다.
"""
from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterable, Iterator, Mapping

from app.prompts import tag_lines, vocabulary_tags
from app.seed import TAG_ENTITY_TYPE

ENTITY_TYPES: list[str] = ["게임시스템", "재화", "아이템", "보스", "지역", "추상구조"]
# 마지막 "추상구조"는 시드 주입의 태그 엔티티 유형(app.seed.TAG_ENTITY_TYPE)과 같아야 한다(테스트가 확인).

EXTRACTION_LANGUAGE = "Korean"

_ENTITY_TYPE_DESC = {
    "게임시스템": "강화·성장·전투 같은 게임 규칙이나 콘텐츠",
    "재화": "게임 안에서 돈처럼 주고받는 것",
    "아이템": "얻거나 사고팔거나 쓰는 물건·소모품·장비",
    "보스": "잡아서 보상을 얻는 강한 몬스터",
    "지역": "맵·지역 이름",
    "추상구조": "게임 밖에서도 통하는 일반 구조. 아래 [통제 어휘] 라벨만 쓴다",
}


def controlled_vocabulary(graph: Mapping[str, Any]) -> list[str]:
    """통제 어휘 = 공통 그래프 tags의 라벨(파일 순서). 질의 키워드 프롬프트와 같은 목록."""
    return [t["label"] for t in vocabulary_tags(graph.get("tags", []))]


def glossary(graph: Mapping[str, Any]) -> list[str]:
    """메이플 용어 사전: 노드마다 "라벨: facts 첫 문장" 한 줄. 은어·별칭은 T-114에서 넓힌다."""
    return [f"{n['label']}: {n['facts'][0]}" for n in graph.get("nodes", []) if n.get("label") and n.get("facts")]


def _entity_types_guidance(graph: Mapping[str, Any]) -> str:
    return "\n".join([
        "각 엔티티의 type은 아래 6개 중 하나만 쓴다. 맞는 것이 없으면 그 엔티티는 뽑지 않는다.",
        *[f"- {t}: {_ENTITY_TYPE_DESC[t]}" for t in ENTITY_TYPES],
        "",
        "[통제 어휘] 추상구조 엔티티의 name은 아래 라벨 중 하나를 글자 그대로 쓴다.",
        "목록 밖 추상구조는 만들지 않는다. 맞는 라벨이 없으면 추상구조 엔티티와 그 관계를 빼고 출력한다.",
        *tag_lines(graph.get("tags", [])),
        "",
        "[메이플 용어 사전] 입력에 이 용어가 나오면 같은 이름으로 쓴다. 사전 내용은 입력에 없는 사실을 지어내는 데 쓰지 않는다.",
        *[f"- {line}" for line in glossary(graph)],
    ])


def _example(n: int, text: str, entities: list[dict[str, str]], relationships: list[dict[str, str]]) -> str:
    body = json.dumps({"entities": entities, "relationships": relationships}, ensure_ascii=False, indent=2)
    return f"예시 {n} 입력: {text}\n예시 {n} 출력:\n{body}"


def _examples() -> list[str]:
    """메이플 가이드 문장 → 엔티티·관계 JSON 예시 2개. 사실은 공통 그래프 facts 안에서만(규칙 2)."""
    return [
        _example(
            1,
            "스타포스 강화는 메소를 내고 장비에 별을 붙여 능력치를 올리는 강화 시스템이다. "
            "별이 높아질수록 성공 확률은 낮아지고 한 번 시도하는 메소 비용은 커진다.",
            [
                {"name": "스타포스 강화", "type": "게임시스템", "description": "메소를 내고 장비에 별을 붙여 능력치를 올리는 강화 시스템이다."},
                {"name": "메소", "type": "재화", "description": "스타포스 강화를 시도할 때 내는 게임 내 화폐이다."},
                {"name": "확률형 강화", "type": "추상구조", "description": "단계가 높아질수록 성공 확률이 낮아지는 강화 구조이다."},
                {"name": "단계별 비용 증가", "type": "추상구조", "description": "단계가 오를수록 한 번 시도하는 비용이 커지는 구조이다."},
            ],
            [
                {"source": "스타포스 강화", "target": "메소", "keywords": "비용", "description": "스타포스 강화는 시도할 때마다 메소를 비용으로 쓴다."},
                {"source": "스타포스 강화", "target": "확률형 강화", "keywords": "확률, 강화", "description": "별이 높아질수록 성공 확률이 낮아진다."},
                {"source": "스타포스 강화", "target": "단계별 비용 증가", "keywords": "비용 증가", "description": "별이 높아질수록 한 번 시도하는 메소 비용이 커진다."},
            ],
        ),
        _example(
            2,
            "강한 보스 중 상당수는 일주일에 한 번만 보상을 받을 수 있다. "
            "보스를 잡으면 나오는 결정석을 상점에 팔아 메소를 번다.",
            [
                {"name": "주간 보스", "type": "보스", "description": "일주일에 한 번만 보상을 받을 수 있는 강한 보스이다."},
                {"name": "결정석", "type": "아이템", "description": "보스를 잡으면 나오고 상점에 팔아 메소로 바꾸는 아이템이다."},
                {"name": "메소", "type": "재화", "description": "결정석을 팔아 버는 게임 내 화폐이다."},
                {"name": "기간당 한도", "type": "추상구조", "description": "정해진 기간마다 얻을 수 있는 양에 상한이 있는 구조이다."},
            ],
            [
                {"source": "주간 보스", "target": "결정석", "keywords": "보상", "description": "주간 보스를 잡으면 결정석이 나온다."},
                {"source": "결정석", "target": "메소", "keywords": "판매", "description": "결정석을 상점에 팔아 메소를 번다."},
                {"source": "주간 보스", "target": "기간당 한도", "keywords": "주간 제한", "description": "주간 보스 보상은 일주일에 한 번만 받을 수 있다."},
            ],
        ),
    ]


def build_extraction_config(graph: Mapping[str, Any]) -> dict[str, Any]:
    """LightRAG 1.5.7 추출 설정 조각.

    반환값:
    - addon_params: {"language", "entity_types_guidance"} — LightRAG(addon_params=...)에 그대로 넘긴다.
    - entity_extraction_use_json: True — LightRAG(entity_extraction_use_json=...)에 넘긴다.
    - prompt_overrides: 전역 PROMPTS에 잠깐 덮어쓸 값(예시 2개). extraction_prompts()로 적용한다.
    - entity_types, vocabulary, glossary: 참고·후처리용(filter_extraction에 vocabulary를 넘긴다).

    사용법(맥 추출 노드):
        cfg = build_extraction_config(graph)
        with extraction_prompts(cfg):
            rag = LightRAG(..., entity_extraction_use_json=cfg["entity_extraction_use_json"],
                           addon_params=cfg["addon_params"])
            await rag.initialize_storages()
            await rag.ainsert(text)
    LightRAG는 생성 시(그리고 addon_params가 바뀔 때) 예시를 PROMPTS에서 읽어 캐시하므로, 생성과 삽입을
    모두 컨텍스트 안에서 한다. 추출 결과의 목록 밖 추상구조는 filter_extraction(..., cfg["vocabulary"])로 버린다.
    """
    return {
        "addon_params": {
            "language": EXTRACTION_LANGUAGE,
            "entity_types_guidance": _entity_types_guidance(graph),
        },
        "entity_extraction_use_json": True,
        "prompt_overrides": {"entity_extraction_json_examples": _examples()},
        "entity_types": list(ENTITY_TYPES),
        "vocabulary": controlled_vocabulary(graph),
        "glossary": glossary(graph),
    }


@contextmanager
def extraction_prompts(config: Mapping[str, Any]) -> Iterator[None]:
    """config["prompt_overrides"]를 전역 lightrag.prompt.PROMPTS에 잠깐 덮어쓰고, 나갈 때(예외여도) 되돌린다."""
    from lightrag.prompt import PROMPTS

    overrides = config.get("prompt_overrides") or {}
    missing = object()
    saved = {k: PROMPTS.get(k, missing) for k in overrides}
    try:
        for k, v in overrides.items():
            PROMPTS[k] = list(v) if isinstance(v, list) else v
        yield
    finally:
        for k, v in saved.items():
            if v is missing:
                PROMPTS.pop(k, None)
            else:
                PROMPTS[k] = v


# --- 후처리: 목록 밖 추상구조 제거(규칙 9) ---

def _get(obj: Mapping[str, Any], *keys: str) -> Any:
    for k in keys:
        if k in obj:
            return obj[k]
    return None


def _norm_name(name: Any) -> str:
    """LightRAG가 엔티티 이름에 쓰는 정규화(normalize_entity_name)와 같게 맞춘다."""
    from lightrag.utils import normalize_entity_name

    return normalize_entity_name(str(name or "")).strip()


def _norm_type(etype: Any) -> str:
    """LightRAG처럼 공백을 지우고 소문자로."""
    return str(etype or "").strip().replace(" ", "").lower()


def filter_extraction(entities: Iterable[Mapping[str, Any]], relationships: Iterable[Mapping[str, Any]],
                      vocabulary: Iterable[str]) -> tuple[list[Any], list[Any]]:
    """추상구조인데 이름이 통제 어휘에 없는 엔티티를 버리고, 그 엔티티에 걸린 관계도 버린다.

    엔티티는 LightRAG 모양(entity_name/entity_type)이나 LLM JSON 모양(name/type), 관계는 src_id/tgt_id나
    source/target 모양을 받는다. 이름·유형은 LightRAG 정규화 뒤 비교한다. 다른 유형은 그대로 둔다. 입력은 바꾸지 않는다.
    """
    allowed = {_norm_name(v) for v in vocabulary}
    abstract = _norm_type(TAG_ENTITY_TYPE)
    kept: list[Any] = []
    dropped: set[str] = set()
    for e in entities:
        name = _norm_name(_get(e, "entity_name", "name"))
        if _norm_type(_get(e, "entity_type", "type")) == abstract and name not in allowed:
            dropped.add(name)
        else:
            kept.append(e)
    rels = [
        r for r in relationships
        if _norm_name(_get(r, "src_id", "source")) not in dropped
        and _norm_name(_get(r, "tgt_id", "target")) not in dropped
    ]
    return kept, rels
