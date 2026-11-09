"""추출 큐 워커(T-414) 테스트.

가짜 Ollama는 127.0.0.1의 실제 소켓 서버(ThreadingHTTPServer)다. 켰다 끄고 같은 포트로 다시 켜서
맥이 꺼졌다 켜지는 상황을 그대로 만든다. 밖으로 나가는 네트워크는 없다.
"""
from __future__ import annotations

import asyncio
import json
import socket
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app import extract_worker as ew
from app.config import Settings, load_common_graph
from app.seedmeta import WorkspaceError

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"
# 시간창 안(02:00 UTC)과 밖(12:00 UTC)
IN_WINDOW = datetime(2026, 11, 10, 2, 0, tzinfo=timezone.utc)
OUT_WINDOW = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)
USER_WS = "u_tester"
COMMON_WS = "common_maplestory"


# ── 가짜 Ollama(실제 소켓) ─────────────────────────────


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeOllama:
    """/api/tags 와 /api/chat 만 흉내 낸다.

    - 사용자 글에 "깨진응답"이 있으면 JSON이 아닌 content(파싱 실패)
    - die_on_call=N 이면 N번째 /api/chat 요청에서 답 없이 연결을 끊고 서버를 내린다(처리 중 맥이 꺼짐)
    """

    def __init__(self, port: int | None = None) -> None:
        self.port = port or _free_port()
        self.chat_calls: list[dict] = []
        self.die_on_call: int | None = None
        # 0이 아니면 /api/chat이 이 상태 코드로 답한다(설정 오류 흉내, 예 404 모델 없음)
        self.chat_status = 0
        # 0보다 크면 /api/chat이 이만큼(초) 늦게 답한다(청크 중간 타임아웃 흉내)
        self.delay_s = 0.0
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._stopper: threading.Thread | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def running(self) -> bool:
        self._join_stopper()
        return self._server is not None

    def _join_stopper(self) -> None:
        if self._stopper is not None:
            self._stopper.join(timeout=5)
            self._stopper = None

    def stop_in_background(self) -> None:
        """요청 처리 스레드에서 부른다. 서버는 바로 '꺼짐'으로 보고, 실제 종료는 다른 스레드에서."""
        server, self._server = self._server, None
        if server is not None:
            self._stopper = threading.Thread(target=lambda: (server.shutdown(), server.server_close()), daemon=True)
            self._stopper.start()

    def start(self) -> None:
        self._join_stopper()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # 테스트 출력 조용히
                pass

            def _json(self, status: int, body: dict) -> None:
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == "/api/tags":
                    self._json(200, {"models": [{"name": "gemma4:12b"}]})
                else:
                    self._json(404, {"error": "없음"})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path != "/api/chat":
                    self._json(404, {"error": "없음"})
                    return
                fake.chat_calls.append(body)
                if fake.die_on_call is not None and len(fake.chat_calls) >= fake.die_on_call:
                    fake.die_on_call = None
                    # 답 없이 연결을 끊고, 서버도 내린다(다른 스레드에서)
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    fake.stop_in_background()
                    return
                if fake.delay_s:
                    import time as _time
                    _time.sleep(fake.delay_s)
                if fake.chat_status:
                    self._json(fake.chat_status, {"error": f"model '{body.get('model')}' not found"})
                    return
                user = body["messages"][-1]["content"]
                if "깨진응답" in user:
                    content = "죄송해요, 지금은 못 해요."
                else:
                    content = json.dumps({
                        "entities": [
                            {"name": "스타포스 강화", "type": "게임시스템", "description": "장비 강화 시스템이다."},
                            {"name": "확률형 강화", "type": "추상구조", "description": "확률로 강화되는 구조다."},
                            {"name": "목록밖구조", "type": "추상구조", "description": "통제 어휘 밖이다."},
                        ],
                        "relationships": [
                            {"source": "스타포스 강화", "target": "확률형 강화", "keywords": "확률", "description": "확률로 강화된다."},
                            {"source": "스타포스 강화", "target": "목록밖구조", "keywords": "x", "description": "버려질 관계."},
                        ],
                    }, ensure_ascii=False)
                try:
                    self._json(200, {"model": body.get("model"), "message": {"role": "assistant", "content": content},
                                     "done": True})
                except OSError:  # 클라이언트가 타임아웃으로 먼저 끊음
                    pass

        self._server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02},
                                        daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._join_stopper()
        server, self._server = self._server, None
        if server is not None:
            server.shutdown()
            server.server_close()


@pytest.fixture
def ollama():
    fake = FakeOllama()
    fake.start()
    yield fake
    fake.stop()


# ── 공용 ─────────────────────────────────────────────


def make_settings(tmp_path: Path, **env: str) -> Settings:
    base = {"LIGHTRAG_WORKING_DIR": str(tmp_path / "rag"), "COMMON_GRAPH_PATH": str(COMMON_GRAPH),
            "EMBEDDING_PROVIDER": "hash", "EXTRACT_WINDOW": "01:00-07:00"}
    base.update(env)
    return Settings.from_env(base)


class Inserted:
    """가짜 LightRAG 삽입 콜백. 같은 청크가 두 번 들어오는지 본다."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list, list]] = []

    async def __call__(self, chunk: dict, entities: list, relationships: list) -> None:
        self.calls.append((chunk["id"], entities, relationships))

    def ids(self) -> list[str]:
        return [c[0] for c in self.calls]


def make_worker(settings: Settings, url: str, insert: Inserted, workspaces=(COMMON_WS,), **kw) -> ew.ExtractWorker:
    graph = load_common_graph(COMMON_GRAPH)
    return ew.ExtractWorker(settings, list(workspaces), extractor=ew.make_ollama_extractor(url, "gemma4:12b", graph),
                            insert=insert, ollama_url=url, **kw)


def statuses(settings: Settings, ws: str = COMMON_WS) -> list[str]:
    return [c["status"] for c in ew.load_queue(settings, ws)]


def enqueue_n(settings: Settings, ws: str, n: int, prefix: str = "문단") -> None:
    for i in range(n):
        ew.enqueue(settings, ws, f"doc-{prefix}-{i}", f"{prefix} {i}: 스타포스 강화는 확률로 별을 붙인다.")


# ── 청크 나누기·큐 파일 ───────────────────────────────


def test_chunk_text_packs_paragraphs_with_overlap():
    paras = [("가" * 500) for _ in range(5)]
    chunks = ew.chunk_text("\n\n".join(paras), size=1200, overlap=100)
    assert len(chunks) >= 2
    assert all(len(c) <= 1200 for c in chunks)
    # 다음 청크는 앞 청크 끝 100자로 시작한다
    assert chunks[1].startswith(chunks[0][-100:])


def test_chunk_text_splits_long_paragraph_and_skips_blank():
    chunks = ew.chunk_text("나" * 3000 + "\n\n\n   \n\n" + "다" * 10, size=1200, overlap=100)
    assert all(0 < len(c) <= 1200 for c in chunks)
    assert "".join(chunks).count("다") == 10
    assert ew.chunk_text("  \n\n ") == []


def test_enqueue_writes_pending_chunks_and_is_idempotent(tmp_path):
    s = make_settings(tmp_path)
    added = ew.enqueue(s, COMMON_WS, "guide-1", "첫 문단이에요.\n\n둘째 문단이에요.")
    assert added == 1
    again = ew.enqueue(s, COMMON_WS, "guide-1", "첫 문단이에요.\n\n둘째 문단이에요.")
    assert again == 0  # 같은 문서·같은 청크는 다시 넣지 않는다
    q = ew.load_queue(s, COMMON_WS)
    assert len(q) == 1
    c = q[0]
    assert c["status"] == "pending" and c["attempts"] == 0 and c["docId"] == "guide-1"
    assert c["workspace"] == COMMON_WS and c["lastError"] is None and c["updatedAt"]
    path = tmp_path / "rag" / COMMON_WS / ew.QUEUE_FILE
    assert path.is_file()


def test_queue_write_is_atomic_and_leaves_no_temp_files(tmp_path, monkeypatch):
    s = make_settings(tmp_path)
    ew.enqueue(s, COMMON_WS, "d1", "하나")
    before = (tmp_path / "rag" / COMMON_WS / ew.QUEUE_FILE).read_text("utf-8")

    def boom(*a, **k):
        raise OSError("디스크 가득")

    monkeypatch.setattr(ew.seedmeta.os, "replace", boom)
    with pytest.raises(OSError):
        ew.enqueue(s, COMMON_WS, "d2", "둘")
    monkeypatch.undo()
    assert (tmp_path / "rag" / COMMON_WS / ew.QUEUE_FILE).read_text("utf-8") == before
    # 임시 파일은 남지 않는다(잠금 파일만 옆에 있다)
    assert sorted(p.name for p in (tmp_path / "rag" / COMMON_WS).iterdir()) == [ew.QUEUE_FILE, ew.QUEUE_LOCK_FILE]


@pytest.mark.parametrize("bad", ["../escape", "a/b", ".", "", "with space"])
def test_queue_rejects_unsafe_workspace(tmp_path, bad):
    s = make_settings(tmp_path)
    with pytest.raises(WorkspaceError):
        ew.enqueue(s, bad, "d", "글")


def test_queue_rejects_symlinked_workspace(tmp_path):
    s = make_settings(tmp_path)
    (tmp_path / "rag").mkdir()
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "rag" / "u_link").symlink_to(tmp_path / "elsewhere")
    with pytest.raises(WorkspaceError):
        ew.enqueue(s, "u_link", "d", "글")


def test_broken_queue_file_raises_instead_of_wiping(tmp_path):
    s = make_settings(tmp_path)
    d = tmp_path / "rag" / COMMON_WS
    d.mkdir(parents=True)
    (d / ew.QUEUE_FILE).write_text("{깨짐", "utf-8")
    with pytest.raises(ew.QueueError):
        ew.load_queue(s, COMMON_WS)


# ── 시간창 ───────────────────────────────────────────


def test_window_parsing_and_wrap_past_midnight():
    w = ew.parse_windows("12:10-13:00, 23:00-07:00")
    assert ew.in_window(datetime(2026, 1, 1, 12, 30), w)
    assert ew.in_window(datetime(2026, 1, 1, 23, 30), w)
    assert ew.in_window(datetime(2026, 1, 1, 3, 0), w)
    assert not ew.in_window(datetime(2026, 1, 1, 8, 0), w)
    assert ew.in_window(datetime(2026, 1, 1, 8, 0), ew.parse_windows(""))  # 비우면 늘 열림
    with pytest.raises(ValueError):
        ew.parse_windows("25:00-01:00")


# ── 헬스체크 ─────────────────────────────────────────


def test_health_true_when_up_false_when_down(ollama):
    assert asyncio.run(ew.health(ollama.url)) is True
    ollama.stop()
    assert asyncio.run(ew.health(ollama.url)) is False
    assert asyncio.run(ew.health("")) is False  # 주소가 비면 워커 꺼짐


# ── 창 실행: 켜짐 → 완료 ──────────────────────────────


def test_window_processes_chunks_one_by_one_and_filters_vocabulary(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 3)
    ins = Inserted()
    summary = asyncio.run(make_worker(s, ollama.url, ins).run_window(IN_WINDOW))
    assert summary["healthy"] is True and summary["done"] == 3
    assert statuses(s) == ["done", "done", "done"]
    assert len(ollama.chat_calls) == 3
    # 요청 모양: 스트리밍 끔, JSON 모드, 모델, 컨텍스트
    req = ollama.chat_calls[0]
    assert req["stream"] is False and req["format"] == "json" and req["model"] == "gemma4:12b"
    assert req["options"]["num_ctx"] == 16384
    assert "확률형 강화" in req["messages"][0]["content"]  # 통제 어휘가 system에(규칙 9)
    # 삽입은 청크마다 한 번, 목록 밖 추상구조와 그 관계는 버려진다
    assert len(ins.calls) == 3
    _, ents, rels = ins.calls[0]
    assert [e["name"] for e in ents] == ["스타포스 강화", "확률형 강화"]
    assert [r["target"] for r in rels] == ["확률형 강화"]


def test_parse_failure_marks_failed_and_continues(tmp_path, ollama):
    s = make_settings(tmp_path)
    ew.enqueue(s, COMMON_WS, "a", "깨진응답 문단")
    ew.enqueue(s, COMMON_WS, "b", "정상 문단")
    ins = Inserted()
    summary = asyncio.run(make_worker(s, ollama.url, ins).run_window(IN_WINDOW))
    q = ew.load_queue(s, COMMON_WS)
    assert [c["status"] for c in q] == ["failed", "done"]
    assert q[0]["attempts"] == 1 and "JSON" in q[0]["lastError"]
    assert summary["failed"] == 1 and summary["done"] == 1
    assert len(ins.calls) == 1


def test_outside_window_does_nothing(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 2)
    ins = Inserted()
    summary = asyncio.run(make_worker(s, ollama.url, ins).run_window(OUT_WINDOW))
    assert summary["skipped"] == "시간창 밖"
    assert statuses(s) == ["pending", "pending"]
    assert ollama.chat_calls == []


def test_unhealthy_does_nothing_without_fallback(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 2)
    ollama.stop()
    summary = asyncio.run(make_worker(s, ollama.url, Inserted()).run_window(IN_WINDOW))
    assert summary["healthy"] is False and summary["done"] == 0
    assert statuses(s) == ["pending", "pending"]


# ── 처리 중 끔 → 실패·창 중단 → 다시 켬 → 재개 ─────────────


def test_mac_off_mid_window_then_resume_next_window(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 4)
    ins = Inserted()
    worker = make_worker(s, ollama.url, ins)
    ollama.die_on_call = 2  # 두 번째 청크 처리 중 맥이 꺼진다

    first = asyncio.run(worker.run_window(IN_WINDOW))
    q = ew.load_queue(s, COMMON_WS)
    assert [c["status"] for c in q] == ["done", "failed", "pending", "pending"]
    assert q[1]["attempts"] == 1 and "연결" in q[1]["lastError"]
    assert first["stopped"]  # 이번 창은 중단
    assert not ollama.running
    assert ins.ids() == [q[0]["id"]]

    # 맥이 꺼진 동안의 창: 아무것도 안 함
    asyncio.run(worker.run_window(IN_WINDOW))
    assert statuses(s) == ["done", "failed", "pending", "pending"]

    # 다시 켬(같은 포트) → 다음 창에서 실패 청크 재시도 + 나머지 완료
    ollama.start()
    second = asyncio.run(worker.run_window(IN_WINDOW))
    q = ew.load_queue(s, COMMON_WS)
    assert [c["status"] for c in q] == ["done", "done", "done", "done"]
    assert q[1]["attempts"] == 2 and second["done"] == 3
    # 잃은 청크도, 두 번 들어간 청크도 없다
    assert sorted(ins.ids()) == sorted(c["id"] for c in q)
    assert len(ins.ids()) == len(set(ins.ids()))


def test_attempts_cap_gives_up(tmp_path, ollama):
    s = make_settings(tmp_path)
    ew.enqueue(s, COMMON_WS, "a", "깨진응답 문단")
    worker = make_worker(s, ollama.url, Inserted(), max_attempts=2)
    for _ in range(4):
        asyncio.run(worker.run_window(IN_WINDOW))
    q = ew.load_queue(s, COMMON_WS)
    assert q[0]["status"] == "failed" and q[0]["attempts"] == 2
    assert len(ollama.chat_calls) == 2
    counts = ew.status_counts(s, COMMON_WS, max_attempts=2)
    assert counts["gaveUp"] == 1 and counts["failed"] == 1


def test_ollama_4xx_is_config_error_and_does_not_use_attempts(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 2)
    ollama.chat_status = 404  # 모델 이름이 틀림
    worker = make_worker(s, ollama.url, Inserted(), max_attempts=2)
    for _ in range(4):
        summary = asyncio.run(worker.run_window(IN_WINDOW))
        assert summary["stopped"]  # 창은 멈춘다
    q = ew.load_queue(s, COMMON_WS)
    assert [c["status"] for c in q] == ["pending", "pending"]
    assert [c["attempts"] for c in q] == [0, 0]
    assert "설정" in q[0]["lastError"] and "404" in q[0]["lastError"]
    assert ew.status_counts(s, COMMON_WS, max_attempts=2)["gaveUp"] == 0
    assert len(ollama.chat_calls) == 4  # 창마다 앞 청크 한 번만 시도

    ollama.chat_status = 0  # 설정을 고침
    asyncio.run(worker.run_window(IN_WINDOW))
    q = ew.load_queue(s, COMMON_WS)
    assert [c["status"] for c in q] == ["done", "done"]
    assert [c["attempts"] for c in q] == [1, 1]


def test_ollama_4xx_keeps_previous_failed_status(tmp_path, ollama):
    s = make_settings(tmp_path)
    ew.enqueue(s, COMMON_WS, "a", "깨진응답 문단")
    worker = make_worker(s, ollama.url, Inserted())
    asyncio.run(worker.run_window(IN_WINDOW))  # 파싱 실패로 attempts 1
    ollama.chat_status = 400
    asyncio.run(worker.run_window(IN_WINDOW))
    c = ew.load_queue(s, COMMON_WS)[0]
    assert c["status"] == "failed" and c["attempts"] == 1 and "400" in c["lastError"]


def test_ollama_5xx_still_uses_attempt(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 1)
    ollama.chat_status = 500
    summary = asyncio.run(make_worker(s, ollama.url, Inserted()).run_window(IN_WINDOW))
    c = ew.load_queue(s, COMMON_WS)[0]
    assert summary["stopped"] and c["status"] == "failed" and c["attempts"] == 1


def test_insert_error_marks_failed_not_done(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 2)

    async def bad_insert(chunk, entities, relationships):
        raise RuntimeError("삽입 실패")

    asyncio.run(make_worker(s, ollama.url, bad_insert).run_window(IN_WINDOW))
    q = ew.load_queue(s, COMMON_WS)
    assert [c["status"] for c in q] == ["failed", "failed"]
    assert "삽입" in q[0]["lastError"]


# ── 시작 시 running 복구 ───────────────────────────────


def test_recover_running_on_start(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 2)
    # 프로세스가 처리 중 죽은 상태를 흉내
    q = ew.load_queue(s, COMMON_WS)
    q[0]["status"] = "running"
    ew.save_queue(s, COMMON_WS, q)
    worker = make_worker(s, ollama.url, Inserted())
    # 시작 시 복구: running → pending
    assert ew.recover_running(s, [COMMON_WS]) == 1
    assert statuses(s) == ["pending", "pending"]
    asyncio.run(worker.run_window(IN_WINDOW))
    assert statuses(s) == ["done", "done"]


def test_running_chunk_is_not_picked_by_window(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 1)
    q = ew.load_queue(s, COMMON_WS)
    q[0]["status"] = "running"
    ew.save_queue(s, COMMON_WS, q)
    asyncio.run(make_worker(s, ollama.url, Inserted()).run_window(IN_WINDOW))
    assert statuses(s) == ["running"]


# ── 클라우드 대체 ─────────────────────────────────────


class FakeCloud:
    def __init__(self) -> None:
        self.texts: list[str] = []

    async def __call__(self, text: str):
        self.texts.append(text)
        return ([{"name": "확률형 강화", "type": "추상구조", "description": "구름"}], [])


def test_cloud_fallback_only_user_workspaces_and_daily_cap(tmp_path, ollama):
    s = make_settings(tmp_path, EXTRACT_FALLBACK="cloud", EXTRACT_CLOUD_DAILY_CAP="2")
    enqueue_n(s, COMMON_WS, 2, "공통")
    enqueue_n(s, USER_WS, 3, "내문서")
    ollama.stop()  # 맥 꺼짐
    cloud = FakeCloud()
    ins = Inserted()
    worker = make_worker(s, ollama.url, ins, workspaces=(COMMON_WS, USER_WS), cloud_extractor=cloud)
    summary = asyncio.run(worker.run_window(IN_WINDOW))
    assert summary["cloud"] == 2
    assert statuses(s, COMMON_WS) == ["pending", "pending"]  # 공통은 늘 맥만
    assert statuses(s, USER_WS) == ["done", "done", "pending"]  # 하루 상한 2
    assert all("공통" not in t for t in cloud.texts)
    usage = json.loads((tmp_path / "rag" / ew.USAGE_FILE).read_text("utf-8"))
    assert usage == {"date": "2026-11-10", "cloudChunks": 2}
    assert ew.load_queue(s, USER_WS)[0]["via"] == "cloud"

    # 같은 날 다음 창: 상한이라 더 안 함
    asyncio.run(worker.run_window(IN_WINDOW))
    assert statuses(s, USER_WS) == ["done", "done", "pending"]
    # 다음 날(UTC): 다시 쓸 수 있다
    asyncio.run(worker.run_window(datetime(2026, 11, 11, 2, 0, tzinfo=timezone.utc)))
    assert statuses(s, USER_WS) == ["done", "done", "done"]
    assert len(cloud.texts) == 3


def test_cloud_not_used_when_flag_none_or_mac_up(tmp_path, ollama):
    s = make_settings(tmp_path)  # 기본 EXTRACT_FALLBACK=none
    enqueue_n(s, USER_WS, 1)
    ollama.stop()
    cloud = FakeCloud()
    asyncio.run(make_worker(s, ollama.url, Inserted(), workspaces=(USER_WS,), cloud_extractor=cloud)
                .run_window(IN_WINDOW))
    assert cloud.texts == [] and statuses(s, USER_WS) == ["pending"]

    s2 = make_settings(tmp_path / "b", EXTRACT_FALLBACK="cloud")
    enqueue_n(s2, USER_WS, 1)
    ollama.start()
    asyncio.run(make_worker(s2, ollama.url, Inserted(), workspaces=(USER_WS,), cloud_extractor=cloud)
                .run_window(IN_WINDOW))
    assert cloud.texts == [] and ew.load_queue(s2, USER_WS)[0]["via"] == "mac"


def test_settings_reject_unknown_fallback(tmp_path):
    with pytest.raises(ValueError):
        make_settings(tmp_path, EXTRACT_FALLBACK="gpu")


def test_settings_defaults(tmp_path):
    s = Settings.from_env({"COMMON_GRAPH_PATH": str(COMMON_GRAPH)})
    assert s.extract_ollama_url == ""  # 비어 있으면 워커 꺼짐
    assert s.extract_fallback == "none" and s.extract_cloud_daily_cap == 50
    assert s.extract_interval_s == 300 and s.extract_max_attempts == 5
    assert s.extract_window == "" and s.extract_workspaces == (s.workspace,)


# ── 주기 루프 ────────────────────────────────────────


def test_run_forever_calls_window_each_interval(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 1)
    worker = make_worker(s, ollama.url, Inserted())
    times = iter([OUT_WINDOW, IN_WINDOW, IN_WINDOW])
    slept: list[float] = []

    async def fake_sleep(sec: float) -> None:
        slept.append(sec)

    results = asyncio.run(ew.run_forever(worker, clock=lambda: next(times), sleep=fake_sleep,
                                         interval_s=300, max_iterations=3))
    assert [r.get("skipped") for r in results][0] == "시간창 밖"
    assert results[1]["done"] == 1
    assert slept == [300, 300]
    assert statuses(s) == ["done"]


# ── CLI ─────────────────────────────────────────────


def test_cli_enqueue_status_once(tmp_path, ollama, capsys, monkeypatch):
    env = {"LIGHTRAG_WORKING_DIR": str(tmp_path / "rag"), "COMMON_GRAPH_PATH": str(COMMON_GRAPH),
           "EXTRACT_OLLAMA_URL": ollama.url, "EXTRACT_WINDOW": ""}
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    doc = tmp_path / "guide.txt"
    doc.write_text("스타포스 강화 문단이에요.\n\n" + "큐브 문단이에요. " * 200, "utf-8")

    assert ew.main(["--enqueue", str(doc)]) == 0
    out = capsys.readouterr().out
    assert "청크" in out

    assert ew.main(["--status"]) == 0
    out = capsys.readouterr().out
    assert "pending" in out and COMMON_WS in out

    assert ew.main(["--once"]) == 0
    capsys.readouterr()
    q = ew.load_queue(Settings.from_env(), COMMON_WS)
    assert q and all(c["status"] == "done" for c in q)
    # 기본 삽입(T-421 전): 추출 결과를 워크스페이스 폴더에 청크별 파일로 남긴다
    results = tmp_path / "rag" / COMMON_WS / ew.RESULTS_DIR
    assert sorted(p.stem for p in results.iterdir()) == sorted(ew.result_name(c["id"]) for c in q)


# ── 수정 2회차(리뷰) ─────────────────────────────────


def _corrupt(tmp_path: Path, ws: str) -> None:
    d = tmp_path / "rag" / ws
    d.mkdir(parents=True, exist_ok=True)
    (d / ew.QUEUE_FILE).write_text("{깨짐", "utf-8")


def test_broken_queue_only_stops_its_own_workspace(tmp_path, ollama):
    s = make_settings(tmp_path)
    _corrupt(tmp_path, COMMON_WS)
    enqueue_n(s, USER_WS, 2)
    worker = make_worker(s, ollama.url, Inserted(), workspaces=(COMMON_WS, USER_WS))
    assert ew.recover_running(s, [COMMON_WS, USER_WS]) == 0  # 깨진 쪽은 건너뛰고 죽지 않는다
    results = asyncio.run(ew.run_forever(worker, clock=lambda: IN_WINDOW, interval_s=0, max_iterations=1))
    assert results[0]["done"] == 2 and COMMON_WS in results[0]["errors"]
    assert statuses(s, USER_WS) == ["done", "done"]
    # 깨진 파일은 그대로(비우지 않음)
    assert (tmp_path / "rag" / COMMON_WS / ew.QUEUE_FILE).read_text("utf-8") == "{깨짐"


def test_cli_status_survives_broken_queue(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("LIGHTRAG_WORKING_DIR", str(tmp_path / "rag"))
    monkeypatch.setenv("COMMON_GRAPH_PATH", str(COMMON_GRAPH))
    monkeypatch.setenv("EXTRACT_WORKSPACES", f"{COMMON_WS},{USER_WS}")
    _corrupt(tmp_path, COMMON_WS)
    ew.enqueue(Settings.from_env(), USER_WS, "d", "글")
    assert ew.main(["--status"]) == 0
    out = capsys.readouterr().out
    assert "읽지 못했어요" in out and f"{USER_WS}: pending 1" in out


def test_worker_lock_refuses_second_worker(tmp_path, ollama, capsys, monkeypatch):
    s = make_settings(tmp_path)
    with ew.worker_lock(s):
        with pytest.raises(ew.WorkerLocked):
            with ew.worker_lock(s):
                pass
        worker = make_worker(s, ollama.url, Inserted())
        with pytest.raises(ew.WorkerLocked):
            asyncio.run(ew.run_forever(worker, clock=lambda: IN_WINDOW, max_iterations=1))
        for k, v in {"LIGHTRAG_WORKING_DIR": str(tmp_path / "rag"), "COMMON_GRAPH_PATH": str(COMMON_GRAPH),
                     "EXTRACT_OLLAMA_URL": ollama.url}.items():
            monkeypatch.setenv(k, v)
        assert ew.main(["--once"]) != 0
        assert "이미" in capsys.readouterr().out
    # 풀리면 다시 잡을 수 있다
    with ew.worker_lock(s):
        pass


def test_enqueue_waits_for_queue_lock_and_loses_nothing(tmp_path):
    s = make_settings(tmp_path)
    ew.enqueue(s, COMMON_WS, "first", "첫 글")
    done = threading.Event()

    def other():
        ew.enqueue(s, COMMON_WS, "second", "둘째 글")
        done.set()

    with ew.queue_lock(s, COMMON_WS):
        t = threading.Thread(target=other)
        t.start()
        assert not done.wait(0.3)  # 잠금을 쥔 동안 기다린다
        # 잠금 안에서 읽고-고치고-쓰기(워커가 청크 상태를 바꾸는 것과 같음)
        q = ew._read_queue(s, COMMON_WS)
        q[0]["status"] = "done"
        ew._write_queue(s, COMMON_WS, q)
    t.join(5)
    assert done.is_set()
    q = ew.load_queue(s, COMMON_WS)
    assert [c["docId"] for c in q] == ["first", "second"]
    assert q[0]["status"] == "done"  # 워커 변경도 남는다


def test_concurrent_enqueue_during_window_loses_no_chunks(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 15, "먼저")
    worker = make_worker(s, ollama.url, Inserted())

    def adder():
        for i in range(15):
            ew.enqueue(s, COMMON_WS, f"later-{i}", f"나중 {i}: 스타포스 강화")

    t = threading.Thread(target=adder)
    t.start()
    asyncio.run(worker.run_window(IN_WINDOW))
    t.join(10)
    q = ew.load_queue(s, COMMON_WS)
    assert len(q) == 30 and len({c["id"] for c in q}) == 30
    assert {c["docId"] for c in q} >= {f"later-{i}" for i in range(15)}


def test_empty_ollama_url_means_worker_off_even_with_cloud(tmp_path):
    s = make_settings(tmp_path, EXTRACT_FALLBACK="cloud")
    enqueue_n(s, USER_WS, 1)
    cloud = FakeCloud()
    worker = make_worker(s, "", Inserted(), workspaces=(USER_WS,), cloud_extractor=cloud)
    summary = asyncio.run(worker.run_window(IN_WINDOW))
    assert summary["skipped"] and cloud.texts == []
    assert statuses(s, USER_WS) == ["pending"]


def test_pending_at_attempt_cap_is_given_up_after_crash_loop(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 1)
    q = ew.load_queue(s, COMMON_WS)
    q[0].update(status="running", attempts=2)  # 처리 중 프로세스가 죽기를 되풀이
    ew.save_queue(s, COMMON_WS, q)
    assert ew.recover_running(s, [COMMON_WS]) == 1
    c = ew.load_queue(s, COMMON_WS)[0]
    assert c["status"] == "pending" and c["attempts"] == 2  # 시도 수는 그대로
    asyncio.run(make_worker(s, ollama.url, Inserted(), max_attempts=2).run_window(IN_WINDOW))
    assert ollama.chat_calls == [] and statuses(s) == ["pending"]
    assert ew.status_counts(s, COMMON_WS, max_attempts=2)["gaveUp"] == 1


@pytest.mark.parametrize("field,value", [("id", "../../escape"), ("id", "a/b"), ("workspace", USER_WS)])
def test_unsafe_chunk_is_failed_and_skipped(tmp_path, ollama, field, value):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 2)
    q = ew.load_queue(s, COMMON_WS)
    q[0][field] = value
    ew.save_queue(s, COMMON_WS, q)
    ins = Inserted()
    summary = asyncio.run(make_worker(s, ollama.url, ins).run_window(IN_WINDOW))
    q = ew.load_queue(s, COMMON_WS)
    assert [c["status"] for c in q] == ["failed", "done"]
    assert summary["done"] == 1 and len(ollama.chat_calls) == 1
    assert ins.ids() == [q[1]["id"]]
    assert not (tmp_path / "escape").exists()


def test_result_writer_rejects_bad_id_and_uses_given_workspace(tmp_path):
    s = make_settings(tmp_path)
    write = ew.make_result_writer(s)
    with pytest.raises(ValueError):
        asyncio.run(write({"id": "../x", "docId": "d", "workspace": COMMON_WS}, [], []))
    good = ew.chunk_id("d", 0, "글")
    asyncio.run(write({"id": good, "docId": "d", "workspace": COMMON_WS}, [], []))
    assert (tmp_path / "rag" / COMMON_WS / ew.RESULTS_DIR / f"{good}.json").is_file()


class CloudLLM:
    """make_cloud_extractor에 넘길 가짜 LLM. status가 있으면 LLMError."""

    def __init__(self, status: int = 0) -> None:
        self.status = status
        self.calls = 0

    async def complete(self, system, user, json):
        from app.llm import LLMError

        self.calls += 1
        if self.status:
            raise LLMError(f"Gemini {self.status}: API key not valid", status=self.status)
        return '{"entities": [{"name": "확률형 강화", "type": "추상구조", "description": "구름"}], "relationships": []}'


def test_cloud_4xx_does_not_use_attempts_or_daily_usage(tmp_path, ollama):
    s = make_settings(tmp_path, EXTRACT_FALLBACK="cloud", EXTRACT_CLOUD_DAILY_CAP="5")
    enqueue_n(s, USER_WS, 2)
    ollama.stop()
    llm = CloudLLM(status=400)
    graph = load_common_graph(COMMON_GRAPH)
    worker = make_worker(s, ollama.url, Inserted(), workspaces=(USER_WS,),
                         cloud_extractor=ew.make_cloud_extractor(llm, graph))
    for _ in range(3):
        summary = asyncio.run(worker.run_window(IN_WINDOW))
        assert summary["stopped"]
    q = ew.load_queue(s, USER_WS)
    assert [c["status"] for c in q] == ["pending", "pending"] and [c["attempts"] for c in q] == [0, 0]
    assert "설정" in q[0]["lastError"]
    assert llm.calls == 3
    assert ew.read_cloud_usage(s, IN_WINDOW) == 0
    llm.status = 0  # 키를 고침
    asyncio.run(worker.run_window(IN_WINDOW))
    assert statuses(s, USER_WS) == ["done", "done"]
    assert ew.read_cloud_usage(s, IN_WINDOW) == 2


def test_cloud_5xx_uses_attempt_and_stops(tmp_path, ollama):
    s = make_settings(tmp_path, EXTRACT_FALLBACK="cloud")
    enqueue_n(s, USER_WS, 2)
    ollama.stop()
    graph = load_common_graph(COMMON_GRAPH)
    worker = make_worker(s, ollama.url, Inserted(), workspaces=(USER_WS,),
                         cloud_extractor=ew.make_cloud_extractor(CloudLLM(status=503), graph))
    summary = asyncio.run(worker.run_window(IN_WINDOW))
    q = ew.load_queue(s, USER_WS)
    assert summary["stopped"] and [c["status"] for c in q] == ["failed", "pending"] and q[0]["attempts"] == 1


def test_timeout_mid_chunk_marks_failed_and_stops_window(tmp_path, ollama):
    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 2)
    ollama.delay_s = 1.0
    graph = load_common_graph(COMMON_GRAPH)
    worker = ew.ExtractWorker(s, [COMMON_WS], extractor=ew.make_ollama_extractor(ollama.url, "gemma4:12b", graph,
                                                                                 timeout=0.2),
                              insert=Inserted(), ollama_url=ollama.url)
    summary = asyncio.run(worker.run_window(IN_WINDOW))
    q = ew.load_queue(s, COMMON_WS)
    assert summary["stopped"] == "연결 끊김"
    assert [c["status"] for c in q] == ["failed", "pending"] and q[0]["attempts"] == 1
    assert "Timeout" in q[0]["lastError"]


def test_insert_connection_error_stops_window(tmp_path, ollama):
    import httpx

    s = make_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 2)

    async def insert(chunk, entities, relationships):
        raise httpx.ConnectError("임베딩 서버 연결 실패")

    summary = asyncio.run(make_worker(s, ollama.url, insert).run_window(IN_WINDOW))
    q = ew.load_queue(s, COMMON_WS)
    assert summary["stopped"] == "연결 끊김"
    assert [c["status"] for c in q] == ["failed", "pending"] and "삽입 중 연결" in q[0]["lastError"]
    assert len(ollama.chat_calls) == 1
