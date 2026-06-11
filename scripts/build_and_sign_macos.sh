#!/usr/bin/env bash
# 本地 macOS 打包脚本：构建 .app -> 用稳定自签名证书签名 -> 安装到 /Applications
#
# 为什么需要它：
#   tauri dev / 默认 tauri build 在本机产出的是 ad-hoc 签名（甚至未签名）。
#   macOS 的隐私权限(TCC，麦克风/辅助功能)会把授权绑定到“代码签名身份”。
#   ad-hoc 签名没有稳定身份，每次重新打包 cdhash 都变，导致授权存不住、反复弹框。
#   用一个固定的自签名证书签名后，授权绑定到证书身份，授权一次即长期有效。
#   发布包不要临时生成证书；证书缺失时应直接失败，避免用户更新后权限失效。
#
# 用法：
#   bash scripts/build_and_sign_macos.sh            # 默认 debug 构建（更快）
#   BUILD_PROFILE=release bash scripts/build_and_sign_macos.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

IDENTITY="${MACOS_SIGNING_IDENTITY:-Local Voice Assistant Self Signed}"
APP_NAME="鱼泡语音助手.app"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
BUILD_PROFILE="${BUILD_PROFILE:-debug}"
CERT_PASS="voiceassistant"
ALLOW_CREATE_LOCAL_SIGNING_CERT="${ALLOW_CREATE_LOCAL_SIGNING_CERT:-0}"

ensure_identity() {
  if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
    echo "✓ 签名证书已存在：$IDENTITY"
    return
  fi
  if [ "$ALLOW_CREATE_LOCAL_SIGNING_CERT" != "1" ]; then
    cat >&2 <<EOF
✗ 未找到签名证书：$IDENTITY

为避免 macOS 把每次更新识别成不同应用，本脚本不会自动创建新证书。

处理方式：
  1. 发布包：导入同一份 .p12 证书后再构建。
  2. 仅本机临时开发：ALLOW_CREATE_LOCAL_SIGNING_CERT=1 bash scripts/build_and_sign_macos.sh

EOF
    exit 1
  fi
  echo "→ 首次运行，创建本机临时自签名代码签名证书：$IDENTITY"
  local tmp
  tmp="$(mktemp -d)"
  cat >"$tmp/cert.conf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = $IDENTITY
[ v3 ]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF
  openssl req -x509 -newkey rsa:2048 -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
    -days 3650 -nodes -config "$tmp/cert.conf" >/dev/null 2>&1
  # macOS 钥匙串只认 legacy PKCS12 加密算法
  openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/identity.p12" \
    -passout "pass:$CERT_PASS" -legacy -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
  # -A：允许所有程序使用私钥，codesign 无需 ACL 弹框
  security import "$tmp/identity.p12" -k "$KEYCHAIN" -P "$CERT_PASS" -T /usr/bin/codesign -A
  rm -rf "$tmp"
  echo "✓ 证书已创建并导入登录钥匙串"
}

ensure_identity

echo "→ 构建 .app (profile=$BUILD_PROFILE) ..."
if [ "$BUILD_PROFILE" = "release" ]; then
  npx tauri build --bundles app
  SRC="src-tauri/target/release/bundle/macos/$APP_NAME"
else
  npx tauri build --bundles app --debug
  SRC="src-tauri/target/debug/bundle/macos/$APP_NAME"
fi

if [ ! -d "$SRC" ]; then
  echo "✗ 未找到构建产物：$SRC" >&2
  exit 1
fi

DEST="/Applications/$APP_NAME"

echo "→ 用证书签名构建产物 ..."
codesign --force --deep --sign "$IDENTITY" "$SRC"

echo "→ 安装到 /Applications 并重新签名（cp 后确保签名完整）..."
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
codesign --force --deep --sign "$IDENTITY" "$DEST"
codesign --verify --deep --strict "$DEST"

echo ""
echo "✓ 完成：$DEST"
codesign -dv --verbose=2 "$DEST" 2>&1 | grep -E "Authority|Identifier|TeamIdentifier" || true
echo ""
echo "提示：首次安装后请在 系统设置 > 隐私与安全性 中授权麦克风与辅助功能各一次。"
echo "      之后重新执行本脚本（同一证书签名）授权依然有效，不会再反复弹框。"
