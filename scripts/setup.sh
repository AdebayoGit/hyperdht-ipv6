#!/usr/bin/env bash
# Sets up the working codebases this proposal targets.
# Phase 1 lives on AdebayoGit/dht-rpc#ipv6-phase1, Phases 2-3 on
# AdebayoGit/hyperdht#ipv6-phase2/#ipv6-phase3, Phase 4 on
# AdebayoGit/hyperswarm#ipv6-phase4.
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p upstream

clone () { # repo, branch
  [ -d "upstream/$1" ] || git clone -b "$2" "https://github.com/AdebayoGit/$1" "upstream/$1" ||
    git clone "https://github.com/holepunchto/$1" "upstream/$1"
}

clone dht-rpc ipv6-phase1
clone hyperdht ipv6-phase3
clone hyperswarm ipv6-phase4

(cd upstream/dht-rpc && npm install --no-audit --no-fund)
# link the local phase-1 dht-rpc into hyperdht, and hyperdht into hyperswarm
(cd upstream/hyperdht && npm install --no-audit --no-fund && npm install --no-save ../dht-rpc)
(cd upstream/hyperswarm && npm install --no-audit --no-fund && npm install --no-save ../hyperdht)
npm install --no-audit --no-fund

echo
echo "Ready. Run:"
echo "  npm run test:golden   # v4 regression pins - must ALWAYS pass"
echo "  npm test              # phase 1 contract"
echo "  npm run test:phase2   # phase 2 contract"
echo "  node scripts/testnet/soak.js   # local mixed-family soak"
