#!/usr/bin/env bash
# Sets up the working codebases this proposal targets.
# Phase 1 work happens in upstream/dht-rpc; Phases 2-3 in upstream/hyperdht.
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p upstream

[ -d upstream/dht-rpc ] || git clone https://github.com/holepunchto/dht-rpc upstream/dht-rpc
[ -d upstream/hyperdht ] || git clone https://github.com/holepunchto/hyperdht upstream/hyperdht

(cd upstream/dht-rpc && npm install --no-audit --no-fund)
(cd upstream/hyperdht && npm install --no-audit --no-fund)
npm install --no-audit --no-fund

echo
echo "Ready. Run:"
echo "  npm run test:golden  # v4 regression pins - must ALWAYS pass"
echo "  npm run test:red     # Phase 1 TDD contract - passes when Phase 1 is done"
