"""시드 인덱스의 판본 기록(seed-meta.json)과 상태 판정(T-140).

시드가 끝나면 워크스페이스 폴더에 무엇으로 만든 인덱스인지 남긴다:
  {"graphVersion": "<그래프 판본+태그 판본>", "embedding": {"provider", "model", "dim"}, "seededAt": ISO}
서버는 인덱스를 열기 전에(그리고 /health마다) 이 파일을 지금 설정과 비교한다. 없거나 다르면 열지 않고
무엇을 해야 하는지(다시 시드 명령) 한국어 안내와 함께 503으로 막는다.

LightRAG를 불러오지 않는 가벼운 모듈이다(/health가 자주 불린다). 파일만 본다.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SEED_META_FILE = "seed-meta.json"
# 해시 임베딩의 모델 이름(차원만으로는 해시 방식이 바뀐 것을 못 가려서 이름을 둔다)
HASH_MODEL_NAME = "hash-ngram-v1"
# 시드 주입이 워크스페이스 폴더에 남기는 파일. 그래프와 개체 벡터가 둘 다 있어야 검색할 수 있다.
# open_rag는 빈 워크스페이스 폴더를 만들기만 하므로(파일 없음) 폴더 존재로는 판단하지 않는다.
INDEX_FILES = ("graph_chunk_entity_relation.graphml", "vdb_entities.json")

SEED_CMD = "python -m app.seed"
RESEED_CMD = "python -m app.seed --reset"
# 도커에서는 같은 이미지·볼륨으로 시드한다(README "도커")
DOCKER_HINT = "도커: docker compose run --rm analogy-api {cmd}"


# 워크스페이스 이름은 작업 디렉터리 바로 아래 폴더 하나다. 경로 구분자·점·공백을 받지 않는다(--reset이 지우는 곳)
WORKSPACE_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class WorkspaceError(ValueError):
    """WORKSPACE·작업 디렉터리 설정이 안전하지 않을 때(설정 오류)."""


class SeedRefused(RuntimeError):
    """시드를 하면 안 되는 상태(옛·다른 인덱스 위에 --reset 없이, 판본을 모름)."""


def validate_workspace(name: Any) -> str:
    if not isinstance(name, str) or not WORKSPACE_RE.fullmatch(name):
        raise WorkspaceError(f"WORKSPACE는 영문·숫자·_·-만 쓸 수 있어요: {name!r}")
    return name


def safe_workspace_dir(settings: Any) -> Path:
    """작업 디렉터리 바로 아래의 워크스페이스 폴더(절대 경로). 벗어나거나 심볼릭 링크면 WorkspaceError.

    --reset이 이 경로를 통째로 지우므로, 어떤 설정으로도 작업 디렉터리 밖·작업 디렉터리 자체를 가리키지 않게 한다.
    """
    name = validate_workspace(settings.workspace)
    base = Path(settings.lightrag_working_dir).resolve()
    target = base / name
    if target.is_symlink():
        raise WorkspaceError(f"워크스페이스 폴더가 심볼릭 링크라 쓰지 않아요: {name}")
    resolved = target.resolve()
    if resolved.parent != base or resolved == base:
        raise WorkspaceError(f"워크스페이스 폴더가 작업 디렉터리 바로 아래가 아니에요: {name}")
    return resolved


def workspace_dir(settings: Any) -> Path:
    return safe_workspace_dir(settings)


def meta_path(settings: Any) -> Path:
    return workspace_dir(settings) / SEED_META_FILE


def index_exists(settings: Any) -> bool:
    """시드된 인덱스 파일이 작업 디렉터리에 있는지. 파일만 본다(LightRAG를 열지 않는다)."""
    d = workspace_dir(settings)
    return all((d / name).is_file() for name in INDEX_FILES)


def embedding_identity(settings: Any) -> dict[str, Any]:
    """지금 설정의 임베딩 공급자·모델·차원. 셋 중 하나라도 다르면 벡터를 섞을 수 없다."""
    provider = settings.embedding_provider
    model = HASH_MODEL_NAME if provider == "hash" else settings.embedding_model
    return {"provider": provider, "model": model, "dim": int(settings.embedding_dim)}


def expected_seed_meta(settings: Any) -> dict[str, Any]:
    """지금 설정이라면 시드가 남겼어야 할 값(seededAt 제외)."""
    return {"graphVersion": settings.workspace_version, "embedding": embedding_identity(settings)}


def write_seed_meta(settings: Any, now: datetime | None = None) -> dict[str, Any]:
    """seed-meta.json을 원자적으로 쓴다: 같은 폴더의 임시 파일에 쓰고 os.replace. 실패하면 옛 파일이 그대로 남는다."""
    meta = {**expected_seed_meta(settings),
            "seededAt": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")}
    d = workspace_dir(settings)
    d.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".seed-meta.", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, meta_path(settings))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return meta


def remove_seed_meta(settings: Any) -> None:
    """시드를 시작할 때 옛 메타를 지운다. 주입이 중간에 실패하면 메타가 없어 '다시 시드' 상태가 된다."""
    try:
        meta_path(settings).unlink()
    except FileNotFoundError:
        pass


def read_seed_meta(settings: Any) -> dict[str, Any] | None:
    """seed-meta.json. 없거나 깨졌으면 None."""
    try:
        data = json.loads(meta_path(settings).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _emb_text(e: Any) -> str:
    if not isinstance(e, dict):
        return "알 수 없음"
    return f"{e.get('provider')}/{e.get('model')}/{e.get('dim')}차원"


def index_status(settings: Any) -> tuple[bool, str | None]:
    """(준비됨, 이유). 준비되지 않았으면 이유는 무엇을 해야 하는지까지 담은 운영자용 한국어 한 줄.

    /health에 그대로 나가므로 절대 경로는 넣지 않는다(경로는 부르는 쪽이 로그에 남긴다).
    """
    if settings.workspace_version is None:
        return False, "공통 그래프 판본(version)을 알 수 없어요. 그래프·태그 파일의 version을 확인해 주세요."
    try:
        exists = index_exists(settings)
    except WorkspaceError as e:
        return False, f"{e} WORKSPACE·LIGHTRAG_WORKING_DIR 설정을 확인해 주세요."
    if not exists:
        return False, f"검색 인덱스가 없어요. 시드해 주세요: {SEED_CMD} ({DOCKER_HINT.format(cmd=SEED_CMD)})"
    reseed = f"다시 시드해 주세요: {RESEED_CMD} ({DOCKER_HINT.format(cmd=RESEED_CMD)}), 그다음 서버를 재시작해요."
    if not meta_path(settings).is_file():
        return False, f"시드 기록({SEED_META_FILE})이 없는 옛 인덱스예요. {reseed}"
    meta = read_seed_meta(settings)
    if meta is None:
        return False, f"시드 기록({SEED_META_FILE})을 읽지 못했어요. {reseed}"
    want = expected_seed_meta(settings)
    if meta.get("graphVersion") != want["graphVersion"]:
        return False, (f"인덱스의 그래프 판본({meta.get('graphVersion')})이 지금 그래프 판본"
                       f"({want['graphVersion']})과 달라요. {reseed}")
    if meta.get("embedding") != want["embedding"]:
        return False, (f"인덱스의 임베딩({_emb_text(meta.get('embedding'))})이 지금 설정"
                       f"({_emb_text(want['embedding'])})과 달라요. EMBEDDING_*를 시드 때와 같게 맞추거나 {reseed}")
    return True, None


def check_can_seed(settings: Any, reset: bool) -> None:
    """시드 전에 확인한다. --reset 없이 옛(메타 없음)·다른 설정의 인덱스 위에 덮어써 '준비됨'을 찍지 않게."""
    if settings.workspace_version is None:
        raise SeedRefused("공통 그래프 판본(version)을 알 수 없어 시드하지 않아요. 그래프·태그 파일의 version을 확인해 주세요.")
    safe_workspace_dir(settings)  # 경로가 안전하지 않으면 여기서 멈춘다
    if reset or not index_exists(settings):
        return
    meta = read_seed_meta(settings)
    if meta is None:
        raise SeedRefused(f"시드 기록이 없는 옛 인덱스가 있어요. 지우고 새로 넣으려면 {RESEED_CMD}")
    if {k: meta.get(k) for k in ("graphVersion", "embedding")} != expected_seed_meta(settings):
        raise SeedRefused("이미 있는 인덱스가 지금 설정(그래프 판본·임베딩)과 달라요. "
                          f"지우고 새로 넣으려면 {RESEED_CMD}")
