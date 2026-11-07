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

## 공통 그래프 주입(시드)

```bash
cd server
.venv/bin/python -m app.seed      # 기본: 해시 임베딩, server/rag_storage/ 에 저장
EMBEDDING_PROVIDER=ollama .venv/bin/python -m app.seed   # 맥의 Ollama bge-m3로
```

- 공통 그래프(`COMMON_GRAPH_PATH`)를 LightRAG 사용자 정의 KG로 바꿔 넣어요(태그 18 + 노드 18 = 엔티티 36). 끝나면 한 줄 요약(엔티티·관계 수, 워크스페이스, 작업 디렉터리)을 찍어요.
- 다시 돌려도 같아요. LightRAG가 같은 이름의 엔티티·관계를 덮어써서 설명이 겹치지 않아요.
- LLM은 부르지 않아요. LightRAG가 LLM을 부르려 하면 오류로 멈춰요(버그라는 뜻이에요).
- 해시 임베딩은 네트워크 없이 도는 개발·테스트용이에요. 실제 검색 품질은 `ollama`로 넣은 인덱스로 봐요. 임베딩을 바꾸면 작업 디렉터리를 지우고 다시 넣어요(벡터 차원·모델이 섞이면 안 돼요).
- `server/rag_storage/`는 커밋하지 않고 도커 이미지에도 넣지 않아요.

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 없음 | 없어도 서버는 떠요. 로컬은 셸 환경, 도커는 `server/.env`(커밋 안 함)에서 읽어요. |
| `WORKSPACE` | `common_maplestory` | LightRAG 워크스페이스 이름 |
| `WORKSPACE_VERSION` | 공통 그래프의 `version` | 캐시 키에 붙는 판본 |
| `RATE_LIMIT_PER_MIN` | `30` | 설치 토큰별 분당 요청 한도 |
| `COMMON_GRAPH_PATH` | 저장소의 `extension/data/common/maplestory.json` | 실행 위치(cwd)와 무관하게 저장소 루트 기준으로 찾아요. 도커에서는 compose가 `/data/common/maplestory.json`으로 지정해요. |
| `LIGHTRAG_WORKING_DIR` | `server/rag_storage` | LightRAG 인덱스 폴더. 아래에 워크스페이스별 폴더가 생겨요. |
| `EMBEDDING_PROVIDER` | `hash` | `hash`(네트워크 없음) 또는 `ollama` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 주소. 맥은 테일넷(`tailscale serve`)으로만 열어요(규칙 10). |
| `EMBEDDING_MODEL` | `bge-m3` | Ollama 임베딩 모델 |
| `EMBEDDING_DIM` | `1024` | 임베딩 차원(bge-m3 = 1024) |
