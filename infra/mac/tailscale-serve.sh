#!/bin/bash
# 맥 Ollama(127.0.0.1:11434)를 테일넷에만 내놓는다(T-411, 규칙 10).
# 인터넷·같은 와이파이에는 포트를 열지 않는다. tailscale serve는 테일넷 주소에서만 받는다(funnel 아님).
# 누가 들어올 수 있는지는 infra/tailscale-policy.json(tag:rag-server → tag:llm-node:11434만)이 정한다.
set -euo pipefail

# Tailscale CLI 찾기: brew/독립 설치는 PATH에, 앱 스토어·standalone 앱은 앱 안에 있다
TS="$(command -v tailscale || true)"
if [ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
if [ -z "$TS" ]; then
  cat >&2 <<'MSG'
Tailscale이 설치돼 있지 않아요.
  1) https://tailscale.com/download/mac 에서 Tailscale을 설치해 주세요(관리자 암호가 필요해요).
  2) 메뉴 막대의 Tailscale에서 로그인한 뒤, 터미널에서 이 기기에 태그를 붙여요:
       tailscale up --advertise-tags=tag:llm-node
  3) 이 스크립트를 다시 돌려 주세요.
MSG
  exit 1
fi

state="$("$TS" status --json 2>/dev/null | /usr/bin/sed -n 's/.*"BackendState": *"\([A-Za-z]*\)".*/\1/p' | head -1 || true)"
if [ "$state" != "Running" ]; then
  cat >&2 <<MSG
Tailscale에 로그인돼 있지 않아요(상태: ${state:-알 수 없음}).
  메뉴 막대의 Tailscale에서 로그인한 뒤, 이 기기에 태그를 붙여 주세요:
    tailscale up --advertise-tags=tag:llm-node
  (태그는 관리 콘솔의 정책 파일 infra/tailscale-policy.json이 먼저 들어가 있어야 붙어요.)
MSG
  exit 1
fi

if ! "$TS" status --json 2>/dev/null | grep -q '"tag:llm-node"'; then
  echo "주의: 이 기기에 tag:llm-node가 없어요. 정책상 EC2(tag:rag-server)가 들어올 수 없어요." >&2
  echo "  tailscale up --advertise-tags=tag:llm-node" >&2
fi

# Ollama가 127.0.0.1에만 열려 있는지 먼저 확인한다
listen="$(/usr/sbin/lsof -nP -iTCP:11434 -sTCP:LISTEN 2>/dev/null | tail -n +2 || true)"
if [ -n "$listen" ] && echo "$listen" | grep -vq '127\.0\.0\.1:11434'; then
  echo "멈춰요: 11434가 127.0.0.1 밖에도 열려 있어요. OLLAMA_HOST를 확인해 주세요(규칙 10)." >&2
  echo "$listen" >&2
  exit 1
fi
[ -z "$listen" ] && echo "참고: 지금은 Ollama가 꺼져 있어요(시간창 밖일 수 있어요). serve 설정은 그대로 해 둬요."

"$TS" serve --bg --tcp 11434 tcp://127.0.0.1:11434
echo
echo "테일넷 노출 상태:"
"$TS" serve status
echo
echo "이 기기의 테일넷 이름: $("$TS" status --json | /usr/bin/sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -1)"
echo "EC2에서 확인: curl http://<위 이름>:11434/api/tags"
