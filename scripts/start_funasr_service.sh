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
TORCH_VARIANT="${FUNASR_TORCH_VARIANT:-auto}"

install_torch_runtime() {
  local python_bin="$1"
  local platform_name
  platform_name="$(uname -s 2>/dev/null || echo unknown)"

  # Linux CPU servers should prefer the CPU-only wheels to avoid pulling CUDA packages.
  if [ "$TORCH_VARIANT" = "cpu" ] || { [ "$TORCH_VARIANT" = "auto" ] && [ "$DEVICE" = "cpu" ] && [ "$platform_name" = "Linux" ]; }; then
    "$python_bin" -m pip install --no-compile \
      --extra-index-url "https://download.pytorch.org/whl/cpu" \
      "torch==2.2.2+cpu" \
      "torchaudio==2.2.2+cpu"
    return
  fi

  "$python_bin" -m pip install --no-compile \
    "torch==2.2.2" \
    "torchaudio==2.2.2"
}

if [ ! -d "$VENV_DIR" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

export PATH="$VENV_DIR/bin:$PATH"

if [ ! -f "$DEPS_MARKER" ] || [ "$ROOT_DIR/requirements-funasr.txt" -nt "$DEPS_MARKER" ]; then
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install cmake
  install_torch_runtime "$VENV_DIR/bin/python"
  "$VENV_DIR/bin/python" -m pip install --no-compile -r "$ROOT_DIR/requirements-funasr.txt"
  date > "$DEPS_MARKER"
fi

exec "$VENV_DIR/bin/python" "$ROOT_DIR/scripts/funasr_server.py" \
  --host "$HOST" \
  --port "$PORT" \
  --model "$MODEL" \
  --device "$DEVICE"
