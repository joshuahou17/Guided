#!/bin/bash
# Build the native SceneKit overlay for Guided
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

SRC="$PROJECT_DIR/src/native/OverlayApp.swift"
OUT_DIR="$PROJECT_DIR/native"
OUT="$OUT_DIR/overlay"

mkdir -p "$OUT_DIR"

echo "Building native overlay..."
swiftc -O -o "$OUT" "$SRC" \
  -framework Cocoa \
  -framework SceneKit \
  -framework QuartzCore

echo "Signing binary..."
codesign --force --sign - "$OUT"

echo "Built: $OUT"
ls -la "$OUT"
