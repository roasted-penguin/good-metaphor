# analogy-api 서버

확장 `explain()`과 같은 모양의 비유 응답을 돌려주는 FastAPI 서버(T-402, ADR 0006). 지금은 뼈대(`/health`)까지 있어요.

## 처음 한 번

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
```

## 테스트

```bash
cd server
.venv/bin/pytest -q
```

테스트는 API 키 없이 돌아요.

## 실행

```bash
cd server
.venv/bin/uvicorn app.main:app --reload --port 8000
curl localhost:8000/health
```

## 도커

```bash
cd server
docker compose up
```

공통 그래프는 저장소의 `extension/data/common/`을 읽기 전용으로 마운트해요.

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 없음 | 없어도 서버는 떠요. 값은 셸 환경에서만 넘기고 파일에 쓰지 않아요. |
| `WORKSPACE` | `common_maplestory` | LightRAG 워크스페이스 이름 |
| `WORKSPACE_VERSION` | 공통 그래프의 `version` | 캐시 키에 붙는 판본 |
| `RATE_LIMIT_PER_MIN` | `30` | 설치 토큰별 분당 요청 한도 |
| `COMMON_GRAPH_PATH` | `../extension/data/common/maplestory.json` | 도커에서는 `/data/common/maplestory.json` |
