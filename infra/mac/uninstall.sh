#!/bin/bash
# 맥 Ollama 시간창 launchd 에이전트 제거(T-411). sudo 없이, 여러 번 돌려도 된다.
# 로그(~/Library/Logs/good-metaphor)와 모델(~/.ollama)은 지우지 않는다.
set -euo pipefail

APP_DIR="$HOME/Library/Application Support/good-metaphor/mac"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
LABELS=(com.good-metaphor.ollama-stop com.good-metaphor.ollama-start)

if [ "$(id -u)" -eq 0 ]; then
  echo "sudo 없이 돌려 주세요." >&2
  exit 1
fi

for label in "${LABELS[@]}"; do
  if /bin/launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
    /bin/launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    echo "내렸어요: $label"
  fi
  rm -f "$AGENTS_DIR/$label.plist"
done
rm -rf "$APP_DIR"

echo "제거했어요(Ollama도 꺼졌어요). 로그와 모델은 남겨 뒀어요."
echo "테일넷 노출도 끄려면: tailscale serve --tcp 11434 off"
