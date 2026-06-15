#!/usr/bin/env bash
# 健康检查：调用 /health，要求 ok=true 且 model 字段已返回。
set -euo pipefail

ENDPOINT="${1:-${FUNASR_ENDPOINT:-http://127.0.0.1:10095}}"
RESPONSE="$(curl -fsS "$ENDPOINT/health")"
echo "$RESPONSE"
echo "$RESPONSE" | python3 -c '
import json, sys
data = json.load(sys.stdin)
assert data.get("ok") is True, f"health not ok: {data}"
assert data.get("model"), f"missing model field: {data}"
print(f"[check] engine={data.get(\"engine\")} model={data.get(\"model\")} device={data.get(\"device\")} quantize={data.get(\"quantize\")}")
'
