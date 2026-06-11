#!/usr/bin/env bash
# Reset only this app's macOS Accessibility permission when TCC keeps an old
# signing requirement for the same bundle id.
set -euo pipefail

APP_NAME="鱼泡语音助手"
APP_PATH="/Applications/$APP_NAME.app"
BUNDLE_ID="com.black.local-voice-assistant"

echo "→ 退出 $APP_NAME ..."
osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
sleep 1

echo "→ 重置 $BUNDLE_ID 的辅助功能授权记录 ..."
tccutil reset Accessibility "$BUNDLE_ID" >/dev/null

echo "→ 重新打开应用 ..."
open -a "$APP_PATH"

echo "→ 打开辅助功能设置页 ..."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"

cat <<EOF

已重置 $APP_NAME 的辅助功能授权。

请在 系统设置 > 隐私与安全性 > 辅助功能 中重新打开“${APP_NAME}”，
然后退出并重新打开应用一次。

EOF
