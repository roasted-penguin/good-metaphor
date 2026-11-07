"""FastAPI 앱 생성. deps로 설정·가짜 부품을 주입할 수 있다(테스트용)."""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from . import __version__
from .config import Settings


def create_app(deps: dict[str, Any] | None = None) -> FastAPI:
    deps = dict(deps or {})
    settings = deps.get("settings") or Settings.from_env()

    app = FastAPI(title="analogy-api", version=__version__)
    app.state.settings = settings
    app.state.deps = deps

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__}

    return app


# uvicorn app.main:app 으로 실행할 때 쓰는 기본 앱
app = create_app()
