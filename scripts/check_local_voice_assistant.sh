#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${APP_CONFIG_PATH:-$HOME/Library/Application Support/com.black.local-voice-assistant/config.json}"

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

print_status() {
  printf '%-18s %s\n' "$1" "$2"
}

ASR_ENGINE="$(json_value asr_engine whisper)"
WHISPER_MODEL="$(json_value whisper_model_path '')"
WHISPER_CLI="$(json_value whisper_cli_path whisper-cli)"
FUNASR_ENDPOINT="$(json_value funasr_endpoint http://127.0.0.1:10095)"
FUNASR_MODEL="$(json_value funasr_model iic/SenseVoiceSmall)"
FUNASR_DEVICE="$(json_value funasr_device cpu)"

print_status "项目目录" "$ROOT_DIR"
print_status "配置文件" "$CONFIG_PATH"
print_status "识别引擎" "$ASR_ENGINE"

if [ "$ASR_ENGINE" = "funasr" ]; then
  print_status "FunASR 地址" "$FUNASR_ENDPOINT"
  print_status "FunASR 模型" "$FUNASR_MODEL"
  print_status "FunASR 设备" "$FUNASR_DEVICE"
  if curl -fsS "$FUNASR_ENDPOINT/health" >/tmp/local-voice-funasr-health.json 2>/dev/null; then
    print_status "FunASR 健康" "OK $(cat /tmp/local-voice-funasr-health.json)"
  else
    print_status "FunASR 健康" "不可用"
    exit 1
  fi
else
  print_status "Whisper CLI" "$WHISPER_CLI"
  if command -v "$WHISPER_CLI" >/dev/null 2>&1 || [ -x "$WHISPER_CLI" ]; then
    print_status "Whisper CLI 检测" "OK"
  else
    print_status "Whisper CLI 检测" "不可执行"
    exit 1
  fi
  if [ -f "$WHISPER_MODEL" ]; then
    print_status "Whisper 模型" "OK $WHISPER_MODEL"
  else
    print_status "Whisper 模型" "不存在：$WHISPER_MODEL"
    exit 1
  fi
fi

if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
  print_status "Vite 端口 1420" "已监听"
else
  print_status "Vite 端口 1420" "未监听"
fi
