#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${APP_CONFIG_PATH:-$HOME/Library/Application Support/com.black.local-voice-assistant/config.json}"
FUNASR_LOG="$ROOT_DIR/funasr-service.log"

json_value() {
  local key="$1"
  local fallback="$2"
  python3 - "$CONFIG_PATH" "$key" "$fallback" <<'PY'
import json
import sys

path, key, fallback = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    value = data.get(key, fallback)
    print(value if value not in (None, "") else fallback)
except Exception:
    print(fallback)
PY
}

wait_for_funasr() {
  local endpoint="$1"
  for _ in $(seq 1 60); do
    if curl -fsS "$endpoint/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cd "$ROOT_DIR"

ASR_ENGINE="$(json_value asr_engine whisper)"
FUNASR_ENDPOINT="$(json_value funasr_endpoint http://127.0.0.1:10095)"

if [ "$ASR_ENGINE" = "funasr" ]; then
  FUNASR_MODEL="$(json_value funasr_model iic/SenseVoiceSmall)"
  FUNASR_DEVICE="$(json_value funasr_device cpu)"
  FUNASR_HOST="$(python3 - "$FUNASR_ENDPOINT" <<'PY'
from urllib.parse import urlparse
import sys

url = urlparse(sys.argv[1])
print(url.hostname or "127.0.0.1")
PY
)"
  FUNASR_PORT="$(python3 - "$FUNASR_ENDPOINT" <<'PY'
from urllib.parse import urlparse
import sys

url = urlparse(sys.argv[1])
print(url.port or 10095)
PY
)"

  if curl -fsS "$FUNASR_ENDPOINT/health" >/dev/null 2>&1; then
    echo "FunASR 服务已可用：$FUNASR_ENDPOINT"
  else
    echo "启动 FunASR 服务：$FUNASR_ENDPOINT，日志：$FUNASR_LOG"
    FUNASR_HOST="$FUNASR_HOST" \
      FUNASR_PORT="$FUNASR_PORT" \
      FUNASR_MODEL="$FUNASR_MODEL" \
      FUNASR_DEVICE="$FUNASR_DEVICE" \
      "$ROOT_DIR/scripts/start_funasr_service.sh" >"$FUNASR_LOG" 2>&1 &
    if ! wait_for_funasr "$FUNASR_ENDPOINT"; then
      echo "FunASR 服务启动超时，请查看日志：$FUNASR_LOG" >&2
      exit 1
    fi
  fi
else
  echo "当前识别引擎：Whisper，本次不启动 FunASR 服务。"
fi

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  npm install
fi

exec npm run tauri:dev
