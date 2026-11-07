# analogy-api 서버

확장 `explain()`과 같은 모양의 비유 응답을 돌려주는 FastAPI 서버(T-402, ADR 0006). `/health`와 `POST /v1/analogy`가 있어요.

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
cp .env.example .env              # 처음 한 번. 키는 .env에만 넣어요(커밋 안 함)
docker compose up --build -d
curl -s localhost:8000/health
docker compose down
```

- 공통 그래프는 저장소의 `extension/data/common/`을 컨테이너 `/data/common`에 읽기 전용으로 마운트하고, `COMMON_GRAPH_PATH=/data/common/maplestory.json`으로 가리켜요.
- `.env`가 없으면 compose가 멈춰요(Compose v2.24 미만은 `env_file`의 `required: false`를 몰라요). `GEMINI_API_KEY=`를 비워 두어도 서버는 뜨고 `/health`는 200이에요.

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 없음 | 없어도 서버는 떠요. 로컬은 셸 환경, 도커는 `server/.env`(커밋 안 함)에서 읽어요. |
| `WORKSPACE` | `common_maplestory` | LightRAG 워크스페이스 이름 |
| `WORKSPACE_VERSION` | 공통 그래프의 `version` | 캐시 키에 붙는 판본 |
| `RATE_LIMIT_PER_MIN` | `30` | 설치 토큰별 분당 요청 한도 |
| `COMMON_GRAPH_PATH` | 저장소의 `extension/data/common/maplestory.json` | 실행 위치(cwd)와 무관하게 저장소 루트 기준으로 찾아요. 도커에서는 compose가 `/data/common/maplestory.json`으로 지정해요. |
