"""추출 워커를 서버 수명에 붙이기·리셋 때 큐 보존(T-161) 테스트.

가짜 Ollama는 T-414 테스트의 실제 소켓 서버(127.0.0.1)를 그대로 쓴다. 밖으로 나가는 네트워크는 없다.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import extract_worker as ew
from app import seedmeta
from app.config import Settings, load_common_graph
from app.seed import seed
from fakes import FakeLLM, FakeRetriever
from test_extract_worker import COMMON_GRAPH, COMMON_WS, IN_WINDOW, Inserted, enqueue_n, make_worker, ollama  # noqa: F401

GRAPH = load_common_graph(COMMON_GRAPH)
TOKEN = {"X-Install-Token": "install-t161"}
SENTENCE = "강화할 때마다 확률이 낮아지는 구조예요."
RUNNING_MSG = "추출 워커가 돌고 있어 리셋할 수 없어요. 서버를 멈춘 뒤 다시 해 주세요."


def server_settings(tmp_path: Path, url: str = "", **env: str) -> Settings:
    base = {"LIGHTRAG_WORKING_DIR": str(tmp_path / "rag"), "COMMON_GRAPH_PATH": str(COMMON_GRAPH),
            "EMBEDDING_PROVIDER": "hash", "EMBEDDING_DIM": "64", "EXTRACT_WINDOW": "",
            "EXTRACT_OLLAMA_URL": url}
    base.update(env)
    return Settings.from_env(base)


def make_app(settings: Settings, worker=None):
    from app.main import create_app

    deps = {"settings": settings, "llm": FakeLLM(), "retriever": FakeRetriever(GRAPH)}
    if worker is not None:
        deps["extract_worker"] = worker
    return create_app(deps=deps)


def wait_until(pred, timeout: float = 5.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


def all_done(settings: Settings, ws: str = COMMON_WS) -> bool:
    q = ew.load_queue(settings, ws)
    return bool(q) and all(c["status"] == "done" for c in q)


# ── 서버 수명에 붙이기 ─────────────────────────────────


def test_no_worker_when_ollama_url_empty(tmp_path, ollama):
    s = server_settings(tmp_path)
    enqueue_n(s, COMMON_WS, 1)
    # 주입한 워커가 있어도 주소가 비면 돌리지 않는다
    app = make_app(s, make_worker(s, ollama.url, Inserted()))
    with TestClient(app) as client:
        assert app.state.extract_task is None
        body = client.get("/health").json()
        assert body["extract"] == {"enabled": False, "running": False}
    assert [c["status"] for c in ew.load_queue(s, COMMON_WS)] == ["pending"]
    assert ollama.chat_calls == []


def test_worker_runs_in_server_and_is_cancelled_on_shutdown(tmp_path, ollama):
    s = server_settings(tmp_path, ollama.url)
    enqueue_n(s, COMMON_WS, 2)
    inserted = Inserted()
    app = make_app(s, make_worker(s, ollama.url, inserted))
    with TestClient(app) as client:
        assert wait_until(lambda: all_done(s))
        assert len(inserted.calls) == 2
        body = client.get("/health").json()
        assert body["extract"] == {"enabled": True, "running": True}
        # 맥 주소는 /health에 나가지 않는다(규칙 10)
        assert ollama.url not in json.dumps(body) and "127.0.0.1" not in json.dumps(body)
        task = app.state.extract_task
        assert task is not None and not task.done()
    assert task.done()
    assert app.state.extract_running is False
    # 종료하면 worker.lock이 풀린다
    with ew.worker_lock(s):
        pass


def test_server_builds_default_worker_from_settings(tmp_path, ollama):
    s = server_settings(tmp_path, ollama.url)
    enqueue_n(s, COMMON_WS, 1)
    app = make_app(s)
    with TestClient(app):
        assert wait_until(lambda: all_done(s))
    # 기본 삽입(T-421 전): 결과 파일
    q = ew.load_queue(s, COMMON_WS)
    results = seedmeta.safe_workspace_dir(s) / ew.RESULTS_DIR
    assert sorted(p.stem for p in results.iterdir()) == [c["id"] for c in q]


def test_worker_lock_taken_server_starts_without_worker(tmp_path, ollama, caplog):
    s = server_settings(tmp_path, ollama.url)
    enqueue_n(s, COMMON_WS, 1)
    app = make_app(s, make_worker(s, ollama.url, Inserted()))
    caplog.set_level(logging.WARNING)
    with ew.worker_lock(s):
        with TestClient(app) as client:
            assert wait_until(lambda: app.state.extract_task is not None and app.state.extract_task.done())
            res = client.get("/health")
            assert res.status_code == 200
            assert res.json()["extract"] == {"enabled": True, "running": False}
            assert client.post("/v1/analogy", json={"sentence": SENTENCE}, headers=TOKEN).status_code == 200
    assert any("이미" in r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING)
    assert [c["status"] for c in ew.load_queue(s, COMMON_WS)] == ["pending"]
    assert ollama.chat_calls == []


def test_worker_exception_does_not_kill_server(tmp_path, ollama, caplog):
    s = server_settings(tmp_path, ollama.url)

    worker = make_worker(s, ollama.url, Inserted())

    async def boom(now):  # run_forever가 창 오류를 잡고 다음 주기로 간다
        raise RuntimeError("창 폭발")

    worker.run_window = boom
    app = make_app(s, worker)
    with TestClient(app) as client:
        assert wait_until(lambda: any("창 폭발" in r.getMessage() for r in caplog.records))
        assert client.get("/health").status_code == 200


@pytest.mark.parametrize("where", ["recover", "window"])
def test_queue_lock_held_does_not_block_health_or_hover(tmp_path, ollama, where):
    """다른 프로세스(--enqueue 등)가 큐 잠금을 쥔 동안 워커가 그 잠금을 기다려도 /health·/v1/analogy는 답한다.

    recover: 서버 시작 때 running 복구가 잠금을 기다림. window: 창에서 청크를 고르다 잠금을 기다림.
    """
    s = server_settings(tmp_path, ollama.url)
    enqueue_n(s, COMMON_WS, 1)
    gate = threading.Event()

    async def gated_health() -> bool:
        while not gate.is_set():
            await asyncio.sleep(0.01)
        return True

    worker = make_worker(s, ollama.url, Inserted(), health_fn=gated_health)
    picking = threading.Event()
    orig_pick = worker._pick

    def signalled_pick(*a):
        picking.set()  # 창이 청크를 고르러 들어옴(곧 큐 잠금을 기다린다)
        return orig_pick(*a)

    worker._pick = signalled_pick
    app = make_app(s, worker)
    replies: dict[str, int] = {}
    ready = threading.Event()
    go = threading.Event()
    release = threading.Event()

    def serve():
        # 이벤트 루프가 막히면 TestClient 시작부터 멈출 수 있어 다른 스레드에서 돌린다
        with TestClient(app) as client:
            ready.set()
            go.wait(10)
            replies["health"] = client.get("/health").status_code
            replies["analogy"] = client.post("/v1/analogy", json={"sentence": SENTENCE}, headers=TOKEN).status_code
            release.wait(10)

    lock = ew.queue_lock(s, COMMON_WS)
    if where == "recover":
        lock.__enter__()
        go.set()
        t = threading.Thread(target=serve, daemon=True)
        t.start()
    else:
        t = threading.Thread(target=serve, daemon=True)
        t.start()
        assert ready.wait(5) and wait_until(lambda: app.state.extract_running)
        lock.__enter__()
        gate.set()  # 이제 창이 청크를 고르러 큐 잠금을 기다린다
        assert picking.wait(5)
        go.set()
    try:
        assert wait_until(lambda: len(replies) == 2, timeout=3), replies
        assert replies == {"health": 200, "analogy": 200}
    finally:
        lock.__exit__(None, None, None)
        gate.set()
    # 잠금이 풀리면 워커가 마저 처리한다
    assert wait_until(lambda: all_done(s))
    release.set()
    t.join(10)
    assert not t.is_alive()


# ── seed --reset 때 큐 보존 ─────────────────────────────


def _queue_with_states(s: Settings) -> list[dict]:
    """pending·done·failed(상한)·failed(재시도 가능) 청크 넷과 결과 파일 하나."""
    enqueue_n(s, COMMON_WS, 4)
    q = ew.load_queue(s, COMMON_WS)
    q[1].update(status="done", attempts=1, via="mac", lastError=None)
    q[2].update(status="failed", attempts=s.extract_max_attempts, lastError="연결 끊김")
    q[3].update(status="failed", attempts=1, lastError="파싱 실패")
    ew.save_queue(s, COMMON_WS, q)
    results = seedmeta.safe_workspace_dir(s) / ew.RESULTS_DIR
    results.mkdir(parents=True, exist_ok=True)
    (results / f"{q[1]['id']}.json").write_text("{}", "utf-8")
    return q


def test_reset_keeps_queue_and_requeues_done(tmp_path):
    s = server_settings(tmp_path)
    asyncio.run(seed(s))
    before = _queue_with_states(s)
    asyncio.run(seed(s, reset=True))
    after = ew.load_queue(s, COMMON_WS)
    assert [c["id"] for c in after] == [c["id"] for c in before]
    assert after[0] == before[0]  # pending 그대로
    assert after[1]["status"] == "pending" and after[1]["attempts"] == 0
    assert after[1]["lastError"] is None and after[1]["via"] is None
    assert after[2] == before[2] and after[3] == before[3]  # failed(상한 포함) 그대로
    assert not (seedmeta.safe_workspace_dir(s) / ew.RESULTS_DIR).exists()
    assert seedmeta.index_status(s) == (True, None)


def test_reset_without_queue_still_works(tmp_path):
    s = server_settings(tmp_path)
    asyncio.run(seed(s, reset=True))
    assert not (seedmeta.safe_workspace_dir(s) / ew.QUEUE_FILE).exists()
    assert seedmeta.index_status(s) == (True, None)


def test_reset_refused_while_worker_runs(tmp_path):
    s = server_settings(tmp_path)
    asyncio.run(seed(s))
    before = _queue_with_states(s)
    stale = seedmeta.safe_workspace_dir(s) / "남은파일.json"
    stale.write_text("{}", "utf-8")
    with ew.worker_lock(s):
        with pytest.raises(seedmeta.SeedRefused) as err:
            asyncio.run(seed(s, reset=True))
    assert str(err.value) == RUNNING_MSG
    # 아무것도 지우지 않았다
    assert stale.is_file()
    assert ew.load_queue(s, COMMON_WS) == before
    assert (seedmeta.safe_workspace_dir(s) / ew.RESULTS_DIR).is_dir()
    assert seedmeta.index_status(s) == (True, None)


def test_reset_refused_when_queue_broken(tmp_path):
    s = server_settings(tmp_path)
    asyncio.run(seed(s))
    qp = ew.queue_path(s, COMMON_WS)
    qp.write_text("{깨짐", "utf-8")
    with pytest.raises(seedmeta.SeedRefused) as err:
        asyncio.run(seed(s, reset=True))
    assert str(qp) in str(err.value)
    assert qp.read_text("utf-8") == "{깨짐"
    assert seedmeta.index_status(s) == (True, None)


def test_seed_cli_reset_refusal_is_one_line(tmp_path, monkeypatch, capsys):
    s = server_settings(tmp_path)
    asyncio.run(seed(s))
    for k, v in {"LIGHTRAG_WORKING_DIR": str(tmp_path / "rag"), "COMMON_GRAPH_PATH": str(COMMON_GRAPH),
                 "EMBEDDING_PROVIDER": "hash", "EMBEDDING_DIM": "64"}.items():
        monkeypatch.setenv(k, v)
    from app.seed import main

    with ew.worker_lock(s):
        with pytest.raises(SystemExit) as ex:
            main(["--reset"])
    assert ex.value.code == 2
    assert RUNNING_MSG in capsys.readouterr().err


# ── 수정 1회차(리뷰): 리셋 안전성·종료 중 스레드 작업 ─────────────


def _raw_queue(s: Settings) -> str:
    return ew.queue_path(s, COMMON_WS).read_text("utf-8")


def test_reset_failure_mid_delete_keeps_queue_file(tmp_path, monkeypatch):
    import app.seed as seed_mod

    s = server_settings(tmp_path)
    asyncio.run(seed(s))
    _queue_with_states(s)
    before = _raw_queue(s)
    calls = []
    orig = seed_mod._remove_entry

    def flaky(path):
        calls.append(path.name)
        if len(calls) == 2:
            raise OSError("디렉터리가 비어 있지 않음(흉내)")
        orig(path)

    monkeypatch.setattr(seed_mod, "_remove_entry", flaky)
    with pytest.raises(OSError):
        asyncio.run(seed(s, reset=True))
    assert len(calls) == 2
    assert ew.QUEUE_FILE not in calls and ew.QUEUE_LOCK_FILE not in calls
    # 원래 큐 파일이 그대로(done도 아직 done)
    assert _raw_queue(s) == before


def test_reset_keeps_lock_file_inode_and_serializes_enqueue(tmp_path, monkeypatch):
    import app.seed as seed_mod

    s = server_settings(tmp_path)
    asyncio.run(seed(s))
    before = _queue_with_states(s)
    lock_file = seedmeta.safe_workspace_dir(s) / ew.QUEUE_LOCK_FILE
    inode = lock_file.stat().st_ino
    orig = seed_mod._remove_entry
    added = threading.Event()
    state: dict = {}

    def enqueue_other():
        ew.enqueue(s, COMMON_WS, "reset-중-추가", "리셋 중에 들어온 문단이에요.")
        added.set()

    def remove_and_race(path):
        if "thread" not in state:
            t = threading.Thread(target=enqueue_other, daemon=True)
            state["thread"] = t
            t.start()
            # 리셋이 큐 잠금을 쥐고 있으니 enqueue는 기다린다
            state["waited"] = not added.wait(0.3)
        orig(path)

    monkeypatch.setattr(seed_mod, "_remove_entry", remove_and_race)
    asyncio.run(seed(s, reset=True))
    state["thread"].join(5)
    assert state["waited"] and added.is_set()
    q = ew.load_queue(s, COMMON_WS)
    # 되살린 큐 뒤에 붙었다(잃은 청크 없음)
    assert [c["id"] for c in q[:4]] == [c["id"] for c in before]
    assert q[1]["status"] == "pending"
    assert len(q) == 5 and q[4]["docId"] == "reset-중-추가"
    assert lock_file.stat().st_ino == inode
    assert seedmeta.index_status(s) == (True, None)


def test_cancel_during_queue_op_waits_for_thread_before_releasing_lock(tmp_path, ollama):
    s = server_settings(tmp_path, ollama.url)
    enqueue_n(s, COMMON_WS, 1)
    worker = make_worker(s, ollama.url, Inserted())
    picking = threading.Event()
    orig_pick = worker._pick

    def signalled_pick(*a):
        picking.set()
        return orig_pick(*a)

    worker._pick = signalled_pick
    held = threading.Event()
    release = threading.Event()

    def holder():
        # 다른 프로세스(--enqueue)가 큐 잠금을 잠깐 쥔 것처럼
        with ew.queue_lock(s, COMMON_WS):
            held.set()
            release.wait(5)

    th = threading.Thread(target=holder, daemon=True)

    async def main() -> str:
        # 복구가 끝난 뒤(on_start) 잠금을 쥔다: 창의 _pick이 그 잠금을 기다리게
        task = asyncio.create_task(ew.run_forever(worker, clock=lambda: IN_WINDOW, max_iterations=1,
                                                  on_start=lambda: (th.start(), held.wait(5))))
        for _ in range(300):
            if picking.is_set() or task.done():
                break
            await asyncio.sleep(0.01)
        assert picking.is_set(), task
        await asyncio.sleep(0.05)  # 스레드가 큐 잠금에서 기다리는 중
        task.cancel()
        asyncio.get_running_loop().call_later(0.3, release.set)
        with pytest.raises(asyncio.CancelledError):
            await task
        # 태스크가 끝난(= worker.lock을 푼) 순간의 큐 파일(잠금 없이 읽음)
        return _raw_queue(s)

    snap = asyncio.run(main())
    th.join(5)
    q = json.loads(snap)["chunks"]
    # 스레드의 쓰기(running 표시)는 잠금을 풀기 전에 끝났고, 그 뒤에는 쓰지 않았다
    assert [(c["status"], c["attempts"]) for c in q] == [("running", 1)]
    time.sleep(0.2)
    assert _raw_queue(s) == snap
    with ew.worker_lock(s):  # 잠금은 풀렸다
        pass
    # 다음 시작의 복구가 되돌린다
    assert ew.recover_running(s, [COMMON_WS]) == 1


def test_reset_removes_seed_meta_first_so_partial_failure_is_not_ready(tmp_path, monkeypatch):
    import app.seed as seed_mod

    s = server_settings(tmp_path)
    asyncio.run(seed(s))
    _queue_with_states(s)
    before = _raw_queue(s)
    calls: list[str] = []
    orig = seed_mod._remove_entry

    def fail_after_first(path):
        calls.append(path.name)
        if len(calls) == 2:
            raise OSError("지우기 실패(흉내)")
        orig(path)

    monkeypatch.setattr(seed_mod, "_remove_entry", fail_after_first)
    with pytest.raises(OSError):
        asyncio.run(seed(s, reset=True))
    # 첫 번째로 지운 것은 seed-meta.json: 중간에 멈춰도 인덱스는 '준비 안 됨'
    assert calls[0] == seedmeta.SEED_META_FILE
    assert not (seedmeta.safe_workspace_dir(s) / seedmeta.SEED_META_FILE).exists()
    assert seedmeta.index_status(s)[0] is False
    assert _raw_queue(s) == before
