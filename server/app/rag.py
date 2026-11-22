"""LightRAG 인스턴스 만들기: 임베딩 함수(해시·Ollama), LLM 금지 함수, open_rag.

lightrag-hku 1.5.7 기준.
- LightRAG(...)는 llm_model_func가 없으면 생성 자체가 안 된다. 시드 주입(ainsert_custom_kg)과
  검색(only_need_context + 키워드 직접 전달)은 LLM을 쓰지 않으므로, 불리면 예외를 던지는 함수를 넘긴다.
- initialize_storages()가 워크스페이스 파이프라인 상태(initialize_pipeline_status)까지 초기화한다.
- 기본 저장소(JSON KV, NanoVectorDB, NetworkX)는 working_dir/<workspace>/ 아래 파일로 남는다.
"""
from __future__ import annotations

import hashlib
import logging
import re
from typing import Any

import httpx
import numpy as np
from lightrag import LightRAG
from lightrag.utils import EmbeddingFunc, Tokenizer

from app.config import Settings
# 인덱스 파일·시드 메타 판정은 LightRAG 없이 도는 seedmeta에 있다(여기서는 예전 이름 그대로 다시 내보낸다)
from app.seedmeta import HASH_MODEL_NAME, INDEX_FILES, index_exists, index_status, workspace_dir  # noqa: F401

log = logging.getLogger(__name__)
# 해시 임베딩은 토큰 한도가 없지만, LightRAG가 요약 길이 판단에 쓰므로 Ollama bge-m3와 같은 값을 둔다
MAX_TOKEN_SIZE = 8192
OLLAMA_TIMEOUT_S = 60.0


class _CharTokenizer:
    """글자 하나 = 토큰 하나. 기본 tiktoken은 처음 쓸 때 인코딩 파일을 인터넷에서 받아서 쓰지 않는다.

    LightRAG는 토큰 수를 청크 길이·맥락 예산에만 쓴다. 한국어는 tiktoken에서도 대개 글자당 1토큰 안팎이라
    예산이 크게 어긋나지 않고, 상태가 없어 여러 스레드에서 불러도 안전하다.
    """

    def encode(self, content: str) -> list[int]:
        return [ord(c) for c in content]

    def decode(self, tokens: list[int]) -> str:
        return "".join(chr(t) for t in tokens)


def make_tokenizer() -> Tokenizer:
    return Tokenizer("char", _CharTokenizer())


class LLMNotAllowed(RuntimeError):
    """시드 주입·검색 중 LightRAG가 LLM을 부르려 할 때. 불리면 버그다."""


async def forbidden_llm(*args: Any, **kwargs: Any) -> str:
    raise LLMNotAllowed("시드 주입·검색에서는 LLM을 부르지 않아요. LightRAG가 LLM을 불렀다면 버그예요.")


def _tokens(text: str) -> list[str]:
    """공백 단어 + 공백 뺀 글자 2·3-gram. 한국어는 띄어쓰기가 들쭉날쭉해 n-gram이 함께 있어야 겹침이 잡힌다."""
    text = text.lower()
    words = re.findall(r"\w+", text)
    compact = re.sub(r"\s+", "", text)
    grams = [compact[i:i + n] for n in (2, 3) for i in range(len(compact) - n + 1)]
    return [f"w:{w}" for w in words] + [f"g:{g}" for g in grams]


def hash_embed(texts: list[str], dim: int) -> np.ndarray:
    """결정적 해시 임베딩(blake2b, 프로세스와 무관). 각 행은 L2 정규화된다."""
    out = np.zeros((len(texts), dim), dtype=np.float32)
    for row, text in enumerate(texts):
        for tok in _tokens(text):
            h = int.from_bytes(hashlib.blake2b(tok.encode("utf-8"), digest_size=8).digest(), "big")
            out[row, h % dim] += 1.0 if (h >> 63) & 1 else -1.0
        norm = float(np.linalg.norm(out[row]))
        if norm == 0.0:
            # 빈 글은 고정 벡터 하나로 둔다(0 벡터는 코사인 유사도가 NaN이 된다)
            out[row, 0] = 1.0
        else:
            out[row] /= norm
    return out


def make_embedding_func(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> EmbeddingFunc:
    """설정에 맞는 LightRAG EmbeddingFunc. transport는 테스트에서 Ollama를 흉내 낼 때만 쓴다."""
    dim = int(settings.embedding_dim)
    provider = settings.embedding_provider

    if provider == "hash":
        async def _hash(texts: list[str], **_: Any) -> np.ndarray:
            return hash_embed(list(texts), dim)

        return EmbeddingFunc(embedding_dim=dim, func=_hash, max_token_size=MAX_TOKEN_SIZE, model_name=HASH_MODEL_NAME)

    if provider == "ollama":
        url = settings.ollama_url.rstrip("/") + "/api/embed"
        model = settings.embedding_model

        async def _ollama(texts: list[str], **_: Any) -> np.ndarray:
            async with httpx.AsyncClient(transport=transport, timeout=OLLAMA_TIMEOUT_S) as client:
                r = await client.post(url, json={"model": model, "input": list(texts)})
                r.raise_for_status()
                out = np.asarray(r.json()["embeddings"], dtype=np.float32)
            # 모델과 EMBEDDING_DIM이 어긋나면 LightRAG 벡터 저장소가 알아보기 어려운 오류를 내거나 벡터가 섞인다. 여기서 막는다
            if out.ndim != 2 or out.shape[0] != len(texts):
                raise ValueError(f"Ollama 임베딩 개수가 맞지 않아요: 글 {len(texts)}개, 응답 모양 {out.shape}")
            if out.shape[1] != dim:
                raise ValueError(f"Ollama 임베딩 차원이 설정과 달라요: 응답 {out.shape[1]}, EMBEDDING_DIM {dim} "
                                 f"(모델 {model}). EMBEDDING_DIM 또는 EMBEDDING_MODEL을 확인해 주세요.")
            return out

        return EmbeddingFunc(embedding_dim=dim, func=_ollama, max_token_size=MAX_TOKEN_SIZE, model_name=model)

    raise ValueError(f"EMBEDDING_PROVIDER는 hash 또는 ollama여야 해요: {provider!r}")


async def open_rag(settings: Settings) -> LightRAG:
    """저장소까지 초기화한 LightRAG. 다 쓰면 finalize_storages()를 부른다."""
    rag = LightRAG(
        working_dir=settings.lightrag_working_dir,
        workspace=settings.workspace,
        embedding_func=make_embedding_func(settings),
        llm_model_func=forbidden_llm,
        tokenizer=make_tokenizer(),
    )
    try:
        await rag.initialize_storages()
    except BaseException:
        # 중간에 실패하면 이미 연 저장소(파일 잠금·백그라운드 작업)를 닫고 인스턴스를 버린 뒤 원래 오류를 다시 던진다
        try:
            await rag.finalize_storages()
        except Exception as e:  # 정리 실패가 원래 오류를 가리지 않게 기록만 한다
            log.warning("열다 실패한 LightRAG 저장소를 닫지 못함: %s: %s", type(e).__name__, e)
        del rag
        raise
    return rag
