"""FastAPI 앱 생성. deps로 설정·가짜 부품을 주입할 수 있다(테스트용).

deps 키: settings, graph, llm(키워드·비유 공용) 또는 keyword_llm·analogy_llm, retriever, rag, cache, rate_limiter.
주입하지 않은 부품은 첫 요청 때 실제 것으로 만든다(앱 생성·import 때는 네트워크·LightRAG를 건드리지 않는다).
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__
from .blocklist import active_terms, load_blocklist
from .cache import ResultCache, cache_key
from .config import Settings, load_common_graph
from .pipeline import AnalogyPipeline, AnalogyRequest, PipelineError
from .ratelimit import RateLimiter

log = logging.getLogger(__name__)

MAX_SENTENCE_CHARS = 2000


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _opt_str(value: Any) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None


def create_app(deps: dict[str, Any] | None = None) -> FastAPI:
    deps = dict(deps or {})
    settings = deps.get("settings") or Settings.from_env()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        # 앱이 직접 만든 검색기만 닫는다(첫 검색 때 연 LightRAG 저장소). 주입된 부품은 건드리지 않는다
        owned = _app.state.owned_retriever
        if owned is not None:
            try:
                await owned.close()
            except Exception as e:  # 종료 중 오류는 기록만 한다
                log.warning("LightRAG 저장소를 닫지 못함: %s", e)

    app = FastAPI(title="analogy-api", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.deps = deps
    app.state.cache = deps.get("cache") or ResultCache()
    app.state.rate_limiter = deps.get("rate_limiter") or RateLimiter(settings.rate_limit_per_min)
    app.state.pipeline = None
    app.state.owned_retriever = None
    # 금칙어(T-114): 시작할 때 한 번 읽는다. 승인 카드가 하나도 없으면 /v1/analogy를 503으로 막는다(실패 시 닫힘)
    injected = deps.get("blocklist")
    app.state.blocklist = active_terms(injected) if injected is not None else load_blocklist(settings.blocklist_path)
    if not app.state.blocklist:
        log.error("승인된 금칙어가 없어 비유 요청을 막아요: %s", settings.blocklist_path)

    def get_pipeline() -> AnalogyPipeline:
        """주입된 부품 + 없는 것은 실제 부품으로 파이프라인을 한 번만 만든다."""
        if app.state.pipeline is not None:
            return app.state.pipeline
        s: Settings = app.state.settings
        keyword_llm = deps.get("keyword_llm") or deps.get("llm")
        analogy_llm = deps.get("analogy_llm") or deps.get("llm")
        if keyword_llm is None or analogy_llm is None:
            if not s.gemini_api_key:
                raise PipelineError(503, "서버에 AI 키가 설정되지 않았어요.")
            from .llm import GeminiLLM

            keyword_llm = keyword_llm or GeminiLLM(s.gemini_api_key, s.keyword_model)
            analogy_llm = analogy_llm or GeminiLLM(s.gemini_api_key, s.analogy_model)
        graph = deps.get("graph")
        if graph is None:
            try:
                graph = load_common_graph(s.common_graph_path, s.tags_path)  # 태그 파일까지 합친다(T-304)
            except (OSError, ValueError) as e:
                log.error("공통 그래프를 읽지 못함: %s", e)
                raise PipelineError(503, "공통 그래프를 읽지 못했어요.") from e
        retriever = deps.get("retriever")
        if retriever is None:
            from .retriever import LazyLightRAGRetriever, LightRAGRetriever

            if "rag" in deps:
                retriever = LightRAGRetriever(rag=deps["rag"], graph=graph)
            else:
                # 시드된 인덱스(LIGHTRAG_WORKING_DIR/WORKSPACE)를 첫 검색 때 연다. 없으면 검색 단계에서 503
                retriever = app.state.owned_retriever = LazyLightRAGRetriever(s, graph)
        app.state.pipeline = AnalogyPipeline(graph, keyword_llm, analogy_llm, retriever, s.analogy_model,
                                             blocklist=app.state.blocklist)
        return app.state.pipeline

    @app.exception_handler(Exception)
    async def unexpected_error(_request: Request, exc: Exception) -> JSONResponse:
        # 예상 못 한 오류도 맨 500 대신 한국어 JSON으로 돌려준다
        log.exception("처리 못 한 오류: %s", exc)
        return _error(500, "서버에서 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.")

    @app.get("/health")
    def health() -> dict[str, Any]:
        # 프로세스는 살아 있으면 ok. 금칙어가 없으면 비유 요청만 503(blocklist.loaded로 보인다)
        n = len(app.state.blocklist)
        return {"ok": True, "version": __version__, "blocklist": {"loaded": n > 0, "approved": n}}

    @app.post("/v1/analogy")
    async def analogy(request: Request) -> JSONResponse:
        token = (request.headers.get("x-install-token") or "").strip()
        if not token:
            return _error(400, "설치 토큰(X-Install-Token)이 필요해요.")
        try:
            body = await request.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return _error(400, "요청 본문은 JSON 객체여야 해요.")
        sentence = _opt_str(body.get("sentence"))
        if not sentence:
            return _error(400, "설명할 문장이 비어 있어요.")
        if len(sentence) > MAX_SENTENCE_CHARS:
            return _error(400, "문장이 너무 길어요.")

        # 금칙어 목록 없이는 비유를 내지 않는다(규칙 11, 실패 시 닫힘)
        if not app.state.blocklist:
            return _error(503, "금칙어 목록을 읽지 못해 비유를 멈췄어요.")

        # 한도 → 캐시 → 파이프라인
        if not app.state.rate_limiter.allow(token):
            return _error(429, "요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.")
        word = _opt_str(body.get("word"))
        key = cache_key(sentence, word, app.state.settings.workspace_version)
        hit = app.state.cache.get(key)
        if hit is not None:
            return JSONResponse({**hit, "cached": True})
        try:
            result = await get_pipeline().run(AnalogyRequest(
                sentence=sentence,
                word=word,
                context=_opt_str(body.get("context")),
                page_title=_opt_str(body.get("pageTitle")),
            ))
        except PipelineError as e:
            return _error(e.status, e.message)
        app.state.cache.put(key, result)
        return JSONResponse(result)

    return app


# uvicorn app.main:app 으로 실행할 때 쓰는 기본 앱
app = create_app()
