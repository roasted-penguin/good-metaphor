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
docker compose build
docker compose run --rm analogy-api python -m app.seed   # 처음 한 번: 검색 인덱스를 rag_storage 볼륨에 넣어요
docker compose up -d
curl -s localhost:8000/health     # "index": {"ready": true, ...} 이면 검색 준비 끝
docker compose down               # 볼륨(인덱스)은 남아요. 지우려면 docker compose down -v
```

- 검색 인덱스는 이름 있는 볼륨 `rag_storage`(컨테이너 `/data/rag_storage`, `LIGHTRAG_WORKING_DIR`)에 있어요. 서버와 시드가 같은 이미지·볼륨·`EMBEDDING_*`를 써서 어긋나지 않아요.
- 그래프 판본이나 임베딩 설정이 바뀌어 `/health`의 `index.reason`이 다시 시드하라고 하면 `docker compose run --rm analogy-api python -m app.seed --reset` 뒤 `docker compose restart`.
- 포트는 기본으로 `127.0.0.1:8000`에만 열려요(맥에서 같은 망에 열지 않아요, 규칙 10). 서버(EC2)에서 바깥에 열어야 하면 `BIND_ADDR=0.0.0.0 docker compose up -d`.

- 공통 그래프는 저장소의 `extension/data/common/`을 컨테이너 `/data/common`에 읽기 전용으로 마운트하고, `COMMON_GRAPH_PATH=/data/common/maplestory.json`으로 가리켜요. 추상 태그는 같은 폴더의 `tags.json`(`TAGS_PATH`)에서 읽어 `load_common_graph`가 합쳐요(T-304).
- `.env`가 없으면 compose가 멈춰요(Compose v2.24 미만은 `env_file`의 `required: false`를 몰라요). `GEMINI_API_KEY=`를 비워 두어도 서버는 뜨고 `/health`는 200이에요.

## 공통 그래프 주입(시드)

```bash
cd server
.venv/bin/python -m app.seed      # 기본: 해시 임베딩, server/rag_storage/ 에 저장
EMBEDDING_PROVIDER=ollama .venv/bin/python -m app.seed   # 맥의 Ollama bge-m3로
.venv/bin/python -m app.seed --reset   # 워크스페이스 폴더를 지우고 새로(그래프 판본·임베딩이 바뀌었을 때)
```

- 공통 그래프(`COMMON_GRAPH_PATH` + 태그 파일 `TAGS_PATH`)를 LightRAG 사용자 정의 KG로 바꿔 넣어요(태그 18 + 노드 18 = 엔티티 36). 끝나면 한 줄 요약(엔티티·관계 수, 워크스페이스, 작업 디렉터리)을 찍어요.
- 다시 돌려도 같아요. LightRAG가 같은 이름의 엔티티·관계를 덮어써서 설명이 겹치지 않아요.
- 시드는 덮어쓰기만 하고 지우지 않아요. 공통 그래프 `version`이 바뀌거나 노드·태그를 지우거나 이름을 바꾸면 `--reset`으로 작업 디렉터리(`LIGHTRAG_WORKING_DIR/WORKSPACE/`)를 지우고 다시 넣어요.
- 시드가 끝나면 워크스페이스 폴더에 `seed-meta.json`(그래프 판본 `그래프+태그`, 임베딩 공급자·모델·차원, 시드 시각)을 남겨요(임시 파일에 쓰고 이름 바꾸기). 시드를 시작할 때 옛 기록을 지우므로 중간에 실패하면 기록이 없어요(T-140).
- 서버는 인덱스를 열기 전에 `seed-meta.json`을 지금 설정(`WORKSPACE_VERSION`, `EMBEDDING_*`)과 비교해요. 없거나(옛 인덱스) 다르면 열지 않고 `/v1/analogy`가 503("검색 인덱스가 아직 준비되지 않았어요."), `/health`의 `index`가 `{"ready": false, "reason": ...}`예요. 이유와 다시 시드 명령은 `index.reason`과 서버 로그에 있어요(경로는 로그에만).
- `--reset` 없이 시드 기록이 없거나 지금 설정과 다른 인덱스 위에 넣으려 하면 시드가 아무것도 건드리지 않고 멈춰요(`--reset`을 쓰라고 알려 줘요). 그래프 판본을 모를 때도 멈춰요.
- `WORKSPACE`는 영문·숫자·`_`·`-`만 돼요. `--reset`은 `LIGHTRAG_WORKING_DIR` 바로 아래 그 폴더만 지우고, 심볼릭 링크면 거절해요.
- Ollama 응답 벡터 차원이 `EMBEDDING_DIM`과 다르면 시드가 한국어 오류로 멈춰요.
- LLM은 부르지 않아요. LightRAG가 LLM을 부르려 하면 오류로 멈춰요(버그라는 뜻이에요).
- 해시 임베딩은 네트워크 없이 도는 개발·테스트용이에요. 실제 검색 품질은 `ollama`로 넣은 인덱스로 봐요. 임베딩을 바꾸면 작업 디렉터리를 지우고 다시 넣어요(벡터 차원·모델이 섞이면 안 돼요).
- `server/rag_storage/`는 커밋하지 않고 도커 이미지에도 넣지 않아요.
- 서버는 `LIGHTRAG_WORKING_DIR/WORKSPACE/`에 인덱스 파일(`graph_chunk_entity_relation.graphml`, `vdb_entities.json`)이 있으면 첫 검색 때 LightRAG를 한 번 열어 써요. 없으면 `/v1/analogy`가 503("검색 인덱스가 아직 준비되지 않았어요.", 시드 명령은 `/health`의 `index.reason`)이고, 서버가 뜬 뒤 처음 시드하면 재시작 없이 잡아요. 다만 서버가 인덱스를 한 번 연 뒤에 다시 시드했다면 서버를 재시작해야 새 인덱스를 읽어요. 서버와 시드의 `EMBEDDING_*` 설정이 같아야 해요(다르면 위 503).

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 없음 | 없어도 서버는 떠요. 로컬은 셸 환경, 도커는 `server/.env`(커밋 안 함)에서 읽어요. |
| `WORKSPACE` | `common_maplestory` | LightRAG 워크스페이스 이름 |
| `WORKSPACE_VERSION` | `그래프 version+태그 version`(태그가 그래프 안에 있거나 태그 파일을 못 읽으면 그래프 version만) | 캐시 키에 붙는 판본. 태그만 바뀌어도 캐시가 갈려요(T-304) |
| `RATE_LIMIT_PER_MIN` | `30` | 설치 토큰별 분당 요청 한도 |
| `COMMON_GRAPH_PATH` | 저장소의 `extension/data/common/maplestory.json` | 실행 위치(cwd)와 무관하게 저장소 루트 기준으로 찾아요. 도커에서는 compose가 `/data/common/maplestory.json`으로 지정해요. |
| `TAGS_PATH` | 공통 그래프 파일 옆 `tags.json` | 추상 태그(통제 어휘)의 원본(T-304, ADR 0012). 그래프에 `tags`가 이미 있으면 읽지 않아요. 도커에서는 `/data/common/tags.json`. |
| `LIGHTRAG_WORKING_DIR` | `server/rag_storage` | LightRAG 인덱스 폴더. 아래에 워크스페이스별 폴더가 생겨요. 도커에서는 볼륨 `rag_storage`의 `/data/rag_storage`. |
| `EMBEDDING_PROVIDER` | `hash` | `hash`(네트워크 없음) 또는 `ollama` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 주소. 맥은 테일넷(`tailscale serve`)으로만 열어요(규칙 10). |
| `EMBEDDING_MODEL` | `bge-m3` | Ollama 임베딩 모델 |
| `EMBEDDING_DIM` | `1024` | 임베딩 차원(bge-m3 = 1024) |
| `BIND_ADDR` | `127.0.0.1` | 도커 compose만. 포트 8000을 열 주소 |
