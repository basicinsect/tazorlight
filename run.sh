#!/bin/bash
set -e

g++ -fPIC -shared engine_api.cpp -o libengine.so
node scripts/server.js
