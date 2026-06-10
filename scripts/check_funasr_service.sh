#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${1:-${FUNASR_ENDPOINT:-http://127.0.0.1:10095}}"
curl -fsS "$ENDPOINT/health"
