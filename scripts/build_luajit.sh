#!/usr/bin/env bash
# Build and stage a local LuaJIT binary under scripts/bin
set -euo pipefail
cd "$(dirname "$0")/.."

# Ensure toolchain
if ! command -v make >/dev/null 2>&1; then
  echo "make not found. Install build-essential." >&2
  exit 1
fi

LUADIR="${1:-./luajit}"
if [ ! -d "$LUADIR" ]; then
  echo "LuaJIT source directory not found at $LUADIR" >&2
  echo "To vendor source: git clone https://luajit.org/git/luajit.git luajit && rm -rf luajit/.git" >&2
  exit 1
fi

make -C "$LUADIR" -j"$(nproc)"
mkdir -p scripts/bin
cp "$LUADIR/src/luajit" scripts/bin/
# Copy shared libs if present
cp -a "$LUADIR/src"/libluajit-5.1.so* scripts/bin/ 2>/dev/null || true

echo "LuaJIT built at scripts/bin/luajit"
