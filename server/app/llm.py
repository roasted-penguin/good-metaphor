"""LLM 인터페이스와 실제 Gemini 구현(httpx로 REST 호출).

호버 경로의 LLM은 클라우드만 쓴다(규칙 8). 키는 설정(환경변수)에서만 받는다.
요청 모양은 확장 extension/lib/providers.js의 gemini 종류와 같다.
"""
from __future__ import annotations

import logging
from typing import Any, Protocol

import httpx

log = logging.getLogger(__name__)

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


class LLM(Protocol):
    async def complete(self, system: str, user: str, json: bool) -> str: ...


class LLMError(Exception):
    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


def _gemini_text(data: Any) -> str:
    """응답에서 생각(thought) 조각을 빼고 글만 잇는다."""
    try:
        parts = data["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError, TypeError):
        return ""
    return "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))


class GeminiLLM:
    def __init__(self, api_key: str, model: str, client: httpx.AsyncClient | None = None,
                 base_url: str = GEMINI_BASE_URL, timeout: float = 30.0) -> None:
        self.model = model
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def complete(self, system: str, user: str, json: bool) -> str:
        config: dict[str, Any] = {"thinkingConfig": {"thinkingLevel": "low"}}
        if json:
            config["responseMimeType"] = "application/json"
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": config,
        }
        try:
            return await self._post(body)
        except LLMError as e:
            # 모델에 따라 thinkingConfig를 받지 않으면 빼고 한 번 더(키 오류 같은 다른 400은 그대로)
            if e.status == 400 and "think" in str(e).lower():
                config.pop("thinkingConfig", None)
                return await self._post(body)
            raise

    async def _post(self, body: dict[str, Any]) -> str:
        url = f"{self._base_url}/models/{self.model}:generateContent"
        try:
            res = await self._client.post(url, json=body, headers={"x-goog-api-key": self._api_key})
        except httpx.HTTPError as e:
            raise LLMError(f"Gemini 연결 실패: {type(e).__name__}") from e
        if res.status_code >= 400:
            try:
                message = res.json().get("error", {}).get("message", "")
            except ValueError:
                message = res.text[:200]
            raise LLMError(f"Gemini {res.status_code}: {message}", status=res.status_code)
        try:
            data = res.json()
        except ValueError as e:
            raise LLMError("Gemini 응답이 JSON이 아니에요.", status=502) from e
        return _gemini_text(data)
