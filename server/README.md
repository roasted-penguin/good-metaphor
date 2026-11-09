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

## 확장에서 부르기(CORS·권한, T-141)

확장은 서비스 워커에서 `POST /v1/analogy`를 `content-type`·`X-Install-Token` 헤더로 불러요.

- **꼭 필요한 것은 확장의 서버 출처 권한이에요.** MV3 서비스 워커의 fetch는 그 출처 권한(host permission)이 있으면 CORS에 묶이지 않아요. 권한이 없으면 확장은 서버를 부르지 않고 이 기기에서 만들어요(`debug.server.reason = 'no-permission'`).
- **CORS는 권장하는 덧댐이지 접근 제어가 아니에요.** 브라우저 밖(curl 등)이나 권한 있는 확장은 CORS와 상관없이 부를 수 있어요. 실제 관문은 설치 토큰(`X-Install-Token`) + 토큰별 요청 한도(`RATE_LIMIT_PER_MIN`)예요. 웹 페이지가 사용자 브라우저를 빌려 부르는 일을 막으려고 기본은 닫아 두고 확장 출처만 열어요.

CORS 설정(기본은 닫힘, 아무 출처도 허용하지 않아요):

- 운영: `ALLOWED_ORIGINS=chrome-extension://<확장 id 32자>`처럼 확장 출처를 쉼표로 적어요. 웹스토어 확장 id와 개발용 압축해제 확장 id가 다르면 둘 다 적어요.
- 개발: `ALLOW_EXTENSION_ORIGINS=true`면 확장 id 형식(`^chrome-extension://[a-p]{32}$`) 전부를 허용해요. 운영에서는 켜지 않아요(아무 확장이나 이 서버를 부를 수 있어요).
- 허용 메서드는 `POST`, 헤더는 `content-type`·`x-install-token`뿐이에요. 쿠키는 쓰지 않아요.
- 확장 쪽: 서버 주소는 `config/admin.json` 또는 정책(`chrome.storage.managed`의 `analogyServer.url`·`timeoutMs`, `managed_schema.json`)으로 줘요. 사용자는 설정 화면 "AI 제공자" 아래 `서버 주소 허용`으로 그 출처의 선택 권한을 한 번 허용해요.
- 도메인이 정해지면(T-401) 확장 `manifest.json`의 `host_permissions`에 그 서버 주소를 고정으로 넣어 허용 단계를 없애요.

로컬에서 확장과 함께 확인:

```bash
cd server
LIGHTRAG_WORKING_DIR=/tmp/rag .venv/bin/python -m app.seed --reset
ALLOW_EXTENSION_ORIGINS=true LIGHTRAG_WORKING_DIR=/tmp/rag .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8770
```

`--host 127.0.0.1`로만 열어요(규칙 10). 확장 `admin.json`의 `analogyServer.url`을 `http://127.0.0.1:8770`으로 두고 설정 화면에서 허용하면 말풍선 아래에 `서버`가 보여요.

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

## 추출 큐 워커(T-414)

```bash
cd server
.venv/bin/python -m app.extract_worker --enqueue 문서.txt [--workspace u_xxx] [--doc-id 출처]   # 청크로 나눠 큐에
.venv/bin/python -m app.extract_worker --status    # 워크스페이스별 pending·running·done·failed(포기) 개수
EXTRACT_OLLAMA_URL=http://<맥 테일넷 주소>:11434 .venv/bin/python -m app.extract_worker --once   # 창 한 번
```

- 큐는 워크스페이스 폴더의 `extract-queue.json`(임시 파일에 쓰고 이름 바꾸기, 경로는 시드와 같은 안전 검사). 청크는 1,200자·겹침 100자, 빈 줄 문단 기준. 같은 문서를 다시 넣으면 이미 있는 청크는 건너뛰어요.
- 창마다 맥에 `GET /api/tags`(2초)로 묻고, 답하면 청크를 하나씩(동시 1) `/api/chat`(JSON 모드, `num_ctx` 16384, 600초)으로 추출해요. 목록 밖 추상구조는 버리고(`filter_extraction`, 규칙 9) 삽입 콜백이 끝나야 `done`이에요.
- 처리 중 연결이 끊기면 그 청크를 `failed`로 두고 이번 창을 멈춰요. 다음 창에 다시 해요. 응답 파싱 실패는 그 청크만 `failed`. Ollama가 4xx(모델 이름이 틀림 등)로 답하면 설정 오류라 시도 수를 쓰지 않고 창만 멈춰요(`lastError`에 안내, 5xx는 연결 실패와 같음). `EXTRACT_MAX_ATTEMPTS`번 실패하면 포기(`--status`의 "포기").
- 프로세스가 죽어 `running`으로 남은 청크는 워커를 시작할 때(`--once`, 주기 루프) `pending`으로 돌려요.
- `EXTRACT_FALLBACK=cloud`면 맥이 답하지 않을 때만 사용자 워크스페이스(`common_`으로 시작하지 않는 것) 청크를 서버 LLM(Gemini, `GEMINI_API_KEY`)으로 추출해요. 하루(UTC) `EXTRACT_CLOUD_DAILY_CAP`개까지, 사용 수는 작업 디렉터리의 `extract-usage.json`. 공통 워크스페이스는 늘 맥만.
- 실제 LightRAG 삽입은 T-421에서 이어요. 지금 `--once`는 결과를 `<워크스페이스>/extract-results/<청크 id>.json`에 남겨요. 주기 루프(`run_forever`, `EXTRACT_INTERVAL_S`)를 서버 프로세스에 붙이는 것도 그때예요(파일 저장소는 프로세스 하나만 써야 해요).
- 맥 포트는 테일넷에만(규칙 10, T-411). `EXTRACT_OLLAMA_URL`이 비면 맥 추출은 꺼져 있어요.

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
| `ALLOWED_ORIGINS` | 없음(허용 없음) | CORS 허용 출처, 쉼표 구분. 운영은 확장 출처 `chrome-extension://<id>`(T-141). 덧댐일 뿐 접근 제어는 설치 토큰 + 요청 한도 |
| `ALLOW_EXTENSION_ORIGINS` | `false` | `true`면 모든 확장 id 형식 허용. 개발용, 운영에서는 끄기 |
| `EXTRACT_OLLAMA_URL` | 없음(꺼짐) | 추출 큐 워커가 부를 맥 Ollama 주소(테일넷, T-414) |
| `EXTRACT_MODEL` | `gemma4:12b` | 맥 추출 모델 |
| `EXTRACT_WINDOW` | 없음(늘 열림) | 추출 시간창(서버 시간대), 예 `12:10-13:00,23:00-07:00` |
| `EXTRACT_INTERVAL_S` | `300` | 주기 루프 간격(초) |
| `EXTRACT_MAX_ATTEMPTS` | `5` | 청크당 시도 상한 |
| `EXTRACT_FALLBACK` | `none` | `cloud`면 맥이 꺼졌을 때 사용자 워크스페이스만 클라우드 추출 |
| `EXTRACT_CLOUD_DAILY_CAP` | `50` | 클라우드 추출 하루(UTC) 청크 상한 |
| `EXTRACT_WORKSPACES` | `WORKSPACE` | 워커가 도는 워크스페이스, 쉼표 구분 |
