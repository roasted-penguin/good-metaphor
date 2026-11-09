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
- 프로세스가 죽어 running으로 남은 청크는 시작할 때 pending으로 되돌린다(recover_running, 시도 수는 그대로).
- 잠금: 큐 파일마다 옆 `extract-queue.lock`(fcntl.flock)을 읽고-고치고-쓰는 동안 쥔다. 복구·창 실행은
  작업 디렉터리의 `worker.lock`을 기다리지 않고 잡은 프로세스 하나만(두 번째 워커는 거절).
- 큐 파일이 깨진 워크스페이스는 그 워크스페이스만 건너뛰고 나머지는 계속한다.
- EXTRACT_FALLBACK=cloud: 맥 헬스체크가 실패했을 때만, 사용자 워크스페이스(common_ 아님) 청크만,
  하루(UTC) 상한까지 클라우드로 추출한다. 공통 워크스페이스는 늘 맥만(운영자 승인 흐름).

규칙 8: 호버 경로와 따로 돈다. 규칙 10: 맥 주소는 테일넷 주소만 설정에 둔다(키는 없다, 로그에 주소만).
"""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import fcntl
import hashlib
import json
import logging
import os
import re
import sys
from contextlib import contextmanager
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Iterator, Mapping

import httpx

from app import seedmeta
from app.config import Settings
from app.extract import build_extraction_config, filter_extraction

log = logging.getLogger(__name__)

QUEUE_FILE = "extract-queue.json"
# 큐 파일 옆 잠금(읽고-고치고-쓰기를 프로세스 사이에도 하나씩)
QUEUE_LOCK_FILE = "extract-queue.lock"
# 작업 디렉터리의 워커 잠금(running 복구·창 실행은 한 프로세스만)
WORKER_LOCK_FILE = "worker.lock"
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


# 청크 id는 chunk_id()가 만든 모양(소문자 16진수·숫자·-)만. 결과 파일 이름으로 쓰므로 경로 글자를 막는다
CHUNK_ID_RE = re.compile(r"^[0-9a-f]+(?:-[0-9a-f]+)*$")


def valid_chunk_id(cid: Any) -> bool:
    return isinstance(cid, str) and len(cid) <= 64 and bool(CHUNK_ID_RE.fullmatch(cid))


def result_name(cid: str) -> str:
    if not valid_chunk_id(cid):
        raise ValueError(f"청크 id 모양이 안전하지 않아요: {cid!r}")
    return cid


# ── 큐 파일·잠금 ─────────────────────────────────────


def _ws_dir(settings: Settings, workspace: str) -> Path:
    """워크스페이스 폴더(작업 디렉터리 바로 아래, 심볼릭 링크 거절). 이름이 안전하지 않으면 WorkspaceError."""
    seedmeta.validate_workspace(workspace)
    return seedmeta.safe_workspace_dir(dataclasses.replace(settings, workspace=workspace))


def queue_path(settings: Settings, workspace: str) -> Path:
    return _ws_dir(settings, workspace) / QUEUE_FILE


@contextmanager
def _flock(path: Path, mode: int) -> Iterator[None]:
    """잠금 파일에 fcntl.flock. 같은 프로세스의 다른 스레드도(파일을 따로 여니까) 서로 기다린다."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, mode)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


@contextmanager
def queue_lock(settings: Settings, workspace: str, shared: bool = False) -> Iterator[None]:
    """큐 파일 옆 잠금(`extract-queue.lock`). 큐를 읽고-고치고-쓰는 동안 쥔다(프로세스 사이에도).

    읽기만 할 때는 shared=True. 워크스페이스 폴더가 아직 없으면 읽을 것도 없으니 폴더를 만들지 않는다.
    같은 스레드에서 겹쳐 잡지 않는다(교착).
    """
    d = _ws_dir(settings, workspace)
    if shared and not d.is_dir():
        yield
        return
    d.mkdir(parents=True, exist_ok=True)
    with _flock(d / QUEUE_LOCK_FILE, fcntl.LOCK_SH if shared else fcntl.LOCK_EX):
        yield


class WorkerLocked(RuntimeError):
    """다른 워커(루프나 --once)가 이미 돌고 있음."""


@contextmanager
def worker_lock(settings: Settings) -> Iterator[None]:
    """작업 디렉터리의 `worker.lock`을 기다리지 않고 잡는다. 이미 잡혀 있으면 WorkerLocked.

    running 복구(recover_running)와 창 실행은 이 잠금을 쥔 프로세스에서만 한다. 그래야 다른 워커가
    처리 중인 청크를 pending으로 돌려 두 번 처리하지 않는다. --enqueue·--status는 큐 잠금만 쓴다.
    """
    base = Path(settings.lightrag_working_dir).resolve()
    base.mkdir(parents=True, exist_ok=True)
    fd = os.open(base / WORKER_LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise WorkerLocked("다른 추출 워커가 이미 돌고 있어요. 그 워커가 끝난 뒤 다시 해 주세요.") from e
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _read_queue(settings: Settings, workspace: str) -> list[dict]:
    """잠금 없이 읽는다(부르는 쪽이 queue_lock을 쥔다). 없으면 빈 목록, 깨졌으면 QueueError."""
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


def _write_queue(settings: Settings, workspace: str, chunks: list[dict]) -> None:
    """잠금 없이 원자적으로 쓴다(부르는 쪽이 queue_lock을 쥔다)."""
    path = queue_path(settings, workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    seedmeta.atomic_write_json(path, {"version": 1, "chunks": chunks})


def load_queue(settings: Settings, workspace: str) -> list[dict]:
    """큐의 청크 목록(파일 순서). 파일이 없으면 빈 목록, 깨졌으면 QueueError."""
    with queue_lock(settings, workspace, shared=True):
        return _read_queue(settings, workspace)


def save_queue(settings: Settings, workspace: str, chunks: list[dict]) -> None:
    with queue_lock(settings, workspace):
        _write_queue(settings, workspace, chunks)


def _mutate(settings: Settings, workspace: str, fn: Callable[[list[dict]], tuple[bool, Any]]) -> Any:
    """잠금을 쥔 채 읽고 fn(chunks) → (바뀜, 결과), 바뀌었으면 쓴다."""
    with queue_lock(settings, workspace):
        chunks = _read_queue(settings, workspace)
        changed, result = fn(chunks)
        if changed:
            _write_queue(settings, workspace, chunks)
        return result


def _iso(now: datetime | None) -> str:
    return (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")


def enqueue(settings: Settings, workspace: str, doc_id: str, text: str, now: datetime | None = None) -> int:
    """문서를 청크로 나눠 pending으로 넣는다. 이미 있는 청크 id는 건너뛴다. 새로 넣은 수를 돌려준다."""
    parts = chunk_text(text)

    def add(chunks: list[dict]) -> tuple[bool, int]:
        have = {c.get("id") for c in chunks}
        added = 0
        for i, part in enumerate(parts):
            cid = chunk_id(doc_id, i, part)
            if cid in have:
                continue
            chunks.append({"id": cid, "docId": doc_id, "workspace": workspace, "text": part, "status": "pending",
                           "attempts": 0, "lastError": None, "updatedAt": _iso(now), "via": None})
            have.add(cid)
            added += 1
        return added > 0, added

    return _mutate(settings, workspace, add)


def _update(settings: Settings, workspace: str, cid: str, now: datetime | None, **fields: Any) -> dict:
    """청크 하나를 고쳐 바로 저장한다(잠금 안에서 다시 읽어 다른 변경을 덮지 않게)."""

    def upd(chunks: list[dict]) -> tuple[bool, dict]:
        for c in chunks:
            if c.get("id") == cid:
                c.update(fields, updatedAt=_iso(now))
                return True, dict(c)
        raise QueueError(f"큐에서 청크를 찾지 못했어요: {cid}")

    return _mutate(settings, workspace, upd)


def recover_running(settings: Settings, workspaces: Iterable[str], now: datetime | None = None) -> int:
    """시작할 때: 프로세스가 죽어 running으로 남은 청크를 pending으로 되돌린다(시도 수는 그대로). 되돌린 수.

    worker_lock을 쥔 프로세스에서만 부른다. 큐 파일이 깨진 워크스페이스는 기록하고 건너뛴다.
    """
    total = 0
    for ws in workspaces:
        def rec(chunks: list[dict]) -> tuple[bool, int]:
            n = 0
            for c in chunks:
                if c.get("status") == "running":
                    c.update(status="pending", updatedAt=_iso(now))
                    n += 1
            return n > 0, n

        try:
            n = _mutate(settings, ws, rec)
        except QueueError as e:
            log.error("추출 큐 %s: 복구를 건너뛰어요: %s", ws, e)
            continue
        if n:
            log.warning("추출 큐 %s: 처리 중 멈춘 청크 %d개를 다시 대기로 돌렸어요.", ws, n)
        total += n
    return total


def is_given_up(c: Mapping[str, Any], max_attempts: int) -> bool:
    """시도 수가 상한에 닿은 청크(failed, 또는 처리 중 죽기를 되풀이해 pending으로 돌아온 것)."""
    return c.get("status") in ("pending", "failed") and int(c.get("attempts") or 0) >= max_attempts


def status_counts(settings: Settings, workspace: str, max_attempts: int) -> dict[str, int]:
    counts = {s: 0 for s in STATUSES}
    counts["gaveUp"] = 0
    chunks = load_queue(settings, workspace)
    for c in chunks:
        st = c.get("status")
        counts[st] = counts.get(st, 0) + 1
        if is_given_up(c, max_attempts):
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
            if 400 <= e.status < 500:
                # 키·모델·한도 같은 설정 문제. 청크 탓이 아니라 시도 수·하루 사용 수를 쓰지 않는다
                raise ExtractConfigError(f"클라우드 추출 설정 오류({e.status}): GEMINI_API_KEY·모델을 확인해 주세요.") from e
            raise ExtractConnectionError(f"클라우드 추출 실패: {e}"[:ERROR_MAX_LEN]) from e
        return parse_extraction(content)

    return extract


def make_result_writer(settings: Settings) -> Inserter:
    """T-421 전 기본 삽입: 추출 결과를 `<워크스페이스>/extract-results/<청크 id>.json`에 원자적으로 쓴다.

    청크 id는 안전한 모양만(아니면 ValueError). 워커는 chunk["workspace"]를 지금 처리 중인 워크스페이스로 채워 넘긴다.
    """

    def write_sync(chunk: dict, entities: list, relationships: list) -> None:
        name = result_name(chunk["id"])
        d = _ws_dir(settings, chunk["workspace"]) / RESULTS_DIR
        d.mkdir(parents=True, exist_ok=True)
        seedmeta.atomic_write_json(d / f"{name}.json", {
            "id": chunk["id"], "docId": chunk["docId"], "workspace": chunk["workspace"],
            "entities": entities, "relationships": relationships})

    async def write(chunk: dict, entities: list, relationships: list) -> None:
        # 파일 쓰기는 이벤트 루프 밖 스레드에서(서버 안에서 돌 때 호버 응답을 막지 않게, T-161)
        await asyncio.to_thread(write_sync, chunk, entities, relationships)

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


def _add_cloud_usage(settings: Settings, now: datetime, delta: int = 1) -> None:
    """사용 수를 더한다(worker_lock을 쥔 워커 한 곳에서만 쓴다)."""
    path = _usage_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    count = max(0, read_cloud_usage(settings, now) + delta)
    seedmeta.atomic_write_json(path, {"date": _utc_date(now), "cloudChunks": count})


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
        self.ollama_url = url
        self.health_fn = health_fn or (lambda: health(url))
        if vocabulary is None:
            vocabulary = build_extraction_config(settings.common_graph())["vocabulary"]
        self.vocabulary = list(vocabulary)
        self.max_attempts = settings.extract_max_attempts if max_attempts is None else max_attempts
        self.windows = parse_windows(settings.extract_window if windows is None else windows)
        self.fallback = settings.extract_fallback if fallback is None else fallback
        self.daily_cap = settings.extract_cloud_daily_cap if daily_cap is None else daily_cap

    def _eligible(self, c: Mapping[str, Any]) -> bool:
        # pending도 시도 수 상한을 본다: 처리 중 프로세스를 죽이는 청크가 복구·재시도를 끝없이 되풀이하지 않게
        return c.get("status") in ("pending", "failed") and not is_given_up(c, self.max_attempts)

    async def run_window(self, now: datetime) -> dict[str, Any]:
        """창 한 번. 반환: {healthy, done, failed, cloud, stopped, skipped, errors(큐를 못 읽은 워크스페이스)}."""
        summary: dict[str, Any] = {"healthy": None, "done": 0, "failed": 0, "cloud": 0, "stopped": None,
                                   "skipped": None, "errors": []}
        if not in_window(now, self.windows):
            summary["skipped"] = "시간창 밖"
            return summary
        if not self.ollama_url:
            # 주소가 비면 워커 전체가 꺼짐(클라우드 대체 포함)
            summary["skipped"] = "EXTRACT_OLLAMA_URL 없음(워커 꺼짐)"
            return summary
        healthy = await self.health_fn()
        summary["healthy"] = healthy
        if healthy:
            targets, extractor, via = self.workspaces, self.extractor, "mac"
        elif self.fallback == "cloud" and self.cloud_extractor is not None:
            # 공통 워크스페이스는 늘 맥만(운영자 승인 흐름, ADR 0006)
            targets, extractor, via = [w for w in self.workspaces if not is_common(w)], self.cloud_extractor, "cloud"
        else:
            return summary
        for ws in targets:
            try:
                stop = await self._drain(ws, extractor, via, summary, now)
            except QueueError as e:
                # 큐 파일이 깨진 워크스페이스만 건너뛰고 나머지는 계속
                log.error("추출 큐 %s: 이번 창은 건너뛰어요: %s", ws, e)
                summary["errors"].append(ws)
                continue
            if stop:
                summary["stopped"] = stop
                break
        return summary

    def _pick(self, ws: str, tried: set[str], now: datetime) -> dict | None:
        """(스레드에서 부른다) 잠금 안에서 처리할 청크를 골라 running(시도 수 +1)으로 표시한다.

        반환: None(없음) | {"kind": "bad", ...}(안전하지 않은 청크, 포기로 표시함) | {"kind": "ok", "chunk", "prev"}.
        """

        def pick(chunks: list[dict]) -> tuple[bool, dict | None]:
            for c in chunks:
                key = str(c.get("id"))
                if key in tried or not self._eligible(c):
                    continue
                tried.add(key)
                attempts = int(c.get("attempts") or 0)
                if not valid_chunk_id(c.get("id")) or c.get("workspace") != ws:
                    # 큐 파일이 손대졌을 때: 결과 파일 경로를 만들지 않고 포기로 둔다
                    c.update(status="failed", attempts=max(attempts, self.max_attempts), updatedAt=_iso(now),
                             lastError="청크 id나 워크스페이스가 큐와 맞지 않아 건너뛰었어요.")
                    return True, {"kind": "bad", "id": key}
                prev = {"status": c.get("status") or "pending", "attempts": attempts}
                c.update(status="running", attempts=attempts + 1, lastError=None, updatedAt=_iso(now))
                return True, {"kind": "ok", "chunk": dict(c, workspace=ws), "prev": prev}
            return False, None

        return _mutate(self.settings, ws, pick)

    async def _drain(self, ws: str, extractor: Extractor, via: str, summary: dict, now: datetime) -> str | None:
        """ws의 처리할 청크를 하나씩 끝까지. 창을 멈춰야 하면 그 이유를 돌려준다."""
        # 이번 창에서 이미 시도한 청크는 다시 집지 않는다(파싱 실패 청크를 한 창에서 되풀이하지 않게)
        tried: set[str] = set()
        while True:
            # 큐 잠금·파일 입출력은 모두 asyncio.to_thread로: 다른 프로세스(--enqueue 등)가 큐 잠금을 쥐어도
            # 이벤트 루프(서버의 /health·/v1/analogy)는 막히지 않는다(T-161)
            if via == "cloud" and await asyncio.to_thread(read_cloud_usage, self.settings, now) >= self.daily_cap:
                return "클라우드 하루 상한"
            picked = await asyncio.to_thread(self._pick, ws, tried, now)
            if picked is None:
                return None
            if picked["kind"] == "bad":
                summary["failed"] += 1
                log.error("추출 큐 %s: 안전하지 않은 청크 %r를 포기로 표시했어요.", ws, picked["id"])
                continue
            chunk, prev = picked["chunk"], picked["prev"]
            cid = chunk["id"]
            if via == "cloud":
                # 호출 전에 센다(실패해도 비용이 드니까). 설정 오류(4xx)면 되돌린다
                await asyncio.to_thread(_add_cloud_usage, self.settings, now)
            try:
                entities, relationships = await extractor(chunk["text"])
                entities, relationships = filter_extraction(entities, relationships, self.vocabulary)
            except ExtractConfigError as e:
                # 설정 오류: 청크는 이전 상태·시도 수 그대로 되돌리고 창을 멈춘다(상한에 닿아 포기되지 않게)
                await asyncio.to_thread(_update, self.settings, ws, cid, now, status=prev["status"],
                                        attempts=prev["attempts"], lastError=_short(e))
                if via == "cloud":
                    await asyncio.to_thread(_add_cloud_usage, self.settings, now, -1)
                log.error("추출 큐 %s: %s 설정 오류, 이번 창을 멈춰요(시도 수는 그대로): %s", ws, via, e)
                return "설정 오류"
            except ExtractConnectionError as e:
                await self._fail(ws, cid, now, _short(e), summary)
                log.warning("추출 큐 %s: 청크 %s 연결 실패, 이번 창을 멈춰요: %s", ws, cid, e)
                return "연결 끊김"
            except Exception as e:  # 파싱 실패 등: 그 청크만 실패
                await self._fail(ws, cid, now, _short(e), summary)
                log.warning("추출 큐 %s: 청크 %s 추출 실패: %s", ws, cid, e)
                continue
            try:
                await self.insert(chunk, entities, relationships)
            except (ExtractConnectionError, httpx.TransportError) as e:
                await self._fail(ws, cid, now, f"삽입 중 연결 실패: {_short(e)}", summary)
                log.warning("추출 큐 %s: 청크 %s 삽입 중 연결 실패, 이번 창을 멈춰요: %s", ws, cid, e)
                return "연결 끊김"
            except Exception as e:
                await self._fail(ws, cid, now, f"삽입 실패: {type(e).__name__}: {_short(e)}", summary)
                log.warning("추출 큐 %s: 청크 %s 삽입 실패: %s", ws, cid, e)
                continue
            await asyncio.to_thread(_update, self.settings, ws, cid, now, status="done", lastError=None, via=via)
            summary["done"] += 1
            if via == "cloud":
                summary["cloud"] += 1

    async def _fail(self, ws: str, cid: str, now: datetime, message: str, summary: dict) -> None:
        await asyncio.to_thread(_update, self.settings, ws, cid, now, status="failed",
                                lastError=message[:ERROR_MAX_LEN])
        summary["failed"] += 1


def _default_clock() -> datetime:
    # 시간창은 서버 시간대, 하루 상한은 UTC 날짜로 본다
    return datetime.now().astimezone()


async def run_forever(worker: ExtractWorker, clock: Callable[[], datetime] = _default_clock,
                      sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, interval_s: float | None = None,
                      max_iterations: int | None = None, on_start: Callable[[], None] | None = None) -> list[dict]:
    """워커 잠금을 잡고(이미 잡혀 있으면 WorkerLocked), running을 복구한 뒤 interval_s마다 창을 연다.

    창 오류는 기록만 하고 다음 주기로. 큐 파일이 깨진 워크스페이스는 그 워크스페이스만 건너뛴다.
    on_start는 잠금을 잡고 복구까지 끝낸 뒤 한 번 부른다(서버 /health의 extract.running, T-161).
    취소되면(서버 종료) 잠금을 풀고 끝난다. 처리 중이던 running 청크는 다음 시작의 복구가 되돌린다.
    """
    interval = worker.settings.extract_interval_s if interval_s is None else interval_s
    results: list[dict] = []
    # 잠금은 기다리지 않고 잡으므로 루프 안에서 바로. 복구는 큐 잠금을 기다릴 수 있어 스레드에서(T-161)
    with worker_lock(worker.settings):
        await asyncio.to_thread(recover_running, worker.settings, worker.workspaces)
        if on_start is not None:
            on_start()
        i = 0
        while max_iterations is None or i < max_iterations:
            if i:
                await sleep(interval)
            try:
                summary = await worker.run_window(clock())
            except Exception as e:  # 워커는 계속 돈다
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


def build_default_worker(settings: Settings, workspaces: Iterable[str] | None = None) -> ExtractWorker:
    """설정만으로 실제 워커: 맥 Ollama 추출 + 결과 파일 삽입(T-421 전) + (설정되면) 클라우드 대체."""
    graph = settings.common_graph()
    return ExtractWorker(
        settings, list(settings.extract_workspaces if workspaces is None else workspaces),
        extractor=make_ollama_extractor(settings.extract_ollama_url, settings.extract_model, graph),
        insert=make_result_writer(settings),
        cloud_extractor=_default_cloud(settings, graph),
        vocabulary=build_extraction_config(graph)["vocabulary"],
    )


def requeue_after_reset(chunks: list[dict], now: datetime | None = None) -> list[dict]:
    """seed --reset 뒤 되돌려 쓸 큐(T-161). 인덱스가 지워졌으니 done은 다시 추출·삽입하도록 pending(시도 0)으로.

    failed(상한 도달 포함)·pending은 그대로 둔다. running은 워커가 멈춘 뒤에만 리셋하므로 죽은 흔적이라
    그대로 두면 다음 워커 시작의 복구가 되돌린다.
    """
    out = []
    for c in chunks:
        c = dict(c)
        if c.get("status") == "done":
            c.update(status="pending", attempts=0, lastError=None, via=None, updatedAt=_iso(now))
        out.append(c)
    return out


def read_queue_for_reset(settings: Settings, workspace: str) -> list[dict]:
    """리셋 전에 큐를 큐 잠금 아래 읽는다. 깨졌으면 QueueError(부르는 쪽이 리셋을 거절한다)."""
    with queue_lock(settings, workspace, shared=True):
        return _read_queue(settings, workspace)


def restore_queue_after_reset(settings: Settings, workspace: str, chunks: list[dict],
                              now: datetime | None = None) -> None:
    """리셋으로 새로 만든 워크스페이스 폴더에 큐를 되돌려 쓴다(done → pending).

    그사이 --enqueue가 넣은 청크가 있으면 뒤에 붙인다(잃지 않게).
    """
    restored = requeue_after_reset(chunks, now)
    if not restored:
        return
    with queue_lock(settings, workspace):
        have = {c.get("id") for c in restored}
        current = _read_queue(settings, workspace)
        _write_queue(settings, workspace, restored + [c for c in current if c.get("id") not in have])


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
            try:
                c = status_counts(settings, ws, settings.extract_max_attempts)
            except QueueError as e:
                print(f"{ws}: {e}")
                continue
            print(f"{ws}: pending {c['pending']}, running {c['running']}, done {c['done']}, "
                  f"failed {c['failed']}(포기 {c['gaveUp']}), 합계 {c['total']}")
        return 0

    # --once
    if not settings.extract_ollama_url:
        print("EXTRACT_OLLAMA_URL이 비어 있어 맥 추출이 꺼져 있어요.")
    worker = build_default_worker(settings, workspaces)
    try:
        with worker_lock(settings):
            recover_running(settings, workspaces)
            s = asyncio.run(worker.run_window(_default_clock()))
    except WorkerLocked as e:
        print(str(e))
        return 1
    if s["skipped"]:
        print(f"건너뜀: {s['skipped']}")
    else:
        print(f"맥 응답 {'있음' if s['healthy'] else '없음'}: 완료 {s['done']}(클라우드 {s['cloud']}), "
              f"실패 {s['failed']}" + (f", 멈춤: {s['stopped']}" if s["stopped"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
