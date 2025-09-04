#!/bin/bash
set -e

# Ensure required system packages are present
apt-get update
apt-get install -y git build-essential nodejs npm

# Build and install LuaJIT from source if not already available
if ! command -v luajit >/dev/null 2>&1; then
  if [ ! -d luajit ]; then
    git clone https://luajit.org/git/luajit.git
  fi
  pushd luajit
  make && make install
  popd
fi

# Install Node dependencies
pushd scripts
npm install
popd

# Build C++ shared library
g++ -fPIC -shared engine_api.cpp -o libengine.so

# Start the server
node scripts/server.js
