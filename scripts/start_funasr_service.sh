#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_PYTHON="/usr/bin/python3"
if [ ! -x "$DEFAULT_PYTHON" ]; then
  DEFAULT_PYTHON="python3"
fi
PYTHON_BIN="${FUNASR_PYTHON:-$DEFAULT_PYTHON}"
DEFAULT_VENV_DIR="$ROOT_DIR/.venv-funasr-py39"
VENV_DIR="${FUNASR_VENV_DIR:-$DEFAULT_VENV_DIR}"
DEPS_MARKER="$VENV_DIR/.deps-installed"
HOST="${FUNASR_HOST:-127.0.0.1}"
PORT="${FUNASR_PORT:-10095}"
MODEL="${FUNASR_MODEL:-iic/SenseVoiceSmall}"
DEVICE="${FUNASR_DEVICE:-cpu}"

if [ ! -d "$VENV_DIR" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

export PATH="$VENV_DIR/bin:$PATH"

if [ ! -f "$DEPS_MARKER" ] || [ "$ROOT_DIR/requirements-funasr.txt" -nt "$DEPS_MARKER" ]; then
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install cmake
  "$VENV_DIR/bin/python" -m pip install --no-compile -r "$ROOT_DIR/requirements-funasr.txt"
  date > "$DEPS_MARKER"
fi

exec "$VENV_DIR/bin/python" "$ROOT_DIR/scripts/funasr_server.py" \
  --host "$HOST" \
  --port "$PORT" \
  --model "$MODEL" \
  --device "$DEVICE"
