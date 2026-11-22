"""20청크 추출 A/B 하네스(T-413, L1 관문).

청크 20개 × 모델(gemma4:12b, qwen3.5:9b) × thinking(켬, 끔)을 맥 Ollama로 돌려 잰다.
- 파싱 실패율: 운영 파서(parse_extraction)가 실패하거나 요청이 실패(타임아웃 등)한 청크 비율
- 청크당 엔티티·관계 수: 운영 후처리(filter_extraction) 뒤
- 추상구조 연결률: 게임 개념 엔티티(추상구조가 아닌 ENTITY_TYPES 유형) 중 통제 어휘 태그와 관계로 이어진 비율(규칙 9)
- 청크당 시간(초), 최대 메모리(Ollama /api/ps size와 ollama 프로세스 RSS 합)
- T-412에서 넘어온 확인 거리: Other·목록 밖 유형 비율, 예시 엔티티 베끼기, 시드 이름 사용, 프롬프트 토큰

요청 본문·system 프롬프트·파서·후처리는 운영 워커(app.extract_worker)와 같은 함수를 쓴다(운영 동작 그대로).
Ollama 설정·launchd는 건드리지 않는다. 모델을 바꿀 때만 keep_alive 0으로 내린다(16GB 맥, 한 번에 모델 하나).

실행(server/에서):
    .venv/bin/python -m tools.ab_extract --build-fixture        # 공식 페이지에서 청크 20개 고정본 만들기(네트워크)
    .venv/bin/python -m tools.ab_extract                        # A/B 실행 → ../.tmp/ab-extract/
    .venv/bin/python -m tools.ab_extract --report-only          # 저장한 결과로 표만 다시
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import threading
import time
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable, Mapping

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from app.extract import ENTITY_TYPES, _examples, _norm_name, _norm_type, build_extraction_config, filter_extraction  # noqa: E402
from app.seed import TAG_ENTITY_TYPE  # noqa: E402

FIXTURE = SERVER_DIR / "tests" / "fixtures" / "ab_extract_chunks.json"
OUT_DIR = SERVER_DIR.parent / ".tmp" / "ab-extract"
OLLAMA = "http://127.0.0.1:11434"
MODELS = ("gemma4:12b", "qwen3.5:9b")
THINKS = (False, True)
MAX_PARSE_FAIL = 0.05
MIN_LINK_RATE = 0.70

# ── 청크 고정본(D-5: 공식 출처만) ─────────────────────────
# 가이드 문서 14개는 첫 청크, 패치 노트 6개는 공통 그래프 라벨·별칭이 가장 여러 종류 나오는 청크(같으면 앞 청크).
# 청크는 운영 청크 나누기(chunk_text, 1200자)로 만든다. 전문은 저장하지 않고 고른 청크만 남긴다.
GUIDE_IDS = (377, 387, 394, 396, 397, 405, 407, 412, 413, 414, 418, 456, 458, 463)
PATCH_IDS = (746, 766, 773, 799, 805, 806)
GUIDE_URL = "https://maplestory.nexon.com/Guide/N23GameInformation/Articles/{}"
PATCH_URL = "https://maplestory.nexon.com/News/Update/{}"
GUIDE_CLASS = "guide_content"
PATCH_CLASS = "se-contents"  # 본문만(아래 댓글 reply_text는 빼야 한다)

_BLOCK_TAGS = {"p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "td", "th", "table", "ul", "ol"}
_VOID_TAGS = {"br", "img", "hr", "input", "meta", "link", "source", "wbr"}


class _ClassText(HTMLParser):
    """class에 target이 들어 있는 첫 요소 안의 글만 모은다(script·style 제외)."""

    def __init__(self, target: str) -> None:
        super().__init__(convert_charrefs=True)
        self.target, self.depth, self.skip, self.done, self.out = target, 0, 0, False, []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if self.done:
            return
        if self.depth:
            if tag in ("script", "style"):
                self.skip += 1
            if tag not in _VOID_TAGS:
                self.depth += 1
            if tag in _BLOCK_TAGS:
                self.out.append("\n")
        elif self.target in (dict(attrs).get("class") or "").split():
            self.depth = 1

    def handle_endtag(self, tag: str) -> None:
        if self.depth and tag not in _VOID_TAGS:
            self.depth -= 1
            if tag in ("script", "style"):
                self.skip -= 1
            if tag in _BLOCK_TAGS:
                self.out.append("\n")
            if self.depth == 0:
                self.done = True

    def handle_data(self, data: str) -> None:
        if self.depth and not self.skip:
            self.out.append(data)


def html_to_text(html: str, css_class: str) -> str:
    """페이지에서 css_class 요소의 본문 글만. 공백을 줄이고 빈 줄은 문단 경계 하나로."""
    p = _ClassText(css_class)
    p.feed(html)
    text = "".join(p.out)
    text = re.sub(r"[ \t\xa0​]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{2,}", "\n\n", text).strip()


def graph_terms(graph: Mapping[str, Any]) -> list[str]:
    """공통 그래프 노드 라벨·별칭(청크 고르기용)."""
    out: list[str] = []
    for n in graph.get("nodes", []):
        out += [n.get("label") or ""] + list(n.get("aliases") or [])
    return [t for t in out if t]


def pick_chunk(chunks: list[str], terms: Iterable[str]) -> int:
    """서로 다른 용어가 가장 많이 나오는 청크 번호(같으면 앞). 용어는 공백을 빼고 찾는다.

    같은 용어가 되풀이되는 보상표 청크보다 여러 시스템을 설명하는 청크를 고르려고 종류 수로 센다."""
    keys = [t.replace(" ", "") for t in terms if t.strip()]
    best, best_n = 0, -1
    for i, c in enumerate(chunks):
        flat = c.replace(" ", "")
        n = sum(1 for k in set(keys) if k in flat)
        if n > best_n:
            best, best_n = i, n
    return best


def build_fixture(path: Path = FIXTURE) -> dict:
    import httpx

    from app.config import Settings
    from app.extract_worker import chunk_text

    graph = Settings.from_env().common_graph()
    terms = graph_terms(graph)
    chunks = []
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        for kind, ids, url_t, cls in (("guide", GUIDE_IDS, GUIDE_URL, GUIDE_CLASS),
                                      ("patch", PATCH_IDS, PATCH_URL, PATCH_CLASS)):
            for i in ids:
                url = url_t.format(i)
                res = client.get(url)
                res.raise_for_status()
                parts = chunk_text(html_to_text(res.text, cls))
                if not parts:
                    raise RuntimeError(f"본문을 못 찾았어요: {url}")
                idx = 0 if kind == "guide" else pick_chunk(parts, terms)
                chunks.append({"id": f"{kind}-{i}-{idx}", "kind": kind, "url": url, "chunkIndex": idx,
                               "text": parts[idx]})
    data = {
        "note": "T-413 A/B용 공식 출처 발췌(D-5). 가이드는 첫 청크, 패치 노트는 공통 그래프 라벨·별칭이 가장 여러 종류 나오는 청크. "
                "청크는 운영 chunk_text(1200자). 전문은 저장하지 않는다.",
        "fetchedAt": date.today().isoformat(),
        "chunks": chunks,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return data


# ── 지표(순수 함수) ───────────────────────────────────


def example_entity_names() -> set[str]:
    """추출 프롬프트 예시에 나오는 게임 개념 엔티티 이름(추상구조 제외, 정규화)."""
    names: set[str] = set()
    for ex in _examples():
        body = json.loads(ex.split("출력:\n", 1)[1])
        for e in body["entities"]:
            if _norm_type(e["type"]) != _norm_type(TAG_ENTITY_TYPE):
                names.add(_norm_name(e["name"]))
    return names


def _flat(s: Any) -> str:
    return re.sub(r"\s+", "", str(s or ""))


def chunk_metrics(text: str, entities: list[Mapping[str, Any]], relationships: list[Mapping[str, Any]],
                  vocabulary: Iterable[str], seed_labels: Iterable[str] = (),
                  example_names: Iterable[str] = ()) -> dict[str, Any]:
    """청크 하나의 추출 결과(파싱 직후 원본) → 지표. 운영과 같이 filter_extraction 뒤 수를 센다."""
    vocab = {_norm_name(v) for v in vocabulary}
    allowed_types = {_norm_type(t) for t in ENTITY_TYPES}
    abstract = _norm_type(TAG_ENTITY_TYPE)
    seeds = {_norm_name(s) for s in seed_labels}
    examples = {_norm_name(x) for x in example_names}
    flat_text = _flat(text)

    raw_types = [_norm_type(e.get("type", e.get("entity_type"))) for e in entities]
    kept_e, kept_r = filter_extraction(entities, relationships, vocabulary)

    game: dict[str, str] = {}  # 정규화 이름 → 원래 이름(게임 개념만, 청크 안 중복 하나로)
    tags: set[str] = set()
    for e in kept_e:
        name = _norm_name(e.get("name", e.get("entity_name")))
        t = _norm_type(e.get("type", e.get("entity_type")))
        if not name:
            continue
        if t == abstract:
            tags.add(name)
        elif t in allowed_types:
            game.setdefault(name, str(e.get("name", e.get("entity_name"))))
    linked: set[str] = set()
    for r in kept_r:
        a = _norm_name(r.get("source", r.get("src_id")))
        b = _norm_name(r.get("target", r.get("tgt_id")))
        # 관계 끝이 통제 어휘 라벨이면 엔티티로 선언하지 않았어도 연결로 본다(LightRAG는 끝 이름으로 엔티티를 만든다)
        if a in game and (b in tags or b in vocab):
            linked.add(a)
        if b in game and (a in tags or a in vocab):
            linked.add(b)

    copied = sorted(n for n in game if n in examples and _flat(n) not in flat_text)
    ungrounded = sorted(n for n in game if _flat(n) not in flat_text)
    return {
        "entities": len(kept_e),
        "relationships": len(kept_r),
        "rawEntities": len(entities),
        "rawRelationships": len(relationships),
        "typeOther": sum(t == "other" for t in raw_types),
        "typeOutside": sum(t not in allowed_types for t in raw_types),  # Other 포함
        "dropped": len(entities) - len(kept_e),  # 목록 밖 추상구조 + 목록 밖 유형
        "gameEntities": len(game),
        "linkedGame": len(linked),
        "tags": len(tags),
        "copiedExamples": copied,
        "ungroundedGame": len(ungrounded),
        "seedNameHits": sorted(n for n in game if n in seeds),
    }


def summarize(rows: list[Mapping[str, Any]]) -> dict[str, Any]:
    """한 조합(모델 × thinking)의 청크별 결과 → 요약. 파싱 실패 청크는 엔티티·연결 집계에서 뺀다."""
    n = len(rows)
    ok = [r for r in rows if r.get("metrics")]
    fails = n - len(ok)
    m = [r["metrics"] for r in ok]

    def total(k: str) -> int:
        return sum(x[k] for x in m)

    def per(k: str) -> float:
        return total(k) / len(m) if m else 0.0

    game, linked = total("gameEntities"), total("linkedGame")
    secs = [r["seconds"] for r in rows if r.get("seconds") is not None]
    return {
        "chunks": n,
        "parseFail": fails,
        "parseFailRate": fails / n if n else 0.0,
        "entitiesPerChunk": per("entities"),
        "relationshipsPerChunk": per("relationships"),
        "linkRate": linked / game if game else 0.0,
        "gameEntities": game,
        "linkedGame": linked,
        "chunksWithLink": sum(1 for x in m if x["linkedGame"] > 0),
        "typeOtherRate": total("typeOther") / total("rawEntities") if m and total("rawEntities") else 0.0,
        "typeOutsideRate": total("typeOutside") / total("rawEntities") if m and total("rawEntities") else 0.0,
        "dropped": total("dropped"),
        "copiedExamples": sum(len(x["copiedExamples"]) for x in m),
        "ungroundedGameRate": total("ungroundedGame") / game if game else 0.0,
        "secondsPerChunk": sum(secs) / len(secs) if secs else 0.0,
        "secondsMax": max(secs) if secs else 0.0,
        "promptTokens": max((r.get("promptTokens") or 0) for r in rows) if rows else 0,
        "outputTokensPerChunk": (sum(r.get("outputTokens") or 0 for r in ok) / len(ok)) if ok else 0.0,
    }


def passes(s: Mapping[str, Any], max_fail: float = MAX_PARSE_FAIL, min_link: float = MIN_LINK_RATE) -> bool:
    return s["parseFailRate"] <= max_fail and s["linkRate"] >= min_link


def choose_default(summaries: Mapping[str, Mapping[str, Any]]) -> str | None:
    """관문을 넘는 조합 중 연결률 높은 순, 같으면 빠른 순. 없으면 None(지금 기본값 유지)."""
    ok = [(k, s) for k, s in summaries.items() if passes(s)]
    if not ok:
        return None
    return sorted(ok, key=lambda kv: (-kv[1]["linkRate"], kv[1]["secondsPerChunk"]))[0][0]


def pending_chunks(chunks: list[Mapping[str, Any]], rows: Iterable[Mapping[str, Any]], key: str) -> list[Mapping[str, Any]]:
    """이어 돌리기: 이 조합(key)으로 이미 결과 줄이 있는 청크는 빼고 남은 청크만(고정본 순서)."""
    done = {r["chunk"] for r in rows if r.get("combo") == key}
    return [c for c in chunks if c["id"] not in done]


def hopeless(fails: int, limit: int, max_fail: float = MAX_PARSE_FAIL) -> bool:
    """실패가 허용 수(limit × max_fail, 내림)를 넘어 남은 청크가 모두 성공해도 관문을 못 넘는지."""
    return fails > int(limit * max_fail + 1e-9)


def combo_key(model: str, think: bool) -> str:
    return f"{model} think={'on' if think else 'off'}"


def format_table(summaries: Mapping[str, Mapping[str, Any]], memory: Mapping[str, Mapping[str, Any]] | None = None) -> str:
    memory = memory or {}
    head = ("| 조합 | 파싱 실패 | 엔티티/청크 | 관계/청크 | 추상구조 연결률 | 연결 청크 | 초/청크(최대) | 최대 메모리 | "
            "Other·목록 밖 유형 | 예시 베낌 | 관문 |")
    lines = [head, "| " + " | ".join(["---"] * 11) + " |"]
    for k, s in summaries.items():
        mem = memory.get(k) or {}
        gb = lambda b: f"{b / 1e9:.1f}GB" if b else "—"  # noqa: E731
        lines.append(
            f"| {k} | {s['parseFail']}/{s['chunks']} ({s['parseFailRate']:.0%}) | {s['entitiesPerChunk']:.1f} | "
            f"{s['relationshipsPerChunk']:.1f} | {s['linkedGame']}/{s['gameEntities']} ({s['linkRate']:.0%}) | "
            f"{s['chunksWithLink']}/{s['chunks'] - s['parseFail']} | {s['secondsPerChunk']:.1f} ({s['secondsMax']:.0f}) | "
            f"ps {gb(mem.get('psSize'))} · RSS {gb(mem.get('rss'))} | "
            f"{s['typeOtherRate']:.0%} · {s['typeOutsideRate']:.0%} | {s['copiedExamples']} | "
            f"{'통과' if passes(s) else '미달'} |")
    return "\n".join(lines)


# ── 실행(네트워크: 맥 Ollama만) ─────────────────────────


class MemorySampler:
    """1초마다 /api/ps size 합과 ollama 프로세스 RSS 합의 최댓값을 잰다."""

    def __init__(self, base: str = OLLAMA, interval: float = 1.0) -> None:
        self.base, self.interval = base, interval
        self.ps_max = self.rss_max = 0
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _sample(self) -> None:
        import httpx

        try:
            models = httpx.get(self.base + "/api/ps", timeout=2).json().get("models") or []
            self.ps_max = max(self.ps_max, sum(int(m.get("size") or 0) for m in models))
        except Exception:  # 재기만 하니 실패는 넘긴다
            pass
        try:
            out = subprocess.run(["ps", "-axo", "rss=,comm="], capture_output=True, text=True, timeout=2).stdout
            rss = sum(int(l.split(None, 1)[0]) * 1024 for l in out.splitlines()
                      if "ollama" in l.lower() and l.split(None, 1)[0].isdigit())
            self.rss_max = max(self.rss_max, rss)
        except Exception:
            pass

    def _run(self) -> None:
        while not self._stop.is_set():
            self._sample()
            self._stop.wait(self.interval)

    def __enter__(self) -> "MemorySampler":
        self._t.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        self._t.join(timeout=5)
        self._sample()


def unload(model: str, base: str = OLLAMA) -> None:
    import httpx

    httpx.post(base + "/api/generate", json={"model": model, "keep_alive": 0}, timeout=60)


def run_one(chat: Any, text: str) -> dict[str, Any]:
    """청크 하나: 운영 함수(make_ollama_chat → parse_extraction)로 부르고 읽는다. 원본 응답과 시간·토큰을 남긴다."""
    import asyncio

    from app.extract_worker import ExtractParseError, parse_extraction

    t0 = time.monotonic()
    try:
        data = asyncio.run(chat(text))
    except Exception as e:  # 타임아웃·HTTP 오류·응답 모양 오류도 그 청크 실패로 센다
        return {"seconds": time.monotonic() - t0, "error": f"{type(e).__name__}: {e}"[:300]}
    secs = time.monotonic() - t0
    msg = data.get("message") or {}
    out = {"seconds": secs, "promptTokens": data.get("prompt_eval_count"), "outputTokens": data.get("eval_count"),
           "loadSeconds": (data.get("load_duration") or 0) / 1e9, "thinkingChars": len(msg.get("thinking") or ""),
           "content": msg.get("content") or ""}
    try:
        out["entitiesRaw"], out["relationshipsRaw"] = parse_extraction(out["content"])
    except ExtractParseError as e:
        out["error"] = f"parse: {e}"
    return out


def _load_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def run_ab(models: Iterable[str], thinks: Iterable[bool], limit: int, out_dir: Path, base: str = OLLAMA,
           early_stop: bool = True) -> None:
    """조합마다 청크를 차례로. early_stop이면 파싱 실패가 허용 수를 넘는 순간 그 조합을 멈춘다(관문 탈락 확정).
    느린 맥에서 청크마다 600초 타임아웃을 다 기다리지 않으려고 둔다(T-413)."""
    from app.config import Settings

    graph = Settings.from_env().common_graph()
    from app.extract_worker import extraction_system_prompt, make_ollama_chat

    system = extraction_system_prompt(graph)
    chunks = json.loads(FIXTURE.read_text(encoding="utf-8"))["chunks"][:limit]
    out_dir.mkdir(parents=True, exist_ok=True)
    rows_path, mem_path = out_dir / "rows.jsonl", out_dir / "memory.json"
    memory = json.loads(mem_path.read_text()) if mem_path.exists() else {}
    models = list(models)
    for model in models:
        for other in models:
            if other != model:
                unload(other, base)
        for think in thinks:
            key = combo_key(model, think)
            todo = pending_chunks(chunks, _load_rows(rows_path), key)
            fails = sum(1 for r in _load_rows(rows_path) if r["combo"] == key and r.get("error"))
            if not todo or (early_stop and hopeless(fails, limit)):
                continue
            chat = make_ollama_chat(base, model, system, think)
            with MemorySampler(base) as mem:
                # 모델 올리기는 청크 시간에서 뺀다(짧은 글로 한 번 데움)
                warm = run_one(chat, "메소는 메이플스토리의 게임 화폐이다.")
                print(f"[{key}] 데움 {warm['seconds']:.1f}초(적재 {warm.get('loadSeconds', 0):.1f}초)", flush=True)
                for c in todo:
                    r = run_one(chat, c["text"])
                    row = {"combo": key, "model": model, "think": think, "chunk": c["id"], **r}
                    with rows_path.open("a", encoding="utf-8") as f:
                        f.write(json.dumps(row, ensure_ascii=False) + "\n")
                    print(f"[{key}] {c['id']}: {r['seconds']:.1f}초 "
                          f"{'실패 ' + r['error'] if r.get('error') else 'ok'}", flush=True)
                    fails += bool(r.get("error"))
                    if early_stop and hopeless(fails, limit):
                        print(f"[{key}] 파싱 실패 {fails}개로 관문 탈락이 확정돼 이 조합을 멈춰요.", flush=True)
                        break
            prev = memory.get(key) or {}
            memory[key] = {"psSize": max(mem.ps_max, prev.get("psSize", 0)), "rss": max(mem.rss_max, prev.get("rss", 0))}
            mem_path.write_text(json.dumps(memory, indent=2))
        unload(model, base)


def report(out_dir: Path, limit: int | None = None) -> tuple[str, dict, str | None]:
    from app.config import Settings

    graph = Settings.from_env().common_graph()
    vocab = build_extraction_config(graph)["vocabulary"]
    seeds = [n["label"] for n in graph.get("nodes", [])]
    examples = example_entity_names()
    chunks = {c["id"]: c for c in json.loads(FIXTURE.read_text(encoding="utf-8"))["chunks"][:limit]}
    by_combo: dict[str, list[dict]] = {}
    for r in _load_rows(out_dir / "rows.jsonl"):
        if r["chunk"] not in chunks:
            continue
        if not r.get("error"):
            r["metrics"] = chunk_metrics(chunks[r["chunk"]]["text"], r["entitiesRaw"], r["relationshipsRaw"],
                                         vocab, seeds, examples)
        by_combo.setdefault(r["combo"], []).append(r)
    order = [combo_key(m, t) for m in MODELS for t in THINKS]
    summaries = {k: summarize(by_combo[k]) for k in order + sorted(set(by_combo) - set(order)) if k in by_combo}
    mem_path = out_dir / "memory.json"
    memory = json.loads(mem_path.read_text()) if mem_path.exists() else {}
    (out_dir / "summary.json").write_text(json.dumps(summaries, ensure_ascii=False, indent=2))
    return format_table(summaries, memory), summaries, choose_default(summaries)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m tools.ab_extract", description="20청크 추출 A/B(T-413)")
    ap.add_argument("--build-fixture", action="store_true", help="공식 페이지에서 청크 고정본을 다시 만든다(네트워크)")
    ap.add_argument("--report-only", action="store_true", help="저장한 결과로 표만")
    ap.add_argument("--models", default=",".join(MODELS))
    ap.add_argument("--think", default="off,on", help="off,on 중에서")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--full", action="store_true", help="관문 탈락이 확정돼도 끝까지 돌린다(조기 중단 끔)")
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--ollama", default=OLLAMA, help="맥 로컬 Ollama 주소(127.0.0.1만, 규칙 10)")
    args = ap.parse_args(argv)
    out_dir = Path(args.out)
    if args.build_fixture:
        data = build_fixture()
        print(f"청크 {len(data['chunks'])}개를 {FIXTURE}에 저장했어요.")
        return 0
    if not args.report_only:
        thinks = [{"off": False, "on": True}[t.strip()] for t in args.think.split(",") if t.strip()]
        run_ab([m.strip() for m in args.models.split(",") if m.strip()], thinks, args.limit, out_dir, args.ollama,
               early_stop=not args.full)
    table, _, best = report(out_dir, args.limit)
    print(table)
    print(f"기본값 후보: {best or '없음(관문을 넘은 조합 없음, 지금 기본값 유지)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
