#!/bin/bash
# 맥 Ollama 시간창 스크립트(T-411). launchd 에이전트가 부른다.
#   start          시작 에이전트용. 창 안이면(또는 "지금 켜기" 표시가 있으면) ollama serve를 띄우고 기다린다.
#   stop           끝 에이전트용. 창 밖이면 시작 에이전트의 Ollama를 끈다.
#   now            창과 상관없이 지금 켠다(다음 창 끝에 꺼진다). T-413 벤치마크 등.
#   hold           지금 켜고, release·off 전까지 끝 에이전트가 끄지 않게 붙잡는다(벤치마크 등 긴 작업).
#   release        hold를 푼다(켜진 Ollama는 다음 창 끝에 꺼진다).
#   off            창과 상관없이 지금 끈다(hold도 푼다, 노트북을 바로 써야 할 때).
#   in-window [HH:MM]  그 시각(없으면 지금)이 창 안이면 종료 코드 0. 테스트용.
#   status         launchd 상태와 11434 리스너를 보여 준다.
# 규칙 10: Ollama는 127.0.0.1에만 연다. 그 외 주소면 켜지 않는다.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$HERE/window.conf"
START_LABEL="com.good-metaphor.ollama-start"
FORCE_MARK="$HERE/force-start"
HOLD_MARK="$HERE/hold"
DOMAIN="gui/$(id -u)"
EXPECTED_HOST="127.0.0.1:11434"

OLLAMA_WINDOW=""
OLLAMA_BIN="/opt/homebrew/bin/ollama"
# shellcheck source=window.conf
[ -f "$CONF" ] && . "$CONF"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# HH:MM → 분
to_min() {
  local h="${1%%:*}" m="${1##*:}"
  echo $((10#$h * 60 + 10#$m))
}

# 서버 extract_worker.in_window와 같은 규칙: [시작, 끝), 끝이 이르면 자정을 넘는다, 비면 늘 열림
in_window() {
  local now_hm="$1" spec="$OLLAMA_WINDOW" part s e t
  spec="${spec// /}"
  [ -z "$spec" ] && return 0
  t=$(to_min "$now_hm")
  IFS=',' read -r -a parts <<< "$spec"
  for part in "${parts[@]}"; do
    [ -z "$part" ] && continue
    if ! [[ "$part" =~ ^([0-9]{1,2}):([0-9]{2})-([0-9]{1,2}):([0-9]{2})$ ]]; then
      log "window.conf 형식이 잘못됐어요: $part (HH:MM-HH:MM)" >&2
      return 2
    fi
    s=$(to_min "${part%%-*}")
    e=$(to_min "${part##*-}")
    if [ "$s" -le "$e" ]; then
      [ "$t" -ge "$s" ] && [ "$t" -lt "$e" ] && return 0
    else
      { [ "$t" -ge "$s" ] || [ "$t" -lt "$e" ]; } && return 0
    fi
  done
  return 1
}

listening() {
  /usr/sbin/lsof -nP -iTCP:11434 -sTCP:LISTEN 2>/dev/null | tail -n +2
}

cmd_start() {
  if [ "${OLLAMA_HOST:-}" != "$EXPECTED_HOST" ]; then
    log "OLLAMA_HOST가 $EXPECTED_HOST가 아니에요(${OLLAMA_HOST:-없음}). 켜지 않아요(규칙 10)."
    exit 0
  fi
  if [ -f "$FORCE_MARK" ]; then
    rm -f "$FORCE_MARK"
    log "지금 켜기 표시가 있어 창과 상관없이 켜요(다음 창 끝에 꺼져요)."
  elif ! in_window "$(date +%H:%M)"; then
    log "시간창($OLLAMA_WINDOW) 밖이라 켜지 않아요."
    exit 0
  fi
  if [ -n "$(listening)" ]; then
    log "11434를 이미 다른 프로세스가 쓰고 있어요. 켜지 않아요:"
    listening
    exit 0
  fi
  if [ ! -x "$OLLAMA_BIN" ]; then
    log "ollama가 없어요: $OLLAMA_BIN (window.conf의 OLLAMA_BIN을 확인해 주세요)"
    exit 1
  fi
  log "Ollama를 켜요(OLLAMA_HOST=$OLLAMA_HOST, 창 $OLLAMA_WINDOW)."
  "$OLLAMA_BIN" serve &
  local pid=$!
  # 켜져 있는 동안만 맥이 잠들지 않게(-i), Ollama가 끝나면 caffeinate도 끝난다(-w)
  /usr/bin/caffeinate -i -w "$pid" &
  trap 'log "끄라는 신호를 받아 Ollama를 꺼요."; kill -TERM "$pid" 2>/dev/null; wait "$pid"; exit 0' TERM INT
  wait "$pid"
  local code=$?
  log "Ollama가 끝났어요(종료 코드 $code)."
  exit "$code"
}

cmd_stop() {
  if [ -f "$HOLD_MARK" ]; then
    log "hold 중이라 끄지 않아요(풀기: ollama-window.sh release)."
    exit 0
  fi
  if in_window "$(date +%H:%M)"; then
    log "아직 다른 시간창 안이라 끄지 않아요."
    exit 0
  fi
  log "시간창이 끝나 Ollama를 꺼요."
  /bin/launchctl kill SIGTERM "$DOMAIN/$START_LABEL" 2>/dev/null || log "켜져 있지 않았어요."
  exit 0
}

cmd_now() {
  if /bin/launchctl print "$DOMAIN/$START_LABEL" 2>/dev/null | grep -q "^\tstate = running"; then
    echo "이미 켜져 있어요."
    return 0
  fi
  touch "$FORCE_MARK"
  if /bin/launchctl print "$DOMAIN/$START_LABEL" >/dev/null 2>&1; then
    /bin/launchctl kickstart "$DOMAIN/$START_LABEL"
    echo "지금 켰어요. 다음 시간창 끝에 꺼져요(창: $OLLAMA_WINDOW)."
  else
    rm -f "$FORCE_MARK"
    echo "시작 에이전트가 설치돼 있지 않아요. 먼저 infra/mac/install.sh를 돌려 주세요." >&2
    exit 1
  fi
}

cmd_hold() {
  touch "$HOLD_MARK"
  if [ -n "$(listening)" ]; then
    echo "hold: 이미 켜져 있어요. release·off 전까지 끄지 않아요."
  else
    cmd_now
    echo "hold: release·off 전까지 끄지 않아요."
  fi
}

cmd_release() {
  rm -f "$HOLD_MARK"
  echo "hold를 풀었어요. 다음 시간창 끝에 꺼져요."
}

cmd_off() {
  rm -f "$FORCE_MARK" "$HOLD_MARK"
  /bin/launchctl kill SIGTERM "$DOMAIN/$START_LABEL" 2>/dev/null && echo "껐어요. 다음 시간창 시작에 다시 켜져요." \
    || echo "켜져 있지 않았어요."
}

cmd_status() {
  echo "시간창: ${OLLAMA_WINDOW:-늘 열림}"
  [ -f "$HOLD_MARK" ] && echo "hold 중: 끝 에이전트가 끄지 않아요(풀기: release)"
  for label in "$START_LABEL" com.good-metaphor.ollama-stop; do
    if /bin/launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
      echo "$label: 설치됨, $(/bin/launchctl print "$DOMAIN/$label" | awk -F'= ' '/^\tstate =/{print "state=" $2} /^\tpid =/{print "pid=" $2}' | tr '\n' ' ')"
    else
      echo "$label: 설치 안 됨"
    fi
  done
  echo "11434 리스너:"
  listening || true
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  now) cmd_now ;;
  off) cmd_off ;;
  hold) cmd_hold ;;
  release) cmd_release ;;
  in-window) in_window "${2:-$(date +%H:%M)}" ;;
  status) cmd_status ;;
  *) echo "쓰는 법: $0 start|stop|now|hold|release|off|in-window [HH:MM]|status" >&2; exit 2 ;;
esac
