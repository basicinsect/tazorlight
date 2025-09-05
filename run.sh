#!/bin/bash
set -e

apt-get update
apt-get install -y git build-essential nodejs npm

# LuaJIT for FFI (unchanged)
if ! command -v luajit >/dev/null 2>&1; then
  if [ ! -d luajit ]; then
    git clone https://luajit.org/git/luajit.git
  fi
  pushd luajit
  make && make install
  popd
fi

# Taskflow (header-only)
if [ ! -d third_party/taskflow ]; then
  git clone --depth 1 https://github.com/taskflow/taskflow.git third_party/taskflow
fi

# Node deps
pushd scripts
npm install
popd

# Build shared library with Taskflow
g++ -std=c++17 -fPIC -shared engine_api.cpp -Ithird_party/taskflow -pthread -o libengine.so

# Optional: copy next to scripts for fallback lookups
cp -f libengine.so scripts/libengine.so

# Run server
node scripts/server.js
