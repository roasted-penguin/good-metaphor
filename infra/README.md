# 인프라 절차

콘솔 클릭 대신 명령을 그대로 남긴다(T-401). 설계는 `docs/architecture-lightrag.md`, ADR 0006.

원칙(CLAUDE.md 규칙 8·10):
- 맥은 인터넷에 포트를 열지 않는다. Ollama는 `127.0.0.1:11434`에만, 노출은 `tailscale serve`로 테일넷에만.
- 맥으로 가는 길은 `tag:rag-server` → `tag:llm-node:11434` 하나뿐이다(`infra/tailscale-policy.json`).
- 호버는 맥에 기대지 않는다. 맥은 추출 전용이고 꺼져 있어도 된다.

```
infra/
  tailscale-policy.json        테일넷 정책(HuJSON). 관리 콘솔 Access controls에 붙여 넣는다
  mac/
    window.conf                시간창(서버 EXTRACT_WINDOW와 같은 형식). 시간창은 여기 한 곳에서만 고친다
    com.good-metaphor.ollama-start.plist   시간창 시작에 Ollama를 켜는 LaunchAgent 틀
    com.good-metaphor.ollama-stop.plist    시간창 끝에 끄는 LaunchAgent 틀
    ollama-window.sh           두 에이전트가 부르는 스크립트(start·stop·now·off·status)
    install.sh / uninstall.sh  에이전트 설치·제거(sudo 없음, 여러 번 돌려도 됨)
    tailscale-serve.sh         127.0.0.1:11434를 테일넷에만 내놓기
```

## 맥 추출 노드 (T-411)

M2 Pro 맥(16GB)의 Ollama가 엔티티·관계 추출을 맡는다. 시간창(기본 점심 12:10~13:00, 밤 23:00~07:00)에만 켜지고, EC2 추출 워커(`server/app/extract_worker.py`)가 5분마다 `GET /api/tags`로 맥이 켜졌는지 보고 큐를 비운다.

### 어떻게 도는지

- **시작 에이전트** `com.good-metaphor.ollama-start`: `window.conf`의 각 시작 시각(`StartCalendarInterval`)과 로그인 때(`RunAtLoad`) `ollama-window.sh start`를 부른다. 창 안이면 `ollama serve`를 띄우고 `caffeinate -i -w`로 켜져 있는 동안만 맥이 잠들지 않게 한다. 창 밖이면 아무것도 하지 않고 끝난다. 비정상 종료만 30초 뒤 다시 띄운다(`KeepAlive.SuccessfulExit=false`).
- **끝 에이전트** `com.good-metaphor.ollama-stop`: 각 끝 시각에 `ollama-window.sh stop`이 시작 에이전트에 SIGTERM을 보낸다(다른 창 안이면 건너뜀).
- 환경 변수는 plist `EnvironmentVariables`에 넷만: `OLLAMA_HOST=127.0.0.1:11434`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=5m`, `OLLAMA_CONTEXT_LENGTH=16384`. `install.sh`와 `ollama-window.sh start`는 `OLLAMA_HOST`가 127.0.0.1이 아니면 멈춘다.
- 스크립트 사본은 `~/Library/Application Support/good-metaphor/mac/`(launchd가 `~/Desktop` 아래 파일을 못 읽는 일을 피함), 에이전트는 `~/Library/LaunchAgents/`, 로그는 `~/Library/Logs/good-metaphor/ollama.log`·`ollama-stop.log`.
- 시간창은 시각 기준이다. 맥이 잠들어 있던 사이 지난 시작 시각은 깨어난 뒤 한 번 돈다(launchd 동작).

### 1. 에이전트 설치

Ollama는 Homebrew로(`brew install ollama`), 모델은 미리 받아 둔다(`ollama pull gemma4:12b`, 비교용 `qwen3.5:9b`, 임베딩 `bge-m3`).

```bash
# 손으로 띄운 ollama serve나 Ollama.app이 11434를 쓰고 있으면 먼저 끈다(아래 확인 명령으로 찾기)
lsof -nP -iTCP:11434 -sTCP:LISTEN

cd infra/mac
./install.sh          # 지금이 창 안이면 바로 켜지고, 밖이면 다음 창 시작에 켜진다
./install.sh --now    # 창과 상관없이 지금 켠다(다음 창 끝에 꺼진다). 벤치마크(T-413) 전에
```

시간창을 바꾸려면 `infra/mac/window.conf`의 `OLLAMA_WINDOW`만 고치고 `./install.sh`를 다시 돌린다. 서버 `.env`의 `EXTRACT_WINDOW`도 같은 값으로 맞춘다.

평소 조작(사본 경로를 쓴다):

```bash
APP="$HOME/Library/Application Support/good-metaphor/mac"
"$APP/ollama-window.sh" status   # 에이전트 상태와 11434 리스너
"$APP/ollama-window.sh" now      # 창 밖에서 지금 켜기(다음 창 끝에 꺼짐)
"$APP/ollama-window.sh" off      # 노트북을 바로 써야 할 때 끄기(다음 창 시작에 다시 켜짐)
tail -f ~/Library/Logs/good-metaphor/ollama.log
./uninstall.sh                   # 에이전트 제거(로그·모델은 남김)
```

`now`는 표시 파일(`force-start`)을 만들고 `launchctl kickstart gui/$(id -u)/com.good-metaphor.ollama-start`를 부른다. 시작 스크립트가 표시를 읽고 지운 뒤 창과 상관없이 켠다. `off`로 끄면 워커는 처리 중이던 청크를 실패로 두고 다음 창에 다시 한다.

### 2. Tailscale 설치·로그인 (사람이 한다, 관리자 암호 필요)

1. 관리 콘솔 → Access controls에 `infra/tailscale-policy.json` 내용을 붙여 넣고 저장한다. 정책 안 `tests`가 통과해야 저장된다. 태그는 정책이 먼저 들어가 있어야 붙는다.
2. https://tailscale.com/download/mac 에서 설치하고, 메뉴 막대에서 로그인한다.
3. 이 맥에 태그를 붙인다.

```bash
tailscale up --advertise-tags=tag:llm-node
```

태그를 붙이면 이 맥은 내 사용자 신원을 잃고, 정책상 이 맥에서 다른 테일넷 기기로 나갈 길도 없다(맥은 받기만 한다). 관리 콘솔 Machines에서 이 맥에 `tag:llm-node`가 보이는지, 필요하면 키 만료 끄기(Disable key expiry)를 확인한다.

### 3. 테일넷에만 내놓기

```bash
cd infra/mac
./tailscale-serve.sh   # tailscale serve --bg --tcp 11434 tcp://127.0.0.1:11434 + 상태 출력
```

Tailscale이 없거나 로그인 전이면 한국어 안내만 내고 멈춘다. 11434가 127.0.0.1 밖에도 열려 있으면 멈춘다. `--bg`라 재부팅 뒤에도 유지된다. 끄기는 `tailscale serve --tcp 11434 off`. **`tailscale funnel`은 쓰지 않는다**(인터넷 공개).

### 4. 확인 (T-411 완료 기준)

```bash
# 맥: 127.0.0.1에만 열려 있어야 한다(*:11434, 0.0.0.0, 192.168.x.x가 보이면 안 된다)
lsof -nP -iTCP:11434 -sTCP:LISTEN
curl -s http://127.0.0.1:11434/api/tags      # 모델 목록(bge-m3, gemma4:12b, qwen3.5:9b)

# EC2(tag:rag-server, T-401 이후): 성공해야 한다
curl -s http://<맥 테일넷 이름>:11434/api/tags

# 같은 와이파이의 다른 기기(휴대폰·다른 노트북, 테일넷 밖): 실패해야 한다(연결 거부·시간 초과)
curl -s -m 5 http://<맥의 와이파이 IP>:11434/api/tags
```

`tailscale serve` 뒤에도 `lsof`의 `ollama` 줄은 `127.0.0.1:11434` 하나여야 한다. 테일넷 쪽 받기는 Tailscale 안(사용자 공간 네트워크)에서 하므로 보통 `lsof`에 따로 보이지 않고, 보이더라도 `100.x` 테일넷 주소의 Tailscale 프로세스뿐이어야 한다.

맥의 와이파이 IP는 `ipconfig getifaddr en0`, 테일넷 이름은 `tailscale status --json`의 `Self.DNSName`(또는 `tailscale-serve.sh` 마지막 줄). 테일넷 안이어도 내 다른 기기(태그 없음)에서는 정책상 실패해야 맞다.

서버 쪽 연결: EC2 `.env`에 `EXTRACT_OLLAMA_URL=http://<맥 테일넷 이름>:11434`, `EXTRACT_WINDOW=12:10-13:00,23:00-07:00`(window.conf와 같게). 자세한 건 `server/README.md` "추출 큐 워커".

## EC2 (T-401, 아직 안 함)

T-401에서 채운다. 사람이 해야 하는 것:

- [ ] AWS 계정·결제, 서울 리전 `t4g.medium`(Graviton) 요금 확인
- [ ] 도메인 준비(Caddy가 HTTPS 인증서를 자동으로 받는다)
- [ ] 보안 그룹 인바운드는 443만(SSH 22도 열지 않는다, SSH는 Tailscale로만)
- [ ] Tailscale 태그 인증 키 발급(`tag:rag-server`) → `tailscale up --auth-key=<키> --advertise-tags=tag:rag-server --ssh`
- [ ] Gemini 키는 SSM Parameter Store에(저장소·대화에 남기지 않는다)
- [ ] 스왑 2GB, Ollama + `bge-m3`
- [ ] 명령은 이 파일에 그대로 남긴다(콘솔 클릭 금지, 가능하면 스크립트)

완료 기준: 테일넷에서만 SSH 가능, 인터넷에서 `https://<도메인>/health` 200, `bge-m3` 임베딩 호출 성공.
