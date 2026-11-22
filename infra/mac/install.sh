#!/bin/bash
# 맥 Ollama 시간창 launchd 에이전트 설치(T-411). sudo 없이 사용자 LaunchAgent만 쓴다.
# 여러 번 돌려도 된다(있으면 내리고 다시 올린다).
#   ./install.sh         설치만. 지금이 창 안이면 바로 켜지고, 밖이면 다음 창 시작에 켜진다.
#   ./install.sh --now   설치하고 창과 상관없이 지금 켠다(다음 창 끝에 꺼진다).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/Library/Application Support/good-metaphor/mac"
LOG_DIR="$HOME/Library/Logs/good-metaphor"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
EXPECTED_HOST="127.0.0.1:11434"
LABELS=(com.good-metaphor.ollama-start com.good-metaphor.ollama-stop)

NOW=0
for arg in "$@"; do
  case "$arg" in
    --now) NOW=1 ;;
    *) echo "쓰는 법: $0 [--now]" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  echo "sudo 없이 돌려 주세요. 사용자 LaunchAgent만 설치해요." >&2
  exit 1
fi

# ── 규칙 10: OLLAMA_HOST가 127.0.0.1이 아니면 멈춘다 ──
for label in "${LABELS[@]}"; do
  plist="$HERE/$label.plist"
  host="$(/usr/bin/plutil -extract EnvironmentVariables.OLLAMA_HOST raw -o - "$plist" 2>/dev/null || true)"
  if [ "$host" != "$EXPECTED_HOST" ]; then
    echo "멈춰요: $label.plist의 OLLAMA_HOST가 $EXPECTED_HOST가 아니에요(${host:-없음}). 127.0.0.1에만 열어야 해요(규칙 10)." >&2
    exit 1
  fi
  if grep -q '0\.0\.0\.0' "$plist"; then
    echo "멈춰요: $label.plist에 모든 주소(0-0-0-0) 바인딩이 있어요(규칙 10)." >&2
    exit 1
  fi
done
if [ -n "${OLLAMA_HOST:-}" ] && [ "$OLLAMA_HOST" != "$EXPECTED_HOST" ] && [ "$OLLAMA_HOST" != "127.0.0.1" ]; then
  echo "멈춰요: 지금 셸의 OLLAMA_HOST가 $OLLAMA_HOST예요. 127.0.0.1로 바꾸거나 지운 뒤 다시 돌려 주세요." >&2
  exit 1
fi
lc_host="$(/bin/launchctl getenv OLLAMA_HOST || true)"
if [ -n "$lc_host" ] && [ "$lc_host" != "$EXPECTED_HOST" ] && [ "$lc_host" != "127.0.0.1" ]; then
  echo "멈춰요: launchctl 전역 OLLAMA_HOST가 $lc_host예요. 'launchctl unsetenv OLLAMA_HOST' 뒤 다시 돌려 주세요." >&2
  exit 1
fi

# ── 시간창 읽기(window.conf 한 곳) ──
OLLAMA_WINDOW=""
OLLAMA_BIN=""
# shellcheck source=window.conf
. "$HERE/window.conf"
if [ -z "${OLLAMA_WINDOW// /}" ]; then
  echo "window.conf의 OLLAMA_WINDOW가 비어 있어요. 시간창을 적어 주세요(예: 12:10-13:00,23:00-07:00)." >&2
  exit 1
fi
set +e
/bin/bash "$HERE/ollama-window.sh" in-window 00:00 >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" -eq 2 ]; then
  echo "window.conf의 OLLAMA_WINDOW 형식이 잘못됐어요: $OLLAMA_WINDOW" >&2
  exit 1
fi
[ -x "$OLLAMA_BIN" ] || echo "주의: ollama가 $OLLAMA_BIN에 없어요. 'brew install ollama' 또는 window.conf의 OLLAMA_BIN을 확인해 주세요." >&2

# "HH:MM-HH:MM,..." → launchd StartCalendarInterval JSON(시작 쪽 또는 끝 쪽)
intervals_json() {
  local which="$1" out="" part hm h m
  IFS=',' read -r -a parts <<< "${OLLAMA_WINDOW// /}"
  for part in "${parts[@]}"; do
    [ -z "$part" ] && continue
    if [ "$which" = start ]; then hm="${part%%-*}"; else hm="${part##*-}"; fi
    h=$((10#${hm%%:*})); m=$((10#${hm##*:}))
    out="$out${out:+,}{\"Hour\":$h,\"Minute\":$m}"
  done
  echo "[$out]"
}

mkdir -p "$APP_DIR" "$LOG_DIR" "$AGENTS_DIR"
# launchd가 ~/Desktop 아래 스크립트를 못 읽는 일(개인정보 보호 권한)을 피하려고 사본을 둔다
install -m 0755 "$HERE/ollama-window.sh" "$APP_DIR/ollama-window.sh"
install -m 0644 "$HERE/window.conf" "$APP_DIR/window.conf"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
esc_app="$(printf '%s' "$APP_DIR" | sed 's/[&|]/\\&/g')"
esc_log="$(printf '%s' "$LOG_DIR" | sed 's/[&|]/\\&/g')"
for label in "${LABELS[@]}"; do
  out="$tmp/$label.plist"
  sed -e "s|__APP_DIR__|$esc_app|g" -e "s|__LOG_DIR__|$esc_log|g" "$HERE/$label.plist" > "$out"
  if [ "$label" = com.good-metaphor.ollama-start ]; then which=start; else which=end; fi
  /usr/bin/plutil -replace StartCalendarInterval -json "$(intervals_json "$which")" "$out"
  /usr/bin/plutil -lint "$out" >/dev/null
done

# 있으면 내리고(멱등) 새로 넣는다
for label in "${LABELS[@]}"; do
  if /bin/launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
    /bin/launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  fi
done
# bootout이 끝날 때까지 잠깐 기다린다(바로 bootstrap하면 "Input/output error"가 날 수 있다)
for _ in 1 2 3 4 5 6 7 8 9 10; do
  /bin/launchctl print "$DOMAIN/${LABELS[0]}" >/dev/null 2>&1 || break
  sleep 0.5
done

busy="$(/usr/sbin/lsof -nP -iTCP:11434 -sTCP:LISTEN 2>/dev/null | tail -n +2 || true)"
if [ -n "$busy" ]; then
  echo "주의: 11434를 다른 프로세스가 이미 쓰고 있어요. launchd Ollama는 그 프로세스가 끝나야 켜져요:" >&2
  echo "$busy" >&2
fi

rm -f "$APP_DIR/force-start"
if [ "$NOW" -eq 1 ]; then
  touch "$APP_DIR/force-start"   # 시작 에이전트가 RunAtLoad로 한 번 읽고 지운다
fi

for label in "${LABELS[@]}"; do
  cp "$tmp/$label.plist" "$AGENTS_DIR/$label.plist"
  chmod 0644 "$AGENTS_DIR/$label.plist"
  /bin/launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$label.plist"
done

# RunAtLoad만 믿지 않고, 켜야 할 때는 바로 kickstart한다(이미 돌고 있으면 아무 일도 안 함)
if [ "$NOW" -eq 1 ] || /bin/bash "$APP_DIR/ollama-window.sh" in-window >/dev/null 2>&1; then
  /bin/launchctl kickstart "$DOMAIN/${LABELS[0]}" || true
fi

echo "설치했어요. 시간창: $OLLAMA_WINDOW"
echo "  시작 에이전트 시각: $(intervals_json start)"
echo "  끝 에이전트 시각:   $(intervals_json end)"
echo "  로그: $LOG_DIR/ollama.log, $LOG_DIR/ollama-stop.log"
if [ "$NOW" -eq 1 ]; then
  echo "  --now: 창과 상관없이 지금 켰어요(다음 창 끝에 꺼져요)."
fi
echo "상태 보기: \"$APP_DIR/ollama-window.sh\" status"
