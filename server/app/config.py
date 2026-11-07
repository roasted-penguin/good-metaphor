"""서버 설정. 모든 값은 환경변수에서 읽는다(API 키는 코드에 두지 않는다)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

# 저장소 루트 = server/app/config.py 에서 두 단계 위. 실행 위치(cwd)와 무관하게 찾는다.
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COMMON_GRAPH_PATH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"
DEFAULT_WORKSPACE = "common_maplestory"
DEFAULT_RATE_LIMIT_PER_MIN = 30


def read_graph_version(path: str | os.PathLike) -> str | None:
    """공통 그래프 JSON의 version 값. 파일이 없거나 깨졌으면 None."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    version = data.get("version") if isinstance(data, dict) else None
    return str(version) if version is not None else None


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str | None
    workspace: str
    workspace_version: str | None
    rate_limit_per_min: int
    common_graph_path: str

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        graph_path = env.get("COMMON_GRAPH_PATH") or str(DEFAULT_COMMON_GRAPH_PATH)
        # 키가 없어도 서버는 뜬다(비유 요청만 나중에 명확한 오류로 막는다).
        key = env.get("GEMINI_API_KEY") or None
        version = env.get("WORKSPACE_VERSION") or read_graph_version(graph_path)
        return cls(
            gemini_api_key=key,
            workspace=env.get("WORKSPACE") or DEFAULT_WORKSPACE,
            workspace_version=version,
            rate_limit_per_min=int(env.get("RATE_LIMIT_PER_MIN") or DEFAULT_RATE_LIMIT_PER_MIN),
            common_graph_path=graph_path,
        )
