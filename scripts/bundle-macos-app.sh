#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Antigravity Console"
BUNDLE_ID="com.jasonneoh.antigravity.console"
VERSION="1.0.0"
EXEC_NAME="agy-test"

PROFILE="${1:-debug}"
CARGO_ARGS=(--manifest-path "$ROOT_DIR/src-tauri/Cargo.toml" --offline)

if [[ "$PROFILE" == "--release" || "$PROFILE" == "release" ]]; then
  PROFILE_DIR="release"
  CARGO_ARGS+=(--release)
else
  PROFILE_DIR="debug"
fi

echo "==> Building Tauri Rust binary ($PROFILE_DIR)..."
cargo build "${CARGO_ARGS[@]}"

BIN_PATH="$ROOT_DIR/src-tauri/target/$PROFILE_DIR/$EXEC_NAME"
if [[ ! -f "$BIN_PATH" ]]; then
  echo "Error: Binary not found at $BIN_PATH" >&2
  exit 1
fi

APP_DIR="$ROOT_DIR/dist/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$BIN_PATH" "$MACOS_DIR/$EXEC_NAME"
chmod +x "$MACOS_DIR/$EXEC_NAME"

if [[ -f "$ROOT_DIR/src-tauri/icons/icon.icns" ]]; then
  cp "$ROOT_DIR/src-tauri/icons/icon.icns" "$RESOURCES_DIR/icon.icns"
fi

cat > "$CONTENTS_DIR/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${EXEC_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "==> Packaged macOS app bundle at: $APP_DIR"
