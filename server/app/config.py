"""서버 설정. 모든 값은 환경변수에서 읽는다(API 키는 코드에 두지 않는다)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

# 저장소 루트 = server/app/config.py 에서 두 단계 위. 실행 위치(cwd)와 무관하게 찾는다.
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COMMON_GRAPH_PATH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"
# 금칙어 목록(T-114, 규칙 11). 공통 그래프 옆, 확장과 같은 파일.
# 실제 기본값은 설정된 공통 그래프 파일의 옆이다(도커 이미지 안에서는 REPO_ROOT가 / 라서)
BLOCKLIST_FILENAME = "blocklist.json"
DEFAULT_BLOCKLIST_PATH = DEFAULT_COMMON_GRAPH_PATH.parent / BLOCKLIST_FILENAME
# 추상 태그(통제 어휘, 규칙 9)의 원본(T-304). 기본값은 금칙어와 같은 규칙으로 공통 그래프 파일의 옆
TAGS_FILENAME = "tags.json"
DEFAULT_WORKSPACE = "common_maplestory"
DEFAULT_RATE_LIMIT_PER_MIN = 30
# 확장 config/admin.json의 defaultModels.gemini와 같게 둔다
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
# LightRAG 인덱스 폴더(커밋·도커 이미지에 넣지 않는다). 워크스페이스별 하위 폴더가 생긴다
DEFAULT_LIGHTRAG_WORKING_DIR = REPO_ROOT / "server" / "rag_storage"
# 시드 주입 임베딩: hash(네트워크 없음, 테스트·개발용) | ollama(맥의 Ollama /api/embed, 규칙 8·10)
DEFAULT_EMBEDDING_PROVIDER = "hash"
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_EMBEDDING_MODEL = "bge-m3"
DEFAULT_EMBEDDING_DIM = 1024
# CORS(T-141): 확장 출처 형식(chrome-extension:// + a~p 32자). ALLOW_EXTENSION_ORIGINS=true 일 때만 쓴다
EXTENSION_ORIGIN_REGEX = r"^chrome-extension://[a-p]{32}$"
# 추출 큐 워커(T-414). 맥 Ollama 주소가 비면 워커는 꺼져 있다(규칙 8·10: 테일넷 주소만 적는다)
DEFAULT_EXTRACT_MODEL = "gemma4:12b"
DEFAULT_EXTRACT_INTERVAL_S = 300
DEFAULT_EXTRACT_MAX_ATTEMPTS = 5
DEFAULT_EXTRACT_CLOUD_DAILY_CAP = 50
# 클라우드 추출(Gemini) 요청 타임아웃(초, T-162). 호버 GeminiLLM 기본값(30초)과 따로
DEFAULT_EXTRACT_CLOUD_TIMEOUT_S = 120.0
EXTRACT_FALLBACKS = ("none", "cloud")


def _parse_origins(raw: str | None) -> tuple[str, ...]:
    """쉼표 구분 출처 목록. 빈 칸·공백은 버린다."""
    return tuple(o.strip() for o in (raw or "").split(",") if o.strip())


def _parse_bool(raw: str | None) -> bool:
    return (raw or "").strip().lower() in ("1", "true", "yes")


def read_graph_version(path: str | os.PathLike) -> str | None:
    """공통 그래프(또는 태그 파일) JSON의 version 값. 파일이 없거나 깨졌으면 None."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    version = data.get("version") if isinstance(data, dict) else None
    return str(version) if version is not None else None


def _check_tags(tags: object) -> None:
    """태그 목록 검증(확장 graph.js validateGraph의 태그 규칙과 같다)."""
    if not isinstance(tags, list):
        raise ValueError("태그 파일에 tags(배열)가 없어요.")
    seen: set[str] = set()
    for i, t in enumerate(tags):
        if not isinstance(t, dict) or not t.get("id") or not t.get("label"):
            raise ValueError(f"tags[{i}]에 id 또는 label이 없어요.")
        if t["id"] in seen:
            raise ValueError(f"태그 id 중복: {t['id']}")
        ex = t.get("examples")
        if ex is not None and not (isinstance(ex, list) and all(isinstance(e, str) for e in ex)):
            raise ValueError(f"태그 {t['id']}의 examples는 문자열 배열이어야 해요.")
        seen.add(t["id"])


def load_common_graph(path: str | os.PathLike, tags_path: str | os.PathLike | None = None) -> dict:
    """공통 그래프 + 태그 파일(tags.json) → 해석된 그래프({**graph, "tags": [...]}). 서버에서 합치는 곳은 여기 하나(T-304).

    태그 순서는 파일 순서 그대로다. tags_path가 없으면 그래프 파일 옆 tags.json.
    하위 호환: 그래프에 tags가 이미 있으면 태그 파일을 읽지 않는다.
    노드가 없는 태그 id를 참조하면 ValueError(공통 그래프 검증). 파일을 못 읽으면 OSError.
    """
    graph = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(graph, dict):
        raise ValueError("공통 그래프가 객체가 아니에요.")
    if isinstance(graph.get("tags"), list):
        tags = graph["tags"]
    else:
        tf_path = Path(tags_path) if tags_path else Path(path).parent / TAGS_FILENAME
        tags_file = json.loads(tf_path.read_text(encoding="utf-8"))
        if not isinstance(tags_file, dict):
            raise ValueError("태그 파일이 객체가 아니에요.")
        if not isinstance(tags_file.get("version"), str) or not tags_file["version"]:
            raise ValueError("태그 파일에 version이 없어요.")
        tags = tags_file.get("tags")
    _check_tags(tags)
    tag_ids = {t["id"] for t in tags}
    for n in graph.get("nodes", []):
        for tid in n.get("tags", []):
            if tid not in tag_ids:
                raise ValueError(f"노드 {n.get('id')}가 없는 태그를 참조해요: {tid}")
    return {**graph, "tags": tags}


def workspace_version_for(graph_path: str | os.PathLike, tags_path: str | os.PathLike | None = None) -> str | None:
    """결과 캐시 키·/health 판본 = "그래프 판본+태그 판본"(T-304). 태그만 바뀌어도 캐시가 갈린다.

    그래프에 tags가 들어 있거나(하위 호환) 태그 파일을 못 읽으면 그래프 판본만 쓴다.
    """
    graph_v = read_graph_version(graph_path)
    try:
        graph = json.loads(Path(graph_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return graph_v
    if not isinstance(graph, dict) or isinstance(graph.get("tags"), list):
        return graph_v
    tags_v = read_graph_version(tags_path or Path(graph_path).parent / TAGS_FILENAME)
    if graph_v is None or tags_v is None:
        return graph_v
    return f"{graph_v}+{tags_v}"


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str | None
    workspace: str
    workspace_version: str | None
    rate_limit_per_min: int
    common_graph_path: str
    keyword_model: str = DEFAULT_GEMINI_MODEL
    analogy_model: str = DEFAULT_GEMINI_MODEL
    lightrag_working_dir: str = str(DEFAULT_LIGHTRAG_WORKING_DIR)
    embedding_provider: str = DEFAULT_EMBEDDING_PROVIDER
    ollama_url: str = DEFAULT_OLLAMA_URL
    embedding_model: str = DEFAULT_EMBEDDING_MODEL
    embedding_dim: int = DEFAULT_EMBEDDING_DIM
    # 비우면 common_graph_path 옆 blocklist.json
    blocklist_path: str | None = None
    # 비우면 common_graph_path 옆 tags.json (T-304)
    tags_path: str | None = None
    # CORS(T-141). 기본은 닫힘: 어떤 출처도 허용하지 않는다. 운영은 확장 id를 allowed_origins 에 적는다
    allowed_origins: tuple[str, ...] = ()
    # true 면 모든 확장 id 형식을 허용(개발용). 운영에서는 끈다
    allow_extension_origins: bool = False
    # 추출 큐 워커(T-414)
    extract_ollama_url: str = ""
    extract_model: str = DEFAULT_EXTRACT_MODEL
    # 비우면 늘 열림. 예 "12:10-13:00,23:00-07:00"(서버 시간대)
    extract_window: str = ""
    extract_interval_s: int = DEFAULT_EXTRACT_INTERVAL_S
    extract_max_attempts: int = DEFAULT_EXTRACT_MAX_ATTEMPTS
    # none | cloud(맥이 꺼졌을 때 사용자 워크스페이스만 클라우드로, 하루 상한)
    extract_fallback: str = "none"
    extract_cloud_daily_cap: int = DEFAULT_EXTRACT_CLOUD_DAILY_CAP
    extract_cloud_timeout_s: float = DEFAULT_EXTRACT_CLOUD_TIMEOUT_S
    # 워커가 도는 워크스페이스들. 비우면 (workspace,)
    extract_workspaces: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        # 워크스페이스 이름은 --reset이 지우는 폴더 이름이 된다. 설정을 읽을 때 바로 막는다(T-140)
        from .seedmeta import validate_workspace

        validate_workspace(self.workspace)
        if self.extract_fallback not in EXTRACT_FALLBACKS:
            raise ValueError(f"EXTRACT_FALLBACK은 none 또는 cloud만 돼요: {self.extract_fallback!r}")
        if not self.extract_workspaces:
            object.__setattr__(self, "extract_workspaces", (self.workspace,))
        for ws in self.extract_workspaces:
            validate_workspace(ws)
        if not self.blocklist_path:
            object.__setattr__(self, "blocklist_path", str(Path(self.common_graph_path).parent / BLOCKLIST_FILENAME))
        if not self.tags_path:
            object.__setattr__(self, "tags_path", str(Path(self.common_graph_path).parent / TAGS_FILENAME))

    def common_graph(self) -> dict:
        """설정된 공통 그래프 + 태그 파일을 합쳐 읽는다(load_common_graph)."""
        return load_common_graph(self.common_graph_path, self.tags_path)

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        graph_path = env.get("COMMON_GRAPH_PATH") or str(DEFAULT_COMMON_GRAPH_PATH)
        # 키가 없어도 서버는 뜬다(비유 요청만 나중에 명확한 오류로 막는다).
        key = env.get("GEMINI_API_KEY") or None
        tags_path = env.get("TAGS_PATH") or None
        version = env.get("WORKSPACE_VERSION") or workspace_version_for(graph_path, tags_path)
        return cls(
            gemini_api_key=key,
            workspace=env.get("WORKSPACE") or DEFAULT_WORKSPACE,
            workspace_version=version,
            rate_limit_per_min=int(env.get("RATE_LIMIT_PER_MIN") or DEFAULT_RATE_LIMIT_PER_MIN),
            common_graph_path=graph_path,
            keyword_model=env.get("GEMINI_KEYWORD_MODEL") or DEFAULT_GEMINI_MODEL,
            analogy_model=env.get("GEMINI_ANALOGY_MODEL") or DEFAULT_GEMINI_MODEL,
            lightrag_working_dir=env.get("LIGHTRAG_WORKING_DIR") or str(DEFAULT_LIGHTRAG_WORKING_DIR),
            embedding_provider=env.get("EMBEDDING_PROVIDER") or DEFAULT_EMBEDDING_PROVIDER,
            ollama_url=env.get("OLLAMA_URL") or DEFAULT_OLLAMA_URL,
            embedding_model=env.get("EMBEDDING_MODEL") or DEFAULT_EMBEDDING_MODEL,
            embedding_dim=int(env.get("EMBEDDING_DIM") or DEFAULT_EMBEDDING_DIM),
            blocklist_path=env.get("BLOCKLIST_PATH") or None,
            tags_path=tags_path,
            allowed_origins=_parse_origins(env.get("ALLOWED_ORIGINS")),
            allow_extension_origins=_parse_bool(env.get("ALLOW_EXTENSION_ORIGINS")),
            extract_ollama_url=(env.get("EXTRACT_OLLAMA_URL") or "").strip(),
            extract_model=env.get("EXTRACT_MODEL") or DEFAULT_EXTRACT_MODEL,
            extract_window=(env.get("EXTRACT_WINDOW") or "").strip(),
            extract_interval_s=int(env.get("EXTRACT_INTERVAL_S") or DEFAULT_EXTRACT_INTERVAL_S),
            extract_max_attempts=int(env.get("EXTRACT_MAX_ATTEMPTS") or DEFAULT_EXTRACT_MAX_ATTEMPTS),
            extract_fallback=(env.get("EXTRACT_FALLBACK") or "none").strip().lower(),
            extract_cloud_daily_cap=int(env.get("EXTRACT_CLOUD_DAILY_CAP") or DEFAULT_EXTRACT_CLOUD_DAILY_CAP),
            extract_cloud_timeout_s=float(env.get("EXTRACT_CLOUD_TIMEOUT_S") or DEFAULT_EXTRACT_CLOUD_TIMEOUT_S),
            extract_workspaces=_parse_origins(env.get("EXTRACT_WORKSPACES")),
        )
