#!/usr/bin/env bash
# Generate a stable self-signed macOS code-signing certificate for internal GitHub releases.
#
# The generated .p12 is not an Apple Developer ID certificate and cannot notarize the app.
# It only gives the app a stable code identity so macOS privacy permissions can persist.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/src-tauri/target/macos-internal-signing"
IDENTITY="${MACOS_SIGNING_IDENTITY:-Local Voice Assistant Self Signed}"
CERT_PASSWORD="${MACOS_CERTIFICATE_PASSWORD:-voiceassistant}"

mkdir -p "$OUT_DIR"

cat >"$OUT_DIR/cert.conf" <<EOF
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

openssl req -x509 -newkey rsa:2048 \
  -keyout "$OUT_DIR/key.pem" \
  -out "$OUT_DIR/cert.pem" \
  -days 3650 \
  -nodes \
  -config "$OUT_DIR/cert.conf" >/dev/null 2>&1

openssl pkcs12 -export \
  -inkey "$OUT_DIR/key.pem" \
  -in "$OUT_DIR/cert.pem" \
  -out "$OUT_DIR/identity.p12" \
  -passout "pass:$CERT_PASSWORD" \
  -legacy \
  -keypbe PBE-SHA1-3DES \
  -certpbe PBE-SHA1-3DES \
  -macalg sha1 >/dev/null 2>&1

base64 <"$OUT_DIR/identity.p12" >"$OUT_DIR/identity.p12.base64"
CERT_SHA1="$(openssl x509 -in "$OUT_DIR/cert.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')"

cat <<EOF
Generated internal signing certificate:
  identity: $IDENTITY
  sha1:     $CERT_SHA1
  p12:      $OUT_DIR/identity.p12
  base64:   $OUT_DIR/identity.p12.base64

Add these GitHub repository secrets:
  MACOS_CERTIFICATE            = contents of $OUT_DIR/identity.p12.base64
  MACOS_CERTIFICATE_PASSWORD   = $CERT_PASSWORD
  MACOS_SIGNING_IDENTITY       = $IDENTITY
  MACOS_CERTIFICATE_SHA1       = $CERT_SHA1

Keep using the same certificate for future releases. Re-generating it changes the app identity and macOS may ask for microphone permission again.
EOF
