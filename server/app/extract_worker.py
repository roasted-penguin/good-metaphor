"""추출 큐 워커(T-414): 문서 청크를 맥 Ollama로 하나씩 추출해 LightRAG에 넣는다.

흐름(docs/architecture-lightrag.md "M2 맥 추출 노드", ADR 0006):
- 큐는 워크스페이스 폴더 안 `extract-queue.json`(원자적 쓰기, 경로는 seedmeta.safe_workspace_dir로만).
  청크: {id, docId, workspace, text, status: pending|running|done|failed, attempts, lastError, updatedAt, via}
- 주기(기본 300초)마다, 시간창(EXTRACT_WINDOW) 안에서만 창을 연다. 창마다 맥에 `GET /api/tags`(2초).
  응답하면 pending·failed(attempts < 상한) 청크를 순서대로 하나씩(동시 1 = llm_model_max_async=1) 처리한다.
- 처리 순서: running 표시(attempts+1) → 추출 → 목록 밖 추상구조 버림(filter_extraction, 규칙 9)
  → 삽입 콜백 → done 표시. 삽입이 끝나야 done이므로 맥이 꺼져도 청크를 잃지 않는다.
  삽입 뒤 done 표시 전에 프로세스가 죽으면 그 청크는 다시 처리된다. 삽입 쪽은 청크 id로 같은 청크를
  덮어쓰게 한다(T-421, LightRAG doc_id = 청크 id).
- 연결이 끊기거나 5xx면 그 청크를 failed로 두고 이번 창은 멈춘다(맥이 꺼진 것으로 보고 다음 창에 다시).
  4xx(모델 이름이 틀림 등)는 설정 오류라 청크를 이전 상태·시도 수로 되돌리고 창만 멈춘다.
  모델 응답 파싱 실패는 failed로 두고 다음 청크로 넘어간다.
- 프로세스가 죽어 running으로 남은 청크는 시작할 때 pending으로 되돌린다(recover_running).
- EXTRACT_FALLBACK=cloud: 맥 헬스체크가 실패했을 때만, 사용자 워크스페이스(common_ 아님) 청크만,
  하루(UTC) 상한까지 클라우드로 추출한다. 공통 워크스페이스는 늘 맥만(운영자 승인 흐름).

규칙 8: 호버 경로와 따로 돈다. 규칙 10: 맥 주소는 테일넷 주소만 설정에 둔다(키는 없다, 로그에 주소만).
"""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import hashlib
import json
import logging
import re
import sys
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Mapping

import httpx

from app import seedmeta
from app.config import Settings
from app.extract import build_extraction_config, filter_extraction

log = logging.getLogger(__name__)

QUEUE_FILE = "extract-queue.json"
# 클라우드 대체 사용 수(하루 상한). 사용자 워크스페이스 전체에 걸린 상한이라 작업 디렉터리 바로 아래에 둔다
USAGE_FILE = "extract-usage.json"
# T-421 전 기본 삽입: 추출 결과를 워크스페이스 폴더 아래 청크별 파일로 남긴다
RESULTS_DIR = "extract-results"
COMMON_PREFIX = "common_"

CHUNK_SIZE = 1200
CHUNK_OVERLAP = 100
HEALTH_TIMEOUT_S = 2.0
# 맥 추출 요청(architecture: 타임아웃 600초, num_ctx 16384)
EXTRACT_TIMEOUT_S = 600.0
EXTRACT_CONNECT_TIMEOUT_S = 5.0
EXTRACT_NUM_CTX = 16384
ERROR_MAX_LEN = 200

STATUSES = ("pending", "running", "done", "failed")

Extractor = Callable[[str], Awaitable[tuple[list[Any], list[Any]]]]
Inserter = Callable[[dict, list, list], Awaitable[None]]


class QueueError(RuntimeError):
    """큐 파일이 깨졌을 때. 조용히 비우지 않고 멈춘다(청크를 잃지 않게)."""


class ExtractConnectionError(RuntimeError):
    """맥(또는 클라우드)에 닿지 못함. 이번 창을 멈춘다."""


class ExtractConfigError(RuntimeError):
    """맥 Ollama가 4xx로 답함(모델 이름이 틀림 등). 청크 탓이 아니라 시도 수를 쓰지 않고 창을 멈춘다."""


class ExtractParseError(ValueError):
    """모델 응답이 엔티티·관계 JSON이 아님. 그 청크만 실패로 두고 계속한다."""


# ── 청크 나누기 ─────────────────────────────────────


def _split_long(p: str, size: int, overlap: int) -> list[str]:
    step = max(1, size - overlap)
    out = []
    for i in range(0, len(p), step):
        out.append(p[i:i + size])
        if i + size >= len(p):
            break
    return out


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """단순 문단 기준 청크: 빈 줄로 문단을 나누고 size자까지 채운다. 다음 청크는 앞 청크 끝 overlap자로 시작한다.

    size보다 긴 문단은 글자 수로 자른다(조각끼리도 overlap자 겹침).
    """
    paras = [p.strip() for p in re.split(r"\n\s*\n", text or "") if p.strip()]
    pieces: list[str] = []
    for p in paras:
        pieces.extend([p] if len(p) <= size else _split_long(p, size, overlap))
    chunks: list[str] = []
    cur = ""
    for piece in pieces:
        if not cur:
            cur = piece
            continue
        joined = f"{cur}\n\n{piece}"
        if len(joined) <= size:
            cur = joined
            continue
        chunks.append(cur)
        with_tail = f"{cur[-overlap:]}\n\n{piece}" if overlap > 0 else piece
        cur = with_tail if len(with_tail) <= size else piece
    if cur:
        chunks.append(cur)
    return chunks


def _sha(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def chunk_id(doc_id: str, index: int, text: str) -> str:
    """같은 문서·같은 자리·같은 글이면 같은 id(다시 넣어도 중복 없음). 파일 이름으로 써도 안전한 글자만."""
    return f"{_sha(doc_id)[:10]}-{index:04d}-{_sha(text)[:10]}"


def result_name(cid: str) -> str:
    return cid


# ── 큐 파일 ─────────────────────────────────────────


def _ws_dir(settings: Settings, workspace: str) -> Path:
    """워크스페이스 폴더(작업 디렉터리 바로 아래, 심볼릭 링크 거절). 이름이 안전하지 않으면 WorkspaceError."""
    seedmeta.validate_workspace(workspace)
    return seedmeta.safe_workspace_dir(dataclasses.replace(settings, workspace=workspace))


def queue_path(settings: Settings, workspace: str) -> Path:
    return _ws_dir(settings, workspace) / QUEUE_FILE


def load_queue(settings: Settings, workspace: str) -> list[dict]:
    """큐의 청크 목록(파일 순서). 파일이 없으면 빈 목록, 깨졌으면 QueueError."""
    path = queue_path(settings, workspace)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise QueueError(f"추출 큐 파일을 읽지 못했어요({workspace}/{QUEUE_FILE}). 고치거나 지운 뒤 다시 넣어 주세요.") from e
    chunks = data.get("chunks") if isinstance(data, dict) else None
    if not isinstance(chunks, list) or not all(isinstance(c, dict) for c in chunks):
        raise QueueError(f"추출 큐 파일 모양이 달라요({workspace}/{QUEUE_FILE}).")
    return chunks


def save_queue(settings: Settings, workspace: str, chunks: list[dict]) -> None:
    path = queue_path(settings, workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    seedmeta.atomic_write_json(path, {"version": 1, "chunks": chunks})


def _iso(now: datetime | None) -> str:
    return (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")


def enqueue(settings: Settings, workspace: str, doc_id: str, text: str, now: datetime | None = None) -> int:
    """문서를 청크로 나눠 pending으로 넣는다. 이미 있는 청크 id는 건너뛴다. 새로 넣은 수를 돌려준다."""
    chunks = load_queue(settings, workspace)
    have = {c.get("id") for c in chunks}
    added = 0
    for i, part in enumerate(chunk_text(text)):
        cid = chunk_id(doc_id, i, part)
        if cid in have:
            continue
        chunks.append({"id": cid, "docId": doc_id, "workspace": workspace, "text": part, "status": "pending",
                       "attempts": 0, "lastError": None, "updatedAt": _iso(now), "via": None})
        have.add(cid)
        added += 1
    if added:
        save_queue(settings, workspace, chunks)
    return added


def _update(settings: Settings, workspace: str, cid: str, now: datetime | None, **fields: Any) -> dict:
    """청크 하나를 고쳐 바로 저장한다(파일을 다시 읽어 다른 청크 변경을 덮지 않게)."""
    chunks = load_queue(settings, workspace)
    for c in chunks:
        if c.get("id") == cid:
            c.update(fields, updatedAt=_iso(now))
            save_queue(settings, workspace, chunks)
            return c
    raise QueueError(f"큐에서 청크를 찾지 못했어요: {cid}")


def recover_running(settings: Settings, workspaces: Iterable[str], now: datetime | None = None) -> int:
    """시작할 때: 프로세스가 죽어 running으로 남은 청크를 pending으로 되돌린다. 되돌린 수."""
    total = 0
    for ws in workspaces:
        chunks = load_queue(settings, ws)
        n = 0
        for c in chunks:
            if c.get("status") == "running":
                c.update(status="pending", updatedAt=_iso(now))
                n += 1
        if n:
            save_queue(settings, ws, chunks)
            log.warning("추출 큐 %s: 처리 중 멈춘 청크 %d개를 다시 대기로 돌렸어요.", ws, n)
        total += n
    return total


def status_counts(settings: Settings, workspace: str, max_attempts: int) -> dict[str, int]:
    counts = {s: 0 for s in STATUSES}
    counts["gaveUp"] = 0
    chunks = load_queue(settings, workspace)
    for c in chunks:
        st = c.get("status")
        counts[st] = counts.get(st, 0) + 1
        if st == "failed" and int(c.get("attempts") or 0) >= max_attempts:
            counts["gaveUp"] += 1
    counts["total"] = len(chunks)
    return counts


def is_common(workspace: str) -> bool:
    return workspace.startswith(COMMON_PREFIX)


# ── 시간창 ───────────────────────────────────────────

_WINDOW_RE = re.compile(r"^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$")


def parse_windows(spec: str) -> list[tuple[time, time]]:
    """"12:10-13:00,23:00-07:00" → [(시작, 끝)]. 비우면 빈 목록(늘 열림). 끝이 시작보다 이르면 자정을 넘는다."""
    out = []
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        m = _WINDOW_RE.match(part)
        if not m:
            raise ValueError(f"EXTRACT_WINDOW 형식은 HH:MM-HH:MM(쉼표로 여러 개)이에요: {part!r}")
        h1, m1, h2, m2 = map(int, m.groups())
        try:
            out.append((time(h1, m1), time(h2, m2)))
        except ValueError as e:
            raise ValueError(f"EXTRACT_WINDOW 시각이 잘못됐어요: {part!r}") from e
    return out


def in_window(now: datetime, windows: list[tuple[time, time]]) -> bool:
    if not windows:
        return True
    t = now.time().replace(tzinfo=None)
    for start, end in windows:
        if start <= end:
            if start <= t < end:
                return True
        elif t >= start or t < end:
            return True
    return False


def _utc_date(now: datetime) -> str:
    aware = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).date().isoformat()


# ── 헬스체크·추출 함수 ─────────────────────────────────


async def health(ollama_url: str, timeout: float = HEALTH_TIMEOUT_S) -> bool:
    """맥 Ollama가 답하는지(`GET /api/tags`). 주소가 비면 False(워커 꺼짐)."""
    if not ollama_url:
        return False
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(ollama_url.rstrip("/") + "/api/tags")
        return res.status_code == 200
    except (httpx.HTTPError, OSError):
        return False


def extraction_system_prompt(graph: Mapping[str, Any]) -> str:
    """T-412 추출 설정(유형 안내·통제 어휘·용어 사전·예시)으로 만든 Ollama /api/chat system 프롬프트."""
    cfg = build_extraction_config(graph)
    examples = "\n\n".join(cfg["prompt_overrides"]["entity_extraction_json_examples"])
    return "\n".join([
        "너는 메이플스토리 문서에서 엔티티와 관계를 뽑는다. 입력에 없는 사실은 지어내지 않는다.",
        f"출력 언어: {cfg['addon_params']['language']}.",
        'JSON 객체 하나만 출력한다: {"entities": [{"name", "type", "description"}], '
        '"relationships": [{"source", "target", "keywords", "description"}]}',
        "",
        cfg["addon_params"]["entity_types_guidance"],
        "",
        examples,
    ])


def parse_extraction(content: str) -> tuple[list[dict], list[dict]]:
    """모델 응답 글 → (엔티티, 관계). JSON 객체가 아니면 ExtractParseError."""
    s = (content or "").strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", s, re.S)
    if fence:
        s = fence.group(1)
    try:
        data = json.loads(s)
    except ValueError as e:
        raise ExtractParseError("모델 응답이 JSON이 아니에요.") from e
    if not isinstance(data, dict):
        raise ExtractParseError("모델 응답이 JSON 객체가 아니에요.")
    ents = data.get("entities") or []
    rels = data.get("relationships") or []
    if not isinstance(ents, list) or not isinstance(rels, list):
        raise ExtractParseError("모델 응답 JSON에 entities·relationships 배열이 없어요.")
    return [e for e in ents if isinstance(e, dict)], [r for r in rels if isinstance(r, dict)]


def make_ollama_extractor(ollama_url: str, model: str, graph: Mapping[str, Any], think: bool = False,
                          timeout: float = EXTRACT_TIMEOUT_S) -> Extractor:
    """맥 Ollama `/api/chat`(JSON 모드, 스트리밍 끔)으로 청크 하나를 추출하는 함수."""
    system = extraction_system_prompt(graph)
    url = (ollama_url or "").rstrip("/") + "/api/chat"

    async def extract(text: str) -> tuple[list[Any], list[Any]]:
        body = {"model": model, "stream": False, "format": "json", "think": think,
                "options": {"num_ctx": EXTRACT_NUM_CTX},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}]}
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=EXTRACT_CONNECT_TIMEOUT_S)) as client:
                res = await client.post(url, json=body)
        except (httpx.HTTPError, OSError) as e:
            raise ExtractConnectionError(f"맥 Ollama 연결이 끊겼어요({type(e).__name__}).") from e
        if 400 <= res.status_code < 500:
            raise ExtractConfigError(f"맥 Ollama 설정 오류({res.status_code}): EXTRACT_MODEL·주소를 확인해 주세요.")
        if res.status_code >= 500:
            raise ExtractConnectionError(f"맥 Ollama가 {res.status_code}로 답했어요.")
        try:
            content = res.json()["message"]["content"]
        except (ValueError, KeyError, TypeError) as e:
            raise ExtractParseError("Ollama 응답 JSON 모양이 달라요.") from e
        return parse_extraction(content)

    return extract


def make_cloud_extractor(llm: Any, graph: Mapping[str, Any]) -> Extractor:
    """서버 LLM(app.llm, 기본 Gemini)으로 추출하는 함수. 클라우드 대체(EXTRACT_FALLBACK=cloud)에서만 쓴다."""
    from app.llm import LLMError

    system = extraction_system_prompt(graph)

    async def extract(text: str) -> tuple[list[Any], list[Any]]:
        try:
            content = await llm.complete(system, text, json=True)
        except LLMError as e:
            raise ExtractConnectionError(f"클라우드 추출 실패: {e}"[:ERROR_MAX_LEN]) from e
        return parse_extraction(content)

    return extract


def make_result_writer(settings: Settings) -> Inserter:
    """T-421 전 기본 삽입: 추출 결과를 `<워크스페이스>/extract-results/<청크 id>.json`에 원자적으로 쓴다."""

    async def write(chunk: dict, entities: list, relationships: list) -> None:
        d = _ws_dir(settings, chunk["workspace"]) / RESULTS_DIR
        d.mkdir(parents=True, exist_ok=True)
        seedmeta.atomic_write_json(d / f"{result_name(chunk['id'])}.json", {
            "id": chunk["id"], "docId": chunk["docId"], "workspace": chunk["workspace"],
            "entities": entities, "relationships": relationships})

    return write


# ── 클라우드 사용 수 ───────────────────────────────────


def _usage_path(settings: Settings) -> Path:
    return Path(settings.lightrag_working_dir).resolve() / USAGE_FILE


def read_cloud_usage(settings: Settings, now: datetime) -> int:
    """오늘(UTC) 클라우드로 처리한 청크 수. 날짜가 바뀌었거나 파일이 없으면 0."""
    try:
        data = json.loads(_usage_path(settings).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    if not isinstance(data, dict) or data.get("date") != _utc_date(now):
        return 0
    return int(data.get("cloudChunks") or 0)


def _add_cloud_usage(settings: Settings, now: datetime) -> None:
    path = _usage_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    seedmeta.atomic_write_json(path, {"date": _utc_date(now), "cloudChunks": read_cloud_usage(settings, now) + 1})


# ── 워커 ────────────────────────────────────────────


def _short(e: BaseException) -> str:
    return str(e)[:ERROR_MAX_LEN] or type(e).__name__


class ExtractWorker:
    def __init__(self, settings: Settings, workspaces: Iterable[str], extractor: Extractor, insert: Inserter,
                 ollama_url: str | None = None, cloud_extractor: Extractor | None = None,
                 health_fn: Callable[[], Awaitable[bool]] | None = None, vocabulary: Iterable[str] | None = None,
                 max_attempts: int | None = None, windows: str | None = None, fallback: str | None = None,
                 daily_cap: int | None = None) -> None:
        self.settings = settings
        self.workspaces = list(workspaces)
        for ws in self.workspaces:
            seedmeta.validate_workspace(ws)
        self.extractor = extractor
        self.insert = insert
        self.cloud_extractor = cloud_extractor
        url = settings.extract_ollama_url if ollama_url is None else ollama_url
        self.health_fn = health_fn or (lambda: health(url))
        if vocabulary is None:
            vocabulary = build_extraction_config(settings.common_graph())["vocabulary"]
        self.vocabulary = list(vocabulary)
        self.max_attempts = settings.extract_max_attempts if max_attempts is None else max_attempts
        self.windows = parse_windows(settings.extract_window if windows is None else windows)
        self.fallback = settings.extract_fallback if fallback is None else fallback
        self.daily_cap = settings.extract_cloud_daily_cap if daily_cap is None else daily_cap

    def _eligible(self, c: Mapping[str, Any]) -> bool:
        st = c.get("status")
        return st == "pending" or (st == "failed" and int(c.get("attempts") or 0) < self.max_attempts)

    async def run_window(self, now: datetime) -> dict[str, Any]:
        """창 한 번. 반환: {healthy, done, failed, cloud, stopped, skipped}."""
        summary: dict[str, Any] = {"healthy": None, "done": 0, "failed": 0, "cloud": 0, "stopped": None,
                                   "skipped": None}
        if not in_window(now, self.windows):
            summary["skipped"] = "시간창 밖"
            return summary
        healthy = await self.health_fn()
        summary["healthy"] = healthy
        if healthy:
            for ws in self.workspaces:
                stop = await self._drain(ws, self.extractor, "mac", summary, now)
                if stop:
                    summary["stopped"] = stop
                    break
        elif self.fallback == "cloud" and self.cloud_extractor is not None:
            # 공통 워크스페이스는 늘 맥만(운영자 승인 흐름, ADR 0006)
            for ws in (w for w in self.workspaces if not is_common(w)):
                stop = await self._drain(ws, self.cloud_extractor, "cloud", summary, now)
                if stop:
                    summary["stopped"] = stop
                    break
        return summary

    async def _drain(self, ws: str, extractor: Extractor, via: str, summary: dict, now: datetime) -> str | None:
        """ws의 처리할 청크를 하나씩 끝까지. 창을 멈춰야 하면 그 이유를 돌려준다."""
        # 이번 창에서 이미 시도한 청크는 다시 집지 않는다(파싱 실패 청크를 한 창에서 되풀이하지 않게)
        tried: set[str] = set()
        while True:
            nxt = next((c for c in load_queue(self.settings, ws)
                        if self._eligible(c) and c.get("id") not in tried), None)
            if nxt is None:
                return None
            cid = nxt["id"]
            tried.add(cid)
            if via == "cloud":
                if read_cloud_usage(self.settings, now) >= self.daily_cap:
                    return "클라우드 하루 상한"
                # 호출 전에 센다(실패해도 비용이 드니까)
                _add_cloud_usage(self.settings, now)
            chunk = _update(self.settings, ws, cid, now, status="running",
                            attempts=int(nxt.get("attempts") or 0) + 1, lastError=None)
            try:
                entities, relationships = await extractor(chunk["text"])
                entities, relationships = filter_extraction(entities, relationships, self.vocabulary)
            except ExtractConfigError as e:
                # 설정 오류: 청크는 이전 상태·시도 수 그대로 되돌리고 창을 멈춘다(상한에 닿아 포기되지 않게)
                _update(self.settings, ws, cid, now, status=nxt.get("status") or "pending",
                        attempts=int(nxt.get("attempts") or 0), lastError=_short(e))
                log.error("추출 큐 %s: 맥 Ollama 설정 오류, 이번 창을 멈춰요(시도 수는 그대로): %s", ws, e)
                return "설정 오류"
            except ExtractConnectionError as e:
                self._fail(ws, cid, now, _short(e), summary)
                log.warning("추출 큐 %s: 청크 %s 연결 실패, 이번 창을 멈춰요: %s", ws, cid, e)
                return "연결 끊김"
            except Exception as e:  # 파싱 실패 등: 그 청크만 실패
                self._fail(ws, cid, now, _short(e), summary)
                log.warning("추출 큐 %s: 청크 %s 추출 실패: %s", ws, cid, e)
                continue
            try:
                await self.insert(chunk, entities, relationships)
            except (ExtractConnectionError, httpx.TransportError) as e:
                self._fail(ws, cid, now, f"삽입 중 연결 실패: {_short(e)}", summary)
                return "연결 끊김"
            except Exception as e:
                self._fail(ws, cid, now, f"삽입 실패: {type(e).__name__}: {_short(e)}", summary)
                log.warning("추출 큐 %s: 청크 %s 삽입 실패: %s", ws, cid, e)
                continue
            _update(self.settings, ws, cid, now, status="done", lastError=None, via=via)
            summary["done"] += 1
            if via == "cloud":
                summary["cloud"] += 1

    def _fail(self, ws: str, cid: str, now: datetime, message: str, summary: dict) -> None:
        _update(self.settings, ws, cid, now, status="failed", lastError=message[:ERROR_MAX_LEN])
        summary["failed"] += 1


def _default_clock() -> datetime:
    # 시간창은 서버 시간대, 하루 상한은 UTC 날짜로 본다
    return datetime.now().astimezone()


async def run_forever(worker: ExtractWorker, clock: Callable[[], datetime] = _default_clock,
                      sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, interval_s: float | None = None,
                      max_iterations: int | None = None) -> list[dict]:
    """시작할 때 running을 복구하고, interval_s마다 창을 연다. 창 오류는 기록만 하고 다음 주기로."""
    interval = worker.settings.extract_interval_s if interval_s is None else interval_s
    recover_running(worker.settings, worker.workspaces)
    results: list[dict] = []
    i = 0
    while max_iterations is None or i < max_iterations:
        if i:
            await sleep(interval)
        try:
            summary = await worker.run_window(clock())
        except Exception as e:  # 큐 파일 오류 등. 워커는 계속 돈다
            log.error("추출 큐 창 실패: %s", e)
            summary = {"error": _short(e)}
        results.append(summary)
        i += 1
    return results


# ── CLI ─────────────────────────────────────────────


def _default_cloud(settings: Settings, graph: Mapping[str, Any]) -> Extractor | None:
    if settings.extract_fallback != "cloud":
        return None
    if not settings.gemini_api_key:
        log.warning("EXTRACT_FALLBACK=cloud인데 GEMINI_API_KEY가 없어 클라우드 대체를 쓰지 않아요.")
        return None
    from app.llm import GeminiLLM

    return make_cloud_extractor(GeminiLLM(settings.gemini_api_key, settings.keyword_model), graph)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.extract_worker", description="추출 큐 워커(T-414)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="창 한 번 실행(시간창·헬스체크 포함)")
    mode.add_argument("--enqueue", metavar="FILE", help="문서를 청크로 나눠 큐에 넣기")
    mode.add_argument("--status", action="store_true", help="워크스페이스별 상태 개수")
    parser.add_argument("--workspace", action="append",
                        help="워크스페이스(여러 번 가능). 기본: --enqueue는 WORKSPACE, 나머지는 EXTRACT_WORKSPACES")
    parser.add_argument("--doc-id", help="--enqueue 문서 id(기본: 파일 이름)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    settings = Settings.from_env()
    workspaces = args.workspace or list(settings.extract_workspaces)

    if args.enqueue:
        path = Path(args.enqueue)
        text = path.read_text(encoding="utf-8")
        ws = (args.workspace or [settings.workspace])[0]
        doc_id = args.doc_id or path.name
        total = len(chunk_text(text))
        added = enqueue(settings, ws, doc_id, text)
        print(f"{ws}: 청크 {total}개 중 {added}개를 넣었어요(이미 있던 {total - added}개는 건너뜀).")
        return 0

    if args.status:
        for ws in workspaces:
            c = status_counts(settings, ws, settings.extract_max_attempts)
            print(f"{ws}: pending {c['pending']}, running {c['running']}, done {c['done']}, "
                  f"failed {c['failed']}(포기 {c['gaveUp']}), 합계 {c['total']}")
        return 0

    # --once
    if not settings.extract_ollama_url:
        print("EXTRACT_OLLAMA_URL이 비어 있어 맥 추출이 꺼져 있어요.")
    graph = settings.common_graph()
    worker = ExtractWorker(
        settings, workspaces,
        extractor=make_ollama_extractor(settings.extract_ollama_url, settings.extract_model, graph),
        insert=make_result_writer(settings),
        cloud_extractor=_default_cloud(settings, graph),
        vocabulary=build_extraction_config(graph)["vocabulary"],
    )
    recover_running(settings, workspaces)
    s = asyncio.run(worker.run_window(_default_clock()))
    if s["skipped"]:
        print(f"건너뜀: {s['skipped']}")
    else:
        print(f"맥 응답 {'있음' if s['healthy'] else '없음'}: 완료 {s['done']}(클라우드 {s['cloud']}), "
              f"실패 {s['failed']}" + (f", 멈춤: {s['stopped']}" if s["stopped"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
