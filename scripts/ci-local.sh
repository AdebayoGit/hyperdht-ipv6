#!/usr/bin/env bash
# Canonical CI for this project — runs the full gate matrix locally.
# Usage: bash scripts/ci-local.sh [--quick]
#   --quick skips the slow integration + upstream suites (pre-commit loop)
set -uo pipefail

cd "$(dirname "$0")/.."

QUICK=${1:-}
FAIL=0
declare -a RESULTS

gate () { # name, command...
  local name=$1; shift
  echo
  echo "=== $name ==="
  if "$@"; then
    RESULTS+=("PASS  $name")
  else
    RESULTS+=("FAIL  $name")
    FAIL=1
  fi
}

have_bare=$(command -v bare || true)

# --- harness contracts -------------------------------------------------
gate "phase1 golden (v4 byte pins)"        npx brittle test/phase1/01-v4-golden.test.js
gate "phase1 contract (codec/id6/caps/sockets)" npx brittle test/phase1/02-ipv6-codec.test.js test/phase1/03-id6.test.js test/phase1/04-table-caps.test.js test/phase1/05-sockets.test.js
[ -d test/phase2 ] && gate "phase2 contract" npx brittle test/phase2/*.test.js
[ -d test/phase3 ] && gate "phase3 contract" npx brittle test/phase3/*.test.js
[ -d test/phase4 ] && gate "phase4 contract" npx brittle test/phase4/*.test.js

if [ "$QUICK" != "--quick" ]; then
  gate "phase1 integration (::1 matrix)" npx brittle test/phase1/06-integration.test.js

  # --- upstream suites, unmodified test files -------------------------
  gate "dht-rpc upstream suite (node)" bash -c 'cd upstream/dht-rpc && npm run test:node'
  if [ -n "$have_bare" ]; then
    gate "dht-rpc upstream suite (bare)" bash -c 'cd upstream/dht-rpc && npm run test:bare'
  else
    echo "(bare runtime not installed - skipping bare gates; npm i -g bare-runtime)"
  fi
  gate "hyperdht upstream suite (node)" bash -c 'cd upstream/hyperdht && node test/all.js'

  # --- style -----------------------------------------------------------
  gate "dht-rpc prettier" bash -c 'cd upstream/dht-rpc && npx prettier --check index.js lib/'
  gate "hyperdht prettier" bash -c 'cd upstream/hyperdht && npx prettier --check index.js lib/ testnet.js'

  if [ -d upstream/hyperswarm/test ] && grep -q families upstream/hyperswarm/index.js 2>/dev/null; then
    gate "hyperswarm upstream suite (node)" bash -c 'cd upstream/hyperswarm && npm run test:node'
  fi
fi

echo
echo "=== summary ==="
printf '%s\n' "${RESULTS[@]}"
exit $FAIL
