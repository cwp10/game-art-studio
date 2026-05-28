#!/bin/bash
# SpriteForge 런처 — 프로덕션 서버를 띄우고 전용 창(Chrome 앱 모드)을 연다.
# 전용 창을 닫으면 이 런처가 띄운 서버를 함께 종료한다(이미 떠 있던 서버는 건드리지 않음).
#
# Finder 의 .app 에서 실행되면 PATH 가 최소화되므로(node/pnpm/codex/claude 못 찾음)
# 도구 위치를 직접 PATH 에 넣는다. codex/claude 는 Next 서버가 자식 프로세스로 spawn 하므로
# 여기 PATH 가 그대로 상속돼야 한다.
set -u

export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/usr/sbin:/bin:$PATH"

# 이 스크립트의 위치(scripts/) 기준으로 프로젝트 루트 해석 — .app 을 어디로 옮겨도 동작.
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=3000
URL="http://127.0.0.1:${PORT}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_PROFILE="$HOME/Library/Application Support/SpriteForge/chrome"

cd "$PROJECT_DIR" || exit 1

is_up() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

# 런처가 직접 서버를 띄운 경우에만 종료 책임을 진다.
SERVER_PID=""
if ! is_up; then
  # 프로덕션 빌드가 없으면 최초 1회 빌드(코드 수정 후 갱신하려면 `pnpm build`).
  [ -f .next/BUILD_ID ] || pnpm build
  mkdir -p data/logs
  nohup pnpm start >> data/logs/app.log 2>&1 &
  SERVER_PID=$!
  # 포트가 열릴 때까지 최대 ~60s 대기.
  for _ in $(seq 1 120); do is_up && break; sleep 0.5; done
fi

stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  # 실제 리스너(next-server)를 포트로 찾아 종료 → 포트 해제.
  local port_pid
  port_pid="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  [ -n "$port_pid" ] && kill "$port_pid" 2>/dev/null
  kill "$SERVER_PID" 2>/dev/null  # pnpm 래퍼
}

if [ -x "$CHROME" ]; then
  # 별도 프로필 → 독립 Chrome 프로세스. 전용 창이 닫힐 때까지 포그라운드로 대기.
  mkdir -p "$CHROME_PROFILE"
  "$CHROME" --app="$URL" --user-data-dir="$CHROME_PROFILE" --window-size=1280,860 >/dev/null 2>&1
  # 창이 닫힘 → 런처가 띄운 서버 종료.
  stop_server
else
  # Chrome 없으면 기본 브라우저 탭(창 수명 추적 불가 → 서버는 계속 둠).
  open "$URL"
fi
