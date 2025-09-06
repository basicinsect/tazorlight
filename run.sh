#!/bin/bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

log() { echo "[run.sh] $*"; }

apt_install() {
  if command -v apt-get >/dev/null 2>&1; then
    if [ "$(id -u)" -ne 0 ]; then SUDO=sudo; else SUDO=""; fi
    $SUDO apt-get update -y
    # NodeJS is often preinstalled in Codespaces; install if missing
    $SUDO apt-get install -y git build-essential g++ make nodejs npm ca-certificates || true
  else
    log "apt-get not available; assuming toolchain and node are present"
  fi
}

ensure_taskflow() {
  if [ ! -f third_party/taskflow/taskflow/taskflow.hpp ]; then
    log "Fetching Taskflow (v3.7.0)"
    rm -rf third_party/taskflow
    git clone --depth 1 --branch v3.7.0 https://github.com/taskflow/taskflow.git third_party/taskflow
  else
    log "Taskflow present"
  fi
}

ensure_luajit_vendored() {
  # Build vendored LuaJIT to scripts/bin (no system install)
  if [ -x scripts/bin/luajit ]; then
    log "LuaJIT already built at scripts/bin/luajit"
    return 0
  fi
  if [ ! -d luajit ] || [ ! -f luajit/src/Makefile ]; then
    log "Cloning LuaJIT source"
    rm -rf luajit
    # Some servers (luajit.org) don't support shallow clones; try full clone first.
    if ! git clone https://luajit.org/git/luajit.git luajit; then
      log "luajit.org clone failed; trying GitHub mirror (shallow)"
      rm -rf luajit
      git clone --depth 1 https://github.com/LuaJIT/LuaJIT.git luajit || {
        log "Failed to fetch LuaJIT from both sources"; exit 1; }
    fi
    # Vendor as deep copy (strip nested .git to avoid nested repo confusion)
    rm -rf luajit/.git
  fi
  log "Building LuaJIT locally"
  bash scripts/build_luajit.sh || { log "LuaJIT build failed"; exit 1; }
}

ensure_node_deps() {
  log "Installing Node dependencies"
  (cd scripts && npm install)
}

build_engine_so() {
  log "Building libengine.so"
  g++ -std=c++17 -fPIC -shared engine_api.cpp -Ithird_party/taskflow -pthread -o libengine.so
  cp -f libengine.so scripts/libengine.so || true
}

start_server() {
  # Prefer vendored LuaJIT via LUAJIT env for clarity; server also auto-detects
  export LUAJIT="$(pwd)/scripts/bin/luajit"
  export LD_LIBRARY_PATH="$(pwd)/scripts/bin:${LD_LIBRARY_PATH:-}"
  log "Starting server at http://localhost:3000"
  node scripts/server.js
}

apt_install
ensure_taskflow
ensure_luajit_vendored
ensure_node_deps
build_engine_so
start_server
