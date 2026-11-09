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
from test_extract_worker import COMMON_GRAPH, COMMON_WS, Inserted, enqueue_n, make_worker, ollama  # noqa: F401

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


def test_queue_lock_held_does_not_block_health_or_hover(tmp_path, ollama):
    s = server_settings(tmp_path, ollama.url)
    enqueue_n(s, COMMON_WS, 1)
    app = make_app(s, make_worker(s, ollama.url, Inserted()))
    with TestClient(app) as client:
        replies: dict[str, int] = {}

        def hit():
            replies["health"] = client.get("/health").status_code
            replies["analogy"] = client.post("/v1/analogy", json={"sentence": SENTENCE}, headers=TOKEN).status_code

        with ew.queue_lock(s, COMMON_WS):
            # 워커는 지금 큐 잠금을 기다린다(이벤트 루프 밖 스레드에서)
            time.sleep(0.2)
            t = threading.Thread(target=hit, daemon=True)
            t.start()
            t.join(3)
            answered = dict(replies)
        t.join(5)
        assert answered == {"health": 200, "analogy": 200}, answered
        # 잠금이 풀리면 워커가 마저 처리한다
        assert wait_until(lambda: all_done(s))


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
